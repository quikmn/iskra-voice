using System.Text.Json;
using Iskra.Server.Storage;
using Iskra.Server.Templates;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Starter templates for new servers: applied once, never onto a server in use, and bad ones rejected clearly.</summary>
public class TemplateTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "iskra-template-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_path, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void Every_built_in_template_is_valid()
    {
        foreach (var id in ServerTemplates.BuiltIn)
        {
            var template = ServerTemplates.Load(id);
            Assert.False(string.IsNullOrWhiteSpace(template.Name));
            var all = template.Channels.Concat(template.Categories.SelectMany(c => c.Channels)).ToList();
            Assert.Contains(all, c => c.Kind == "text");
            Assert.Contains(all, c => c.Kind == "voice"); // every server can talk right away
        }
    }

    [Fact]
    public void The_gaming_template_sets_up_channels_voice_rooms_roles_and_rules_once()
    {
        using var world = World.OpenOrCreate(_path);
        var general = world.Store.AllChannels().Single().Id;
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.Apply(world, ServerTemplates.Load("gaming"), "gaming", 1000));

        var categories = world.Store.AllCategories();
        Assert.Equal(["Text channels", "Voice"], categories.Select(c => c.Name));
        var channels = world.Store.AllChannels().OrderBy(c => c.Position).ToList();
        Assert.Equal(["general", "clips", "looking-for-group", "Lobby", "Squad 1", "Squad 2", "Raid", "AFK"], channels.Select(c => c.Name));
        // The starting #general is reused, not duplicated.
        Assert.Equal(general, channels[0].Id);
        Assert.All(channels.Take(3), c => Assert.Equal(categories[0].Id, c.CategoryId));
        Assert.All(channels.Skip(3), c => Assert.Equal("voice", c.Kind));
        Assert.All(channels.Skip(3), c => Assert.Equal(categories[1].Id, c.CategoryId));
        var limits = world.Store.AllUserLimits();
        Assert.Equal(5, limits[channels.Single(c => c.Name == "Squad 1").Id]);
        Assert.Equal(10, limits[channels.Single(c => c.Name == "Raid").Id]);
        Assert.False(limits.ContainsKey(channels.Single(c => c.Name == "Lobby").Id));

        var roles = world.Store.AllRoles(); // highest first, as listed
        Assert.Equal(["Moderator", "Raid lead"], roles.Select(r => r.Name));
        Assert.True(roles[0].Perms.HasFlag(Perm.KickMembers));
        Assert.True(roles[1].Mentionable);
        Assert.Equal("⚔️", roles[1].Icon);
        Assert.Equal(new Dictionary<string, string> { ["owner"] = "#c27ce0", ["admin"] = "#e5534b" }, world.Store.BaseRoleColors());
        Assert.Contains("Be good to each other", world.Store.Rules()!.Text);
        Assert.False(world.Store.Rules()!.Required);
        Assert.Equal("gaming", world.Store.AppliedTemplate()!.Value.Name);
        Assert.Single(world.Store.SecurityEvents("server.template", null, null, 10));

        // Again (a restart with the same setting): nothing changes.
        Assert.Equal(ServerTemplates.Outcome.AlreadyApplied, ServerTemplates.ApplyOnStart(world, "gaming", 2000));
        Assert.Equal(ServerTemplates.Outcome.AlreadyApplied, ServerTemplates.ApplyOnStart(world, "friends", 2000));
        Assert.Equal(8, world.Store.AllChannels().Count);
        Assert.Equal(2, world.Store.AllCategories().Count);
        Assert.Equal(2, world.Store.AllRoles().Count);
    }

    [Fact]
    public void A_template_never_touches_a_server_that_is_in_use()
    {
        using var world = World.OpenOrCreate(_path);
        world.Store.AddMember("someone", "Someone", "owner", 0);
        Assert.Equal(ServerTemplates.Outcome.NotNew, ServerTemplates.ApplyOnStart(world, "gaming", 1000));
        Assert.Single(world.Store.AllChannels());
        Assert.Null(world.Store.AppliedTemplate());
        // Not even read: a missing file doesn't stop a server that's already set up.
        Assert.Equal(ServerTemplates.Outcome.NotNew, ServerTemplates.ApplyOnStart(world, Path.Combine(_path, "gone.json"), 1000));
    }

    [Fact]
    public void A_file_template_works_and_the_empty_one_keeps_general()
    {
        Directory.CreateDirectory(_path);
        var file = Path.Combine(_path, "mine.json");
        File.WriteAllText(file, """
            {
              // comments are fine
              "name": "Book club",
              "channels": [ { "name": "Reading room", "kind": "voice", "userLimit": 8 } ],
              "categories": [ { "name": "Books", "channels": [ { "name": "now-reading" }, { "name": "announcements", "writeRole": "admin" } ] } ],
              "rules": { "text": "Be nice.", "required": true },
              "builtinRoles": { "Trusted": { "color": "#5B9BD5" }, "guest": { "color": "" } },
            }
            """);
        using var world = World.OpenOrCreate(Path.Combine(_path, "world"));
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.ApplyOnStart(world, file, 1000));
        var channels = world.Store.AllChannels().OrderBy(c => c.Position).ToList();
        Assert.Equal(["Reading room", "now-reading", "announcements"], channels.Select(c => c.Name));
        Assert.Equal("admin", channels[2].WriteRole);
        Assert.Equal("member", channels[2].ReadRole);
        Assert.True(world.Store.Rules()!.Required);
        Assert.Equal("mine.json", world.Store.AppliedTemplate()!.Value.Name);
        Assert.Equal(new Dictionary<string, string> { ["trusted"] = "#5b9bd5" }, world.Store.BaseRoleColors());

        using var empty = World.OpenOrCreate(Path.Combine(_path, "empty"));
        ServerTemplates.ApplyOnStart(empty, "empty", 1000);
        Assert.Equal(["general", "Voice"], empty.Store.AllChannels().Select(c => c.Name));
        Assert.Empty(empty.Store.AllRoles());
        Assert.Empty(empty.Store.BaseRoleColors());
        Assert.Null(empty.Store.Rules());
    }

    [Theory]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "vioce" } ] }""", "'kind' must be \"text\" or \"voice\", not \"vioce\"")]
    [InlineData("""{ "name": "x", "chanels": [] }""", "unknown field at $.chanels")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "voice", "userLimit": 100 } ] }""", "'userLimit' must be 0 (no limit) to 99")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "userLimit": 3 } ] }""", "only voice channels have a 'userLimit'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "" } ] }""", "channel names must be 1–32 characters")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "readRole": "owner" } ] }""", "roles must be guest, member, trusted or admin")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "Mod", "permissions": ["banEveryone"] } ] }""", "unknown permission 'banEveryone'")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "Mod" }, { "name": "mod" } ] }""", "two roles have the same name")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "Mod", "color": "red" } ] }""", "'color' must look like #rrggbb")]
    [InlineData("""{ "name": "x", "rules": { "required": true } }""", "'rules.required' needs 'rules.text'")]
    [InlineData("""{ "name": "x", "builtinRoles": { "moderator": { "color": "#ffffff" } } }""", "builtinRoles: there's no base role called 'moderator'. Use: owner, admin, trusted, member, guest")]
    [InlineData("""{ "name": "x", "builtinRoles": { "admin": { "color": "red" } } }""", "builtinRoles.admin: 'color' must look like #rrggbb")]
    [InlineData("""{ "name": "x", "builtinRoles": { "admin": { "colour": "#ffffff" } } }""", "unknown field at $.builtinRoles.admin.colour")]
    [InlineData("""{ "name": "x", "builtinRoles": { "admin": {}, "Admin": {} } }""", "builtinRoles: 'admin' is listed twice")]
    [InlineData("""{ "name": "x", "builtinRoles": { "admin": null } }""", "builtinRoles.admin: give an object")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "Trusted" } ] }""", "that name is taken by a built-in role")]
    [InlineData("""{ "name": "" }""", "'name' must be 1–60 characters")]
    [InlineData("""{ "name": "x", """, "isn't valid")]
    public void Invalid_templates_are_rejected_with_a_clear_error(string json, string expected)
    {
        var error = Assert.Throws<TemplateException>(() => ServerTemplates.Parse(json, "test.json"));
        Assert.StartsWith("Template 'test.json'", error.Message);
        Assert.Contains(expected, error.Message);
    }

    [Fact]
    public void Unknown_names_and_missing_files_are_rejected()
    {
        Assert.Contains("There's no template called 'gamng'", Assert.Throws<TemplateException>(() => ServerTemplates.Load("gamng")).Message);
        Assert.Contains("not found", Assert.Throws<TemplateException>(() => ServerTemplates.Load(Path.Combine(_path, "nope.json"))).Message);
        Directory.CreateDirectory(_path);
        var big = Path.Combine(_path, "big.json");
        File.WriteAllText(big, new string(' ', ServerTemplates.MaxFileBytes + 1));
        Assert.Contains("larger than", Assert.Throws<TemplateException>(() => ServerTemplates.Load(big)).Message);
    }

    [Fact]
    public async Task A_server_started_with_a_template_shows_it_to_the_first_people_who_join()
    {
        using var server = new IskraServer { Settings = { ["Template"] = "tabletop" } };
        using var owner = await server.JoinAsync("Owner", "owner");
        var welcome = owner.Welcome.Body();
        Assert.Equal(["Text channels", "Tables"], welcome.GetProperty("categories").EnumerateArray().Select(c => c.GetProperty("name").GetString()));
        var table = welcome.GetProperty("channels").EnumerateArray().Single(c => c.GetProperty("name").GetString() == "Table 1");
        Assert.Equal("voice", table.GetProperty("kind").GetString());
        Assert.Equal(6, table.GetProperty("userLimit").GetInt32());
        var roles = (await owner.RequestAsync("role.list")).Body().GetProperty("roles");
        Assert.Contains(roles.EnumerateArray(), r => r.GetProperty("name").GetString() == "Game master");
    }

    [Fact]
    public void A_server_with_a_bad_template_refuses_to_start()
    {
        using var server = new IskraServer { Settings = { ["Template"] = "no-such-template" } };
        Assert.ThrowsAny<Exception>(() => server.Services);
        using var world = World.OpenOrCreate(server.WorldPath);
        Assert.Single(world.Store.AllChannels());
        Assert.Null(world.Store.AppliedTemplate());
    }
}
