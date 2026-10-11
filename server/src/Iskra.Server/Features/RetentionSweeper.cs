using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Enforces Retention in server.json every hour: channel messages (with their edit history) and DM/group envelopes, files in messages and DMs, and the
/// security log. The audit log is pruned by the ModerationSweeper; expired data exports are deleted here too.
/// </summary>
public sealed class RetentionSweeper(World world, Hub hub, Uploads uploads, DataExports exports, TimeProvider time, ILogger<RetentionSweeper> log)
    : BackgroundService
{
    private const int Batch = 1000;
    private const int MaxAnnounced = 200;

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        DataExports.CleanUp(world);
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1), time);
        do Sweep();
        while (await timer.WaitForNextTickAsync(stopping).ConfigureAwait(false));
    }

    /// <summary>One pass. Returns how many messages, envelopes, files and security entries went.</summary>
    internal (int Messages, int Envelopes, int Files, int Security) Sweep()
    {
        var result = (Messages: 0, Envelopes: 0, Files: 0, Security: 0);
        try
        {
            exports.Expire();
            var now = time.GetUtcNow();
            var r = world.Settings.Retention;
            long Cutoff(int days) => (now - TimeSpan.FromDays(days)).ToUnixTimeMilliseconds();

            if (r.MessagesDays > 0)
            {
                var cutoff = Cutoff(r.MessagesDays);
                List<(long Id, long ChannelId)> deleted;
                do
                {
                    deleted = world.Store.DeleteMessagesBefore(cutoff, Batch);
                    result.Messages += deleted.Count;
                    // Hourly passes delete a few; the first pass after turning retention on may delete years, which apps get on reload.
                    Forget(deleted, announce: result.Messages <= MaxAnnounced);
                } while (deleted.Count == Batch);
                result.Envelopes = world.Store.DeleteEnvelopesBefore(cutoff);
                world.Store.PruneMessageVersions(cutoff); // edit history follows its messages
                world.Store.PruneDocRevisions(cutoff); // old docs revisions follow message retention
            }
            if (r.UploadsDays > 0) result.Files = uploads.DeleteOldMessageFiles(Cutoff(r.UploadsDays));
            if (r.SecurityLogDays > 0) result.Security = world.Store.PruneSecurityLog(Cutoff(r.SecurityLogDays));

            if (result.Messages + result.Envelopes + result.Files > 0)
                log.LogInformation("Retention: deleted {Messages} messages, {Envelopes} encrypted DM and group messages and {Files} files",
                    result.Messages, result.Envelopes, result.Files);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Retention sweep failed");
        }
        return result;
    }

    /// <summary>Apps drop the messages they have loaded; a forum post whose first message went goes with it.</summary>
    private void Forget(List<(long Id, long ChannelId)> deleted, bool announce)
    {
        foreach (var group in deleted.GroupBy(d => d.ChannelId))
        {
            if (world.Store.GetChannel(group.Key) is not { } channel) continue;
            foreach (var (id, _) in group)
            {
                if (announce) hub.BroadcastToReaders(channel, Frames.Event("chat.deleted", new { id, channelId = channel.Id }));
                if (channel.Kind == "forum" && world.Store.PostForRoot(id) is { } post)
                {
                    world.Store.DeleteChannel(post);
                    hub.BroadcastToReaders(channel, Frames.Event("thread.deleted", new { id = post, channelId = channel.Id, rootId = id }));
                }
            }
        }
    }
}
