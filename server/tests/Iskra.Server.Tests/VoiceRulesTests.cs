using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;

namespace Iskra.Server.Tests;

/// <summary>Voice channel user limits, and server rules members agree to before taking part.</summary>
public class VoiceRulesTests
{
    private static long VoiceChannel(IskraServer server, string name = "lounge", string kind = "voice") =>
        server.World.Store.CreateChannel(name, kind, "member", "member", 0).Id;

    private static async Task<HttpStatusCode> Webhook(IskraServer server, object evt)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(evt);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var token = LiveKitTokens.Sign(new JsonObject
        {
            ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = Convert.ToBase64String(SHA256.HashData(body)),
        }, server.Voice.ApiSecret);
        request.Headers.TryAddWithoutValidation("Authorization", token);
        using var response = await server.CreateClient().SendAsync(request);
        return response.StatusCode;
    }

    private static Task Joined(IskraServer server, long channel, string identity) =>
        Webhook(server, new { @event = "participant_joined", room = new { name = $"voice-{channel}" }, participant = new { identity } });

    private static Task Left(IskraServer server, long channel, string identity) =>
        Webhook(server, new { @event = "participant_left", room = new { name = $"voice-{channel}" }, participant = new { identity } });

    private static async Task SetLimit(User admin, long channel, int limit) =>
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = channel, userLimit = limit })).Type());

    // ── User limits ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Admins_set_a_user_limit_on_voice_channels_only()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        var stage = VoiceChannel(server, "talks", "stage");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        Assert.Equal("forbidden", (await alice.RequestAsync("channel.update", new { id = lounge, userLimit = 5 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = lounge, userLimit = 100 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = lounge, userLimit = -1 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = stage, userLimit = 5 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = server.General, userLimit = 5 })).ErrorCode());

        var updated = (await admin.RequestAsync("channel.update", new { id = lounge, userLimit = 5 })).Body().GetProperty("channel");
        Assert.Equal(5, updated.GetProperty("userLimit").GetInt32());
        var channels = (await alice.EventAsync("channels")).Body().GetProperty("channels");
        Assert.Equal(5, channels.EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == lounge).GetProperty("userLimit").GetInt32());

        // New channels can start with one; newcomers see it in the welcome.
        var created = (await admin.RequestAsync("channel.create", new { name = "duo", kind = "voice", userLimit = 2 })).Body().GetProperty("channel");
        Assert.Equal(2, created.GetProperty("userLimit").GetInt32());
        using var bob = await server.JoinAsync("Bob");
        var welcome = bob.Welcome.Body().GetProperty("channels").EnumerateArray().ToList();
        Assert.Equal(5, welcome.Single(c => c.GetProperty("id").GetInt64() == lounge).GetProperty("userLimit").GetInt32());
        Assert.Equal(0, welcome.Single(c => c.GetProperty("id").GetInt64() == server.General).GetProperty("userLimit").GetInt32());

        // 0 removes it, and the audit log keeps the change.
        await SetLimit(admin, lounge, 0);
        Assert.Equal(0, server.World.Store.UserLimit(lounge));
        var audit = (await admin.RequestAsync("audit.list", new { action = "channel.update" })).Body().GetProperty("entries");
        Assert.Contains(audit.EnumerateArray(), e => e.GetProperty("details").GetProperty("changes").TryGetProperty("userLimit", out _));
    }

    [Fact]
    public async Task A_full_channel_refuses_tokens_except_to_people_who_can_move_members()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var mod = await server.JoinAsync("Mod");
        await SetLimit(owner, lounge, 2);

        Assert.Equal("result", (await alice.RequestAsync("voice.join", new { channelId = lounge })).Type());
        await Joined(server, lounge, alice.Key);
        Assert.Equal("result", (await bob.RequestAsync("voice.join", new { channelId = lounge })).Type());
        await Joined(server, lounge, bob.Key);

        var full = await carol.RequestAsync("voice.join", new { channelId = lounge });
        Assert.Equal("channel_full", full.ErrorCode());
        Assert.Contains("full", full.Body().GetProperty("message").GetString());
        // Someone already inside doesn't count against themselves (reconnecting).
        Assert.Equal("result", (await alice.RequestAsync("voice.join", new { channelId = lounge })).Type());

        // Admins, and anyone whose role can move members, still get in.
        Assert.Equal("result", (await owner.RequestAsync("voice.join", new { channelId = lounge })).Type());
        var role = (await owner.RequestAsync("role.create", new { name = "Mover", permissions = new[] { "moveMembers" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { role } });
        Assert.Equal("result", (await mod.RequestAsync("voice.join", new { channelId = lounge })).Type());

        // Someone leaves: there's room again.
        await Left(server, lounge, bob.Key);
        Assert.Equal("result", (await carol.RequestAsync("voice.join", new { channelId = lounge })).Type());
    }

    [Fact]
    public async Task LiveKit_joins_past_the_limit_are_removed()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await SetLimit(admin, lounge, 1);

        // Both got a token while the room was empty; only the first join sticks.
        await Joined(server, lounge, alice.Key);
        await Joined(server, lounge, bob.Key);
        Assert.Contains(($"voice-{lounge}", bob.Key), server.Voice.Removed);
        Assert.DoesNotContain(($"voice-{lounge}", alice.Key), server.Voice.Removed);

        // An admin is let through.
        await Joined(server, lounge, admin.Key);
        Assert.DoesNotContain(($"voice-{lounge}", admin.Key), server.Voice.Removed);
    }

    [Fact]
    public async Task A_moderator_can_move_someone_into_a_full_channel()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        var games = VoiceChannel(server, "games");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await SetLimit(admin, games, 1);
        await Joined(server, games, alice.Key);
        await Joined(server, lounge, bob.Key);

        Assert.Equal("channel_full", (await bob.RequestAsync("voice.join", new { channelId = games })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("voice.move", new { accountKey = bob.Key, channelId = games })).Type());
        Assert.Equal(games, (await bob.EventAsync("voice.moved")).Body().GetProperty("channelId").GetInt64());
        Assert.Equal("result", (await bob.RequestAsync("voice.join", new { channelId = games })).Type());
        await Joined(server, games, bob.Key);
        Assert.DoesNotContain(($"voice-{games}", bob.Key), server.Voice.Removed);
    }

    // ── Rules ────────────────────────────────────────────────────────────────

    private static async Task<JsonElement> UpdateRules(User admin, object body)
    {
        var result = await admin.RequestAsync("rules.update", body);
        Assert.Equal("result", result.Type());
        return result.Body().GetProperty("rules");
    }

    [Fact]
    public async Task Only_admins_write_rules_and_they_are_validated()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice", "trusted");

        Assert.Equal("forbidden", (await alice.RequestAsync("rules.update", new { text = "Be nice" })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("rules.update", new { required = true })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("rules.update", new { text = new string('a', 6001) })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("rules.update", new { text = "ok", welcome = new string('a', 501) })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("rules.update", new { text = "bad\u0007bell" })).ErrorCode());

        var rules = await UpdateRules(admin, new { text = "1. **Be nice**\n2. No spam", welcome = "Welcome to the crew!" });
        Assert.False(rules.GetProperty("required").GetBoolean());
        Assert.Equal("Welcome to the crew!", rules.GetProperty("welcome").GetString());
        var seen = (await alice.EventAsync("rules")).Body().GetProperty("rules");
        Assert.Equal("1. **Be nice**\n2. No spam", seen.GetProperty("text").GetString());
        Assert.False(seen.GetProperty("mustAgree").GetBoolean());
        // Not required: nothing to agree to, nothing gated.
        Assert.Equal("bad_request", (await alice.RequestAsync("rules.accept", new { version = 0 })).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Type());
    }

    [Fact]
    public async Task New_members_agree_before_writing_reacting_or_joining_voice()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var old = await server.JoinAsync("Old");
        var message = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "first" })).Body().GetProperty("message").GetProperty("id").GetInt64();

        // Turned on without asking everyone: people already here are fine.
        var rules = await UpdateRules(admin, new { text = "Be kind.", required = true });
        Assert.Equal(1, rules.GetProperty("version").GetInt32());
        Assert.False((await old.EventAsync("rules")).Body().GetProperty("rules").GetProperty("mustAgree").GetBoolean());
        Assert.Equal("result", (await old.RequestAsync("chat.send", new { channelId = server.General, text = "still here" })).Type());

        using var newbie = await server.JoinAsync("Newbie");
        var welcome = newbie.Welcome.Body().GetProperty("rules");
        Assert.True(welcome.GetProperty("mustAgree").GetBoolean());
        Assert.Equal("Be kind.", welcome.GetProperty("text").GetString());

        Assert.Equal("rules_required", (await newbie.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).ErrorCode());
        Assert.Equal("rules_required", (await newbie.RequestAsync("chat.react", new { id = message, emoji = "👍" })).ErrorCode());
        Assert.Equal("rules_required", (await newbie.RequestAsync("voice.join", new { channelId = lounge })).ErrorCode());
        Assert.Equal("rules_required", (await newbie.RequestAsync("invite.create", new { })).ErrorCode());
        // Reading works.
        Assert.Equal("result", (await newbie.RequestAsync("chat.history", new { channelId = server.General })).Type());
        Assert.Equal("result", (await newbie.RequestAsync("rules.get")).Type());

        // A LiveKit join with an old token is removed too.
        await Joined(server, lounge, newbie.Key);
        Assert.Contains(($"voice-{lounge}", newbie.Key), server.Voice.Removed);

        Assert.Equal("conflict", (await newbie.RequestAsync("rules.accept", new { version = 0 })).ErrorCode());
        var accepted = (await newbie.RequestAsync("rules.accept", new { version = 1 })).Body().GetProperty("rules");
        Assert.False(accepted.GetProperty("mustAgree").GetBoolean());
        Assert.Equal(1, accepted.GetProperty("agreedVersion").GetInt32());
        Assert.Equal("result", (await newbie.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Type());
        Assert.Equal("result", (await newbie.RequestAsync("voice.join", new { channelId = lounge })).Type());

        // Admins see how many agreed (the owner and bots don't count).
        var counts = (await admin.RequestAsync("rules.get")).Body().GetProperty("rules");
        Assert.Equal(3, counts.GetProperty("agreed").GetInt32());
        Assert.Equal(3, counts.GetProperty("members").GetInt32());
        Assert.Equal(JsonValueKind.Null, (await old.RequestAsync("rules.get")).Body().GetProperty("rules").GetProperty("agreed").ValueKind);
    }

    [Fact]
    public async Task Asking_everyone_again_gates_existing_members_but_not_the_editor_owner_or_bots()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var botInvite = (await admin.RequestAsync("bot.invite")).Body().GetProperty("invite").GetProperty("code").GetString()!;
        using var botIdentity = new TestIdentity();
        using var bot = await server.ConnectAsync();
        var hello = await bot.ReceiveAsync();
        var frame = botIdentity.AuthFrame(hello, "Dice", invite: botInvite);
        ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await bot.SendAsync(frame);
        Assert.Equal("welcome", (await bot.ReceiveAsync()).Type());

        // Turned on asking everyone, existing members included.
        var rules = await UpdateRules(admin, new { text = "Be kind.", required = true, reaccept = true });
        Assert.False(rules.GetProperty("mustAgree").GetBoolean()); // the editor agreed by writing them
        Assert.True((await alice.EventAsync("rules")).Body().GetProperty("rules").GetProperty("mustAgree").GetBoolean());
        Assert.False((await owner.EventAsync("rules")).Body().GetProperty("rules").GetProperty("mustAgree").GetBoolean());
        Assert.Equal("rules_required", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Type());
        Assert.Equal("result", (await bot.RequestAsync("chat.send", new { channelId = server.General, text = "🎲" })).Type());

        await alice.RequestAsync("rules.accept", new { version = 1 });
        // The owner and the bot aren't counted.
        var counts = (await admin.RequestAsync("rules.get")).Body().GetProperty("rules");
        Assert.Equal(2, counts.GetProperty("agreed").GetInt32());
        Assert.Equal(2, counts.GetProperty("members").GetInt32());
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "ok" })).Type());

        // A small edit keeps everyone's agreement; a material change can ask again.
        rules = await UpdateRules(admin, new { text = "Be kind!" });
        Assert.Equal(1, rules.GetProperty("version").GetInt32());
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "ok" })).Type());
        rules = await UpdateRules(admin, new { text = "Be kind. No spoilers.", reaccept = true });
        Assert.Equal(2, rules.GetProperty("version").GetInt32());
        Assert.Equal("rules_required", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).ErrorCode());

        // Turning it off lifts the gate; the audit log has every change.
        await UpdateRules(admin, new { required = false });
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "free" })).Type());
        var audit = (await admin.RequestAsync("audit.list", new { action = "rules.update" })).Body().GetProperty("entries");
        Assert.Equal(4, audit.GetArrayLength());
    }
}
