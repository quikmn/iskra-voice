using System.Collections.Concurrent;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Safety and moderation: block lists (kept per account, synced by the client to every server it's on),
/// timeouts, slowmode, and the admins' audit log.
/// </summary>
public static class ModerationFeature
{
    public const int MaxBlocks = 500;
    public const int MaxReasonLength = 200;
    public const int MaxAuditPage = 100;
    /// <summary>How far in the future a block entry's time may be (clock skew).</summary>
    private const long MaxClockSkewMs = 10 * 60 * 1000;

    public static readonly long[] TimeoutDurations = [60_000, 5 * 60_000, 3600_000, 24 * 3600_000, 7 * 24 * 3600_000];
    public static readonly int[] SlowmodeSteps = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

    /// <summary>What a timed-out member can't do: write, react, make threads or polls, use voice, calls and the soundboard.</summary>
    private static readonly HashSet<string> BlockedWhileTimedOut =
    [
        "chat.send", "chat.edit", "chat.react", "chat.typing", "chat.pin", "upload.begin", "interaction.invoke",
        "thread.create", "thread.update", "poll.create", "poll.vote", "poll.end",
        "voice.join", "sound.play", "call.start", "call.accept",
        "forum.post.create", "forum.post.update", "event.create", "event.update",
        "docs.page.create", "docs.page.save", "docs.page.move", "docs.page.delete", "docs.page.restore",
        "wb.open", "wb.update", "wb.live", "wb.snapshot", "wb.clear",
    ];

    public static void Register(Router router)
    {
        router.Add("block.list", (s, me, _) => new { blocks = s.World.Store.Blocks(me.AccountKey).Select(PublicBlock) });
        router.Add("block.sync", SyncBlocks);
        router.Add("member.timeout", SetTimeout);
        router.Add("member.timeout.remove", RemoveTimeout);
        router.Add("member.timeout.status", TimeoutStatus);
        router.Add("audit.list", ListAudit);
    }

    // ── Blocks ───────────────────────────────────────────────────────────────

    private static object PublicBlock(BlockEntry e) => new { accountKey = e.AccountKey, blocked = e.Blocked, at = e.At };

    /// <summary>
    /// Merges the client's entries into the stored list: per person, the newest change wins (a block beats an unblock made
    /// at the same moment). Old unblocks are dropped first when the list is full.
    /// </summary>
    private static object SyncBlocks(Session s, Member me, Body body)
    {
        var raw = body.Element("entries");
        if (raw.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest("'entries' must be a list.");
        if (raw.GetArrayLength() > MaxBlocks) throw RequestException.BadRequest($"'entries' can have at most {MaxBlocks} items.");

        var incoming = raw.EnumerateArray().Select(item => ParseBlock(s, me, item)).ToList();
        var stored = s.World.Store.Blocks(me.AccountKey);
        var merged = stored.ToDictionary(e => e.AccountKey);
        var newlyBlocked = new List<string>();
        foreach (var entry in incoming)
        {
            if (merged.TryGetValue(entry.AccountKey, out var current) &&
                (current.At > entry.At || (current.At == entry.At && (current.Blocked || !entry.Blocked)))) continue;
            if (entry.Blocked && current is not { Blocked: true }) newlyBlocked.Add(entry.AccountKey);
            merged[entry.AccountKey] = entry;
        }

        var list = merged.Values.OrderBy(e => e.At).ToList();
        while (list.Count > MaxBlocks && list.FindIndex(e => !e.Blocked) is var i and >= 0) list.RemoveAt(i);
        if (list.Count > MaxBlocks) throw RequestException.BadRequest($"You can block up to {MaxBlocks} people.", "blocks_max", new { max = MaxBlocks });

        var changed = list.Count != stored.Count || list.Any(e => !stored.Contains(e));
        if (changed)
        {
            s.World.Store.SaveBlocks(me.AccountKey, list);
            var blocks = list.Select(PublicBlock).ToList();
            var frame = Frames.Event("blocks", new { blocks });
            foreach (var other in s.Hub.Sessions.Where(o => o.AccountKey == me.AccountKey && o != s)) other.Send(frame);
            // Calls with someone you just blocked end (they can't ring you again either).
            foreach (var key in newlyBlocked) s.Voice.Calls.EndWhere(c => c.Involves(me.AccountKey) && c.Involves(key));
            if (newlyBlocked.Count > 0) s.Voice.Whisper.Sync(); // ...and so do whispers between you
        }
        return new { blocks = list.Select(PublicBlock) };
    }

    private static BlockEntry ParseBlock(Session s, Member me, JsonElement item)
    {
        var entry = new Body(item);
        if (item.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each entry must be an object.");
        var key = entry.String("accountKey", 64);
        if (!Ed25519.TryFromB64u(key, out var bytes) || bytes.Length != 32) throw RequestException.BadRequest("'accountKey' must be an account key.");
        if (key == me.AccountKey) throw RequestException.BadRequest("You can't block yourself.", "block_self");
        var blocked = entry.OptionalBool("blocked") ?? throw RequestException.BadRequest("'blocked' is required.");
        var at = entry.OptionalLong("at", min: 0, max: s.Now + MaxClockSkewMs) ?? throw RequestException.BadRequest("'at' is required.");
        return new BlockEntry(key, blocked, at);
    }

    /// <summary>DMs and calls between two people need neither to have blocked the other. The refusal doesn't say who blocked whom.</summary>
    internal static void CheckNotBlocked(Session s, Member me, Member peer, string what)
    {
        if (peer.AccountKey != me.AccountKey && s.World.Store.EitherBlocked(me.AccountKey, peer.AccountKey))
            throw RequestException.Forbidden($"You can't {what} this person.", $"blocked_{what}");
    }

    // ── Timeouts ─────────────────────────────────────────────────────────────

    /// <summary>The router asks before every request: a timed-out member is refused anything in <see cref="BlockedWhileTimedOut"/>.</summary>
    internal static RequestException? Gate(Session s, Member me, string type)
    {
        if (!BlockedWhileTimedOut.Contains(type) || s.World.Store.TimedOutUntil(me.AccountKey, s.Now) is null) return null;
        return RequestException.Forbidden("You're timed out on this server for now.", "timed_out");
    }

    internal static bool IsTimedOut(Store store, string accountKey, long now) => store.TimedOutUntil(accountKey, now) is not null;

    private static string Reason(Body body) =>
        body.OptionalString("reason", MaxReasonLength * 2) is { } raw && raw.Trim().Length > 0
            ? Text.Normalize(raw, MaxReasonLength, allowNewlines: false) ?? throw RequestException.BadRequest($"Reasons can be up to {MaxReasonLength} characters.", "reason_length", new { max = MaxReasonLength })
            : "";

    private static object SetTimeout(Session s, Member me, Body body)
    {
        var target = MemberFeature.Target(s, me, body, Perm.TimeoutMembers);
        var duration = body.OptionalLong("durationMs") ?? throw RequestException.BadRequest("'durationMs' is required.");
        if (!TimeoutDurations.Contains(duration))
            throw RequestException.BadRequest("'durationMs' must be 60 s, 5 min, 1 hour, 1 day or 1 week.");
        var reason = Reason(body);
        var until = s.Now + duration;

        s.World.Store.SetTimeout(new MemberTimeout(target.AccountKey, until, reason, me.AccountKey, s.Now));
        Audit.Record(s, "member.timeout", target.AccountKey, reason, new { durationMs = duration, until });
        var member = s.Hub.PublicMember(target);
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        s.Voice.RemoveEverywhere(target.AccountKey);
        return new { member };
    }

    private static object RemoveTimeout(Session s, Member me, Body body)
    {
        var target = MemberFeature.Target(s, me, body, Perm.TimeoutMembers);
        if (!s.World.Store.RemoveTimeout(target.AccountKey)) throw RequestException.NotFound("Timeout");
        Audit.Record(s, "member.timeout.remove", target.AccountKey);
        var member = s.Hub.PublicMember(target);
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        return new { member };
    }

    /// <summary>Your own timeout, with the reason (others only see when it ends).</summary>
    private static object TimeoutStatus(Session s, Member me, Body body)
    {
        var t = s.World.Store.GetTimeout(me.AccountKey);
        return new { timeout = t is not null && t.Until > s.Now ? new { until = t.Until, reason = t.Reason.Length > 0 ? t.Reason : null } : null };
    }

    // ── Slowmode ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Before a message is stored: one message per member per slowmode interval (the channel's, or the newcomer slowmode
    /// while they're new, whichever is longer). People who manage messages or channels are exempt.
    /// </summary>
    internal static void CheckSlowmode(Session s, Member me, Channel channel)
    {
        if (Permissions.Has(me, Perm.ManageMessages) || Permissions.Has(me, Perm.ManageChannels)) return;
        var seconds = Math.Max(s.World.Store.Slowmode(channel.Id), JoinFeature.NewcomerSlowmode(s.World.Store, me, s.Now));
        if (seconds <= 0) return;
        if (!s.Hub.Slowmode.TryTake(channel.Id, me.AccountKey, seconds * 1000L, s.Now, out var waitMs))
            throw new RequestException("rate_limited", $"Slowmode is on. You can send again in {Wait(waitMs)}.", "slowmode", new { seconds = (waitMs + 999) / 1000 });
    }

    private static string Wait(long ms)
    {
        var seconds = (ms + 999) / 1000;
        return seconds < 60 ? $"{seconds} s" : seconds < 3600 ? $"{(seconds + 59) / 60} min" : $"{(seconds + 3599) / 3600} h";
    }

    /// <summary>Validates a <c>slowmode</c> field (seconds, one of <see cref="SlowmodeSteps"/>).</summary>
    internal static int? SlowmodeField(Body body)
    {
        if (body.OptionalLong("slowmode", min: 0, max: SlowmodeSteps[^1]) is not { } value) return null;
        if (!SlowmodeSteps.Contains((int)value)) throw RequestException.BadRequest("'slowmode' must be off or one of the offered steps (5 s to 6 h).");
        return (int)value;
    }

    // ── Audit log ────────────────────────────────────────────────────────────

    private static object ListAudit(Session s, Member me, Body body)
    {
        if (!Permissions.Has(me, Perm.ViewAuditLog)) throw RequestException.Forbidden("You can't read the activity log on this server.", "read_activity_log");
        var action = body.OptionalString("action", 40);
        var person = body.OptionalString("person", 64);
        var before = body.OptionalLong("before", min: 1);
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxAuditPage) ?? 50);
        var entries = s.World.Store.Audit(action, person, before, limit);
        return new
        {
            entries = entries.Select(e => new
            {
                id = e.Id, at = e.At, action = e.Action, actor = e.Actor, actorName = e.ActorName, target = e.Target, targetName = e.TargetName,
                reason = e.Reason,
                details = e.Details is null ? (JsonElement?)null : JsonDocument.Parse(e.Details).RootElement.Clone(),
            }),
            hasMore = entries.Count == limit,
        };
    }
}

/// <summary>Records moderation and admin actions for the audit log (kept Retention.AuditDays, 90 by default).</summary>
public static class Audit
{
    /// <summary>Call before the change removes the target (names are looked up now and kept with the entry).</summary>
    public static void Record(Session s, string action, string? target = null, string? reason = null, object? details = null)
    {
        var store = s.World.Store;
        var actor = s.AccountKey!;
        store.AddAudit(s.Now, action, actor, store.GetMember(actor)?.Name ?? "",
            target, target is null ? null : store.GetMember(target)?.Name,
            string.IsNullOrEmpty(reason) ? null : reason,
            details is null ? null : JsonSerializer.Serialize(details, Json.Options));
    }
}

/// <summary>When each member last sent a message in each slowmode channel (in memory; a restart forgets it).</summary>
public sealed class SlowmodeTracker
{
    private readonly ConcurrentDictionary<(long Channel, string Account), long> _last = new();

    public bool TryTake(long channelId, string accountKey, long intervalMs, long now, out long waitMs)
    {
        var key = (channelId, accountKey);
        while (true)
        {
            if (_last.TryGetValue(key, out var last))
            {
                if (now - last < intervalMs)
                {
                    waitMs = intervalMs - (now - last);
                    return false;
                }
                if (_last.TryUpdate(key, now, last)) break;
            }
            else if (_last.TryAdd(key, now)) break;
        }
        waitMs = 0;
        // Keep the map small: forget entries older than the longest slowmode.
        if (_last.Count > 10_000)
            foreach (var (k, at) in _last)
                if (now - at > ModerationFeature.SlowmodeSteps[^1] * 1000L) _last.TryRemove(k, out _);
        return true;
    }
}

/// <summary>Ends timeouts when they run out (so everyone sees it) and drops audit entries and departures older than Retention.AuditDays.</summary>
public sealed class ModerationSweeper(World world, Hub hub, TimeProvider time, ILogger<ModerationSweeper> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1), time);
        var ticks = 0;
        try
        {
            Sweep(pruneAudit: true);
            while (await timer.WaitForNextTickAsync(stopping)) Sweep(pruneAudit: ++ticks % 3600 == 0);
        }
        catch (OperationCanceledException) { }
    }

    internal void Sweep(bool pruneAudit)
    {
        try
        {
            var now = time.GetUtcNow().ToUnixTimeMilliseconds();
            foreach (var key in world.Store.EndExpiredTimeouts(now))
                if (world.Store.GetMember(key) is { } member) hub.Broadcast(Frames.Event("member.updated", new { member = hub.PublicMember(member) }));
            if (pruneAudit)
            {
                if (world.Settings.Retention.AuditDays is > 0 and var days)
                {
                    var cutoff = now - (long)TimeSpan.FromDays(days).TotalMilliseconds;
                    world.Store.PruneAudit(cutoff);
                    world.Store.PruneDepartures(cutoff); // "People who left" (ModPackFeature) share the audit log's horizon
                }
                world.Store.PruneNonces(now - (long)TimeSpan.FromDays(1).TotalMilliseconds);
                world.Store.PruneJoinRequests(now);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Moderation sweep failed");
        }
    }
}
