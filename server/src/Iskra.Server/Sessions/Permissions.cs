using Iskra.Server.Storage;

namespace Iskra.Server.Sessions;

public static class Roles
{
    public const string Guest = "guest";
    public const string Member = "member";
    public const string Trusted = "trusted";
    public const string Admin = "admin";
    public const string Owner = "owner";

    public static readonly string[] All = [Guest, Member, Trusted, Admin, Owner];

    public static int Rank(string role) => Array.IndexOf(All, role);

    public static bool IsValid(string? role) => role is not null && Rank(role) >= 0;
}

/// <summary>
/// Every permission decision lives here, and callers pass the member as it is *now* (never a copy cached at login).
/// Two layers: the level (guest &lt; member &lt; trusted &lt; admin &lt; owner) and, on top, custom roles that grant
/// permissions (<see cref="Perm"/>) and per-channel overrides. The owner has every permission; admins too unless the server changed that.
/// </summary>
public static class Permissions
{
    public static bool IsAdmin(Member member) => Roles.Rank(member.Role) >= Roles.Rank(Roles.Admin);

    /// <summary>Every server-wide permission the member has: from their base role (admins: all by default; the owner: all, always) and custom roles.</summary>
    public static Perm Effective(Member member) => BaseRoles.PermsOf(member) | member.Perms;

    /// <summary>A server-wide permission, from the member's base role or a custom role.</summary>
    public static bool Has(Member member, Perm perm) => (Effective(member) & perm) == perm;

    /// <summary>
    /// The hierarchy: owner, then admins, then anyone with custom roles (by their highest role), then trusted, member, guest.
    /// </summary>
    private static (int Tier, int Value) Height(Member m) =>
        m.Role == Roles.Owner ? (3, 0)
        : IsAdmin(m) ? (2, 0)
        : m.TopPosition > 0 ? (1, m.TopPosition)
        : (0, Roles.Rank(m.Role));

    /// <summary>Moderation (kick, ban, timeout, roles) only works on people ranked strictly below you.</summary>
    public static bool Outranks(Member actor, Member target) => Height(actor).CompareTo(Height(target)) > 0;

    /// <summary>Custom roles you can hand out, edit or reorder: those below your highest role (admins: all).</summary>
    public static bool IsAbove(Member actor, int rolePosition) => IsAdmin(actor) || actor.TopPosition > rolePosition;

    /// <summary>You can hand out levels strictly below your own (admins up to trusted, the owner up to admin).</summary>
    public static bool CanGrant(Member actor, string role) =>
        BaseRoles.Allows(actor, BaseAbility.GiveBaseRoles) && Roles.Rank(role) < Roles.Rank(actor.Role);

    /// <summary>
    /// What the member may do in a channel: the read/write levels give the base (read: view and connect; write: send and speak),
    /// then the overrides of the member's roles apply: denies first, then allows (an allow from any role wins).
    /// Without view nothing else counts; speaking needs connect. (Admins follow the levels too: an owner-only channel stays hidden from them.)
    /// </summary>
    public static ChannelPerm Access(Member member, Channel channel)
    {
        var rank = Roles.Rank(member.Role);
        var bits = ChannelPerm.None;
        if (rank >= Roles.Rank(channel.ReadRole)) bits |= ChannelPerm.View | ChannelPerm.Connect;
        if (rank >= Roles.Rank(channel.WriteRole)) bits |= ChannelPerm.Send | ChannelPerm.Speak;
        if (channel.Overrides.Length > 0 && member.RoleIds.Length > 0)
        {
            ChannelPerm allow = ChannelPerm.None, deny = ChannelPerm.None;
            foreach (var o in channel.Overrides)
            {
                if (Array.IndexOf(member.RoleIds, o.RoleId) < 0) continue;
                allow |= o.Allow;
                deny |= o.Deny;
            }
            bits = (bits & ~deny) | allow;
        }
        if (!bits.HasFlag(ChannelPerm.View)) return ChannelPerm.None;
        if (!bits.HasFlag(ChannelPerm.Connect)) bits &= ~ChannelPerm.Speak;
        return bits;
    }

    public static bool CanRead(Member member, Channel channel) => Access(member, channel).HasFlag(ChannelPerm.View);

    /// <summary>Text: send messages. Voice: connect and speak.</summary>
    public static bool CanWrite(Member member, Channel channel) =>
        Access(member, channel).HasFlag(channel.Kind is "voice" or "stage" ? ChannelPerm.View | ChannelPerm.Connect | ChannelPerm.Speak : ChannelPerm.View | ChannelPerm.Send);

    /// <summary>Posting in the channel's chat (text channels, and the text chat of voice and stage channels).</summary>
    public static bool CanSend(Member member, Channel channel) => Access(member, channel).HasFlag(ChannelPerm.View | ChannelPerm.Send);

    /// <summary>Joining a voice channel (listening).</summary>
    public static bool CanConnect(Member member, Channel channel) => Access(member, channel).HasFlag(ChannelPerm.View | ChannelPerm.Connect);

    public static bool CanDeleteMessage(Member actor, Message message, Member? author) =>
        message.AuthorKey == actor.AccountKey || (Has(actor, Perm.ManageMessages) && (author is null || Outranks(actor, author)));

    /// <summary>Pinning is a shared, channel-wide action: writers who are trusted+ or can manage messages.</summary>
    public static bool CanPin(Member member, Channel channel) =>
        CanSend(member, channel) && (BaseRoles.Allows(member, BaseAbility.Pin) || Has(member, Perm.ManageMessages));

    /// <summary>Renaming or deleting a thread: whoever started it, or someone who can manage messages and outranks them.</summary>
    public static bool CanManageThread(Member actor, string creatorKey, Member? creator) =>
        creatorKey == actor.AccountKey || (Has(actor, Perm.ManageMessages) && (creator is null || Outranks(actor, creator)));

    /// <summary>Forum moderation (pin, lock, close any post, retag): the same people who can pin messages there.</summary>
    public static bool CanModerateForum(Member member, Channel forum) => CanPin(member, forum);

    /// <summary>Scheduling events: members and above (not guests).</summary>
    public static bool CanCreateEvent(Member member) => BaseRoles.Allows(member, BaseAbility.Events);

    /// <summary>Editing or cancelling an event: whoever created it, or someone who can manage messages and outranks them.</summary>
    public static bool CanManageEvent(Member actor, string creatorKey, Member? creator) => CanManageThread(actor, creatorKey, creator);
}
