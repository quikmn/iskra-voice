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
        new { code = i.Code, id = InviteTrackFeature.PublicId(i.Code), label = i.Label, role = i.Role, createdBy = i.CreatedBy, createdAt = i.CreatedAt, expiresAt = i.ExpiresAt, maxUses = i.MaxUses, uses = i.Uses, approve = i.Approve };

    /// <summary>Any member can invite friends as members. Inviting into a higher role needs the right to grant it.</summary>
    private static object Create(Session s, Member me, Body body)
    {
        var role = body.OptionalString("role", 16) ?? Roles.Member;
        if (!Roles.IsValid(role)) throw RequestException.BadRequest($"'role' must be one of: {string.Join(", ", Roles.All)}.");
        var canInvite = Roles.Rank(role) <= Roles.Rank(Roles.Member)
            ? BaseRoles.Allows(me, BaseAbility.Invite)
            : Permissions.CanGrant(me, role);
        if (!canInvite || s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("You can't create invites for that role.", "invite_role");

        var maxUses = (int?)body.OptionalLong("maxUses", min: 1, max: 1000);
        var lifetimeMs = body.OptionalLong("expiresInMs", min: 60_000, max: (long)MaxLifetime.TotalMilliseconds);
        var now = s.Now; // one reading, so the lifetime is exact
        long? expiresAt;
        if (body.OptionalBool("neverExpires") == true)
        {
            // A standing link (say, for app reviewers): admins only, and it can still be revoked any time.
            if (lifetimeMs is not null) throw RequestException.BadRequest("Use either 'expiresInMs' or 'neverExpires'.");
            if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can create invites that never expire.", "invite_never");
            expiresAt = null;
        }
        else expiresAt = now + (lifetimeMs ?? (long)DefaultLifetime.TotalMilliseconds);

        // Approval: whoever joins through it waits until a moderator lets them in (JoinFeature).
        var approve = body.OptionalBool("approve") ?? false;
        var label = InviteTrackFeature.Label(body);
        var invite = s.World.Store.CreateInvite(NewCode(), me.AccountKey, role, now, expiresAt, maxUses, approve, label);
        Audit.Record(s, "invite.create", details: new { role, maxUses, expiresAt = invite.ExpiresAt, approve, id = InviteTrackFeature.PublicId(invite.Code), label });
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
        Audit.Record(s, "invite.revoke", invite.CreatedBy, details: new { role = invite.Role, uses = invite.Uses });
        return null;
    }
}
