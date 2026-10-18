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
    public const int MaxAnswers = 25;
    public const int MaxAnswerLabelLength = 60;
    public const int MaxAnswerRoles = 5;
    public const int MaxAnswerChannels = 5;

    public static object PublicGroup(RoleGroup g) => new
    {
        id = g.Id, title = g.Title, question = g.Question, multi = g.Multi, required = g.Required, roles = g.RoleIds,
        answers = g.Answers.Select(a => new { id = a.Id, label = a.Label, emoji = a.Emoji, roles = a.RoleIds, channels = a.ChannelIds }),
    };

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
        var ids = Ids(body.Element("roles"), "roles", MaxGroupRoles, "role_group_roles_max");
        if (ids.Length == 0) throw RequestException.BadRequest("A group needs at least one role.", "role_group_empty");
        CheckPickable(store, ids);
        return ids;
    }

    private static long[] Ids(JsonElement element, string name, int max, string? key = null)
    {
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > max)
            throw RequestException.BadRequest($"'{name}' must be a list of up to {max} ids.", key, key is null ? null : new { max });
        return element.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id : throw RequestException.BadRequest($"'{name}' must be a list of ids."))
            .Distinct().ToArray();
    }

    /// <summary>Only roles members may pick themselves (no permissions, no rank): an answer can't give anyone more than that.</summary>
    internal static void CheckPickable(Store store, IEnumerable<long> ids, string key = "role_group_not_self_assign")
    {
        var all = store.AllRoles().ToDictionary(r => r.Id);
        foreach (var id in ids)
        {
            if (!all.TryGetValue(id, out var role)) throw RequestException.BadRequest("Unknown role.");
            if (!Pickable(role)) throw RequestException.BadRequest($"'{role.Name}' isn't a role members can pick themselves.", key, new { name = role.Name });
        }
    }

    /// <summary>The one safety rule for roles given without a manager choosing the person: picked, answered, or given on join.</summary>
    public static bool Pickable(CustomRole role) => role.SelfAssign && role.Perms == Perm.None;

    /// <summary>
    /// `answers`: 1–25 of `{ id?, label?, emoji?, roles?, channels? }`. `id` keeps an answer of this question (and who
    /// picked it); without one it's new. A label is 0–60 characters (none: the answer shows its roles' names, so it needs one).
    /// </summary>
    private static JoinAnswer[] GroupAnswers(Session s, Member me, Body body, RoleGroup? group)
    {
        var element = body.Element("answers");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxAnswers)
            throw RequestException.BadRequest($"'answers' must be a list of up to {MaxAnswers} answers.", "role_group_answers_max", new { max = MaxAnswers });
        if (element.GetArrayLength() == 0) throw RequestException.BadRequest("A question needs at least one answer.", "role_group_no_answers");
        var store = s.World.Store;
        var own = group?.Answers.Select(a => a.Id).ToHashSet() ?? [];
        var channels = store.AllChannels().ToDictionary(c => c.Id);
        var answers = new List<JoinAnswer>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each answer must be an object.");
            var a = new Body(item);
            var id = a.OptionalLong("id") ?? 0;
            if (id != 0 && (!own.Contains(id) || answers.Any(x => x.Id == id))) throw RequestException.BadRequest("Unknown answer.", "onboarding_unknown_answer");
            var roles = a.Has("roles") ? Ids(a.Element("roles"), "roles", MaxAnswerRoles, "role_answer_roles_max") : [];
            CheckPickable(store, roles);
            var channelIds = a.Has("channels") ? Ids(a.Element("channels"), "channels", MaxAnswerChannels, "role_answer_channels_max") : [];
            foreach (var c in channelIds)
                if (!channels.TryGetValue(c, out var channel) || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
            var raw = a.OptionalString("label", MaxAnswerLabelLength * 2) ?? "";
            var label = raw.Trim().Length == 0 ? "" : Text.Normalize(raw, MaxAnswerLabelLength, allowNewlines: false)
                ?? throw RequestException.BadRequest($"Answers can be up to {MaxAnswerLabelLength} characters.", "role_answer_label", new { max = MaxAnswerLabelLength });
            if (label.Length == 0 && roles.Length == 0) throw RequestException.BadRequest("Give the answer a name or a role.", "role_answer_empty");
            answers.Add(new JoinAnswer(id, label, Icon(a, null, "emoji"), roles, channelIds));
        }
        return [.. answers];
    }

    /// <summary>The older `roles` form: one answer per role, keeping the answers that were already just that role.</summary>
    private static JoinAnswer[] AnswersFromRoles(long[] roleIds, RoleGroup? group) =>
        roleIds.Select(id => group?.Answers.FirstOrDefault(a => a.Label == "" && a.ChannelIds.Length == 0 && a.RoleIds.SequenceEqual([id]))
            ?? new JoinAnswer(0, "", null, [id], [])).ToArray();

    private static JoinAnswer[] Answers(Session s, Member me, Body body, RoleGroup? group)
    {
        if (body.Has("answers")) return GroupAnswers(s, me, body, group);
        if (body.Has("roles")) return AnswersFromRoles(GroupRoles(s.World.Store, body), group);
        return group?.Answers ?? throw RequestException.BadRequest("A question needs at least one answer.", "role_group_no_answers");
    }

    private static object CreateGroup(Session s, Member me, Body body)
    {
        RequireManager(me);
        var store = s.World.Store;
        if (store.RoleGroupCount() >= MaxGroups) throw RequestException.BadRequest($"A server can have up to {MaxGroups} groups.", "role_groups_max", new { max = MaxGroups });
        var group = store.CreateRoleGroup(GroupTitle(body, null), GroupQuestion(body, ""), body.OptionalBool("multi") ?? false,
            body.OptionalBool("required") ?? false, Answers(s, me, body, null), s.Now);
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
            Required = body.OptionalBool("required") ?? group.Required,
            Answers = Answers(s, me, body, group),
        };
        store.UpdateRoleGroup(updated);
        var saved = store.GetRoleGroup(group.Id)!;
        Audit.Record(s, "role.group.update", details: new { id = group.Id, title = saved.Title, roles = RoleNames(store, saved.RoleIds) });
        RolesChanged(s);
        return new { group = PublicGroup(saved) };
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
            if (!Pickable(role))
                throw RequestException.Forbidden("You can only pick roles this server lets members choose.", "role_not_self_assign");
        }

        var wanted = me.RoleIds.ToHashSet();
        wanted.ExceptWith(remove);
        var groups = store.AllRoleGroups();
        foreach (var id in add)
        {
            // Only answers that are just one role count here; answers with several roles are changed with onboarding.answer.
            foreach (var group in groups.Where(g => !g.Multi && g.Answers.Any(a => a.RoleIds.SequenceEqual([id]))))
                wanted.ExceptWith(group.Answers.Where(a => a.RoleIds.Length == 1).Select(a => a.RoleIds[0]));
            wanted.Add(id);
        }
        if (!wanted.SetEquals(me.RoleIds))
        {
            store.SetMemberRoles(me.AccountKey, wanted);
            store.ForgetOnboardingGrants(me.AccountKey, wanted.Except(me.RoleIds).Concat(me.RoleIds.Except(wanted))); // picked by hand now
            AccessChanged(s, [me.AccountKey]); // opt-in channels appear or go
            s.Hub.Outhooks?.MemberUpdated(me.AccountKey, "roles");
        }
        return new { member = s.Hub.PublicMember(store.GetMember(me.AccountKey)!) };
    }
}
