namespace Iskra.Server.Sessions;

/// <summary>A token bucket per request type, per session. Not thread-safe: only the session's read loop uses it.</summary>
public sealed class RateLimiter(TimeProvider time)
{
    private sealed class Bucket(double capacity, double perSecond, long now)
    {
        public double Tokens = capacity;
        public long Updated = now;
        public readonly double Capacity = capacity;
        public readonly double PerSecond = perSecond;
    }

    private static readonly Dictionary<string, (double Burst, double PerSecond)> Limits = new()
    {
        ["chat.send"] = (10, 2),
        ["dm.send"] = (10, 2),
        ["upload.begin"] = (10, 2),
        ["chat.react"] = (20, 5),
        ["link.preview"] = (10, 1),
        ["chat.typing"] = (3, 0.5),
        ["search"] = (10, 2),
        ["poll.create"] = (5, 0.2),
        ["poll.vote"] = (10, 2),
        ["sound.play"] = (3, 0.5),
        ["link.create"] = (3, 0.1),
        ["device.revoke.new"] = (10, 10 / 3600.0), // new revocations: 10 an hour, so a thief can't use up the 100 at once
        ["*"] = (40, 10),
    };

    private readonly Dictionary<string, Bucket> _buckets = [];

    public bool TryTake(string type)
    {
        var now = time.GetTimestamp();
        return Take("*", now) && (!Limits.ContainsKey(type) || Take(type, now));
    }

    /// <summary>Takes from one named bucket only (for limits checked inside a handler, e.g. only on real changes).</summary>
    public bool TryTakeOnly(string key) => Take(key, time.GetTimestamp());

    private bool Take(string key, long now)
    {
        if (!_buckets.TryGetValue(key, out var bucket))
        {
            var (burst, perSecond) = Limits[key];
            _buckets[key] = bucket = new Bucket(burst, perSecond, now);
        }
        var elapsed = time.GetElapsedTime(bucket.Updated, now).TotalSeconds;
        bucket.Tokens = Math.Min(bucket.Capacity, bucket.Tokens + elapsed * bucket.PerSecond);
        bucket.Updated = now;
        if (bucket.Tokens < 1) return false;
        bucket.Tokens -= 1;
        return true;
    }
}
