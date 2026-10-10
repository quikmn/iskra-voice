using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;

namespace Iskra.Server.Tests;

public class CallTests
{
    private static string NewId() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));

    /// <summary>Stands in for the caller's encrypted invite; the server only relays it.</summary>
    private static object Envelope() => new { v = 1, ct = "opaque-ciphertext" };

    private static Task<JsonElement> Start(User caller, User callee, string id, bool video = false) =>
        caller.RequestAsync("call.start", new { accountKey = callee.Key, callId = id, video, envelope = Envelope() });

    private static JsonElement Claims(IskraServer server, string token) =>
        LiveKitTokens.Verify(token, server.Voice.ApiKey, server.Voice.ApiSecret, DateTimeOffset.UtcNow)
        ?? throw new Xunit.Sdk.XunitException("token did not verify");

    private static async Task<HttpStatusCode> Webhook(IskraServer server, string type, string room, string identity)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { @event = type, room = new { name = room }, participant = new { identity } });
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        request.Headers.TryAddWithoutValidation("Authorization", LiveKitTokens.Sign(new JsonObject
        {
            ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = Convert.ToBase64String(SHA256.HashData(body)),
        }, server.Voice.ApiSecret));
        using var response = await server.CreateClient().SendAsync(request);
        return response.StatusCode;
    }

    [Fact]
    public async Task A_call_rings_only_the_callee_and_both_get_tokens_for_one_private_room()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");
        // Bob's phone: a second device of the same account rings too.
        using var phone = new TestIdentity(bob.Identity.Account);
        using var phoneClient = await server.ConnectAsync();
        Assert.Equal("welcome", (await phoneClient.LoginAsync(phone, "Bob")).Type());

        var id = NewId();
        var started = (await Start(alice, bob, id, video: true)).Body();
        var room = CallRegistry.RoomName(alice.Key, bob.Key, id);
        Assert.Equal(room, started.GetProperty("room").GetString());
        Assert.Equal("ringing", started.GetProperty("call").GetProperty("state").GetString());
        var aliceClaims = Claims(server, started.GetProperty("token").GetString()!);
        Assert.Equal(alice.Key, aliceClaims.GetProperty("sub").GetString());
        Assert.Equal(room, aliceClaims.GetProperty("video").GetProperty("room").GetString());
        Assert.False(aliceClaims.GetProperty("video").TryGetProperty("roomAdmin", out _));

        foreach (var ring in new[] { (await bob.EventAsync("call.ring")).Body(), (await phoneClient.EventAsync("call.ring")).Body() })
        {
            Assert.Equal(id, ring.GetProperty("call").GetProperty("id").GetString());
            Assert.Equal(alice.Key, ring.GetProperty("call").GetProperty("from").GetString());
            Assert.True(ring.GetProperty("call").GetProperty("video").GetBoolean());
            Assert.Equal("opaque-ciphertext", ring.GetProperty("envelope").GetProperty("ct").GetString());
        }
        await alice.NoEventAsync("call.ring");
        await admin.NoEventAsync("call.ring");

        var accepted = (await bob.RequestAsync("call.accept", new { callId = id })).Body();
        Assert.Equal(room, accepted.GetProperty("room").GetString());
        Assert.Equal(bob.Key, Claims(server, accepted.GetProperty("token").GetString()!).GetProperty("sub").GetString());
        await alice.EventAsync("call.accepted");
        await phoneClient.EventAsync("call.accepted"); // the phone stops ringing
        await bob.NoEventAsync("call.accepted");      // the device that answered already knows
        await admin.NoEventAsync("call.accepted");

        await alice.RequestAsync("call.end", new { callId = id });
        foreach (var client in new[] { alice.Client, bob.Client, phoneClient })
            Assert.Equal("ended", (await client.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
        await admin.NoEventAsync("call.ended");
        lock (server.Voice.Removed)
        {
            Assert.Contains((room, alice.Key), server.Voice.Removed);
            Assert.Contains((room, bob.Key), server.Voice.Removed);
        }
    }

    [Fact]
    public async Task Nobody_else_can_answer_decline_end_or_see_a_call_not_even_an_admin()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var owner = await server.JoinAsync("Owner", "owner");
        var id = NewId();
        await Start(alice, bob, id);

        Assert.Equal("not_found", (await owner.RequestAsync("call.accept", new { callId = id })).ErrorCode());
        Assert.Equal("not_found", (await owner.RequestAsync("call.decline", new { callId = id })).ErrorCode());
        Assert.Equal("not_found", (await owner.RequestAsync("call.end", new { callId = id })).ErrorCode());
        Assert.Equal(0, (await owner.RequestAsync("call.pending")).Body().GetProperty("calls").GetArrayLength());
        // The caller can't answer their own call.
        Assert.Equal("forbidden", (await alice.RequestAsync("call.accept", new { callId = id })).ErrorCode());
        await owner.NoEventAsync("call.ring");

        // A device that connects while it rings can still pick it up.
        var pending = (await bob.RequestAsync("call.pending")).Body().GetProperty("calls");
        Assert.Equal(id, pending[0].GetProperty("call").GetProperty("id").GetString());
    }

    [Fact]
    public async Task Someone_else_in_the_call_room_is_removed()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = NewId();
        var room = (await Start(alice, bob, id)).Body().GetProperty("room").GetString()!;

        Assert.Equal(HttpStatusCode.OK, await Webhook(server, "participant_joined", room, admin.Key));
        lock (server.Voice.Removed) Assert.Contains((room, admin.Key), server.Voice.Removed);
        // So is anyone in a call room that isn't a call (anymore).
        await Webhook(server, "participant_joined", "call-0123456789abcdef0123456789abcdef", alice.Key);
        lock (server.Voice.Removed) Assert.Contains(("call-0123456789abcdef0123456789abcdef", alice.Key), server.Voice.Removed);

        // Presence comes from LiveKit and goes only to the two people.
        await Webhook(server, "participant_joined", room, alice.Key);
        var state = (await alice.EventAsync("call.state")).Body();
        Assert.Equal(alice.Key, state.GetProperty("participants")[0].GetString());
        await bob.EventAsync("call.state");
        await admin.NoEventAsync("call.state");

        await bob.RequestAsync("call.accept", new { callId = id });
        await Webhook(server, "participant_joined", room, bob.Key);
        Assert.Equal(2, (await bob.EventAsync("call.state")).Body().GetProperty("participants").GetArrayLength());

        // Someone leaving an answered call ends it for both.
        await Webhook(server, "participant_left", room, bob.Key);
        Assert.Equal("ended", (await alice.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
        Assert.Equal("not_found", (await alice.RequestAsync("call.end", new { callId = id })).ErrorCode());
    }

    [Fact]
    public async Task Declining_and_busy_end_the_call_for_the_caller()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");

        var first = NewId();
        await Start(alice, bob, first);
        await bob.RequestAsync("call.decline", new { callId = first });
        Assert.Equal("declined", (await alice.EventAsync("call.ended")).Body().GetProperty("reason").GetString());

        // Bob's app says he's busy (e.g. in a call on another server).
        var second = NewId();
        await Start(alice, bob, second);
        await bob.RequestAsync("call.decline", new { callId = second, reason = "busy" });
        Assert.Equal("busy", (await alice.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
        Assert.Equal("bad_request", (await bob.RequestAsync("call.decline", new { callId = NewId(), reason = "nope" })).ErrorCode());

        // Someone already in a call here is busy.
        var third = NewId();
        await Start(alice, bob, third);
        await bob.RequestAsync("call.accept", new { callId = third });
        for (var i = 0; i < 3; i++) await bob.EventAsync("call.ring");
        var busy = await Start(carol, bob, NewId());
        Assert.Equal("busy", busy.ErrorCode());
        await bob.NoEventAsync("call.ring");

        // The caller cancelling while it rings.
        await alice.RequestAsync("call.end", new { callId = third });
        var fourth = NewId();
        await Start(carol, bob, fourth);
        await carol.RequestAsync("call.end", new { callId = fourth });
        Assert.Equal("cancelled", (await carol.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
    }

    [Fact]
    public async Task An_unanswered_call_times_out()
    {
        using var server = new IskraServer { RingTimeoutMs = 300 };
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = NewId();
        await Start(alice, bob, id);
        Assert.Equal("no_answer", (await alice.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
        Assert.Equal("no_answer", (await bob.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
        Assert.Equal("not_found", (await bob.RequestAsync("call.accept", new { callId = id })).ErrorCode());
    }

    [Fact]
    public async Task Call_requests_are_checked()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var stranger = new TestIdentity();

        Assert.Equal("bad_request", (await Start(alice, alice, NewId())).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("call.start",
            new { accountKey = stranger.AccountKey, callId = NewId(), envelope = Envelope() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("call.start",
            new { accountKey = bob.Key, callId = "short", envelope = Envelope() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("call.start",
            new { accountKey = bob.Key, callId = NewId(), envelope = "text" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("call.start",
            new { accountKey = bob.Key, callId = NewId(), envelope = new { pad = new string('x', 33 * 1024) } })).ErrorCode());

        var id = NewId();
        await Start(alice, bob, id);
        Assert.Equal("bad_request", (await Start(alice, bob, id)).ErrorCode()); // ids are single use

        server.Voice.Available = false;
        Assert.Equal("ended", (await alice.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
        Assert.Equal("voice_unavailable", (await Start(alice, bob, NewId())).ErrorCode());
    }

    [Fact]
    public async Task Calls_are_rate_limited_per_account_and_callee()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");

        for (var i = 0; i < 3; i++)
        {
            var id = NewId();
            Assert.Equal("result", (await Start(alice, bob, id)).Type());
            await alice.RequestAsync("call.end", new { callId = id });
        }
        Assert.Equal("rate_limited", (await Start(alice, bob, NewId())).ErrorCode());
        // A second connection doesn't reset it, and someone else can still be called.
        using var again = await server.ConnectAsync();
        await again.LoginAsync(alice.Identity, "Alice");
        Assert.Equal("rate_limited", (await again.RequestAsync("call.start", new { accountKey = bob.Key, callId = NewId(), envelope = Envelope() })).ErrorCode());
        Assert.Equal("result", (await Start(alice, carol, NewId())).Type());
    }

    [Fact]
    public async Task Removing_a_member_ends_their_calls()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = NewId();
        await Start(alice, bob, id);
        await bob.RequestAsync("call.accept", new { callId = id });

        await admin.RequestAsync("member.kick", new { accountKey = bob.Key });
        Assert.Equal("ended", (await alice.EventAsync("call.ended")).Body().GetProperty("reason").GetString());
    }
}
