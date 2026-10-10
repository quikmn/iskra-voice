using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using static Iskra.Server.Tests.GroupTests;

namespace Iskra.Server.Tests;

public class GroupCallTests
{
    private static object Key(string marker) => new { v = 2, kind = "group", ct = marker };

    private static Task<JsonElement> Start(User user, string group, string callId, long version = 1, bool video = false) =>
        user.RequestAsync("gcall.start", new { groupId = group, callId, version, video, envelope = Key("key-1") });

    private static JsonElement Claims(IskraServer server, string token) =>
        LiveKitTokens.Verify(token, server.Voice.ApiKey, server.Voice.ApiSecret, DateTimeOffset.UtcNow)
        ?? throw new Xunit.Sdk.XunitException("token did not verify");

    private static async Task Webhook(IskraServer server, string type, string room, string identity)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { @event = type, room = new { name = room }, participant = new { identity } });
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        request.Headers.TryAddWithoutValidation("Authorization", LiveKitTokens.Sign(new JsonObject
        {
            ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = Convert.ToBase64String(SHA256.HashData(body)),
        }, server.Voice.ApiSecret));
        using var response = await server.CreateClient().SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static string[] Participants(JsonElement call) => call.GetProperty("participants").EnumerateArray().Select(p => p.GetString()!).ToArray();

    [Fact]
    public async Task A_group_call_rings_the_other_members_and_only_members_get_tickets()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var eve = await server.JoinAsync("Eve", "admin");
        var group = NewId();
        await CreateAsync(alice, group, bob, carol);
        var id = NewId();

        var started = (await Start(alice, group, id, video: true)).Body();
        var room = GroupCallRegistry.RoomName(group, id);
        var ticket = started.GetProperty("ticket");
        Assert.Equal(room, ticket.GetProperty("room").GetString());
        Assert.Equal(alice.Key, Claims(server, ticket.GetProperty("token").GetString()!).GetProperty("sub").GetString());
        Assert.Equal(room, Claims(server, ticket.GetProperty("token").GetString()!).GetProperty("video").GetProperty("room").GetString());

        foreach (var user in new[] { bob, carol })
        {
            var ring = (await user.EventAsync("gcall.ring")).Body();
            Assert.Equal(id, ring.GetProperty("call").GetProperty("id").GetString());
            Assert.Equal(group, ring.GetProperty("call").GetProperty("group").GetString());
            Assert.Equal("key-1", ring.GetProperty("envelope").GetProperty("ct").GetString());
        }
        await alice.NoEventAsync("gcall.ring");
        await eve.NoEventAsync("gcall.ring");

        // Someone outside the group can't join, start, list or rekey it; a second call in the same group is "busy".
        Assert.Equal("not_found", (await eve.RequestAsync("gcall.join", new { callId = id })).ErrorCode());
        Assert.Equal("not_found", (await eve.RequestAsync("gcall.start", new { groupId = group, callId = NewId(), version = 1, envelope = Key("x") })).ErrorCode());
        Assert.Empty((await eve.RequestAsync("gcall.list")).Body().GetProperty("calls").EnumerateArray());
        Assert.Equal("busy", (await Start(bob, group, NewId())).ErrorCode());

        // Bob joins: his ticket, the current key, and the ringing stops on his other devices.
        var joined = (await bob.RequestAsync("gcall.join", new { callId = id })).Body();
        Assert.Equal(bob.Key, Claims(server, joined.GetProperty("ticket").GetProperty("token").GetString()!).GetProperty("sub").GetString());
        Assert.Equal("key-1", joined.GetProperty("ring").GetProperty("envelope").GetProperty("ct").GetString());

        // Who's in the room comes from LiveKit. A stranger who somehow got in is removed.
        await Webhook(server, "participant_joined", room, alice.Key);
        await Webhook(server, "participant_joined", room, bob.Key);
        await Webhook(server, "participant_joined", room, eve.Key);
        Assert.Contains((room, eve.Key), server.Voice.Removed);
        var listed = (await carol.RequestAsync("gcall.list")).Body().GetProperty("calls")[0];
        Assert.Equal([alice.Key, bob.Key], Participants(listed.GetProperty("call")));
        Assert.True(listed.GetProperty("ringing").GetBoolean());

        // Carol declines; the call goes on. Everyone leaving ends it for the whole group.
        await carol.RequestAsync("gcall.decline", new { callId = id });
        await Webhook(server, "participant_left", room, bob.Key);
        await alice.RequestAsync("gcall.leave", new { callId = id });
        foreach (var user in new[] { alice, bob, carol })
            Assert.Equal(id, (await user.EventAsync("gcall.ended")).Body().GetProperty("callId").GetString());
        await eve.NoEventAsync("gcall.ended");
        Assert.Equal("not_found", (await bob.RequestAsync("gcall.join", new { callId = id })).ErrorCode());
    }

    [Fact]
    public async Task Leaving_the_group_drops_you_from_its_call_and_asks_for_a_new_key()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var group = NewId();
        var g = await CreateAsync(alice, group, bob, carol);
        var id = NewId();
        await Start(alice, group, id);
        var room = GroupCallRegistry.RoomName(group, id);
        foreach (var user in new[] { alice, bob, carol }) await Webhook(server, "participant_joined", room, user.Key);

        // Only people in the call may rekey, and only for the current version.
        Assert.Equal("conflict", (await bob.RequestAsync("gcall.key", new { callId = id, version = 2, envelope = Key("key-2") })).ErrorCode());

        await alice.RequestAsync("group.change", Change(alice, group, 2, g.GetProperty("head").GetString()!, "remove", [carol.Key], [alice.Key, bob.Key]));
        Assert.Contains((room, carol.Key), server.Voice.Removed);
        JsonElement state;
        do state = (await bob.EventAsync("gcall.state")).Body().GetProperty("call");
        while (Participants(state).Contains(carol.Key));
        Assert.Equal(1, state.GetProperty("keyVersion").GetInt64()); // behind the group: time for a new key

        // Carol can't come back in, and doesn't get the new key.
        Assert.Equal("not_found", (await carol.RequestAsync("gcall.join", new { callId = id })).ErrorCode());
        await Webhook(server, "participant_joined", room, carol.Key);
        Assert.Equal(2, server.Voice.Removed.Count(r => r == (room, carol.Key)));

        Assert.Equal("result", (await bob.RequestAsync("gcall.key", new { callId = id, version = 2, envelope = Key("key-2") })).Type());
        var rekeyed = (await alice.EventAsync("gcall.key")).Body();
        Assert.Equal("key-2", rekeyed.GetProperty("envelope").GetProperty("ct").GetString());
        Assert.Equal(2, rekeyed.GetProperty("call").GetProperty("keyVersion").GetInt64());
        await carol.NoEventAsync("gcall.key");
        Assert.Equal("not_found", (await carol.RequestAsync("gcall.key", new { callId = id, version = 2, envelope = Key("evil") })).ErrorCode());
    }

    [Fact]
    public async Task Nobody_answering_ends_a_group_call_and_kicked_members_leave_it()
    {
        using var server = new IskraServer { RingTimeoutMs = 400 };
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var group = NewId();
        await CreateAsync(admin, group, bob, carol);

        // Nobody joins, not even the starter: the call is over once the ringing is.
        var id = NewId();
        await Start(admin, group, id);
        Assert.Equal(id, (await bob.EventAsync("gcall.ring.stopped")).Body().GetProperty("callId").GetString()); // ringing over
        Assert.Equal(id, (await carol.EventAsync("gcall.ended")).Body().GetProperty("callId").GetString());

        // A kicked member is dropped from a call in progress.
        id = NewId();
        await Start(admin, group, id);
        var room = GroupCallRegistry.RoomName(group, id);
        await Webhook(server, "participant_joined", room, admin.Key);
        await Webhook(server, "participant_joined", room, bob.Key);
        await admin.RequestAsync("member.kick", new { accountKey = bob.Key });
        Assert.Contains((room, bob.Key), server.Voice.Removed);
        var listed = (await carol.RequestAsync("gcall.list")).Body().GetProperty("calls")[0].GetProperty("call");
        Assert.Equal([admin.Key], Participants(listed));

        // LiveKit going away ends every call.
        server.Voice.Available = false;
        await carol.EventAsync("gcall.ended");
        Assert.Equal("voice_unavailable", (await Start(admin, group, NewId())).ErrorCode());
    }
}
