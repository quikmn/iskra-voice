using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class GroupTests
{
    public static string NewId() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));

    /// <summary>A signed membership change, built the way clients build them.</summary>
    public static object Change(User by, string group, long version, string prev, string action, string[] targets, string[] members,
        long? at = null, NSec.Cryptography.Key? signWith = null, string? byKey = null)
    {
        var payload = Encoding.UTF8.GetBytes(new JsonObject
        {
            ["v"] = 1, ["group"] = group, ["version"] = version, ["prev"] = prev, ["by"] = byKey ?? by.Key, ["action"] = action,
            ["targets"] = new JsonArray(targets.Select(t => (JsonNode)t).ToArray()),
            ["members"] = new JsonArray(members.Select(m => (JsonNode)m).ToArray()),
            ["at"] = at ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }.ToJsonString());
        var sig = Ed25519.Sign(signWith ?? by.Identity.Account, Ed25519.Payload(GroupChain.Context, payload));
        return new { change = new { payload = Ed25519.ToB64u(payload), sig = Ed25519.ToB64u(sig) } };
    }

    public static async Task<JsonElement> CreateAsync(User owner, string id, params User[] others)
    {
        var reply = await owner.RequestAsync("group.create",
            Change(owner, id, 1, "", "create", others.Select(o => o.Key).ToArray(), [owner.Key, .. others.Select(o => o.Key)]));
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("group");
    }

    private static string Head(JsonElement group) => group.GetProperty("head").GetString()!;
    private static string[] Members(JsonElement group) => group.GetProperty("members").EnumerateArray().Select(m => m.GetString()!).ToArray();

    private static object Envelope(string marker) => new { v = 2, kind = "group", ct = marker };

    [Fact]
    public async Task Creating_a_group_tells_its_members_and_the_chain_can_be_checked_by_anyone_in_it()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var eve = await server.JoinAsync("Eve", "admin");
        var id = NewId();

        var group = await CreateAsync(alice, id, bob, carol);
        Assert.Equal(1, group.GetProperty("version").GetInt64());
        Assert.Equal([alice.Key, bob.Key, carol.Key], Members(group));
        foreach (var user in new[] { alice, bob, carol })
            Assert.Equal(id, (await user.EventAsync("group.changed")).Body().GetProperty("group").GetProperty("id").GetString());
        await eve.NoEventAsync("group.changed");

        var got = (await bob.RequestAsync("group.get", new { groupId = id })).Body();
        var change = got.GetProperty("changes")[0];
        var payload = Base64UrlDecode(change.GetProperty("payload").GetString()!);
        Assert.Equal(Head(group), GroupChain.Head(payload));
        Assert.True(Ed25519.Verify(Base64UrlDecode(alice.Key), Ed25519.Payload(GroupChain.Context, payload), Base64UrlDecode(change.GetProperty("sig").GetString()!)));

        var listed = (await carol.RequestAsync("group.list")).Body().GetProperty("groups");
        Assert.Equal(id, listed[0].GetProperty("group").GetProperty("id").GetString());

        // An admin who isn't in it can't see it at all.
        Assert.Equal("not_found", (await eve.RequestAsync("group.get", new { groupId = id })).ErrorCode());
        Assert.Equal("not_found", (await eve.RequestAsync("group.history", new { groupId = id })).ErrorCode());
        Assert.Equal("not_found", (await eve.RequestAsync("group.send", new { groupId = id, version = 1, envelope = Envelope("x") })).ErrorCode());
        Assert.Empty((await eve.RequestAsync("group.list")).Body().GetProperty("groups").EnumerateArray());
    }

    private static byte[] Base64UrlDecode(string text) => System.Buffers.Text.Base64Url.DecodeFromChars(text);

    [Fact]
    public async Task Bad_or_forged_creations_are_refused()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var stranger = new TestIdentity();
        string Code(JsonElement reply) => reply.ErrorCode() ?? "ok";

        // Too few people.
        var id = NewId();
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create", Change(alice, id, 1, "", "create", [bob.Key], [alice.Key, bob.Key]))));
        // Someone who isn't on this server.
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create",
            Change(alice, id, 1, "", "create", [bob.Key, stranger.AccountKey], [alice.Key, bob.Key, stranger.AccountKey]))));
        // The member list must be exactly creator + targets.
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create",
            Change(alice, id, 1, "", "create", [bob.Key, carol.Key], [bob.Key, alice.Key, carol.Key]))));
        // Signed by someone else, or claiming to be someone else.
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create",
            Change(alice, id, 1, "", "create", [bob.Key, carol.Key], [alice.Key, bob.Key, carol.Key], signWith: bob.Identity.Account))));
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create",
            Change(bob, id, 1, "", "create", [alice.Key, carol.Key], [bob.Key, alice.Key, carol.Key]))));
        // A clock far off.
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create",
            Change(alice, id, 1, "", "create", [bob.Key, carol.Key], [alice.Key, bob.Key, carol.Key], at: DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeMilliseconds()))));
        // Not a change at all.
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create", new { change = new { payload = "!!", sig = "x" } })));
        // A duplicate person.
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create",
            Change(alice, id, 1, "", "create", [bob.Key, bob.Key], [alice.Key, bob.Key, bob.Key]))));
        Assert.Null(server.World.Store.GetGroup(id));

        // Eleven people is one too many.
        var many = new List<User>();
        for (var i = 0; i < 10; i++) many.Add(await server.JoinAsync($"P{i}"));
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create",
            Change(alice, id, 1, "", "create", many.Select(m => m.Key).ToArray(), [alice.Key, .. many.Select(m => m.Key)]))));
        // Ten is fine, and creating the same group twice isn't.
        await CreateAsync(alice, id, [.. many.Take(9)]);
        Assert.Equal("bad_request", Code(await alice.RequestAsync("group.create", Change(alice, id, 1, "", "create", [bob.Key, carol.Key], [alice.Key, bob.Key, carol.Key]))));
        foreach (var m in many) m.Dispose();
    }

    [Fact]
    public async Task Anyone_adds_people_only_the_owner_removes_and_anyone_can_leave()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dave = await server.JoinAsync("Dave");
        var id = NewId();
        var group = await CreateAsync(alice, id, bob, carol);

        // Bob (not the owner) adds Dave.
        var added = await bob.RequestAsync("group.change", Change(bob, id, 2, Head(group), "add", [dave.Key], [alice.Key, bob.Key, carol.Key, dave.Key]));
        group = added.Body().GetProperty("group");
        Assert.Equal(2, group.GetProperty("version").GetInt64());
        Assert.Equal(id, (await dave.EventAsync("group.changed")).Body().GetProperty("group").GetProperty("id").GetString());

        // Bob can't remove anyone; a change built on an old version is a conflict.
        Assert.Equal("forbidden", (await bob.RequestAsync("group.change", Change(bob, id, 3, Head(group), "remove", [carol.Key], [alice.Key, bob.Key, dave.Key]))).ErrorCode());
        Assert.Equal("conflict", (await alice.RequestAsync("group.change", Change(alice, id, 2, Head(group), "remove", [carol.Key], [alice.Key, bob.Key, dave.Key]))).ErrorCode());
        Assert.Equal("conflict", (await alice.RequestAsync("group.change", Change(alice, id, 3, "AAAA", "remove", [carol.Key], [alice.Key, bob.Key, dave.Key]))).ErrorCode());
        // Leaving is only ever for yourself.
        Assert.Equal("bad_request", (await bob.RequestAsync("group.change", Change(bob, id, 3, Head(group), "leave", [carol.Key], [alice.Key, bob.Key, dave.Key]))).ErrorCode());

        // Alice removes Carol: Carol hears about it, then the group is gone for her.
        group = (await alice.RequestAsync("group.change", Change(alice, id, 3, Head(group), "remove", [carol.Key], [alice.Key, bob.Key, dave.Key]))).Body().GetProperty("group");
        var seen = (await carol.EventAsync("group.changed")).Body(); // creation
        seen = (await carol.EventAsync("group.changed")).Body();     // Dave added
        seen = (await carol.EventAsync("group.changed")).Body();     // removed
        Assert.DoesNotContain(carol.Key, Members(seen.GetProperty("group")));
        Assert.Equal("not_found", (await carol.RequestAsync("group.get", new { groupId = id })).ErrorCode());
        Assert.Equal("not_found", (await carol.RequestAsync("group.send", new { groupId = id, version = 3, envelope = Envelope("x") })).ErrorCode());

        // The owner leaves: the longest-standing member (Bob) can now remove people.
        group = (await alice.RequestAsync("group.change", Change(alice, id, 4, Head(group), "leave", [alice.Key], [bob.Key, dave.Key]))).Body().GetProperty("group");
        Assert.Equal([bob.Key, dave.Key], Members(group));
        group = (await bob.RequestAsync("group.change", Change(bob, id, 5, Head(group), "remove", [dave.Key], [bob.Key]))).Body().GetProperty("group");
        // The last one out deletes it.
        await bob.RequestAsync("group.change", Change(bob, id, 6, Head(group), "leave", [bob.Key], []));
        Assert.Null(server.World.Store.GetGroup(id));

        // The full chain is there for members to check.
        var other = NewId();
        var g2 = await CreateAsync(alice, other, bob, carol);
        await bob.RequestAsync("group.change", Change(bob, other, 2, Head(g2), "add", [dave.Key], [alice.Key, bob.Key, carol.Key, dave.Key]));
        var changes = (await dave.RequestAsync("group.get", new { groupId = other })).Body().GetProperty("changes");
        Assert.Equal(2, changes.GetArrayLength());
        Assert.Equal(1, (await dave.RequestAsync("group.get", new { groupId = other, since = 1 })).Body().GetProperty("changes").GetArrayLength());
    }

    [Fact]
    public async Task Messages_go_to_current_members_only_and_must_be_for_the_current_version()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var eve = await server.JoinAsync("Eve");
        var id = NewId();
        var group = await CreateAsync(alice, id, bob, carol);

        var sent = (await alice.RequestAsync("group.send", new { groupId = id, version = 1, envelope = Envelope("hello") })).Body().GetProperty("message");
        Assert.Equal(alice.Key, sent.GetProperty("from").GetString());
        Assert.Equal(id, sent.GetProperty("group").GetString());
        foreach (var user in new[] { alice, bob, carol })
            Assert.Equal("hello", (await user.EventAsync("group.message")).Body().GetProperty("message").GetProperty("envelope").GetProperty("ct").GetString());
        await eve.NoEventAsync("group.message");
        Assert.Single((await carol.RequestAsync("group.history", new { groupId = id })).Body().GetProperty("messages").EnumerateArray());

        // After a change, a sender who still holds version 1 is told to refresh.
        group = (await alice.RequestAsync("group.change", Change(alice, id, 2, Head(group), "remove", [carol.Key], [alice.Key, bob.Key]))).Body().GetProperty("group");
        Assert.Equal("conflict", (await bob.RequestAsync("group.send", new { groupId = id, version = 1, envelope = Envelope("stale") })).ErrorCode());
        await bob.RequestAsync("group.send", new { groupId = id, version = 2, envelope = Envelope("fresh") });
        await carol.NoEventAsync("group.message");
        Assert.Equal("bad_request", (await bob.RequestAsync("group.send", new { groupId = id, version = 2, envelope = "text" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("group.send", new { groupId = id, version = 2, envelope = new { ct = new string('x', GroupFeature.MaxEnvelopeBytes) } })).ErrorCode());
    }

    [Fact]
    public async Task Group_pushes_never_carry_content_or_names_and_skip_the_sender()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var aliceEndpoint = $"https://fcm.googleapis.com/fcm/send/alice-{Guid.NewGuid():N}";
        var bobEndpoint = $"https://fcm.googleapis.com/fcm/send/bob-{Guid.NewGuid():N}";
        foreach (var (user, endpoint) in new[] { (alice, aliceEndpoint), (bob, bobEndpoint) })
        {
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var q = key.ExportParameters(false).Q;
            await user.RequestAsync("push.subscribe", new { endpoint, keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) } });
        }
        var id = NewId();
        await CreateAsync(alice, id, bob, carol);
        await alice.RequestAsync("group.send", new { groupId = id, version = 1, envelope = Envelope("secret plans") });

        var push = (await server.Push.WaitForAsync(bobEndpoint)).Single();
        Assert.Equal("group", push.GetProperty("kind").GetString());
        Assert.Equal(id, push.GetProperty("group").GetString());
        Assert.Equal("New message from Alice", push.GetProperty("title").GetString());
        Assert.DoesNotContain("secret", push.GetRawText());
        await server.Push.NoneAsync(aliceEndpoint);
    }

    [Fact]
    public async Task Bots_cannot_be_in_groups()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");
        // Mark Bob as a bot directly: the rule is about the account, whoever made it one.
        server.World.Store.AddBot(bob.Key, admin.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Assert.Equal("bad_request", (await alice.RequestAsync("group.create",
            Change(alice, NewId(), 1, "", "create", [bob.Key, admin.Key], [alice.Key, bob.Key, admin.Key]))).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("group.create",
            Change(bob, NewId(), 1, "", "create", [alice.Key, admin.Key], [bob.Key, alice.Key, admin.Key]))).ErrorCode());
    }
}
