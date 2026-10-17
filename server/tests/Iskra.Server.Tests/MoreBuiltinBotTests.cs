using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Built-in bots Starboard, Birthdays and Welcome: settings, the starboard's rules, birthdays once a year, welcomes.</summary>
public class MoreBuiltinBotTests
{
    /// <summary>The timer is off: tests tick by hand. Welcomes gather for a long time unless a test flushes them.</summary>
    private static IskraServer Server() => new() { Settings = { ["BuiltinBots:TickMs"] = "0", ["BuiltinBots:WelcomeWindowMs"] = "3600000" } };

    private static BuiltinBotRuntime Runtime(IskraServer server) => server.Services.GetRequiredService<BuiltinBotRuntime>();

    private static async Task<string> TurnOn(User admin, string bot)
    {
        var reply = await admin.RequestAsync("builtin.bots.set", new { bot, enabled = true });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("bots").EnumerateArray().Single(b => b.GetProperty("id").GetString() == bot).GetProperty("accountKey").GetString()!;
    }

    private static async Task<JsonElement> Configure(User admin, object body)
    {
        var reply = await admin.RequestAsync("builtin.bots.config.set", body);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("config");
    }

    private static async Task<long> Say(User user, long channelId, string text)
    {
        var reply = await user.RequestAsync("chat.send", new { channelId, text });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("message").GetProperty("id").GetInt64();
    }

    private static async Task Star(User user, long id, bool on = true, string emoji = "⭐") =>
        Assert.Equal("result", (await user.RequestAsync("chat.react", new { id, emoji, on })).Type());

    private static List<Message> Posts(IskraServer server, long channelId, string author) =>
        server.World.Store.History(channelId, null, null, 100).Where(m => m.AuthorKey == author).ToList();

    private static JsonElement Builtin(IskraServer server, Message m) => JsonDocument.Parse(server.World.Store.GetBuiltinReply(m.Id)!).RootElement.Clone();

    private static async Task<long> Channel(User admin, string name, string readRole = "member", string? writeRole = null)
    {
        var reply = await admin.RequestAsync("channel.create", writeRole is null ? new { name, readRole } : (object)new { name, readRole, writeRole });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("channel").GetProperty("id").GetInt64();
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task Admins_turn_them_on_and_change_their_settings_and_nobody_else_can()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        var listed = alice.Welcome.Body().GetProperty("builtinBots").EnumerateArray().Select(b => b.GetProperty("id").GetString());
        Assert.Equal(["dice", "polls", "reminders", "starboard", "birthdays", "welcome"], listed);

        Assert.Equal("forbidden", (await alice.RequestAsync("builtin.bots.set", new { bot = "starboard", enabled = true })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("builtin.bots.config.get", new { bot = "starboard" })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("builtin.bots.config.set", new { bot = "welcome", message = "hi" })).ErrorCode());
        Assert.Equal("builtin_bot_no_settings", ErrorKey(await admin.RequestAsync("builtin.bots.config.get", new { bot = "dice" })));

        // Turned on, Starboard gets a #starboard everyone reads and only admins write; the bot has no commands.
        var key = await TurnOn(admin, "starboard");
        var board = server.World.Store.AllChannels().Single(c => c.Name == "starboard");
        Assert.Equal(("member", "admin"), (board.ReadRole, board.WriteRole));
        var config = (await admin.RequestAsync("builtin.bots.config.get", new { bot = "starboard" })).Body().GetProperty("config");
        Assert.Equal(board.Id, config.GetProperty("channelId").GetInt64());
        Assert.Equal("⭐", config.GetProperty("emoji").GetString());
        Assert.Equal(3, config.GetProperty("threshold").GetInt32());
        var joined = alice.Welcome; // (the member list now has the bot)
        Assert.Equal("starboard", server.World.Store.BuiltinIdOf(key));
        // Turned off and on again: the same channel, no second one.
        await admin.RequestAsync("builtin.bots.set", new { bot = "starboard", enabled = false });
        Assert.Equal(key, await TurnOn(admin, "starboard"));
        Assert.Single(server.World.Store.AllChannels(), c => c.Name == "starboard");

        // Validation.
        Assert.Equal("builtin_bot_emoji", ErrorKey(await admin.RequestAsync("builtin.bots.config.set", new { bot = "starboard", emoji = "not an emoji at all" })));
        Assert.Equal("bad_request", (await admin.RequestAsync("builtin.bots.config.set", new { bot = "starboard", threshold = 0 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("builtin.bots.config.set", new { bot = "starboard", threshold = 51 })).ErrorCode());
        Assert.Equal("builtin_bot_time", ErrorKey(await admin.RequestAsync("builtin.bots.config.set", new { bot = "birthdays", time = "25:00" })));
        Assert.Equal("bad_request", (await admin.RequestAsync("builtin.bots.config.set", new { bot = "birthdays", timeZone = "Mars/Olympus" })).ErrorCode());
        Assert.Equal("builtin_bot_template", ErrorKey(await admin.RequestAsync("builtin.bots.config.set", new { bot = "welcome", message = new string('a', 1001) })));
        Assert.Equal("not_found", (await admin.RequestAsync("builtin.bots.config.set", new { bot = "welcome", channelId = 999_999 })).ErrorCode());
        var lounge = (await admin.RequestAsync("channel.create", new { name = "lounge", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("builtin_bot_channel", ErrorKey(await admin.RequestAsync("builtin.bots.config.set", new { bot = "welcome", channelId = lounge })));

        config = await Configure(admin, new { bot = "starboard", emoji = "🔥", threshold = 2 });
        Assert.Equal("🔥", config.GetProperty("emoji").GetString());
        Assert.Equal(2, config.GetProperty("threshold").GetInt32());
        config = await Configure(admin, new { bot = "birthdays", time = "08:30", timeZone = "Europe/Stockholm", channelId = server.General });
        Assert.Equal("08:30", config.GetProperty("time").GetString());
        Assert.Equal("Europe/Stockholm", config.GetProperty("timeZone").GetString());
        Assert.False(string.IsNullOrEmpty(config.GetProperty("serverTimeZone").GetString()));
        config = await Configure(admin, new { bot = "welcome", message = "Hi {name}!", privateMessage = "Read #rules" });
        Assert.Equal("Hi {name}!", config.GetProperty("message").GetString());

        // Every change is in the audit log, by field, never the text itself.
        var audit = (await admin.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray()
            .Where(e => e.GetProperty("action").GetString() == "builtin.bot.config").ToList();
        Assert.Equal(3, audit.Count);
        Assert.DoesNotContain("Read #rules", string.Join("", audit.Select(a => a.GetRawText())));
        _ = joined;
    }

    private static string? ErrorKey(JsonElement reply) =>
        reply.GetProperty("body").TryGetProperty("key", out var key) ? key.GetString() : null;

    // ── Starboard ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Three_stars_from_others_put_a_message_on_the_board_and_the_card_keeps_up()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var bot = await TurnOn(admin, "starboard");
        var dice = await TurnOn(admin, "dice");
        var board = server.World.Store.AllChannels().Single(c => c.Name == "starboard").Id;

        var message = await Say(alice, server.General, "the pizza **was** great\nreally");
        // Alice's own star and a bot's don't count.
        await Star(alice, message);
        server.World.Store.SetReaction(message, dice, "⭐", true, 1);
        await Star(bob, message);
        await Star(bob, message, emoji: "👍"); // another emoji doesn't count either
        Assert.Empty(Posts(server, board, bot));
        await Star(carol, message);
        Assert.Empty(Posts(server, board, bot));
        await Star(admin, message);

        var card = Assert.Single(Posts(server, board, bot));
        var reply = Builtin(server, card);
        Assert.Equal("star", reply.GetProperty("kind").GetString());
        Assert.Equal(alice.Key, reply.GetProperty("for").GetString());
        Assert.Equal(3, reply.GetProperty("count").GetInt32());
        Assert.Equal(message, reply.GetProperty("messageId").GetInt64());
        Assert.Equal(server.General, reply.GetProperty("channelId").GetInt64());
        Assert.Equal("the pizza **was** great really", reply.GetProperty("excerpt").GetString());
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("image").ValueKind);
        Assert.Equal("⭐ 3 · Alice in #general: the pizza **was** great really", card.Text);

        // Below the threshold again: the card stays, with the new count; nothing new is posted.
        await Star(carol, message, on: false);
        var edited = (await bob.EventAsync("chat.edited")).Body().GetProperty("message");
        Assert.Equal(card.Id, edited.GetProperty("id").GetInt64());
        Assert.Equal(2, edited.GetProperty("builtin").GetProperty("count").GetInt32());
        await Star(carol, message);
        Assert.Equal(3, Builtin(server, Assert.Single(Posts(server, board, bot))).GetProperty("count").GetInt32());

        // Stars on the card itself, and on bots' messages, never make cards.
        await Star(bob, card.Id);
        await Star(carol, card.Id);
        await Star(admin, card.Id);
        Assert.Single(Posts(server, board, bot));

        // An edit of the original shows on the card; deleting it takes the card along.
        Assert.Equal("result", (await alice.RequestAsync("chat.edit", new { id = message, text = "the tacos were better" })).Type());
        Assert.Equal("the tacos were better", Builtin(server, Assert.Single(Posts(server, board, bot))).GetProperty("excerpt").GetString());
        Assert.Equal("result", (await alice.RequestAsync("chat.delete", new { id = message })).Type());
        while (true)
        {
            var gone = (await bob.EventAsync("chat.deleted")).Body();
            if (gone.GetProperty("id").GetInt64() == card.Id)
            {
                Assert.Equal(board, gone.GetProperty("channelId").GetInt64());
                break;
            }
        }
        Assert.Empty(Posts(server, board, bot));
        Assert.Null(server.World.Store.GetStarboardCard(message));
    }

    [Fact]
    public async Task A_card_a_moderator_deleted_stays_gone_and_a_deleted_original_takes_its_card_any_way_it_goes()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bot = await TurnOn(admin, "starboard");
        var board = server.World.Store.AllChannels().Single(c => c.Name == "starboard").Id;
        await Configure(admin, new { bot = "starboard", threshold = 1 });

        var first = await Say(alice, server.General, "one");
        await Star(bob, first);
        var card = Assert.Single(Posts(server, board, bot));
        Assert.Equal("result", (await admin.RequestAsync("chat.delete", new { id = card.Id })).Type());
        await Star(admin, first);
        Assert.Empty(Posts(server, board, bot));

        // Retention, disappearing messages and account deletion delete in the database: the card goes with it.
        var second = await Say(alice, server.General, "two");
        await Star(bob, second);
        Assert.Single(Posts(server, board, bot));
        server.World.Store.DeleteMessage(second);
        Assert.Empty(Posts(server, board, bot));
    }

    [Fact]
    public async Task Messages_from_channels_more_private_than_the_board_never_reach_it()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var tina = await server.JoinAsync("Tina", "trusted");
        using var tom = await server.JoinAsync("Tom", "trusted");
        using var alice = await server.JoinAsync("Alice");
        var bot = await TurnOn(admin, "starboard");
        var board = server.World.Store.AllChannels().Single(c => c.Name == "starboard");
        await Configure(admin, new { bot = "starboard", threshold = 1 });
        var starboardBot = server.World.Store.GetMember(bot)!;

        // A trusted-only channel: the board is read by members, so nothing from there goes on it.
        var lounge = await Channel(admin, "trusted-lounge", readRole: "trusted");
        // The bot can't see it either unless given trusted; even then the rule holds.
        await admin.RequestAsync("member.setRole", new { accountKey = bot, role = "trusted" });
        var secret = await Say(tina, lounge, "secret plans");
        await Star(tom, secret);
        Assert.Empty(Posts(server, board.Id, bot));
        Assert.False(StarboardBot.MayFeature(server.World.Store, server.World.Store.GetMember(bot)!, server.World.Store.GetChannel(lounge)!, board));

        // A members' channel with an override hiding it from a role: skipped too.
        var role = (await admin.RequestAsync("role.create", new { name = "Muted" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        var hidden = await Channel(admin, "no-muted");
        Assert.Equal("result", (await admin.RequestAsync("channel.overrides.set", new { id = hidden, roleId = role, deny = new[] { "view" } })).Type());
        var quiet = await Say(alice, hidden, "not for everyone");
        await Star(tom, quiet);
        Assert.Empty(Posts(server, board.Id, bot));

        // An ordinary members' channel works.
        var fine = await Say(alice, server.General, "public news");
        await Star(tom, fine);
        Assert.Single(Posts(server, board.Id, bot));

        // A board some role is let into must only show channels that role can read.
        var vip = (await admin.RequestAsync("role.create", new { name = "Guests VIP" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        var open = await Channel(admin, "open");
        var store = server.World.Store;
        Assert.True(StarboardBot.MayFeature(store, store.GetMember(bot)!, store.GetChannel(open)!, store.GetChannel(board.Id)!));
        Assert.Equal("result", (await admin.RequestAsync("channel.overrides.set", new { id = board.Id, roleId = vip, allow = new[] { "view" } })).Type());
        Assert.False(StarboardBot.MayFeature(store, store.GetMember(bot)!, store.GetChannel(open)!, store.GetChannel(board.Id)!));
        Assert.Equal("result", (await admin.RequestAsync("channel.overrides.set", new { id = open, roleId = vip, allow = new[] { "view" } })).Type());
        Assert.True(StarboardBot.MayFeature(store, store.GetMember(bot)!, store.GetChannel(open)!, store.GetChannel(board.Id)!));

        _ = starboardBot;
    }

    [Fact]
    public async Task The_bot_stays_out_of_channels_it_cant_see()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bot = await TurnOn(admin, "starboard");
        await Configure(admin, new { bot = "starboard", threshold = 1 });
        var board = server.World.Store.AllChannels().Single(c => c.Name == "starboard").Id;

        // An admin hides the board from the bot: it stays quiet.
        var role = (await admin.RequestAsync("role.create", new { name = "Bots" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        Assert.Equal("result", (await admin.RequestAsync("member.roles.set", new { accountKey = bot, roles = new[] { role } })).Type());
        Assert.Equal("result", (await admin.RequestAsync("channel.overrides.set", new { id = board, roleId = role, deny = new[] { "view" } })).Type());
        var message = await Say(alice, server.General, "hello");
        await Star(bob, message);
        Assert.Empty(Posts(server, board, bot));
    }

    // ── Birthdays ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Birthdays_are_opt_in_day_and_month_only_and_go_with_the_member()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        Assert.Equal("birthdays_off", ErrorKey(await alice.RequestAsync("birthday.set", new { month = 3, day = 14 })));
        var bot = await TurnOn(admin, "birthdays");
        Assert.Equal("birthday_date", ErrorKey(await alice.RequestAsync("birthday.set", new { month = 2, day = 30 })));
        Assert.Equal("result", (await alice.RequestAsync("birthday.set", new { month = 2, day = 29 })).Type());
        Assert.Equal(JsonValueKind.Null, (await bob.RequestAsync("birthday.get")).Body().GetProperty("birthday").ValueKind);
        var mine = (await alice.RequestAsync("birthday.get")).Body().GetProperty("birthday");
        Assert.Equal((2, 29), (mine.GetProperty("month").GetInt32(), mine.GetProperty("day").GetInt32()));
        Assert.Null(server.World.Store.GetBirthday(bob.Key)); // nothing kept for people who didn't opt in

        // /birthday: private answers only.
        await Say(bob, server.General, "/birthday set 14th of March");
        var answer = (await bob.EventAsync("interaction.response")).Body();
        Assert.Equal(bot, answer.GetProperty("bot").GetString());
        Assert.Equal("birthday.set", answer.GetProperty("builtin").GetProperty("kind").GetString());
        Assert.Equal(3, answer.GetProperty("builtin").GetProperty("month").GetInt32());
        Assert.Equal(14, server.World.Store.GetBirthday(bob.Key)!.Day);
        await Say(bob, server.General, "/birthday set banana");
        Assert.Equal("birthday.usage", (await bob.EventAsync("interaction.response")).Body().GetProperty("builtin").GetProperty("kind").GetString());
        await Say(bob, server.General, "/birthday list");
        var list = (await bob.EventAsync("interaction.response")).Body().GetProperty("builtin");
        Assert.Equal("birthday.list", list.GetProperty("kind").GetString());
        Assert.Equal(0, server.World.Store.History(server.General, null, null, 100).Count(m => m.AuthorKey == bot)); // nothing public

        // In "Download my data".
        var data = await ComplianceTests.Download(server, (await alice.RequestAsync("data.export")).Body());
        var row = Assert.Single(data.GetProperty("birthday").EnumerateArray());
        Assert.Equal(29, row.GetProperty("day").GetInt32());
        Assert.DoesNotContain("year\":", row.GetRawText().Replace("last_posted_year", ""));

        // Removed by hand, or with the member.
        await Say(bob, server.General, "/birthday remove");
        Assert.Equal("birthday.removed", (await bob.EventAsync("interaction.response")).Body().GetProperty("builtin").GetProperty("kind").GetString());
        Assert.Null(server.World.Store.GetBirthday(bob.Key));
        Assert.Equal("result", (await alice.RequestAsync("member.leave")).Type());
        Assert.Null(server.World.Store.GetBirthday(alice.Key));
    }

    [Theory]
    [InlineData("14 March", 3, 14)]
    [InlineData("March 14", 3, 14)]
    [InlineData("14th of March", 3, 14)]
    [InlineData("14 mars", 3, 14)]
    [InlineData("den 1 maj", 5, 1)]
    [InlineData("14/3", 3, 14)]
    [InlineData("29.2.", 2, 29)]
    [InlineData("dec 31", 12, 31)]
    public void Birthday_dates_parse(string text, int month, int day) => Assert.Equal((month, day), BirthdayBot.ParseDate(text));

    [Theory]
    [InlineData("")]
    [InlineData("31 April")]
    [InlineData("14 March 1990")]
    [InlineData("3/14")]
    [InlineData("ma 14")]
    public void Birthday_nonsense_doesnt(string text) => Assert.Null(BirthdayBot.ParseDate(text));

    [Fact]
    public async Task A_birthday_is_announced_once_a_year_at_the_chosen_time_in_the_chosen_zone()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var bot = await TurnOn(admin, "birthdays");
        await Configure(admin, new { bot = "birthdays", channelId = server.General, time = "09:00", timeZone = "Europe/Stockholm" });
        await alice.RequestAsync("birthday.set", new { month = 3, day = 14 });
        await bob.RequestAsync("birthday.set", new { month = 3, day = 14 });
        await carol.RequestAsync("birthday.set", new { month = 3, day = 15 });
        var runtime = Runtime(server);
        List<Message> Greetings() => Posts(server, server.General, bot);

        // 08:30 in Stockholm (07:30 UTC, winter time): not yet. 09:05: Alice and Bob in one greeting, once.
        runtime.Tick(new DateTimeOffset(2027, 3, 14, 7, 30, 0, TimeSpan.Zero));
        Assert.Empty(Greetings());
        runtime.Tick(new DateTimeOffset(2027, 3, 14, 8, 5, 0, TimeSpan.Zero));
        var greeting = Assert.Single(Greetings());
        Assert.Equal("🎂 It's Alice and Bob's birthday today!", greeting.Text);
        var people = Builtin(server, greeting).GetProperty("people").EnumerateArray().Select(p => p.GetString()).ToHashSet();
        Assert.Equal([alice.Key, bob.Key], people);
        runtime.Tick(new DateTimeOffset(2027, 3, 14, 20, 0, 0, TimeSpan.Zero));
        Assert.Single(Greetings());

        // Changing the date doesn't give a second greeting the same year.
        await alice.RequestAsync("birthday.set", new { month = 3, day = 15 });
        // Late evening on the 14th UTC is already the 15th in Tokyo, but this server's zone is Stockholm.
        runtime.Tick(new DateTimeOffset(2027, 3, 14, 23, 30, 0, TimeSpan.Zero)); // 00:30 on the 15th in Stockholm: before 09:00
        Assert.Single(Greetings());
        runtime.Tick(new DateTimeOffset(2027, 3, 15, 9, 0, 0, TimeSpan.Zero));
        Assert.Equal(2, Greetings().Count);
        Assert.Equal("🎂 It's Carol's birthday today!", Greetings()[^1].Text);

        // Next year, again.
        runtime.Tick(new DateTimeOffset(2028, 3, 14, 8, 5, 0, TimeSpan.Zero));
        Assert.Equal("🎂 It's Bob's birthday today!", Greetings()[^1].Text);
        runtime.Tick(new DateTimeOffset(2028, 3, 15, 8, 5, 0, TimeSpan.Zero));
        Assert.Equal("🎂 It's Alice and Carol's birthday today!", Greetings()[^1].Text);

        // Turned off: quiet.
        await admin.RequestAsync("builtin.bots.set", new { bot = "birthdays", enabled = false });
        runtime.Tick(new DateTimeOffset(2029, 3, 14, 10, 0, 0, TimeSpan.Zero));
        Assert.Equal(4, Greetings().Count);
    }

    [Fact]
    public void Leap_day_birthdays_fall_on_the_28th_in_other_years()
    {
        Assert.Equal(new DateOnly(2027, 2, 28), BirthdayBot.NextOccurrence(2, 29, new DateOnly(2027, 1, 10)));
        Assert.Equal(new DateOnly(2028, 2, 29), BirthdayBot.NextOccurrence(2, 29, new DateOnly(2028, 2, 1)));
        Assert.Equal(new DateOnly(2028, 3, 14), BirthdayBot.NextOccurrence(3, 14, new DateOnly(2027, 3, 15)));
    }

    // ── Welcome ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task Newcomers_are_welcomed_with_the_admins_text_and_privately()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        var bot = await TurnOn(admin, "welcome");
        await Configure(admin, new { bot = "welcome", message = "Hi {name}, welcome to **{server}**! You're number {memberCount}.", privateMessage = "Psst {name}, read the rules." });

        using var alice = await server.JoinAsync("Alice");
        var welcome = Assert.Single(Posts(server, server.General, bot));
        var people = server.World.Store.CountPeople();
        Assert.Equal($"Hi <@{alice.Key}>, welcome to **{server.World.Settings.Name}**! You're number {people}.", welcome.Text);
        var reply = Builtin(server, welcome);
        Assert.Equal("welcome", reply.GetProperty("kind").GetString());
        Assert.Equal(alice.Key, reply.GetProperty("for").GetString());
        Assert.Equal(welcome.Text, reply.GetProperty("text").GetString());

        // The private welcome reaches Alice alone once she's online.
        Runtime(server).Tick();
        var card = (await alice.EventAsync("interaction.response")).Body();
        Assert.Equal("welcome.private", card.GetProperty("builtin").GetProperty("kind").GetString());
        Assert.Equal($"Psst <@{alice.Key}>, read the rules.", card.GetProperty("text").GetString());
        await admin.NoEventAsync("interaction.response");

        // The default greeting, worded by apps.
        await Configure(admin, new { bot = "welcome", message = "" });
        Runtime(server).Tick(DateTimeOffset.UtcNow.AddHours(2), forceWelcome: true);
        using var bob = await server.JoinAsync("Bob");
        Runtime(server).Tick(forceWelcome: true);
        var last = Posts(server, server.General, bot)[^1];
        Assert.Equal(JsonValueKind.Null, Builtin(server, last).GetProperty("text").ValueKind);
        Assert.Equal(bob.Key, Builtin(server, last).GetProperty("for").GetString());
    }

    [Fact]
    public async Task A_burst_of_joins_gets_one_line_instead_of_one_post_each()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        var bot = await TurnOn(admin, "welcome");
        using var first = await server.JoinAsync("First");
        Assert.Single(Posts(server, server.General, bot));

        var raid = new List<User>();
        for (var i = 0; i < 12; i++) raid.Add(await server.JoinAsync($"Raider{i}"));
        Assert.Single(Posts(server, server.General, bot)); // gathered, not posted

        Runtime(server).Tick(DateTimeOffset.UtcNow); // the window hasn't passed
        Assert.Single(Posts(server, server.General, bot));
        Runtime(server).Tick(forceWelcome: true);
        var posts = Posts(server, server.General, bot);
        Assert.Equal(2, posts.Count);
        var batch = Builtin(server, posts[1]);
        Assert.Equal("welcome.batch", batch.GetProperty("kind").GetString());
        Assert.Equal(12, batch.GetProperty("count").GetInt32());
        Assert.Equal(BuiltinBotRuntime.MaxBatchNames, batch.GetProperty("people").GetArrayLength());
        Assert.StartsWith("👋 12 people joined: Raider0, Raider1", posts[1].Text);
        Assert.EndsWith("and 2 more. Welcome!", posts[1].Text);
        foreach (var u in raid) u.Dispose();
    }

    [Fact]
    public async Task People_are_welcomed_when_they_actually_get_in()
    {
        using var server = Server();
        using var owner = await server.JoinAsync("Owner", "owner");
        var bot = await TurnOn(owner, "welcome");
        Assert.Empty(Posts(server, server.General, bot)); // nobody greets the owner (or bots)

        // An approval invite: greeted when a moderator lets them in, not while they wait.
        var code = (await owner.RequestAsync("invite.create", new { approve = true })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        using var sam = new TestIdentity();
        using (var client = await server.ConnectAsync())
            Assert.Equal("join_pending", (await client.LoginAsync(sam, "Sam", code)).ErrorCode());
        Assert.Empty(Posts(server, server.General, bot));
        Assert.Equal("result", (await owner.RequestAsync("join.approve", new { accountKey = sam.AccountKey })).Type());
        Assert.Equal(sam.AccountKey, Builtin(server, Assert.Single(Posts(server, server.General, bot))).GetProperty("for").GetString());

        // Rules to agree to: greeted once they agree (and only the first time).
        Assert.Equal("result", (await owner.RequestAsync("rules.update", new { text = "Be kind.", required = true })).Type());
        Runtime(server).Tick(forceWelcome: true);
        using var newbie = await server.JoinAsync("Newbie");
        Runtime(server).Tick(forceWelcome: true);
        Assert.Single(Posts(server, server.General, bot));
        Assert.Equal("result", (await newbie.RequestAsync("rules.accept", new { version = 1 })).Type());
        Runtime(server).Tick(forceWelcome: true);
        var posts = Posts(server, server.General, bot);
        Assert.Equal(2, posts.Count);
        Assert.Equal(newbie.Key, Builtin(server, posts[1]).GetProperty("for").GetString());
        Assert.Equal("result", (await owner.RequestAsync("rules.update", new { text = "Be kinder.", required = true, reaccept = true })).Type());
        Assert.Equal("result", (await newbie.RequestAsync("rules.accept", new { version = 2 })).Type());
        Runtime(server).Tick(forceWelcome: true);
        Assert.Equal(2, Posts(server, server.General, bot).Count);
    }

    [Fact]
    public async Task Welcome_stays_quiet_in_channels_it_cant_see_and_when_off()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        var bot = await TurnOn(admin, "welcome");
        var staff = await Channel(admin, "staff", readRole: "admin");
        await Configure(admin, new { bot = "welcome", channelId = staff });
        using var alice = await server.JoinAsync("Alice");
        Assert.Empty(Posts(server, staff, bot));

        await Configure(admin, new { bot = "welcome", channelId = server.General });
        await admin.RequestAsync("builtin.bots.set", new { bot = "welcome", enabled = false });
        using var bob = await server.JoinAsync("Bob");
        Runtime(server).Tick(forceWelcome: true);
        Assert.Empty(Posts(server, server.General, bot));
    }
}
