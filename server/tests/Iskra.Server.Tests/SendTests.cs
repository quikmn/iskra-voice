using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Idempotent sends (a client nonce) and @role mentions.</summary>
public class SendTests
{
    private static string NewNonce() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));

    [Fact]
    public async Task A_retried_send_returns_the_stored_message_instead_of_posting_twice()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var nonce = NewNonce();

        var first = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hello", nonce })).Body();
        var evt = (await bob.EventAsync("chat.message")).Body();
        Assert.Equal(nonce, evt.GetProperty("nonce").GetString());
        Assert.Equal(nonce, first.GetProperty("nonce").GetString());

        // The connection dropped before the reply arrived: the app reconnects (a new session) and sends again.
        using var again = await server.ConnectAsync();
        await again.LoginAsync(alice.Identity, "Alice");
        var retry = (await again.RequestAsync("chat.send", new { channelId = server.General, text = "hello", nonce })).Body();
        Assert.Equal(first.GetProperty("message").GetProperty("id").GetInt64(), retry.GetProperty("message").GetProperty("id").GetInt64());
        await bob.NoEventAsync("chat.message");
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(1, history.GetArrayLength());

        // Nonces are per account; sends without one work as before.
        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "hello", nonce })).Type());
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "no nonce" })).Type());
        Assert.Equal(3, (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages").GetArrayLength());
    }

    [Fact]
    public async Task Nonces_are_validated_skip_slowmode_on_retry_and_follow_deletes()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "x", nonce = "short" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "x", nonce = "has spaces in it" })).ErrorCode());

        await admin.RequestAsync("channel.update", new { id = server.General, slowmode = 60 });
        var nonce = NewNonce();
        var sent = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "slow", nonce })).Body();
        // The retry is the same message, so slowmode doesn't count it again.
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "slow", nonce })).Type());
        Assert.Equal("rate_limited", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "slow", nonce = NewNonce() })).ErrorCode());

        await alice.RequestAsync("chat.delete", new { id = sent.GetProperty("message").GetProperty("id").GetInt64() });
        Assert.Equal("not_found", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "slow", nonce })).ErrorCode());
    }

    [Fact]
    public async Task Role_mentions_push_the_roles_members_when_the_author_may_mention_it()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        using var mod = await server.JoinAsync("Mod");
        var role = (await owner.RequestAsync("role.create", new { name = "Moderators" })).Body().GetProperty("role");
        var id = role.GetProperty("id").GetInt64();
        Assert.False(role.GetProperty("mentionable").GetBoolean());
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { id } });
        var endpoint = $"https://fcm.googleapis.com/fcm/send/mod-{Guid.NewGuid():N}";
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            var q = key.ExportParameters(false).Q;
            await mod.RequestAsync("push.subscribe", new
            {
                endpoint, keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
            });
        }
        await mod.RequestAsync("notify.set", new { level = "mentions" }); // only mentions: a small server would push every message by default

        // Not mentionable, and a plain member can't mention everyone: no push.
        await member.RequestAsync("chat.send", new { channelId = server.General, text = $"help <@&{id}>" });
        await server.Push.NoneAsync(endpoint);
        // The owner may mention any role.
        await owner.RequestAsync("chat.send", new { channelId = server.General, text = $"<@&{id}> look" });
        var push = (await server.Push.WaitForAsync(endpoint))[0];
        Assert.Contains("@Moderators look", push.GetProperty("body").GetString());

        // Once the role allows anyone to mention it, members can too.
        Assert.True((await owner.RequestAsync("role.update", new { id, mentionable = true })).Body().GetProperty("role").GetProperty("mentionable").GetBoolean());
        await Task.Delay(700); // past the push coalescing window
        var before = server.Push.SentTo(endpoint).Count;
        await member.RequestAsync("chat.send", new { channelId = server.General, text = $"<@&{id}> please" });
        await server.Push.WaitForAsync(endpoint, before + 1);
    }
}
