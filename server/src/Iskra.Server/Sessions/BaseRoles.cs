using Iskra.Server.Storage;

namespace Iskra.Server.Sessions;

/// <summary>Things the base roles (guest … owner) allow by themselves, on top of channel access and custom-role permissions.</summary>
public enum BaseAbility
{
    Invite, Events,
    Pin, MentionEveryone, UploadSounds,
    GiveBaseRoles, Bots, Organize, Rules, Stickers, Gifs, StageModerators, ForumTags, ProfilePages, ResolveDisputes,
    RunServer, TransferOwnership,
}

/// <summary>
/// The one table of what each base role can do. The server's checks ask <see cref="Allows"/> and <see cref="PermsOf"/>,
/// and `role.list` shows the same thing to apps (`baseRoles`), so what the role list says is what the server enforces.
/// Defaults: the abilities below by their lowest role, and every custom-role permission for admins. A server can change
/// them per role (Server settings → Roles) within <see cref="Adjustable"/>: the owner's role never changes, owner-only
/// abilities stay the owner's, and guests and members only get everyday powers.
/// </summary>
public static class BaseRoles
{
    /// <summary>Each ability, its wire name and the lowest base role that has it by default.</summary>
    public static readonly IReadOnlyList<(BaseAbility Ability, string Name, string MinRole)> Abilities =
    [
        (BaseAbility.Invite, "invite", Roles.Member),                 // invite friends as guests or members
        (BaseAbility.Events, "events", Roles.Member),                 // schedule events
        (BaseAbility.Pin, "pin", Roles.Trusted),                      // pin messages where they can post
        (BaseAbility.MentionEveryone, "mentionEveryone", Roles.Trusted),
        (BaseAbility.UploadSounds, "uploadSounds", Roles.Trusted),    // add soundboard sounds
        (BaseAbility.GiveBaseRoles, "giveBaseRoles", Roles.Admin),    // set base roles below their own, invite into them
        (BaseAbility.Bots, "bots", Roles.Admin),                      // add bots, voice bots, built-in bots
        (BaseAbility.Organize, "organize", Roles.Admin),              // categories
        (BaseAbility.Rules, "rules", Roles.Admin),
        (BaseAbility.Stickers, "stickers", Roles.Admin),
        (BaseAbility.Gifs, "gifs", Roles.Admin),
        (BaseAbility.StageModerators, "stageModerators", Roles.Admin),
        (BaseAbility.ForumTags, "forumTags", Roles.Admin),
        (BaseAbility.ProfilePages, "profilePages", Roles.Admin),
        (BaseAbility.ResolveDisputes, "resolveDisputes", Roles.Admin),
        (BaseAbility.RunServer, "runServer", Roles.Owner),            // limits, updates, backups, moves, imports, security, internet
        (BaseAbility.TransferOwnership, "transferOwnership", Roles.Owner),
    ];

    /// <summary>Only ever the owner's.</summary>
    public static readonly BaseAbility[] OwnerOnly = [BaseAbility.RunServer, BaseAbility.TransferOwnership];

    /// <summary>What guests and members can be given: everyday things, nothing that acts on other people.</summary>
    public static readonly BaseAbility[] Everyday =
        [BaseAbility.Invite, BaseAbility.Events, BaseAbility.Pin, BaseAbility.MentionEveryone, BaseAbility.UploadSounds];
    public const Perm EverydayPerms = Perm.MentionEveryone;

    public static readonly Perm AllPerms = Enum.GetValues<Perm>().Aggregate(Perm.None, (all, p) => all | p);

    private static readonly Dictionary<BaseAbility, string> MinRoles = Abilities.ToDictionary(a => a.Ability, a => a.MinRole);
    private static readonly Dictionary<string, BaseAbility> ByName = Abilities.ToDictionary(a => a.Name, a => a.Ability);

    public static string MinRole(BaseAbility ability) => MinRoles[ability];

    public static long Bit(BaseAbility ability) => 1L << (int)ability;
    private static long Mask(IEnumerable<BaseAbility> abilities) => abilities.Aggregate(0L, (all, a) => all | Bit(a));

    public static bool TryParse(string name, out BaseAbility ability) => ByName.TryGetValue(name, out ability);

    /// <summary>Wire names of the abilities in a mask, in table order.</summary>
    public static string[] Names(long mask) => Abilities.Where(a => (mask & Bit(a.Ability)) != 0).Select(a => a.Name).ToArray();

    public static long DefaultAbilities(string role) => Mask(Abilities.Where(a => Roles.Rank(role) >= Roles.Rank(a.MinRole)).Select(a => a.Ability));
    public static Perm DefaultPerms(string role) => Roles.Rank(role) >= Roles.Rank(Roles.Admin) ? AllPerms : Perm.None;

    /// <summary>What a server may change for a role: nothing for the owner, everyday powers for guests and members, the rest for trusted and admin.</summary>
    public static (long Abilities, Perm Perms) Adjustable(string role) => role switch
    {
        Roles.Owner => (0, Perm.None),
        Roles.Guest or Roles.Member => (Mask(Everyday), EverydayPerms),
        _ => (Mask(Abilities.Select(a => a.Ability).Except(OwnerOnly)), AllPerms),
    };

    /// <summary>A role's powers with a server's changes, kept within what may be changed (unknown names are ignored).</summary>
    public static BasePowers Effective(string role, BaseRoleChange? change)
    {
        var abilities = DefaultAbilities(role);
        var perms = DefaultPerms(role);
        if (change is null) return new BasePowers(abilities, perms);
        var (adjustable, adjustablePerms) = Adjustable(role);
        static long Parse(string[] names) => names.Aggregate(0L, (all, n) => TryParse(n, out var a) ? all | Bit(a) : all);
        abilities = (abilities | (Parse(change.GrantAbilities) & adjustable)) & ~(Parse(change.RevokeAbilities) & adjustable);
        perms = (perms | (change.GrantPerms & adjustablePerms)) & ~(change.RevokePerms & adjustablePerms);
        return new BasePowers(abilities, perms);
    }

    /// <summary>The changes that turn a role's defaults into these powers (null when they are the defaults).</summary>
    public static BaseRoleChange? ChangeFor(string role, long abilities, Perm perms)
    {
        var defaults = DefaultAbilities(role);
        var defaultPerms = DefaultPerms(role);
        var change = new BaseRoleChange(Names(abilities & ~defaults), Names(defaults & ~abilities), perms & ~defaultPerms, defaultPerms & ~perms);
        return change.GrantAbilities.Length + change.RevokeAbilities.Length == 0 && change.GrantPerms == Perm.None && change.RevokePerms == Perm.None
            ? null : change;
    }

    /// <summary>The member's base role abilities on this server.</summary>
    public static long AbilitiesOf(Member member) =>
        member.Role == Roles.Owner ? DefaultAbilities(Roles.Owner) : member.Base?.Abilities ?? DefaultAbilities(member.Role);

    /// <summary>The custom-role permissions the member's base role gives (the owner: all, always).</summary>
    public static Perm PermsOf(Member member) =>
        member.Role == Roles.Owner ? AllPerms : member.Base?.Perms ?? DefaultPerms(member.Role);

    /// <summary>The member's base role allows the ability (custom roles never grant these).</summary>
    public static bool Allows(Member member, BaseAbility ability) => (AbilitiesOf(member) & Bit(ability)) != 0;

    /// <summary>The ability names a base role has by default, its own and those of the roles below it.</summary>
    public static string[] AbilitiesOf(string role) => Names(DefaultAbilities(role));

    /// <summary>Base roles whose colour someone may change: the owner any, other role managers those below admin.</summary>
    public static bool CanStyle(Member actor, string role) =>
        Permissions.Has(actor, Perm.ManageRoles)
        && (actor.Role == Roles.Owner || Roles.Rank(role) < Roles.Rank(Roles.Admin));

    /// <summary>Base roles whose powers someone may change: never the owner's; otherwise role managers, for roles below their own.</summary>
    public static bool CanAdjust(Member actor, string role) =>
        role != Roles.Owner && Roles.IsValid(role) && Permissions.Has(actor, Perm.ManageRoles) && Roles.Rank(role) < Roles.Rank(actor.Role);
}
