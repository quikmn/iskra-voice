using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Roles members pick themselves ("PC", "Announcements pings") and the pick groups that ask new members about them
/// (Server settings → Onboarding). A self-assignable role never carries a permission and never counts in the hierarchy
/// (Store.WithRoles), so picking one can't give anyone more than the member base role has.
/// </summary>
public static partial class RoleFeature
{
    public const int MaxGroups = 20;
    public const int MaxGroupRoles = 25;
    public const int MaxGroupTitleLength = 60;
    public const int MaxGroupQuestionLength = 200;

    public static object PublicGroup(RoleGroup g) => new { id = g.Id, title = g.Title, question = g.Question, multi = g.Multi, roles = g.RoleIds };

    public static List<object> PublicGroups(Store store) => store.AllRoleGroups().Select(PublicGroup).ToList();

    // ── Pick groups ──────────────────────────────────────────────────────────

    private static string GroupTitle(Body body, string? fallback)
    {
        var raw = body.OptionalString("title", MaxGroupTitleLength * 2);
        if (raw is null && fallback is not null) return fallback;
        return Text.Normalize(raw ?? "", MaxGroupTitleLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"'title' must be 1–{MaxGroupTitleLength} characters.", "role_group_title", new { max = MaxGroupTitleLength });
    }

    /// <summary>"" or absent (when creating) clears.</summary>
    private static string GroupQuestion(Body body, string fallback)
    {
        if (!body.Has("question")) return fallback;
        var raw = body.OptionalString("question", MaxGroupQuestionLength * 2) ?? "";
        if (raw.Trim().Length == 0) return "";
        return Text.Normalize(raw, MaxGroupQuestionLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"'question' can be up to {MaxGroupQuestionLength} characters.", "role_group_question", new { max = MaxGroupQuestionLength });
    }

    /// <summary>`roles`: 1–25 distinct ids of self-assignable roles, in the order shown.</summary>
    private static long[] GroupRoles(Store store, Body body)
    {
        var element = body.Element("roles");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxGroupRoles)
            throw RequestException.BadRequest($"'roles' must be a list of up to {MaxGroupRoles} ids.", "role_group_roles_max", new { max = MaxGroupRoles });
        var ids = element.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id : throw RequestException.BadRequest("'roles' must be a list of ids."))
            .Distinct().ToArray();
        if (ids.Length == 0) throw RequestException.BadRequest("A group needs at least one role.", "role_group_empty");
        var all = store.AllRoles().ToDictionary(r => r.Id);
        foreach (var id in ids)
        {
            if (!all.TryGetValue(id, out var role)) throw RequestException.BadRequest("Unknown role.");
            if (!role.SelfAssign) throw RequestException.BadRequest($"'{role.Name}' isn't a role members can pick themselves.", "role_group_not_self_assign", new { name = role.Name });
        }
        return ids;
    }

    private static object CreateGroup(Session s, Member me, Body body)
    {
        RequireManager(me);
        var store = s.World.Store;
        if (store.RoleGroupCount() >= MaxGroups) throw RequestException.BadRequest($"A server can have up to {MaxGroups} groups.", "role_groups_max", new { max = MaxGroups });
        var group = store.CreateRoleGroup(GroupTitle(body, null), GroupQuestion(body, ""), body.OptionalBool("multi") ?? false, GroupRoles(store, body), s.Now);
        Audit.Record(s, "role.group.create", details: new { id = group.Id, title = group.Title, roles = RoleNames(store, group.RoleIds) });
        RolesChanged(s);
        return new { group = PublicGroup(group) };
    }

    private static object UpdateGroup(Session s, Member me, Body body)
    {
        RequireManager(me);
        var store = s.World.Store;
        var group = store.GetRoleGroup(body.Long("id")) ?? throw RequestException.NotFound("Group");
        var updated = group with
        {
            Title = GroupTitle(body, group.Title),
            Question = GroupQuestion(body, group.Question),
            Multi = body.OptionalBool("multi") ?? group.Multi,
            RoleIds = body.Has("roles") ? GroupRoles(store, body) : group.RoleIds,
        };
        store.UpdateRoleGroup(updated);
        Audit.Record(s, "role.group.update", details: new { id = group.Id, title = updated.Title, roles = RoleNames(store, updated.RoleIds) });
        RolesChanged(s);
        return new { group = PublicGroup(store.GetRoleGroup(group.Id)!) };
    }

    private static object? DeleteGroup(Session s, Member me, Body body)
    {
        RequireManager(me);
        var store = s.World.Store;
        var group = store.GetRoleGroup(body.Long("id")) ?? throw RequestException.NotFound("Group");
        store.DeleteRoleGroup(group.Id);
        Audit.Record(s, "role.group.delete", details: new { id = group.Id, title = group.Title });
        RolesChanged(s);
        return null;
    }

    private static string[] RoleNames(Store store, long[] ids)
    {
        var all = store.AllRoles().ToDictionary(r => r.Id, r => r.Name);
        return ids.Select(id => all.GetValueOrDefault(id) ?? "?").ToArray();
    }

    // ── Picking your own roles ───────────────────────────────────────────────

    private static List<long> OptionalLongArray(Body body, string name) => body.Has(name) ? LongArray(body, name) : [];

    /// <summary>
    /// `roles.self`: gives yourself or drops self-assignable roles (`add`, `remove`). Only roles flagged selfAssign that carry no
    /// permission, checked now, not when the flag was set. Picking a role in a single-choice group drops the group's others.
    /// </summary>
    private static object SetSelf(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        if (store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots don't pick roles.", "bots_no_roles");
        var add = OptionalLongArray(body, "add");
        var remove = OptionalLongArray(body, "remove");
        if (add.Count + remove.Count == 0) throw RequestException.BadRequest("Send 'add' or 'remove'.");
        var all = store.AllRoles().ToDictionary(r => r.Id);
        foreach (var id in add.Concat(remove))
        {
            if (!all.TryGetValue(id, out var role)) throw RequestException.BadRequest("Unknown role.");
            if (!role.SelfAssign || role.Perms != Perm.None)
                throw RequestException.Forbidden("You can only pick roles this server lets members choose.", "role_not_self_assign");
        }

        var wanted = me.RoleIds.ToHashSet();
        wanted.ExceptWith(remove);
        var groups = store.AllRoleGroups();
        foreach (var id in add)
        {
            foreach (var group in groups.Where(g => !g.Multi && g.RoleIds.Contains(id))) wanted.ExceptWith(group.RoleIds);
            wanted.Add(id);
        }
        if (!wanted.SetEquals(me.RoleIds))
        {
            store.SetMemberRoles(me.AccountKey, wanted);
            AccessChanged(s, [me.AccountKey]); // opt-in channels appear or go
        }
        return new { member = s.Hub.PublicMember(store.GetMember(me.AccountKey)!) };
    }
}
