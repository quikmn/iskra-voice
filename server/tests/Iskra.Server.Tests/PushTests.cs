using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Push;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class PushTests
{
    /// <summary>A browser-shaped subscription: a P-256 public key and a 16-byte auth secret.</summary>
    private static object Subscription(string endpoint)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        return new
        {
            endpoint,
            keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
        };
    }

    private static string Endpoint(string who) => $"https://fcm.googleapis.com/fcm/send/{who}-{Guid.NewGuid():N}";

    private static async Task<string> SubscribeAsync(User user)
    {
        var endpoint = Endpoint(user.Welcome.Body().GetProperty("you").GetProperty("name").GetString()!);
        Assert.Equal("result", (await user.RequestAsync("push.subscribe", Subscription(endpoint))).Type());
        // These tests are about mentions and replies: a small server would otherwise push every message by default.
        Assert.Equal("result", (await user.RequestAsync("notify.set", new { level = "mentions" })).Type());
        return endpoint;
    }

    private static Task<JsonElement> Say(User user, long channelId, string text, long? replyTo = null) =>
        user.RequestAsync("chat.send", new { channelId, text, replyTo });

    [Fact]
    public async Task Status_gives_the_vapid_key_which_survives_restarts()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var status = (await alice.RequestAsync("push.status")).Body();
        Assert.True(Ed25519.TryFromB64u(status.GetProperty("publicKey").GetString(), out var key));
        Assert.Equal(65, key.Length);
        Assert.Equal(JsonValueKind.Null, status.GetProperty("endpoint").ValueKind);

        Assert.True(File.Exists(Path.Combine(server.WorldPath, VapidKeys.FileName)));
        Assert.Equal(status.GetProperty("publicKey").GetString(), VapidKeys.LoadOrCreate(server.WorldPath).PublicKey);

        var endpoint = await SubscribeAsync(alice);
        Assert.Equal(endpoint, (await alice.RequestAsync("push.status")).Body().GetProperty("endpoint").GetString());
        await alice.RequestAsync("push.unsubscribe");
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("push.status")).Body().GetProperty("endpoint").ValueKind);
    }

    [Theory]
    [InlineData("http://fcm.googleapis.com/fcm/send/x")]          // not https
    [InlineData("https://evil.example.com/fcm.googleapis.com")]   // not a push service
    [InlineData("https://fcm.googleapis.com.evil.com/x")]
    [InlineData("https://127.0.0.1/x")]
    [InlineData("https://169.254.169.254/latest/meta-data")]
    [InlineData("https://[::1]/x")]
    [InlineData("https://fcm.googleapis.com:8443/x")]
    [InlineData("https://user:pw@fcm.googleapis.com/x")]
    [InlineData("file:///etc/passwd")]
    [InlineData("not a url")]
    public async Task Endpoints_must_be_https_urls_of_known_push_services(string endpoint)
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", Subscription(endpoint))).ErrorCode());
    }

    [Theory]
    [InlineData("https://fcm.googleapis.com/fcm/send/abc")]
    [InlineData("https://updates.push.services.mozilla.com/wpush/v2/abc")]
    [InlineData("https://wns2-db5p.notify.windows.com/w/?token=abc")]
    [InlineData("https://web.push.apple.com/abc")]
    public async Task Browser_push_services_are_accepted(string endpoint)
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("result", (await alice.RequestAsync("push.subscribe", Subscription(endpoint))).Type());
    }

    /// <summary>Phone apps no longer get native push (older ones subscribed with kind "native" through a push relay).</summary>
    [Fact]
    public async Task Only_web_subscriptions_are_accepted()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var good = JsonSerializer.SerializeToElement(Subscription(Endpoint("a")));
        var endpoint = good.GetProperty("endpoint").GetString();
        var keys = good.GetProperty("keys");

        var native = await alice.RequestAsync("push.subscribe", new { kind = "native", endpoint, keys });
        Assert.Equal("bad_request", native.ErrorCode());
        Assert.Contains("while the app is open", native.Body().GetProperty("message").GetString());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { kind = "apns", endpoint, keys })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { kind = 5, endpoint, keys })).ErrorCode());
        // The old relay's endpoints aren't a push service either.
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe",
            new { kind = "native", endpoint = "https://push.iskra.foo/v1/push/" + new string('A', 40), keys })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe",
            new { endpoint = "https://push.iskra.foo/v1/push/" + new string('A', 40), keys })).ErrorCode());
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("push.status")).Body().GetProperty("endpoint").ValueKind);

        Assert.Equal("result", (await alice.RequestAsync("push.subscribe", new { kind = "web", endpoint, keys })).Type());
        Assert.Equal(endpoint, (await alice.RequestAsync("push.status")).Body().GetProperty("endpoint").GetString());
    }

    [Fact]
    public void Stored_relay_subscriptions_are_dropped_on_upgrade()
    {
        var path = Path.Combine(Path.GetTempPath(), $"iskra-push-{Guid.NewGuid():N}.db");
        try
        {
            using (var store = Store.Open(path))
            {
                store.SavePushSubscription("acct", "phone", "https://push.iskra.foo/v1/push/" + new string('A', 40), "p", "a", 1, 10);
                store.SavePushSubscription("acct", "laptop", "https://fcm.googleapis.com/fcm/send/abc", "p", "a", 1, 10);
            }
            // A database from before push-2.
            using (var db = new SqliteConnection($"Data Source={path};Pooling=False"))
            {
                db.Open();
                using var cmd = db.CreateCommand();
                cmd.CommandText = "DELETE FROM migrations WHERE name = 'push-2';";
                cmd.ExecuteNonQuery();
            }
            using (var store = Store.Open(path))
            {
                Assert.Null(store.PushSubscriptionFor("phone"));
                Assert.NotNull(store.PushSubscriptionFor("laptop"));
            }
        }
        finally
        {
            foreach (var f in new[] { path, path + "-wal", path + "-shm" }) File.Delete(f);
        }
    }

    [Fact]
    public async Task Keys_and_sizes_are_checked()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var endpoint = Endpoint("a");
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { endpoint, keys = new { p256dh = "AAAA", auth = "AAAA" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", new { endpoint })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.subscribe", Subscription("https://fcm.googleapis.com/" + new string('a', 1100)))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("push.focus", new { focused = "yes" })).ErrorCode());
    }

    [Fact]
    public async Task Mentions_push_only_to_the_mentioned_and_never_to_the_author()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var aliceEndpoint = await SubscribeAsync(alice);
        var bobEndpoint = await SubscribeAsync(bob);
        var carolEndpoint = await SubscribeAsync(carol);

        await Say(alice, server.General, $"hey <@{bob.Key}> and <@{alice.Key}>, game\nat 8?");
        var push = (await server.Push.WaitForAsync(bobEndpoint)).Single();
        Assert.Equal("mention", push.GetProperty("kind").GetString());
        Assert.Equal("Alice in #general", push.GetProperty("title").GetString());
        Assert.Equal("mention", push.GetProperty("text").GetProperty("title").GetString());
        Assert.Equal(JsonValueKind.Null, push.GetProperty("text").GetProperty("body").ValueKind); // the excerpt shows as is
        Assert.Equal("general", push.GetProperty("text").GetProperty("args").GetProperty("channel").GetString());
        Assert.Equal("hey @Bob and @Alice, game at 8?", push.GetProperty("body").GetString());
        Assert.Equal(server.General, push.GetProperty("channelId").GetInt64());
        Assert.Equal(Ed25519.ToB64u(server.World.ServerPublicKey), push.GetProperty("server").GetString());
        await server.Push.NoneAsync(carolEndpoint);
        await server.Push.NoneAsync(aliceEndpoint);
    }

    [Fact]
    public async Task Replies_and_everyone_push_too()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var aliceEndpoint = await SubscribeAsync(alice);
        var bobEndpoint = await SubscribeAsync(bob);

        var original = (await Say(alice, server.General, "who's up for a game?")).Body().GetProperty("message").GetProperty("id").GetInt64();
        await Say(bob, server.General, "me!", replyTo: original);
        var reply = (await server.Push.WaitForAsync(aliceEndpoint)).Single();
        Assert.Equal("reply", reply.GetProperty("kind").GetString());
        Assert.Equal("Bob replied in #general", reply.GetProperty("title").GetString());

        // @everyone pings only from trusted and above.
        var other = server.World.Store.CreateChannel("news", "text", "member", "member", 0).Id;
        await Say(alice, other, "@everyone patch notes are out");
        await server.Push.NoneAsync(bobEndpoint);
        server.World.Store.SetMemberRole(alice.Key, "trusted");
        await Say(alice, other, "@everyone patch notes are out, for real");
        Assert.Equal("mention", (await server.Push.WaitForAsync(bobEndpoint)).Single().GetProperty("kind").GetString());
        await server.Push.NoneAsync(aliceEndpoint, already: 1);
    }

    [Fact]
    public async Task Here_pings_only_members_who_are_online()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var carol = await server.JoinAsync("Carol");
        var bobEndpoint = await SubscribeAsync(bob);
        var carolEndpoint = await SubscribeAsync(carol);
        carol.Dispose();
        await Task.Delay(300); // Carol goes offline

        await Say(admin, server.General, "@here standup in 5");
        Assert.Equal("mention", (await server.Push.WaitForAsync(bobEndpoint)).Single().GetProperty("kind").GetString());
        await server.Push.NoneAsync(carolEndpoint);
    }

    [Fact]
    public async Task People_who_cannot_read_the_channel_are_not_pushed()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var guest = await server.JoinAsync("Guest", "guest");
        var guestEndpoint = await SubscribeAsync(guest);
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;

        await Say(admin, staff, $"<@{guest.Key}> shh");
        await server.Push.NoneAsync(guestEndpoint);
    }

    [Fact]
    public async Task A_focused_device_gets_no_push_but_the_others_do()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var phone = await SubscribeAsync(bob);

        // Bob's second device (same account) is open and focused.
        using var laptopId = new TestIdentity(bob.Identity.Account);
        using var laptop = await server.ConnectAsync();
        await laptop.LoginAsync(laptopId, "Bob");
        var laptopEndpoint = Endpoint("laptop");
        await laptop.RequestAsync("push.subscribe", Subscription(laptopEndpoint));
        await laptop.RequestAsync("push.focus", new { focused = true });

        await Say(alice, server.General, $"<@{bob.Key}> one");
        await server.Push.WaitForAsync(phone);
        await server.Push.NoneAsync(laptopEndpoint);

        // Once the laptop loses focus it gets pushes again.
        await laptop.RequestAsync("push.focus", new { focused = false });
        var news = server.World.Store.CreateChannel("news", "text", "member", "member", 0).Id;
        await Say(alice, news, $"<@{bob.Key}> two");
        await server.Push.WaitForAsync(laptopEndpoint);
    }

    [Fact]
    public async Task Focus_ends_with_the_connection()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("push.focus", new { focused = true });
        await Say(alice, server.General, $"<@{bob.Key}> are you there?");
        await server.Push.NoneAsync(endpoint);

        bob.Dispose();
        var hub = server.Services.GetRequiredService<Iskra.Server.Sessions.Hub>();
        for (var i = 0; i < 100 && hub.IsOnline(bob.Key); i++) await Task.Delay(20);
        Assert.False(hub.IsOnline(bob.Key));
        var news = server.World.Store.CreateChannel("news", "text", "member", "member", 0).Id;
        await Say(alice, news, $"<@{bob.Key}> now?");
        await server.Push.WaitForAsync(endpoint);
    }

    [Fact]
    public async Task DM_pushes_never_carry_the_message()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var aliceEndpoint = await SubscribeAsync(alice);
        var bobEndpoint = await SubscribeAsync(bob);

        var envelope = new { v = 1, ct = "U0VDUkVULVRFWFQ", marker = "SECRET-TEXT", keys = Array.Empty<object>() };
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope });
        var delivery = (await server.Push.WaitForAsync(bobEndpoint)).Single();
        Assert.Equal("dm", delivery.GetProperty("kind").GetString());
        Assert.Equal("New message from Alice", delivery.GetProperty("title").GetString());
        // The texts' names, so the app can show them in its language.
        var text = delivery.GetProperty("text");
        Assert.Equal("dm", text.GetProperty("title").GetString());
        Assert.Equal("openToRead", text.GetProperty("body").GetString());
        Assert.Equal("Alice", text.GetProperty("args").GetProperty("name").GetString());
        Assert.Equal(alice.Key, delivery.GetProperty("peer").GetString());
        var raw = server.Push.SentTo(bobEndpoint).Single().Payload;
        Assert.DoesNotContain("SECRET", raw);
        Assert.DoesNotContain("U0VDUkVU", raw);
        await server.Push.NoneAsync(aliceEndpoint); // not to the sender

        // Messages to yourself (your other devices) don't push.
        await alice.RequestAsync("dm.send", new { accountKey = alice.Key, envelope });
        await server.Push.NoneAsync(aliceEndpoint);
    }

    [Fact]
    public async Task Silent_dms_are_delivered_but_not_pushed()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);

        // A quiet friend action (cancel, ignore, remove): stored and relayed like any DM, no push.
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 2 }, silent = true });
        await bob.EventAsync("dm.message");
        await server.Push.NoneAsync(endpoint);
        var history = (await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body();
        Assert.Single(history.GetProperty("messages").EnumerateArray());

        // A wrong type is refused before anything is stored; silent: false is an ordinary send.
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 2 }, silent = "yes" })).ErrorCode());
        Assert.Single((await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages").EnumerateArray());
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 2 }, silent = false });
        Assert.Single(await server.Push.WaitForAsync(endpoint));
    }

    [Fact]
    public async Task Bursts_are_merged_into_one_follow_up_push()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);

        for (var i = 1; i <= 4; i++) await Say(alice, server.General, $"<@{bob.Key}> ping {i}");
        var first = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("@Bob ping 1", first.GetProperty("body").GetString());

        var pushes = await server.Push.WaitForAsync(endpoint, 2);
        Assert.Equal(3, pushes[1].GetProperty("count").GetInt32());
        Assert.Equal("@Bob ping 4 (+2 more)", pushes[1].GetProperty("body").GetString());
        Assert.Equal(server.Push.SentTo(endpoint)[0].Topic, server.Push.SentTo(endpoint)[1].Topic);
        await server.Push.NoneAsync(endpoint, already: 2, waitMs: 900);
    }

    [Fact]
    public async Task Gone_subscriptions_are_removed()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        server.Push.Respond = _ => PushOutcome.Gone;

        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        await server.Push.WaitForAsync(endpoint);
        for (var i = 0; i < 50 && server.World.Store.PushSubscriptions(bob.Key).Count > 0; i++) await Task.Delay(20);
        Assert.Empty(server.World.Store.PushSubscriptions(bob.Key));
    }

    [Fact]
    public async Task Each_account_keeps_a_bounded_number_of_subscriptions()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        for (var i = 0; i < PushService.MaxSubscriptionsPerAccount + 5; i++)
            store.SavePushSubscription("acc", $"dev{i}", Endpoint($"d{i}"), "k", "a", i, PushService.MaxSubscriptionsPerAccount);
        var kept = store.PushSubscriptions("acc");
        Assert.Equal(PushService.MaxSubscriptionsPerAccount, kept.Count);
        Assert.DoesNotContain(kept, s => s.DeviceKey == "dev0"); // the oldest went first

        // An endpoint belongs to one device: re-using it moves it.
        var shared = Endpoint("shared");
        store.SavePushSubscription("acc", "dev14", shared, "k", "a", 100, 10);
        store.SavePushSubscription("other", "devX", shared, "k", "a", 101, 10);
        Assert.DoesNotContain(store.PushSubscriptions("acc"), s => s.Endpoint == shared);
        Assert.Single(store.PushSubscriptions("other"));
    }

    [Fact]
    public async Task Kicked_members_are_not_pushed()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "admin");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await owner.RequestAsync("member.kick", new { accountKey = bob.Key });
        await Say(owner, server.General, $"<@{bob.Key}> bye");
        await owner.RequestAsync("dm.send", new { accountKey = owner.Key, envelope = new { v = 1 } });
        await server.Push.NoneAsync(endpoint);
    }

    [Fact]
    public async Task Calls_hook_rings_right_away_without_merging()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        var push = server.Services.GetRequiredService<PushService>();
        var caller = server.World.Store.GetMember(alice.Key)!;
        push.IncomingCall(caller, bob.Key);
        var calls = await server.Push.WaitForAsync(endpoint, 1);
        Assert.All(calls, c => Assert.Equal("Alice is calling", c.GetProperty("title").GetString()));
        Assert.Equal(30, server.Push.SentTo(endpoint)[0].TtlSeconds);
        // Calling again right away doesn't ring the phone again; another caller does.
        push.IncomingCall(caller, bob.Key);
        await server.Push.NoneAsync(endpoint, already: 1);
        using var carol = await server.JoinAsync("Carol");
        push.IncomingCall(server.World.Store.GetMember(carol.Key)!, bob.Key);
        Assert.Equal("Carol is calling", (await server.Push.WaitForAsync(endpoint, 2))[1].GetProperty("title").GetString());
    }

    [Fact]
    public async Task Starting_a_call_pushes_to_the_callee()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        var callId = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));
        Assert.Equal("result", (await alice.RequestAsync("call.start",
            new { accountKey = bob.Key, callId, video = false, envelope = new { v = 1, ct = "opaque" } })).Type());
        var pushes = await server.Push.WaitForAsync(endpoint, 1);
        Assert.Equal("Alice is calling", pushes[0].GetProperty("title").GetString());
    }

    /// <summary>The real sender, against a local stand-in for a push service: encrypted body, VAPID auth, 410 handling.</summary>
    [Fact]
    public async Task The_web_push_sender_encrypts_signs_and_reports_gone()
    {
        using var server = new IskraServer();
        var keys = server.Services.GetRequiredService<VapidKeys>();
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Push:AllowLoopbackForTests"] = "true" }).Build();
        using var sender = new WebPushSender(server.World, keys, config);

        var port = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        port.Start();
        var url = $"http://127.0.0.1:{((IPEndPoint)port.LocalEndpoint).Port}/";
        port.Stop();
        using var listener = new HttpListener();
        listener.Prefixes.Add(url);
        listener.Start();

        var status = 201;
        HttpListenerRequest? seen = null;
        byte[] body = [];
        _ = Task.Run(async () =>
        {
            while (listener.IsListening)
            {
                try
                {
                    var c = await listener.GetContextAsync();
                    seen = c.Request;
                    using var ms = new MemoryStream();
                    await c.Request.InputStream.CopyToAsync(ms);
                    body = ms.ToArray();
                    c.Response.StatusCode = status;
                    c.Response.Close();
                }
                catch (Exception) { }
            }
        });

        var sub = (JsonElement)JsonSerializer.SerializeToElement(Subscription(url + "push/abc"));
        var keysJson = sub.GetProperty("keys");
        var delivery = new PushDelivery(url + "push/abc", keysJson.GetProperty("p256dh").GetString()!, keysJson.GetProperty("auth").GetString()!,
            """{"title":"plaintext-marker"}""", "topic123", Urgent: true, TtlSeconds: 60);

        Assert.Equal(PushOutcome.Delivered, await sender.SendAsync(delivery, CancellationToken.None));
        Assert.Equal("aes128gcm", seen!.Headers["Content-Encoding"]);
        Assert.StartsWith("vapid t=", seen.Headers["Authorization"]);
        Assert.Contains($"k={keys.PublicKey}", seen.Headers["Authorization"]);
        Assert.Equal("60", seen.Headers["TTL"]);
        Assert.Equal("high", seen.Headers["Urgency"]);
        Assert.Equal("topic123", seen.Headers["Topic"]);
        Assert.DoesNotContain("plaintext-marker", System.Text.Encoding.UTF8.GetString(body));

        status = 410;
        Assert.Equal(PushOutcome.Gone, await sender.SendAsync(delivery, CancellationToken.None));
        listener.Stop();
    }

    [Fact]
    public async Task The_web_push_sender_never_connects_to_private_addresses()
    {
        using var server = new IskraServer();
        var config = new ConfigurationBuilder().Build();
        using var sender = new WebPushSender(server.World, server.Services.GetRequiredService<VapidKeys>(), config);
        var sub = JsonSerializer.SerializeToElement(Subscription("x")).GetProperty("keys");
        var delivery = new PushDelivery("http://127.0.0.1:9/push", sub.GetProperty("p256dh").GetString()!, sub.GetProperty("auth").GetString()!,
            "{}", "t", false, 60);
        await Assert.ThrowsAnyAsync<HttpRequestException>(() => sender.SendAsync(delivery, CancellationToken.None));
    }
}
