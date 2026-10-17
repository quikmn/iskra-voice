using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The server's public page: what a browser sees at the server's own address (<see cref="LandingPage"/>). Off by default:
/// then the page only says this is an Iskra server. The owner turns it on and picks what it shows (Server settings →
/// Overview → Public page). See PROTOCOL.md, "Public page".
/// </summary>
public static class LandingFeature
{
    public const int MaxDescriptionLength = 500;

    public static void Register(Router router)
    {
        router.Add("landing.get", (s, me, _) =>
        {
            RequireOwner(me);
            return new { settings = View(s.World.Store, s.Now) };
        });
        router.Add("landing.update", Update);
    }

    private static void RequireOwner(Member me)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can change the public page.", "owner_landing");
    }

    /// <summary>The invite the page offers, while it still works and only lets people in as members (or guests).</summary>
    public static Invite? UsableInvite(Store store, string? code, long now)
    {
        if (code is null) return null;
        var invite = store.GetInvite(code);
        if (invite is null || invite.Revoked) return null;
        if (invite.ExpiresAt is { } exp && exp <= now) return null;
        if (invite.MaxUses is { } max && invite.Uses >= max) return null;
        return Roles.Rank(invite.Role) <= Roles.Rank(Roles.Member) ? invite : null;
    }

    public static object View(Store store, long now)
    {
        var l = store.Landing();
        var invite = UsableInvite(store, l.InviteCode, now);
        return new
        {
            enabled = l.Enabled, description = l.Description, showRules = l.ShowRules, showCounts = l.ShowCounts, indexable = l.Indexable,
            invite = invite is null ? null : InviteFeature.PublicInvite(invite),
            // The chosen invite stopped working (expired, used up or revoked): the page has no Join button until another is picked.
            inviteGone = l.InviteCode is not null && invite is null,
        };
    }

    private static object Update(Session s, Member me, Body body)
    {
        RequireOwner(me);
        var store = s.World.Store;
        var before = store.Landing();
        var description = before.Description;
        if (body.Has("description"))
        {
            var raw = body.OptionalString("description", MaxDescriptionLength * 2) ?? "";
            description = raw.Trim().Length == 0 ? "" : Text.Normalize(raw, MaxDescriptionLength, allowNewlines: true)
                ?? throw RequestException.BadRequest($"The description can be up to {MaxDescriptionLength} characters, without control characters.",
                    "landing_description", new { max = MaxDescriptionLength });
        }
        var inviteCode = before.InviteCode;
        if (body.Has("invite") || body.IsNull("invite"))
        {
            var code = body.OptionalString("invite", 64) ?? "";
            if (code.Length == 0) inviteCode = null;
            else
            {
                var invite = store.GetInvite(code);
                if (invite is not null && Roles.Rank(invite.Role) > Roles.Rank(Roles.Member))
                    throw RequestException.BadRequest("Only invites for members can go on the public page.", "landing_invite_role");
                if (UsableInvite(store, code, s.Now) is null)
                    throw RequestException.BadRequest("That invite doesn't work anymore. Pick another one.", "landing_invite");
                inviteCode = code;
            }
        }
        var after = new LandingSettings(
            body.OptionalBool("enabled") ?? before.Enabled,
            description,
            body.OptionalBool("showRules") ?? before.ShowRules,
            body.OptionalBool("showCounts") ?? before.ShowCounts,
            body.OptionalBool("indexable") ?? before.Indexable,
            inviteCode);
        if (after != before)
        {
            store.SaveLanding(after);
            Audit.Record(s, "landing.update", details: new { enabled = after.Enabled });
            // What the world can see changed: never the description itself, only which parts are shown.
            SecurityLog.Record(s, "landing.settings", details: new
            {
                enabled = after.Enabled, indexable = after.Indexable, showRules = after.ShowRules, showCounts = after.ShowCounts,
                invite = after.InviteCode is not null, descriptionChanged = after.Description != before.Description,
            });
        }
        var view = View(store, s.Now);
        s.Hub.SendToAccount(me.AccountKey, Frames.Event("landing.settings", new { settings = view }));
        return new { settings = view };
    }
}
