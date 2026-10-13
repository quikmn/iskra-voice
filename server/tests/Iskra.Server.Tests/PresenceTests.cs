using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class PresenceTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static object Presence(string status, object? custom = null, long? updatedAt = null) =>
        new { status, custom, updatedAt = updatedAt ?? Now };

    private static JsonElement Member(JsonElement frame) => frame.Body().GetProperty("member");

    /// <summary>The next member.updated about <paramref name="who"/>.</summary>
    /// <summary>The next member.updated about <paramref name="accountKey"/> showing <paramref name="status"/> (older updates are skipped).</summary>
    private static async Task<JsonElement> UpdateAbout(User watcher, string accountKey, string status)
    {
        while (true)
        {
            var member = Member(await watcher.EventAsync("member.updated"));
            if (member.GetProperty("accountKey").GetString() == accountKey && member.GetProperty("status").GetString() == status) return member;
        }
    }

    private static Task<JsonElement> UpdateAbout(User watcher, User who, string status) => UpdateAbout(watcher, who.Key, status);

    [Fact]
    public async Task Members_carry_status_and_go_dnd_and_back()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var you = bob.Welcome.Body().GetProperty("you");
        Assert.Equal("online", you.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, you.GetProperty("customStatus").ValueKind);
        Assert.Equal(JsonValueKind.Null, bob.Welcome.Body().GetProperty("presence").ValueKind);

        var result = await bob.RequestAsync("presence.set", Presence("dnd", new { emoji = "🎮", text = "  Raiding  " }));
        Assert.Equal("dnd", result.Body().GetProperty("presence").GetProperty("status").GetString());
        var seen = await UpdateAbout(alice, bob, "dnd");
        Assert.True(seen.GetProperty("online").GetBoolean());
        Assert.Equal("🎮", seen.GetProperty("customStatus").GetProperty("emoji").GetString());
        Assert.Equal("Raiding", seen.GetProperty("customStatus").GetProperty("text").GetString());

        await bob.RequestAsync("presence.set", Presence("online"));
        seen = await UpdateAbout(alice, bob, "online");
        Assert.Equal(JsonValueKind.Null, seen.GetProperty("customStatus").ValueKind);
    }

    [Fact]
    public async Task Invisible_looks_offline_to_everyone_and_hides_the_custom_status()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await bob.RequestAsync("presence.set", Presence("invisible", new { text = "secret" }));
        var seen = await UpdateAbout(alice, bob, "offline");
        Assert.False(seen.GetProperty("online").GetBoolean());
        Assert.Equal(JsonValueKind.Null, seen.GetProperty("customStatus").ValueKind);

        // Bob can still use the app.
        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "boo" })).Type());

        // A new joiner sees Bob offline in the welcome too.
        using var carol = await server.JoinAsync("Carol");
        var members = carol.Welcome.Body().GetProperty("members").EnumerateArray();
        Assert.Equal("offline", members.Single(m => m.GetProperty("accountKey").GetString() == bob.Key).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Presence_sent_with_auth_applies_before_anyone_sees_you_come_online()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var bobIdentity = new TestIdentity();
        using (var first = await server.ConnectAsync())
        {
            await first.LoginAsync(bobIdentity, "Bob", server.Invite());
            await UpdateAbout(alice, bobIdentity.AccountKey, "online");
        }
        await UpdateAbout(alice, bobIdentity.AccountKey, "offline");

        using var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = bobIdentity.AuthFrame(hello, "Bob");
        frame["body"]!["presence"] = JsonSerializer.SerializeToNode(Presence("invisible"));
        await client.SendAsync(frame);
        var welcome = await client.ReceiveAsync();
        Assert.Equal("invisible", welcome.Body().GetProperty("presence").GetProperty("status").GetString());

        var others = new List<JsonElement>();
        using var cts = new CancellationTokenSource(500);
        try
        {
            while (true)
            {
                var update = Member(await alice.EventAsync("member.updated").WaitAsync(cts.Token));
                if (update.GetProperty("accountKey").GetString() == bobIdentity.AccountKey) others.Add(update);
            }
        }
        catch (OperationCanceledException) { }
        catch (TimeoutException) { }
        Assert.All(others, m => Assert.False(m.GetProperty("online").GetBoolean()));
    }

    [Fact]
    public async Task Idle_is_automatic_only_when_every_session_is_idle()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var phone = await server.ConnectAsync();
        await phone.LoginAsync(new TestIdentity(bob.Identity.Account), "Bob");

        await bob.RequestAsync("presence.idle", new { idle = true });
        Assert.Equal("online", (await UpdateAboutOrCurrent(server, alice, bob)).GetProperty("status").GetString());
        await phone.RequestAsync("presence.idle", new { idle = true });
        await UpdateAbout(alice, bob, "idle");
        await bob.RequestAsync("presence.idle", new { idle = false });
        await UpdateAbout(alice, bob, "online");

        // Leaving the only active session leaves an idle account.
        await bob.RequestAsync("presence.idle", new { idle = true });
        await UpdateAbout(alice, bob, "idle");
        await phone.RequestAsync("presence.idle", new { idle = false });
        await UpdateAbout(alice, bob, "online");
        phone.Dispose();
        await UpdateAbout(alice, bob, "idle");

        Assert.Equal("bad_request", (await bob.RequestAsync("presence.idle", new { idle = "yes" })).ErrorCode());
    }

    /// <summary>One idle session out of two changes nothing, so there may be no update: read the member list instead.</summary>
    private static async Task<JsonElement> UpdateAboutOrCurrent(IskraServer server, User watcher, User who)
    {
        await Task.Delay(300);
        using var probe = await server.JoinAsync("Probe");
        return probe.Welcome.Body().GetProperty("members").EnumerateArray().Single(m => m.GetProperty("accountKey").GetString() == who.Key);
    }

    [Fact]
    public async Task The_newest_choice_wins_and_reaches_your_other_devices()
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        using var phone = await server.ConnectAsync();
        await phone.LoginAsync(new TestIdentity(bob.Identity.Account), "Bob");

        var t = Now;
        await bob.RequestAsync("presence.set", Presence("dnd", updatedAt: t));
        var self = (await phone.EventAsync("presence.self")).Body().GetProperty("presence");
        Assert.Equal("dnd", self.GetProperty("status").GetString());
        Assert.Equal(t, self.GetProperty("updatedAt").GetInt64());

        // An older choice (a device that was offline) doesn't overwrite it; the reply says what is current.
        var stale = await phone.RequestAsync("presence.set", Presence("online", updatedAt: t - 60_000));
        Assert.Equal("dnd", stale.Body().GetProperty("presence").GetProperty("status").GetString());
        await bob.NoEventAsync("presence.self");
    }

    [Theory]
    [InlineData("busy")]
    [InlineData("")]
    [InlineData("offline")]
    public async Task Unknown_statuses_are_refused(string status)
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        Assert.Equal("bad_request", (await bob.RequestAsync("presence.set", Presence(status))).ErrorCode());
    }

    [Theory]
    [InlineData("""{ "text": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }""")] // 129
    [InlineData("""{ "text": "two\nlines" }""")]
    [InlineData("""{ "text": "rtl‮override" }""")]
    [InlineData("""{ "emoji": "a b" }""")]
    [InlineData("""{ "emoji": "<:x:1>" }""")]
    [InlineData("""{ "emoji": "🎉🎉🎉🎉🎉🎉🎉🎉🎉" }""")]
    [InlineData("""{ "text": "x", "expiresAt": 99999999999999 }""")]
    [InlineData("""{ "text": 5 }""")]
    [InlineData("\"hi\"")]
    public async Task Bad_custom_statuses_are_refused(string custom)
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        var body = new { status = "online", updatedAt = Now, custom = JsonDocument.Parse(custom).RootElement };
        Assert.Equal("bad_request", (await bob.RequestAsync("presence.set", body)).ErrorCode());
    }

    [Fact]
    public async Task Custom_statuses_up_to_the_limits_are_fine()
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        Assert.Equal("result", (await bob.RequestAsync("presence.set", Presence("online", new { text = new string('a', 128) }))).Type());
        Assert.Equal("result", (await bob.RequestAsync("presence.set", Presence("online", new { emoji = "👨‍👩‍👧", expiresAt = Now + 3_600_000 }))).Type());
        Assert.Equal("bad_request", (await bob.RequestAsync("presence.set", Presence("online", updatedAt: Now + 3_600_000))).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("presence.set", new { status = "online" })).ErrorCode());
    }

    [Fact]
    public async Task Expired_custom_statuses_are_not_shown()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await bob.RequestAsync("presence.set", Presence("online", new { text = "brb", expiresAt = Now + 400 }));
        var update = await UpdateAbout(alice, bob, "online");
        if (update.GetProperty("customStatus").ValueKind == JsonValueKind.Null) update = await UpdateAbout(alice, bob, "online"); // skip "came online"
        Assert.Equal("brb", update.GetProperty("customStatus").GetProperty("text").GetString());
        await Task.Delay(600);
        using var carol = await server.JoinAsync("Carol");
        var seen = carol.Welcome.Body().GetProperty("members").EnumerateArray().Single(m => m.GetProperty("accountKey").GetString() == bob.Key);
        Assert.Equal(JsonValueKind.Null, seen.GetProperty("customStatus").ValueKind);
    }

    [Fact]
    public async Task Do_not_disturb_holds_back_pushes_even_while_offline()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        var endpoint = $"https://fcm.googleapis.com/fcm/send/bob-{Guid.NewGuid():N}";
        await bob.RequestAsync("push.subscribe", new
        {
            endpoint,
            keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
        });

        await bob.RequestAsync("presence.set", Presence("dnd"));
        bob.Client.Dispose();
        await Task.Delay(200);
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"hey <@{bob.Key}>" });
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        await server.Push.NoneAsync(endpoint);

        // Back to online (from another device): pushes resume.
        using var phone = await server.ConnectAsync();
        await phone.LoginAsync(new TestIdentity(bob.Identity.Account), "Bob");
        await phone.RequestAsync("presence.set", Presence("online"));
        phone.Dispose();
        await Task.Delay(200);
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"again <@{bob.Key}>" });
        Assert.Single(await server.Push.WaitForAsync(endpoint));
    }
    [Fact]
    public async Task Invisible_members_are_not_seen_typing()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await bob.RequestAsync("presence.set", Presence("invisible"));
        Assert.Equal("result", (await bob.RequestAsync("chat.typing", new { channelId = server.General })).Type());
        await alice.NoEventAsync("chat.typing");

        await Task.Delay(2100); // the typing rate limit
        await bob.RequestAsync("presence.set", Presence("online"));
        await bob.RequestAsync("chat.typing", new { channelId = server.General });
        Assert.Equal(bob.Key, (await alice.EventAsync("chat.typing")).Body().GetProperty("accountKey").GetString());
    }

    [Fact]
    public async Task Here_does_not_ping_invisible_members()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        async Task<string> Subscribe(User user)
        {
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var q = key.ExportParameters(false).Q;
            var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
            await user.RequestAsync("push.subscribe", new
            {
                endpoint,
                keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
            });
            await user.RequestAsync("notify.set", new { level = "mentions" }); // only mentions: a small server would push every message by default
            return endpoint;
        }
        var bobEndpoint = await Subscribe(bob);
        var carolEndpoint = await Subscribe(carol);
        await carol.RequestAsync("presence.set", Presence("invisible"));

        await admin.RequestAsync("chat.send", new { channelId = server.General, text = "@here standup" });
        Assert.Single(await server.Push.WaitForAsync(bobEndpoint));
        await server.Push.NoneAsync(carolEndpoint);
    }
}
