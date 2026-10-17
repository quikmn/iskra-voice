using System.Collections.Concurrent;

namespace Iskra.Server.Sessions;

/// <summary>
/// Token buckets per account (shared by all of its sessions), for actions where opening more
/// connections must not buy more: uploads, calls, new threads. Thread-safe.
/// </summary>
public sealed class AccountLimits(TimeProvider time)
{
    /// <summary>Burst and refill per second for each kind of action.</summary>
    public static readonly Dictionary<string, (double Burst, double PerSecond)> Limits = new()
    {
        ["upload.begin"] = (20, 1),
        ["call.start"] = (10, 10 / 60.0),          // 10 a minute in total…
        ["call.start.callee"] = (3, 3 / 60.0),     // …and 3 a minute to the same person
        ["thread.create"] = (5, 5 / 60.0),
        ["event.create"] = (5, 5 / 600.0),         // 5 at once, then one every 2 minutes
        ["group.change"] = (10, 10 / 60.0),       // creating groups and changing who is in them
        ["link.http"] = (60, 2),                   // device-link HTTP requests, per client address
        ["link.part"] = (300, 20),                 // device-link history parts (they need the link keys), per client address
        ["gif.media"] = (200, 20),                 // GIF media proxy, per client address
        ["landing.page"] = (30, 1),
        ["activity.file"] = (300, 30),             // server-added activities' files, per client address                // the public page (GET / from a browser), per client address
        ["captions.model"] = (30, 0.2),            // the captions model's parts (6 a download), per client address
        ["translate.model"] = (40, 0.5),           // translation models' parts (3-4 a language and direction), per client address
        ["report.create"] = (5, 1 / 120.0),        // 5 at once, then one every 2 minutes
        ["data.export"] = (2, 1 / 600.0),          // "Download my data", whatever the number of connections
        ["scheduled.deliver"] = (10, 2),           // scheduled messages going out: chat.send's burst, so 50 at one time trickle out
        ["bot.dm.send"] = (30, 1),                 // a bot's DMs, over all of its connections
        ["bot.dm.new"] = (20, 20 / 3600.0),        // conversations a bot starts: 20, then 20 an hour
    };

    private const int PruneAbove = 10_000;

    private sealed class Bucket(double tokens, long updated)
    {
        public double Tokens = tokens;
        public long Updated = updated;
    }

    private readonly ConcurrentDictionary<(string Account, string Kind, string? Target), Bucket> _buckets = new();

    /// <summary>Takes one token for this account (and optional target, e.g. the person being called).</summary>
    public bool TryTake(string accountKey, string kind, string? target = null)
    {
        var (burst, perSecond) = Limits[kind];
        var now = time.GetTimestamp();
        if (_buckets.Count > PruneAbove) Prune(now);
        var bucket = _buckets.GetOrAdd((accountKey, kind, target), _ => new Bucket(burst, now));
        lock (bucket)
        {
            bucket.Tokens = Math.Min(burst, bucket.Tokens + time.GetElapsedTime(bucket.Updated, now).TotalSeconds * perSecond);
            bucket.Updated = now;
            if (bucket.Tokens < 1) return false;
            bucket.Tokens -= 1;
            return true;
        }
    }

    /// <summary>Forgets buckets that have refilled completely: they behave exactly like new ones.</summary>
    private void Prune(long now)
    {
        foreach (var (key, bucket) in _buckets)
        {
            var (burst, perSecond) = Limits[key.Kind];
            if (bucket.Tokens + time.GetElapsedTime(bucket.Updated, now).TotalSeconds * perSecond >= burst) _buckets.TryRemove(key, out _);
        }
    }
}
