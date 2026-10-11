using System.Collections.Concurrent;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server.Sessions;

/// <summary>
/// The set of connected, authenticated sessions. Broadcasts look up each recipient's *current* role
/// so permission changes apply immediately.
/// </summary>
public sealed class Hub(World world, TimeProvider time)
{
    /// <summary>Rate limits shared by all of an account's sessions.</summary>
    public AccountLimits Limits { get; } = new(time);

    /// <summary>"Playing X" per online account (Features/ActivityFeature.cs).</summary>
    public Features.ActivityRegistry Activities { get; } = new(time);

    private readonly ConcurrentDictionary<Session, byte> _sessions = new();

    public IEnumerable<Session> Sessions => _sessions.Keys;

    public bool IsOnline(string accountKey) => _sessions.Keys.Any(s => s.AccountKey == accountKey);

    /// <summary>Adds the session. Returns true if this is the account's first connection (it just came online).</summary>
    public bool Add(Session session)
    {
        var wasOnline = IsOnline(session.AccountKey!);
        _sessions.TryAdd(session, 0);
        return !wasOnline;
    }

    /// <summary>Removes the session. Returns true if the account has no connections left (it just went offline).</summary>
    public bool Remove(Session session)
    {
        _sessions.TryRemove(session, out _);
        if (session.AccountKey is null || IsOnline(session.AccountKey)) return false;
        Activities.Clear(session.AccountKey); // activity only lasts while you're online
        return true;
    }

    /// <summary>Sends to every connected member.</summary>
    public void Broadcast(string frame)
    {
        foreach (var session in _sessions.Keys) session.Send(frame);
    }

    /// <summary>Sends only to members who can read the channel right now.</summary>
    public void BroadcastToReaders(Channel channel, string frame)
    {
        foreach (var session in _sessions.Keys)
        {
            var member = session.CurrentMember();
            if (member is not null && Permissions.CanRead(member, channel)) session.Send(frame);
        }
    }

    public void SendToAccount(string accountKey, string frame)
    {
        foreach (var session in _sessions.Keys.Where(s => s.AccountKey == accountKey)) session.Send(frame);
    }

    public void Disconnect(string accountKey, int closeCode, string reason)
    {
        foreach (var session in _sessions.Keys.Where(s => s.AccountKey == accountKey)) session.Kick(closeCode, reason);
    }

    public object PublicMember(Member m)
    {
        var online = IsOnline(m.AccountKey);
        return Features.ProfileFeature.Public(world.Store, m, online, online ? Features.ActivityFeature.Public(Activities.Get(m.AccountKey)) : null);
    }

    public static object PublicChannel(Channel c) =>
        new { id = c.Id, name = c.Name, kind = c.Kind, position = c.Position, readRole = c.ReadRole, writeRole = c.WriteRole };

    /// <summary>The channels this member can see, in order.</summary>
    public List<object> VisibleChannels(Member member) =>
        world.Store.AllChannels().Where(c => Permissions.CanRead(member, c)).Select(PublicChannel).ToList();

    /// <summary>After a role change: tell that member which channels they can see now.</summary>
    public void RefreshChannels(string accountKey)
    {
        var member = world.Store.GetMember(accountKey);
        if (member is null) return;
        SendToAccount(accountKey, Frames.Event("channels", new { channels = VisibleChannels(member) }));
    }
}
