using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public static class InviteFeature
{
    public static readonly TimeSpan DefaultLifetime = TimeSpan.FromDays(7);
    public static readonly TimeSpan MaxLifetime = TimeSpan.FromDays(30);

    public static void Register(Router router)
    {
        router.Add("invite.create", Create);
        router.Add("invite.list", List);
        router.Add("invite.revoke", Revoke);
    }

    public static string NewCode() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));

    public static object PublicInvite(Invite i) =>
        new { code = i.Code, role = i.Role, createdBy = i.CreatedBy, createdAt = i.CreatedAt, expiresAt = i.ExpiresAt, maxUses = i.MaxUses, uses = i.Uses };

    /// <summary>Any member can invite friends as members. Inviting into a higher role needs the right to grant it.</summary>
    private static object Create(Session s, Member me, Body body)
    {
        var role = body.OptionalString("role", 16) ?? Roles.Member;
        if (!Roles.IsValid(role)) throw RequestException.BadRequest($"'role' must be one of: {string.Join(", ", Roles.All)}.");
        var canInvite = Roles.Rank(role) <= Roles.Rank(Roles.Member)
            ? Roles.Rank(me.Role) >= Roles.Rank(Roles.Member)
            : Permissions.CanGrant(me, role);
        if (!canInvite || s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("You can't create invites for that role.");

        var maxUses = (int?)body.OptionalLong("maxUses", min: 1, max: 1000);
        var lifetimeMs = body.OptionalLong("expiresInMs", min: 60_000, max: (long)MaxLifetime.TotalMilliseconds)
            ?? (long)DefaultLifetime.TotalMilliseconds;

        var invite = s.World.Store.CreateInvite(NewCode(), me.AccountKey, role, s.Now, s.Now + lifetimeMs, maxUses);
        return new { invite = PublicInvite(invite) };
    }

    private static object List(Session s, Member me, Body body)
    {
        var invites = s.World.Store.ActiveInvites(s.Now);
        // Admins see every invite; everyone else sees their own.
        if (!Permissions.IsAdmin(me)) invites = invites.Where(i => i.CreatedBy == me.AccountKey).ToList();
        return new { invites = invites.Select(PublicInvite) };
    }

    private static object? Revoke(Session s, Member me, Body body)
    {
        var invite = s.World.Store.GetInvite(body.String("code", 64)) ?? throw RequestException.NotFound("Invite");
        if (invite.CreatedBy != me.AccountKey && !Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        s.World.Store.RevokeInvite(invite.Code);
        return null;
    }
}
