using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Tests;

/// <summary>Key transparency: the signed, hash-chained log of account keys (see "Key transparency" in PROTOCOL.md).</summary>
public class KeyLogTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static string KeyOf(Key key) => Ed25519.ToB64u(Ed25519.PublicKeyOf(key));

    private static JsonObject Rotation(Key from, Key to, long at)
    {
        var payload = Ed25519.Payload(KeyFeature.RotateContext, Ed25519.PublicKeyOf(from), Ed25519.PublicKeyOf(to), Ed25519.U64BigEndian(at));
        return new JsonObject
        {
            ["oldKey"] = KeyOf(from), ["newKey"] = KeyOf(to), ["rotatedAt"] = at,
            ["oldSig"] = Ed25519.ToB64u(Ed25519.Sign(from, payload)), ["newSig"] = Ed25519.ToB64u(Ed25519.Sign(to, payload)),
        };
    }

    private static JsonObject Recertify(TestIdentity device, Key account)
    {
        var devicePub = Ed25519.PublicKeyOf(device.Device);
        var sig = Ed25519.Sign(account, Ed25519.Payload(Identity.DeviceCertContext, devicePub, Ed25519.U64BigEndian(device.Created)));
        return new JsonObject { ["accountKey"] = KeyOf(account), ["deviceKey"] = Ed25519.ToB64u(devicePub), ["created"] = device.Created, ["sig"] = Ed25519.ToB64u(sig) };
    }

    private sealed record Entry(long Seq, string Data)
    {
        public JsonElement Json => JsonDocument.Parse(Data).RootElement;
        public string Kind => Json.GetProperty("kind").GetString()!;
    }

    /// <summary>Reads the whole log page by page, checking every link and the head's signature like a client does.</summary>
    private static async Task<List<Entry>> ReadLogAsync(IskraServer server, User user)
    {
        var entries = new List<Entry>();
        var hash = new byte[32];
        JsonElement head;
        while (true)
        {
            var body = (await user.RequestAsync("keylog.entries", new { after = entries.Count, limit = 2 })).Body();
            head = body.GetProperty("head");
            var page = body.GetProperty("entries").EnumerateArray().Select(e => new Entry(e.GetProperty("seq").GetInt64(), e.GetProperty("data").GetString()!)).ToList();
            foreach (var e in page)
            {
                Assert.Equal(entries.Count + 1, e.Seq);
                hash = KeyLogFeature.EntryHash(hash, e.Seq, e.Data);
                entries.Add(e);
            }
            if (page.Count == 0) break;
        }
        Assert.Equal(entries.Count, head.GetProperty("seq").GetInt64());
        Assert.Equal(Ed25519.ToB64u(hash), head.GetProperty("hash").GetString());
        Assert.True(VerifyHead(server, head));
        return entries;
    }

    private static bool VerifyHead(IskraServer server, JsonElement head)
    {
        Ed25519.TryFromB64u(head.GetProperty("hash").GetString(), out var hash);
        Ed25519.TryFromB64u(head.GetProperty("sig").GetString(), out var sig);
        var payload = KeyLogFeature.HeadPayload(server.World.ServerPublicKey, head.GetProperty("seq").GetInt64(), hash, head.GetProperty("at").GetInt64());
        return Ed25519.Verify(server.World.ServerPublicKey, payload, sig);
    }

    [Fact]
    public async Task Welcome_carries_a_signed_head_and_every_member_is_in_the_log()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "admin");
        using var bob = await server.JoinAsync("Bob");

        var head = bob.Welcome.Body().GetProperty("keyLog");
        Assert.True(VerifyHead(server, head));
        Assert.Equal(2, head.GetProperty("seq").GetInt64());

        var entries = await ReadLogAsync(server, alice);
        Assert.Equal(["join", "join"], entries.Select(e => e.Kind));
        Assert.Equal(alice.Key, entries[0].Json.GetProperty("key").GetString());
        Assert.Equal("Bob", entries[1].Json.GetProperty("name").GetString());

        // keylog.head is the same signed head; a forged signature wouldn't check out.
        var again = (await bob.RequestAsync("keylog.head")).Body().GetProperty("head");
        Assert.Equal(head.GetProperty("hash").GetString(), again.GetProperty("hash").GetString());
        var forged = JsonNode.Parse(again.GetRawText())!;
        forged["seq"] = 3;
        Assert.False(VerifyHead(server, JsonDocument.Parse(forged.ToJsonString()).RootElement));
    }

    [Fact]
    public async Task Names_and_rotations_are_appended_and_old_entries_never_change()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        await alice.RequestAsync("profile.update", new { name = "Alicia" });
        var before = await ReadLogAsync(server, bob);
        Assert.Equal(["join", "join", "name"], before.Select(e => e.Kind));

        using var next = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        var rotation = Rotation(alice.Identity.Account, next, Now);
        Assert.Equal("applied", (await alice.RequestAsync("account.rotate", new { rotation, certs = new[] { Recertify(alice.Identity, next) } })).Body().GetProperty("status").GetString());
        await bob.EventAsync("member.rotated");

        var after = await ReadLogAsync(server, bob);
        // The account move rewrites account keys everywhere else, but not in the log: the history stays verifiable.
        Assert.Equal(before, after.Take(before.Count));
        Assert.Equal(alice.Key, after[0].Json.GetProperty("key").GetString());
        var rotate = after[before.Count];
        Assert.Equal("rotate", rotate.Kind);
        Assert.Equal(rotation["newSig"]!.GetValue<string>(), rotate.Json.GetProperty("rotation").GetProperty("newSig").GetString());
        // The moved member is explained by the rotation, so there's no second join for the new key.
        Assert.Equal(before.Count + 1, after.Count);

        // Nothing changed: reading again appends nothing.
        Assert.Equal(after.Count, (await ReadLogAsync(server, bob)).Count);
    }

    [Fact]
    public async Task Disputes_and_their_resolution_are_logged()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var thief = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        using var real = Ed25519.KeyFromSeed(Ed25519.NewSeed());

        await alice.RequestAsync("account.rotate", new { rotation = Rotation(alice.Identity.Account, thief, Now) });
        await admin.EventAsync("member.rotated");
        using (var claim = await server.ConnectAsync())
        {
            var frame = alice.Identity.AuthFrame(await claim.ReceiveAsync(), "Alice", cert: Recertify(alice.Identity, real));
            frame["body"]!["rotations"] = new JsonArray(Rotation(alice.Identity.Account, real, Now));
            await claim.SendAsync(frame);
            Assert.Equal("account_disputed", (await claim.ReceiveAsync()).ErrorCode());
        }
        await admin.EventAsync("account.disputed");
        await admin.RequestAsync("account.dispute.resolve", new { oldKey = alice.Key, keep = KeyOf(real) });
        await admin.EventAsync("account.resolved");

        var entries = await ReadLogAsync(server, admin);
        Assert.Equal(["join", "join", "rotate", "contest", "resolve"], entries.Select(e => e.Kind));
        Assert.Equal(KeyOf(thief), entries[2].Json.GetProperty("rotation").GetProperty("newKey").GetString());
        Assert.Equal(KeyOf(real), entries[3].Json.GetProperty("rotation").GetProperty("newKey").GetString());
        Assert.Equal(KeyOf(real), entries[4].Json.GetProperty("rotation").GetProperty("newKey").GetString());
        Assert.Equal(KeyOf(thief), entries[4].Json.GetProperty("previousKey").GetString());
        Assert.Equal(entries.Count, (await ReadLogAsync(server, admin)).Count);
    }

    [Fact]
    public async Task Entries_are_paged_and_limits_are_enforced()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "admin");
        for (var i = 0; i < 4; i++) using (await server.JoinAsync($"Member{i}")) { }

        var page = (await alice.RequestAsync("keylog.entries", new { after = 2, limit = 2 })).Body();
        Assert.Equal([3L, 4L], page.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("seq").GetInt64()));
        Assert.Equal(5, page.GetProperty("head").GetProperty("seq").GetInt64());
        Assert.Empty((await alice.RequestAsync("keylog.entries", new { after = 5 })).Body().GetProperty("entries").EnumerateArray());

        Assert.Equal("bad_request", (await alice.RequestAsync("keylog.entries", new { limit = KeyLogFeature.MaxEntries + 1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("keylog.entries", new { after = -1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("keylog.entries", new { limit = 0 })).ErrorCode());
    }
}
