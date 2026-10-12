using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class BotCommandTests
{
    private static async Task<User> JoinBot(IskraServer server, User admin, string name = "Dice", string role = "member")
    {
        var code = (await admin.RequestAsync("bot.invite", new { role })).Body().GetProperty("invite").GetProperty("code").GetString()!;
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
        name = "roll", description = "Rolls dice", usage = "2d6",
        options = new object[]
        {
            new { name = "dice", description = "Like 2d6", type = "string", required = true,
                  choices = new object[] { new { name = "Twenty-sided", value = "d20" } } },
            new { name = "times", description = "How often", type = "integer" },
        },
    };

    [Fact]
    public async Task A_bot_registers_commands_and_everyone_hears_about_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        await admin.EventAsync("member.joined");

        var set = await bot.RequestAsync("bot.commands.set", new { commands = new[] { Roll, new { name = "coin", description = "Flips a coin" } } });
        Assert.Equal("result", set.Type());
        var stored = set.Body().GetProperty("commands");
        Assert.Equal(2, stored.GetArrayLength());
        Assert.Equal("2d6", stored[0].GetProperty("usage").GetString());
        Assert.True(stored[0].GetProperty("options")[0].GetProperty("required").GetBoolean());
        Assert.False(stored[0].GetProperty("options")[1].TryGetProperty("required", out _));

        var changed = (await admin.EventAsync("bot.commands")).Body();
        Assert.Equal(bot.Key, changed.GetProperty("bot").GetString());
        Assert.Equal("roll", changed.GetProperty("commands")[0].GetProperty("name").GetString());

        // Newcomers get it in welcome.
        using var alice = await server.JoinAsync("Alice");
        var listed = alice.Welcome.Body().GetProperty("botCommands");
        Assert.Equal(bot.Key, listed[0].GetProperty("bot").GetString());
        Assert.Equal(2, listed[0].GetProperty("commands").GetArrayLength());

        // Replacing with [] clears it.
        await bot.RequestAsync("bot.commands.set", new { commands = Array.Empty<object>() });
        Assert.Equal(0, (await alice.EventAsync("bot.commands")).Body().GetProperty("commands").GetArrayLength());
        using var bob = await server.JoinAsync("Bob");
        Assert.Equal(0, bob.Welcome.Body().GetProperty("botCommands").GetArrayLength());
    }

    [Fact]
    public async Task People_cannot_register_commands()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        Assert.Equal("forbidden", (await admin.RequestAsync("bot.commands.set", new { commands = new[] { Roll } })).ErrorCode());
    }

    public static TheoryData<string> BadLists() => new()
    {
        """[{"name":"Roll","description":"x"}]""",
        """[{"name":"/roll","description":"x"}]""",
        """[{"name":"_roll","description":"x"}]""",
        """[{"name":"abcdefghijklmnopqrstuvwxyz0123456","description":"x"}]""",
        """[{"name":"roll"}]""",
        """[{"name":"roll","description":""}]""",
        """[{"name":"roll","description":"two\nlines"}]""",
        """[{"name":"roll","description":"x"},{"name":"roll","description":"y"}]""",
        """[{"name":"roll","description":"x","options":[{"name":"a","description":"a","type":"date"}]}]""",
        """[{"name":"roll","description":"x","options":[{"name":"a","description":"a","type":"string"},{"name":"b","description":"b","type":"string","required":true}]}]""",
        """[{"name":"roll","description":"x","options":[{"name":"a","description":"a","type":"boolean","choices":[{"name":"y","value":true}]}]}]""",
        """[{"name":"roll","description":"x","options":[{"name":"a","description":"a","type":"integer","choices":[{"name":"y","value":1.5}]}]}]""",
        """[{"name":"roll","description":"x","options":[{"name":"a","description":"a","type":"string","choices":[{"name":"y","value":3}]}]}]""",
        """[{"name":"roll","description":"x","options":[{"name":"a","description":"a","type":"string"},{"name":"a","description":"b","type":"string"}]}]""",
        """{"name":"roll"}""",
    };

    [Theory]
    [MemberData(nameof(BadLists))]
    public async Task The_server_checks_every_field(string commands)
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        var reply = await bot.RequestAsync("bot.commands.set", new { commands = JsonDocument.Parse(commands).RootElement });
        Assert.Equal("bad_request", reply.ErrorCode());
    }

    [Fact]
    public async Task Count_and_size_limits()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);

        object Command(int i, int options = 0) => new
        {
            name = $"c{i}", description = new string('d', 100),
            options = Enumerable.Range(0, options).Select(o => new { name = $"o{o}", description = new string('o', 100), type = "string" }).ToArray(),
        };
        Assert.Equal("result", (await bot.RequestAsync("bot.commands.set", new { commands = Enumerable.Range(0, 50).Select(i => Command(i)).ToArray() })).Type());
        Assert.Equal("bad_request", (await bot.RequestAsync("bot.commands.set", new { commands = Enumerable.Range(0, 51).Select(i => Command(i)).ToArray() })).ErrorCode());
        Assert.Equal("bad_request", (await bot.RequestAsync("bot.commands.set", new { commands = new[] { Command(0, 26) } })).ErrorCode());
        // 50 commands with long descriptions and options go over 16 KB.
        Assert.Equal("bad_request", (await bot.RequestAsync("bot.commands.set", new { commands = Enumerable.Range(0, 6).Select(i => Command(i, 25)).ToArray() })).ErrorCode());
        // Too many requests.
        for (var i = 0; i < 5; i++) await bot.RequestAsync("bot.commands.set", new { commands = Array.Empty<object>() });
        Assert.Equal("rate_limited", (await bot.RequestAsync("bot.commands.set", new { commands = Array.Empty<object>() })).ErrorCode());
    }

    [Fact]
    public async Task Available_lists_bots_that_can_read_and_post_in_the_channel()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bot = await JoinBot(server, owner);
        await bot.RequestAsync("bot.commands.set", new { commands = new[] { Roll } });
        using var quiet = await JoinBot(server, owner, "Quiet"); // no commands

        var store = server.World.Store;
        var announcements = store.CreateChannel("announcements", "text", "member", "admin", 0).Id;
        var staff = store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        var secret = store.CreateChannel("secret", "text", "member", "member", 0).Id;
        store.SaveE2eeChange(new E2eeChannel(secret, "chain", 1, "head", [owner.Key, alice.Key], 0),
            new E2eeChange(1, "{}", "sig", owner.Key, 0), [], fresh: true);

        async Task<string[]> Available(User user, long channelId) =>
            (await user.RequestAsync("bot.commands.available", new { channelId })).Body().GetProperty("bots").EnumerateArray().Select(b => b.GetString()!).ToArray();

        Assert.Equal([bot.Key], await Available(alice, server.General));
        Assert.Empty(await Available(alice, announcements)); // the bot can read but not post
        Assert.Empty(await Available(owner, staff)); // the bot can't read
        Assert.Empty(await Available(alice, secret)); // encrypted: bots aren't there
        Assert.Equal("not_found", (await alice.RequestAsync("bot.commands.available", new { channelId = staff })).ErrorCode());

        // Threads follow their parent.
        var root = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "root" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        var thread = (await alice.RequestAsync("thread.create", new { messageId = root, name = "t" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        Assert.Equal([bot.Key], await Available(alice, thread));
    }

    [Fact]
    public async Task A_removed_bot_loses_its_commands()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bot = await JoinBot(server, owner);
        await bot.RequestAsync("bot.commands.set", new { commands = new[] { Roll } });
        Assert.Single(server.World.Store.AllBotCommands());

        await owner.RequestAsync("member.kick", new { accountKey = bot.Key });
        await owner.EventAsync("member.removed");
        Assert.Empty(server.World.Store.AllBotCommands());
        Assert.Empty((await owner.RequestAsync("bot.commands.available", new { channelId = server.General })).Body().GetProperty("bots").EnumerateArray());
    }

    // ── Cards ────────────────────────────────────────────────────────────────

    private static readonly object Card = new
    {
        title = "🎲 2d6", description = "**7**", color = 0x695bff, url = "https://example.com/rules",
        fields = new[] { new { name = "Rolls", value = "3, 4", inline = true } },
        footer = new { text = "Dice" },
    };

    [Fact]
    public async Task A_bot_attaches_cards_and_readers_see_them()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);

        var sent = await bot.RequestAsync("chat.send", new { channelId = server.General, text = "", cards = new[] { Card } });
        Assert.Equal("result", sent.Type());
        var message = (await admin.EventAsync("chat.message")).Body().GetProperty("message");
        var card = message.GetProperty("cards")[0];
        Assert.Equal("🎲 2d6", card.GetProperty("title").GetString());
        Assert.Equal(0x695bff, card.GetProperty("color").GetInt32());
        Assert.Equal("3, 4", card.GetProperty("fields")[0].GetProperty("value").GetString());
        Assert.Equal("", message.GetProperty("text").GetString());

        // In history too; other messages have none.
        var history = (await admin.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(JsonValueKind.Array, history[history.GetArrayLength() - 1].GetProperty("cards").ValueKind);
        var plain = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Body().GetProperty("message");
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("cards").ValueKind);

        // Edits replace the cards; [] removes them (text is then needed).
        var id = sent.Body().GetProperty("message").GetProperty("id").GetInt64();
        var edited = await bot.RequestAsync("chat.edit", new { id, cards = new[] { new { title = "Rerolled" } } });
        Assert.Equal("Rerolled", edited.Body().GetProperty("message").GetProperty("cards")[0].GetProperty("title").GetString());
        Assert.Equal("bad_request", (await bot.RequestAsync("chat.edit", new { id, cards = Array.Empty<object>() })).ErrorCode());
        var cleared = await bot.RequestAsync("chat.edit", new { id, text = "done", cards = Array.Empty<object>() });
        Assert.Equal(JsonValueKind.Null, cleared.Body().GetProperty("message").GetProperty("cards").ValueKind);
    }

    [Fact]
    public async Task People_cannot_attach_cards()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("forbidden", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "x", cards = new[] { Card } })).ErrorCode());
    }

    public static TheoryData<string> BadCards() => new()
    {
        """[{"title":"x","color":16777216}]""",
        """[{"title":"x","url":"javascript:alert(1)"}]""",
        """[{"title":"x","image":{"url":"https://example.com/a.png"}}]""",
        """[{"title":"x","thumbnail":{"url":"data:image/svg+xml;base64,PHN2Zz4="}}]""",
        """[{"title":"x","image":{"url":"/files/AAAAAAAAAAAAAAAAAAAAAA/a.png"}}]""",
        """[{"title":"x","image":"data:image/png;base64,AAAA"}]""",
        """[{"fields":[{"name":"a","value":"b"}],"description":"two\u0007bell"}]""",
        """{"title":"x"}""",
    };

    [Theory]
    [MemberData(nameof(BadCards))]
    public async Task Cards_are_validated(string cards)
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        var reply = await bot.RequestAsync("chat.send", new { channelId = server.General, text = "x", cards = JsonDocument.Parse(cards).RootElement });
        Assert.Equal("bad_request", reply.ErrorCode());
    }

    [Fact]
    public async Task Card_limits_match_webhooks()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        var eleven = Enumerable.Range(0, 11).Select(i => new { title = $"t{i}" }).ToArray();
        Assert.Equal("bad_request", (await bot.RequestAsync("chat.send", new { channelId = server.General, text = "x", cards = eleven })).ErrorCode());
        var big = Enumerable.Range(0, 2).Select(_ => new { description = new string('a', 4000) }).ToArray();
        Assert.Equal("bad_request", (await bot.RequestAsync("chat.send", new { channelId = server.General, text = "x", cards = big })).ErrorCode());
    }

    [Fact]
    public async Task Card_pictures_come_from_the_server_or_data_urls()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        var mine = await EmojiTests.Upload(server, bot, EmojiTests.Png, "die.png");
        var hers = await EmojiTests.Upload(server, admin, EmojiTests.Png, "other.png");
        var dataUrl = "data:image/png;base64," + Convert.ToBase64String(EmojiTests.Png);

        var sent = await bot.RequestAsync("chat.send", new
        {
            channelId = server.General, text = "",
            cards = new[] { new { title = "x", thumbnail = new { url = dataUrl }, image = new { url = $"/files/{mine}/whatever" } } },
        });
        var card = sent.Body().GetProperty("message").GetProperty("cards")[0];
        Assert.Equal(dataUrl, card.GetProperty("thumbnail").GetProperty("url").GetString());
        Assert.Equal($"/files/{mine}/die.png", card.GetProperty("image").GetProperty("url").GetString());
        Assert.Contains(mine, server.World.Store.CardFileIds());

        // Someone else's upload doesn't count; neither does a data: URL over 16 KB.
        Assert.Equal("bad_request", (await bot.RequestAsync("chat.send", new
        {
            channelId = server.General, text = "x", cards = new[] { new { title = "x", image = new { url = $"/files/{hers}/other.png" } } },
        })).ErrorCode());
        var huge = "data:image/png;base64," + new string('A', 16 * 1024);
        Assert.Equal("bad_request", (await bot.RequestAsync("chat.send", new
        {
            channelId = server.General, text = "x", cards = new[] { new { title = "x", image = new { url = huge } } },
        })).ErrorCode());
    }
}
