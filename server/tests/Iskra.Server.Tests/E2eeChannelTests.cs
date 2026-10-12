using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class E2eeChannelTests
{
    private static string DeviceKey(User u) => Ed25519.ToB64u(Ed25519.PublicKeyOf(u.Identity.Device));

    /// <summary>A signed channel membership change, built the way clients build them.</summary>
    private static (JsonObject Change, string Head) Change(User by, string chain, long version, string prev, string action, string[] targets,
        string[] members, NSec.Cryptography.Key? signWith = null)
    {
        var payload = Encoding.UTF8.GetBytes(new JsonObject
        {
            ["v"] = 1, ["group"] = chain, ["version"] = version, ["prev"] = prev, ["by"] = by.Key, ["action"] = action,
            ["targets"] = new JsonArray(targets.Select(t => (JsonNode)t).ToArray()),
            ["members"] = new JsonArray(members.Select(m => (JsonNode)m).ToArray()),
            ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }.ToJsonString());
        var sig = Ed25519.Sign(signWith ?? by.Identity.Account, Ed25519.Payload(E2eeChannelFeature.Context, payload));
        return (new JsonObject { ["payload"] = Ed25519.ToB64u(payload), ["sig"] = Ed25519.ToB64u(sig) }, GroupChain.Head(payload));
    }

    /// <summary>A channel key envelope as the server sees it: a header and one slot per device (contents opaque here).</summary>
    private static JsonObject KeyEnvelope(User from, string chain, long version, params User[] to) => new()
    {
        ["v"] = 2, ["kind"] = "channel-key",
        ["header"] = new JsonObject { ["from"] = from.Key, ["chain"] = chain, ["version"] = version, ["head"] = "", ["sentAt"] = 1, ["id"] = "k" },
        ["nonce"] = "n", ["ct"] = "opaque",
        ["keys"] = new JsonArray(to.Select(u => (JsonNode)new JsonObject { ["device"] = DeviceKey(u), ["nonce"] = "x", ["box"] = "y" }).ToArray()),
    };

    private static JsonObject MessageEnvelope(User from, string chain, long version, string ct) => new()
    {
        ["v"] = 1, ["kind"] = "channel",
        ["header"] = new JsonObject { ["from"] = from.Key, ["chain"] = chain, ["version"] = version, ["sentAt"] = 1, ["id"] = "m" },
        ["nonce"] = "n", ["ct"] = ct, ["sig"] = "s",
    };

    private sealed record Setup(IskraServer Server, User Owner, User Bob, User Carol, User Dave, long ChannelId, string Chain, string Head) : IDisposable
    {
        public void Dispose()
        {
            foreach (var u in new[] { Owner, Bob, Carol, Dave }) u.Dispose();
            Server.Dispose();
        }
    }

    /// <summary>An encrypted channel only trusted+ can read: the owner, Bob and Carol. Dave is a member.</summary>
    private static async Task<Setup> CreateAsync()
    {
        var server = new IskraServer();
        var owner = await server.JoinAsync("Owner", "owner");
        var bob = await server.JoinAsync("Bob", "trusted");
        var carol = await server.JoinAsync("Carol", "trusted");
        var dave = await server.JoinAsync("Dave");
        var chain = GroupTests.NewId();
        var (change, head) = Change(owner, chain, 1, "", "create", [bob.Key, carol.Key], [owner.Key, bob.Key, carol.Key]);
        var reply = await owner.RequestAsync("channel.create", new
        {
            name = "secret", readRole = "trusted",
            e2ee = new { change, keys = new[] { KeyEnvelope(owner, chain, 1, owner, bob, carol) } },
        });
        Assert.Equal("result", reply.Type());
        var channel = reply.Body().GetProperty("channel");
        Assert.Equal(chain, channel.GetProperty("e2ee").GetProperty("chain").GetString());
        return new Setup(server, owner, bob, carol, dave, channel.GetProperty("id").GetInt64(), chain, head);
    }

    private static object Send(Setup t, User from, long version, string ct, string? nonce = null) =>
        new { channelId = t.ChannelId, version, envelope = MessageEnvelope(from, t.Chain, version, ct), nonce };

    [Fact]
    public async Task Creating_needs_exactly_the_readers_and_a_key()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob", "trusted");
        using var dave = await server.JoinAsync("Dave");
        var chain = GroupTests.NewId();
        string Code(JsonElement r) => r.ErrorCode() ?? "ok";

        // Someone missing, or someone who can't read it, is refused (conflict: the app refreshes and tries again).
        var (onlyMe, _) = Change(owner, chain, 1, "", "create", [], [owner.Key]);
        Assert.Equal("conflict", Code(await owner.RequestAsync("channel.create",
            new { name = "s", readRole = "trusted", e2ee = new { change = onlyMe, keys = new[] { KeyEnvelope(owner, chain, 1, owner) } } })));
        var (withDave, _) = Change(owner, chain, 1, "", "create", [bob.Key, dave.Key], [owner.Key, bob.Key, dave.Key]);
        Assert.Equal("conflict", Code(await owner.RequestAsync("channel.create",
            new { name = "s", readRole = "trusted", e2ee = new { change = withDave, keys = new[] { KeyEnvelope(owner, chain, 1, owner) } } })));

        var (good, _) = Change(owner, chain, 1, "", "create", [bob.Key], [owner.Key, bob.Key]);
        // No key, a key for another version, or a kind that can't be encrypted.
        Assert.Equal("bad_request", Code(await owner.RequestAsync("channel.create", new { name = "s", readRole = "trusted", e2ee = new { change = good } })));
        Assert.Equal("bad_request", Code(await owner.RequestAsync("channel.create",
            new { name = "s", readRole = "trusted", e2ee = new { change = good, keys = new[] { KeyEnvelope(owner, chain, 2, owner) } } })));
        Assert.Equal("bad_request", Code(await owner.RequestAsync("channel.create",
            new { name = "s", kind = "docs", readRole = "trusted", e2ee = new { change = good, keys = new[] { KeyEnvelope(owner, chain, 1, owner) } } })));
        // Signed by someone else.
        var (forged, _) = Change(owner, chain, 1, "", "create", [bob.Key], [owner.Key, bob.Key], signWith: bob.Identity.Account);
        Assert.Equal("bad_request", Code(await owner.RequestAsync("channel.create",
            new { name = "s", readRole = "trusted", e2ee = new { change = forged, keys = new[] { KeyEnvelope(owner, chain, 1, owner) } } })));
        Assert.DoesNotContain(server.World.Store.AllChannels(), c => c.Name == "s");

        Assert.Equal("ok", Code(await owner.RequestAsync("channel.create",
            new { name = "s", readRole = "trusted", e2ee = new { change = good, keys = new[] { KeyEnvelope(owner, chain, 1, owner, bob) } } })));
        // Bob sees the lock; Dave doesn't see the channel at all.
        var channels = (await bob.EventAsync("channels")).Body().GetProperty("channels");
        var secret = channels.EnumerateArray().Single(c => c.GetProperty("name").GetString() == "s");
        Assert.Equal(1, secret.GetProperty("e2ee").GetProperty("version").GetInt64());
        var general = channels.EnumerateArray().Single(c => c.GetProperty("name").GetString() == "general");
        Assert.Equal(JsonValueKind.Null, general.GetProperty("e2ee").ValueKind);
    }

    [Fact]
    public async Task The_server_stores_and_relays_only_ciphertext_to_readers()
    {
        using var t = await CreateAsync();
        const string Marker = "CIPHERTEXT-ONLY";

        // Plain text, server-side attachments or a missing version are refused; so is an old version.
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("chat.send", new { channelId = t.ChannelId, text = "hello in the clear" })).ErrorCode());
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("chat.send",
            new { channelId = t.ChannelId, version = 1, text = "leak", envelope = MessageEnvelope(t.Bob, t.Chain, 1, Marker) })).ErrorCode());
        Assert.Equal("conflict", (await t.Bob.RequestAsync("chat.send", Send(t, t.Bob, 2, Marker))).ErrorCode());
        // The envelope must name its sender and chain.
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("chat.send",
            new { channelId = t.ChannelId, version = 1, envelope = MessageEnvelope(t.Carol, t.Chain, 1, Marker) })).ErrorCode());

        var sent = await t.Bob.RequestAsync("chat.send", Send(t, t.Bob, 1, Marker, nonce: "nonce-123456"));
        Assert.Equal("result", sent.Type());
        var message = sent.Body().GetProperty("message");
        Assert.Equal("", message.GetProperty("text").GetString());
        Assert.Equal(Marker, message.GetProperty("e2ee").GetProperty("envelope").GetProperty("ct").GetString());

        foreach (var reader in new[] { t.Owner, t.Carol })
            Assert.Equal(Marker, (await reader.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("e2ee")
                .GetProperty("envelope").GetProperty("ct").GetString());
        await t.Dave.NoEventAsync("chat.message");
        Assert.Equal("not_found", (await t.Dave.RequestAsync("chat.history", new { channelId = t.ChannelId })).ErrorCode());

        // History carries the envelope; the database has no text, and server search can't find it.
        var history = (await t.Carol.RequestAsync("chat.history", new { channelId = t.ChannelId })).Body().GetProperty("messages");
        Assert.Equal(Marker, history[0].GetProperty("e2ee").GetProperty("envelope").GetProperty("ct").GetString());
        Assert.Equal("", t.Server.World.Store.GetMessage(message.GetProperty("id").GetInt64())!.Text);
        var search = (await t.Owner.RequestAsync("search", new { author = t.Bob.Key })).Body().GetProperty("results");
        Assert.Empty(search.EnumerateArray());

        // Edits are envelopes too.
        var edited = await t.Bob.RequestAsync("chat.edit", new { id = message.GetProperty("id").GetInt64(), version = 1, envelope = MessageEnvelope(t.Bob, t.Chain, 1, "EDITED") });
        Assert.Equal("EDITED", edited.Body().GetProperty("message").GetProperty("e2ee").GetProperty("envelope").GetProperty("ct").GetString());
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("chat.edit", new { id = message.GetProperty("id").GetInt64(), text = "plain" })).ErrorCode());
    }

    [Fact]
    public async Task Features_that_need_plaintext_are_refused()
    {
        using var t = await CreateAsync();
        var sent = (await t.Bob.RequestAsync("chat.send", Send(t, t.Bob, 1, "x"))).Body().GetProperty("message").GetProperty("id").GetInt64();
        static void Refused(JsonElement r)
        {
            Assert.Equal("bad_request", r.ErrorCode());
            Assert.Contains("encrypted", r.Body().GetProperty("message").GetString());
        }
        Refused(await t.Owner.RequestAsync("webhook.create", new { channelId = t.ChannelId, name = "Hook" }));
        Refused(await t.Owner.RequestAsync("poll.create", new { channelId = t.ChannelId, question = "Q?", options = new[] { "a", "b" } }));
        Refused(await t.Owner.RequestAsync("chat.forward", new { id = sent, channelId = t.Server.General }));
        Refused(await t.Owner.RequestAsync("scheduled.create",
            new { channelId = t.ChannelId, text = "later", sendAt = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds() }));
        Refused(await t.Owner.RequestAsync("chat.send", new { channelId = t.ChannelId, text = "in the clear" }));

        // Threads work (their messages are encrypted under the channel's key) but have no name the server could read.
        var thread = (await t.Bob.RequestAsync("thread.create", new { messageId = sent, name = "secret plans" })).Body().GetProperty("thread");
        Assert.Equal(ThreadFeature.EncryptedThreadName, thread.GetProperty("name").GetString());
        var threadId = thread.GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("chat.send", new { channelId = threadId, text = "in the clear" })).ErrorCode());
        Assert.Equal("result", (await t.Carol.RequestAsync("chat.send",
            new { channelId = threadId, version = 1, envelope = MessageEnvelope(t.Carol, t.Chain, 1, "thread-ct") })).Type());
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("thread.update", new { id = threadId, name = "renamed" })).ErrorCode());

        // A report shares what the reporter read (with consent), marked as unverifiable by the server.
        var report = await t.Carol.RequestAsync("report.create", new
        {
            messageId = sent, reason = "harassment",
            messages = new[] { new { author = t.Bob.Key, text = "what I read", at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() } },
        });
        Assert.Equal("result", report.Type());
        var listed = (await t.Owner.RequestAsync("report.list")).Body().GetProperty("reports")[0];
        Assert.Equal("what I read", listed.GetProperty("messages")[0].GetProperty("text").GetString());
        Assert.Equal("", listed.GetProperty("message").GetProperty("text").GetString());
    }

    [Fact]
    public async Task Permission_changes_drive_membership_and_people_who_lose_access_get_nothing()
    {
        using var t = await CreateAsync();
        // Carol loses access: the server stops delivering to her at once, and asks the members to remove her.
        Assert.Equal("result", (await t.Owner.RequestAsync("member.setRole", new { accountKey = t.Carol.Key, role = "member" })).Type());
        var get = (await t.Bob.RequestAsync("echan.get", new { channelId = t.ChannelId })).Body();
        Assert.Equal([t.Carol.Key], get.GetProperty("want").GetProperty("remove").EnumerateArray().Select(x => x.GetString()));
        Assert.Empty(get.GetProperty("want").GetProperty("add").EnumerateArray());
        Assert.Equal("not_found", (await t.Carol.RequestAsync("echan.get", new { channelId = t.ChannelId })).ErrorCode());
        Assert.Equal("not_found", (await t.Carol.RequestAsync("echan.keys", new { channelId = t.ChannelId })).ErrorCode());

        // Only people who can't read it can be removed, and only people who can read it added.
        var (removeOwner, _) = Change(t.Bob, t.Chain, 2, t.Head, "remove", [t.Owner.Key], [t.Bob.Key, t.Carol.Key]);
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = removeOwner, keys = new[] { KeyEnvelope(t.Bob, t.Chain, 2, t.Bob) } })).ErrorCode());
        var (addDave, _) = Change(t.Bob, t.Chain, 2, t.Head, "add", [t.Dave.Key], [t.Owner.Key, t.Bob.Key, t.Carol.Key, t.Dave.Key]);
        Assert.Equal("not_found", (await t.Dave.RequestAsync("echan.get", new { channelId = t.ChannelId })).ErrorCode());
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = addDave, keys = new[] { KeyEnvelope(t.Bob, t.Chain, 2, t.Bob) } })).ErrorCode());

        // Bob removes Carol, with a new key for the others.
        var (removeCarol, head2) = Change(t.Bob, t.Chain, 2, t.Head, "remove", [t.Carol.Key], [t.Owner.Key, t.Bob.Key]);
        var removed = await t.Bob.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = removeCarol, keys = new[] { KeyEnvelope(t.Bob, t.Chain, 2, t.Owner, t.Bob) } });
        Assert.Equal("result", removed.Type());
        Assert.Equal(2, (await t.Owner.EventAsync("echan.changed")).Body().GetProperty("e2ee").GetProperty("version").GetInt64());
        await t.Carol.NoEventAsync("echan.changed");

        // Messages for the old version are refused; new ones never reach Carol.
        Assert.Equal("conflict", (await t.Owner.RequestAsync("chat.send", Send(t, t.Owner, 1, "old"))).ErrorCode());
        Assert.Equal("result", (await t.Owner.RequestAsync("chat.send", Send(t, t.Owner, 2, "after-removal"))).Type());
        await t.Carol.NoEventAsync("chat.message");

        // Dave gains access: he sees the channel and that he's waiting; until added, he can't send.
        Assert.Equal("result", (await t.Owner.RequestAsync("member.setRole", new { accountKey = t.Dave.Key, role = "trusted" })).Type());
        Assert.Equal([t.Dave.Key], (await t.Dave.RequestAsync("echan.get", new { channelId = t.ChannelId })).Body()
            .GetProperty("want").GetProperty("add").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal("forbidden", (await t.Dave.RequestAsync("chat.send", Send(t, t.Dave, 2, "x"))).ErrorCode());
        // Someone outside the chain can't change it.
        var (selfAdd, _) = Change(t.Dave, t.Chain, 3, head2, "add", [t.Dave.Key], [t.Owner.Key, t.Bob.Key, t.Dave.Key]);
        Assert.Equal("forbidden", (await t.Dave.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = selfAdd, keys = new[] { KeyEnvelope(t.Dave, t.Chain, 3, t.Dave) } })).ErrorCode());

        var (add, _) = Change(t.Owner, t.Chain, 3, head2, "add", [t.Dave.Key], [t.Owner.Key, t.Bob.Key, t.Dave.Key]);
        Assert.Equal("result", (await t.Owner.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = add, keys = new[] { KeyEnvelope(t.Owner, t.Chain, 3, t.Owner, t.Bob) } })).Type());
        // More key envelopes: only from whoever made the change.
        Assert.Equal("forbidden", (await t.Bob.RequestAsync("echan.keys.add",
            new { channelId = t.ChannelId, version = 3, keys = new[] { KeyEnvelope(t.Bob, t.Chain, 3, t.Dave) } })).ErrorCode());
        Assert.Equal("result", (await t.Owner.RequestAsync("echan.keys.add",
            new { channelId = t.ChannelId, version = 3, keys = new[] { KeyEnvelope(t.Owner, t.Chain, 3, t.Dave) } })).Type());

        // Each device fetches only the envelopes with a slot for it: Dave gets the one key from when he was added, nothing older.
        var daveKeys = (await t.Dave.RequestAsync("echan.keys", new { channelId = t.ChannelId })).Body().GetProperty("keys");
        Assert.Equal([3L], daveKeys.EnumerateArray().Select(k => k.GetProperty("version").GetInt64()));
        var bobKeys = (await t.Bob.RequestAsync("echan.keys", new { channelId = t.ChannelId })).Body().GetProperty("keys");
        Assert.Equal([1L, 2L, 3L], bobKeys.EnumerateArray().Select(k => k.GetProperty("version").GetInt64()));
        Assert.Equal("result", (await t.Dave.RequestAsync("chat.send", Send(t, t.Dave, 3, "hi"))).Type());
    }

    [Fact]
    public async Task Permission_overrides_drive_membership_like_roles_do()
    {
        using var t = await CreateAsync();
        async Task<long> Role(string name) =>
            (await t.Owner.RequestAsync("role.create", new { name, permissions = Array.Empty<string>() })).Body().GetProperty("role").GetProperty("id").GetInt64();
        var hidden = await Role("Hidden");
        var guests = await Role("Guests");
        Assert.Equal("result", (await t.Owner.RequestAsync("member.roles.set", new { accountKey = t.Carol.Key, roles = new[] { hidden } })).Type());
        Assert.Equal("result", (await t.Owner.RequestAsync("member.roles.set", new { accountKey = t.Dave.Key, roles = new[] { guests } })).Type());

        // Deny view for Carol's role: she stops getting anything at once, and the members are asked to remove her.
        Assert.Equal("result", (await t.Owner.RequestAsync("channel.overrides.set", new { id = t.ChannelId, roleId = hidden, deny = new[] { "view" } })).Type());
        Assert.Equal("not_found", (await t.Carol.RequestAsync("echan.get", new { channelId = t.ChannelId })).ErrorCode());
        Assert.Equal("not_found", (await t.Carol.RequestAsync("echan.keys", new { channelId = t.ChannelId })).ErrorCode());
        Assert.Equal("result", (await t.Owner.RequestAsync("chat.send", Send(t, t.Owner, 1, "while-carol-is-hidden"))).Type());
        await t.Carol.NoEventAsync("chat.message");

        // Allow view for Dave's role: the members are asked to add him.
        Assert.Equal("result", (await t.Owner.RequestAsync("channel.overrides.set", new { id = t.ChannelId, roleId = guests, allow = new[] { "view" } })).Type());
        var want = (await t.Bob.RequestAsync("echan.get", new { channelId = t.ChannelId })).Body().GetProperty("want");
        Assert.Equal([t.Carol.Key], want.GetProperty("remove").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal([t.Dave.Key], want.GetProperty("add").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal("result", (await t.Dave.RequestAsync("echan.get", new { channelId = t.ChannelId })).Type());
    }

    [Fact]
    public async Task A_rekey_keeps_the_members_and_a_chain_can_restart_when_nobody_in_it_can_read()
    {
        using var t = await CreateAsync();
        var (rekey, head2) = Change(t.Carol, t.Chain, 2, t.Head, "rekey", [], [t.Owner.Key, t.Bob.Key, t.Carol.Key]);
        Assert.Equal("result", (await t.Carol.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = rekey, keys = new[] { KeyEnvelope(t.Carol, t.Chain, 2, t.Owner, t.Bob, t.Carol) } })).Type());
        // The chain must fit together.
        var (stale, _) = Change(t.Bob, t.Chain, 2, t.Head, "rekey", [], [t.Owner.Key, t.Bob.Key, t.Carol.Key]);
        Assert.Equal("conflict", (await t.Bob.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = stale, keys = new[] { KeyEnvelope(t.Bob, t.Chain, 2, t.Bob) } })).ErrorCode());

        // While someone in the chain can still read, nobody may start over.
        var fresh = GroupTests.NewId();
        var (restart, _) = Change(t.Dave, fresh, 1, "", "create", [], [t.Dave.Key]);
        await t.Owner.RequestAsync("member.setRole", new { accountKey = t.Dave.Key, role = "trusted" });
        Assert.Equal("bad_request", (await t.Dave.RequestAsync("echan.change",
            new { channelId = t.ChannelId, change = restart, keys = new[] { KeyEnvelope(t.Dave, fresh, 1, t.Dave) } })).ErrorCode());
        Assert.NotNull(head2);
    }

    [Fact]
    public async Task Encrypted_uploads_are_for_the_chain_and_bots_stay_out()
    {
        using var t = await CreateAsync();
        var begin = await t.Bob.RequestAsync("dm.upload.begin", new { channelId = t.ChannelId, size = 100 });
        Assert.Equal("result", begin.Type());
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("dm.upload.begin", new { channelId = t.Server.General, size = 100 })).ErrorCode());
        Assert.Equal("not_found", (await t.Dave.RequestAsync("dm.upload.begin", new { channelId = t.ChannelId, size = 100 })).ErrorCode());
        // Bots never count as readers to add.
        var readers = E2eeChannelFeature.Readers(t.Server.World.Store, t.Server.World.Store.GetChannel(t.ChannelId)!);
        Assert.Equal([t.Owner.Key, t.Bob.Key, t.Carol.Key], readers);
    }
}
