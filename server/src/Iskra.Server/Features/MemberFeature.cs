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

    /// <summary>Loads the target and checks the actor has the permission (no permission given: is an admin) and outranks them.</summary>
    internal static Member Target(Session s, Member me, Body body, Perm? perm = null)
    {
        if (perm is { } p ? !Permissions.Has(me, p) : !Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("You can't do that to yourself.", "not_to_self");
        var target = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (!Permissions.Outranks(me, target)) throw RequestException.Forbidden("You can only manage members ranked below you.", "rank_members");
        return target;
    }

    private static object SetRole(Session s, Member me, Body body)
    {
        var target = Target(s, me, body);
        var role = body.String("role", 16);
        if (!Roles.IsValid(role)) throw RequestException.BadRequest($"'role' must be one of: {string.Join(", ", Roles.All)}.");
        if (!Permissions.CanGrant(me, role)) throw RequestException.Forbidden("You can only give roles below your own.", "rank_roles_below");
        if (s.World.Store.IsBot(target.AccountKey) && Roles.Rank(role) > Roles.Rank(BotFeature.MaxRole))
            throw RequestException.BadRequest("Bots can be guest, member or trusted.", "bot_roles");

        s.World.Store.SetMemberRole(target.AccountKey, role);
        if (role != target.Role) Audit.Record(s, "member.role", target.AccountKey, details: new { from = target.Role, to = role });
        if (role != target.Role) s.Hub.Outhooks?.MemberUpdated(target.AccountKey, "role");
        var member = s.Hub.PublicMember(target with { Role = role });
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        s.Hub.RefreshChannels(target.AccountKey);
        s.Voice.EnforceAccess();
        return new { member };
    }

    private static void Remove(Session s, Member target, string reason, string key, int closeCode)
    {
        var how = key == "kicked_banned" ? "banned" : "kicked";
        s.World.Store.RemoveMember(target.AccountKey);
        s.World.Store.RecordDeparture(target.AccountKey, target.Name, how, s.AccountKey, s.Now); // "People who left" (ModPackFeature)
        s.Hub.Disconnect(target.AccountKey, closeCode, reason, key);
        s.Hub.Broadcast(Frames.Event("member.removed", new { accountKey = target.AccountKey }));
        s.Hub.Outhooks?.MemberLeft(target.AccountKey, target.Name, how);
        s.Voice.EnforceAccess();
    }

    private static object? Kick(Session s, Member me, Body body)
    {
        var target = Target(s, me, body, Perm.KickMembers);
        Audit.Record(s, "member.kick", target.AccountKey);
        Remove(s, target, "You were removed from this server.", "kicked_removed", CloseCodes.Forbidden);
        return null;
    }

    /// <summary>
    /// Bans a member (ranked below you), or someone who already left (so a report about them can still be acted on).
    /// `deleteMessagesMs` (24 hours or 7 days) also deletes what they wrote in that time, everywhere.
    /// </summary>
    private static object? BanMember(Session s, Member me, Body body)
    {
        if (!Permissions.Has(me, Perm.BanMembers)) throw RequestException.Forbidden();
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("You can't do that to yourself.", "not_to_self");
        var store = s.World.Store;
        var target = store.GetMember(key);
        if (target is not null && !Permissions.Outranks(me, target)) throw RequestException.Forbidden("You can only manage members ranked below you.", "rank_members");
        if (target is null && store.GetDeparture(key) is null) throw RequestException.NotFound("Member");
        var reason = body.OptionalString("reason", MaxReasonLength) ?? "";
        var window = ModPackFeature.DeleteWindow(body);

        store.AddBan(key, reason, me.AccountKey, s.Now);
        var deleted = window is { } ms ? ModPackFeature.DeleteRecent(s, key, ms) : 0;
        Audit.Record(s, "member.ban", key, reason, window is null ? new { name = target?.Name ?? store.GetDeparture(key)?.Name } : new { name = target?.Name ?? store.GetDeparture(key)?.Name, deletedMessages = deleted, deleteMessagesMs = window });
        if (target is not null) Remove(s, target, "You were banned from this server.", "kicked_banned", CloseCodes.Forbidden);
        return new { deletedMessages = deleted };
    }

    private static object? Unban(Session s, Member me, Body body)
    {
        if (!Permissions.Has(me, Perm.BanMembers)) throw RequestException.Forbidden();
        var key = body.String("accountKey", 64);
        if (!s.World.Store.RemoveBan(key)) throw RequestException.NotFound("Ban");
        Audit.Record(s, "member.unban", key);
        return null;
    }

    private static object ListBans(Session s, Member me, Body body)
    {
        if (!Permissions.Has(me, Perm.BanMembers)) throw RequestException.Forbidden();
        return new
        {
            bans = s.World.Store.AllBans().Select(b => new { accountKey = b.AccountKey, reason = b.Reason, bannedBy = b.BannedBy, bannedAt = b.BannedAt }),
        };
    }
}
