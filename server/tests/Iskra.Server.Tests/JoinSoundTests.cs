using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class JoinSoundTests
{
    private static async Task<string> Sound(IskraServer server, User user, int ms, string name = "hello") =>
        (await SoundboardTests.AddSound(server, user, SoundboardTests.Wav(ms), name)).Body().GetProperty("sound").GetProperty("id").GetString()!;

    private static void Enter(IskraServer server, long channelId, User user) =>
        server.Services.GetRequiredService<VoiceRegistry>().Joined(channelId, user.Key, server.Clock.GetUtcNow().ToUnixTimeMilliseconds());

    private static void Leave(IskraServer server, long channelId, User user) =>
        server.Services.GetRequiredService<VoiceRegistry>().Left(channelId, user.Key);

    [Fact]
    public async Task The_others_in_the_channel_hear_the_sound_of_someone_who_enters()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        var other = server.World.Store.CreateChannel("other", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var id = await Sound(server, alice, 1200);

        var set = await alice.RequestAsync("joinsound.set", new { id });
        Assert.Equal(id, set.Body().GetProperty("soundId").GetString());
        Assert.True(set.Body().GetProperty("enabled").GetBoolean());
        Assert.Equal(5000, set.Body().GetProperty("maxMs").GetInt32());
        Assert.Equal(id, (await alice.RequestAsync("joinsound.get")).Body().GetProperty("soundId").GetString());
        Assert.Equal(JsonValueKind.Null, (await bob.RequestAsync("joinsound.get")).Body().GetProperty("soundId").ValueKind);

        Enter(server, lounge, bob);
        Enter(server, other, carol);
        Enter(server, lounge, alice);

        var played = (await bob.EventAsync("joinsound.played")).Body();
        Assert.Equal(lounge, played.GetProperty("channelId").GetInt64());
        Assert.Equal(alice.Key, played.GetProperty("accountKey").GetString());
        Assert.Equal(id, played.GetProperty("sound").GetProperty("id").GetString());
        Assert.StartsWith("/files/", played.GetProperty("sound").GetProperty("url").GetString());
        // Not the person who entered, and not people in other channels.
        await alice.NoEventAsync("joinsound.played");
        await carol.NoEventAsync("joinsound.played");
    }

    [Fact]
    public async Task Nothing_plays_for_a_reconnect_or_a_quick_rejoin()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        await alice.RequestAsync("joinsound.set", new { id = await Sound(server, alice, 800) });
        Enter(server, lounge, bob);

        Enter(server, lounge, alice);
        await bob.EventAsync("joinsound.played");
        // LiveKit says "joined" again after a reconnect.
        Enter(server, lounge, alice);
        await bob.NoEventAsync("joinsound.played");
        // Leaving and coming straight back.
        Leave(server, lounge, alice);
        Enter(server, lounge, alice);
        await bob.NoEventAsync("joinsound.played");

        Leave(server, lounge, alice);
        server.Clock.Advance(TimeSpan.FromMilliseconds(JoinSoundFeature.CooldownMs + 1));
        Enter(server, lounge, alice);
        await bob.EventAsync("joinsound.played");
    }

    [Fact]
    public async Task Only_short_sounds_that_exist_can_be_picked()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        var longId = await Sound(server, alice, 6000, "long");
        var shortId = await Sound(server, alice, 5000, "short");

        Assert.Equal("bad_request", (await alice.RequestAsync("joinsound.set", new { id = longId })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("joinsound.set", new { id = "nope" })).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("joinsound.set", new { id = shortId })).Type());

        // A deleted sound is nobody's join sound any more.
        await alice.RequestAsync("sound.delete", new { id = shortId });
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("joinsound.get")).Body().GetProperty("soundId").ValueKind);
        Enter(server, lounge, bob);
        Enter(server, lounge, alice);
        await bob.NoEventAsync("joinsound.played");
    }

    [Fact]
    public async Task Picking_none_stops_it_and_other_devices_are_told()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        using var phoneIdentity = new TestIdentity(alice.Identity.Account);
        using var phone = await server.ConnectAsync();
        Assert.Equal("welcome", (await phone.LoginAsync(phoneIdentity, "Alice")).Type());
        var id = await Sound(server, alice, 800);

        await alice.RequestAsync("joinsound.set", new { id });
        Assert.Equal(id, (await phone.EventAsync("joinsound.updated")).Body().GetProperty("soundId").GetString());
        await bob.NoEventAsync("joinsound.updated");

        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("joinsound.set", new { })).Body().GetProperty("soundId").ValueKind);
        Enter(server, lounge, bob);
        Enter(server, lounge, alice);
        await bob.NoEventAsync("joinsound.played");
    }

    [Fact]
    public async Task The_owner_turns_join_sounds_off_for_the_server()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        await owner.RequestAsync("joinsound.set", new { id = await Sound(server, owner, 800) });

        Assert.Equal("forbidden", (await admin.RequestAsync("joinsound.configure", new { enabled = false })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("joinsound.configure", new { enabled = false })).Type());
        Assert.False((await bob.EventAsync("joinsound.enabled")).Body().GetProperty("enabled").GetBoolean());
        Assert.False((await bob.RequestAsync("joinsound.get")).Body().GetProperty("enabled").GetBoolean());

        Enter(server, lounge, bob);
        Enter(server, lounge, owner);
        await bob.NoEventAsync("joinsound.played");

        // A new connection learns it in the welcome.
        using var late = await server.JoinAsync("Late");
        Assert.False(late.Welcome.Body().GetProperty("server").GetProperty("joinSounds").GetBoolean());
    }

    [Fact]
    public async Task Listen_only_channels_and_stages_play_no_join_sound()
    {
        using var server = new IskraServer();
        var quiet = server.World.Store.CreateChannel("quiet", "voice", "member", "admin", 0).Id;
        var stage = server.World.Store.CreateChannel("stage", "stage", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        await alice.RequestAsync("joinsound.set", new { id = await Sound(server, alice, 800) });

        Enter(server, quiet, bob);
        Enter(server, quiet, alice);
        await bob.NoEventAsync("joinsound.played");
        Leave(server, quiet, bob);
        Leave(server, quiet, alice);

        Enter(server, stage, bob);
        Enter(server, stage, alice);
        await bob.NoEventAsync("joinsound.played");
    }

    [Fact]
    public async Task The_choice_is_in_the_data_export_and_goes_when_the_member_leaves()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "trusted");
        var id = await Sound(server, alice, 800);
        await alice.RequestAsync("joinsound.set", new { id });
        Assert.Equal(id, server.World.Store.GetJoinSound(alice.Key)?.Id);

        Assert.Equal("result", (await alice.RequestAsync("member.leave")).Type());
        Assert.Null(server.World.Store.GetJoinSound(alice.Key));
    }
}
