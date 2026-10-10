using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;

namespace Iskra.Server.Tests;

public class VoiceTests
{
    private static long VoiceChannel(IskraServer server, string name = "lounge", string read = "member", string write = "member") =>
        server.World.Store.CreateChannel(name, "voice", read, write, 0).Id;

    private static JsonElement Claims(IskraServer server, string token) =>
        LiveKitTokens.Verify(token, server.Voice.ApiKey, server.Voice.ApiSecret, DateTimeOffset.UtcNow)
        ?? throw new Xunit.Sdk.XunitException("token did not verify");

    /// <summary>Sends a LiveKit-style webhook, signed (or not) like LiveKit does.</summary>
    private static async Task<HttpStatusCode> Webhook(IskraServer server, object evt, bool sign = true, string? secret = null, bool tamper = false)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(evt);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        if (sign)
        {
            var hash = Convert.ToBase64String(SHA256.HashData(tamper ? [.. body, (byte)' '] : body));
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var token = LiveKitTokens.Sign(new JsonObject { ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = hash },
                secret ?? server.Voice.ApiSecret);
            request.Headers.TryAddWithoutValidation("Authorization", token);
        }
        using var response = await server.CreateClient().SendAsync(request);
        return response.StatusCode;
    }

    private static object Joined(long channel, string identity) =>
        new { @event = "participant_joined", room = new { name = $"voice-{channel}" }, participant = new { identity } };

    private static object Left(long channel, string identity) =>
        new { @event = "participant_left", room = new { name = $"voice-{channel}" }, participant = new { identity } };

    [Fact]
    public async Task Joining_voice_returns_a_token_for_that_room_only()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var alice = await server.JoinAsync("Alice");

        var result = (await alice.RequestAsync("voice.join", new { channelId = lounge })).Body();
        Assert.Equal("ws://voice.test:7880", result.GetProperty("url").GetString());
        Assert.True(result.GetProperty("canSpeak").GetBoolean());

        var claims = Claims(server, result.GetProperty("token").GetString()!);
        Assert.Equal(alice.Key, claims.GetProperty("sub").GetString());
        Assert.Equal("Alice", claims.GetProperty("name").GetString());
        var video = claims.GetProperty("video");
        Assert.Equal($"voice-{lounge}", video.GetProperty("room").GetString());
        Assert.True(video.GetProperty("roomJoin").GetBoolean());
        Assert.True(video.GetProperty("canPublish").GetBoolean());
        Assert.False(video.TryGetProperty("roomAdmin", out _));
    }

    [Fact]
    public async Task Listen_only_channels_give_listen_only_tokens()
    {
        using var server = new IskraServer();
        var stage = VoiceChannel(server, "stage", read: "member", write: "trusted");
        using var member = await server.JoinAsync("Member");
        var result = (await member.RequestAsync("voice.join", new { channelId = stage })).Body();
        Assert.False(result.GetProperty("canSpeak").GetBoolean());
        Assert.False(Claims(server, result.GetProperty("token").GetString()!).GetProperty("video").GetProperty("canPublish").GetBoolean());
    }

    [Fact]
    public async Task Voice_join_checks_channel_and_availability()
    {
        using var server = new IskraServer();
        var secret = VoiceChannel(server, "staff-voice", read: "admin", write: "admin");
        var lounge = VoiceChannel(server);
        using var member = await server.JoinAsync("Member");

        Assert.Equal("not_found", (await member.RequestAsync("voice.join", new { channelId = secret })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("voice.join", new { channelId = server.General })).ErrorCode());

        server.Voice.Available = false;
        Assert.Equal("voice_unavailable", (await member.RequestAsync("voice.join", new { channelId = lounge })).ErrorCode());
    }

    [Fact]
    public async Task Webhooks_must_be_signed_with_the_world_secret()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var alice = await server.JoinAsync("Alice");

        Assert.Equal(HttpStatusCode.Unauthorized, await Webhook(server, Joined(lounge, alice.Key), sign: false));
        Assert.Equal(HttpStatusCode.Unauthorized, await Webhook(server, Joined(lounge, alice.Key), secret: "wrong-secret-wrong-secret-wrong"));
        Assert.Equal(HttpStatusCode.Unauthorized, await Webhook(server, Joined(lounge, alice.Key), tamper: true));
        await alice.NoEventAsync("voice.state");
    }

    [Fact]
    public async Task Joins_and_leaves_from_LiveKit_are_broadcast_to_channel_readers()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        var staff = VoiceChannel(server, "staff-voice", read: "admin", write: "admin");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        Assert.Equal(HttpStatusCode.OK, await Webhook(server, Joined(lounge, bob.Key)));
        var state = (await admin.EventAsync("voice.state")).Body();
        Assert.Equal(lounge, state.GetProperty("channelId").GetInt64());
        Assert.Equal(bob.Key, state.GetProperty("participants")[0].GetProperty("accountKey").GetString());

        await bob.RequestAsync("voice.state", new { muted = true, deafened = false });
        var muted = (await admin.EventAsync("voice.state")).Body().GetProperty("participants")[0];
        Assert.True(muted.GetProperty("muted").GetBoolean());

        // Who is in a private voice channel doesn't leak either.
        await Webhook(server, Joined(staff, admin.Key));
        Assert.Equal(staff, (await admin.EventAsync("voice.state")).Body().GetProperty("channelId").GetInt64());
        await bob.EventAsync("voice.state"); // his own join
        await bob.EventAsync("voice.state"); // his own mute update
        await bob.NoEventAsync("voice.state");

        await Webhook(server, Left(lounge, bob.Key));
        var empty = (await admin.EventAsync("voice.state")).Body();
        Assert.Equal(0, empty.GetProperty("participants").GetArrayLength());

        // Someone joining later sees who's in voice right away.
        using var carol = await server.JoinAsync("Carol", "admin");
        var snapshot = carol.Welcome.Body().GetProperty("voice");
        Assert.Contains(snapshot.EnumerateArray(), v => v.GetProperty("channelId").GetInt64() == staff);
    }

    [Fact]
    public async Task Strangers_reported_by_LiveKit_are_removed_not_shown()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var alice = await server.JoinAsync("Alice");

        await Webhook(server, Joined(lounge, "not-a-member"));
        await alice.NoEventAsync("voice.state");
        Assert.Contains(($"voice-{lounge}", "not-a-member"), server.Voice.Removed);
    }

    [Fact]
    public async Task Kicking_someone_also_drops_them_from_voice()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        await Webhook(server, Joined(lounge, bob.Key));
        await admin.EventAsync("voice.state");

        await admin.RequestAsync("member.kick", new { accountKey = bob.Key });
        Assert.Contains(($"voice-{lounge}", bob.Key), server.Voice.Removed);
        var state = (await admin.EventAsync("voice.state")).Body();
        Assert.Equal(0, state.GetProperty("participants").GetArrayLength());
    }

    [Fact]
    public async Task Demotion_out_of_a_private_voice_channel_drops_them()
    {
        using var server = new IskraServer();
        var staff = VoiceChannel(server, "staff-voice", read: "trusted", write: "trusted");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob", "trusted");
        await Webhook(server, Joined(staff, bob.Key));

        await owner.RequestAsync("member.setRole", new { accountKey = bob.Key, role = "member" });
        Assert.Contains(($"voice-{staff}", bob.Key), server.Voice.Removed);
    }

    [Fact]
    public void Default_voice_url_follows_the_server_url()
    {
        Assert.Equal("ws://localhost:7070/livekit", LiveKitHost.DefaultClientUrl("http://localhost:7070"));
        Assert.Equal("wss://chat.example.com/livekit", LiveKitHost.DefaultClientUrl("https://chat.example.com"));
        Assert.True(LiveKitHost.IsLocalOnly("http://localhost:7070"));
        Assert.True(LiveKitHost.IsLocalOnly("http://192.168.1.20:7070"));
        Assert.False(LiveKitHost.IsLocalOnly("https://chat.example.com"));
        Assert.False(LiveKitHost.IsLocalOnly("http://203.0.113.5:7070"));
    }
}
