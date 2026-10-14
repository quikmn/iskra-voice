using System.Text.Json;
using Iskra.Server.Sessions;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>The base roles (owner … guest) as apps list them: fixed powers from one table, adjustable colours.</summary>
public class BaseRoleTests
{
    private static Iskra.Server.Storage.Member M(string role, Iskra.Server.Storage.Perm perms = 0, int top = 0) =>
        new("k" + role, role, role, 0) { Perms = perms, TopPosition = top, RoleIds = top > 0 ? [top] : [] };

    [Fact]
    public void Every_ability_is_listed_once_and_higher_roles_keep_everything_below()
    {
        Assert.Equal(Enum.GetValues<BaseAbility>().Order(), BaseRoles.Abilities.Select(a => a.Ability).Order());
        Assert.Equal(BaseRoles.Abilities.Count, BaseRoles.Abilities.Select(a => a.Name).Distinct().Count());
        for (var i = 1; i < Roles.All.Length; i++)
            Assert.Superset(BaseRoles.AbilitiesOf(Roles.All[i - 1]).ToHashSet(), BaseRoles.AbilitiesOf(Roles.All[i]).ToHashSet());
        Assert.Equal(BaseRoles.Abilities.Count, BaseRoles.AbilitiesOf(Roles.Owner).Length);
        Assert.Empty(BaseRoles.AbilitiesOf(Roles.Guest));

        // The checks follow the table.
        Assert.False(Permissions.CanCreateEvent(M("guest")));
        Assert.True(Permissions.CanCreateEvent(M("member")));
        Assert.False(Permissions.CanGrant(M("trusted"), "member"));
        Assert.True(Permissions.CanGrant(M("admin"), "trusted"));
        Assert.False(Permissions.CanGrant(M("admin"), "admin"));
        Assert.True(BaseRoles.Allows(M("owner"), BaseAbility.RunServer));
        Assert.False(BaseRoles.Allows(M("admin"), BaseAbility.RunServer));
        // Custom roles never grant base abilities.
        Assert.False(BaseRoles.Allows(M("member", (Iskra.Server.Storage.Perm)~0L, 9), BaseAbility.Bots));
    }

    [Fact]
    public async Task Role_list_shows_the_base_roles_highest_first_with_what_they_can_do()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var guest = await server.JoinAsync("Guest", "guest");

        var list = (await guest.RequestAsync("role.list")).Body().GetProperty("baseRoles");
        Assert.Equal(["owner", "admin", "trusted", "member", "guest"], list.EnumerateArray().Select(r => r.GetProperty("id").GetString()));
        string[] Names(JsonElement r, string field) => r.GetProperty(field).EnumerateArray().Select(x => x.GetString()!).ToArray();
        Assert.Equal(BaseRoles.AbilitiesOf("trusted"), Names(list[2], "abilities"));
        Assert.Contains("pin", Names(list[2], "abilities"));
        Assert.DoesNotContain("pin", Names(list[3], "abilities"));
        Assert.Contains("runServer", Names(list[0], "abilities"));
        Assert.DoesNotContain("runServer", Names(list[1], "abilities"));
        Assert.Equal(13, Names(list[1], "permissions").Length); // admins: every permission
        Assert.Empty(Names(list[2], "permissions"));
        Assert.All(list.EnumerateArray(), r => Assert.Equal(JsonValueKind.Null, r.GetProperty("color").ValueKind));
    }

    [Fact]
    public async Task Base_role_colours_follow_the_hierarchy()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var mod = await server.JoinAsync("Mod");
        using var member = await server.JoinAsync("Member");
        var modRole = (await owner.RequestAsync("role.create", new { name = "Moderator", permissions = new[] { "manageRoles" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { modRole } });
        await member.EventAsync("roles"); // from creating the role

        // The owner styles any base role, their own included; everyone hears about it.
        var result = await owner.RequestAsync("role.base.update", new { role = "owner", color = "#C27CE0" });
        Assert.Equal("#c27ce0", result.Body().GetProperty("baseRole").GetProperty("color").GetString());
        Assert.Equal("owner", result.Body().GetProperty("baseRole").GetProperty("id").GetString());
        var roles = (await member.EventAsync("roles")).Body();
        Assert.Equal("#c27ce0", roles.GetProperty("baseRoles")[0].GetProperty("color").GetString());

        // Admins and other role managers: only below admin. Nobody without manageRoles.
        Assert.Equal("forbidden", (await admin.RequestAsync("role.base.update", new { role = "admin", color = "#ffffff" })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("role.base.update", new { role = "owner", color = "" })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("role.base.update", new { role = "trusted", color = "#5b9bd5" })).Type());
        Assert.Equal("forbidden", (await mod.RequestAsync("role.base.update", new { role = "admin", color = "#ffffff" })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("role.base.update", new { role = "member", color = "#aaaaaa" })).Type());
        Assert.Equal("forbidden", (await member.RequestAsync("role.base.update", new { role = "guest", color = "#ffffff" })).ErrorCode());

        // Validation, and clearing.
        Assert.Equal("bad_request", (await owner.RequestAsync("role.base.update", new { role = "moderator", color = "#ffffff" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.base.update", new { role = "admin", color = "red" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("role.base.update", new { role = "member", color = "" })).Type());
        Assert.Equal(new Dictionary<string, string> { ["owner"] = "#c27ce0", ["trusted"] = "#5b9bd5" }, server.World.Store.BaseRoleColors());

        // Custom roles can't pass for built-in ones.
        Assert.Equal("bad_request", (await owner.RequestAsync("role.create", new { name = "Admin" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.update", new { id = modRole, name = "everyone" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("role.update", new { id = modRole, name = "Moderator", color = "#3fa66b" })).Type());

        // Recorded in the activity log.
        var log = (await owner.RequestAsync("audit.list")).Body().GetProperty("entries");
        Assert.Contains(log.EnumerateArray(), e => e.GetProperty("action").GetString() == "role.base");
    }
}
