using System.Collections.Concurrent;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>What someone is doing right now ("Playing X"), shown on their member card.</summary>
public sealed record Activity(string Name, long Since);

/// <summary>
/// Activity status: set by the client (the desktop app's game detection), kept only in memory and only while the
/// account is online. The server never sees how it was detected, only the name.
/// </summary>
public sealed class ActivityRegistry(TimeProvider time)
{
    private readonly ConcurrentDictionary<string, Activity> _activities = new(StringComparer.Ordinal);

    public Activity? Get(string accountKey) => _activities.TryGetValue(accountKey, out var a) ? a : null;

    /// <summary>Sets or clears (null) the activity. Returns false if nothing changed. The same name keeps its start time.</summary>
    public bool Set(string accountKey, string? name)
    {
        if (name is null) return _activities.TryRemove(accountKey, out _);
        var current = Get(accountKey);
        if (current?.Name == name) return false;
        _activities[accountKey] = new Activity(name, time.GetUtcNow().ToUnixTimeMilliseconds());
        return true;
    }

    public void Clear(string accountKey) => _activities.TryRemove(accountKey, out _);
}

public static class ActivityFeature
{
    public const int MaxNameLength = 64;

    public static void Register(Router router) => router.Add("activity.set", Set);

    /// <summary>The public view: the name and when it started (ms), or null.</summary>
    public static object? Public(Activity? a) => a is null ? null : new { name = a.Name, since = a.Since };

    /// <summary>`name`: 1–64 characters (same text rules as names), or null / "" to clear.</summary>
    private static object Set(Session s, Member me, Body body)
    {
        var raw = body.OptionalString("name", MaxNameLength * 2);
        var name = string.IsNullOrWhiteSpace(raw) ? null
            : Text.Normalize(raw, MaxNameLength, allowNewlines: false)
              ?? throw RequestException.BadRequest($"Activity names can be up to {MaxNameLength} characters, with no invisible characters.", "activity_name", new { max = MaxNameLength });
        // Only real changes count against the limit: a client may repeat itself (e.g. after reconnecting).
        if (s.Hub.Activities.Get(me.AccountKey)?.Name != name && !s.TryTakeLimit("activity.change"))
            throw new RequestException("rate_limited", "Your activity is changing too often.", "activity_too_often");
        if (s.Hub.Activities.Set(me.AccountKey, name))
            s.Hub.Broadcast(Frames.Event("member.updated", new { member = s.Hub.PublicMember(s.World.Store.GetMember(me.AccountKey) ?? me) }));
        return new { activity = Public(s.Hub.Activities.Get(me.AccountKey)) };
    }
}
