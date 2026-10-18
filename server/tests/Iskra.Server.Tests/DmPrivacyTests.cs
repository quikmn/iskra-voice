using System.Text.Json;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Who can DM me, and message requests: enforced by the server, invisible to the sender.</summary>
public class DmPrivacyTests
{
    private static object Envelope(string marker) => new { v = 1, ct = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(marker)), keys = Array.Empty<object>() };

    private static string? ErrorKey(JsonElement frame) =>
        frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task SetWho(User user, string who, long? at = null)
    {
        var reply = await user.RequestAsync("dm.privacy.set", new { who, at = at ?? Now });
        Assert.Equal(who, reply.Body().GetProperty("who").GetString());
    }

    private static Task<JsonElement> Send(User from, User to, string text, bool silent = false) =>
        from.RequestAsync("dm.send", new { accountKey = to.Key, envelope = Envelope(text), silent });

    private static string? RequestFlag(JsonElement dmEvent) =>
        dmEvent.Body().TryGetProperty("request", out var r) ? r.GetString() : null;

    private static async Task<string[]> Conversations(User user) =>
        (await user.RequestAsync("dm.conversations")).Body().GetProperty("conversations").EnumerateArray()
            .Select(c => c.GetProperty("accountKey").GetString()!).ToArray();

    private static async Task<(string Key, string State)[]> Requests(User user) =>
        (await user.RequestAsync("dm.requests.list")).Body().GetProperty("requests").EnumerateArray()
            .Select(r => (r.GetProperty("accountKey").GetString()!, r.GetProperty("state").GetString()!)).ToArray();

    private static async Task<string> Subscribe(User user)
    {
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        Assert.Equal("result", (await user.RequestAsync("push.subscribe", PushTests.Subscription(endpoint))).Type());
        return endpoint;
    }

    [Fact]
    public async Task By_default_anyone_can_start_a_dm_and_it_is_not_a_request()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var pref = (await bob.RequestAsync("dm.privacy.get")).Body();
        Assert.Equal("anyone", pref.GetProperty("who").GetString());
        Assert.Equal(0, pref.GetProperty("at").GetInt64());

        Assert.Equal("result", (await Send(alice, bob, "hi")).Type());
        Assert.Null(RequestFlag(await bob.EventAsync("dm.message")));
        Assert.Contains(alice.Key, await Conversations(bob));
        Assert.Empty(await Requests(bob));
    }

    [Fact]
    public async Task A_first_dm_becomes_a_request_that_is_not_pushed_and_the_sender_cannot_tell()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await SetWho(bob, "requests");
        var endpoint = await Subscribe(bob);

        // Carol, who Bob talks to normally: her DM is a plain one, as a baseline for what a sender sees.
        await bob.RequestAsync("dm.privacy.set", new { who = "anyone", at = Now - 5000 }); // older: changes nothing
        await Send(bob, carol, "hey carol");
        var normal = await Send(carol, bob, "hey bob");
        await carol.EventAsync("dm.message");
        await carol.EventAsync("dm.message");
        await server.Push.WaitForAsync(endpoint);

        var request = await Send(alice, bob, "hello stranger");
        Assert.Equal("result", request.Type());
        // The sender's answer and own copy look exactly like a normal DM's.
        Assert.Equal(PropertyNames(normal.Body()), PropertyNames(request.Body()));
        Assert.Equal(PropertyNames(normal.Body().GetProperty("message")), PropertyNames(request.Body().GetProperty("message")));
        Assert.Null(RequestFlag(await alice.EventAsync("dm.message")));

        // Bob's copy says it's a request; no push; not in his conversations, but in his requests.
        var seen = await bob.EventAsync("dm.message"); // Bob's own echo of "hey carol"
        seen = await bob.EventAsync("dm.message"); // Carol's
        Assert.Null(RequestFlag(seen));
        seen = await bob.EventAsync("dm.message");
        Assert.Equal(alice.Key, seen.Body().GetProperty("message").GetProperty("from").GetString());
        Assert.Equal("request", RequestFlag(seen));
        await server.Push.NoneAsync(endpoint, already: 1);
        Assert.DoesNotContain(alice.Key, await Conversations(bob));
        Assert.Equal([(alice.Key, "request")], await Requests(bob));
        // The sender's conversation list has it like any other; the history is there for both.
        Assert.Contains(bob.Key, await Conversations(alice));
        Assert.Single((await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages").EnumerateArray());
        // More messages stay requests.
        await Send(alice, bob, "are you there?");
        Assert.Equal("request", RequestFlag(await bob.EventAsync("dm.message")));
    }

    private static string[] PropertyNames(JsonElement e) => e.EnumerateObject().Select(p => p.Name).Order().ToArray();

    [Fact]
    public async Task Accepting_moves_it_to_the_conversations_and_reaches_the_other_sessions()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var bobPhone = await server.ConnectAsync();
        Assert.Equal("welcome", (await bobPhone.LoginAsync(bob.Identity, "Bob")).Type());
        await SetWho(bob, "requests");
        await bobPhone.EventAsync("dm.privacy");
        var endpoint = await Subscribe(bob);

        await Send(alice, bob, "hello");
        Assert.Equal("request", RequestFlag(await bob.EventAsync("dm.message")));

        var accepted = (await bob.RequestAsync("dm.requests.accept", new { accountKey = alice.Key })).Body();
        Assert.Equal("accepted", accepted.GetProperty("state").GetString());
        var changed = (await bobPhone.EventAsync("dm.requests.changed")).Body();
        Assert.Equal(alice.Key, changed.GetProperty("accountKey").GetString());
        Assert.Equal("accepted", changed.GetProperty("state").GetString());
        Assert.Contains(alice.Key, await Conversations(bob));
        Assert.Empty(await Requests(bob));

        await Send(alice, bob, "thanks");
        Assert.Null(RequestFlag(await bob.EventAsync("dm.message")));
        await server.Push.WaitForAsync(endpoint);
    }

    [Fact]
    public async Task Ignoring_hides_it_without_telling_the_sender_and_replying_accepts()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await SetWho(bob, "requests");
        var endpoint = await Subscribe(bob);

        var first = await Send(alice, bob, "hello");
        await bob.EventAsync("dm.message");
        // Alice's own inbox notes that she accepts Bob's DMs now (she wrote to him); that's all she ever hears.
        var own = (await alice.EventAsync("dm.requests.changed")).Body();
        Assert.Equal((bob.Key, "accepted"), (own.GetProperty("accountKey").GetString(), own.GetProperty("state").GetString()));
        Assert.Equal("ignored", (await bob.RequestAsync("dm.requests.ignore", new { accountKey = alice.Key })).Body().GetProperty("state").GetString());
        await alice.NoEventAsync("dm.requests.changed"); // nothing reaches Alice

        var after = await Send(alice, bob, "hello?");
        Assert.Equal("result", after.Type());
        Assert.Equal(PropertyNames(first.Body()), PropertyNames(after.Body()));
        Assert.Equal("ignored", RequestFlag(await bob.EventAsync("dm.message")));
        await server.Push.NoneAsync(endpoint);
        Assert.Equal([(alice.Key, "ignored")], await Requests(bob));
        Assert.DoesNotContain(alice.Key, await Conversations(bob));

        // Bob changes his mind and writes back: that accepts her.
        Assert.Equal("result", (await Send(bob, alice, "oh hi")).Type());
        Assert.Equal("accepted", (await bob.EventAsync("dm.requests.changed")).Body().GetProperty("state").GetString());
        Assert.Empty(await Requests(bob));
        await Send(alice, bob, "yay");
        await server.Push.WaitForAsync(endpoint);
    }

    [Fact]
    public async Task A_quiet_send_does_not_accept_the_other_person()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await SetWho(bob, "requests");
        await Send(alice, bob, "friend request");
        // Declining a friend request is a quiet DM back; Alice stays a request.
        await Send(bob, alice, "decline", silent: true);
        Assert.Equal([(alice.Key, "request")], await Requests(bob));
    }

    [Fact]
    public async Task Known_takes_people_you_talked_to_and_staff_and_nobody_takes_only_people_you_talked_to()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        // Bob and Carol already talk: Bob wrote back. Alice wrote to him too, but he never answered.
        await Send(carol, bob, "hi");
        await Send(bob, carol, "hi carol");
        await Send(alice, bob, "hi bob");
        await SetWho(bob, "known");

        var refused = await Send(alice, bob, "hello");
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("dm_closed", ErrorKey(refused));
        Assert.Single((await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages").EnumerateArray());
        Assert.Equal("result", (await Send(carol, bob, "still me")).Type());
        Assert.Equal("result", (await Send(admin, bob, "a word from the staff")).Type());
        Assert.Null(RequestFlag(await WaitFrom(bob, admin.Key)));

        await SetWho(bob, "nobody");
        using var admin2 = await server.JoinAsync("Admin2", "admin");
        Assert.Equal("dm_closed", ErrorKey(await Send(admin2, bob, "hello")));
        Assert.Equal("result", (await Send(carol, bob, "and again")).Type());
        // The staff exemption was never "talked to": at nobody, the admin can't write either.
        Assert.Equal("dm_closed", ErrorKey(await Send(admin, bob, "a word from the staff, again")));
        // Bob can still start conversations himself, and that lets the other person answer.
        Assert.Equal("result", (await Send(bob, alice, "hi alice")).Type());
        Assert.Equal("result", (await Send(alice, bob, "hi bob")).Type());
    }

    private static async Task<JsonElement> WaitFrom(User user, string from)
    {
        while (true)
        {
            var e = await user.EventAsync("dm.message");
            if (e.Body().GetProperty("message").GetProperty("from").GetString() == from) return e;
        }
    }

    [Fact]
    public async Task Staff_go_straight_to_the_list_in_requests_mode()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        await SetWho(bob, "requests");
        await Send(admin, bob, "welcome!");
        Assert.Null(RequestFlag(await bob.EventAsync("dm.message")));
        Assert.Empty(await Requests(bob));
    }

    [Fact]
    public async Task Calls_timers_and_group_adds_need_an_accepted_conversation()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await SetWho(bob, "requests");
        await Send(alice, bob, "hello"); // a request

        var call = await alice.RequestAsync("call.start", new { accountKey = bob.Key, callId = GroupTests.NewId(), envelope = Envelope("key") });
        Assert.Equal("call_closed", ErrorKey(call));
        Assert.Equal("dm_closed", ErrorKey(await alice.RequestAsync("disappear.set", new { accountKey = bob.Key, seconds = 3600 })));
        var id = GroupTests.NewId();
        var group = await alice.RequestAsync("group.create",
            GroupTests.Change(alice, id, 1, "", "create", [bob.Key, carol.Key], [alice.Key, bob.Key, carol.Key]));
        Assert.Equal("group_closed", ErrorKey(group));
        // Ignored is refused the same way.
        await bob.RequestAsync("dm.requests.ignore", new { accountKey = alice.Key });
        Assert.Equal("call_closed", ErrorKey(await alice.RequestAsync("call.start", new { accountKey = bob.Key, callId = GroupTests.NewId(), envelope = Envelope("key") })));

        // Once Bob accepts, all of them work.
        await bob.RequestAsync("dm.requests.accept", new { accountKey = alice.Key });
        Assert.Equal("result", (await alice.RequestAsync("disappear.set", new { accountKey = bob.Key, seconds = 3600 })).Type());
        Assert.Equal("result", (await alice.RequestAsync("group.create",
            GroupTests.Change(alice, id, 1, "", "create", [bob.Key, carol.Key], [alice.Key, bob.Key, carol.Key]))).Type());
        Assert.Equal("result", (await alice.RequestAsync("call.start", new { accountKey = bob.Key, callId = GroupTests.NewId(), envelope = Envelope("key") })).Type());
    }

    [Fact]
    public async Task New_conversations_are_rate_limited_per_account()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var store = server.World.Store;
        var people = Enumerable.Range(0, 21).Select(i =>
        {
            var key = Iskra.Server.Crypto.Ed25519.ToB64u(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
            store.AddMember(key, $"Person {i}", "member", Now);
            store.SetDmPrivacy(key, "requests", Now);
            return key;
        }).ToList();
        // dm.send's own limit is per connection (burst 10): spread the sends over a few, as one account.
        var sessions = new List<TestClient>();
        for (var i = 0; i < 3; i++)
        {
            var c = await server.ConnectAsync();
            await c.LoginAsync(alice.Identity, "Alice");
            sessions.Add(c);
        }
        for (var i = 0; i < 20; i++)
            Assert.Equal("result", (await sessions[i % 3].RequestAsync("dm.send", new { accountKey = people[i], envelope = Envelope("hi") })).Type());
        // A decision the recipient made ahead of time (ignored, here) doesn't make it any less new for the sender.
        store.SetDmContact(people[20], alice.Key, Iskra.Server.Storage.DmContactState.Ignored, Now);
        var limited = await alice.RequestAsync("dm.send", new { accountKey = people[20], envelope = Envelope("hi") });
        Assert.Equal("rate_limited", limited.ErrorCode());
        Assert.Equal("dm_new_limit", ErrorKey(limited));
        // Messages in conversations already started still go.
        Assert.Equal("result", (await alice.RequestAsync("dm.send", new { accountKey = people[0], envelope = Envelope("again") })).Type());
        // Another connection doesn't reset it.
        using var again = await server.ConnectAsync();
        await again.LoginAsync(alice.Identity, "Alice");
        Assert.Equal("rate_limited", (await again.RequestAsync("dm.send", new { accountKey = people[20], envelope = Envelope("hi") })).ErrorCode());
        foreach (var c in sessions) c.Dispose();
    }

    [Fact]
    public async Task Bot_dms_follow_the_setting_unless_the_person_wrote_or_just_used_a_command()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bot = await BotDmTests.JoinBot(server, admin);
        await SetWho(alice, "requests");
        await SetWho(bob, "nobody");

        Assert.Equal("result", (await bot.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope("news") })).Type());
        Assert.Equal("request", RequestFlag(await alice.EventAsync("dm.message")));
        Assert.Equal("dm_closed", ErrorKey(await bot.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("news") })));

        // Bob used one of the bot's commands just now: its answer by DM isn't out of the blue.
        var hub = server.Services.GetRequiredService<Iskra.Server.Sessions.Hub>();
        hub.Interactions.Start(bot.Key, bob.Key, server.General, "command", "help", null, null, isPrivate: false);
        Assert.Equal("result", (await bot.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope("help") })).Type());
        Assert.Null(RequestFlag(await bob.EventAsync("dm.message")));
        // Only for now: it never makes the bot someone Bob talked to.
        Assert.NotEqual(Iskra.Server.Storage.DmContactState.Accepted, server.World.Store.DmContact(bob.Key, bot.Key));

        // Writing to a bot is always allowed, and accepts its DMs.
        Assert.Equal("result", (await alice.RequestAsync("dm.send", new { accountKey = bot.Key, envelope = Envelope("/help") })).Type());
        Assert.Empty(await Requests(alice));
        bot.Dispose();
    }

    [Fact]
    public async Task The_setting_is_last_writer_wins_and_checked()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var now = Now;
        await SetWho(alice, "known", now);
        var stale = (await alice.RequestAsync("dm.privacy.set", new { who = "anyone", at = now - 1 })).Body();
        Assert.Equal("known", stale.GetProperty("who").GetString());
        Assert.Equal(now, stale.GetProperty("at").GetInt64());
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.privacy.set", new { who = "friends", at = now + 1 })).ErrorCode());
        var future = await alice.RequestAsync("dm.privacy.set", new { who = "anyone", at = now + 3_600_000 });
        Assert.Equal("bad_request", future.ErrorCode());
        Assert.Equal("clock_off", ErrorKey(future));
        // The server tells apps its clock, so they can stamp changes it takes.
        Assert.InRange((await alice.RequestAsync("dm.privacy.get")).Body().GetProperty("now").GetInt64(), now - 60_000, now + 60_000);
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.privacy.set", new { who = "anyone" })).ErrorCode());
        // Accept and ignore take members other than yourself.
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.requests.accept", new { accountKey = alice.Key })).ErrorCode());
        using var stranger = new TestIdentity();
        Assert.Equal("not_found", (await alice.RequestAsync("dm.requests.ignore", new { accountKey = stranger.AccountKey })).ErrorCode());
        // Accepting someone ahead of time lets them in.
        Assert.Equal("dm_closed", ErrorKey(await Send(bob, alice, "hi")));
        await alice.RequestAsync("dm.requests.accept", new { accountKey = bob.Key });
        Assert.Equal("result", (await Send(bob, alice, "hi")).Type());
    }

    [Fact]
    public async Task The_setting_and_requests_are_in_the_data_export()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await SetWho(bob, "requests");
        await Send(alice, bob, "hello");
        var data = await ComplianceTests.Download(server, (await bob.RequestAsync("data.export")).Body());
        Assert.Equal("requests", data.GetProperty("dmPrivacy")[0].GetProperty("who").GetString());
        var row = data.GetProperty("dmRequests").EnumerateArray().Single(r => r.GetProperty("peer_key").GetString() == alice.Key);
        Assert.Equal(0, row.GetProperty("state").GetInt64());
    }

    [Fact]
    public async Task A_waiting_request_or_an_ignored_one_is_refused_once_the_setting_closes()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await SetWho(bob, "requests");
        Assert.Equal("result", (await Send(alice, bob, "hello")).Type()); // a request
        await bob.RequestAsync("dm.requests.ignore", new { accountKey = carol.Key }); // ignored ahead of time

        await SetWho(bob, "nobody");
        Assert.Equal("dm_closed", ErrorKey(await Send(alice, bob, "still there?")));
        Assert.Equal("dm_closed", ErrorKey(await Send(carol, bob, "hi")));
        await SetWho(bob, "known");
        Assert.Equal("dm_closed", ErrorKey(await Send(alice, bob, "and now?")));
        Assert.Equal("dm_closed", ErrorKey(await Send(carol, bob, "hi")));
        // Accepting lets Alice in at any level.
        await bob.RequestAsync("dm.requests.accept", new { accountKey = alice.Key });
        Assert.Equal("result", (await Send(alice, bob, "thanks")).Type());
    }

    [Fact]
    public async Task Going_straight_in_by_default_or_as_staff_never_counts_as_talked_to()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        // Before Bob's setting reached this server (default: anyone), Alice's DM went straight in.
        Assert.Equal("result", (await Send(alice, bob, "hi")).Type());
        await SetWho(bob, "known");
        Assert.Equal("dm_closed", ErrorKey(await Send(alice, bob, "hi again")));

        // Staff go straight through at "requests" only while they are staff.
        await SetWho(bob, "requests", Now + 1);
        Assert.Equal("result", (await Send(admin, bob, "welcome")).Type());
        server.World.Store.SetMemberRole(admin.Key, "member");
        Assert.Equal("result", (await Send(admin, bob, "me again")).Type());
        Assert.Null(RequestFlag(await WaitFrom(bob, admin.Key)));
        Assert.Equal("request", RequestFlag(await WaitFrom(bob, admin.Key)));
    }

    [Fact]
    public void The_quiet_hours_digest_leaves_out_requests_and_ignored_dms()
    {
        using var server = new IskraServer();
        _ = server.Services; // start it
        var store = server.World.Store;
        string Key() => Iskra.Server.Crypto.Ed25519.ToB64u(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var (bob, alice, carol, dan) = (Key(), Key(), Key(), Key());
        var now = Now;
        foreach (var from in new[] { alice, carol, dan }) store.AddDm(from, bob, "{}", now);
        store.NoteDmWritten(alice, bob, request: true, now);
        store.NoteDmWritten(carol, bob, request: false, now);
        store.SetDmContact(bob, dan, Iskra.Server.Storage.DmContactState.Ignored, now);
        Assert.Equal([carol], store.DmsBetween(bob, now - 1, now + 1).Select(d => d.From).ToArray());
    }
}
