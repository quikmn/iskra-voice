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

    /// <summary>Who sent what when, for channel slowmode.</summary>
    public Features.SlowmodeTracker Slowmode { get; } = new();
    /// <summary>"Playing X" per online account (Features/ActivityFeature.cs).</summary>
    public Features.ActivityRegistry Activities { get; } = new(time);
    /// <summary>What sessions are told when the server stops: a restart (1012) or a stop (1001), see RestartSignal.</summary>
    public RestartSignal Restart { get; } = new(world.Path, time);

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

    /// <summary>Sends only to members who can read the channel right now (but not to <paramref name="except"/>'s sessions).</summary>
    public void BroadcastToReaders(Channel channel, string frame, string? except = null)
    {
        var members = OnlineMembers();
        foreach (var session in _sessions.Keys)
        {
            if (session.AccountKey is null || session.AccountKey == except) continue;
            if (members.TryGetValue(session.AccountKey, out var member) && Permissions.CanRead(member, channel)) session.Send(frame);
        }
    }

    /// <summary>
    /// The member record of everyone connected, as it is right now. One query for a whole broadcast: a lookup per
    /// session made busy servers queue on the database lock.
    /// </summary>
    public Dictionary<string, Member> OnlineMembers() =>
        world.Store.GetMembers(_sessions.Keys.Select(s => s.AccountKey).OfType<string>().Distinct().ToList());

    public void SendToAccount(string accountKey, string frame)
    {
        foreach (var session in _sessions.Keys.Where(s => s.AccountKey == accountKey)) session.Send(frame);
    }

    public void Disconnect(string accountKey, int closeCode, string reason, string? key = null)
    {
        foreach (var session in _sessions.Keys.Where(s => s.AccountKey == accountKey)) session.Kick(closeCode, reason, key);
    }

    /// <summary>Every member as <see cref="PublicMember"/> shows them, in join order: a few queries in all, not several per member.</summary>
    public List<object> PublicMembers()
    {
        var store = world.Store;
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        var members = store.AllMembers();
        var views = store.MemberViews();
        var pages = Features.ProfileFeature.PagesEnabled(store);
        var sessions = _sessions.Keys.Where(s => s.AccountKey is not null).GroupBy(s => s.AccountKey!).ToDictionary(g => g.Key, g => g.ToList());
        return members.Select(m =>
        {
            var presence = Features.PresenceFeature.Of(views.Presence.GetValueOrDefault(m.AccountKey), sessions.GetValueOrDefault(m.AccountKey), now);
            return Features.ProfileFeature.Public(m, views.Profiles.GetValueOrDefault(m.AccountKey) ?? store.GetPublicProfile(m.AccountKey), pages,
                views.Nicknames.GetValueOrDefault(m.AccountKey), store.IsBot(m.AccountKey),
                views.Timeouts.TryGetValue(m.AccountKey, out var until) ? until : null, presence,
                presence.Online ? Features.ActivityFeature.Public(Activities.Get(m.AccountKey)) : null);
        }).ToList();
    }

    public object PublicMember(Member m)
    {
        var presence = Features.PresenceFeature.Of(world.Store, this, m.AccountKey, time.GetUtcNow().ToUnixTimeMilliseconds());
        // "Playing X" only while they show as online (never for invisible members).
        return Features.ProfileFeature.Public(world.Store, m, presence, presence.Online ? Features.ActivityFeature.Public(Activities.Get(m.AccountKey)) : null);
    }

    public static object PublicChannel(Channel c, int slowmode = 0, int userLimit = 0, object? e2ee = null, bool hifi = false) =>
        new
        {
            id = c.Id, name = c.Name, kind = c.Kind, position = c.Position, readRole = c.ReadRole, writeRole = c.WriteRole, slowmode, categoryId = c.CategoryId, userLimit,
            e2ee, hifi,
            overrides = c.Overrides.Select(o => new
            {
                roleId = o.RoleId, allow = Features.RoleFeature.ChannelPermNames(o.Allow), deny = Features.RoleFeature.ChannelPermNames(o.Deny),
            }),
        };

    /// <summary>The channels this member can see, in order.</summary>
    public List<object> VisibleChannels(Member member)
    {
        var slowmodes = world.Store.AllSlowmodes();
        var limits = world.Store.AllUserLimits();
        var e2ee = world.Store.AllE2ee();
        var hifi = world.Store.AllHifi();
        return world.Store.AllChannels().Where(c => Permissions.CanRead(member, c))
            .Select(c => PublicChannel(c, slowmodes.GetValueOrDefault(c.Id), limits.GetValueOrDefault(c.Id),
                Features.E2eeChannelFeature.Info(e2ee.GetValueOrDefault(c.Id)), hifi.Contains(c.Id))).ToList();
    }

    /// <summary>The categories this member can see (see <see cref="Features.OrganizeFeature.VisibleCategories"/>).</summary>
    public List<object> VisibleCategories(Member member) => Features.OrganizeFeature.VisibleCategories(world.Store, member);

    /// <summary>The "channels" event for this member: their channels and categories.</summary>
    public string ChannelsEvent(Member member) =>
        Frames.Event("channels", new { channels = VisibleChannels(member), categories = VisibleCategories(member) });

    /// <summary>After a role change: tell that member which channels they can see now.</summary>
    public void RefreshChannels(string accountKey)
    {
        var member = world.Store.GetMember(accountKey);
        if (member is null) return;
        SendToAccount(accountKey, ChannelsEvent(member));
    }
}
