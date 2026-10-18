using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>DMs with bots: anyone may write to a bot; a bot may write to people unless they blocked it or turned bot DMs off.</summary>
public class BotDmTests
{
    private static object Envelope(string marker) => new { v = 1, ct = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(marker)), keys = Array.Empty<object>() };

    private static string? ErrorKey(JsonElement frame) =>
        frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    internal sealed record Bot(TestClient Client, TestIdentity Identity) : IDisposable
    {
        public string Key => Identity.AccountKey;
        public Task<JsonElement> RequestAsync(string type, object? body = null) => Client.RequestAsync(type, body);
        public void Dispose()
        {
            Client.Dispose();
            Identity.Dispose();
        }
    }

    internal static async Task<Bot> JoinBot(IskraServer server, User admin, string name = "Helper")
    {
        var code = (await admin.RequestAsync("bot.invite")).Body().GetProperty("invite").GetProperty("code").GetString()!;
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, name, invite: code);
        ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        Assert.Equal("welcome", (await client.ReceiveAsync()).Type());
        return new Bot(client, identity);
    }

    [Fact]
    public async Task People_and_bots_message_each_other_and_the_bot_sees_only_envelopes()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bot = await JoinBot(server, admin);

        // The bot publishes its device like anyone, so people can encrypt to it.
        var devices = (await alice.RequestAsync("dm.devices", new { accountKey = bot.Key })).Body().GetProperty("devices");
        Assert.Equal(bot.Key, devices[0].GetProperty("accountKey").GetString());

        var sent = await alice.RequestAsync("dm.send", new { accountKey = bot.Key, envelope = Envelope("/roll 2d6") });
        Assert.Equal("result", sent.Type());
        await alice.EventAsync("dm.message"); // her own copy
        var received = (await bot.Client.EventAsync("dm.message")).Body().GetProperty("message");
        Assert.Equal(alice.Key, received.GetProperty("from").GetString());

        var answer = await bot.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope("7") });
        Assert.Equal("result", answer.Type());
        Assert.Equal(bot.Key, (await alice.EventAsync("dm.message")).Body().GetProperty("message").GetProperty("from").GetString());
        Assert.Equal(2, (await bot.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages").GetArrayLength());
    }

    [Fact]
    public async Task A_bot_can_start_a_conversation_unless_the_person_turned_bot_dms_off()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var bot = await JoinBot(server, admin);

        // Default: allowed.
        var pref = (await alice.RequestAsync("dm.bots.get")).Body();
        Assert.True(pref.GetProperty("allow").GetBoolean());
        Assert.Equal("result", (await bot.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope("hi") })).Type());

        // Bob turns them off: the bot can't write first, not even in the conversation it started before.
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Assert.False((await bob.RequestAsync("dm.bots.set", new { allow = false, at = now })).Body().GetProperty("allow").GetBoolean());
        var refused = await bot.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("hi") });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("bot_dms_off", ErrorKey(refused));

        // Once Bob writes to the bot, it may answer him.
        Assert.Equal("result", (await bob.RequestAsync("dm.send", new { accountKey = bot.Key, envelope = Envelope("/help") })).Type());
        Assert.Equal("result", (await bot.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("help text") })).Type());

        // Alice turns them off later: the conversation the bot started is closed to it too.
        await alice.RequestAsync("dm.bots.set", new { allow = false, at = now });
        Assert.Equal("bot_dms_off", ErrorKey(await bot.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope("again") })));
    }

    [Fact]
    public async Task The_setting_is_last_writer_wins_and_reaches_the_other_sessions()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var other = await server.ConnectAsync();
        Assert.Equal("welcome", (await other.LoginAsync(alice.Identity, "Alice")).Type());

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await alice.RequestAsync("dm.bots.set", new { allow = false, at = now });
        var seen = (await other.EventAsync("dm.bots")).Body();
        Assert.False(seen.GetProperty("allow").GetBoolean());

        // An older change (another device that was offline) doesn't win.
        var stale = (await alice.RequestAsync("dm.bots.set", new { allow = true, at = now - 1000 })).Body();
        Assert.False(stale.GetProperty("allow").GetBoolean());
        Assert.Equal(now, stale.GetProperty("at").GetInt64());
        // Not from the future, and both fields are needed.
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.bots.set", new { allow = true, at = now + 3_600_000 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.bots.set", new { allow = true })).ErrorCode());
        Assert.True((await alice.RequestAsync("dm.bots.set", new { allow = true, at = now + 1 })).Body().GetProperty("allow").GetBoolean());
    }

    [Fact]
    public async Task Blocking_a_bot_stops_its_dms_both_ways()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bot = await JoinBot(server, admin);

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await alice.RequestAsync("block.sync", new { entries = new[] { new { accountKey = bot.Key, blocked = true, at = now } } });
        Assert.Equal("forbidden", (await bot.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope("hi") })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("dm.send", new { accountKey = bot.Key, envelope = Envelope("hi") })).ErrorCode());
    }

    [Fact]
    public async Task Bots_dont_message_bots_and_built_in_bots_take_no_dms()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var one = await JoinBot(server, admin, "One");
        using var two = await JoinBot(server, admin, "Two");

        var refused = await one.RequestAsync("dm.send", new { accountKey = two.Key, envelope = Envelope("ping") });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("bot_dm_bot", ErrorKey(refused));

        await admin.RequestAsync("builtin.bots.set", new { bot = "dice", enabled = true });
        var dice = server.World.Store.BuiltinBots().Single(b => b.Id == "dice").AccountKey;
        var builtin = await admin.RequestAsync("dm.send", new { accountKey = dice, envelope = Envelope("/roll") });
        Assert.Equal("bad_request", builtin.ErrorCode());
        Assert.Equal("builtin_bot_dm", ErrorKey(builtin));
        // Bots still can't upload DM files, take calls or join group DMs.
        Assert.Equal("forbidden", (await one.RequestAsync("dm.upload.begin", new { accountKey = admin.Key, size = 10 })).ErrorCode());
    }

    [Fact]
    public async Task A_bot_can_only_reach_members_of_this_server()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        using var stranger = new TestIdentity();
        Assert.Equal("not_found", (await bot.RequestAsync("dm.send", new { accountKey = stranger.AccountKey, envelope = Envelope("hi") })).ErrorCode());
    }

    [Fact]
    public async Task New_conversations_a_bot_starts_are_rate_limited()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bot = await JoinBot(server, admin);
        // Members straight in the store: 21 connections would be slow and hit other limits first.
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var people = Enumerable.Range(0, 21).Select(i =>
        {
            using var id = new TestIdentity();
            server.World.Store.AddMember(id.AccountKey, $"P{i}", "member", now);
            return id.AccountKey;
        }).ToList();

        JsonElement last = default;
        for (var i = 0; i < people.Count; i++)
        {
            var key = people[i];
            if (i >= 9) await Task.Delay(520); // stay under dm.send's own per-session rate
            last = await bot.RequestAsync("dm.send", new { accountKey = key, envelope = Envelope("hello") });
            if (last.Type() == "error") break;
        }
        Assert.Equal("rate_limited", last.ErrorCode());
        Assert.Equal("bot_dm_new_limit", ErrorKey(last));
        // Writing again to someone it already talks to still works.
        Assert.Equal("result", (await bot.RequestAsync("dm.send", new { accountKey = people[0], envelope = Envelope("again") })).Type());
    }
}
