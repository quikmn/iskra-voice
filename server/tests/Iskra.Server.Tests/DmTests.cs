using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class DmTests
{
    private static object Envelope(string marker) => new { v = 1, ct = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(marker)), keys = Array.Empty<object>() };

    [Fact]
    public async Task Device_certificates_are_published_for_encryption()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var devices = (await alice.RequestAsync("dm.devices", new { accountKey = bob.Key })).Body().GetProperty("devices");
        var cert = devices[0].Deserialize<DeviceCert>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        Assert.Equal(bob.Key, cert.AccountKey);
        Assert.True(Identity.VerifyDeviceCert(cert)); // anyone can check the server didn't make it up
    }

    [Fact]
    public async Task Envelopes_are_relayed_and_stored_untouched()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var sent = await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("opaque") });
        var message = sent.Body().GetProperty("message");
        Assert.Equal(alice.Key, message.GetProperty("from").GetString());
        Assert.Equal(bob.Key, message.GetProperty("to").GetString());

        var received = (await bob.EventAsync("dm.message")).Body().GetProperty("message");
        Assert.Equal(message.GetProperty("id").GetInt64(), received.GetProperty("id").GetInt64());
        Assert.Equal(message.GetProperty("envelope").GetRawText(), received.GetProperty("envelope").GetRawText());

        var history = (await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages");
        Assert.Single(history.EnumerateArray());

        var conversations = (await bob.RequestAsync("dm.conversations")).Body().GetProperty("conversations");
        Assert.Equal(alice.Key, conversations[0].GetProperty("accountKey").GetString());
    }

    [Fact]
    public async Task A_send_retried_with_its_nonce_is_stored_once()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var first = (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("once"), nonce = "retry-me-1" })).Body();
        await bob.EventAsync("dm.message");
        var again = (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("once"), nonce = "retry-me-1" })).Body();
        Assert.Equal(first.GetProperty("message").GetProperty("id").GetInt64(), again.GetProperty("message").GetProperty("id").GetInt64());
        await bob.NoEventAsync("dm.message");
        Assert.Single((await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages").EnumerateArray());
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("x"), nonce = "short" })).ErrorCode());
    }

    [Fact]
    public async Task Third_parties_cannot_read_or_see_others_DMs()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var eve = await server.JoinAsync("Eve", "admin");

        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("private") });
        await eve.NoEventAsync("dm.message");

        // History is always "between me and X": Eve asking about Alice only gets Eve↔Alice, which is empty.
        Assert.Empty((await eve.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages").EnumerateArray());
        Assert.Empty((await eve.RequestAsync("dm.conversations")).Body().GetProperty("conversations").EnumerateArray());
    }

    [Fact]
    public async Task Only_members_can_be_messaged_and_envelopes_are_bounded()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");

        Assert.Equal("not_found", (await alice.RequestAsync("dm.send", new { accountKey = "nobody", envelope = Envelope("x") })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = "plaintext!" })).ErrorCode());
        var huge = new { v = 1, ct = new string('A', 40_000) };
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = huge })).ErrorCode());
    }

    [Fact]
    public async Task Your_other_devices_get_a_copy()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        // Alice's second device: same account key, new device key.
        using var second = new TestIdentity(alice.Identity.Account);
        using var client = await server.ConnectAsync();
        Assert.Equal("welcome", (await client.LoginAsync(second, "Alice")).Type());

        Assert.Equal(2, (await bob.RequestAsync("dm.devices", new { accountKey = alice.Key })).Body().GetProperty("devices").GetArrayLength());

        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("hi") });
        await client.EventAsync("dm.message");
    }
}
