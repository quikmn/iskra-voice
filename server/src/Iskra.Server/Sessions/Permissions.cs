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
/// Every permission decision lives here, and callers pass the member's role as it is *now*
/// (never a copy cached at login).
/// </summary>
public static class Permissions
{
    public static bool CanRead(Member member, Channel channel) => Roles.Rank(member.Role) >= Roles.Rank(channel.ReadRole);

    public static bool CanWrite(Member member, Channel channel) =>
        CanRead(member, channel) && Roles.Rank(member.Role) >= Roles.Rank(channel.WriteRole);

    public static bool IsAdmin(Member member) => Roles.Rank(member.Role) >= Roles.Rank(Roles.Admin);

    /// <summary>Moderation (kick, ban, role changes) only works on people ranked strictly below you.</summary>
    public static bool Outranks(Member actor, Member target) => Roles.Rank(actor.Role) > Roles.Rank(target.Role);

    /// <summary>You can hand out roles strictly below your own (admins up to trusted, the owner up to admin).</summary>
    public static bool CanGrant(Member actor, string role) =>
        IsAdmin(actor) && Roles.Rank(role) < Roles.Rank(actor.Role);

    public static bool CanDeleteMessage(Member actor, Message message, Member? author) =>
        message.AuthorKey == actor.AccountKey || (IsAdmin(actor) && (author is null || Outranks(actor, author)));
}
