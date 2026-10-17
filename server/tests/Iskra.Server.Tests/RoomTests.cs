using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Join-to-create voice rooms: lobbies, the rooms they make, what a host can do, and cleanup.</summary>
public class RoomTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static VoiceRegistry Voice(IskraServer server) => server.Services.GetRequiredService<VoiceRegistry>();

    private static string? Key(JsonElement frame) => frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

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

    private static Task LiveKitJoin(IskraServer server, long channel, string identity) =>
        Webhook(server, new { @event = "participant_joined", room = new { name = $"voice-{channel}" }, participant = new { identity } });

    private static bool Removed(IskraServer server, long channel, string identity)
    {
        lock (server.Voice.Removed) return server.Voice.Removed.Contains(($"voice-{channel}", identity));
    }

    private static async Task<long> Lobby(User admin, string name = "lobby", object? extra = null)
    {
        var body = new Dictionary<string, object?> { ["name"] = name, ["kind"] = "voice", ["lobby"] = true };
        if (extra is not null)
            foreach (var p in extra.GetType().GetProperties()) body[p.Name] = p.GetValue(extra);
        var created = await admin.RequestAsync("channel.create", body);
        Assert.Equal("result", created.Type());
        return created.Body().GetProperty("channel").GetProperty("id").GetInt64();
    }

    /// <summary>Joins through voice.join (the room's token) and then as LiveKit reports it; returns the room's id.</summary>
    private static async Task<long> JoinLobby(IskraServer server, User user, long lobby)
    {
        var result = await user.RequestAsync("voice.join", new { channelId = lobby });
        Assert.Equal("result", result.Type());
        var room = result.Body().GetProperty("channelId").GetInt64();
        Assert.NotEqual(lobby, room);
        Assert.Equal($"voice-{room}", result.Body().GetProperty("room").GetString());
        Voice(server).Joined(room, user.Key, Now);
        return room;
    }

    private static JsonElement ChannelIn(JsonElement channels, long id) => channels.EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == id);

    /// <summary>Reads `channels` events (several may be queued: role changes send them too) until the channel looks as expected.</summary>
    private static async Task<JsonElement> ChannelEvent(User user, long id, Func<JsonElement, bool> expected)
    {
        while (true)
        {
            var channels = (await user.EventAsync("channels")).Body().GetProperty("channels");
            var found = channels.EnumerateArray().Where(c => c.GetProperty("id").GetInt64() == id).ToList();
            if (found.Count == 1 && expected(found[0])) return found[0];
        }
    }

    [Fact]
    public async Task Admins_flag_voice_channels_as_lobbies()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        var lounge = store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        Assert.False(ChannelIn(alice.Welcome.Body().GetProperty("channels"), lounge).GetProperty("lobby").GetBoolean());
        Assert.Equal("forbidden", (await alice.RequestAsync("channel.update", new { id = lounge, lobby = true })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = lounge, lobby = "yes" })).ErrorCode());
        Assert.Equal("lobby_voice_only", Key(await admin.RequestAsync("channel.update", new { id = server.General, lobby = true })));
        Assert.Equal("lobby_voice_only", Key(await admin.RequestAsync("channel.create", new { name = "talks", kind = "stage", lobby = true })));
        Assert.False(store.IsLobby(lounge));

        var updated = (await admin.RequestAsync("channel.update", new { id = lounge, lobby = true })).Body().GetProperty("channel");
        Assert.True(updated.GetProperty("lobby").GetBoolean());
        Assert.Equal(JsonValueKind.Null, updated.GetProperty("room").ValueKind);
        Assert.True(ChannelIn((await alice.EventAsync("channels")).Body().GetProperty("channels"), lounge).GetProperty("lobby").GetBoolean());

        // An update that leaves it out keeps it; off again; both changes in the audit log (and nothing else about rooms).
        await admin.RequestAsync("channel.update", new { id = lounge, name = "hangout" });
        Assert.True(store.IsLobby(lounge));
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = lounge, lobby = false })).Type());
        Assert.False(store.IsLobby(lounge));
        var audit = (await admin.RequestAsync("audit.list", new { action = "channel.update" })).Body().GetProperty("entries");
        Assert.Equal(2, audit.EnumerateArray().Count(e => e.GetProperty("details").GetProperty("changes").TryGetProperty("lobby", out _)));
    }

    [Fact]
    public async Task Joining_a_lobby_makes_your_own_room_under_it_with_its_permissions()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        using var admin = await server.JoinAsync("Admin", "admin");
        var games = (await admin.RequestAsync("category.create", new { name = "Games" })).Body().GetProperty("category").GetProperty("id").GetInt64();
        var role = (await admin.RequestAsync("role.create", new { name = "Gamers" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        var lobby = await Lobby(admin, extra: new { readRole = "member", writeRole = "trusted", categoryId = games, hifi = true, userLimit = 4 });
        await admin.RequestAsync("channel.overrides.set", new { id = lobby, roleId = role, allow = new[] { "speak" } });
        var after = (await admin.RequestAsync("channel.create", new { name = "after", kind = "voice", categoryId = games })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        using var alice = await server.JoinAsync("Alice Smith");
        using var bob = await server.JoinAsync("Bob");

        var room = await JoinLobby(server, alice, lobby);
        var channel = store.GetChannel(room)!;
        Assert.Equal(("alice-smith's-room", "voice", "member", "trusted", (long?)games), (channel.Name, channel.Kind, channel.ReadRole, channel.WriteRole, channel.CategoryId));
        Assert.Equal(role, Assert.Single(channel.Overrides).RoleId);
        Assert.True(store.IsHifi(room));
        Assert.Equal(4, store.UserLimit(room));
        Assert.False(store.IsLobby(room));

        // Everyone sees the room, with Alice as its host; the lobby itself stays empty.
        var channels = (await bob.EventAsync("channels")).Body().GetProperty("channels");
        var view = ChannelIn(channels, room).GetProperty("room");
        Assert.Equal(lobby, view.GetProperty("lobbyId").GetInt64());
        Assert.Equal(alice.Key, view.GetProperty("host").GetString());
        Assert.False(view.GetProperty("locked").GetBoolean());
        Assert.Empty(view.GetProperty("invited").EnumerateArray());
        Assert.Empty(Voice(server).Participants(lobby));
        Assert.Single(Voice(server).Participants(room));

        // Bob's room comes after Alice's, both right under the lobby.
        var second = await JoinLobby(server, bob, lobby);
        Assert.Equal("bob's-room", store.GetChannel(second)!.Name);
        var order = store.AllChannels().Select(c => c.Id).ToList();
        Assert.Equal([lobby, room, second, after], order.Where(id => id == lobby || id == room || id == second || id == after));

        // Nobody can stay in the lobby: a LiveKit join there (an old token) is removed.
        await LiveKitJoin(server, lobby, bob.Key);
        Assert.True(Removed(server, lobby, bob.Key));
        Assert.Empty(Voice(server).Participants(lobby));
        // The lobby's and "after"'s creation reached the audit log, never the rooms.
        var created = store.Audit("channel.create", null, null, 10);
        Assert.Equal(2, created.Count);
        Assert.Single(created, e => e.Details!.Contains("\"lobby\":true"));
        Assert.DoesNotContain(created, e => e.Details!.Contains("'s-room"));
    }

    [Fact]
    public async Task The_afk_channel_and_lobbies_stay_apart()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        var lounge = store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        var lobby = await Lobby(admin);

        // The AFK channel can't become a lobby (idle people couldn't be parked in one)...
        Assert.Equal("result", (await admin.RequestAsync("afk.update", new { channelId = lounge })).Type());
        Assert.Equal("lobby_afk", Key(await admin.RequestAsync("channel.update", new { id = lounge, lobby = true })));
        Assert.False(store.IsLobby(lounge));
        // ...and a lobby can't be made the AFK channel.
        Assert.Equal("afk_lobby", Key(await admin.RequestAsync("afk.update", new { channelId = lobby })));
        Assert.Equal(lounge, store.Afk().ChannelId);
        // Off again as a lobby, it can.
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = lobby, lobby = false })).Type());
        Assert.Equal("result", (await admin.RequestAsync("afk.update", new { channelId = lobby })).Type());
    }

    [Fact]
    public async Task Bots_cant_make_rooms_and_rooms_cant_be_lobbies()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var lobby = await Lobby(admin);
        using var bot = await server.JoinAsync("Dice");
        server.World.Store.AddBot(bot.Key, admin.Key, Now, readAll: false);
        server.World.Store.SetBotVoice(bot.Key, true);
        Assert.Equal("lobby_bot", Key(await bot.RequestAsync("voice.join", new { channelId = lobby })));
        Assert.Empty(server.World.Store.AllRooms());
        // A room can't be a lobby itself.
        using var alice = await server.JoinAsync("Alice");
        var room = await JoinLobby(server, alice, lobby);
        Assert.Equal("lobby_room", Key(await admin.RequestAsync("channel.update", new { id = room, lobby = true })));
    }

    [Fact]
    public async Task The_host_renames_limits_and_locks_the_room_and_invites_people_in()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        using var admin = await server.JoinAsync("Admin", "admin");
        var lobby = await Lobby(admin);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var mover = await server.JoinAsync("Mover");
        var movers = (await admin.RequestAsync("role.create", new { name = "Movers", permissions = new[] { "moveMembers" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await admin.RequestAsync("member.roles.set", new { accountKey = mover.Key, roles = new[] { movers } });
        var room = await JoinLobby(server, alice, lobby);

        // Only the host (or an admin) changes it; names follow channel name rules, up to 60 characters.
        Assert.Equal("room_host_only", Key(await bob.RequestAsync("room.update", new { channelId = room, name = "Bob's place" })));
        Assert.Equal("room_only", Key(await alice.RequestAsync("room.update", new { channelId = lobby, name = "x" })));
        Assert.Equal("room_name", Key(await alice.RequestAsync("room.update", new { channelId = room, name = new string('a', 61) })));
        Assert.Equal("bad_request", (await alice.RequestAsync("room.update", new { channelId = room, userLimit = 100 })).ErrorCode());
        var updated = (await alice.RequestAsync("room.update", new { channelId = room, name = "Valheim Build Night", userLimit = 3, locked = true })).Body().GetProperty("channel");
        Assert.Equal("valheim-build-night", updated.GetProperty("name").GetString());
        Assert.Equal(3, updated.GetProperty("userLimit").GetInt32());
        Assert.True(updated.GetProperty("room").GetProperty("locked").GetBoolean());
        var seen = await ChannelEvent(bob, room, c => c.GetProperty("room").GetProperty("locked").GetBoolean());
        Assert.Equal("valheim-build-night", seen.GetProperty("name").GetString());

        // Locked: Bob can't get a token, and a LiveKit join with an old token is removed.
        var refused = await bob.RequestAsync("voice.join", new { channelId = room });
        Assert.Equal("room_locked", refused.ErrorCode());
        Assert.Equal("Alice", refused.Body().GetProperty("args").GetProperty("host").GetString());
        await LiveKitJoin(server, room, bob.Key);
        Assert.True(Removed(server, room, bob.Key));
        Assert.Empty(Voice(server).Participants(room).Where(p => p.AccountKey == bob.Key));

        // Invited: in. Someone a moderator moved in: in. Movers themselves: in. The host after reconnecting: in.
        Assert.Equal("room_host_only", Key(await bob.RequestAsync("room.invite", new { channelId = room, accountKey = bob.Key })));
        Assert.Equal("not_found", (await alice.RequestAsync("room.invite", new { channelId = room, accountKey = "nobody" })).ErrorCode());
        var invited = (await alice.RequestAsync("room.invite", new { channelId = room, accountKey = bob.Key })).Body().GetProperty("channel").GetProperty("room").GetProperty("invited");
        Assert.Equal([bob.Key], invited.EnumerateArray().Select(k => k.GetString()));
        Assert.Equal("result", (await bob.RequestAsync("voice.join", new { channelId = room })).Type());
        Voice(server).Joined(room, bob.Key, Now);
        Assert.Equal("room_locked", (await carol.RequestAsync("voice.join", new { channelId = room })).ErrorCode());
        Voice(server).Joined(lobby, carol.Key, Now); // as if somewhere else: a mover moves her in
        Assert.Equal("result", (await mover.RequestAsync("voice.move", new { accountKey = carol.Key, channelId = room })).Type());
        Assert.Equal("result", (await carol.RequestAsync("voice.join", new { channelId = room })).Type());
        Assert.Equal("result", (await mover.RequestAsync("voice.join", new { channelId = room })).Type());
        Assert.Equal("result", (await alice.RequestAsync("voice.join", new { channelId = room })).Type());

        // Uninvited again, and the admin can unlock what the host locked.
        Assert.Equal("result", (await alice.RequestAsync("room.uninvite", new { channelId = room, accountKey = bob.Key })).Type());
        Assert.Empty(store.RoomInvites(room));
        Assert.Equal("result", (await admin.RequestAsync("room.update", new { channelId = room, locked = false })).Type());
        Assert.False(store.GetRoom(room)!.Locked);
        Assert.Equal("result", (await carol.RequestAsync("voice.join", new { channelId = room })).Type());
        // Rooms never reach the audit log.
        Assert.Empty(store.Audit("channel.update", null, null, 10));
    }

    [Fact]
    public async Task The_host_passes_to_whoever_has_been_there_longest()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        using var admin = await server.JoinAsync("Admin", "admin");
        var lobby = await Lobby(admin);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dice = await server.JoinAsync("Dice");
        store.AddBot(dice.Key, admin.Key, Now, readAll: false);
        var start = Now;
        var room = await JoinLobby(server, alice, lobby);
        Voice(server).Joined(room, dice.Key, start + 1);
        Voice(server).Joined(room, bob.Key, start + 2);
        Voice(server).Joined(room, carol.Key, start + 3);
        Assert.Equal(alice.Key, store.GetRoom(room)!.HostKey);

        Voice(server).Left(room, alice.Key);
        Assert.Equal(bob.Key, store.GetRoom(room)!.HostKey); // not the bot, who was there before Bob
        await ChannelEvent(carol, room, c => c.GetProperty("room").GetProperty("host").GetString() == bob.Key);
        Assert.Equal("result", (await bob.RequestAsync("room.update", new { channelId = room, locked = true })).Type());
        Assert.Equal("room_host_only", Key(await alice.RequestAsync("room.update", new { channelId = room, locked = false })));

        // Everyone leaves (the bot last, who never hosts); whoever comes in next hosts.
        Voice(server).Left(room, bob.Key);
        Assert.Equal(carol.Key, store.GetRoom(room)!.HostKey);
        Voice(server).Left(room, carol.Key);
        Voice(server).Left(room, dice.Key);
        Assert.Equal(carol.Key, store.GetRoom(room)!.HostKey);
        Assert.Equal("room_host_only", Key(await bob.RequestAsync("room.update", new { channelId = room, locked = false })));
        Voice(server).Joined(room, alice.Key, Now);
        Assert.Equal(alice.Key, store.GetRoom(room)!.HostKey);
    }

    [Fact]
    public async Task Empty_rooms_go_after_thirty_seconds_and_the_lobby_stays()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        using var admin = await server.JoinAsync("Admin", "admin");
        var lobby = await Lobby(admin);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var start = Now;
        var mine = await JoinLobby(server, alice, lobby);
        var theirs = await JoinLobby(server, bob, lobby);
        var sweeper = server.Services.GetRequiredService<RoomSweeper>();

        // Both in use: nothing goes. Bob leaves: his room goes 30 s later; Alice's stays while she's there.
        Assert.Equal(0, sweeper.Sweep(start + 60_000));
        Voice(server).Left(theirs, bob.Key);
        Assert.Equal(0, sweeper.Sweep(start + 70_000));
        Assert.Equal(1, sweeper.Sweep(start + 90_000));
        Assert.Null(store.GetChannel(theirs));
        Assert.NotNull(store.GetChannel(mine));
        Assert.Empty(store.RoomInvites(theirs));
        var channels = await bob.EventAsync("channels");
        while (channels.Body().GetProperty("channels").EnumerateArray().Any(c => c.GetProperty("id").GetInt64() == theirs)) channels = await bob.EventAsync("channels");
        Assert.Contains(channels.Body().GetProperty("channels").EnumerateArray(), c => c.GetProperty("id").GetInt64() == mine);

        // A room nobody has reached yet (no webhook) counts from its creation; the lobby is never swept.
        var fresh = (await bob.RequestAsync("voice.join", new { channelId = lobby })).Body().GetProperty("channelId").GetInt64();
        Assert.Equal(0, sweeper.Sweep(Now + 10_000));
        Assert.Equal(1, sweeper.Sweep(Now + 31_000));
        Assert.Null(store.GetChannel(fresh));
        Voice(server).Left(mine, alice.Key);
        Assert.Equal(1, sweeper.Sweep(Now + 120_000));
        Assert.Empty(store.AllRooms());
        Assert.NotNull(store.GetChannel(lobby));
        Assert.True(store.IsLobby(lobby));
    }

    [Fact]
    public async Task Someone_moved_into_a_room_keeps_it_alive_until_they_arrive()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var lobby = await Lobby(admin);
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var room = await JoinLobby(server, alice, lobby);
        Voice(server).Joined(lounge, bob.Key, Now);
        Voice(server).Left(room, alice.Key);
        var sweeper = server.Services.GetRequiredService<RoomSweeper>();
        var start = Now;
        Assert.Equal(0, sweeper.Sweep(start));
        Assert.Equal("result", (await admin.RequestAsync("voice.move", new { accountKey = bob.Key, channelId = room })).Type());
        Assert.Equal(0, sweeper.Sweep(start + 40_000)); // his app is on its way (the move pass lasts a minute)
        Assert.NotNull(server.World.Store.GetChannel(room));
    }

    [Fact]
    public async Task Rooms_are_rate_limited_and_capped()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var lobby = await Lobby(admin);
        using var alice = await server.JoinAsync("Alice");
        var codes = new List<string?>();
        for (var i = 0; i < 6; i++) codes.Add((await alice.RequestAsync("voice.join", new { channelId = lobby })).ErrorCode());
        Assert.Equal([null, null, null, null, null, "rate_limited"], codes);
        Assert.Equal(5, server.World.Store.AllRooms().Count);
        // Deleting the lobby leaves its rooms (they empty out and go by themselves).
        Assert.Equal("result", (await admin.RequestAsync("channel.delete", new { id = lobby })).Type());
        Assert.Equal(5, server.World.Store.AllRooms().Count);
        Assert.Equal(5, server.World.Store.AllChannels().Count(c => c.Kind == "voice"));
    }
}
