using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Disappearing messages: a timer per channel (set by people who manage channels), DM pair (either person) and group DM
/// (any member). Every message gets its expiry when it is stored: the timer then, or what an encrypted envelope's signed
/// header says if that is sooner. Changing the timer only affects new messages. The <see cref="DisappearSweeper"/>
/// deletes expired messages and their files.
/// </summary>
public static class DisappearFeature
{
    /// <summary>The timers apps offer, in seconds: off, 5 minutes, 1 hour, 8 hours, 1 day, 7 days, 4 weeks.</summary>
    public static readonly int[] Allowed = [0, 300, 3600, 28800, 86400, 604800, 2419200];

    public static void Register(Router router)
    {
        router.Add("disappear.set", Set);
        router.Add("disappear.list", List);
    }

    private static int Seconds(Body body)
    {
        var seconds = body.OptionalLong("seconds") ?? throw RequestException.BadRequest("'seconds' is required.");
        return Allowed.Contains((int)Math.Clamp(seconds, -1, int.MaxValue)) ? (int)seconds
            : throw RequestException.BadRequest("That isn't one of the disappearing message timers.", "disappear_timer");
    }

    private static object Set(Session s, Member me, Body body)
    {
        var seconds = Seconds(body);
        var targets = new[] { body.Has("channelId"), body.Has("accountKey"), body.Has("groupId") }.Count(x => x);
        if (targets != 1) throw RequestException.BadRequest("Give one of 'channelId', 'accountKey' or 'groupId'.");
        var store = s.World.Store;

        if (body.Has("channelId"))
        {
            var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
            if (channel.Kind is not ("text" or "voice" or "stage"))
                throw RequestException.BadRequest("Messages can't disappear in this kind of channel.", "disappear_kind");
            if (!Permissions.Has(me, Perm.ManageChannels)) throw RequestException.Forbidden("You can't manage channels on this server.", "manage_channels");
            var before = store.ChannelTimer(channel.Id);
            if ((before?.Seconds ?? 0) == seconds) return new { timer = View("channel", channel.Id.ToString(), before ?? new(0, me.AccountKey, 0)) };
            // The line everyone sees. Apps show it from `disappear`; the text is for apps from before disappearing messages.
            var text = E2eeChannelFeature.IsEncrypted(store, channel) ? "" : FallbackText(seconds);
            var line = store.AddMessage(channel.Id, me.AccountKey, text, s.Now);
            store.MarkDisappearNotice(line.Id, seconds);
            store.SetChannelTimer(channel.Id, seconds, me.AccountKey, s.Now);
            var timer = store.ChannelTimer(channel.Id)!;
            s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = MessageViews.Public(store, line) }));
            s.Hub.BroadcastToReaders(channel, Frames.Event("disappear.changed", new { timer = View("channel", channel.Id.ToString(), timer) }));
            return new { timer = View("channel", channel.Id.ToString(), timer) };
        }

        if (body.Has("accountKey"))
        {
            var key = body.String("accountKey", 64);
            var peer = (key == me.AccountKey ? me : store.GetMember(key)) ?? throw RequestException.NotFound("Member");
            ModerationFeature.CheckNotBlocked(s, me, peer, "message");
            DmPrivacyFeature.CheckContact(s, me, peer, "message");
            store.SetDmTimer(me.AccountKey, peer.AccountKey, seconds, me.AccountKey, s.Now);
            var timer = store.DmTimer(me.AccountKey, peer.AccountKey)!;
            // Each side sees the other person as the conversation.
            s.Hub.SendToAccount(me.AccountKey, Frames.Event("disappear.changed", new { timer = View("dm", peer.AccountKey, timer) }));
            if (peer.AccountKey != me.AccountKey)
                s.Hub.SendToAccount(peer.AccountKey, Frames.Event("disappear.changed", new { timer = View("dm", me.AccountKey, timer) }));
            return new { timer = View("dm", peer.AccountKey, timer) };
        }

        var id = body.String("groupId", GroupChain.IdLength);
        var group = GroupChain.IsId(id) && store.GetGroup(id) is { } g && g.Members.Contains(me.AccountKey) ? g : throw RequestException.NotFound("Group");
        if (store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't be in group DMs.");
        store.SetGroupTimer(group.Id, seconds, me.AccountKey, s.Now);
        var groupTimer = store.GroupTimer(group.Id)!;
        var frame = Frames.Event("disappear.changed", new { timer = View("group", group.Id, groupTimer) });
        foreach (var account in group.Members) s.Hub.SendToAccount(account, frame);
        return new { timer = View("group", group.Id, groupTimer) };
    }

    private static object List(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var timers = new List<object>();
        foreach (var (channelId, timer) in store.ChannelTimers())
            if (store.GetChannel(channelId) is { } channel && Permissions.CanRead(me, channel)) timers.Add(View("channel", channelId.ToString(), timer));
        foreach (var (peer, timer) in store.DmTimers(me.AccountKey)) timers.Add(View("dm", peer, timer));
        foreach (var (group, timer) in store.GroupTimers(me.AccountKey)) timers.Add(View("group", group, timer));
        return new { timers };
    }

    /// <summary>`Disappear { scope, channelId | accountKey | groupId, seconds, setBy, setAt }`.</summary>
    public static object View(string scope, string target, DisappearTimer timer) => scope switch
    {
        "channel" => new { scope, channelId = long.Parse(target, System.Globalization.CultureInfo.InvariantCulture), seconds = timer.Seconds, setBy = timer.SetBy, setAt = timer.SetAt },
        "dm" => new { scope, accountKey = target, seconds = timer.Seconds, setBy = timer.SetBy, setAt = timer.SetAt },
        _ => (object)new { scope, groupId = target, seconds = timer.Seconds, setBy = timer.SetBy, setAt = timer.SetAt },
    };

    /// <summary>English, for apps that don't know disappearing messages (they show it as a normal message).</summary>
    public static string FallbackText(int seconds) => seconds == 0
        ? "Turned off disappearing messages."
        : $"Set new messages to disappear after {Duration(seconds)}. (Update Iskra to see the timer.)";

    private static string Duration(int seconds) => seconds switch
    {
        300 => "5 minutes",
        3600 => "1 hour",
        28800 => "8 hours",
        86400 => "1 day",
        604800 => "7 days",
        _ => "4 weeks",
    };

    // ── Each message's expiry ────────────────────────────────────────────────

    /// <summary>
    /// The `expires` an encrypted envelope's header carries (seconds; signed or authenticated with the message, so apps
    /// can hold the server to it), or null. Anything other than one of the timers is refused.
    /// </summary>
    public static int? EnvelopeExpires(JsonElement envelope)
    {
        if (envelope.ValueKind != JsonValueKind.Object || !envelope.TryGetProperty("header", out var header) || header.ValueKind != JsonValueKind.Object
            || !header.TryGetProperty("expires", out var expires))
            return null;
        if (expires.ValueKind == JsonValueKind.Number && expires.TryGetInt32(out var seconds) && seconds > 0 && Allowed.Contains(seconds)) return seconds;
        throw RequestException.BadRequest("That isn't one of the disappearing message timers.", "disappear_timer");
    }

    private static int? EnvelopeExpires(string raw)
    {
        using var doc = JsonDocument.Parse(raw);
        return EnvelopeExpires(doc.RootElement);
    }

    /// <summary>The sooner of the timer and the envelope's own expiry, as a time; null if neither applies.</summary>
    private static long? ExpiryFor(DisappearTimer? timer, int? envelope, long createdAt)
    {
        int? seconds = timer is { Seconds: > 0 } t ? t.Seconds : null;
        if (envelope is { } e) seconds = seconds is { } s ? Math.Min(s, e) : e;
        return seconds is { } x ? createdAt + x * 1000L : null;
    }

    /// <summary>A stored DM gets its expiry (and its files are remembered to go with it).</summary>
    public static DirectMessage Stamp(Store store, DirectMessage m, string[] files)
    {
        var at = ExpiryFor(store.DmTimer(m.From, m.To), EnvelopeExpires(m.Envelope), m.CreatedAt);
        return m with { ExpiresAt = store.StampExpiry("dm", m.Id, at, files) };
    }

    public static GroupMessage Stamp(Store store, GroupMessage m, string[] files)
    {
        var at = ExpiryFor(store.GroupTimer(m.GroupId), EnvelopeExpires(m.Envelope), m.CreatedAt);
        return m with { ExpiresAt = store.StampExpiry("group", m.Id, at, files) };
    }

    /// <summary>An encrypted channel message: the trigger applied the channel's timer; the envelope may make it sooner.</summary>
    public static void Stamp(Store store, Message m, string envelope, string[] files) =>
        store.StampExpiry("channel", m.Id, EnvelopeExpires(envelope) is { } e ? m.CreatedAt + e * 1000L : null, files);

    /// <summary>Whether a channel message will disappear (pushes then leave its text out).</summary>
    public static bool Expiring(Store store, long messageId) => store.MessageExpiry(messageId).ExpiresAt is not null;
}

/// <summary>Deletes expired messages every few seconds (apps also delete their copies on their own clocks).</summary>
public sealed class DisappearSweeper(World world, Hub hub, Files.Uploads uploads, TimeProvider time, ILogger<DisappearSweeper> log) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);
    private const int Batch = 500;

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        world.Store.SecureSearchDeletes();
        using var timer = new PeriodicTimer(Interval, time);
        do Sweep(time.GetUtcNow().ToUnixTimeMilliseconds());
        while (await timer.WaitForNextTickAsync(stopping).ConfigureAwait(false));
    }

    /// <summary>One pass. Returns how many channel messages, DM and group messages, and files went.</summary>
    internal (int Messages, int Envelopes, int Files) Sweep(long now)
    {
        var result = (Messages: 0, Envelopes: 0, Files: 0);
        try
        {
            ExpiredSweep swept;
            do
            {
                swept = world.Store.DeleteExpired(now, Batch);
                result.Messages += swept.Messages.Count;
                result.Envelopes += swept.Envelopes;
                result.Files += uploads.DeleteExpiredFiles(swept.FileIds);
                foreach (var (thread, parent, root) in swept.Threads)
                    if (world.Store.GetChannel(parent) is { } channel)
                        hub.BroadcastToReaders(channel, Frames.Event("thread.deleted", new { id = thread, channelId = parent, rootId = root }));
                foreach (var group in swept.Messages.GroupBy(m => m.ChannelId))
                {
                    if (world.Store.GetChannel(group.Key) is not { } channel) continue;
                    foreach (var (id, _) in group) hub.BroadcastToReaders(channel, Frames.Event("chat.deleted", new { id, channelId = channel.Id }));
                }
            } while (swept.Messages.Count == Batch || swept.Envelopes >= Batch);
            if (result.Messages + result.Envelopes > 0)
            {
                world.Store.CheckpointAfterDelete();
                log.Info("sweep", "done", ("what", "disappearing"), ("msgs", result.Messages), ("envelopes", result.Envelopes), ("files", result.Files));
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.Warn(ex, "SWP-110", "sweep", "failed", ("what", "disappearing"));
        }
        return result;
    }
}
