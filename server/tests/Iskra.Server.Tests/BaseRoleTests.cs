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
        Assert.Equal(15, Names(list[1], "permissions").Length); // admins: every permission
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

    private static string[] Names(JsonElement r, string field) => r.GetProperty(field).EnumerateArray().Select(x => x.GetString()!).ToArray();

    [Fact]
    public async Task Defaults_are_unchanged_and_the_list_says_what_can_be_adjusted()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var list = (await owner.RequestAsync("role.list")).Body().GetProperty("baseRoles");
        foreach (var r in list.EnumerateArray())
        {
            var role = r.GetProperty("id").GetString()!;
            Assert.False(r.GetProperty("changed").GetBoolean());
            Assert.Equal(Names(r, "abilities"), Names(r.GetProperty("defaults"), "abilities"));
            Assert.Equal(BaseRoles.AbilitiesOf(role), Names(r, "abilities"));
        }
        Assert.Empty(Names(list[0].GetProperty("adjustable"), "abilities")); // owner: nothing
        Assert.DoesNotContain("runServer", Names(list[1].GetProperty("adjustable"), "abilities"));
        Assert.Equal(15, Names(list[1].GetProperty("adjustable"), "permissions").Length);
        Assert.Equal(["invite", "events", "whisper", "externalEmoji", "pin", "mentionEveryone", "uploadSounds"], Names(list[3].GetProperty("adjustable"), "abilities"));
        Assert.Equal(["mentionEveryone"], Names(list[4].GetProperty("adjustable"), "permissions"));
    }

    [Fact]
    public async Task The_owner_adjusts_powers_and_the_checks_follow()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var channelId = owner.Welcome.Body().GetProperty("channels").EnumerateArray().First(c => c.GetProperty("kind").GetString() == "text").GetProperty("id").GetInt64();
        var messageId = (await member.RequestAsync("chat.send", new { channelId, text = "pin me" })).Body().GetProperty("message").GetProperty("id").GetInt64();

        // Members can't pin by default; give them pinning, and they can.
        Assert.Equal("forbidden", (await member.RequestAsync("chat.pin", new { id = messageId })).ErrorCode());
        var result = (await owner.RequestAsync("role.base.update", new { role = "member", abilities = new[] { "invite", "events", "pin" } })).Body().GetProperty("baseRole");
        Assert.True(result.GetProperty("changed").GetBoolean());
        Assert.Contains("pin", Names(result, "abilities"));
        var roles = (await member.EventAsync("roles")).Body().GetProperty("baseRoles");
        Assert.Contains("pin", Names(roles[3], "abilities"));
        Assert.Equal("result", (await member.RequestAsync("chat.pin", new { id = messageId })).Type());

        // Take invites away from members.
        await owner.RequestAsync("role.base.update", new { role = "member", abilities = new[] { "events", "pin" } });
        Assert.Equal("forbidden", (await member.RequestAsync("invite.create", new { })).ErrorCode());

        // Admins without kicking: the server refuses, the owner still can.
        await owner.RequestAsync("role.base.update", new { role = "admin", permissions = new[] { "manageMessages", "manageRoles", "manageChannels" } });
        Assert.Equal("forbidden", (await admin.RequestAsync("member.kick", new { accountKey = member.Key })).ErrorCode());
        // An admin role can only grant custom roles what admins have now.
        Assert.Equal("forbidden", (await admin.RequestAsync("role.create", new { name = "Kicker", permissions = new[] { "kickMembers" } })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("role.create", new { name = "Tidy", permissions = new[] { "manageMessages" } })).Type());

        // Reset puts the defaults back, and the change is gone from the store.
        var reset = (await owner.RequestAsync("role.base.update", new { role = "admin", reset = true })).Body().GetProperty("baseRole");
        Assert.False(reset.GetProperty("changed").GetBoolean());
        Assert.Equal(15, Names(reset, "permissions").Length);
        Assert.False(server.World.Store.BaseRoleChanges().ContainsKey("admin"));
        Assert.Equal("result", (await admin.RequestAsync("member.kick", new { accountKey = member.Key })).Type());

        var log = (await owner.RequestAsync("audit.list")).Body().GetProperty("entries");
        Assert.Contains(log.EnumerateArray(), e => e.GetProperty("action").GetString() == "role.base.powers");
    }

    [Fact]
    public async Task Nobody_can_lock_out_the_owner_or_raise_a_role_past_their_own()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var helper = await server.JoinAsync("Helper");
        using var member = await server.JoinAsync("Member");
        // A member who can manage roles through a custom role.
        var managers = (await owner.RequestAsync("role.create", new { name = "Role helpers", permissions = new[] { "manageRoles" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = helper.Key, roles = new[] { managers } });

        static string Key(JsonElement m) => m.Body().GetProperty("key").GetString()!;

        // The owner's role never changes, not even by the owner.
        var ownerEdit = await owner.RequestAsync("role.base.update", new { role = "owner", abilities = Array.Empty<string>() });
        Assert.Equal("forbidden", ownerEdit.ErrorCode());
        Assert.Equal("base_role_owner", Key(ownerEdit));
        Assert.Equal("forbidden", (await owner.RequestAsync("role.base.update", new { role = "owner", reset = true })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("role.base.update", new { role = "owner", permissions = Array.Empty<string>() })).ErrorCode());

        // Only roles below your own: admins can't touch admin; helpers (members) can't touch member or trusted.
        Assert.Equal("rank_base_roles", Key(await admin.RequestAsync("role.base.update", new { role = "admin", permissions = Array.Empty<string>() })));
        Assert.Equal("rank_base_roles", Key(await helper.RequestAsync("role.base.update", new { role = "member", abilities = Array.Empty<string>() })));
        Assert.Equal("rank_base_roles", Key(await helper.RequestAsync("role.base.update", new { role = "trusted", abilities = Array.Empty<string>() })));
        Assert.Equal("manage_roles", Key(await trusted.RequestAsync("role.base.update", new { role = "guest", abilities = new[] { "invite" } })));
        Assert.Equal("manage_roles", Key(await member.RequestAsync("role.base.update", new { role = "guest", reset = true })));

        // Only powers you have yourself: the helper (a member) can give guests inviting, not pinning.
        Assert.Equal("result", (await helper.RequestAsync("role.base.update", new { role = "guest", abilities = new[] { "invite" } })).Type());
        Assert.Equal("base_power_not_yours", Key(await helper.RequestAsync("role.base.update", new { role = "guest", abilities = new[] { "invite", "pin" } })));
        // ... and can't take away what they don't have either.
        await owner.RequestAsync("role.base.update", new { role = "guest", abilities = new[] { "invite", "uploadSounds" } });
        Assert.Equal("base_power_not_yours", Key(await helper.RequestAsync("role.base.update", new { role = "guest", abilities = new[] { "invite" } })));
        Assert.Equal("base_power_not_yours", Key(await helper.RequestAsync("role.base.update", new { role = "guest", reset = true })));

        // Guests and members only get everyday powers; owner-only powers never move.
        var modPower = await owner.RequestAsync("role.base.update", new { role = "member", permissions = new[] { "kickMembers" } });
        Assert.Equal("bad_request", modPower.ErrorCode());
        Assert.Equal("base_power_not_allowed", Key(modPower));
        Assert.Equal("base_power_not_allowed", Key(await owner.RequestAsync("role.base.update", new { role = "guest", abilities = new[] { "bots" } })));
        Assert.Equal("base_power_not_allowed", Key(await owner.RequestAsync("role.base.update", new { role = "admin", abilities = BaseRoles.AbilitiesOf("owner") })));
        Assert.Equal("base_power_not_allowed", Key(await owner.RequestAsync("role.base.update", new { role = "trusted", abilities = new[] { "transferOwnership" } })));
        Assert.Equal("bad_request", (await owner.RequestAsync("role.base.update", new { role = "trusted", abilities = new[] { "fly" } })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.base.update", new { role = "trusted", permissions = new[] { "fly" } })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.base.update", new { role = "trusted", reset = true, abilities = Array.Empty<string>() })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.base.update", new { role = "trusted", abilities = Enumerable.Repeat("pin", 40).ToArray() })).ErrorCode());

        // Taking every power from admins (managing roles too) still leaves the owner in charge: the owner gives it back.
        await owner.RequestAsync("role.base.update", new { role = "admin", abilities = Array.Empty<string>(), permissions = Array.Empty<string>() });
        Assert.Equal("manage_roles", Key(await admin.RequestAsync("role.base.update", new { role = "trusted", reset = true })));
        Assert.Equal("forbidden", (await admin.RequestAsync("member.setRole", new { accountKey = member.Key, role = "trusted" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("member.kick", new { accountKey = member.Key })).Type());
        Assert.Equal("result", (await owner.RequestAsync("limits.update", new { maxUploadMb = 100 })).Type());
        Assert.Equal("result", (await owner.RequestAsync("role.base.update", new { role = "admin", reset = true })).Type());
        Assert.Equal("result", (await admin.RequestAsync("role.base.update", new { role = "trusted", reset = true })).Type());

        // An admin can't lift trusted above admin: owner-only stays the owner's, and admins only give what they have.
        await owner.RequestAsync("role.base.update", new { role = "admin", abilities = BaseRoles.AbilitiesOf("admin").Where(a => a != "bots").ToArray() });
        Assert.Equal("base_power_not_yours", Key(await admin.RequestAsync("role.base.update", new { role = "trusted", abilities = BaseRoles.AbilitiesOf("trusted").Append("bots").ToArray() })));
    }

    [Fact]
    public void Stored_changes_stay_within_the_rules_even_if_the_database_says_otherwise()
    {
        var change = new Iskra.Server.Storage.BaseRoleChange(["bots", "runServer", "nonsense"], [], Iskra.Server.Storage.Perm.KickMembers | Iskra.Server.Storage.Perm.MentionEveryone, 0);
        var member = BaseRoles.Effective("member", change);
        Assert.Equal(BaseRoles.DefaultAbilities("member"), member.Abilities); // bots and runServer can't be given to members
        Assert.Equal(Iskra.Server.Storage.Perm.MentionEveryone, member.Perms);
        var admin = BaseRoles.Effective("admin", change);
        Assert.False((admin.Abilities & BaseRoles.Bit(BaseAbility.RunServer)) != 0);
        // The owner always has everything, whatever is stored.
        var owner = M("owner") with { Base = new Iskra.Server.Storage.BasePowers(0, 0) };
        Assert.True(BaseRoles.Allows(owner, BaseAbility.RunServer));
        Assert.True(Permissions.Has(owner, Iskra.Server.Storage.Perm.ManageRoles));
        Assert.Null(BaseRoles.ChangeFor("trusted", BaseRoles.DefaultAbilities("trusted"), 0));
    }
}
