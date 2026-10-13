using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class InteractionTests
{
    private static async Task<User> JoinBot(IskraServer server, User admin, string name = "Dice", string role = "member", bool? readAll = null)
    {
        object request = readAll is { } all ? new { role, readAll = all } : new { role };
        var code = (await admin.RequestAsync("bot.invite", request)).Body().GetProperty("invite").GetProperty("code").GetString()!;
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, name, invite: code);
        ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        var welcome = await client.ReceiveAsync();
        Assert.Equal("welcome", welcome.Type());
        return new User(identity, client, welcome);
    }

    private static readonly object Roll = new
    {
        name = "roll", description = "Rolls dice",
        options = new object[]
        {
            new { name = "dice", description = "Which dice", type = "string", required = true,
                  choices = new object[] { new { name = "Six", value = "d6" }, new { name = "Twenty", value = "d20" } } },
            new { name = "times", description = "How often", type = "integer" },
            new { name = "secret", description = "Only you see it", type = "boolean" },
            new { name = "for", description = "Who", type = "user" },
            new { name = "where", description = "Where", type = "channel" },
            new { name = "team", description = "Which role", type = "role" },
            new { name = "bonus", description = "A bonus", type = "number" },
            new { name = "note", description = "A note", type = "string" },
        },
    };

    private static readonly object Purge = new { name = "purge", description = "Cleans up", role = "trusted", permission = "manageMessages" };

    private static async Task Register(User bot, bool interactions = true, params object[] commands)
    {
        var reply = await bot.RequestAsync("bot.commands.set", new { commands = commands.Length > 0 ? commands : [Roll, Purge], interactions });
        Assert.Equal("result", reply.Type());
    }

    private static Task<JsonElement> Invoke(User user, string bot, long channelId, string command, object? options = null, string? args = null) =>
        user.RequestAsync("interaction.invoke", new { bot, channelId, command, options, args });

    /// <summary>Lets the invoke rate limit (5, then 2 a second) refill.</summary>
    private static Task Breathe() => Task.Delay(2600);

    private static string Key(JsonElement reply) => reply.Body().TryGetProperty("key", out var key) ? key.GetString()! : "";

    // ── What a bot can read ──────────────────────────────────────────────────

    [Fact]
    public async Task By_default_a_bot_only_gets_messages_meant_for_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        await Register(bot);
        using var alice = await server.JoinAsync("Alice");

        // Everyone sees which bots can read everything.
        var listed = alice.Welcome.Body().GetProperty("members").EnumerateArray().First(m => m.GetProperty("accountKey").GetString() == bot.Key);
        Assert.False(listed.GetProperty("readsMessages").GetBoolean());
        Assert.Equal(JsonValueKind.Null, alice.Welcome.Body().GetProperty("you").GetProperty("readsMessages").ValueKind);

        async Task<long> Say(string text, long? replyTo = null) =>
            (await alice.RequestAsync("chat.send", new { channelId = server.General, text, replyTo })).Body().GetProperty("message").GetProperty("id").GetInt64();

        await Say("just chatting");
        await Say("/roll@OtherBot d6");
        await Say("/unknown thing");
        await Say($"hey <@{bot.Key}>");
        Assert.Equal($"hey <@{bot.Key}>", (await bot.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        await Say("/roll d20");
        Assert.Equal("/roll d20", (await bot.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        await Say("/ROLL@dice d6");
        Assert.Equal("/ROLL@dice d6", (await bot.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        var own = (await bot.RequestAsync("chat.send", new { channelId = server.General, text = "I am Dice" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("I am Dice", (await bot.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        await Say("thanks!", replyTo: own);
        Assert.Equal("thanks!", (await bot.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        await bot.NoEventAsync("chat.message");
        await alice.RequestAsync("chat.typing", new { channelId = server.General });
        await bot.NoEventAsync("chat.typing");

        // Reading requests are refused.
        foreach (var (type, body) in new (string, object)[]
        {
            ("chat.history", new { channelId = server.General }), ("search", new { query = "chatting" }),
            ("pin.list", new { channelId = server.General }), ("inbox.list", new { }),
        })
        {
            var reply = await bot.RequestAsync(type, body);
            Assert.Equal("forbidden", reply.ErrorCode());
            Assert.Equal("bot_no_read", Key(reply));
        }
    }

    [Fact]
    public async Task Reading_everything_is_the_admins_choice_and_can_change()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin, readAll: true);
        using var alice = await server.JoinAsync("Alice");
        Assert.True(bot.Welcome.Body().GetProperty("you").GetProperty("readsMessages").GetBoolean());

        await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hello all" });
        Assert.Equal("hello all", (await bot.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        Assert.Equal("result", (await bot.RequestAsync("chat.history", new { channelId = server.General })).Type());

        // Only admins change it; it applies at once, and everyone hears.
        Assert.Equal("forbidden", (await alice.RequestAsync("bot.scope.set", new { accountKey = bot.Key, readAll = false })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("bot.scope.set", new { accountKey = alice.Key, readAll = false })).ErrorCode());
        var set = await admin.RequestAsync("bot.scope.set", new { accountKey = bot.Key, readAll = false });
        Assert.False(set.Body().GetProperty("member").GetProperty("readsMessages").GetBoolean());
        var updated = await alice.EventAsync("member.updated");
        Assert.False(updated.Body().GetProperty("member").GetProperty("readsMessages").GetBoolean());

        await alice.RequestAsync("chat.send", new { channelId = server.General, text = "not for bots" });
        await bot.NoEventAsync("chat.message");
        Assert.Equal("forbidden", (await bot.RequestAsync("chat.history", new { channelId = server.General })).ErrorCode());
        Assert.Contains(server.World.Store.Audit("bot.scope", null, null, 10), e => e.Action == "bot.scope");
    }

    // Security review W6: a commands-only bot read other messages through a reply's quote, Web Push (the small-server
    // default pushes every message, text included), docs saves and moderation answers.
    [Fact]
    public async Task A_bot_that_reads_only_its_messages_cant_read_others_another_way()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin, role: "trusted");
        await Register(bot);
        using var alice = await server.JoinAsync("Alice");

        var secret = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "the secret plan" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        var quoted = await bot.RequestAsync("chat.send", new { channelId = server.General, text = "what?", replyTo = secret });
        Assert.Equal("forbidden", quoted.ErrorCode());
        Assert.Equal("bot_no_read", Key(quoted));
        // Answering what was meant for it still works.
        var command = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "/roll d6" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("result", (await bot.RequestAsync("chat.send", new { channelId = server.General, text = "4", replyTo = command })).Type());

        foreach (var (type, body) in new (string, object)[]
        {
            ("push.subscribe", new { endpoint = "https://fcm.googleapis.com/fcm/send/bot", keys = new { p256dh = "x", auth = "y" } }),
            ("docs.page.save", new { id = 1, baseVersion = 1, title = "x" }), ("docs.page.restore", new { id = 1, baseVersion = 1, version = 1 }),
            ("docs.home.set", new { }), ("forum.post.set", new { id = 1 }), ("forum.post.update", new { id = 1 }), ("report.list", new { }),
        })
        {
            var reply = await bot.RequestAsync(type, body);
            Assert.Equal("bot_no_read", Key(reply));
        }

        // A bot that read everything and made a push subscription loses it when it may no longer, and pushes skip it anyway.
        using var reader = await JoinBot(server, admin, name: "Reader", readAll: true);
        server.World.Store.SavePushSubscription(reader.Key, "reader-device", "https://fcm.googleapis.com/fcm/send/reader", "p", "a", 1, 10);
        Assert.Equal("result", (await admin.RequestAsync("bot.scope.set", new { accountKey = reader.Key, readAll = false })).Type());
        Assert.Empty(server.World.Store.PushSubscriptions(reader.Key));
        using var p256 = System.Security.Cryptography.ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256);
        var q = p256.ExportParameters(false).Q;
        server.World.Store.SavePushSubscription(bot.Key, "bot-device", "https://fcm.googleapis.com/fcm/send/bot", Ed25519.ToB64u([4, .. q.X!, .. q.Y!]),
            Ed25519.ToB64u(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16)), 1, 10);
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = "everyone hears this on a small server" });
        await server.Push.NoneAsync("https://fcm.googleapis.com/fcm/send/bot");
    }

    [Fact]
    public void One_person_cant_use_up_everyones_interactions()
    {
        var registry = new InteractionRegistry(TimeProvider.System);
        for (var i = 0; i < InteractionRegistry.MaxPendingPerUser; i++) registry.Start("bot", "mallory", 1, "command", "roll", null, null, false);
        var refused = Assert.Throws<RequestException>(() => registry.Start("bot", "mallory", 1, "command", "roll", null, null, false));
        Assert.Equal("rate_limited", refused.Code);
        registry.Start("bot", "alice", 1, "command", "roll", null, null, false);
        registry.Start("bot", "mallory", 1, "command", null, null, null, true, capped: false); // a built-in bot's own note
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task A_command_reaches_the_bot_with_checked_options_and_the_answer_is_stamped()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        await Register(bot);
        using var alice = await server.JoinAsync("Alice");
        var roleId = (await admin.RequestAsync("role.create", new { name = "Players" })).Body().GetProperty("role").GetProperty("id").GetInt64();

        var invoked = await Invoke(alice, bot.Key, server.General, "roll",
            new { dice = "d20", times = 3, secret = false, @for = admin.Key, where = server.General, team = roleId, bonus = 1.5 }, "d20 3");
        Assert.Equal("result", invoked.Type());
        var id = invoked.Body().GetProperty("id").GetString()!;
        Assert.False(invoked.Body().GetProperty("private").GetBoolean());

        var interaction = (await bot.EventAsync("interaction")).Body();
        Assert.Equal(id, interaction.GetProperty("id").GetString());
        Assert.Equal("command", interaction.GetProperty("kind").GetString());
        Assert.Equal("roll", interaction.GetProperty("command").GetString());
        Assert.Equal(alice.Key, interaction.GetProperty("user").GetString());
        Assert.Equal(3, interaction.GetProperty("options").GetProperty("times").GetInt64());
        Assert.Equal("d20 3", interaction.GetProperty("args").GetString());
        // Nobody else hears of it, and nothing is posted.
        await admin.NoEventAsync("interaction");
        await admin.NoEventAsync("chat.message");

        var answer = await bot.RequestAsync("interaction.respond", new { id, text = "Alice rolled 17" });
        var message = answer.Body().GetProperty("message");
        Assert.Equal(alice.Key, message.GetProperty("interaction").GetProperty("user").GetString());
        Assert.Equal("roll", message.GetProperty("interaction").GetProperty("command").GetString());
        var seen = (await admin.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("Alice rolled 17", seen.GetProperty("text").GetString());
        Assert.Equal(id, seen.GetProperty("interaction").GetProperty("id").GetString());
        var state = (await alice.EventAsync("interaction.state")).Body();
        Assert.Equal("done", state.GetProperty("state").GetString());

        // Follow-ups: up to five answers in all, then the token is used up.
        for (var i = 0; i < 4; i++) Assert.Equal("result", (await bot.RequestAsync("interaction.respond", new { id, text = $"more {i}" })).Type());
        Assert.Equal("bad_request", (await bot.RequestAsync("interaction.respond", new { id, text = "too many" })).ErrorCode());
    }

    public static TheoryData<string> BadOptions() => new()
    {
        """{"dice":"d8"}""",                        // not a choice
        """{"times":2}""",                          // the required one is missing
        """{"dice":"d6","times":"two"}""",          // wrong type
        """{"dice":"d6","times":1.5}""",
        """{"dice":"d6","secret":"yes"}""",
        """{"dice":"d6","for":"nobody"}""",         // not a member
        """{"dice":"d6","where":999999}""",         // no such channel
        """{"dice":"d6","team":999999}""",          // no such role
        """{"dice":"d6","bonus":"NaN"}""",
        """{"dice":"d6","note":"two\nlines"}""",
        """{"dice":"d6","extra":1}""",              // not declared
        """["d6"]""",
    };

    [Theory]
    [MemberData(nameof(BadOptions))]
    public async Task Options_must_match_the_declared_command(string options)
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        await Register(bot);
        var reply = await Invoke(admin, bot.Key, server.General, "roll", JsonDocument.Parse(options).RootElement);
        Assert.Equal("bad_request", reply.ErrorCode());
        await bot.NoEventAsync("interaction");
    }

    [Fact]
    public async Task Who_may_use_a_command_is_checked_on_the_server()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bot = await JoinBot(server, owner);
        await Register(bot);
        using var alice = await server.JoinAsync("Alice");
        using var trusted = await server.JoinAsync("Tess", "trusted");
        using var admin = await server.JoinAsync("Adam", "admin");

        // role trusted + manageMessages: a member and a trusted member without the permission are refused.
        foreach (var who in new[] { alice, trusted })
        {
            var refused = await Invoke(who, bot.Key, server.General, "purge");
            Assert.Equal("forbidden", refused.ErrorCode());
            Assert.Equal("command_not_allowed", Key(refused));
        }
        Assert.Equal("result", (await Invoke(admin, bot.Key, server.General, "purge")).Type());

        // Unknown commands, other bots' tokens, and bots invoking.
        Assert.Equal("not_found", (await Invoke(alice, bot.Key, server.General, "fly")).ErrorCode());
        Assert.Equal("not_found", (await Invoke(alice, alice.Key, server.General, "roll", new { dice = "d6" })).ErrorCode());
        Assert.Equal("forbidden", (await Invoke(bot, bot.Key, server.General, "roll", new { dice = "d6" })).ErrorCode());

        // A channel the invoker can read but not post in.
        var readOnly = (await owner.RequestAsync("channel.create", new { name = "news", writeRole = "admin" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var cant = await Invoke(alice, bot.Key, readOnly, "roll", new { dice = "d6" });
        Assert.Equal("forbidden", cant.ErrorCode());
        Assert.Equal("cant_send_here", Key(cant));
        // A channel the invoker can't see.
        var hidden = (await owner.RequestAsync("channel.create", new { name = "staff", readRole = "admin" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await Invoke(alice, bot.Key, hidden, "roll", new { dice = "d6" })).ErrorCode());

        // Timed out: no commands either.
        await Breathe();
        await owner.RequestAsync("member.timeout", new { accountKey = alice.Key, durationMs = 60_000 });
        var timedOut = await Invoke(alice, bot.Key, server.General, "roll", new { dice = "d6" });
        Assert.Equal("timed_out", Key(timedOut));
    }

    [Fact]
    public async Task The_bot_must_take_interactions_be_allowed_to_post_and_be_online()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var textBot = await JoinBot(server, admin, "Echo");
        await Register(textBot, interactions: false);
        using var guestBot = await JoinBot(server, admin, "Guest", role: "guest");
        await Register(guestBot);
        var offline = await JoinBot(server, admin, "Sleepy");
        await Register(offline);

        Assert.Equal("not_found", (await Invoke(admin, textBot.Key, server.General, "roll", new { dice = "d6" })).ErrorCode());
        var cantPost = await Invoke(admin, guestBot.Key, server.General, "roll", new { dice = "d6" });
        Assert.Equal("bot_cant_post", Key(cantPost));

        offline.Dispose();
        string key = "";
        for (var i = 0; i < 50 && key != "bot_offline"; i++)
        {
            key = Key(await Invoke(admin, offline.Key, server.General, "roll", new { dice = "d6" }));
            if (key != "bot_offline") await Task.Delay(50);
        }
        Assert.Equal("bot_offline", key);
    }

    [Fact]
    public async Task Tokens_are_for_one_bot_and_answers_follow_the_rules()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var dice = await JoinBot(server, admin);
        using var other = await JoinBot(server, admin, "Other");
        await Register(dice);
        await Register(other);
        var id = (await Invoke(admin, dice.Key, server.General, "roll", new { dice = "d6" })).Body().GetProperty("id").GetString()!;
        await dice.EventAsync("interaction");

        Assert.Equal("not_found", (await other.RequestAsync("interaction.respond", new { id, text = "mine now" })).ErrorCode());
        Assert.Equal("not_found", (await dice.RequestAsync("interaction.respond", new { id = "nope", text = "x" })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("interaction.respond", new { id, text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await dice.RequestAsync("interaction.respond", new { id, type = "update", text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await dice.RequestAsync("interaction.respond", new { id, type = "teleport" })).ErrorCode());

        // Defer first, then answer; not defer twice, and no form after an answer.
        Assert.Equal("result", (await dice.RequestAsync("interaction.respond", new { id, type = "defer" })).Type());
        Assert.Equal("deferred", (await admin.EventAsync("interaction.state")).Body().GetProperty("state").GetString());
        Assert.Equal("bad_request", (await dice.RequestAsync("interaction.respond", new { id, type = "defer" })).ErrorCode());
        Assert.Equal("result", (await dice.RequestAsync("interaction.respond", new { id, text = "done thinking" })).Type());
        Assert.Equal("bad_request", (await dice.RequestAsync("interaction.respond", new { id, type = "modal",
            modal = new { customId = "f", title = "Form", fields = new[] { new { customId = "a", label = "A" } } } })).ErrorCode());
        // A failed answer doesn't use up a slot.
        Assert.Equal("bad_request", (await dice.RequestAsync("interaction.respond", new { id, text = "" })).ErrorCode());
    }

    [Fact]
    public async Task Private_answers_reach_only_the_invoker_and_are_never_stored()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        await Register(bot);
        using var alice = await server.JoinAsync("Alice");
        var id = (await Invoke(alice, bot.Key, server.General, "roll", new { dice = "d6", secret = true })).Body().GetProperty("id").GetString()!;
        await bot.EventAsync("interaction");

        var reply = await bot.RequestAsync("interaction.respond", new
        {
            id, text = "Only you: 4", @private = true,
            components = new[] { new { type = "row", items = new[] { new { type = "button", customId = "again", label = "Again" } } } },
        });
        var responseId = reply.Body().GetProperty("responseId").GetString()!;
        var got = (await alice.EventAsync("interaction.response")).Body();
        Assert.Equal("Only you: 4", got.GetProperty("text").GetString());
        Assert.Equal(responseId, got.GetProperty("responseId").GetString());
        await admin.NoEventAsync("interaction.response");
        await admin.NoEventAsync("chat.message");
        var history = (await admin.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.DoesNotContain(history.EnumerateArray(), m => m.GetProperty("text").GetString()!.Contains("Only you"));

        // Its button: only Alice can click it; the bot updates the answer in place.
        Assert.Equal("not_found", (await admin.RequestAsync("interaction.invoke", new { responseId, customId = "again" })).ErrorCode());
        var click = await alice.RequestAsync("interaction.invoke", new { responseId, customId = "again" });
        var clickId = click.Body().GetProperty("id").GetString()!;
        var clicked = (await bot.EventAsync("interaction")).Body();
        Assert.Equal("component", clicked.GetProperty("kind").GetString());
        Assert.Equal(responseId, clicked.GetProperty("responseId").GetString());
        Assert.Equal("result", (await bot.RequestAsync("interaction.respond", new { id = clickId, type = "update", text = "Only you: 6" })).Type());
        var updated = (await alice.EventAsync("interaction.response")).Body();
        Assert.True(updated.GetProperty("updated").GetBoolean());
        Assert.Equal(responseId, updated.GetProperty("responseId").GetString());
        Assert.Equal("Only you: 6", updated.GetProperty("text").GetString());
    }

    // ── Components ───────────────────────────────────────────────────────────

    private static object[] Buttons => [new
    {
        type = "row",
        items = new object[]
        {
            new { type = "button", customId = "roll:d6", label = "Roll again", style = "primary" },
            new { type = "button", customId = "off", label = "Off", disabled = true },
            new { type = "button", label = "Docs", style = "link", url = "https://example.com/dice" },
        },
    }, new
    {
        type = "row",
        items = new object[]
        {
            new { type = "select", customId = "pick", placeholder = "Pick dice", maxValues = 2, options = new object[]
            {
                new { label = "d6", value = "d6" }, new { label = "d20", value = "d20", description = "Big one" }, new { label = "d4", value = "d4" },
            } },
        },
    }];

    [Fact]
    public async Task Clicks_on_a_bots_message_become_interactions_and_the_bot_can_update_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        await Register(bot);
        using var alice = await server.JoinAsync("Alice");

        Assert.Equal("forbidden", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "fake", components = Buttons })).ErrorCode());
        var sent = await bot.RequestAsync("chat.send", new { channelId = server.General, components = Buttons });
        var message = sent.Body().GetProperty("message");
        var messageId = message.GetProperty("id").GetInt64();
        Assert.Equal(2, message.GetProperty("components").GetArrayLength());
        Assert.Equal("https://example.com/dice", message.GetProperty("components")[0].GetProperty("items")[2].GetProperty("url").GetString());
        Assert.Equal(JsonValueKind.Null, message.GetProperty("interaction").ValueKind);

        // Buttons: enabled ones only; links never reach the bot.
        Assert.Equal("not_found", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "off" })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "nope" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "roll:d6", values = new[] { "x" } })).ErrorCode());
        var click = await alice.RequestAsync("interaction.invoke", new { messageId, customId = "roll:d6" });
        var id = click.Body().GetProperty("id").GetString()!;
        var interaction = (await bot.EventAsync("interaction")).Body();
        Assert.Equal("roll:d6", interaction.GetProperty("customId").GetString());
        Assert.Equal(messageId, interaction.GetProperty("messageId").GetInt64());

        // Select menus: values from the options, within min/max.
        await Breathe();
        Assert.Equal("bad_request", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "pick", values = new[] { "d100" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "pick", values = new[] { "d6", "d20", "d4" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "pick" })).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "pick", values = new[] { "d6", "d20" } })).Type());
        Assert.Equal(2, (await bot.EventAsync("interaction")).Body().GetProperty("values").GetArrayLength());

        await Breathe();
        // Update: the message's text, cards and components are replaced.
        var update = await bot.RequestAsync("interaction.respond", new { id, type = "update", text = "Rolled 5",
            components = new[] { new { type = "row", items = new[] { new { type = "button", customId = "roll:d6", label = "Roll again" } } } } });
        Assert.Equal("result", update.Type());
        var edited = (await alice.EventAsync("chat.edited")).Body().GetProperty("message");
        Assert.Equal("Rolled 5", edited.GetProperty("text").GetString());
        Assert.Single(edited.GetProperty("components").EnumerateArray());

        // Only the bot's own messages carry clickable components; a person's message has none to click.
        var mine = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await alice.RequestAsync("interaction.invoke", new { messageId = mine, customId = "roll:d6" })).ErrorCode());
        // Removing them.
        Assert.Equal("result", (await bot.RequestAsync("chat.edit", new { id = messageId, text = "Done", components = Array.Empty<object>() })).Type());
        Assert.Equal("not_found", (await alice.RequestAsync("interaction.invoke", new { messageId, customId = "roll:d6" })).ErrorCode());
    }

    public static TheoryData<string> BadComponents() => new()
    {
        """[{"type":"button","customId":"a","label":"A"}]""",                                       // not in a row
        """[{"type":"row","items":[]}]""",
        """[{"type":"row","items":[{"type":"button","customId":"a","label":"A","style":"neon"}]}]""",
        """[{"type":"row","items":[{"type":"button","customId":"a","label":""}]}]""",
        """[{"type":"row","items":[{"type":"button","customId":"a","label":"A"},{"type":"button","customId":"a","label":"B"}]}]""",
        """[{"type":"row","items":[{"type":"button","label":"L","style":"link","url":"javascript:alert(1)"}]}]""",
        """[{"type":"row","items":[{"type":"button","label":"L","style":"link"}]}]""",
        """[{"type":"row","items":[{"type":"button","customId":"a","label":"A","url":"https://x.y"}]}]""",
        """[{"type":"row","items":[{"type":"select","customId":"s","options":[]}]}]""",
        """[{"type":"row","items":[{"type":"select","customId":"s","options":[{"label":"a","value":"a"}],"maxValues":2}]}]""",
        """[{"type":"row","items":[{"type":"select","customId":"s","options":[{"label":"a","value":"a"},{"label":"b","value":"a"}]}]}]""",
        """[{"type":"row","items":[{"type":"select","customId":"s","options":[{"label":"a","value":"a"}]},{"type":"button","customId":"b","label":"B"}]}]""",
        """[{"type":"row","items":[{"type":"button","customId":"\u0001","label":"A"}]}]""",
    };

    [Theory]
    [MemberData(nameof(BadComponents))]
    public async Task Components_are_validated(string components)
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        var reply = await bot.RequestAsync("chat.send", new { channelId = server.General, text = "x", components = JsonDocument.Parse(components).RootElement });
        Assert.Equal("bad_request", reply.ErrorCode());
    }

    [Fact]
    public async Task Component_limits()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        object Row(int buttons, int offset = 0) => new
        {
            type = "row",
            items = Enumerable.Range(offset, buttons).Select(i => new { type = "button", customId = $"b{i}", label = $"B{i}" }).ToArray(),
        };
        async Task<string> Send(object[] rows) =>
            (await bot.RequestAsync("chat.send", new { channelId = server.General, text = "x", components = rows })).ErrorCode() ?? "ok";

        Assert.Equal("ok", await Send(Enumerable.Range(0, 5).Select(r => Row(5, r * 5)).ToArray()));
        Assert.Equal("bad_request", await Send(Enumerable.Range(0, 6).Select(r => Row(1, r)).ToArray()));
        Assert.Equal("bad_request", await Send([Row(6)]));
        var longId = new string('a', 101);
        Assert.Equal("bad_request", await Send([new { type = "row", items = new[] { new { type = "button", customId = longId, label = "A" } } }]));
        Assert.Equal("bad_request", await Send([new { type = "row", items = new[] { new { type = "button", customId = "a", label = new string('L', 81) } } }]));
        var options = Enumerable.Range(0, 26).Select(i => new { label = $"o{i}", value = $"v{i}" }).ToArray();
        Assert.Equal("bad_request", await Send([new { type = "row", items = new[] { new { type = "select", customId = "s", options } } }]));
    }

    // ── Forms ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task A_form_goes_to_the_invoker_and_its_answer_is_checked_and_single_use()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        await Register(bot);
        using var alice = await server.JoinAsync("Alice");
        var id = (await Invoke(alice, bot.Key, server.General, "roll", new { dice = "d6" })).Body().GetProperty("id").GetString()!;
        await bot.EventAsync("interaction");

        Assert.Equal("bad_request", (await bot.RequestAsync("interaction.respond", new { id, type = "modal",
            modal = new { customId = "plan", title = "Plan", fields = Array.Empty<object>() } })).ErrorCode());
        Assert.Equal("result", (await bot.RequestAsync("interaction.respond", new { id, type = "modal", modal = new
        {
            customId = "plan", title = "Plan a game night",
            fields = new object[]
            {
                new { customId = "title", label = "Title", style = "short", maxLength = 20 },
                new { customId = "notes", label = "Notes", style = "paragraph", required = false },
            },
        } })).Type());
        var modal = (await alice.EventAsync("interaction.modal")).Body();
        var modalId = modal.GetProperty("modalId").GetString()!;
        Assert.Equal("Plan a game night", modal.GetProperty("modal").GetProperty("title").GetString());
        await admin.NoEventAsync("interaction.modal");

        Assert.Equal("not_found", (await admin.RequestAsync("interaction.invoke", new { modalId, fields = new { title = "x" } })).ErrorCode());
        var missing = await alice.RequestAsync("interaction.invoke", new { modalId, fields = new { notes = "snacks" } });
        Assert.Equal("form_required", Key(missing));
        Assert.Equal("bad_request", (await alice.RequestAsync("interaction.invoke", new { modalId, fields = new { title = new string('t', 21) } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("interaction.invoke", new { modalId, fields = new { title = "a\nb" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("interaction.invoke", new { modalId, fields = new { title = "ok", other = "x" } })).ErrorCode());

        await Breathe();
        Assert.Equal("result", (await alice.RequestAsync("interaction.invoke", new { modalId, fields = new { title = "Game night", notes = "Bring\nsnacks" } })).Type());
        var submitted = (await bot.EventAsync("interaction")).Body();
        Assert.Equal("modal", submitted.GetProperty("kind").GetString());
        Assert.Equal("plan", submitted.GetProperty("customId").GetString());
        Assert.Equal("Bring\nsnacks", submitted.GetProperty("fields").GetProperty("notes").GetString());
        Assert.Equal("not_found", (await alice.RequestAsync("interaction.invoke", new { modalId, fields = new { title = "Again" } })).ErrorCode());
    }

    // ── Encrypted channels ───────────────────────────────────────────────────

    [Fact]
    public async Task In_an_encrypted_channel_every_answer_is_private()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob", "trusted");
        using var bot = await JoinBot(server, owner, role: "trusted");
        await Register(bot);
        using var textBot = await JoinBot(server, owner, "Echo", role: "trusted");
        await Register(textBot, interactions: false);

        // The chain holds only people; the bot can read the channel by its role but is never in it.
        var chain = GroupTests.NewId();
        var payload = Encoding.UTF8.GetBytes(new JsonObject
        {
            ["v"] = 1, ["group"] = chain, ["version"] = 1, ["prev"] = "", ["by"] = owner.Key, ["action"] = "create",
            ["targets"] = new JsonArray(bob.Key), ["members"] = new JsonArray(owner.Key, bob.Key),
            ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }.ToJsonString());
        var sig = Ed25519.Sign(owner.Identity.Account, Ed25519.Payload(E2eeChannelFeature.Context, payload));
        string Device(User u) => Ed25519.ToB64u(Ed25519.PublicKeyOf(u.Identity.Device));
        var keys = new JsonObject
        {
            ["v"] = 2, ["kind"] = "channel-key",
            ["header"] = new JsonObject { ["from"] = owner.Key, ["chain"] = chain, ["version"] = 1, ["head"] = "", ["sentAt"] = 1, ["id"] = "k" },
            ["nonce"] = "n", ["ct"] = "opaque",
            ["keys"] = new JsonArray(new[] { owner, bob }.Select(u => (JsonNode)new JsonObject { ["device"] = Device(u), ["nonce"] = "x", ["box"] = "y" }).ToArray()),
        };
        var created = await owner.RequestAsync("channel.create", new
        {
            name = "secret", readRole = "trusted",
            e2ee = new { change = new { payload = Ed25519.ToB64u(payload), sig = Ed25519.ToB64u(sig) }, keys = new[] { keys } },
        });
        Assert.Equal("result", created.Type());
        var channelId = created.Body().GetProperty("channel").GetProperty("id").GetInt64();

        var available = (await bob.RequestAsync("bot.commands.available", new { channelId })).Body().GetProperty("bots");
        Assert.Equal([bot.Key], available.EnumerateArray().Select(b => b.GetString()).ToArray());

        var invoked = await Invoke(bob, bot.Key, channelId, "roll", new { dice = "d6" });
        Assert.True(invoked.Body().GetProperty("private").GetBoolean());
        var id = invoked.Body().GetProperty("id").GetString()!;
        Assert.True((await bot.EventAsync("interaction")).Body().GetProperty("private").GetBoolean());

        // Asked for a public answer: it still goes only to Bob, and nothing lands in the channel.
        var reply = await bot.RequestAsync("interaction.respond", new { id, text = "Bob rolled 3" });
        Assert.True(reply.Body().TryGetProperty("responseId", out _));
        Assert.Equal("Bob rolled 3", (await bob.EventAsync("interaction.response")).Body().GetProperty("text").GetString());
        await owner.NoEventAsync("interaction.response");
        await owner.NoEventAsync("chat.message");
        // Bots still can't post there themselves.
        Assert.NotEqual("result", (await bot.RequestAsync("chat.send", new { channelId, text = "plain" })).Type());
    }

    [Fact]
    public async Task The_registry_flag_and_command_rules_are_stored_and_listed()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        var set = await bot.RequestAsync("bot.commands.set", new { commands = new[] { Purge }, interactions = true });
        Assert.True(set.Body().GetProperty("interactions").GetBoolean());
        Assert.Equal("trusted", set.Body().GetProperty("commands")[0].GetProperty("role").GetString());
        Assert.Equal("manageMessages", set.Body().GetProperty("commands")[0].GetProperty("permission").GetString());
        Assert.True((await admin.EventAsync("bot.commands")).Body().GetProperty("interactions").GetBoolean());
        using var alice = await server.JoinAsync("Alice");
        Assert.True(alice.Welcome.Body().GetProperty("botCommands")[0].GetProperty("interactions").GetBoolean());

        Assert.Equal("bad_request", (await bot.RequestAsync("bot.commands.set", new { commands = new[] { new { name = "x", description = "x", role = "owner" } } })).ErrorCode());
        Assert.Equal("bad_request", (await bot.RequestAsync("bot.commands.set", new { commands = new[] { new { name = "x", description = "x", permission = "flyPlanes" } } })).ErrorCode());
    }
}
