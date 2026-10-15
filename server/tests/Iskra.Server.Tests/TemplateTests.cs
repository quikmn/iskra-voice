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
        Assert.Equal(["general", "announcements", "clips", "looking-for-group", "mod-chat", "Lobby", "Squad 1", "Squad 2", "Raid", "Tournament", "AFK"],
            channels.Select(c => c.Name));
        // The starting #general is reused, not duplicated.
        Assert.Equal(general, channels[0].Id);
        Assert.Equal("admin", channels[1].WriteRole);
        Assert.All(channels.Take(5), c => Assert.Equal(categories[0].Id, c.CategoryId));
        Assert.All(channels.Skip(5), c => Assert.Equal(categories[1].Id, c.CategoryId));
        Assert.Equal("stage", channels.Single(c => c.Name == "Tournament").Kind);
        Assert.Equal(30, world.Store.Slowmode(channels.Single(c => c.Name == "looking-for-group").Id));
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
        // The AFK channel, 30 minutes, owner and admins can talk there.
        var afk = world.Store.Afk();
        Assert.Equal(channels.Single(c => c.Name == "AFK").Id, afk.ChannelId);
        Assert.Equal(30, afk.IdleMinutes);
        Assert.Equal(["owner", "admin"], afk.TalkLevels);
        Assert.Empty(afk.TalkRoles);
        // Per-role channel permissions: moderators post announcements and see #mod-chat; members don't.
        var mod = world.Store.AllRoles()[0];
        var announcements = world.Store.GetChannel(channels[1].Id)!;
        var modChat = world.Store.GetChannel(channels.Single(c => c.Name == "mod-chat").Id)!;
        var member = new Member("m", "M", "member", 0);
        var moderator = member with { RoleIds = [mod.Id], Perms = mod.Perms, TopPosition = mod.Position };
        Assert.False(Iskra.Server.Sessions.Permissions.CanSend(member, announcements));
        Assert.True(Iskra.Server.Sessions.Permissions.CanSend(moderator, announcements));
        Assert.False(Iskra.Server.Sessions.Permissions.CanRead(member, modChat));
        Assert.True(Iskra.Server.Sessions.Permissions.CanSend(moderator, modChat));
        // Dice and Polls are on.
        Assert.Equal(["dice", "polls"], world.Store.BuiltinBots().Select(b => b.Id).Order());

        // Again (a restart with the same setting): nothing changes.
        Assert.Equal(ServerTemplates.Outcome.AlreadyApplied, ServerTemplates.ApplyOnStart(world, "gaming", 2000));
        Assert.Equal(ServerTemplates.Outcome.AlreadyApplied, ServerTemplates.ApplyOnStart(world, "friends", 2000));
        Assert.Equal(11, world.Store.AllChannels().Count);
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
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "vioce" } ] }""", "'kind' must be one of text, voice, forum, stage, docs, whiteboard, not \"vioce\"")]
    [InlineData("""{ "name": "x", "chanels": [] }""", "unknown field at $.chanels")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "voice", "userLimit": 100 } ] }""", "'userLimit' must be 0 (no limit) to 99")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "userLimit": 3 } ] }""", "only voice channels have a 'userLimit'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "" } ] }""", "channel names must be 1–32 characters")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "readRole": "boss" } ] }""", "roles must be guest, member, trusted, admin or owner")]
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
    [InlineData("""{ "name": "x", "afk": { "channel": "AFK" } }""", "'afk.channel': there's no channel called 'AFK'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "AFK" } ], "afk": { "channel": "AFK" } }""", "'afk.channel': 'AFK' isn't a voice channel")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "AFK", "kind": "voice" }, { "name": "afk", "kind": "voice" } ], "afk": { "channel": "AFK" } }""", "more than one channel is called 'AFK'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "AFK", "kind": "voice" } ], "afk": { "channel": "AFK", "minutes": 10 } }""", "'afk.minutes' must be 0 (never move anyone), 5, 15, 30 or 60")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "AFK", "kind": "voice" } ], "afk": { "channel": "AFK", "canTalk": ["Mods"] } }""", "'afk.canTalk': 'Mods' is neither a level")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "AFK", "kind": "voice" } ], "afk": { "channel": "AFK", "mins": 5 } }""", "unknown field at $.afk.mins")]
    [InlineData("""{ "version": 4, "name": "x" }""", "made by a newer version of Iskra (format 4)")]
    [InlineData("""{ "version": 0, "name": "x" }""", "'version' must be 1 to 3")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "hifi": true } ] }""", "only voice channels can allow hi-fi audio")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "slowmode": 7 } ] }""", "'slowmode' must be 0 (off) or one of")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "docs", "slowmode": 5 } ] }""", "docs channels have no slowmode")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "whiteboard", "slowmode": 5 } ] }""", "whiteboard channels have no slowmode")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "overrides": [ { "role": "Mods", "allow": ["send"] } ] } ] }""", "override for 'Mods', which isn't one of the template's roles")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "Mods" } ], "channels": [ { "name": "a", "overrides": [ { "role": "mods", "allow": ["fly"] } ] } ] }""", "unknown channel permission 'fly'")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "Mods" } ], "channels": [ { "name": "a", "overrides": [ { "role": "Mods", "allow": ["send"], "deny": ["send"] } ] } ] }""", "can't both allow and deny")]
    [InlineData("""{ "name": "x", "roles": [ { "name": "Mods" } ], "channels": [ { "name": "a", "overrides": [ { "role": "Mods", "allow": ["send"] }, { "role": "mods", "deny": ["view"] } ] } ] }""", "each role can only have one override per channel")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "tags": [ { "name": "News" } ] } ] }""", "only forums have tags")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "forum", "tags": [ { "name": "News" }, { "name": "news" } ] } ] }""", "two tags have the same name")]
    [InlineData("""{ "name": "x", "builtinRoles": { "owner": { "abilities": [] } } }""", "the owner can always do everything")]
    [InlineData("""{ "name": "x", "builtinRoles": { "member": { "permissions": ["kickMembers"] } } }""", "guests and members can only get everyday powers")]
    [InlineData("""{ "name": "x", "builtinRoles": { "guest": { "abilities": ["bots"] } } }""", "guests and members can only get everyday powers (invite, events, pin, mentionEveryone, uploadSounds), not bots")]
    [InlineData("""{ "name": "x", "builtinRoles": { "admin": { "abilities": ["runServer"] } } }""", "runServer always stay with the owner")]
    [InlineData("""{ "name": "x", "builtinRoles": { "trusted": { "abilities": ["fly"] } } }""", "builtinRoles.trusted: unknown ability 'fly'")]
    [InlineData("""{ "name": "x", "settings": { "notifyDefault": "loud" } }""", "'settings.notifyDefault' must be")]
    [InlineData("""{ "name": "x", "settings": { "builtinBots": ["music"] } }""", "there's no built-in bot called 'music'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "Bugs", "kind": "voice" } ], "settings": { "bugInbox": "Bugs" } }""", "'settings.bugInbox': 'Bugs' isn't a text channel")]
    [InlineData("""{ "name": "x", "settings": { "bugInbox": "bugs" } }""", "'settings.bugInbox' must name exactly one")]
    [InlineData("""{ "name": "x", "settings": { "limits": { "maxUploadMb": 0 } } }""", "'settings.limits.maxUploadMb' must be 1 to")]
    [InlineData("""{ "name": "x", "settings": { "volume": 11 } }""", "unknown field at $.settings.volume")]
    public void Invalid_templates_are_rejected_with_a_clear_error(string json, string expected)
    {
        var error = Assert.Throws<TemplateException>(() => ServerTemplates.Parse(json, "test.json"));
        Assert.StartsWith("Template 'test.json'", error.Message);
        Assert.Contains(expected, error.Message);
    }

    [Fact]
    public void A_template_sets_the_AFK_channel_with_levels_and_its_own_roles()
    {
        var template = ServerTemplates.Parse("""
            {
              "name": "Squad",
              "categories": [ { "name": "Voice", "channels": [ { "name": "Lobby", "kind": "voice" }, { "name": "Sleeping", "kind": "voice" } ] } ],
              "roles": [ { "name": "Raid lead" } ],
              "afk": { "channel": "sleeping", "minutes": 5, "canTalk": ["Owner", "raid lead"] }
            }
            """, "squad.json");
        Assert.Equal("Sleeping", template.Afk!.Channel);
        Assert.Equal(["owner", "Raid lead"], template.Afk.CanTalk);
        using var world = World.OpenOrCreate(_path);
        ServerTemplates.Apply(world, template, "squad.json", 1000);
        var afk = world.Store.Afk();
        Assert.Equal(world.Store.AllChannels().Single(c => c.Name == "Sleeping").Id, afk.ChannelId);
        Assert.Equal(5, afk.IdleMinutes);
        Assert.Equal(["owner"], afk.TalkLevels);
        Assert.Equal([world.Store.AllRoles().Single().Id], afk.TalkRoles);
        // Without "afk" a template leaves it off (older templates stay valid).
        using var plain = World.OpenOrCreate(Path.Combine(_path, "plain"));
        ServerTemplates.Apply(plain, ServerTemplates.Parse("""{ "name": "x", "channels": [ { "name": "a", "kind": "voice" } ] }""", "x.json"), "x.json", 1000);
        Assert.Null(plain.Store.Afk().ChannelId);
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

    [Fact]
    public void A_format_2_template_sets_up_every_channel_kind_permissions_powers_and_settings()
    {
        var template = ServerTemplates.Parse("""
            {
              "version": 2,
              "name": "Everything",
              "roles": [ { "name": "Editor", "permissions": ["manageMessages"] }, { "name": "Muted" } ],
              "channels": [
                { "name": "news", "writeRole": "admin", "slowmode": 60, "overrides": [ { "role": "Editor", "allow": ["send"] }, { "role": "Muted", "deny": ["send"] } ] },
                { "name": "secret", "readRole": "owner" },
                { "name": "ideas", "kind": "forum", "tags": [ { "name": "Bug", "emoji": "🐛" }, { "name": "Wish" } ] },
                { "name": "wiki", "kind": "docs" },
                { "name": "Town hall", "kind": "stage" },
                { "name": "Studio", "kind": "voice", "hifi": true, "userLimit": 4 },
                { "name": "bugs", "readRole": "admin" }
              ],
              "builtinRoles": {
                "member": { "abilities": ["invite", "events", "pin"] },
                "trusted": { "color": "#5b9bd5", "permissions": ["manageMessages", "mentionEveryone"] },
                "admin": { "permissions": ["manageMessages", "kickMembers", "banMembers", "manageChannels", "viewAuditLog"] }
              },
              "settings": {
                "notifyDefault": "mentions",
                "limits": { "maxUploadMb": 100, "guestMbPerDay": 0, "emojiMaxKb": 256 },
                "builtinBots": ["Dice", "reminders"],
                "bugInbox": "bugs"
              }
            }
            """, "everything.json");
        using var world = World.OpenOrCreate(_path);
        world.UpdateSettings(w => w with { BugInbox = new BugInboxConfig { Accept = true } });
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.Apply(world, template, "everything.json", 1000));
        var store = world.Store;
        var channels = store.AllChannels().ToDictionary(c => c.Name);
        Assert.Equal(["text", "text", "forum", "docs", "stage", "voice", "text"], store.AllChannels().OrderBy(c => c.Position).Select(c => c.Kind));
        Assert.Equal("owner", channels["secret"].ReadRole);
        Assert.Equal("trusted", channels["wiki"].WriteRole); // docs: trusted and above edit by default
        Assert.Equal(60, store.Slowmode(channels["news"].Id));
        Assert.True(store.IsHifi(channels["Studio"].Id));
        Assert.Equal(4, store.UserLimit(channels["Studio"].Id));
        Assert.Equal(["Bug", "Wish"], store.ForumTags(channels["ideas"].Id).Select(t => t.Name));
        var roles = store.AllRoles().ToDictionary(r => r.Name);
        var news = channels["news"];
        Assert.Contains(news.Overrides, o => o.RoleId == roles["Editor"].Id && o.Allow == ChannelPerm.Send);
        Assert.Contains(news.Overrides, o => o.RoleId == roles["Muted"].Id && o.Deny == ChannelPerm.Send);

        // Built-in role powers: stored as changes from the defaults.
        var powers = store.ChangedBasePowers();
        Assert.Equal(["invite", "events", "pin"], Iskra.Server.Sessions.BaseRoles.Names(powers["member"].Abilities));
        Assert.Equal(Perm.ManageMessages | Perm.MentionEveryone, powers["trusted"].Perms);
        Assert.False(powers["admin"].Perms.HasFlag(Perm.ManageRoles));
        Assert.False(powers.ContainsKey("guest"));
        Assert.Equal("#5b9bd5", store.BaseRoleColors()["trusted"]);
        var admin = store.AddMember("a", "Admin", "admin", 2000);
        Assert.False(Iskra.Server.Sessions.Permissions.Has(admin, Perm.ManageRoles));
        Assert.True(Iskra.Server.Sessions.Permissions.Has(admin, Perm.KickMembers));

        // Settings.
        Assert.Equal("mentions", store.NotifyDefault());
        Assert.Equal(100, world.Settings.MaxUploadMb);
        Assert.Equal(0, world.Settings.UploadQuota.GuestMbPerDay);
        Assert.Equal(10240, world.Settings.UploadQuota.MemberMbPerDay); // left out: the default
        Assert.Equal(256, world.Settings.Limits.EmojiMaxKb);
        Assert.Equal(["dice", "reminders"], store.BuiltinBots().Select(b => b.Id).Order());
        Assert.All(store.BuiltinBots(), b => Assert.NotNull(store.GetMember(b.AccountKey)));
        Assert.Equal(new BugInboxSettings(true, channels["bugs"].Id), store.GetBugInbox());
    }

    [Fact]
    public void Format_1_templates_still_work()
    {
        var template = ServerTemplates.Parse("""{ "name": "Old", "channels": [ { "name": "chat" }, { "name": "Talk", "kind": "voice" } ], "builtinRoles": { "admin": { "color": "#e5534b" } } }""", "old.json");
        Assert.Equal(1, template.Version);
        using var world = World.OpenOrCreate(_path);
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.Apply(world, template, "old.json", 1000));
        Assert.Equal(["chat", "Talk"], world.Store.AllChannels().Select(c => c.Name));
        Assert.Empty(world.Store.ChangedBasePowers()); // powers stay the defaults
        Assert.Null(world.Store.NotifyDefault());
    }

    [Fact]
    public void A_relative_template_file_is_found_in_the_world_folder()
    {
        using var world = World.OpenOrCreate(_path);
        File.WriteAllText(Path.Combine(_path, "template.json"), """{ "version": 2, "name": "Mine", "channels": [ { "name": "here" } ] }""");
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.ApplyOnStart(world, "template.json", 1000));
        Assert.Equal(["here"], world.Store.AllChannels().Select(c => c.Name));
    }

    [Fact]
    public async Task Save_as_template_round_trips_and_never_includes_members_messages_or_secrets()
    {
        using var server = new IskraServer { AcceptBugReports = true, Settings = { ["Template"] = "tabletop" } };
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var channels = owner.Welcome.Body().GetProperty("channels").EnumerateArray().ToList();
        long Id(string name) => channels.Single(c => c.GetProperty("name").GetString() == name).GetProperty("id").GetInt64();
        await owner.RequestAsync("chat.send", new { channelId = Id("general"), text = "a secret message" });
        await owner.RequestAsync("channel.create", new { name = "owner-notes", readRole = "owner" });
        var invite = (await owner.RequestAsync("invite.create", new { })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        await owner.RequestAsync("role.base.update", new { role = "member", abilities = new[] { "invite", "events", "pin" } });
        await owner.RequestAsync("notify.default.set", new { level = "all" });
        await owner.RequestAsync("buginbox.set", new { enabled = true, channelId = Id("gm-screen") });

        Assert.Equal("forbidden", (await member.RequestAsync("server.template.export")).ErrorCode());
        var byAdmin = (await admin.RequestAsync("server.template.export")).Body().GetProperty("template").GetRawText();
        var json = (await owner.RequestAsync("server.template.export")).Body().GetProperty("template").GetRawText();

        // Nothing about people, messages, invites or keys.
        foreach (var leak in new[] { "a secret message", owner.Key, admin.Key, member.Key, "\"Owner\"", "\"Member\"", invite })
            Assert.DoesNotContain(leak, json);
        Assert.DoesNotContain(server.World.Store.BuiltinBots().Single().AccountKey, json);
        // The admin doesn't see owner-only channels or the owner's bug inbox; the owner's export has both.
        Assert.DoesNotContain("owner-notes", byAdmin);
        Assert.DoesNotContain("bugInbox", byAdmin);
        Assert.Contains("owner-notes", json);
        Assert.Contains("\"bugInbox\":\"gm-screen\"", json.Replace(" ", ""));

        var template = ServerTemplates.Parse(json, "export.json");
        Assert.Equal(2, template.Version); // nothing from format 3 in it
        Assert.Contains(template.AllChannels, c => c.Name == "campaign-notes" && c.Kind == "docs" && c.Overrides.Single().Role == "Game master");
        Assert.Contains(template.AllChannels, c => c.Name == "Music room" && c.Hifi);
        Assert.Equal(["invite", "events", "pin"], template.BuiltinRoles["member"].Abilities);
        Assert.Equal("all", template.Settings!.NotifyDefault);
        Assert.Equal(["dice"], template.Settings.BuiltinBots);

        // And it starts a new server that looks the same.
        using var world = World.OpenOrCreate(Path.Combine(_path, "copy"));
        world.UpdateSettings(w => w with { BugInbox = new BugInboxConfig { Accept = true } });
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.Apply(world, template, "export.json", 1000));
        Assert.Equal(server.World.Store.AllChannels().Select(c => (c.Name, c.Kind, c.ReadRole, c.WriteRole, c.Overrides.Length)).Order(),
            world.Store.AllChannels().Select(c => (c.Name, c.Kind, c.ReadRole, c.WriteRole, c.Overrides.Length)).Order());
        Assert.Equal(server.World.Store.AllRoles().Select(r => (r.Name, r.Perms, r.Color)), world.Store.AllRoles().Select(r => (r.Name, r.Perms, r.Color)));
        Assert.Equal(server.World.Store.ChangedBasePowers(), world.Store.ChangedBasePowers());
        Assert.Equal("all", world.Store.NotifyDefault());
        Assert.Equal(new BugInboxSettings(true, world.Store.AllChannels().Single(c => c.Name == "gm-screen").Id), world.Store.GetBugInbox());
    }

    private static string ReviewTemplate()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "server", "templates", "review.json"))) dir = Path.GetDirectoryName(dir);
        return Path.Combine(dir ?? throw new FileNotFoundException("server/templates/review.json"), "server", "templates", "review.json");
    }

    [Fact]
    public void Adding_a_template_to_a_server_in_use_only_adds_and_twice_adds_nothing()
    {
        using var world = World.OpenOrCreate(_path);
        ServerTemplates.Apply(world, ServerTemplates.Load("friends"), "friends", 1000);
        var store = world.Store;
        store.AddMember("owner-key", "Owner", "owner", 1000);
        var general = store.AllChannels().Single(c => c.Name == "general");
        var hello = store.AddMessage(general.Id, "owner-key", "hello", 1100);
        var quiet = store.AllChannels().Single(c => c.Name == "Quiet corner");
        store.UpdateChannel(quiet with { Name = "Quiet corner", WriteRole = "trusted" }); // a change the template must keep
        var before = store.AllChannels();
        var rolesBefore = store.AllRoles();
        var review = ServerTemplates.Load(ReviewTemplate());

        // Dry run: says what it would add, changes nothing.
        var plan = ServerTemplates.Merge(world, review, apply: false, 2000);
        Assert.Contains("text channel gaming in Chat", plan);
        Assert.Contains("category Try things", plan);
        Assert.Contains("default notifications: mentions", plan);
        // Channels it has get only their starting content (topics here), never a second channel.
        Assert.Contains("topic for #general", plan);
        Assert.Contains("topic for Hangout", plan);
        Assert.DoesNotContain(plan, p => p.Contains("channel general ") || p.EndsWith("channel general in Chat"));
        Assert.DoesNotContain(plan, p => p.Contains("channel Hangout") || p.Contains("Quiet corner") || p.Contains("role Moderator") || p.StartsWith("AFK"));
        Assert.Equal(before.Count, store.AllChannels().Count);
        Assert.Null(store.NotifyDefault());

        // Apply: everything new is there, everything old is as it was.
        Assert.Equal(plan, ServerTemplates.Merge(world, review, apply: true, 3000));
        var after = store.AllChannels();
        Assert.All(before, b => Assert.Contains(after, a => a.Id == b.Id && a.Name == b.Name && a.Kind == b.Kind && a.ReadRole == b.ReadRole
            && a.WriteRole == b.WriteRole && a.CategoryId == b.CategoryId));
        Assert.Equal("trusted", store.GetChannel(quiet.Id)!.WriteRole);
        Assert.Equal(4, store.UserLimit(quiet.Id));
        Assert.Single(after, c => c.Name == "general");
        Assert.Single(after, c => c.Name == "Hangout");
        Assert.Single(after, c => c.Name == "AFK");
        Assert.Equal(rolesBefore.Select(r => (r.Id, r.Name, r.Perms)), store.AllRoles().Select(r => (r.Id, r.Name, r.Perms)));
        Assert.Equal("hello", store.GetMessage(hello.Id)!.Text);
        Assert.NotNull(store.GetMember("owner-key"));
        var byName = after.ToDictionary(c => c.Name);
        Assert.Equal(2, store.UserLimit(byName["Duo"].Id));
        Assert.True(store.IsHifi(byName["Music lounge"].Id));
        Assert.Equal(10, store.Slowmode(byName["introductions"].Id));
        Assert.Equal("admin", byName["announcements"].WriteRole);
        Assert.Equal("stage", byName["town-hall"].Kind);
        Assert.Equal("docs", byName["testing-guide"].Kind);
        Assert.Equal("hello", store.History(general.Id, null, null, 10).Single().Text); // #general's messages untouched
        Assert.StartsWith("Talk about anything", store.Topic(general.Id));
        Assert.Equal(3600, store.ChannelTimer(byName["disappearing"].Id)!.Seconds);
        Assert.True(world.Settings.Translate.Offer);
        Assert.Equal("mentions", store.NotifyDefault());
        Assert.Equal(["dice", "polls", "reminders"], store.BuiltinBots().Select(b => b.Id).Order());
        Assert.Equal(store.AllChannels().Single(c => c.Name == "AFK").Id, store.Afk().ChannelId); // the friends one, kept

        // Again: nothing to add.
        var count = store.AllChannels().Count;
        Assert.Empty(ServerTemplates.Merge(world, review, apply: true, 4000));
        Assert.Equal(count, store.AllChannels().Count);
    }

    [Fact]
    public void The_command_refuses_while_the_server_runs_and_dry_runs_by_default()
    {
        using (var world = World.OpenOrCreate(_path)) { }
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
            var settings = Path.Combine(_path, "server.json");
            var json = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(settings))!;
            json["Port"] = port;
            File.WriteAllText(settings, json.ToJsonString());
            Assert.Equal(1, Cli.Run(["templates", "apply", _path, ReviewTemplate(), "--apply"]));
        }
        finally
        {
            listener.Stop();
        }
        Assert.Equal(0, Cli.Run(["templates", "apply", _path, ReviewTemplate()]));
        using (var world = World.OpenOrCreate(_path)) Assert.Single(world.Store.AllChannels()); // dry run
        Assert.Equal(0, Cli.Run(["templates", "apply", _path, ReviewTemplate(), "--apply"]));
        using (var world = World.OpenOrCreate(_path)) Assert.Equal(25, world.Store.AllChannels().Count);
    }
}
