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
            Notify(accountKey, new PushNote("group", $"g:{groupId}", $"New message from {from.Name}", "In a group. Open Iskra to read it.", from.Name,
                Group: groupId));
        }
    }

    /// <summary>A group call starting: rings right away, short-lived, at most once per group and member per window.</summary>
    public void IncomingGroupCall(Member caller, string groupId, string calleeKey)
    {
        if (caller.AccountKey == calleeKey) return;
        var now = _time.GetUtcNow();
        lock (_gate)
        {
            var pair = $"{calleeKey}|g:{groupId}";
            if (_lastRing.TryGetValue(pair, out var last) && now - last < _window) return;
            _lastRing[pair] = now;
        }
        Notify(calleeKey, new PushNote("call", $"gcall:{groupId}", $"{caller.Name} started a group call", "Tap to join.", caller.Name,
            Coalesce: false, TtlSeconds: 30, Group: groupId));
    }
}
