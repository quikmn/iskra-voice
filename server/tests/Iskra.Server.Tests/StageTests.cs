using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class StageTests
{
    private static long StageChannel(IskraServer server, string read = "member", string write = "member") =>
        server.World.Store.CreateChannel("town-hall", "stage", read, write, 0).Id;

    /// <summary>A participant_joined/left webhook, signed like LiveKit signs them.</summary>
    private static async Task Webhook(IskraServer server, string evt, long channel, string identity)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { @event = evt, room = new { name = $"voice-{channel}" }, participant = new { identity } });
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var token = LiveKitTokens.Sign(new JsonObject
        {
            ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = Convert.ToBase64String(SHA256.HashData(body)),
        }, server.Voice.ApiSecret);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        request.Headers.TryAddWithoutValidation("Authorization", token);
        using var response = await server.CreateClient().SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static Task Join(IskraServer server, long channel, User user) => Webhook(server, "participant_joined", channel, user.Key);
    private static Task Leave(IskraServer server, long channel, User user) => Webhook(server, "participant_left", channel, user.Key);

    /// <summary>Reads stage.state events until one matches.</summary>
    private static async Task<JsonElement> StateWhere(User user, Func<JsonElement, bool> match)
    {
        for (var i = 0; i < 20; i++)
        {
            var state = (await user.EventAsync("stage.state")).Body();
            if (match(state)) return state;
        }
        throw new Xunit.Sdk.XunitException("no matching stage.state");
    }

    private static string[] Keys(JsonElement state, string field) =>
        state.GetProperty(field).EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetProperty("accountKey").GetString()!).ToArray();

    private static bool Grants(IskraServer server, long channel, User user, bool canPublish)
    {
        lock (server.Voice.Permissions) return server.Voice.Permissions.Contains(($"voice-{channel}", user.Key, canPublish));
    }

    /// <summary>An admin who has joined the stage and started it.</summary>
    private static async Task<User> LiveStage(IskraServer server, long stage, string topic = "Game night")
    {
        var admin = await server.JoinAsync("Admin", "admin");
        await Join(server, stage, admin);
        var start = await admin.RequestAsync("stage.start", new { channelId = stage, topic });
        Assert.Null(start.ErrorCode());
        return admin;
    }

    [Fact]
    public async Task Everyone_joins_a_stage_listening_only()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await server.JoinAsync("Admin", "admin");

        var result = (await admin.RequestAsync("voice.join", new { channelId = stage })).Body();
        Assert.False(result.GetProperty("canSpeak").GetBoolean());
        var claims = LiveKitTokens.Verify(result.GetProperty("token").GetString()!, server.Voice.ApiKey, server.Voice.ApiSecret, DateTimeOffset.UtcNow)!.Value;
        Assert.False(claims.GetProperty("video").GetProperty("canPublish").GetBoolean());
        Assert.False(claims.GetProperty("video").GetProperty("canPublishData").GetBoolean());
        Assert.Equal($"voice-{stage}", claims.GetProperty("video").GetProperty("room").GetString());
    }

    [Fact]
    public async Task Admins_create_stages_and_everyone_sees_their_state()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var created = (await admin.RequestAsync("channel.create", new { name = "Town Hall", kind = "stage" })).Body().GetProperty("channel");
        Assert.Equal("stage", created.GetProperty("kind").GetString());
        var stage = created.GetProperty("id").GetInt64();

        using var bob = await server.JoinAsync("Bob");
        var snapshot = bob.Welcome.Body().GetProperty("stages").EnumerateArray().Single();
        Assert.Equal(stage, snapshot.GetProperty("channelId").GetInt64());
        Assert.False(snapshot.GetProperty("live").GetBoolean());
    }

    [Fact]
    public async Task A_moderator_in_the_room_starts_the_stage_and_speaks()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");

        Assert.Equal("bad_request", (await admin.RequestAsync("stage.start", new { channelId = stage, topic = "Hi" })).ErrorCode()); // not in the room
        await Join(server, stage, bob);
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.start", new { channelId = stage, topic = "Hi" })).ErrorCode());
        await Join(server, stage, admin);
        Assert.Equal("bad_request", (await admin.RequestAsync("stage.start", new { channelId = stage, topic = "  " })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("stage.start", new { channelId = stage, topic = new string('x', 121) })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("stage.start", new { channelId = server.General, topic = "Hi" })).ErrorCode());

        Assert.Null((await admin.RequestAsync("stage.start", new { channelId = stage, topic = "Friday game night" })).ErrorCode());
        var live = await StateWhere(bob, s => s.GetProperty("live").GetBoolean() && Keys(s, "speakers").Length == 1);
        Assert.Equal("Friday game night", live.GetProperty("topic").GetString());
        Assert.Equal([admin.Key], Keys(live, "speakers"));
        Assert.True(Grants(server, stage, admin, true));
        Assert.Equal("bad_request", (await admin.RequestAsync("stage.start", new { channelId = stage, topic = "Again" })).ErrorCode());

        Assert.Null((await admin.RequestAsync("stage.update", new { channelId = stage, topic = "Round two" })).ErrorCode());
        await StateWhere(bob, s => s.GetProperty("topic").GetString() == "Round two");
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.update", new { channelId = stage, topic = "Mine now" })).ErrorCode());

        // Someone connecting later sees it live.
        using var carol = await server.JoinAsync("Carol");
        var snapshot = carol.Welcome.Body().GetProperty("stages")[0];
        Assert.True(snapshot.GetProperty("live").GetBoolean());
        Assert.Equal("Round two", snapshot.GetProperty("topic").GetString());
    }

    [Fact]
    public async Task Raised_hands_are_accepted_and_speakers_step_down()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");

        Assert.Equal("bad_request", (await bob.RequestAsync("stage.hand", new { channelId = stage, raised = true })).ErrorCode()); // not in the room
        await Join(server, stage, bob);
        Assert.Null((await bob.RequestAsync("stage.hand", new { channelId = stage, raised = true })).ErrorCode());
        var queued = await StateWhere(admin, s => Keys(s, "hands").Contains(bob.Key));
        Assert.True(queued.GetProperty("hands")[0].GetProperty("raisedAt").GetInt64() > 0);

        // Only moderators accept; accepting tells LiveKit to let them publish.
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.False(Grants(server, stage, bob, true));
        Assert.Null((await admin.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.True(Grants(server, stage, bob, true));
        var speaking = await StateWhere(bob, s => Keys(s, "speakers").Contains(bob.Key));
        Assert.Empty(Keys(speaking, "hands"));
        Assert.Equal("bad_request", (await bob.RequestAsync("stage.hand", new { channelId = stage, raised = true })).ErrorCode());

        // Stepping down takes the right back.
        Assert.Null((await bob.RequestAsync("stage.audience", new { channelId = stage })).ErrorCode());
        Assert.True(Grants(server, stage, bob, false));
        await StateWhere(admin, s => !Keys(s, "speakers").Contains(bob.Key));

        // A declined hand just goes down.
        await bob.RequestAsync("stage.hand", new { channelId = stage, raised = true });
        await StateWhere(admin, s => Keys(s, "hands").Contains(bob.Key));
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.decline", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.Null((await admin.RequestAsync("stage.decline", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        var lowered = await StateWhere(admin, s => !Keys(s, "hands").Contains(bob.Key));
        Assert.DoesNotContain(bob.Key, Keys(lowered, "speakers"));
    }

    [Fact]
    public async Task Moderators_move_speakers_to_the_audience_mute_and_remove_them()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await Join(server, stage, bob);
        await Join(server, stage, carol);
        await admin.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key });

        // Listeners can't touch speakers.
        Assert.Equal("forbidden", (await carol.RequestAsync("stage.audience", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.Equal("forbidden", (await carol.RequestAsync("stage.mute", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.Equal("forbidden", (await carol.RequestAsync("stage.remove", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.Equal("forbidden", (await carol.RequestAsync("stage.end", new { channelId = stage })).ErrorCode());

        Assert.Null((await admin.RequestAsync("stage.mute", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.Contains(($"voice-{stage}", bob.Key), server.Voice.Muted);
        Assert.Equal("bad_request", (await admin.RequestAsync("stage.mute", new { channelId = stage, accountKey = carol.Key })).ErrorCode()); // not speaking

        Assert.Null((await admin.RequestAsync("stage.audience", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.True(Grants(server, stage, bob, false));

        Assert.Null((await admin.RequestAsync("stage.remove", new { channelId = stage, accountKey = carol.Key })).ErrorCode());
        Assert.Contains(($"voice-{stage}", carol.Key), server.Voice.Removed);
        Assert.Equal("not_found", (await admin.RequestAsync("stage.remove", new { channelId = stage, accountKey = "not-here" })).ErrorCode());
    }

    [Fact]
    public async Task Admins_pick_stage_moderators_who_cannot_act_on_admins()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await Join(server, stage, bob);
        await Join(server, stage, carol);

        Assert.Equal("forbidden", (await bob.RequestAsync("stage.moderator", new { channelId = stage, accountKey = bob.Key, on = true })).ErrorCode());
        Assert.Null((await admin.RequestAsync("stage.moderator", new { channelId = stage, accountKey = bob.Key, on = true })).ErrorCode());
        await StateWhere(bob, s => Keys(s, "moderators").Contains(bob.Key));
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.moderator", new { channelId = stage, accountKey = carol.Key, on = true })).ErrorCode());

        // Bob moderates now: he can bring Carol up and send her back, and himself.
        Assert.Null((await bob.RequestAsync("stage.invite", new { channelId = stage, accountKey = carol.Key })).ErrorCode());
        Assert.True(Grants(server, stage, carol, true));
        Assert.Null((await bob.RequestAsync("stage.audience", new { channelId = stage, accountKey = carol.Key })).ErrorCode());
        Assert.Null((await bob.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key })).ErrorCode());

        // ...but not the admin.
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.audience", new { channelId = stage, accountKey = admin.Key })).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.mute", new { channelId = stage, accountKey = admin.Key })).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.remove", new { channelId = stage, accountKey = admin.Key })).ErrorCode());

        // Moderators are per stage.
        var other = server.World.Store.CreateChannel("other-stage", "stage", "member", "member", 0).Id;
        await Join(server, other, bob);
        Assert.Equal("forbidden", (await bob.RequestAsync("stage.start", new { channelId = other, topic = "Mine" })).ErrorCode());

        // Taking moderation away from someone who couldn't otherwise speak sends them back to the audience.
        server.World.Store.UpdateChannel(server.World.Store.GetChannel(stage)! with { WriteRole = "trusted" });
        Assert.Null((await admin.RequestAsync("stage.moderator", new { channelId = stage, accountKey = bob.Key, on = false })).ErrorCode());
        var stages = server.Services.GetRequiredService<VoiceRegistry>().Stages;
        Assert.False(stages.IsSpeaker(stage, bob.Key));
        Assert.True(stages.IsSpeaker(stage, admin.Key));
        Assert.True(Grants(server, stage, bob, false));
    }

    [Fact]
    public async Task Listen_only_members_cannot_ask_to_speak()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server, write: "trusted");
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");
        await Join(server, stage, bob);

        Assert.Equal("forbidden", (await bob.RequestAsync("stage.hand", new { channelId = stage, raised = true })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        Assert.False(Grants(server, stage, bob, true));
    }

    [Fact]
    public async Task Leaving_drops_speakers_and_hands_and_an_empty_stage_ends()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await Join(server, stage, bob);
        await Join(server, stage, carol);
        await admin.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key });
        await carol.RequestAsync("stage.hand", new { channelId = stage, raised = true });

        await Leave(server, stage, bob);
        await Leave(server, stage, carol);
        var left = await StateWhere(admin, s => Keys(s, "speakers").Length == 1 && Keys(s, "hands").Length == 0);
        Assert.True(left.GetProperty("live").GetBoolean());

        // Coming back, they're in the audience again.
        await Join(server, stage, bob);
        Assert.False(server.Services.GetRequiredService<VoiceRegistry>().Stages.IsSpeaker(stage, bob.Key));
        await Leave(server, stage, bob);
        await Leave(server, stage, admin);
        var ended = await StateWhere(admin, s => !s.GetProperty("live").GetBoolean());
        Assert.Empty(Keys(ended, "speakers"));
        Assert.Equal(JsonValueKind.Null, ended.GetProperty("topic").ValueKind);
    }

    [Fact]
    public async Task Ending_a_stage_sends_everyone_off()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");
        await Join(server, stage, bob);

        Assert.Null((await admin.RequestAsync("stage.end", new { channelId = stage })).ErrorCode());
        await StateWhere(bob, s => !s.GetProperty("live").GetBoolean());
        Assert.Contains(($"voice-{stage}", bob.Key), server.Voice.Removed);
        Assert.Contains(($"voice-{stage}", admin.Key), server.Voice.Removed);
        Assert.Equal("bad_request", (await admin.RequestAsync("stage.end", new { channelId = stage })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("stage.hand", new { channelId = stage, raised = true })).ErrorCode());
    }

    [Fact]
    public async Task If_LiveKit_cannot_be_told_nobody_gets_to_speak_and_revoking_fails_closed()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await Join(server, stage, bob);
        await Join(server, stage, carol);
        await admin.RequestAsync("stage.invite", new { channelId = stage, accountKey = carol.Key });

        server.Voice.FailUpdates = true;
        Assert.Equal("voice_unavailable", (await admin.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key })).ErrorCode());
        await StateWhere(admin, s => Keys(s, "speakers").Length == 2 && !Keys(s, "speakers").Contains(bob.Key));

        // Can't take Carol's right away through the API: she's removed from the room instead.
        Assert.Null((await admin.RequestAsync("stage.audience", new { channelId = stage, accountKey = carol.Key })).ErrorCode());
        Assert.Contains(($"voice-{stage}", carol.Key), server.Voice.Removed);
    }

    [Fact]
    public async Task Demotion_and_kicks_take_away_the_right_to_speak()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server, write: "trusted");
        using var owner = await server.JoinAsync("Owner", "owner");
        await Join(server, stage, owner);
        await owner.RequestAsync("stage.start", new { channelId = stage, topic = "AMA" });
        using var bob = await server.JoinAsync("Bob", "trusted");
        await Join(server, stage, bob);
        await owner.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key });
        Assert.True(Grants(server, stage, bob, true));

        await owner.RequestAsync("member.setRole", new { accountKey = bob.Key, role = "member" });
        await StateWhere(owner, s => !Keys(s, "speakers").Contains(bob.Key));
        Assert.True(Grants(server, stage, bob, false));

        // A kicked moderator stops being one, even if they come back.
        await owner.RequestAsync("stage.moderator", new { channelId = stage, accountKey = bob.Key, on = true });
        await owner.RequestAsync("member.kick", new { accountKey = bob.Key });
        Assert.Empty(server.World.Store.StageModerators(stage));
    }

    [Fact]
    public async Task Only_speakers_play_sounds_on_a_stage()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server);
        using var admin = await LiveStage(server, stage);
        using var bob = await server.JoinAsync("Bob");
        await Join(server, stage, bob);
        server.World.Store.AddSound(new Iskra.Server.Storage.Sound("s1", "airhorn", null, "file", 1000, admin.Key, 0));

        Assert.Equal("forbidden", (await bob.RequestAsync("sound.play", new { id = "s1" })).ErrorCode());
    }

    [Fact]
    public async Task Hidden_stages_stay_hidden()
    {
        using var server = new IskraServer();
        var stage = StageChannel(server, read: "admin", write: "admin");
        using var bob = await server.JoinAsync("Bob");
        Assert.Empty(bob.Welcome.Body().GetProperty("stages").EnumerateArray());
        Assert.Equal("not_found", (await bob.RequestAsync("stage.hand", new { channelId = stage, raised = true })).ErrorCode());

        using var admin = await LiveStage(server, stage);
        await bob.NoEventAsync("stage.state");
    }

    [Theory]
    [InlineData("""{"sid":"TR_1"}""", true)] // protojson leaves out AUDIO (0)
    [InlineData("""{"sid":"TR_1","source":"MICROPHONE"}""", true)]
    [InlineData("""{"sid":"TR_1","type":"AUDIO","source":"SCREEN_SHARE_AUDIO"}""", false)]
    [InlineData("""{"sid":"TR_1","type":"VIDEO","source":"CAMERA"}""", false)]
    [InlineData("""{"sid":"TR_1","type":"VIDEO"}""", false)]
    public void Server_mutes_only_microphone_tracks(string track, bool mic) =>
        Assert.Equal(mic, LiveKitHost.IsMicrophone(JsonDocument.Parse(track).RootElement));
}
