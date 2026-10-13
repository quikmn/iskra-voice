using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

/// <summary>Built-in bots: Dice, Polls and Reminders, run by the server and switched on by an admin.</summary>
public class BuiltinBotTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task<string> TurnOn(User admin, string bot)
    {
        var reply = await admin.RequestAsync("builtin.bots.set", new { bot, enabled = true });
        Assert.Equal("result", reply.Type());
        var row = reply.Body().GetProperty("bots").EnumerateArray().Single(b => b.GetProperty("id").GetString() == bot);
        Assert.True(row.GetProperty("enabled").GetBoolean());
        return row.GetProperty("accountKey").GetString()!;
    }

    private static async Task<long> Say(User user, long channelId, string text)
    {
        var reply = await user.RequestAsync("chat.send", new { channelId, text });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("message").GetProperty("id").GetInt64();
    }

    /// <summary>The next chat message from <paramref name="author"/> (skipping everyone else's).</summary>
    private static async Task<JsonElement> From(User watcher, string author)
    {
        while (true)
        {
            var message = (await watcher.EventAsync("chat.message")).Body().GetProperty("message");
            if (message.GetProperty("author").GetString() == author) return message;
        }
    }

    /// <summary>Sends <paramref name="text"/> and checks the bot stays quiet (a ping from the watcher marks the end).</summary>
    private static async Task Quiet(User sender, User watcher, long channelId, string text, string bot)
    {
        var command = await Say(sender, channelId, text);
        var marker = await Say(watcher, channelId, "marker");
        while (true)
        {
            var message = (await watcher.EventAsync("chat.message")).Body().GetProperty("message");
            if (message.GetProperty("id").GetInt64() > command) Assert.NotEqual(bot, message.GetProperty("author").GetString());
            if (message.GetProperty("id").GetInt64() == marker) return;
        }
    }

    // ── On and off ───────────────────────────────────────────────────────────

    [Fact]
    public async Task An_admin_turns_a_bot_on_and_everyone_sees_a_built_in_bot_member()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        var listed = alice.Welcome.Body().GetProperty("builtinBots");
        Assert.Equal(["dice", "polls", "reminders"], listed.EnumerateArray().Select(b => b.GetProperty("id").GetString()));
        Assert.All(listed.EnumerateArray(), b => Assert.False(b.GetProperty("enabled").GetBoolean()));

        var key = await TurnOn(admin, "dice");
        var joined = (await alice.EventAsync("member.joined")).Body().GetProperty("member");
        Assert.Equal(key, joined.GetProperty("accountKey").GetString());
        Assert.Equal("Dice", joined.GetProperty("name").GetString());
        Assert.True(joined.GetProperty("bot").GetBoolean());
        Assert.Equal("dice", joined.GetProperty("builtin").GetString());
        Assert.True(joined.GetProperty("online").GetBoolean());
        var commands = (await alice.EventAsync("bot.commands")).Body();
        Assert.Equal(key, commands.GetProperty("bot").GetString());
        Assert.Equal("roll", commands.GetProperty("commands")[0].GetProperty("name").GetString());
        var changed = (await alice.EventAsync("builtin.bots")).Body().GetProperty("bots");
        Assert.True(changed[0].GetProperty("enabled").GetBoolean());

        // Newcomers see it in welcome: listed, as a member, with its commands; and it answers in #general.
        using var bob = await server.JoinAsync("Bob");
        var welcome = bob.Welcome.Body();
        Assert.True(welcome.GetProperty("builtinBots")[0].GetProperty("enabled").GetBoolean());
        var member = welcome.GetProperty("members").EnumerateArray().Single(m => m.GetProperty("accountKey").GetString() == key);
        Assert.Equal("dice", member.GetProperty("builtin").GetString());
        Assert.True(member.GetProperty("online").GetBoolean());
        Assert.Equal(JsonValueKind.Null, welcome.GetProperty("members").EnumerateArray()
            .Single(m => m.GetProperty("accountKey").GetString() == bob.Key).GetProperty("builtin").ValueKind);
        Assert.Contains(welcome.GetProperty("botCommands").EnumerateArray(), c => c.GetProperty("bot").GetString() == key);
        Assert.Equal([key], (await bob.RequestAsync("bot.commands.available", new { channelId = server.General })).Body()
            .GetProperty("bots").EnumerateArray().Select(b => b.GetString()));

        // Turning it on again changes nothing.
        Assert.Equal(key, await TurnOn(admin, "dice"));
        await alice.NoEventAsync("builtin.bots");
    }

    [Fact]
    public async Task Turning_a_bot_off_removes_it_and_on_again_brings_back_the_same_one()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var key = await TurnOn(admin, "dice");
        await Say(alice, server.General, "/roll d20");
        var answer = await From(alice, key);
        await alice.EventAsync("builtin.bots"); // the one from turning it on

        var off = await admin.RequestAsync("builtin.bots.set", new { bot = "dice", enabled = false });
        Assert.False(off.Body().GetProperty("bots")[0].GetProperty("enabled").GetBoolean());
        Assert.Equal(key, (await alice.EventAsync("member.removed")).Body().GetProperty("accountKey").GetString());
        Assert.False((await alice.EventAsync("builtin.bots")).Body().GetProperty("bots")[0].GetProperty("enabled").GetBoolean());
        Assert.Null(server.World.Store.GetMember(key));
        Assert.Empty(server.World.Store.AllBotCommands());
        await Quiet(alice, admin, server.General, "/roll d20", key);

        // Its old answers stay, still marked as its own; on again, it's the same identity.
        var history = (await alice.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        var old = history.EnumerateArray().Single(m => m.GetProperty("id").GetInt64() == answer.GetProperty("id").GetInt64());
        Assert.Equal("roll", old.GetProperty("builtin").GetProperty("kind").GetString());
        Assert.Equal(key, await TurnOn(admin, "dice"));
        Assert.Equal("Dice", server.World.Store.GetMember(key)!.Name);
        Assert.Single(server.World.Store.AllBotCommands());
    }

    [Fact]
    public async Task Only_admins_turn_bots_on_and_only_known_ones()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var trusted = await server.JoinAsync("Tess", "trusted");
        var refused = (await trusted.RequestAsync("builtin.bots.set", new { bot = "dice", enabled = true })).Body();
        Assert.Equal("forbidden", refused.GetProperty("code").GetString());
        Assert.Equal("builtin_bots_admin", refused.GetProperty("key").GetString());
        Assert.Equal("bad_request", (await owner.RequestAsync("builtin.bots.set", new { bot = "music", enabled = true })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("builtin.bots.set", new { bot = "dice" })).ErrorCode());
        Assert.Empty(server.World.Store.BuiltinBots());

        // Nobody can sign in as it: the private key was never kept, so the handshake can't be signed.
        var key = await TurnOn(owner, "polls");
        Assert.True(server.World.Store.IsBot(key));
        var audit = server.World.Store.Audit(null, null, null, 50).Select(a => a.Action).ToList();
        Assert.Contains("builtin.bot.on", audit);
    }

    // ── Dice ─────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Dice_rolls_and_shows_every_die()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var dice = await TurnOn(admin, "dice");

        await Say(alice, server.General, "/roll 2d6+3");
        var answer = await From(admin, dice);
        var reply = answer.GetProperty("builtin");
        Assert.Equal("dice", reply.GetProperty("bot").GetString());
        Assert.Equal("roll", reply.GetProperty("kind").GetString());
        Assert.Equal(alice.Key, reply.GetProperty("for").GetString());
        Assert.Equal("2d6+3", reply.GetProperty("expression").GetString());
        var rolls = reply.GetProperty("groups")[0].GetProperty("rolls").EnumerateArray().Select(r => r.GetInt32()).ToList();
        Assert.Equal(2, rolls.Count);
        Assert.All(rolls, r => Assert.InRange(r, 1, 6));
        Assert.Equal(rolls.Sum() + 3, reply.GetProperty("total").GetInt64());
        Assert.StartsWith("🎲 Alice rolled 2d6+3: [", answer.GetProperty("text").GetString());
        Assert.EndsWith($"= {rolls.Sum() + 3}", answer.GetProperty("text").GetString());

        // No dice given: one d6. "@Dice" picks this bot; another name doesn't.
        await Say(alice, server.General, "/roll");
        Assert.Equal("1d6", (await From(admin, dice)).GetProperty("builtin").GetProperty("expression").GetString());
        await Say(alice, server.General, "/ROLL@dice d20");
        Assert.Equal("1d20", (await From(admin, dice)).GetProperty("builtin").GetProperty("expression").GetString());
        await Quiet(alice, admin, server.General, "/roll@Other d20", dice);
        await Quiet(alice, admin, server.General, "/rolling d20", dice);
        await Quiet(alice, admin, server.General, "roll d20", dice);

        // Nonsense gets a hint, not silence.
        await Say(alice, server.General, "/roll banana");
        var hint = (await From(admin, dice)).GetProperty("builtin");
        Assert.Equal("roll.invalid", hint.GetProperty("kind").GetString());
        Assert.Equal("banana", hint.GetProperty("input").GetString());

        // "Download my data" lists the answers to your own commands.
        var export = await ComplianceTests.Download(server, (await alice.RequestAsync("data.export")).Body());
        var answers = export.GetProperty("builtinBotAnswers").EnumerateArray().ToList();
        Assert.Equal(4, answers.Count);
        Assert.Contains("\"kind\":\"roll\"", answers[0].GetProperty("reply").GetString());
        Assert.Empty((await ComplianceTests.Download(server, (await admin.RequestAsync("data.export")).Body())).GetProperty("builtinBotAnswers").EnumerateArray());

        // Ordinary messages have no `builtin`.
        var plain = await Say(alice, server.General, "hello");
        var history = (await alice.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(JsonValueKind.Null, history.EnumerateArray().Single(m => m.GetProperty("id").GetInt64() == plain).GetProperty("builtin").ValueKind);
    }

    [Theory]
    [InlineData("2d6+3", "2d6+3", 2, 3)]
    [InlineData("d20", "1d20", 1, 0)]
    [InlineData(" 1d8 + 1d6 - 1 ", "1d8+1d6-1", 2, -1)]
    [InlineData("d%", "1d100", 1, 0)]
    [InlineData("", "1d6", 1, 0)]
    [InlineData("3D4", "3d4", 3, 0)]
    [InlineData("-1d4+10", "-1d4+10", 1, 10)]
    public void Dice_notation_is_read(string input, string expression, int dice, long modifier)
    {
        var roll = BuiltinCommands.Roll(input, sides => sides);
        Assert.NotNull(roll);
        Assert.Equal(expression, roll.Expression);
        Assert.Equal(dice, roll.Groups.Sum(g => g.Count));
        Assert.Equal(modifier, roll.Modifier);
        Assert.Equal(roll.Groups.Sum(g => g.Sign * g.Count * g.Sides) + modifier, roll.Total); // every die showed its top face
    }

    [Theory]
    [InlineData("banana")]
    [InlineData("5")]
    [InlineData("2d6 3")]
    [InlineData("2d")]
    [InlineData("0d6")]
    [InlineData("1d1")]
    [InlineData("1d1001")]
    [InlineData("101d6")]
    [InlineData("60d6+50d6")]
    [InlineData("1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6")]
    [InlineData("1d6+200000")]
    [InlineData("2d6++3")]
    public void Bad_dice_notation_is_refused(string input) => Assert.Null(BuiltinCommands.Roll(input, _ => 1));

    // ── Polls ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Polls_makes_a_native_poll()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var polls = await TurnOn(admin, "polls");

        await Say(alice, server.General, "/poll Pizza or tacos? | Pizza | Tacos | Both");
        var message = await From(admin, polls);
        var poll = message.GetProperty("poll");
        Assert.Equal("Pizza or tacos?", poll.GetProperty("question").GetString());
        Assert.Equal(["Pizza", "Tacos", "Both"], poll.GetProperty("options").EnumerateArray().Select(o => o.GetProperty("text").GetString()));
        Assert.NotNull(server.World.Store.GetPoll(message.GetProperty("id").GetInt64()));
        // People vote on it like on any poll.
        Assert.Equal("result", (await alice.RequestAsync("poll.vote", new { id = message.GetProperty("id").GetInt64(), options = new[] { 1 } })).Type());

        await Say(alice, server.General, "/poll \"Movie night?\" \"Friday\" \"Saturday\"");
        Assert.Equal("Movie night?", (await From(admin, polls)).GetProperty("poll").GetProperty("question").GetString());

        await Say(alice, server.General, "/poll Just a question");
        Assert.Equal("poll.usage", (await From(admin, polls)).GetProperty("builtin").GetProperty("kind").GetString());

        await Say(alice, server.General, "/poll Q | " + string.Join(" | ", Enumerable.Range(1, 11)));
        var tooMany = (await From(admin, polls)).GetProperty("builtin");
        Assert.Equal("error", tooMany.GetProperty("kind").GetString());
        Assert.Equal("poll_answers", tooMany.GetProperty("error").GetProperty("key").GetString());

        await Say(alice, server.General, "/poll Q | Same | same");
        Assert.Equal("poll_answers_unique", (await From(admin, polls)).GetProperty("builtin").GetProperty("error").GetProperty("key").GetString());
    }

    [Fact]
    public async Task Polls_go_only_in_text_channels_and_say_so_in_threads()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var polls = await TurnOn(admin, "polls");
        var root = await Say(admin, server.General, "root");
        var thread = (await admin.RequestAsync("thread.create", new { messageId = root, name = "side" })).Body().GetProperty("thread").GetProperty("id").GetInt64();

        await Say(admin, thread, "/poll Q | A | B");
        var answer = await From(admin, polls);
        Assert.Equal(thread, answer.GetProperty("channelId").GetInt64());
        Assert.Equal("poll_channel", answer.GetProperty("builtin").GetProperty("error").GetProperty("key").GetString());
    }

    // ── Reminders ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Reminders_sets_a_personal_reminder_that_fires_like_any_other()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var reminders = await TurnOn(admin, "reminders");

        var before = Now;
        var command = await Say(alice, server.General, "/remind me in 1h30m take the pizza out");
        var set = (await alice.EventAsync("reminder.updated")).Body().GetProperty("reminder");
        Assert.Equal(command, set.GetProperty("messageId").GetInt64());
        Assert.Equal(server.General, set.GetProperty("channelId").GetInt64());
        Assert.InRange(set.GetProperty("dueAt").GetInt64(), before + 90 * 60_000, Now + 90 * 60_000);
        var data = set.GetProperty("data").GetString()!;
        Assert.StartsWith(BuiltinBotFeature.ReminderDataPrefix, data);
        Ed25519.TryFromB64u(data[BuiltinBotFeature.ReminderDataPrefix.Length..], out var about);
        var parsed = JsonDocument.Parse(about).RootElement;
        Assert.Equal("take the pizza out", parsed.GetProperty("note").GetString());
        Assert.Equal("#general", parsed.GetProperty("where").GetString());

        var answer = await From(admin, reminders);
        Assert.Equal("remind", answer.GetProperty("builtin").GetProperty("kind").GetString());
        Assert.Equal(set.GetProperty("dueAt").GetInt64(), answer.GetProperty("builtin").GetProperty("dueAt").GetInt64());
        Assert.Equal("⏰ OK Alice, I'll remind you in 1 hour 30 minutes.", answer.GetProperty("text").GetString());
        // Only the asker has it.
        Assert.Single((await alice.RequestAsync("reminder.list")).Body().GetProperty("reminders").EnumerateArray());
        Assert.Empty((await admin.RequestAsync("reminder.list")).Body().GetProperty("reminders").EnumerateArray());

        // Time's up: the ordinary reminder machinery fires it.
        var id = set.GetProperty("id").GetInt64();
        server.World.Store.UpdateReminder(id, Now - 1, data);
        server.Services.GetServices<IHostedService>().OfType<ProductivityScheduler>().Single().Tick();
        Assert.Equal(id, (await alice.EventAsync("reminder.due")).Body().GetProperty("reminder").GetProperty("id").GetInt64());

        // A client can't forge bot data: it isn't ciphertext-shaped.
        Assert.Equal("bad_request", (await alice.RequestAsync("reminder.create", new { dueAt = Now + 60_000, data })).ErrorCode());

        await Say(alice, server.General, "/remind me pizza");
        Assert.Equal("remind.usage", (await From(admin, reminders)).GetProperty("builtin").GetProperty("kind").GetString());
    }

    [Fact]
    public async Task Reminders_respects_the_per_person_limit()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var reminders = await TurnOn(admin, "reminders");
        for (var i = 0; i < ReminderFeature.MaxPerAccount; i++) server.World.Store.AddReminder(alice.Key, Now + 60_000, "x", null, null, Now);
        await Say(alice, server.General, "/remind me in 10m tea");
        Assert.Equal("reminders_max", (await From(admin, reminders)).GetProperty("builtin").GetProperty("error").GetProperty("key").GetString());
        Assert.Equal(ReminderFeature.MaxPerAccount, server.World.Store.CountReminders(alice.Key));
    }

    [Theory]
    [InlineData("me in 10m take the pizza out", 10 * 60_000L, "take the pizza out")]
    [InlineData("in 2 hours to call mom", 2 * 3_600_000L, "call mom")]
    [InlineData("me in 1h30m", 90 * 60_000L, "")]
    [InlineData("me in 1 day and 2 hours: check the oven", 26 * 3_600_000L, "check the oven")]
    [InlineData("1w about the trip", 7 * 86_400_000L, "the trip")]
    [InlineData("mig om 10 minuter att ringa mamma", 10 * 60_000L, "ringa mamma")]
    [InlineData("me in 10m 5 pizzas", 10 * 60_000L, "5 pizzas")]
    public void Reminder_times_are_read(string args, long delay, string note)
    {
        var remind = BuiltinCommands.ParseRemind(args);
        Assert.NotNull(remind);
        Assert.Equal(delay, remind.DelayMs);
        Assert.Equal(note, remind.Note);
    }

    [Theory]
    [InlineData("")]
    [InlineData("me pizza")]
    [InlineData("me in 0m pizza")]
    [InlineData("me in 400 days")]
    [InlineData("me in 10 parsecs")]
    [InlineData("me in 999999w")]
    public void Bad_reminder_times_are_refused(string args) => Assert.Null(BuiltinCommands.ParseRemind(args));

    // ── Where bots answer ────────────────────────────────────────────────────

    [Fact]
    public async Task Bots_answer_only_where_their_role_lets_them_read_and_post()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var tess = await server.JoinAsync("Tess", "trusted");
        var dice = await TurnOn(owner, "dice");
        var readOnly = server.World.Store.CreateChannel("announcements", "text", "member", "trusted", Now).Id;
        var secret = server.World.Store.CreateChannel("trusted-only", "text", "trusted", "trusted", Now).Id;

        // Dice is a member: it can read #announcements but not post there, and can't see #trusted-only.
        await Quiet(tess, owner, readOnly, "/roll", dice);
        await Quiet(tess, owner, secret, "/roll", dice);
        Assert.Empty((await tess.RequestAsync("bot.commands.available", new { channelId = secret })).Body().GetProperty("bots").EnumerateArray());

        // Made trusted, it answers in both.
        Assert.Equal("result", (await owner.RequestAsync("member.setRole", new { accountKey = dice, role = "trusted" })).Type());
        await Say(tess, secret, "/roll");
        Assert.Equal(secret, (await From(owner, dice)).GetProperty("channelId").GetInt64());

        // Timed out, it stays quiet.
        Assert.Equal("result", (await owner.RequestAsync("member.timeout", new { accountKey = dice, durationMs = 60_000 })).Type());
        await Quiet(tess, owner, server.General, "/roll", dice);
    }

    [Fact]
    public async Task Bots_never_answer_bots_and_never_in_encrypted_channels()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var dice = await TurnOn(owner, "dice");

        // Another bot saying "/roll" gets no answer (no loops between bots).
        var code = (await owner.RequestAsync("bot.invite", new { role = "member" })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        using var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, "Echo", invite: code);
        ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        using var echo = new User(identity, client, await client.ReceiveAsync());
        await Quiet(echo, owner, server.General, "/roll", dice);

        // An encrypted channel: the server can't read commands there, so no bot is offered or answers.
        var channel = server.World.Store.CreateChannel("secret", "text", "member", "member", Now);
        server.World.Store.SaveE2eeChange(new E2eeChannel(channel.Id, "chain", 1, "head", [owner.Key], Now),
            new E2eeChange(1, "{}", "sig", owner.Key, Now), [], fresh: true);
        var bot = server.World.Store.GetMember(dice)!;
        Assert.False(BuiltinBotFeature.Answers(server.World.Store, bot, channel, Now));
        Assert.True(BuiltinBotFeature.Answers(server.World.Store, bot, server.World.Store.GetChannel(server.General)!, Now));
        Assert.Empty((await owner.RequestAsync("bot.commands.available", new { channelId = channel.Id })).Body().GetProperty("bots").EnumerateArray());
        Assert.Equal("bad_request", (await owner.RequestAsync("chat.send", new { channelId = channel.Id, text = "/roll" })).ErrorCode());
    }

    [Theory]
    [InlineData("Q | A | B", "Q", new[] { "A", "B" })]
    [InlineData(" Lunch? |Sushi|  Pasta | ", "Lunch?", new[] { "Sushi", "Pasta" })]
    [InlineData("\"Q\" \"A\" “B”", "Q", new[] { "A", "B" })]
    public void Poll_text_is_read(string args, string question, string[] answers)
    {
        var poll = BuiltinCommands.ParsePoll(args);
        Assert.NotNull(poll);
        Assert.Equal(question, poll.Value.Question);
        Assert.Equal(answers, poll.Value.Answers);
    }

    [Fact]
    public void Plain_text_and_durations_read_well() =>
        Assert.Equal(["1 day 2 hours", "10 minutes", "1 hour"],
            new[] { 26 * 3_600_000L, 600_000L, 3_600_000L }.Select(BuiltinBotFeature.Duration));
}
