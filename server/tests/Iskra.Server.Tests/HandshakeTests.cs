using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>
/// The auth handshake, driven over a real WebSocket. Several of these are v1 audit findings
/// (impersonation, oversized frames, crashing on bad input) written as tests that must stay fixed.
/// </summary>
public class HandshakeTests
{
    [Fact]
    public async Task Hello_is_sent_on_connect()
    {
        using var server = new IskraServer();
        using var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        Assert.Equal("hello", hello.GetProperty("type").GetString());
        Assert.Equal(1, hello.GetProperty("body").GetProperty("v").GetInt32());
        Assert.Equal(43, hello.GetProperty("body").GetProperty("nonce").GetString()!.Length); // 32 bytes, b64u
    }

    [Fact]
    public async Task Joining_with_an_invite_gives_its_role()
    {
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var client = await server.ConnectAsync();

        var welcome = await client.LoginAsync(alice, "Alice", server.Invite("owner"));

        Assert.Equal("welcome", welcome.GetProperty("type").GetString());
        var you = welcome.GetProperty("body").GetProperty("you");
        Assert.Equal(alice.AccountKey, you.GetProperty("accountKey").GetString());
        Assert.Equal("Alice", you.GetProperty("name").GetString());
        Assert.Equal("owner", you.GetProperty("role").GetString());
    }

    [Fact]
    public async Task Members_keep_their_role_and_can_rename_on_reconnect()
    {
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var bob = new TestIdentity();

        using (var c = await server.ConnectAsync()) await c.LoginAsync(alice, "Alice", server.Invite("owner"));
        using (var c = await server.ConnectAsync())
            Assert.Equal("member", (await c.LoginAsync(bob, "Bob", server.Invite())).GetProperty("body").GetProperty("you").GetProperty("role").GetString());

        using var again = await server.ConnectAsync();
        var you = (await again.LoginAsync(alice, "Alice 2")).GetProperty("body").GetProperty("you");
        Assert.Equal("owner", you.GetProperty("role").GetString());
        Assert.Equal("Alice 2", you.GetProperty("name").GetString());
    }

    [Fact]
    public async Task Claiming_someone_elses_account_fails()
    {
        // v1: anyone could connect as any alias, including an admin. Here the account key must sign the device cert.
        using var server = new IskraServer();
        using var victim = new TestIdentity();
        using var attacker = new TestIdentity();
        using var client = await server.ConnectAsync();

        var hello = await client.ReceiveAsync();
        var forgedCert = attacker.Cert();
        forgedCert["accountKey"] = victim.AccountKey;
        await client.SendAsync(attacker.AuthFrame(hello, cert: forgedCert, invite: server.Invite()));

        await AssertAuthFailed(client);
    }

    [Fact]
    public async Task Auth_signed_by_the_wrong_device_fails()
    {
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var mallory = new TestIdentity();
        using var client = await server.ConnectAsync();

        var hello = await client.ReceiveAsync();
        await client.SendAsync(alice.AuthFrame(hello, sig: (key, nonce) => alice.AuthSig(key, nonce, mallory.Device), invite: server.Invite()));

        await AssertAuthFailed(client);
    }

    [Fact]
    public async Task Auth_signature_from_another_server_cannot_be_replayed()
    {
        using var serverA = new IskraServer();
        using var serverB = new IskraServer();
        using var alice = new TestIdentity();

        using var a = await serverA.ConnectAsync();
        using var b = await serverB.ConnectAsync();
        var helloA = await a.ReceiveAsync();
        await b.ReceiveAsync();

        // Replay the auth frame meant for server A against server B.
        await b.SendAsync(alice.AuthFrame(helloA, invite: serverB.Invite()));

        await AssertAuthFailed(b);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("abcdefghijklmnopqrstuvwxyz0123456")] // 33 characters
    [InlineData("evil‮gnp.exe")]               // right-to-left override
    [InlineData("two\nlines")]
    [InlineData("zero​width")]
    public async Task Invalid_display_names_are_rejected(string name)
    {
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var client = await server.ConnectAsync();

        var hello = await client.ReceiveAsync();
        await client.SendAsync(alice.AuthFrame(hello, name, invite: server.Invite()));

        await AssertAuthFailed(client);
    }

    [Fact]
    public async Task Emoji_names_with_joiners_are_allowed()
    {
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var client = await server.ConnectAsync();
        var welcome = await client.LoginAsync(alice, "fam 👨‍👩‍👧", server.Invite());
        Assert.Equal("welcome", welcome.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Garbage_instead_of_auth_fails_cleanly()
    {
        using var server = new IskraServer();
        using var client = await server.ConnectAsync();
        await client.ReceiveAsync();
        await client.SendRawAsync("{ this is not json");
        await AssertAuthFailed(client);
    }

    [Fact]
    public async Task Oversized_frame_before_auth_is_closed()
    {
        // v1: unbounded frames before auth let anyone exhaust server memory.
        using var server = new IskraServer();
        using var client = await server.ConnectAsync();
        await client.ReceiveAsync();
        await client.SendRawAsync(new string('x', 8 * 1024));
        Assert.Equal(CloseCodes.TooLarge, await client.ReceiveCloseAsync());
    }

    [Fact]
    public async Task Silent_clients_are_dropped_after_the_auth_timeout()
    {
        using var server = new IskraServer { AuthTimeoutMs = 300 };
        using var client = await server.ConnectAsync();
        await client.ReceiveAsync();

        var error = await client.ReceiveAsync();
        Assert.Equal("auth_failed", error.GetProperty("body").GetProperty("code").GetString());
        Assert.Equal(CloseCodes.AuthFailed, await client.ReceiveCloseAsync());
    }

    private static async Task AssertAuthFailed(TestClient client)
    {
        var error = await client.ReceiveAsync();
        Assert.Equal("error", error.GetProperty("type").GetString());
        Assert.Equal("auth_failed", error.GetProperty("body").GetProperty("code").GetString());
        Assert.Equal(CloseCodes.AuthFailed, await client.ReceiveCloseAsync());
    }
}

public class SessionTests
{
    [Fact]
    public async Task Unknown_types_get_an_error_and_the_session_survives()
    {
        // v1: a malformed or unexpected message ended the whole session.
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var client = await server.ConnectAsync();
        await client.LoginAsync(alice, invite: server.Invite());

        await client.SendAsync(new JsonObject { ["type"] = "does.not.exist", ["id"] = "r1" });
        var error = await client.ReceiveAsync();
        Assert.Equal("unknown_type", error.GetProperty("body").GetProperty("code").GetString());
        Assert.Equal("r1", error.GetProperty("id").GetString());

        await client.SendAsync(new JsonObject { ["type"] = "ping", ["id"] = "r2" });
        var result = await client.ReceiveAsync();
        Assert.Equal("result", result.GetProperty("type").GetString());
        Assert.Equal("r2", result.GetProperty("id").GetString());
    }

    [Fact]
    public async Task Malformed_frames_get_errors_and_a_flood_closes_the_session()
    {
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var client = await server.ConnectAsync();
        await client.LoginAsync(alice, invite: server.Invite());

        for (var i = 0; i < 10; i++)
        {
            await client.SendRawAsync("[1,2,3]");
            Assert.Equal("bad_request", (await client.ReceiveAsync()).GetProperty("body").GetProperty("code").GetString());
        }
        Assert.Equal(CloseCodes.BadRequests, await client.ReceiveCloseAsync());
    }

    [Fact]
    public async Task Oversized_frame_after_auth_is_closed()
    {
        using var server = new IskraServer();
        using var alice = new TestIdentity();
        using var client = await server.ConnectAsync();
        await client.LoginAsync(alice, invite: server.Invite());

        await client.SendRawAsync(new string('x', 65 * 1024));
        Assert.Equal(CloseCodes.TooLarge, await client.ReceiveCloseAsync());
    }
}
