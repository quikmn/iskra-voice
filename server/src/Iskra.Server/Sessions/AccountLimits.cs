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
