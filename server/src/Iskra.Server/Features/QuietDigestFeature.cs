using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>What came in for a member during one quiet stretch, on this server. Counts only: never content.</summary>
public sealed record QuietDigestCounts(int Mentions, int Messages, int Keywords, int Follows, int Events, int Reminders)
{
    public int Total => Mentions + Messages + Keywords + Follows + Events + Reminders;
}

/// <summary>
/// The quiet hours digest: when a member's quiet hours end (the schedule ends, or they turn them off), each of their
/// devices that isn't looking at Iskra gets one push from this server summing up this server's own items ("While it was
/// quiet: 3 mentions, 2 messages"), only if anything happened and only if they didn't opt out (<c>digest: false</c>).
/// The server knows the schedule only where push is on (see AlertFeature), which is exactly where the push can go.
/// Open apps show their own card, gathered across all servers on the device.
/// </summary>
public static class QuietDigestFeature
{
    /// <summary>Events starting this soon after quiet hours end count as "starting soon".</summary>
    public static readonly TimeSpan Soon = TimeSpan.FromHours(1);

    /// <summary>How far back a stretch can reach (an all-week schedule never ends on its own).</summary>
    public static readonly TimeSpan MaxStretch = TimeSpan.FromDays(7);

    private static readonly HashSet<string> MentionKinds = ["mention", "reply", "role", "everyone"];

    // ── When ─────────────────────────────────────────────────────────────────

    /// <summary>When the quiet stretch running at <paramref name="now"/> began (to the minute, at most a week back).</summary>
    public static long StretchStart(QuietHours quiet, DateTimeOffset now)
    {
        var t = new DateTimeOffset(now.UtcTicks - now.UtcTicks % TimeSpan.TicksPerMinute, TimeSpan.Zero);
        var limit = now - MaxStretch;
        var coarse = TimeSpan.FromMinutes(15);
        while (t - coarse >= limit && AlertFeature.Active(quiet, t - coarse)) t -= coarse;
        for (var i = 0; i < 15 && t - TimeSpan.FromMinutes(1) >= limit && AlertFeature.Active(quiet, t - TimeSpan.FromMinutes(1)); i++)
            t -= TimeSpan.FromMinutes(1);
        return t.ToUnixTimeMilliseconds();
    }

    /// <summary>
    /// One step for one member: the new start of their quiet stretch (null outside one), and whether a stretch that began
    /// at the returned <c>Ended</c> time just ended.
    /// </summary>
    public static (long? Since, long? Ended) Advance(QuietHours? quiet, long? since, DateTimeOffset now)
    {
        var active = quiet is not null && AlertFeature.Active(quiet, now);
        if (active) return (since ?? StretchStart(quiet!, now), null);
        return (null, since);
    }

    // ── What ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// This server's items for the member in [from, to): pings they can still read (not from people either of them
    /// blocked), DMs and group messages from others, reminders that came due, and events they're interested in (and can
    /// see) that started or start soon.
    /// </summary>
    public static QuietDigestCounts Summarize(Store store, string accountKey, long from, long to)
    {
        if (store.GetMember(accountKey) is not { } me) return new(0, 0, 0, 0, 0, 0);
        int mentions = 0, keywords = 0, follows = 0;
        foreach (var item in store.InboxItemsBetween(accountKey, from, to))
        {
            if (store.GetMessage(item.MessageId) is not { } message || store.GetChannel(message.ChannelId) is not { } channel) continue;
            if (!Permissions.CanRead(me, channel) || store.EitherBlocked(accountKey, message.AuthorKey)) continue;
            if (MentionKinds.Contains(item.Kind)) mentions++;
            else if (item.Kind == "keyword") keywords++;
            else if (item.Kind == "follow") follows++;
        }
        var messages = store.DmsBetween(accountKey, from, to).Concat(store.GroupMessagesBetween(accountKey, from, to))
            .Where(m => !store.EitherBlocked(accountKey, m.From)).Sum(m => m.Count);
        var events = store.InterestingEventsBetween(accountKey, from, to, (long)Soon.TotalMilliseconds).Count(e => EventFeature.CanSee(store, me, e));
        return new(mentions, messages, keywords, follows, events, store.RemindersFiredBetween(accountKey, from, to));
    }

    /// <summary>"3 mentions, 2 messages, 1 reminder": the English body (apps show it in their language from the counts).</summary>
    public static string Body(QuietDigestCounts c)
    {
        static string Part(int n, string one, string many) => n == 1 ? $"1 {one}" : $"{n} {many}";
        var parts = new List<string>();
        if (c.Mentions > 0) parts.Add(Part(c.Mentions, "mention", "mentions"));
        if (c.Messages > 0) parts.Add(Part(c.Messages, "message", "messages"));
        if (c.Keywords > 0) parts.Add(Part(c.Keywords, "alert word", "alert words"));
        if (c.Follows > 0) parts.Add(Part(c.Follows, "post by someone you follow", "posts by people you follow"));
        if (c.Events > 0) parts.Add(Part(c.Events, "event", "events"));
        if (c.Reminders > 0) parts.Add(Part(c.Reminders, "reminder", "reminders"));
        return string.Join(", ", parts);
    }

    /// <summary>Sends the digest push for [from, to) if anything happened. Returns what it counted.</summary>
    public static QuietDigestCounts Send(Store store, PushService push, string accountKey, long from, long to)
    {
        var counts = Summarize(store, accountKey, from, to);
        if (counts.Total == 0) return counts;
        var args = new { mentions = counts.Mentions, messages = counts.Messages, keywords = counts.Keywords, follows = counts.Follows, events = counts.Events, reminders = counts.Reminders };
        push.Notify(accountKey, new PushNote("digest", "digest", "While it was quiet", Body(counts), "", Coalesce: false, TtlSeconds: 12 * 3600,
            Text: new PushText("digest", "digestBody", args), Silent: true), afterQuiet: true);
        return counts;
    }

    // ── Hooks ────────────────────────────────────────────────────────────────

    /// <summary>
    /// After <c>alerts.set</c>: a stretch that the new settings end (quiet hours turned off, or moved off now) ends right
    /// away; one they start is noted. <paramref name="before"/> decides the opt-out when quiet hours were turned off.
    /// </summary>
    public static void AfterSet(Store store, PushService push, string accountKey, QuietHours? before, long? since, QuietHours? after, DateTimeOffset now)
    {
        var (next, ended) = Advance(after, since, now);
        if (next != since) store.SetQuietSince(accountKey, next);
        if (ended is { } from && (after ?? before)?.Digest != false) Send(store, push, accountKey, from, now.ToUnixTimeMilliseconds());
    }

    /// <summary>One pass over everyone with quiet hours here.</summary>
    public static void Tick(Store store, PushService push, DateTimeOffset now)
    {
        foreach (var watch in store.QuietWatches())
        {
            var quiet = watch.Quiet is { } json ? AlertFeature.ParseStoredQuiet(json) : null;
            var (next, ended) = Advance(quiet, watch.Since, now);
            if (next != watch.Since) store.SetQuietSince(watch.AccountKey, next);
            if (ended is { } from && quiet?.Digest != false) Send(store, push, watch.AccountKey, from, now.ToUnixTimeMilliseconds());
        }
    }
}

/// <summary>Checks every half minute (QuietDigest:TickMs; 0 turns the timer off, for tests that tick by hand) whose quiet hours began or ended.</summary>
public sealed class QuietDigestScheduler(World world, PushService push, TimeProvider time, IConfiguration config, ILogger<QuietDigestScheduler> log)
    : BackgroundService
{
    private readonly long _tickMs = config.GetValue("QuietDigest:TickMs", 30_000L);

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (_tickMs <= 0) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(_tickMs), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping)) Tick();
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>One pass, at <paramref name="at"/> (tests) or now.</summary>
    internal void Tick(DateTimeOffset? at = null)
    {
        try
        {
            QuietDigestFeature.Tick(world.Store, push, at ?? time.GetUtcNow());
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not ObjectDisposedException)
        {
            log.Warn(ex, "SCH-110", "sched", "failed", ("what", "digest"));
        }
    }
}
