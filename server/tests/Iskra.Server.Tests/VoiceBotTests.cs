using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class VoiceBotTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task<User> JoinBot(IskraServer server, User admin, bool voice, string name = "Jukebox", string role = "member")
    {
        var code = (await admin.RequestAsync("bot.invite", new { role, voice })).Body().GetProperty("invite").GetProperty("code").GetString()!;
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

    private static long VoiceChannel(IskraServer server, string name = "lounge", string kind = "voice", string write = "member") =>
        server.World.Store.CreateChannel(name, kind, "member", write, 0).Id;

    private static JsonElement Grant(IskraServer server, JsonElement joined) =>
        (LiveKitTokens.Verify(joined.GetProperty("token").GetString()!, server.Voice.ApiKey, server.Voice.ApiSecret, DateTimeOffset.UtcNow)
            ?? throw new Xunit.Sdk.XunitException("token did not verify")).GetProperty("video");

    private static void Webhook(IskraServer server, string type, long channel, string identity)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { @event = type, room = new { name = $"voice-{channel}" }, participant = new { identity } }));
        server.Services.GetRequiredService<VoiceRegistry>().HandleWebhook(doc.RootElement, Now);
    }

    [Fact]
    public async Task Bots_join_voice_only_when_an_admin_allows_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var lounge = VoiceChannel(server);
        using var quiet = await JoinBot(server, admin, voice: false, "Quiet");

        Assert.False(quiet.Welcome.Body().GetProperty("you").GetProperty("joinsVoice").GetBoolean());
        Assert.Equal(JsonValueKind.Null, alice.Welcome.Body().GetProperty("you").GetProperty("joinsVoice").ValueKind);
        var refused = (await quiet.RequestAsync("voice.join", new { channelId = lounge })).Body();
        Assert.Equal("forbidden", refused.GetProperty("code").GetString());
        Assert.Equal("bot_no_voice", refused.GetProperty("key").GetString());

        // Joining anyway (a token from elsewhere): LiveKit's webhook takes it out again.
        Webhook(server, "participant_joined", lounge, quiet.Key);
        Assert.Contains(($"voice-{lounge}", quiet.Key), server.Voice.Removed);
        Assert.Null(server.Services.GetRequiredService<VoiceRegistry>().ChannelOfMember(quiet.Key));

        // Only admins change it, only for bots.
        Assert.Equal("forbidden", (await alice.RequestAsync("bot.voice.set", new { accountKey = quiet.Key, voice = true })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("bot.voice.set", new { accountKey = alice.Key, voice = true })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("bot.voice.set", new { accountKey = quiet.Key })).ErrorCode());

        var set = (await admin.RequestAsync("bot.voice.set", new { accountKey = quiet.Key, voice = true })).Body();
        Assert.True(set.GetProperty("member").GetProperty("joinsVoice").GetBoolean());
        var updated = (await alice.EventAsync("member.updated")).Body().GetProperty("member");
        while (updated.GetProperty("accountKey").GetString() != quiet.Key || !updated.GetProperty("joinsVoice").GetBoolean())
            updated = (await alice.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.Equal("result", (await quiet.RequestAsync("voice.join", new { channelId = lounge })).Type());

        var audit = server.World.Store.Audit(null, null, null, 50).Select(a => a.Action).ToList();
        Assert.Contains("bot.voice", audit);
    }

    [Fact]
    public async Task A_bots_token_publishes_audio_only_and_never_subscribes()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var lounge = VoiceChannel(server);
        var listenOnly = VoiceChannel(server, "radio", write: "trusted");
        using var bot = await JoinBot(server, admin, voice: true);
        Assert.True(bot.Welcome.Body().GetProperty("you").GetProperty("joinsVoice").GetBoolean());

        var joined = (await bot.RequestAsync("voice.join", new { channelId = lounge })).Body();
        Assert.True(joined.GetProperty("canSpeak").GetBoolean());
        var grant = Grant(server, joined);
        Assert.Equal($"voice-{lounge}", grant.GetProperty("room").GetString());
        Assert.True(grant.GetProperty("canPublish").GetBoolean());
        Assert.False(grant.GetProperty("canSubscribe").GetBoolean());
        Assert.False(grant.GetProperty("canPublishData").GetBoolean());
        Assert.Equal(["microphone"], grant.GetProperty("canPublishSources").EnumerateArray().Select(s => s.GetString()).ToArray());

        // People keep their usual grants.
        var person = Grant(server, (await alice.RequestAsync("voice.join", new { channelId = lounge })).Body());
        Assert.True(person.GetProperty("canSubscribe").GetBoolean());
        Assert.False(person.TryGetProperty("canPublishSources", out _));

        // Channel permissions apply as for people: a bot that can't post there can't play there.
        var quiet = (await bot.RequestAsync("voice.join", new { channelId = listenOnly })).Body();
        Assert.False(quiet.GetProperty("canSpeak").GetBoolean());
        Assert.False(Grant(server, quiet).GetProperty("canPublish").GetBoolean());
    }

    [Fact]
    public async Task Bots_never_join_stages_encrypted_channels_or_full_channels()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        var stage = VoiceChannel(server, "talks", kind: "stage");
        var secret = VoiceChannel(server, "secret");
        server.World.Store.SaveE2eeChange(new E2eeChannel(secret, "chain-secret", 1, "head", [owner.Key], Now),
            new E2eeChange(1, "payload", "sig", owner.Key, Now), [], fresh: true);
        var small = VoiceChannel(server, "small");
        server.World.Store.SetUserLimit(small, 1);
        using var bot = await JoinBot(server, owner, voice: true);

        var onStage = (await bot.RequestAsync("voice.join", new { channelId = stage })).Body();
        Assert.Equal("bot_stage", onStage.GetProperty("key").GetString());
        var encrypted = (await bot.RequestAsync("voice.join", new { channelId = secret })).Body();
        Assert.Equal("bot_e2ee_voice", encrypted.GetProperty("key").GetString());

        Webhook(server, "participant_joined", small, alice.Key);
        Assert.Equal("channel_full", (await bot.RequestAsync("voice.join", new { channelId = small })).ErrorCode());

        // The webhook check holds the same line.
        Webhook(server, "participant_joined", stage, bot.Key);
        Webhook(server, "participant_joined", secret, bot.Key);
        Assert.Contains(($"voice-{stage}", bot.Key), server.Voice.Removed);
        Assert.Contains(($"voice-{secret}", bot.Key), server.Voice.Removed);

        // Timed out: no voice either.
        await owner.RequestAsync("member.timeout", new { accountKey = bot.Key, durationMs = 60_000 });
        Assert.Equal("forbidden", (await bot.RequestAsync("voice.join", new { channelId = VoiceChannel(server, "other") })).ErrorCode());
    }

    [Fact]
    public async Task Moderators_mute_and_disconnect_bots_and_turning_voice_off_takes_them_out()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        var lounge = VoiceChannel(server);
        var registry = server.Services.GetRequiredService<VoiceRegistry>();
        using var bot = await JoinBot(server, owner, voice: true);

        Webhook(server, "participant_joined", lounge, bot.Key);
        Assert.Equal(lounge, registry.ChannelOfMember(bot.Key));

        // A server mute keeps the bot's audio-only grants.
        Assert.Equal("result", (await owner.RequestAsync("voice.mute", new { accountKey = bot.Key, muted = true })).Type());
        Assert.Contains(($"voice-{lounge}", bot.Key, false), server.Voice.BotPermissions);
        Assert.DoesNotContain(server.Voice.Permissions, p => p.Identity == bot.Key);
        Assert.False((await bot.RequestAsync("voice.join", new { channelId = lounge })).Body().GetProperty("canSpeak").GetBoolean());
        await owner.RequestAsync("voice.mute", new { accountKey = bot.Key, muted = false });
        Assert.Contains(($"voice-{lounge}", bot.Key, true), server.Voice.BotPermissions);

        // Disconnect: moveMembers only.
        Assert.Equal("forbidden", (await alice.RequestAsync("voice.disconnect", new { accountKey = bot.Key })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("voice.disconnect", new { accountKey = bot.Key })).Type());
        Assert.Equal(lounge, (await bot.EventAsync("voice.disconnected")).Body().GetProperty("channelId").GetInt64());
        Assert.Contains(($"voice-{lounge}", bot.Key), server.Voice.Removed);
        Assert.Null(registry.ChannelOfMember(bot.Key));
        Assert.Equal("bad_request", (await owner.RequestAsync("voice.disconnect", new { accountKey = bot.Key })).ErrorCode()); // not in voice
        Assert.Contains("voice.disconnect", server.World.Store.Audit(null, null, null, 50).Select(a => a.Action));

        // People can be disconnected too.
        Webhook(server, "participant_joined", lounge, alice.Key);
        Assert.Equal("result", (await owner.RequestAsync("voice.disconnect", new { accountKey = alice.Key })).Type());
        Assert.Equal(lounge, (await alice.EventAsync("voice.disconnected")).Body().GetProperty("channelId").GetInt64());

        // Turning voice off takes the bot out at once.
        Webhook(server, "participant_joined", lounge, bot.Key);
        server.Voice.Removed.Clear();
        await owner.RequestAsync("bot.voice.set", new { accountKey = bot.Key, voice = false });
        Assert.Equal(lounge, (await bot.EventAsync("voice.disconnected")).Body().GetProperty("channelId").GetInt64());
        Assert.Contains(($"voice-{lounge}", bot.Key), server.Voice.Removed);
        Assert.Equal("forbidden", (await bot.RequestAsync("voice.join", new { channelId = lounge })).ErrorCode());
    }

    [Fact]
    public async Task Built_in_bots_never_join_voice()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        Assert.Equal("result", (await owner.RequestAsync("builtin.bots.set", new { bot = "dice", enabled = true })).Type());
        var dice = server.World.Store.AllMembers().First(m => server.World.Store.BuiltinIdOf(m.AccountKey) == "dice");
        Assert.Equal("bad_request", (await owner.RequestAsync("bot.voice.set", new { accountKey = dice.AccountKey, voice = true })).ErrorCode());
    }
}
