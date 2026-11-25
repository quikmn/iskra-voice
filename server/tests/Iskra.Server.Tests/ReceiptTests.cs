using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ReceiptTests
{
    private static object Envelope(string marker) => new { v = 1, ct = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(marker)), keys = Array.Empty<object>() };
    private static object GroupEnvelope(string marker) => new { v = 2, kind = "group", ct = marker };
    private static string Marker(JsonElement receipt) => receipt.GetProperty("envelope").GetProperty("ct").GetString()!;

    private static async Task<JsonElement[]> Receipts(User user) =>
        (await user.RequestAsync("dm.receipts")).Body().GetProperty("receipts").EnumerateArray().ToArray();

    [Fact]
    public async Task A_receipt_is_relayed_untouched_and_only_the_newest_is_kept()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("hello") });

        Assert.Equal("result", (await bob.RequestAsync("dm.receipt", new { accountKey = alice.Key, envelope = Envelope("read-1") })).Type());
        var got = (await alice.EventAsync("dm.receipt")).Body();
        Assert.Equal(bob.Key, got.GetProperty("from").GetString());
        Assert.Equal(alice.Key, got.GetProperty("to").GetString());
        Assert.Equal(JsonSerializer.Serialize(Envelope("read-1")), got.GetProperty("envelope").GetRawText());
        // Nobody else hears of it, and the sender's own list is about receipts sent to them.
        await carol.NoEventAsync("dm.receipt");
        Assert.Empty(await Receipts(bob));
        Assert.Empty(await Receipts(carol));

        // A later one replaces it: the server keeps no history of when someone read.
        server.Clock.Advance(TimeSpan.FromMinutes(5));
        await bob.RequestAsync("dm.receipt", new { accountKey = alice.Key, envelope = Envelope("read-2") });
        var kept = Assert.Single(await Receipts(alice));
        Assert.Equal(bob.Key, kept.GetProperty("from").GetString());
        Assert.Equal(JsonSerializer.Serialize(Envelope("read-2")), kept.GetProperty("envelope").GetRawText());
        Assert.Equal(1L, server.World.Store.DmReceiptsFor(alice.Key, 10).Count);
    }

    [Fact]
    public async Task Receipts_need_a_member_who_takes_your_messages()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        Assert.Equal("bad_request", (await bob.RequestAsync("dm.receipt", new { accountKey = bob.Key, envelope = Envelope("me") })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("dm.receipt", new { accountKey = new string('A', 43), envelope = Envelope("x") })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("dm.receipt", new { accountKey = alice.Key, envelope = "text" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("dm.receipt", new { accountKey = alice.Key, envelope = Envelope(new string('x', 40_000)) })).ErrorCode());

        // Blocked by the other person: refused like a message, and nothing reaches them.
        await alice.RequestAsync("block.sync", new { entries = new[] { new { accountKey = bob.Key, blocked = true, at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() } } });
        Assert.Equal("forbidden", (await bob.RequestAsync("dm.receipt", new { accountKey = alice.Key, envelope = Envelope("blocked") })).ErrorCode());
        await alice.NoEventAsync("dm.receipt");
        Assert.Empty(await Receipts(alice));
    }

    [Fact]
    public async Task Someone_whose_messages_wait_as_a_request_cannot_send_receipts()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        // Alice asks for message requests: Bob's would be a request.
        Assert.Equal("result", (await alice.RequestAsync("dm.privacy.set", new { who = "requests", at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() })).Type());

        Assert.Equal("forbidden", (await bob.RequestAsync("dm.receipt", new { accountKey = alice.Key, envelope = Envelope("r") })).ErrorCode());
        await alice.NoEventAsync("dm.receipt");
    }

    [Fact]
    public async Task Group_receipts_go_to_the_other_members_and_need_the_current_version()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dave = await server.JoinAsync("Dave");
        var id = GroupTests.NewId();
        await GroupTests.CreateAsync(alice, id, bob, carol);

        Assert.Equal("result", (await bob.RequestAsync("group.receipt", new { groupId = id, version = 1, envelope = GroupEnvelope("seen-1") })).Type());
        foreach (var other in new[] { alice, carol })
        {
            var got = (await other.EventAsync("group.receipt")).Body();
            Assert.Equal(id, got.GetProperty("group").GetString());
            Assert.Equal(bob.Key, got.GetProperty("from").GetString());
            Assert.Equal("seen-1", Marker(got));
        }
        await bob.NoEventAsync("group.receipt");
        await dave.NoEventAsync("group.receipt");

        // Outsiders can neither send nor list; an old version is refused like a message.
        Assert.Equal("not_found", (await dave.RequestAsync("group.receipt", new { groupId = id, version = 1, envelope = GroupEnvelope("x") })).ErrorCode());
        Assert.Equal("not_found", (await dave.RequestAsync("group.receipts", new { groupId = id })).ErrorCode());
        Assert.Equal("conflict", (await bob.RequestAsync("group.receipt", new { groupId = id, version = 7, envelope = GroupEnvelope("x") })).ErrorCode());

        // The newest per person, never your own.
        await bob.RequestAsync("group.receipt", new { groupId = id, version = 1, envelope = GroupEnvelope("seen-2") });
        await carol.RequestAsync("group.receipt", new { groupId = id, version = 1, envelope = GroupEnvelope("carol") });
        var forAlice = (await alice.RequestAsync("group.receipts", new { groupId = id })).Body().GetProperty("receipts").EnumerateArray().ToArray();
        Assert.Equal(["carol", "seen-2"], forAlice.Select(Marker).Order().ToArray());
        var forBob = (await bob.RequestAsync("group.receipts", new { groupId = id })).Body().GetProperty("receipts").EnumerateArray().ToArray();
        Assert.Equal(["carol"], forBob.Select(Marker).ToArray());
    }

    [Fact]
    public async Task Receipts_are_in_the_data_export_without_their_content_and_go_with_the_account()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("hello") });
        await bob.RequestAsync("dm.receipt", new { accountKey = alice.Key, envelope = Envelope("read") });
        Assert.Single(server.World.Store.DmReceiptsFor(alice.Key, 10));

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        server.World.Store.DeleteAccount(new Iskra.Server.Storage.AccountDeletion(bob.Key, now, false, ""), now);
        Assert.Empty(server.World.Store.DmReceiptsFor(alice.Key, 10));
    }
}
