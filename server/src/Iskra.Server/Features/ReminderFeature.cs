using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// "Remind me about this": at the chosen time the server tells your open apps (<c>reminder.due</c>) and pushes to your
/// devices, even if every app is closed. What a reminder is about travels sealed (only your devices can open it); for a
/// channel message the server also keeps which message, so the push can say where. For DMs and groups it knows only the time.
/// </summary>
public static class ReminderFeature
{
    public const int MaxPerAccount = 100;
    public const int MaxDataLength = 2048;
    public const long MaxAheadMs = 366L * 24 * 3600 * 1000;
    /// <summary>A time "now" from a clock that's a little behind is still fine.</summary>
    public const long PastSlackMs = 60_000;
    /// <summary>Fired reminders stay listed (until you're done with them) this long.</summary>
    public static readonly TimeSpan FiredRetention = TimeSpan.FromDays(30);

    public static void Register(Router router)
    {
        router.Add("reminder.create", Create);
        router.Add("reminder.list", (s, me, _) => new { reminders = s.World.Store.Reminders(me.AccountKey).Select(View) });
        router.Add("reminder.update", Update);
        router.Add("reminder.delete", Delete);
    }

    public static object View(Reminder r) =>
        new { id = r.Id, dueAt = r.DueAt, data = r.Data, channelId = r.ChannelId, messageId = r.MessageId, createdAt = r.CreatedAt, firedAt = r.FiredAt };

    private static long DueAt(Session s, Body body)
    {
        var due = body.OptionalLong("dueAt", 0, 1L << 53) ?? throw RequestException.BadRequest("'dueAt' is required.");
        if (due < s.Now - PastSlackMs || due > s.Now + MaxAheadMs) throw RequestException.BadRequest("Reminders can be set from now up to a year ahead.");
        return due;
    }

    private static Reminder Mine(Session s, Member me, Body body) =>
        s.World.Store.GetReminder(body.Long("id")) is { } r && r.AccountKey == me.AccountKey ? r : throw RequestException.NotFound("Reminder");

    private static void Tell(Session s, string accountKey, string frame)
    {
        foreach (var other in s.Hub.Sessions.Where(o => o.AccountKey == accountKey && o != s)) other.Send(frame);
    }

    private static object Create(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var due = DueAt(s, body);
        var data = ProductivityFeature.Sealed(body, "data", MaxDataLength);
        long? channelId = null;
        long? messageId = body.OptionalLong("messageId", 1);
        if (messageId is { } id)
        {
            var message = store.GetMessage(id) ?? throw RequestException.NotFound("Message");
            channelId = ChatFeature.ReadableChannel(s, me, message.ChannelId).Id;
        }
        if (store.CountReminders(me.AccountKey) >= MaxPerAccount)
            throw RequestException.BadRequest($"You can have up to {MaxPerAccount} reminders here. Finish some first.");
        var reminder = store.AddReminder(me.AccountKey, due, data, channelId, messageId, s.Now);
        Tell(s, me.AccountKey, Frames.Event("reminder.updated", new { reminder = View(reminder) }));
        return new { reminder = View(reminder) };
    }

    /// <summary>A new time (snooze) and optionally new sealed data; a fired reminder becomes pending again.</summary>
    private static object Update(Session s, Member me, Body body)
    {
        var reminder = Mine(s, me, body);
        var due = DueAt(s, body);
        var data = body.Has("data") ? ProductivityFeature.Sealed(body, "data", MaxDataLength) : reminder.Data;
        s.World.Store.UpdateReminder(reminder.Id, due, data);
        var updated = reminder with { DueAt = due, Data = data, FiredAt = null };
        Tell(s, me.AccountKey, Frames.Event("reminder.updated", new { reminder = View(updated) }));
        return new { reminder = View(updated) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        var reminder = Mine(s, me, body);
        s.World.Store.DeleteReminder(reminder.Id);
        Tell(s, me.AccountKey, Frames.Event("reminder.deleted", new { id = reminder.Id }));
        return null;
    }

    /// <summary>Called by the scheduler when a reminder's time has come.</summary>
    internal static void Fire(World world, Hub hub, PushService push, Reminder r, long now)
    {
        var store = world.Store;
        if (!store.MarkReminderFired(r.Id, r.DueAt, now)) return;
        if (store.GetMember(r.AccountKey) is not { } member)
        {
            store.DeleteReminder(r.Id); // left the server meanwhile
            return;
        }
        var fired = r with { FiredAt = now };
        hub.SendToAccount(r.AccountKey, Frames.Event("reminder.due", new { reminder = View(fired) }));

        // A channel message the member can still read: say where and what. Anything else stays generic.
        var body = "You asked to be reminded about a message.";
        long? channelId = null;
        if (r.MessageId is { } id && store.GetMessage(id) is { } message && store.GetChannel(message.ChannelId) is { } channel
            && Permissions.CanRead(member, channel) && !store.EitherBlocked(member.AccountKey, message.AuthorKey))
        {
            var author = store.GetMember(message.AuthorKey) is { } a ? store.DisplayName(a) : "Someone";
            var text = message.Text.ReplaceLineEndings(" ");
            body = $"{author} in #{channel.Name}: {(text.Length == 0 ? "an attachment" : text.Length <= 120 ? text : text[..120] + "…")}";
            channelId = channel.Id;
        }
        push.Notify(r.AccountKey, new PushNote("reminder", $"reminder:{r.Id}", "Reminder", body, "Iskra",
            ChannelId: channelId, MessageId: channelId is null ? null : r.MessageId, Coalesce: false, TtlSeconds: 12 * 3600, Reminder: r.Id));
    }
}
