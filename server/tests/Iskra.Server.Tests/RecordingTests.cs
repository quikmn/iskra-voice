using System.Text.Json;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Recording a voice channel: who may, the mark everyone sees (late joiners too), "don't record me", encrypted consent, ends.</summary>
public class RecordingTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static long VoiceChannel(IskraServer server, string name = "lounge", string kind = "voice") =>
        server.World.Store.CreateChannel(name, kind, "member", "member", 0).Id;

    private static VoiceRegistry Voice(IskraServer server) => server.Services.GetRequiredService<VoiceRegistry>();

    private static void Webhook(IskraServer server, string type, long channel, string identity)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { @event = type, room = new { name = $"voice-{channel}" }, participant = new { identity } }));
        Voice(server).HandleWebhook(doc.RootElement, Now);
    }

    private static void Joined(IskraServer server, long channel, User user) => Webhook(server, "participant_joined", channel, user.Key);
    private static void Left(IskraServer server, long channel, User user) => Webhook(server, "participant_left", channel, user.Key);

    private static string? Key(JsonElement reply) =>
        reply.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    /// <summary>Reads voice.state events for the channel until one matches.</summary>
    private static async Task<JsonElement> Until(User user, long channel, Func<JsonElement, bool> match)
    {
        while (true)
        {
            var state = (await user.EventAsync("voice.state")).Body();
            if (state.GetProperty("channelId").GetInt64() == channel && match(state)) return state;
        }
    }

    private static bool Recording(JsonElement state) => state.GetProperty("recording").ValueKind == JsonValueKind.Object;
    private static bool NotRecording(JsonElement state) => state.GetProperty("recording").ValueKind == JsonValueKind.Null;

    private static JsonElement Participant(JsonElement state, string key) =>
        state.GetProperty("participants").EnumerateArray().Single(p => p.GetProperty("accountKey").GetString() == key);

    private static async Task<JsonElement> AuditEntries(User admin, string action) =>
        (await admin.RequestAsync("audit.list", new { action })).Body().GetProperty("entries");

    [Fact]
    public async Task Only_people_with_the_permission_in_the_call_start_it_and_everyone_who_can_see_the_channel_sees_it()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        // Members can't by default; admins can, but only from inside the call; only voice channels.
        Joined(server, lounge, bob);
        var refused = await bob.RequestAsync("voice.record.start", new { channelId = lounge });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("record_forbidden", Key(refused));
        Assert.Equal("voice_join_first", Key(await admin.RequestAsync("voice.record.start", new { channelId = lounge })));
        Assert.Equal("bad_request", (await admin.RequestAsync("voice.record.start", new { channelId = server.General })).ErrorCode());

        Joined(server, lounge, admin);
        var started = await admin.RequestAsync("voice.record.start", new { channelId = lounge });
        Assert.Equal("result", started.Type());
        var recording = started.Body().GetProperty("recording");
        Assert.Equal(admin.Key, recording.GetProperty("by").GetString());
        Assert.True(recording.GetProperty("live").GetBoolean());
        Assert.False(recording.GetProperty("encrypted").GetBoolean());

        // Everyone who can see the channel is told, in the call or not.
        var seen = await Until(owner, lounge, Recording);
        Assert.Equal(admin.Key, seen.GetProperty("recording").GetProperty("by").GetString());
        await Until(bob, lounge, Recording);

        // Someone who connects later gets it in the welcome, before joining the call.
        using var carol = await server.JoinAsync("Carol");
        var voice = carol.Welcome.Body().GetProperty("voice").EnumerateArray().Single(v => v.GetProperty("channelId").GetInt64() == lounge);
        Assert.Equal(admin.Key, voice.GetProperty("recording").GetProperty("by").GetString());

        // One recording at a time.
        Joined(server, lounge, owner);
        var twice = await owner.RequestAsync("voice.record.start", new { channelId = lounge });
        Assert.Equal("record_already", Key(twice));
        Assert.Equal(admin.Key, twice.Body().GetProperty("args").GetProperty("by").GetString());

        // Bob can't stop someone else's recording; the recorder can. The audit log has both ends (never any content).
        Assert.Equal("record_stop_forbidden", Key(await bob.RequestAsync("voice.record.stop", new { channelId = lounge })));
        Assert.Equal("result", (await admin.RequestAsync("voice.record.stop", new { channelId = lounge })).Type());
        await Until(bob, lounge, NotRecording);
        var start = (await AuditEntries(owner, "voice.record.start")).EnumerateArray().Single();
        Assert.Equal(admin.Key, start.GetProperty("actor").GetString());
        Assert.Equal("lounge", start.GetProperty("details").GetProperty("channelName").GetString());
        var stop = (await AuditEntries(owner, "voice.record.stop")).EnumerateArray().Single();
        Assert.Equal("stopped", stop.GetProperty("details").GetProperty("why").GetString());
        // Stopping when nothing is recorded is fine.
        Assert.Equal("result", (await admin.RequestAsync("voice.record.stop", new { channelId = lounge })).Type());
    }

    [Fact]
    public async Task A_role_can_grant_it_and_taking_it_away_ends_the_recording()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var role = (await owner.RequestAsync("role.create", new { name = "Recorder", permissions = new[] { "recordVoice" } })).Body().GetProperty("role");
        Assert.Contains("recordVoice", role.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()));
        var roleId = role.GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = bob.Key, roles = new[] { roleId } });

        Joined(server, lounge, bob);
        Joined(server, lounge, owner);
        Assert.Equal("result", (await bob.RequestAsync("voice.record.start", new { channelId = lounge })).Type());
        await Until(owner, lounge, Recording);

        // Someone else with the permission (the owner) may end it too.
        // But first: losing the role ends it by itself.
        await owner.RequestAsync("member.roles.set", new { accountKey = bob.Key, roles = Array.Empty<long>() });
        await Until(owner, lounge, NotRecording);
        var stop = (await AuditEntries(owner, "voice.record.stop")).EnumerateArray().Single();
        Assert.Equal(bob.Key, stop.GetProperty("actor").GetString());
        Assert.Equal("permission", stop.GetProperty("details").GetProperty("why").GetString());
        Assert.Contains(server.LogLines, l => l.Contains("VOI-180") && l.Contains("why=permission"));
    }

    [Fact]
    public async Task Another_recorder_may_stop_it_and_it_ends_when_the_recorder_leaves_or_after_four_hours()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        Joined(server, lounge, admin);
        Joined(server, lounge, owner);

        Assert.Equal("result", (await admin.RequestAsync("voice.record.start", new { channelId = lounge })).Type());
        Assert.Equal("result", (await owner.RequestAsync("voice.record.stop", new { channelId = lounge })).Type());
        var stopped = (await AuditEntries(owner, "voice.record.stop")).EnumerateArray().Single();
        Assert.Equal(admin.Key, stopped.GetProperty("target").GetString());

        // The recorder leaves: it ends.
        Assert.Equal("result", (await admin.RequestAsync("voice.record.start", new { channelId = lounge })).Type());
        Left(server, lounge, admin);
        Assert.Null(Voice(server).Recordings.Get(lounge));

        // The longest recording is 4 hours.
        Joined(server, lounge, admin);
        Assert.Equal("result", (await admin.RequestAsync("voice.record.start", new { channelId = lounge })).Type());
        Voice(server).Recordings.Sweep(Now + RecordingRegistry.MaxMs - 60_000);
        Assert.NotNull(Voice(server).Recordings.Get(lounge));
        Voice(server).Recordings.Sweep(Now + RecordingRegistry.MaxMs + 1);
        Assert.Null(Voice(server).Recordings.Get(lounge));
        var whys = (await AuditEntries(owner, "voice.record.stop")).EnumerateArray().Select(e => e.GetProperty("details").GetProperty("why").GetString()).ToList();
        Assert.Contains("left", whys);
        Assert.Contains("max", whys);

        // LiveKit stopping ends it too.
        Joined(server, lounge, admin);
        Assert.Equal("result", (await admin.RequestAsync("voice.record.start", new { channelId = lounge })).Type());
        server.Voice.Available = false;
        Assert.Null(Voice(server).Recordings.Get(lounge));
    }

    [Fact]
    public async Task Dont_record_me_shows_for_everyone_and_lasts_across_calls()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        // Set before joining: it's for the account, not the call.
        Assert.Equal("result", (await bob.RequestAsync("voice.record.optout", new { optOut = true })).Type());
        Joined(server, lounge, admin);
        Joined(server, lounge, bob);
        var state = await Until(admin, lounge, s => s.GetProperty("participants").GetArrayLength() == 2);
        Assert.True(Participant(state, bob.Key).GetProperty("noRecord").GetBoolean());
        Assert.False(Participant(state, admin.Key).GetProperty("noRecord").GetBoolean());
        Assert.Equal(JsonValueKind.Null, Participant(state, bob.Key).GetProperty("recordConsent").ValueKind);

        Assert.Equal("result", (await bob.RequestAsync("voice.record.optout", new { optOut = false })).Type());
        state = await Until(admin, lounge, s => !Participant(s, bob.Key).GetProperty("noRecord").GetBoolean());
        // Without optOut: what the server has. It's stored for the account (from the handshake on, across restarts).
        Assert.False((await bob.RequestAsync("voice.record.optout", new { })).Body().GetProperty("optOut").GetBoolean());
        Assert.Equal("result", (await bob.RequestAsync("voice.record.optout", new { optOut = true })).Type());
        Assert.Contains(bob.Key, server.World.Store.RecordOptOuts());
        Assert.True((await bob.RequestAsync("voice.record.optout", new { })).Body().GetProperty("optOut").GetBoolean());
        // Answers are for encrypted channels only.
        Assert.Equal("record_none", Key(await bob.RequestAsync("voice.record.consent", new { channelId = lounge, agree = true })));
    }

    /// <summary>Joins with an app that says it shows recording marks (auth features: ["recording"]).</summary>
    private static async Task<User> JoinAware(IskraServer server, string name, string role = "member")
    {
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, name, invite: server.Invite(role));
        ((System.Text.Json.Nodes.JsonObject)frame["body"]!)["features"] = new System.Text.Json.Nodes.JsonArray("recording");
        await client.SendAsync(frame);
        return new User(identity, client, await client.ReceiveAsync());
    }

    [Fact]
    public async Task Only_apps_that_show_the_mark_are_recorded_and_the_chat_says_so_in_text()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var admin = await JoinAware(server, "Admin", "admin");
        using var newer = await JoinAware(server, "Newer");
        using var older = await server.JoinAsync("Older"); // an app from before recording: no features
        foreach (var u in new[] { admin, newer, older })
        {
            Assert.Equal("result", (await u.RequestAsync("voice.join", new { channelId = lounge })).Type());
            Joined(server, lounge, u);
        }
        var state = await Until(admin, lounge, s => s.GetProperty("participants").GetArrayLength() == 3);
        Assert.True(Participant(state, admin.Key).GetProperty("recordingAware").GetBoolean());
        Assert.True(Participant(state, newer.Key).GetProperty("recordingAware").GetBoolean());
        Assert.False(Participant(state, older.Key).GetProperty("recordingAware").GetBoolean());

        // Starting posts a line in the channel's chat, by the recorder, that every app shows as text.
        Assert.Equal("result", (await admin.RequestAsync("voice.record.start", new { channelId = lounge })).Type());
        var start = (await older.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal(admin.Key, start.GetProperty("author").GetString());
        Assert.Equal(lounge, start.GetProperty("channelId").GetInt64());
        Assert.Contains("Started recording", start.GetProperty("text").GetString());
        Assert.Equal("start", start.GetProperty("recordNotice").GetProperty("kind").GetString());
        // The recorder can't edit or take it down.
        var id = start.GetProperty("id").GetInt64();
        Assert.Equal("record_notice_delete", Key(await admin.RequestAsync("chat.delete", new { id })));
        Assert.Equal("bad_request", (await admin.RequestAsync("chat.edit", new { id, text = "nothing to see" })).ErrorCode());

        // Ending it, even by itself (the recorder leaves), posts the stop line.
        Left(server, lounge, admin);
        var stop = (await older.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("stop", stop.GetProperty("recordNotice").GetProperty("kind").GetString());
        Assert.Contains("Stopped recording", stop.GetProperty("text").GetString());
    }

    [Fact]
    public async Task Taking_the_permission_off_a_role_ends_the_recording_at_once()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var roleId = (await owner.RequestAsync("role.create", new { name = "Recorder", permissions = new[] { "recordVoice" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = bob.Key, roles = new[] { roleId } });
        Joined(server, lounge, bob);
        Assert.Equal("result", (await bob.RequestAsync("voice.record.start", new { channelId = lounge })).Type());
        Assert.NotNull(Voice(server).Recordings.Get(lounge));

        Assert.Equal("result", (await owner.RequestAsync("role.update", new { id = roleId, permissions = Array.Empty<string>() })).Type());
        Assert.Null(Voice(server).Recordings.Get(lounge));
        await Until(owner, lounge, NotRecording);
    }

    [Fact]
    public async Task Bots_cant_record()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        var code = (await owner.RequestAsync("bot.invite", new { role = "trusted", voice = true })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, "Jukebox", invite: code);
        ((System.Text.Json.Nodes.JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        using var bot = new User(identity, client, await client.ReceiveAsync());
        Webhook(server, "participant_joined", lounge, bot.Key);
        Assert.Equal("record_bot", Key(await bot.RequestAsync("voice.record.start", new { channelId = lounge })));
    }

    [Fact]
    public async Task Encrypted_channels_record_only_once_everyone_in_the_call_agrees()
    {
        using var t = await E2eeChannelTests.CreateAsync("voice");
        var voice = Voice(t.Server);
        Joined(t.Server, t.ChannelId, t.Owner);
        Joined(t.Server, t.ChannelId, t.Bob);

        var started = (await t.Owner.RequestAsync("voice.record.start", new { channelId = t.ChannelId })).Body().GetProperty("recording");
        Assert.True(started.GetProperty("encrypted").GetBoolean());
        Assert.False(started.GetProperty("live").GetBoolean());
        Assert.True(started.GetProperty("askUntil").GetInt64() > Now);
        var asked = await Until(t.Bob, t.ChannelId, Recording);
        Assert.True(Participant(asked, t.Owner.Key).GetProperty("recordConsent").GetBoolean());
        Assert.Equal(JsonValueKind.Null, Participant(asked, t.Bob.Key).GetProperty("recordConsent").ValueKind);

        // Bob agrees: everyone in the call said yes, so it starts.
        Assert.Equal("result", (await t.Bob.RequestAsync("voice.record.consent", new { channelId = t.ChannelId, agree = true })).Type());
        var live = await Until(t.Owner, t.ChannelId, s => Recording(s) && s.GetProperty("recording").GetProperty("live").GetBoolean());
        Assert.Equal(JsonValueKind.Null, live.GetProperty("recording").GetProperty("askUntil").ValueKind);

        // Carol joins later: she's asked too and left out until she says yes; her "no" leaves her out but the recording goes on.
        Joined(t.Server, t.ChannelId, t.Carol);
        var withCarol = await Until(t.Owner, t.ChannelId, s => s.GetProperty("participants").GetArrayLength() == 3);
        Assert.Equal(JsonValueKind.Null, Participant(withCarol, t.Carol.Key).GetProperty("recordConsent").ValueKind);
        Assert.Equal("result", (await t.Carol.RequestAsync("voice.record.consent", new { channelId = t.ChannelId, agree = false })).Type());
        var declined = await Until(t.Owner, t.ChannelId, s => Participant(s, t.Carol.Key).GetProperty("recordConsent").ValueKind == JsonValueKind.False);
        Assert.True(declined.GetProperty("recording").GetProperty("live").GetBoolean());

        // Bob leaves and comes back: he's asked again.
        Left(t.Server, t.ChannelId, t.Bob);
        Joined(t.Server, t.ChannelId, t.Bob);
        Assert.Null(voice.Recordings.Consent(t.ChannelId, t.Bob.Key));

        // Only people in the call answer (Dave can't even see the channel).
        Assert.Equal("not_found", (await t.Dave.RequestAsync("voice.record.consent", new { channelId = t.ChannelId, agree = true })).ErrorCode());
        Left(t.Server, t.ChannelId, t.Carol);
        Assert.Equal("voice_join_first", Key(await t.Carol.RequestAsync("voice.record.consent", new { channelId = t.ChannelId, agree = true })));
    }

    [Fact]
    public async Task In_encrypted_channels_one_no_or_no_answer_calls_it_off()
    {
        using var t = await E2eeChannelTests.CreateAsync("voice");
        var voice = Voice(t.Server);
        Joined(t.Server, t.ChannelId, t.Owner);
        Joined(t.Server, t.ChannelId, t.Bob);
        Joined(t.Server, t.ChannelId, t.Carol);

        Assert.Equal("result", (await t.Owner.RequestAsync("voice.record.start", new { channelId = t.ChannelId })).Type());
        Assert.Equal("result", (await t.Bob.RequestAsync("voice.record.consent", new { channelId = t.ChannelId, agree = true })).Type());
        Assert.False(voice.Recordings.Get(t.ChannelId)!.Live); // Carol hasn't answered
        Assert.Equal("result", (await t.Carol.RequestAsync("voice.record.consent", new { channelId = t.ChannelId, agree = false })).Type());
        Assert.Null(voice.Recordings.Get(t.ChannelId));
        await Until(t.Bob, t.ChannelId, NotRecording);

        // Nobody answers within a minute: called off too.
        Assert.Equal("result", (await t.Owner.RequestAsync("voice.record.start", new { channelId = t.ChannelId })).Type());
        voice.Recordings.Sweep(Now + RecordingRegistry.AskMs + 1);
        Assert.Null(voice.Recordings.Get(t.ChannelId));
        var whys = (await AuditEntries(t.Owner, "voice.record.stop")).EnumerateArray().Select(e => e.GetProperty("details").GetProperty("why").GetString()).ToList();
        Assert.Equal(["timeout", "declined"], whys);

        // Alone in the call: your own yes is everyone's.
        Left(t.Server, t.ChannelId, t.Bob);
        Left(t.Server, t.ChannelId, t.Carol);
        Assert.Equal("result", (await t.Owner.RequestAsync("voice.record.start", new { channelId = t.ChannelId })).Type());
        Assert.True(voice.Recordings.Get(t.ChannelId)!.Live);
    }
}
