using Iskra.Server.Storage;

namespace Iskra.Server.Push;

public sealed partial class PushService
{
    /// <summary>A group DM message. Like DMs, the push never carries content (the server can't read it), nor the group's name.</summary>
    public void GroupMessage(Member from, string groupId, IEnumerable<string> recipients)
    {
        foreach (var accountKey in recipients)
        {
            if (accountKey == from.AccountKey) continue;
            if (_world.Store.EitherBlocked(accountKey, from.AccountKey)) continue; // still delivered, never pushed
            var name = _world.Store.DisplayName(from);
            Notify(accountKey, new PushNote("group", $"g:{groupId}", $"New message from {name}", "In a group. Open Iskra to read it.", name,
                Group: groupId));
        }
    }

    /// <summary>A group call starting: rings right away, short-lived, at most once per group and member per window.</summary>
    public void IncomingGroupCall(Member caller, string groupId, string calleeKey)
    {
        if (caller.AccountKey == calleeKey || _world.Store.EitherBlocked(calleeKey, caller.AccountKey)) return;
        var now = _time.GetUtcNow();
        lock (_gate)
        {
            var pair = $"{calleeKey}|g:{groupId}";
            if (_lastRing.TryGetValue(pair, out var last) && now - last < _window) return;
            _lastRing[pair] = now;
        }
        var name = _world.Store.DisplayName(caller);
        Notify(calleeKey, new PushNote("call", $"gcall:{groupId}", $"{name} started a group call", "Tap to join.", name,
            Coalesce: false, TtlSeconds: 30, Group: groupId));
    }
}
