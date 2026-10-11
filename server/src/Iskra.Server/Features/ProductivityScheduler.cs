using Iskra.Server.Files;
using Iskra.Server.Gifs;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Fires reminders and sends scheduled messages when their time comes (checked every second), and prunes old inbox
/// items and finished reminders hourly. Scheduled messages go out through a detached session of their author, so they
/// pass the same checks as a message sent by hand at that moment.
/// </summary>
public sealed class ProductivityScheduler(World world, Hub hub, PushService push, Router router, VoiceRegistry voice, Uploads uploads,
    LinkPreviews previews, GifService gifs, TimeProvider time, ILogger<ProductivityScheduler> log) : BackgroundService
{
    private const int Batch = 50;
    private long _lastPrune;

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        try
        {
            world.Store.ResetSendingScheduled();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Couldn't reset scheduled messages");
        }
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping)) Tick();
        }
        catch (OperationCanceledException) { }
    }

    internal void Tick()
    {
        try
        {
            var now = time.GetUtcNow().ToUnixTimeMilliseconds();
            var store = world.Store;
            foreach (var reminder in store.DueReminders(now, Batch)) ReminderFeature.Fire(world, hub, push, reminder, now);
            foreach (var due in store.DueScheduled(now, Batch))
            {
                if (!store.ClaimScheduled(due.Id, due.SendAt)) continue;
                if (store.GetMember(due.AccountKey) is not { } author)
                {
                    store.DeleteScheduled(due.Id); // the author left (or was removed): nothing to send as them
                    continue;
                }
                var session = Session.Detached(author.AccountKey, world, hub, voice, uploads, previews, router, log, time, push, gifs);
                try
                {
                    ScheduledFeature.Deliver(session, author, due, notify: true);
                }
                catch (Exception ex) when (ex is not OperationCanceledException and not ObjectDisposedException)
                {
                    log.LogWarning(ex, "Scheduled message {Id} failed", due.Id);
                    store.FailScheduled(due.Id, "Something went wrong on the server.");
                }
            }
            if (now - _lastPrune > 3_600_000)
            {
                _lastPrune = now;
                store.PruneInbox(now - (long)InboxFeature.Retention.TotalMilliseconds, InboxFeature.MaxItems);
                store.PruneReminders(now - (long)ReminderFeature.FiredRetention.TotalMilliseconds);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not ObjectDisposedException)
        {
            log.LogWarning(ex, "Reminders and scheduled messages failed");
        }
    }
}
