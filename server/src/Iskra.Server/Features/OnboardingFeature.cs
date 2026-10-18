using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Join questions from the member's side, and roles on join. Answers give only self-assignable roles without permissions
/// (RoleFeature.Pickable, checked again on every answer), so answering can't give anyone more than picking roles by hand.
/// Changing an answer takes back only roles an answer gave (onboarding_grants), never ones given another way.
/// Roles on join follow the same rule, so a newcomer never gets permissions or rank from them. Bots get neither.
/// </summary>
public static class OnboardingFeature
{
    public const int MaxAutoRoles = 10;

    public static void Register(Router router)
    {
        router.Add("onboarding.mine", Mine);
        router.Add("onboarding.answer", Answer);
        router.Add("onboarding.autoroles.set", SetAutoRoles);
        router.Add("onboarding.autoroles.apply", ApplyAutoRoles);
    }

    private static object Mine(Session s, Member me, Body body) =>
        new { answers = s.World.Store.IsBot(me.AccountKey) ? [] : s.World.Store.OnboardingAnswers(me.AccountKey) };

    /// <summary>`onboarding.answer { question, answers }`: replaces your answers to one question and gives or takes their roles.</summary>
    private static object Answer(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        if (store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots don't pick roles.", "bots_no_roles");
        var group = store.GetRoleGroup(body.Long("question")) ?? throw RequestException.NotFound("Question");
        var element = body.Element("answers");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > RoleFeature.MaxAnswers)
            throw RequestException.BadRequest($"'answers' must be a list of up to {RoleFeature.MaxAnswers} ids.");
        var ids = element.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id : throw RequestException.BadRequest("'answers' must be a list of ids."))
            .Distinct().ToList();
        var own = group.Answers.Select(a => a.Id).ToHashSet();
        if (ids.Any(id => !own.Contains(id))) throw RequestException.BadRequest("That isn't an answer to this question.", "onboarding_unknown_answer");
        if (!group.Multi && ids.Count > 1) throw RequestException.BadRequest("Pick one answer.", "onboarding_single");
        if (group.Required && ids.Count == 0) throw RequestException.BadRequest("This question needs an answer.", "onboarding_required");

        store.SetOnboardingAnswers(me.AccountKey, group.Id, ids);
        var member = Reconcile(s, me.AccountKey);
        return new { member = s.Hub.PublicMember(member), answers = store.OnboardingAnswers(me.AccountKey) };
    }

    /// <summary>
    /// Gives the roles the member's answers call for that they don't hold, and takes back roles an earlier answer gave
    /// that no answer calls for any more. Roles they held already, or got by hand, are left alone.
    /// </summary>
    private static Member Reconcile(Session s, string accountKey)
    {
        var store = s.World.Store;
        var me = store.GetMember(accountKey)!;
        var roles = store.AllRoles().ToDictionary(r => r.Id);
        var chosen = store.OnboardingAnswers(accountKey).ToHashSet();
        var wanted = store.AllRoleGroups().SelectMany(g => g.Answers).Where(a => chosen.Contains(a.Id)).SelectMany(a => a.RoleIds)
            .Where(id => roles.TryGetValue(id, out var r) && RoleFeature.Pickable(r)).ToHashSet();
        var held = me.RoleIds.ToHashSet();
        var grants = store.OnboardingGrants(accountKey);
        grants.IntersectWith(held);
        var remove = grants.Except(wanted).ToList();
        var add = wanted.Except(held).ToList();
        grants.ExceptWith(remove);
        grants.UnionWith(add);
        store.SetOnboardingGrants(accountKey, grants);
        if (remove.Count + add.Count == 0) return me;
        held.ExceptWith(remove);
        held.UnionWith(add);
        store.SetMemberRoles(accountKey, held);
        RoleFeature.AccessChanged(s, [accountKey]); // opt-in channels appear or go
        s.Hub.Outhooks?.MemberUpdated(accountKey, "roles");
        return store.GetMember(accountKey)!;
    }

    // ── Roles on join ────────────────────────────────────────────────────────

    private static void RequireManager(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageRoles)) throw RequestException.Forbidden("You can't manage roles on this server.", "manage_roles");
    }

    /// <summary>The roles on join that are still safe to give (a role can't gain permissions while self-assignable, but check anyway).</summary>
    private static long[] SafeAutoRoles(Store store)
    {
        var roles = store.AllRoles().ToDictionary(r => r.Id);
        return store.AutoRoles().Where(id => roles.TryGetValue(id, out var r) && RoleFeature.Pickable(r)).ToArray();
    }

    /// <summary>A person just became a member (any invite, approved or not, the p2p tunnel too): they get the roles on join. Bots don't.</summary>
    public static Member Joined(Store store, Member member)
    {
        if (store.IsBot(member.AccountKey)) return member;
        var auto = SafeAutoRoles(store);
        if (auto.Length == 0) return member;
        store.SetMemberRoles(member.AccountKey, member.RoleIds.Concat(auto));
        return store.GetMember(member.AccountKey) ?? member;
    }

    private static object SetAutoRoles(Session s, Member me, Body body)
    {
        RequireManager(me);
        var store = s.World.Store;
        var element = body.Element("roles");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxAutoRoles)
            throw RequestException.BadRequest($"New members can get up to {MaxAutoRoles} roles on join.", "onboarding_auto_roles_max", new { max = MaxAutoRoles });
        var ids = element.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id : throw RequestException.BadRequest("'roles' must be a list of ids."))
            .Distinct().ToList();
        RoleFeature.CheckPickable(store, ids, "onboarding_auto_role");
        var before = store.AutoRoles();
        if (!before.SequenceEqual(ids))
        {
            store.SetAutoRoles(ids);
            var names = store.AllRoles().ToDictionary(r => r.Id, r => r.Name);
            Audit.Record(s, "onboarding.autoroles", details: new { roles = ids.Select(id => names[id]) });
            RoleFeature.RolesChanged(s);
        }
        return new { autoRoles = store.AutoRoles() };
    }

    /// <summary>"Give to everyone now": every member who isn't a bot gets the roles on join they don't have yet.</summary>
    private static object ApplyAutoRoles(Session s, Member me, Body body)
    {
        RequireManager(me);
        var store = s.World.Store;
        var auto = SafeAutoRoles(store);
        var changed = new List<string>();
        if (auto.Length > 0)
        {
            foreach (var member in store.AllMembers())
            {
                if (store.IsBot(member.AccountKey)) continue;
                store.ForgetOnboardingGrants(member.AccountKey, auto); // given to everyone now, not by an answer
                if (auto.All(member.RoleIds.Contains)) continue;
                store.SetMemberRoles(member.AccountKey, member.RoleIds.Concat(auto));
                changed.Add(member.AccountKey);
            }
        }
        if (changed.Count > 0)
        {
            Audit.Record(s, "onboarding.autoroles.apply", details: new { members = changed.Count });
            RoleFeature.AccessChanged(s, changed);
            foreach (var key in changed) s.Hub.Outhooks?.MemberUpdated(key, "roles");
        }
        return new { members = changed.Count };
    }
}
