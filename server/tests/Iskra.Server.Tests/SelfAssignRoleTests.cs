using System.Text.Json;
using Iskra.Server.Templates;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Roles members pick themselves, the pick groups that ask about them, and what they can never grant.</summary>
public class SelfAssignRoleTests
{
    private static async Task<long> CreateRole(User by, string name, bool selfAssign = true, string[]? permissions = null)
    {
        var result = await by.RequestAsync("role.create", new { name, selfAssign, permissions = permissions ?? [] });
        Assert.Equal("result", result.Type());
        return result.Body().GetProperty("role").GetProperty("id").GetInt64();
    }

    private static long[] Ids(JsonElement ids) => ids.EnumerateArray().Select(r => r.GetInt64()).ToArray();

    [Fact]
    public async Task A_self_assignable_role_never_carries_permissions()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");

        var pc = await CreateRole(owner, "PC");
        Assert.True((await member.EventAsync("roles")).Body().GetProperty("roles")[0].GetProperty("selfAssign").GetBoolean());
        // Not with permissions: neither when made, nor added later, nor flagged later on a role that has some.
        var refused = await owner.RequestAsync("role.create", new { name = "Mod", selfAssign = true, permissions = new[] { "kickMembers" } });
        Assert.Equal("bad_request", refused.ErrorCode());
        Assert.Equal("role_self_assign_perms", refused.Body().GetProperty("key").GetString());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.update", new { id = pc, permissions = new[] { "manageMessages" } })).ErrorCode());
        var mod = await CreateRole(owner, "Moderator", selfAssign: false, permissions: ["kickMembers"]);
        Assert.Equal("bad_request", (await owner.RequestAsync("role.update", new { id = mod, selfAssign = true })).ErrorCode());
        // Only role managers set the flag.
        Assert.Equal("forbidden", (await member.RequestAsync("role.update", new { id = pc, selfAssign = false })).ErrorCode());
    }

    [Fact]
    public async Task Members_pick_and_drop_self_assignable_roles_only()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        using var watcher = await server.JoinAsync("Watcher");
        var pc = await CreateRole(owner, "PC");
        var ps = await CreateRole(owner, "PlayStation");
        var mod = await CreateRole(owner, "Moderator", selfAssign: false, permissions: ["kickMembers"]);
        var plain = await CreateRole(owner, "Plain", selfAssign: false);

        var picked = await member.RequestAsync("roles.self", new { add = new[] { pc, ps } });
        Assert.Equal("result", picked.Type());
        Assert.Equal(new[] { pc, ps }.Order().ToArray(), Ids(picked.Body().GetProperty("member").GetProperty("roles")).Order().ToArray());
        // Everyone hears it, like any role change.
        var updated = (await watcher.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.Equal(member.Key, updated.GetProperty("accountKey").GetString());
        Assert.Equal(2, updated.GetProperty("roles").GetArrayLength());

        var dropped = await member.RequestAsync("roles.self", new { remove = new[] { ps } });
        Assert.Equal([pc], Ids(dropped.Body().GetProperty("member").GetProperty("roles")));

        // Not a role with permissions, not a plain role, not one that doesn't exist, not nothing.
        foreach (var id in new[] { mod, plain })
        {
            var refused = await member.RequestAsync("roles.self", new { add = new[] { id } });
            Assert.Equal("forbidden", refused.ErrorCode());
            Assert.Equal("role_not_self_assign", refused.Body().GetProperty("key").GetString());
        }
        Assert.Equal("bad_request", (await member.RequestAsync("roles.self", new { add = new[] { 999L } })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("roles.self", new { })).ErrorCode());
        // A role a moderator gave can't be dropped this way either.
        await owner.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { pc, plain } });
        Assert.Equal("forbidden", (await member.RequestAsync("roles.self", new { remove = new[] { plain } })).ErrorCode());

        // The flag is checked when picking, not when it was set: turn it off and the role is no longer anyone's to pick.
        await owner.RequestAsync("role.update", new { id = ps, selfAssign = false });
        Assert.Equal("forbidden", (await member.RequestAsync("roles.self", new { add = new[] { ps } })).ErrorCode());
    }

    [Fact]
    public async Task Picked_roles_grant_nothing_and_never_lift_anyone_in_the_hierarchy()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await server.JoinAsync("Mod");
        using var member = await server.JoinAsync("Member");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        var moderator = await CreateRole(owner, "Moderator", selfAssign: false, permissions: ["kickMembers", "timeoutMembers"]);
        var pc = await CreateRole(owner, "PC"); // newest role: the highest position
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { moderator } });
        await owner.RequestAsync("role.reorder", new { ids = new[] { pc, moderator } }); // PC above Moderator

        await member.RequestAsync("roles.self", new { add = new[] { pc } });
        await trusted.RequestAsync("roles.self", new { add = new[] { pc } });
        var stored = server.World.Store.GetMember(member.Key)!;
        Assert.Equal([pc], stored.RoleIds);
        Assert.Equal(0, stored.TopPosition);
        Assert.Equal(Iskra.Server.Storage.Perm.None, stored.Perms);
        // The moderator (whose role sits below PC) can still time the member out: PC doesn't count as rank.
        Assert.Equal("result", (await mod.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 60_000 })).Type());
        // ...and a trusted member who picked PC still outranks a plain member, not the moderator.
        Assert.Equal("forbidden", (await trusted.RequestAsync("member.kick", new { accountKey = mod.Key })).ErrorCode());
        Assert.False(Iskra.Server.Sessions.Permissions.Outranks(server.World.Store.GetMember(trusted.Key)!, server.World.Store.GetMember(mod.Key)!));
    }

    [Fact]
    public async Task Pick_groups_are_managed_by_role_managers_and_announced_to_everyone()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var ps = await CreateRole(owner, "PlayStation");
        var mod = await CreateRole(owner, "Moderator", selfAssign: false, permissions: ["kickMembers"]);

        Assert.Equal("forbidden", (await member.RequestAsync("role.group.create", new { title = "Platform", roles = new[] { pc } })).ErrorCode());
        var created = await owner.RequestAsync("role.group.create", new { title = "Platform", question = "What do you play on?", multi = true, roles = new[] { pc, ps } });
        Assert.Equal("result", created.Type());
        var group = created.Body().GetProperty("group");
        var id = group.GetProperty("id").GetInt64();
        Assert.Equal("Platform", group.GetProperty("title").GetString());
        Assert.True(group.GetProperty("multi").GetBoolean());
        Assert.Equal([pc, ps], Ids(group.GetProperty("roles")));
        for (var i = 0; i < 3; i++) await member.EventAsync("roles"); // the three roles being made
        var announced = (await member.EventAsync("roles")).Body().GetProperty("groups");
        Assert.Equal(1, announced.GetArrayLength());
        Assert.Equal(1, (await member.RequestAsync("role.list")).Body().GetProperty("groups").GetArrayLength());

        // Limits and checks.
        Assert.Equal("bad_request", (await owner.RequestAsync("role.group.create", new { title = "", roles = new[] { pc } })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.group.create", new { title = new string('x', 61), roles = new[] { pc } })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.group.create", new { title = "Q", question = new string('x', 201), roles = new[] { pc } })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.group.create", new { title = "Empty", roles = Array.Empty<long>() })).ErrorCode());
        var notPickable = await owner.RequestAsync("role.group.create", new { title = "Staff", roles = new[] { mod } });
        Assert.Equal("bad_request", notPickable.ErrorCode());
        Assert.Equal("role_group_not_self_assign", notPickable.Body().GetProperty("key").GetString());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.group.create", new { title = "Ghost", roles = new[] { 999L } })).ErrorCode());

        // Update, then the role stops being pickable and leaves the group; delete.
        var updated = (await owner.RequestAsync("role.group.update", new { id, title = "Platforms", multi = false, roles = new[] { ps, pc } })).Body().GetProperty("group");
        Assert.Equal("Platforms", updated.GetProperty("title").GetString());
        Assert.False(updated.GetProperty("multi").GetBoolean());
        Assert.Equal([ps, pc], Ids(updated.GetProperty("roles")));
        await owner.RequestAsync("role.update", new { id = ps, selfAssign = false });
        Assert.Equal([pc], server.World.Store.GetRoleGroup(id)!.RoleIds);
        await owner.RequestAsync("role.delete", new { id = pc });
        Assert.Empty(server.World.Store.GetRoleGroup(id)!.RoleIds);
        Assert.Equal("result", (await owner.RequestAsync("role.group.delete", new { id })).Type());
        Assert.Equal("not_found", (await owner.RequestAsync("role.group.delete", new { id })).ErrorCode());
        Assert.Empty((await owner.RequestAsync("role.list")).Body().GetProperty("groups").EnumerateArray());

        // At most 20 groups.
        var x = await CreateRole(owner, "X");
        for (var i = 0; i < 20; i++) Assert.Equal("result", (await owner.RequestAsync("role.group.create", new { title = $"G{i}", roles = new[] { x } })).Type());
        var full = await owner.RequestAsync("role.group.create", new { title = "G20", roles = new[] { x } });
        Assert.Equal("bad_request", full.ErrorCode());
        Assert.Equal("role_groups_max", full.Body().GetProperty("key").GetString());

        // The audit log tells the story.
        var actions = (await owner.RequestAsync("audit.list", new { limit = 100 })).Body().GetProperty("entries").EnumerateArray()
            .Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("role.group.create", actions);
        Assert.Contains("role.group.update", actions);
        Assert.Contains("role.group.delete", actions);
    }

    [Fact]
    public async Task Picking_in_a_single_choice_group_drops_the_other_answers()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var ps = await CreateRole(owner, "PlayStation");
        var xbox = await CreateRole(owner, "Xbox");
        var events = await CreateRole(owner, "Events");
        await owner.RequestAsync("role.group.create", new { title = "Platform", roles = new[] { pc, ps, xbox } }); // single choice
        await owner.RequestAsync("role.group.create", new { title = "Pings", multi = true, roles = new[] { events } });

        var first = await member.RequestAsync("roles.self", new { add = new[] { pc, events } });
        Assert.Equal(new[] { pc, events }.Order().ToArray(), Ids(first.Body().GetProperty("member").GetProperty("roles")).Order().ToArray());
        var second = await member.RequestAsync("roles.self", new { add = new[] { ps } });
        Assert.Equal(new[] { ps, events }.Order().ToArray(), Ids(second.Body().GetProperty("member").GetProperty("roles")).Order().ToArray()); // PC went, Events stayed
        // Same again changes nothing and says so quietly.
        Assert.Equal("result", (await member.RequestAsync("roles.self", new { add = new[] { ps } })).Type());
        Assert.Equal(new[] { ps, events }.Order().ToArray(), server.World.Store.GetMember(member.Key)!.RoleIds.Order().ToArray());
    }

    [Fact]
    public async Task Picking_roles_is_rate_limited()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var codes = new List<string?>();
        for (var i = 0; i < 12; i++) codes.Add((await member.RequestAsync("roles.self", new { add = new[] { pc } })).ErrorCode());
        Assert.Contains("rate_limited", codes);
        Assert.Equal(10, codes.Count(c => c is null));
    }

    [Fact]
    public void Templates_carry_self_assignable_roles_and_pick_groups()
    {
        var template = ServerTemplates.Parse("""
            {
              "version": 4, "name": "Club",
              "roles": [
                { "name": "Moderator", "permissions": ["kickMembers"] },
                { "name": "PC", "selfAssign": true },
                { "name": "PlayStation", "selfAssign": true, "color": "#003087" }
              ],
              "roleGroups": [ { "title": "Platform", "question": "What do you play on?", "multi": true, "roles": ["PC", "playstation"] } ]
            }
            """, "club.json");
        Assert.True(template.Roles[1].SelfAssign);
        Assert.Equal(["PC", "PlayStation"], template.RoleGroups[0].Roles);

        using var server = new IskraServer();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.Apply(server.World, template, "club", now));
        var roles = server.World.Store.AllRoles();
        Assert.Equal([false, true, true], roles.Select(r => r.SelfAssign));
        var group = Assert.Single(server.World.Store.AllRoleGroups());
        Assert.Equal("Platform", group.Title);
        Assert.True(group.Multi);
        Assert.Equal(roles.Where(r => r.SelfAssign).Select(r => r.Id).Order(), group.RoleIds.Order());

        // Saved again, it comes out as format 4 with the same groups.
        var owner = server.World.Store.AddMember("k-owner", "Owner", "owner", now);
        var exported = TemplateExport.Build(server.World, owner);
        Assert.Equal(4, exported["version"]!.GetValue<int>());
        Assert.Equal("Platform", exported["roleGroups"]![0]!["title"]!.GetValue<string>());
        Assert.True(exported["roles"]![1]!["selfAssign"]!.GetValue<bool>());
        ServerTemplates.Parse(exported.ToJsonString(), "export.json");
    }

    [Theory]
    [InlineData("""{ "name": "x", "roles": [ { "name": "PC", "selfAssign": true, "permissions": ["kickMembers"] } ] }""", "can't have permissions")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "PC" } ], "roleGroups": [ { "title": "P", "roles": ["PC"] } ] }""", "needs \"selfAssign\": true")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "PC", "selfAssign": true } ], "roleGroups": [ { "title": "P", "roles": ["Xbox"] } ] }""", "isn't one of the template's roles")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "PC", "selfAssign": true } ], "roleGroups": [ { "title": "", "roles": ["PC"] } ] }""", "'title' must be 1–60 characters")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "PC", "selfAssign": true } ], "roleGroups": [ { "title": "P", "roles": [] } ] }""", "'roles' needs 1–25")]
    public void Templates_with_bad_pick_groups_are_refused(string json, string problem)
    {
        var ex = Assert.Throws<TemplateException>(() => ServerTemplates.Parse(json, "t.json"));
        Assert.Contains(problem, ex.Message);
    }

    [Fact]
    public async Task Applying_a_template_to_a_server_in_use_adds_missing_pick_groups()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var existing = await CreateRole(owner, "PC", selfAssign: false); // the server's own PC role: nobody may pick it
        var template = ServerTemplates.Parse("""
            {
              "version": 4, "name": "Club",
              "roles": [ { "name": "PC", "selfAssign": true }, { "name": "Xbox", "selfAssign": true }, { "name": "Events", "selfAssign": true } ],
              "roleGroups": [
                { "title": "Platform", "roles": ["PC", "Xbox"] },
                { "title": "Pings", "multi": true, "roles": ["Events"] }
              ]
            }
            """, "club.json");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var plan = ServerTemplates.Merge(server.World, template, apply: false, now);
        Assert.Contains("role Xbox", plan);
        Assert.Contains(plan, p => p.StartsWith("(skipped) pick group Platform"));
        Assert.Contains("pick group Pings (Events)", plan);
        Assert.Empty(server.World.Store.AllRoleGroups());

        ServerTemplates.Merge(server.World, template, apply: true, now);
        var group = Assert.Single(server.World.Store.AllRoleGroups());
        Assert.Equal("Pings", group.Title);
        Assert.False(server.World.Store.GetRole(existing)!.SelfAssign);
        // Running it again adds nothing.
        Assert.DoesNotContain(ServerTemplates.Merge(server.World, template, apply: false, now), p => !p.StartsWith("(skipped)"));
    }
}
