using System.Text.Json;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Whispers (only the people they reach get a listener token, and LiveKit is told when that changes) and priority speakers.</summary>
public class WhisperTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static long Channel(IskraServer server, string name, string kind = "voice", string read = "member", string write = "member") =>
        server.World.Store.CreateChannel(name, kind, read, write, 0).Id;

    private static JsonElement Grant(IskraServer server, JsonElement result) =>
        (LiveKitTokens.Verify(result.GetProperty("token").GetString()!, server.Voice.ApiKey, server.Voice.ApiSecret, DateTimeOffset.UtcNow)
         ?? throw new Xunit.Sdk.XunitException("token did not verify")).GetProperty("video");

    private static VoiceRegistry Voice(IskraServer server) => server.Services.GetRequiredService<VoiceRegistry>();

    private static string[] Reached(JsonElement body) => body.GetProperty("reached").EnumerateArray().Select(k => k.GetString()!).Order().ToArray();

    private static void Webhook(IskraServer server, string evt, string room, string identity)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { @event = evt, room = new { name = room }, participant = new { identity } }));
        Voice(server).HandleWebhook(doc.RootElement, Now);
    }

    [Fact]
    public async Task A_whisper_reaches_only_its_targets_in_voice_and_only_they_get_listener_tokens()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge");
        var games = Channel(server, "games");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dave = await server.JoinAsync("Dave");
        var voice = Voice(server);
        voice.Joined(lounge, owner.Key, Now);
        voice.Joined(lounge, alice.Key, Now);
        voice.Joined(lounge, bob.Key, Now);
        voice.Joined(games, carol.Key, Now);

        // Dave isn't in voice: not reached (yet). The owner isn't on the list.
        var started = (await alice.RequestAsync("whisper.start", new { slot = 1, targets = new[] { bob.Key, carol.Key, dave.Key } })).Body();
        Assert.Equal(new[] { bob.Key, carol.Key }.Order(), Reached(started));
        var room = started.GetProperty("room").GetString()!;
        Assert.StartsWith("whisper-", room);
        var speaker = Grant(server, started);
        Assert.Equal(room, speaker.GetProperty("room").GetString());
        Assert.True(speaker.GetProperty("canPublish").GetBoolean());
        Assert.False(speaker.GetProperty("canSubscribe").GetBoolean());
        Assert.False(speaker.GetProperty("canPublishData").GetBoolean());
        Assert.Equal(["microphone"], speaker.GetProperty("canPublishSources").EnumerateArray().Select(s => s.GetString()));

        var id = started.GetProperty("id").GetString()!;
        var incoming = (await bob.EventAsync("whisper.incoming")).Body();
        Assert.Equal(id, incoming.GetProperty("id").GetString());
        Assert.Equal(alice.Key, incoming.GetProperty("from").GetString());
        Assert.Equal(JsonValueKind.Null, incoming.GetProperty("channelId").ValueKind);
        await carol.EventAsync("whisper.incoming");
        await owner.NoEventAsync("whisper.incoming");

        // Listeners may only subscribe; anyone else gets nothing.
        var listen = Grant(server, (await bob.RequestAsync("whisper.join", new { id })).Body());
        Assert.Equal(room, listen.GetProperty("room").GetString());
        Assert.True(listen.GetProperty("canSubscribe").GetBoolean());
        Assert.False(listen.GetProperty("canPublish").GetBoolean());
        Assert.Equal("not_found", (await owner.RequestAsync("whisper.join", new { id })).ErrorCode());
        Assert.Equal("not_found", (await dave.RequestAsync("whisper.join", new { id })).ErrorCode());

        // LiveKit reports who joined the room: anyone the whisper doesn't reach is removed.
        Webhook(server, "participant_joined", room, owner.Key);
        Webhook(server, "participant_joined", room, bob.Key);
        Webhook(server, "participant_joined", room, alice.Key);
        Assert.Contains((room, owner.Key), server.Voice.Removed);
        Assert.DoesNotContain((room, bob.Key), server.Voice.Removed);
        Assert.DoesNotContain((room, alice.Key), server.Voice.Removed);

        // Dave joins voice: reached. Carol leaves: out of the room at once.
        voice.Joined(games, dave.Key, Now);
        await dave.EventAsync("whisper.incoming");
        voice.Left(games, carol.Key);
        Assert.Equal(id, (await carol.EventAsync("whisper.ended")).Body().GetProperty("id").GetString());
        Assert.Contains((room, carol.Key), server.Voice.Removed);
        Assert.Equal("not_found", (await carol.RequestAsync("whisper.join", new { id })).ErrorCode());
        Webhook(server, "participant_joined", room, carol.Key); // an old token used again
        Assert.Equal(2, server.Voice.Removed.Count(r => r == (room, carol.Key)));
        var reach = (await alice.EventAsync("whisper.reach")).Body();
        while (Reached(reach).Contains(carol.Key) || !Reached(reach).Contains(dave.Key)) reach = (await alice.EventAsync("whisper.reach")).Body();
        Assert.Equal(new[] { bob.Key, dave.Key }.Order(), Reached(reach));

        // The same list again is the same whisper; other targets on it make a new one and close the old room.
        var again = (await alice.RequestAsync("whisper.start", new { slot = 1, targets = new[] { bob.Key, carol.Key, dave.Key } })).Body();
        Assert.Equal(id, again.GetProperty("id").GetString());
        var changed = (await alice.RequestAsync("whisper.start", new { slot = 1, targets = new[] { bob.Key } })).Body();
        Assert.NotEqual(id, changed.GetProperty("id").GetString());
        Assert.Contains(room, server.Voice.Deleted);
        Assert.Equal(id, (await dave.EventAsync("whisper.ended")).Body().GetProperty("id").GetString());

        // Stopping closes it for everyone; only the whisperer can.
        var next = changed.GetProperty("id").GetString()!;
        Assert.Equal("not_found", (await bob.RequestAsync("whisper.stop", new { id = next })).ErrorCode());
        await alice.RequestAsync("whisper.stop", new { id = next });
        Assert.Contains(changed.GetProperty("room").GetString()!, server.Voice.Deleted);
        var ended = (await bob.EventAsync("whisper.ended")).Body();
        while (ended.GetProperty("id").GetString() != next) ended = (await bob.EventAsync("whisper.ended")).Body();
    }

    [Fact]
    public async Task Whispering_needs_the_power_and_a_plain_voice_channel()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge");
        var stage = Channel(server, "talks", "stage");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var guest = await server.JoinAsync("Guest", "guest");
        using var bob = await server.JoinAsync("Bob");
        var voice = Voice(server);
        voice.Joined(lounge, bob.Key, Now);
        var targets = new[] { bob.Key };

        async Task<string?> Key(User who, object body) => (await who.RequestAsync("whisper.start", body)).Body().GetProperty("key").GetString();

        Assert.Equal("whisper_not_in_voice", await Key(alice, new { slot = 1, targets }));
        voice.Joined(lounge, guest.Key, Now);
        Assert.Equal("whisper_not_allowed", await Key(guest, new { slot = 1, targets })); // guests don't have it by default
        voice.Joined(stage, alice.Key, Now);
        Assert.Equal("whisper_stage", await Key(alice, new { slot = 1, targets }));
        voice.Left(stage, alice.Key);
        voice.Joined(lounge, alice.Key, Now);
        Assert.Equal("whisper_no_targets", await Key(alice, new { slot = 1, targets = Array.Empty<string>() }));
        Assert.Equal("bad_request", (await alice.RequestAsync("whisper.start", new { slot = 4, targets })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("whisper.start", new { slot = 1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("whisper.start", new { slot = 1, targets, channelId = lounge })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("whisper.start", new { slot = 1, targets = Enumerable.Repeat("x", 26).ToArray() })).ErrorCode());

        // An admin turns the power off for members: a whisper under way ends at once.
        var started = (await alice.RequestAsync("whisper.start", new { slot = 1, targets })).Body();
        var room = started.GetProperty("room").GetString()!;
        var without = Iskra.Server.Sessions.BaseRoles.AbilitiesOf("member").Where(a => a != "whisper").ToArray();
        Assert.Equal("result", (await owner.RequestAsync("role.base.update", new { role = "member", abilities = without })).Type());
        await alice.EventAsync("whisper.ended");
        await bob.EventAsync("whisper.ended");
        Assert.Contains(room, server.Voice.Deleted);
        Assert.Equal("whisper_not_allowed", await Key(alice, new { slot = 1, targets }));
        await owner.RequestAsync("role.base.update", new { role = "member", reset = true });

        // A server mute stops whispering too (someone else: the starts above used up the rate limit).
        using var erin = await server.JoinAsync("Erin");
        voice.Joined(lounge, erin.Key, Now);
        started = (await erin.RequestAsync("whisper.start", new { slot = 2, targets })).Body();
        await owner.RequestAsync("voice.mute", new { accountKey = erin.Key, muted = true });
        await erin.EventAsync("whisper.ended");
        Assert.Contains(started.GetProperty("room").GetString()!, server.Voice.Deleted);
        Assert.Equal("whisper_muted", await Key(erin, new { slot = 1, targets }));
        await owner.RequestAsync("voice.mute", new { accountKey = erin.Key, muted = false });

        // Leaving voice ends your whispers.
        started = (await erin.RequestAsync("whisper.start", new { slot = 3, targets })).Body();
        voice.Left(lounge, erin.Key);
        await erin.EventAsync("whisper.ended");
        Assert.Contains(started.GetProperty("room").GetString()!, server.Voice.Deleted);

        // Voice down: no whispers.
        voice.Joined(lounge, erin.Key, Now);
        server.Voice.Available = false;
        Assert.Equal("voice_unavailable", (await erin.RequestAsync("whisper.start", new { slot = 1, targets })).ErrorCode());
    }

    [Fact]
    public async Task Whispering_to_a_channel_needs_speaking_there_and_reaches_whoever_is_in_it()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge");
        var leads = Channel(server, "leads", write: "trusted");
        var secret = Channel(server, "secret", read: "admin", write: "admin");
        var stage = Channel(server, "talks", "stage");
        using var alice = await server.JoinAsync("Alice");
        using var lead = await server.JoinAsync("Lead", "trusted");
        using var other = await server.JoinAsync("Other", "trusted");
        using var admin = await server.JoinAsync("Admin", "admin");
        var voice = Voice(server);
        voice.Joined(lounge, alice.Key, Now);
        voice.Joined(lounge, lead.Key, Now);
        voice.Joined(leads, other.Key, Now);
        voice.Joined(leads, admin.Key, Now);

        Assert.Equal("whisper_channel", (await alice.RequestAsync("whisper.start", new { slot = 1, channelId = leads })).Body().GetProperty("key").GetString());
        Assert.Equal("not_found", (await alice.RequestAsync("whisper.start", new { slot = 1, channelId = secret })).ErrorCode());
        Assert.Equal("whisper_stage", (await lead.RequestAsync("whisper.start", new { slot = 1, channelId = stage })).Body().GetProperty("key").GetString());
        Assert.Equal("whisper_voice_only", (await lead.RequestAsync("whisper.start", new { slot = 1, channelId = server.General })).Body().GetProperty("key").GetString());

        var started = (await lead.RequestAsync("whisper.start", new { slot = 1, channelId = leads })).Body();
        Assert.Equal(new[] { other.Key, admin.Key }.Order(), Reached(started));
        var incoming = (await other.EventAsync("whisper.incoming")).Body();
        Assert.Equal(leads, incoming.GetProperty("channelId").GetInt64());
        await alice.NoEventAsync("whisper.incoming");

        // Someone joining the channel later hears it too; the whisperer losing "speak" there ends it.
        voice.Left(lounge, alice.Key);
        voice.Joined(leads, alice.Key, Now);
        await alice.EventAsync("whisper.incoming");
        await admin.RequestAsync("member.setRole", new { accountKey = lead.Key, role = "member" });
        await lead.EventAsync("whisper.ended");
        Assert.Contains(started.GetProperty("room").GetString()!, server.Voice.Deleted);
    }

    [Fact]
    public async Task Blocks_the_AFK_channel_and_hidden_channels_keep_whispers_out()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge");
        var hidden = Channel(server, "hidden", read: "trusted", write: "trusted");
        var afk = Channel(server, "AFK");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol", "trusted");
        using var dave = await server.JoinAsync("Dave");
        await owner.RequestAsync("afk.update", new { channelId = afk });
        var voice = Voice(server);
        voice.Joined(lounge, alice.Key, Now);
        voice.Joined(lounge, bob.Key, Now);
        voice.Joined(hidden, carol.Key, Now);
        voice.Joined(afk, dave.Key, Now);

        // Carol is in a channel Alice can't see; Dave is deafened by the AFK channel.
        var started = (await alice.RequestAsync("whisper.start", new { slot = 1, targets = new[] { bob.Key, carol.Key, dave.Key } })).Body();
        Assert.Equal([bob.Key], Reached(started));
        await bob.EventAsync("whisper.incoming");

        // Bob blocks Alice: out of the room.
        var block = new { accountKey = alice.Key, blocked = true, at = Now };
        await bob.RequestAsync("block.sync", new { entries = new[] { block } });
        await bob.EventAsync("whisper.ended");
        Assert.Contains((started.GetProperty("room").GetString()!, bob.Key), server.Voice.Removed);
        var again = (await alice.RequestAsync("whisper.start", new { slot = 1, targets = new[] { bob.Key, carol.Key, dave.Key } })).Body();
        Assert.Empty(Reached(again));
    }

    [Fact]
    public async Task Whisper_starts_are_rate_limited()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        Voice(server).Joined(lounge, alice.Key, Now);
        Voice(server).Joined(lounge, bob.Key, Now);
        var codes = new List<string?>();
        for (var i = 0; i < 14; i++) codes.Add((await alice.RequestAsync("whisper.start", new { slot = 1, targets = new[] { bob.Key } })).ErrorCode());
        Assert.Contains("rate_limited", codes);
    }

    [Fact]
    public async Task Priority_is_for_priority_speakers_who_can_talk_and_shows_in_voice_state()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge");
        var listenOnly = Channel(server, "radio", write: "admin");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        using var mod = await server.JoinAsync("Mod");
        var voice = Voice(server);

        Assert.Equal("priority_not_in_voice", (await admin.RequestAsync("voice.priority", new { on = true })).Body().GetProperty("key").GetString());
        voice.Joined(lounge, admin.Key, Now);
        voice.Joined(lounge, member.Key, Now);
        voice.Joined(lounge, mod.Key, Now);
        Assert.Equal("priority_not_allowed", (await member.RequestAsync("voice.priority", new { on = true })).Body().GetProperty("key").GetString());
        Assert.Equal("result", (await member.RequestAsync("voice.priority", new { on = false })).Type());

        // voice.join tells the app what it may offer.
        var joined = (await admin.RequestAsync("voice.join", new { channelId = lounge })).Body();
        Assert.True(joined.GetProperty("priority").GetBoolean());
        Assert.True(joined.GetProperty("whisper").GetBoolean());
        Assert.False((await member.RequestAsync("voice.join", new { channelId = lounge })).Body().GetProperty("priority").GetBoolean());

        await admin.RequestAsync("voice.priority", new { on = true });
        bool PriorityOf(JsonElement state, string key) =>
            state.GetProperty("participants").EnumerateArray().First(p => p.GetProperty("accountKey").GetString() == key).GetProperty("priority").GetBoolean();
        var state = (await member.EventAsync("voice.state")).Body();
        while (!PriorityOf(state, admin.Key)) state = (await member.EventAsync("voice.state")).Body();

        // A custom role with the permission (the Moderator preset) works; taking it away turns priority off.
        var role = (await owner.RequestAsync("role.create", new { name = "Moderator", permissions = new[] { "prioritySpeaker" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { role } });
        Assert.Equal("result", (await mod.RequestAsync("voice.priority", new { on = true })).Type());
        Assert.True(voice.Participant(lounge, mod.Key)!.Priority);
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = Array.Empty<long>() });
        Assert.False(voice.Participant(lounge, mod.Key)!.Priority);

        // Not where you can't talk.
        voice.Left(lounge, admin.Key);
        voice.Joined(listenOnly, owner.Key, Now);
        voice.Left(lounge, mod.Key);
        voice.Joined(listenOnly, mod.Key, Now);
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { role } });
        Assert.Equal("priority_cant_talk", (await mod.RequestAsync("voice.priority", new { on = true })).Body().GetProperty("key").GetString());
    }
}
