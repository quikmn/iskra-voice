using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class AlertTests
{
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

    private static async Task<string> SubscribeAsync(User user)
    {
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        Assert.Equal("result", (await user.RequestAsync("push.subscribe", Subscription(endpoint))).Type());
        Assert.Equal("result", (await user.RequestAsync("notify.set", new { level = "mentions" })).Type());
        return endpoint;
    }

    private static Task<JsonElement> Say(User user, long channelId, string text) => user.RequestAsync("chat.send", new { channelId, text });

    private static object AllDay(bool mentions = false) => new { days = 127, from = 0, to = 0, timeZone = "UTC", mentions };

    // ── Settings ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task Settings_are_kept_per_member_and_cleaned()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var empty = (await alice.RequestAsync("alerts.get")).Body().GetProperty("alerts");
        Assert.Empty(empty.GetProperty("words").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("quiet").ValueKind);

        var set = await alice.RequestAsync("alerts.set", new
        {
            words = new[] { "  raid  night ", "Pizza", "pizza", "" },
            quiet = new { days = 0b0111110, from = 22 * 60, to = 7 * 60, timeZone = "Europe/Stockholm", mentions = true },
        });
        Assert.Equal("result", set.Type());
        var alerts = set.Body().GetProperty("alerts");
        Assert.Equal(["raid night", "Pizza"], alerts.GetProperty("words").EnumerateArray().Select(w => w.GetString()!));
        Assert.Equal("Europe/Stockholm", alerts.GetProperty("quiet").GetProperty("timeZone").GetString());
        Assert.Equal(1320, alerts.GetProperty("quiet").GetProperty("from").GetInt32());
        Assert.True(alerts.GetProperty("quiet").GetProperty("mentions").GetBoolean());
        // Their other devices hear about it; nobody else does.
        Assert.Equal("Pizza", (await alice.EventAsync("alerts.updated")).Body().GetProperty("alerts").GetProperty("words")[1].GetString());
        await bob.NoEventAsync("alerts.updated");
        Assert.Empty((await bob.RequestAsync("alerts.get")).Body().GetProperty("alerts").GetProperty("words").EnumerateArray());

        // Nothing left to keep: the row goes.
        await alice.RequestAsync("alerts.set", new { words = Array.Empty<string>(), quiet = (object?)null });
        Assert.Null(server.World.Store.GetAlerts(alice.Key));
    }

    [Fact]
    public async Task Bad_settings_are_refused()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("alerts.set", new { words = Enumerable.Range(0, 26).Select(i => $"w{i}").ToArray() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("alerts.set", new { words = new[] { new string('x', 51) } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("alerts.set", new { words = new[] { "a\u0007b" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("alerts.set", new { words = new object[] { 5 } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("alerts.set", new { quiet = new { days = 0, from = 0, to = 60, timeZone = "UTC" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("alerts.set", new { quiet = new { days = 128, from = 0, to = 60, timeZone = "UTC" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("alerts.set", new { quiet = new { days = 1, from = 0, to = 1440, timeZone = "UTC" } })).ErrorCode());
        var zone = await alice.RequestAsync("alerts.set", new { quiet = new { days = 1, from = 0, to = 60, timeZone = "Mars/Olympus" } });
        Assert.Equal("bad_request", zone.ErrorCode());
        Assert.Equal("alerts_time_zone", zone.Body().GetProperty("key").GetString());
        Assert.Null(server.World.Store.GetAlerts(alice.Key));
    }

    [Fact]
    public async Task Leaving_and_deleting_the_account_remove_them()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        await alice.RequestAsync("alerts.set", new { words = new[] { "pizza" } });
        Assert.NotNull(server.World.Store.GetAlerts(alice.Key));
        server.World.Store.RemoveMember(alice.Key);
        Assert.Null(server.World.Store.GetAlerts(alice.Key));
    }

    // ── Matching ─────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("Anyone for pizza tonight?", true)]
    [InlineData("PIZZA!", true)]
    [InlineData("pizzas are great", false)]       // whole words only
    [InlineData("pepperonipizza", false)]
    [InlineData("pizza_time", false)]
    [InlineData("the raid   night is on", true)]  // phrases, any spaces between
    [InlineData("raid nightly", false)]
    [InlineData("Ölkväll på fredag", true)]       // letters beyond ASCII, any case
    [InlineData("ölkvällen", false)]
    [InlineData("", false)]
    public void Words_match_whole_and_ignore_case(string text, bool expected) =>
        Assert.Equal(expected, AlertFeature.Matches(["pizza", "raid night", "ölkväll"], text));

    [Fact]
    public void Patterns_are_literal() =>
        Assert.False(AlertFeature.Matches(["a.c", "(x+)+$"], "abc xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx!"));

    [Fact]
    public async Task Opted_in_words_push_and_land_in_the_inbox()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var bobEndpoint = await SubscribeAsync(bob);
        var carolEndpoint = await SubscribeAsync(carol);
        await bob.RequestAsync("alerts.set", new { words = new[] { "pizza" } });

        await Say(alice, server.General, "who wants Pizza?");
        var push = (await server.Push.WaitForAsync(bobEndpoint)).Single();
        Assert.Equal("keyword", push.GetProperty("kind").GetString());
        Assert.Equal("Alice in #general", push.GetProperty("title").GetString());
        await server.Push.NoneAsync(carolEndpoint);
        var item = (await bob.EventAsync("inbox.new")).Body().GetProperty("item");
        Assert.Equal("keyword", item.GetProperty("kind").GetString());
        Assert.Equal("keyword", (await bob.RequestAsync("inbox.list")).Body().GetProperty("items")[0].GetProperty("kind").GetString());

        // Your own words in your own message don't alert you; a level of "nothing" still means nothing.
        await Say(bob, server.General, "pizza is here");
        await bob.RequestAsync("notify.set", new { level = "none" });
        await Say(alice, server.General, "more pizza");
        await server.Push.NoneAsync(bobEndpoint, already: 1);
    }

    [Fact]
    public async Task Words_never_match_where_they_cannot_be_read()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var guest = await server.JoinAsync("Guest", "guest");
        var endpoint = await SubscribeAsync(guest);
        await guest.RequestAsync("alerts.set", new { words = new[] { "secret" } });
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        await Say(admin, staff, "the secret plan");
        await server.Push.NoneAsync(endpoint);
        await guest.NoEventAsync("inbox.new");
    }

    // ── Quiet hours ──────────────────────────────────────────────────────────

    private static QuietHours Q(int days, int from, int to, string zone = "Europe/Stockholm") => new(days, from, to, zone, false);
    private static DateTimeOffset Utc(string iso) => DateTimeOffset.Parse(iso + "Z", System.Globalization.CultureInfo.InvariantCulture);
    private const int Weekdays = 0b0111110;
    private const int Friday = 1 << 5;
    private const int Saturday = 1 << 6;

    [Theory]
    // 22:00–07:00 Stockholm on weekdays (summer time, UTC+2): starts on the day it begins, ends the next morning.
    [InlineData("2026-07-01T19:59", false)] // Wed 21:59 local
    [InlineData("2026-07-01T20:00", true)]  // Wed 22:00
    [InlineData("2026-07-02T04:59", true)]  // Thu 06:59 (Wednesday's night)
    [InlineData("2026-07-02T05:00", false)] // Thu 07:00
    [InlineData("2026-07-04T21:00", false)] // Sat 23:00: Saturday isn't picked
    [InlineData("2026-07-04T03:00", true)]  // Sat 05:00: Friday's night goes on into Saturday
    [InlineData("2026-07-05T23:30", false)] // Mon 01:30 local: that's Sunday's night, and Sunday isn't picked
    [InlineData("2026-07-06T20:30", true)]  // Mon 22:30
    public void Quiet_hours_cross_midnight_in_their_own_time_zone(string utc, bool expected) =>
        Assert.Equal(expected, AlertFeature.Active(Q(Weekdays, 22 * 60, 7 * 60), Utc(utc)));

    [Fact]
    public void Quiet_hours_follow_the_zone_not_utc()
    {
        var fridayNight = Q(Friday, 23 * 60, 2 * 60, "America/New_York");
        Assert.True(AlertFeature.Active(fridayNight, Utc("2026-01-10T04:30")));  // Fri 23:30 in New York (UTC-5)
        Assert.True(AlertFeature.Active(fridayNight, Utc("2026-01-10T06:59")));  // Sat 01:59
        Assert.False(AlertFeature.Active(fridayNight, Utc("2026-01-10T07:00"))); // Sat 02:00
        Assert.False(AlertFeature.Active(fridayNight, Utc("2026-01-09T23:30"))); // Fri 23:30 UTC is only 18:30 there
        // Same day, from < to; from = to is the whole day.
        Assert.True(AlertFeature.Active(Q(Saturday, 9 * 60, 12 * 60, "UTC"), Utc("2026-01-10T11:59")));
        Assert.False(AlertFeature.Active(Q(Saturday, 9 * 60, 12 * 60, "UTC"), Utc("2026-01-10T12:00")));
        Assert.True(AlertFeature.Active(Q(Saturday, 0, 0, "UTC"), Utc("2026-01-10T23:59")));
        Assert.False(AlertFeature.Active(Q(Saturday, 0, 0, "UTC"), Utc("2026-01-11T00:00")));
        Assert.False(AlertFeature.Active(Q(Saturday, 0, 0, "Nowhere/Else"), Utc("2026-01-10T12:00")));
    }

    [Fact]
    public async Task Quiet_hours_stop_pushes()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { quiet = AllDay() });

        await Say(alice, server.General, $"<@{bob.Key}> you there?");
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        await server.Push.NoneAsync(endpoint);
        // Still in the inbox, as unread.
        Assert.Equal("mention", (await bob.EventAsync("inbox.new")).Body().GetProperty("item").GetProperty("kind").GetString());
    }

    [Fact]
    public async Task Quiet_hours_can_let_mentions_through_silently()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("notify.set", new { level = "all" });
        await bob.RequestAsync("alerts.set", new { quiet = AllDay(mentions: true) });

        await Say(alice, server.General, "just chatting"); // an ordinary message: not now
        await server.Push.NoneAsync(endpoint);
        await Say(alice, server.General, $"<@{bob.Key}> dinner?");
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("mention", push.GetProperty("kind").GetString());
        Assert.True(push.GetProperty("silent").GetBoolean());

        // Outside quiet hours pushes make their usual sound.
        await bob.RequestAsync("alerts.set", new { quiet = (object?)null });
        var other = server.World.Store.CreateChannel("other", "text", "member", "member", 0).Id;
        await Say(alice, other, $"<@{bob.Key}> and now?");
        var loud = (await server.Push.WaitForAsync(endpoint, 2))[1];
        Assert.Equal(JsonValueKind.Null, loud.GetProperty("silent").ValueKind);
    }

    [Fact]
    public async Task Alert_settings_are_in_the_data_export()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        await alice.RequestAsync("alerts.set", new { words = new[] { "pizza" }, quiet = AllDay() });
        var data = await ComplianceTests.Download(server, (await alice.RequestAsync("data.export")).Body());
        var row = data.GetProperty("alertSettings")[0];
        Assert.Contains("pizza", row.GetProperty("words").GetString());
        Assert.Contains("UTC", row.GetProperty("quiet").GetString());
    }

    // ── Follows ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task Following_a_person_in_a_channel_pushes_and_lands_in_the_inbox()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var offtopic = server.World.Store.CreateChannel("offtopic", "text", "member", "member", 1).Id;
        var endpoint = await SubscribeAsync(bob);
        var saved = (await bob.RequestAsync("alerts.set", new { follows = new[] { new { member = alice.Key, channelId = server.General } } })).Body().GetProperty("alerts");
        var follow = saved.GetProperty("follows").EnumerateArray().Single();
        Assert.Equal(alice.Key, follow.GetProperty("member").GetString());
        Assert.Equal(server.General, follow.GetProperty("channelId").GetInt64());

        await Say(alice, server.General, "hello there");
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("follow", push.GetProperty("kind").GetString());
        Assert.Equal("Alice in #general", push.GetProperty("title").GetString());
        var item = (await bob.EventAsync("inbox.new")).Body().GetProperty("item");
        Assert.Equal("follow", item.GetProperty("kind").GetString());
        Assert.Equal("follow", (await bob.RequestAsync("inbox.list")).Body().GetProperty("items")[0].GetProperty("kind").GetString());

        // Someone else, or another channel: nothing. A mention still wins over a follow.
        await Say(carol, server.General, "not followed");
        await Say(alice, offtopic, "elsewhere");
        await server.Push.NoneAsync(endpoint, already: 1);
        await bob.NoEventAsync("inbox.new");
        await Say(alice, server.General, $"hey <@{bob.Key}>");
        Assert.Equal("mention", (await bob.EventAsync("inbox.new")).Body().GetProperty("item").GetProperty("kind").GetString());
    }

    [Fact]
    public async Task Following_a_role_anywhere_covers_every_channel_but_respects_mutes()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var offtopic = server.World.Store.CreateChannel("offtopic", "text", "member", "member", 1).Id;
        var role = (await owner.RequestAsync("role.create", new { name = "Raiders" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("member.roles.set", new { accountKey = alice.Key, roles = new[] { role } })).Type());
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { follows = new[] { new { role } } });

        await Say(alice, offtopic, "raid at nine");
        Assert.Equal("follow", (await server.Push.WaitForAsync(endpoint)).Single().GetProperty("kind").GetString());
        Assert.Equal("follow", (await bob.EventAsync("inbox.new")).Body().GetProperty("item").GetProperty("kind").GetString());

        // A muted channel keeps follows out of push (the inbox still lists them); the owner, without the role, doesn't count.
        await bob.RequestAsync("notify.set", new { channelId = offtopic, muteMinutes = -1 });
        await Say(alice, offtopic, "muted here");
        await server.Push.NoneAsync(endpoint, already: 1);
        await bob.EventAsync("inbox.new");
        await Say(owner, server.General, "no role");
        await server.Push.NoneAsync(endpoint, already: 1);
        await bob.NoEventAsync("inbox.new");
    }

    [Fact]
    public async Task Bad_follows_are_refused_and_the_rest_cleaned()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        Assert.Equal("bad_request", (await bob.RequestAsync("alerts.set", new { follows = new[] { new { channelId = 1 } } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("alerts.set", new { follows = new[] { new { member = alice.Key, role = 1 } } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("alerts.set", new { follows = new[] { new { member = "not-a-key" } } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("alerts.set", new { follows = Enumerable.Range(1, 51).Select(i => new { role = i }).ToArray() })).ErrorCode());
        var twice = new[] { new { member = alice.Key }, new { member = alice.Key } };
        var alerts = (await bob.RequestAsync("alerts.set", new { follows = twice })).Body().GetProperty("alerts");
        Assert.Single(alerts.GetProperty("follows").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, alerts.GetProperty("follows")[0].GetProperty("channelId").ValueKind);
        // Clearing everything removes the row.
        await bob.RequestAsync("alerts.set", new { });
        Assert.Null(server.World.Store.GetAlerts(bob.Key));
    }
}
