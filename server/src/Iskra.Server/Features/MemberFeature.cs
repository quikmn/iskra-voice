using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public static class MemberFeature
{
    public const int MaxReasonLength = 200;

    public static void Register(Router router)
    {
        router.Add("member.setRole", SetRole);
        router.Add("member.kick", Kick);
        router.Add("member.ban", BanMember);
        router.Add("member.unban", Unban);
        router.Add("member.bans", ListBans);
    }

    /// <summary>Loads the target and checks the actor is an admin who outranks them.</summary>
    private static Member Target(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("You can't do that to yourself.");
        var target = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (!Permissions.Outranks(me, target)) throw RequestException.Forbidden("You can only manage members ranked below you.");
        return target;
    }

    private static object SetRole(Session s, Member me, Body body)
    {
        var target = Target(s, me, body);
        var role = body.String("role", 16);
        if (!Roles.IsValid(role)) throw RequestException.BadRequest($"'role' must be one of: {string.Join(", ", Roles.All)}.");
        if (!Permissions.CanGrant(me, role)) throw RequestException.Forbidden("You can only give roles below your own.");
        if (s.World.Store.IsBot(target.AccountKey) && Roles.Rank(role) > Roles.Rank(BotFeature.MaxRole))
            throw RequestException.BadRequest("Bots can be guest, member or trusted.");

        s.World.Store.SetMemberRole(target.AccountKey, role);
        var member = s.Hub.PublicMember(target with { Role = role });
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        s.Hub.RefreshChannels(target.AccountKey);
        s.Voice.EnforceAccess();
        return new { member };
    }

    private static void Remove(Session s, Member target, string reason, int closeCode)
    {
        s.World.Store.RemoveMember(target.AccountKey);
        s.Hub.Disconnect(target.AccountKey, closeCode, reason);
        s.Hub.Broadcast(Frames.Event("member.removed", new { accountKey = target.AccountKey }));
        s.Voice.EnforceAccess();
    }

    private static object? Kick(Session s, Member me, Body body)
    {
        var target = Target(s, me, body);
        Remove(s, target, "You were removed from this server.", CloseCodes.Forbidden);
        return null;
    }

    private static object? BanMember(Session s, Member me, Body body)
    {
        var target = Target(s, me, body);
        var reason = body.OptionalString("reason", MaxReasonLength) ?? "";
        s.World.Store.AddBan(target.AccountKey, reason, me.AccountKey, s.Now);
        Remove(s, target, "You were banned from this server.", CloseCodes.Forbidden);
        return null;
    }

    private static object? Unban(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        if (!s.World.Store.RemoveBan(body.String("accountKey", 64))) throw RequestException.NotFound("Ban");
        return null;
    }

    private static object ListBans(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        return new
        {
            bans = s.World.Store.AllBans().Select(b => new { accountKey = b.AccountKey, reason = b.Reason, bannedBy = b.BannedBy, bannedAt = b.BannedAt }),
        };
    }
}
