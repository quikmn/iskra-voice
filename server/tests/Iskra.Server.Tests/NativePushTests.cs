using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Push;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Phone apps: push subscriptions of kind "native" at the Iskra push relay (relay/), next to browser Web Push.</summary>
public class NativePushTests
{
    private static object Keys()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        return new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) };
    }

    private static string RelayEndpoint() => "https://push.iskra.foo/v1/push/" + Ed25519.ToB64u(RandomNumberGenerator.GetBytes(120));

    private static async Task<string> SubscribeNativeAsync(User user)
    {
        var endpoint = RelayEndpoint();
        Assert.Equal("result", (await user.RequestAsync("push.subscribe", new { kind = "native", endpoint, keys = Keys() })).Type());
        return endpoint;
    }

    [Fact]
    public async Task Phone_apps_subscribe_through_the_relay_and_status_says_native()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var endpoint = await SubscribeNativeAsync(alice);
        var status = (await alice.RequestAsync("push.status")).Body();
        Assert.Equal(endpoint, status.GetProperty("endpoint").GetString());
        Assert.Equal("native", status.GetProperty("kind").GetString());

        // A browser subscription on the same device replaces it, and says web.
        var web = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        await alice.RequestAsync("push.subscribe", new { endpoint = web, keys = Keys() });
        Assert.Equal("web", (await alice.RequestAsync("push.status")).Body().GetProperty("kind").GetString());
        await alice.RequestAsync("push.unsubscribe");
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("push.status")).Body().GetProperty("kind").ValueKind);
    }

    [Theory]
    [InlineData("https://push.iskra.foo/v1/push/short")]                                   // not a handle
    [InlineData("https://push.iskra.foo/v1/call/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]            // only the push path is registered
    [InlineData("https://push.iskra.foo/v1/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?x=1")]       // no query
    [InlineData("https://push.iskra.foo/v1/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/more")]
    [InlineData("http://push.iskra.foo/v1/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]             // not https
    [InlineData("https://push.iskra.foo:8443/v1/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("https://evil.iskra.foo/v1/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]           // only the relay itself
    [InlineData("https://push.iskra.foo.evil.com/v1/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("https://fcm.googleapis.com/fcm/send/abc")]                                 // a browser endpoint isn't native
    public async Task Native_endpoints_must_be_relay_handles(string endpoint)
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { kind = "native", endpoint, keys = Keys() })).ErrorCode());
    }

    [Fact]
    public async Task Relay_endpoints_are_not_web_endpoints_and_kinds_are_checked()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { endpoint = RelayEndpoint(), keys = Keys() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { kind = "apns", endpoint = RelayEndpoint(), keys = Keys() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { kind = 5, endpoint = RelayEndpoint(), keys = Keys() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { kind = "native", endpoint = RelayEndpoint(), keys = new { p256dh = "AAAA", auth = "AAAA" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { kind = "native", endpoint = "https://push.iskra.foo/v1/push/" + new string('A', 1100), keys = Keys() })).ErrorCode());
    }

    [Fact]
    public async Task Pushes_are_encrypted_web_push_to_the_relay_and_calls_use_the_call_path()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeNativeAsync(bob);

        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> game?" });
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("mention", push.GetProperty("kind").GetString());
        Assert.True(server.Push.SentTo(endpoint).Single().Urgent);

        server.Services.GetRequiredService<PushService>().IncomingCall(server.World.Store.GetMember(alice.Key)!, bob.Key);
        var callEndpoint = endpoint.Replace("/v1/push/", "/v1/call/");
        var ring = (await server.Push.WaitForAsync(callEndpoint)).Single();
        Assert.Equal("call", ring.GetProperty("kind").GetString());
        Assert.Equal("Alice", ring.GetProperty("from").GetString()); // the phone's call screen shows the caller
        Assert.Equal(30, server.Push.SentTo(callEndpoint).Single().TtlSeconds);
        Assert.Single(server.Push.SentTo(endpoint)); // the call didn't go to the ordinary path
    }

    [Fact]
    public async Task Do_not_disturb_mutes_and_blocks_apply_to_phones_too()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeNativeAsync(bob);

        // Muted server: no mention pushes.
        await bob.RequestAsync("notify.set", new { level = "none" });
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> muted?" });
        await server.Push.NoneAsync(endpoint);
        await bob.RequestAsync("notify.set", new { level = "default" });

        // Do not disturb: nothing at all, DMs included.
        await bob.RequestAsync("presence.set", new { status = "dnd", updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        await server.Push.NoneAsync(endpoint);
        await bob.RequestAsync("presence.set", new { status = "online", updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        var dm = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("New message from Alice", dm.GetProperty("title").GetString());

        // A focused app gets nothing.
        await bob.RequestAsync("push.focus", new { focused = true });
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> here?" });
        await server.Push.NoneAsync(endpoint, already: 1);
    }

    [Fact]
    public async Task A_relay_saying_gone_removes_the_phone()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeNativeAsync(bob);
        server.Push.Respond = _ => PushOutcome.Gone;
        server.Services.GetRequiredService<PushService>().IncomingCall(server.World.Store.GetMember(alice.Key)!, bob.Key);
        await server.Push.WaitForAsync(endpoint.Replace("/v1/push/", "/v1/call/"));
        for (var i = 0; i < 50 && server.World.Store.PushSubscriptions(bob.Key).Count > 0; i++) await Task.Delay(20);
        Assert.Empty(server.World.Store.PushSubscriptions(bob.Key));
    }
}
