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
/// The one table of what each base role can do. The server's checks ask <see cref="Allows"/>, and `role.list` shows the same
/// table to apps (`baseRoles`), so what the role list says is what the server enforces. Base roles' powers are fixed;
/// admins and the owner also have every custom-role permission (<see cref="Permissions.Has"/>).
/// </summary>
public static class BaseRoles
{
    /// <summary>Each ability, its wire name and the lowest base role that has it.</summary>
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

    private static readonly Dictionary<BaseAbility, string> MinRoles = Abilities.ToDictionary(a => a.Ability, a => a.MinRole);

    public static string MinRole(BaseAbility ability) => MinRoles[ability];

    /// <summary>The member's base role is high enough for the ability (custom roles never grant these).</summary>
    public static bool Allows(Member member, BaseAbility ability) => Roles.Rank(member.Role) >= Roles.Rank(MinRoles[ability]);

    /// <summary>The ability names a base role has, its own and those of the roles below it.</summary>
    public static string[] AbilitiesOf(string role) =>
        Abilities.Where(a => Roles.Rank(role) >= Roles.Rank(a.MinRole)).Select(a => a.Name).ToArray();

    /// <summary>Base roles whose colour someone may change: the owner any, other role managers those below admin.</summary>
    public static bool CanStyle(Member actor, string role) =>
        Permissions.Has(actor, Perm.ManageRoles)
        && (actor.Role == Roles.Owner || Roles.Rank(role) < Roles.Rank(Roles.Admin));
}
