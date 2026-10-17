using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

/// <summary>The summary push when quiet hours end (Features/QuietDigestFeature.cs). The clock is passed to Tick by hand.</summary>
public class QuietDigestTests
{
    private static IskraServer NewServer() => new() { Settings = { ["QuietDigest:TickMs"] = "0" } };

    private static void Tick(IskraServer server, DateTimeOffset at) =>
        server.Services.GetServices<IHostedService>().OfType<QuietDigestScheduler>().Single().Tick(at);

    private static async Task<string> SubscribeAsync(User user)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        var keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) };
        Assert.Equal("result", (await user.RequestAsync("push.subscribe", new { endpoint, keys })).Type());
        Assert.Equal("result", (await user.RequestAsync("notify.set", new { level = "mentions" })).Type());
        return endpoint;
    }

    /// <summary>Quiet hours from an hour ago to an hour from now (UTC, every day): on now, over two hours from now.</summary>
    private static object AroundNow(bool digest = true)
    {
        var now = DateTimeOffset.UtcNow;
        var minute = now.Hour * 60 + now.Minute;
        return new { days = 127, from = (minute + 1440 - 60) % 1440, to = (minute + 60) % 1440, timeZone = "UTC", mentions = false, digest };
    }

    private static object AllDay(bool digest = true) => new { days = 127, from = 0, to = 0, timeZone = "UTC", mentions = false, digest };

    private static DateTimeOffset Later => DateTimeOffset.UtcNow.AddHours(2).AddMinutes(1);

    // ── Ends ─────────────────────────────────────────────────────────────────

    [Fact]
    public async Task One_summary_when_quiet_hours_end_and_none_before()
    {
        using var server = NewServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { quiet = AroundNow() });
        Assert.True((await bob.RequestAsync("alerts.get")).Body().GetProperty("alerts").GetProperty("quiet").GetProperty("digest").GetBoolean());

        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> lunch?" });
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> hello?" });
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        Tick(server, DateTimeOffset.UtcNow); // still quiet: nothing
        await server.Push.NoneAsync(endpoint);

        Tick(server, Later);
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("digest", push.GetProperty("kind").GetString());
        Assert.Equal("While it was quiet", push.GetProperty("title").GetString());
        Assert.Equal("2 mentions, 1 message", push.GetProperty("body").GetString());
        Assert.Equal("digest", push.GetProperty("text").GetProperty("title").GetString());
        Assert.Equal("digestBody", push.GetProperty("text").GetProperty("body").GetString());
        var args = push.GetProperty("text").GetProperty("args");
        Assert.Equal(2, args.GetProperty("mentions").GetInt32());
        Assert.Equal(1, args.GetProperty("messages").GetInt32());
        Assert.Equal(0, args.GetProperty("reminders").GetInt32());
        Assert.DoesNotContain("lunch", push.GetRawText()); // counts only, never content

        // Once: the next pass sends nothing more.
        Tick(server, Later.AddMinutes(1));
        await server.Push.NoneAsync(endpoint, already: 1);
    }

    [Fact]
    public async Task Nothing_happened_means_no_summary()
    {
        using var server = NewServer();
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { quiet = AroundNow() });
        Tick(server, Later);
        await server.Push.NoneAsync(endpoint);
        Assert.Null(server.World.Store.QuietSince(bob.Key)); // the stretch is over all the same
    }

    [Fact]
    public async Task Opting_out_sends_no_summary()
    {
        using var server = NewServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { quiet = AroundNow(digest: false) });
        Assert.False((await bob.RequestAsync("alerts.get")).Body().GetProperty("alerts").GetProperty("quiet").GetProperty("digest").GetBoolean());
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> hi" });
        Tick(server, Later);
        await server.Push.NoneAsync(endpoint);
    }

    [Fact]
    public async Task Turning_quiet_hours_off_by_hand_sends_the_summary_at_once()
    {
        using var server = NewServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { quiet = AllDay() });
        Assert.NotNull(server.World.Store.QuietSince(bob.Key));
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        await server.Push.NoneAsync(endpoint);

        await bob.RequestAsync("alerts.set", new { quiet = (object?)null });
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("1 message", push.GetProperty("body").GetString());
        Assert.True(push.GetProperty("silent").GetBoolean());
    }

    [Fact]
    public async Task Turning_them_off_with_the_summary_off_sends_nothing()
    {
        using var server = NewServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { quiet = AllDay(digest: false) });
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        await bob.RequestAsync("alerts.set", new { quiet = (object?)null });
        await server.Push.NoneAsync(endpoint);
    }

    [Fact]
    public async Task Do_not_disturb_still_stops_it()
    {
        using var server = NewServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        await bob.RequestAsync("alerts.set", new { quiet = AroundNow() });
        await bob.RequestAsync("presence.set", new { status = "dnd", custom = (object?)null, updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        Tick(server, Later);
        await server.Push.NoneAsync(endpoint);
    }

    // ── What counts ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Only_what_the_member_can_still_read_and_not_from_people_they_blocked()
    {
        using var server = NewServer();
        using var alice = await server.JoinAsync("Alice");
        using var carol = await server.JoinAsync("Carol");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        var store = server.World.Store;
        var staff = store.CreateChannel("staff", "text", "member", "member", 0);
        await bob.RequestAsync("alerts.set", new { quiet = AroundNow() });

        await alice.RequestAsync("chat.send", new { channelId = staff.Id, text = $"<@{bob.Key}> secret plans" });
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> open plans" });
        await carol.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{bob.Key}> from carol" });
        await carol.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1 } });
        // Then the channel is closed to members, and Bob blocks Carol.
        store.UpdateChannel(staff with { ReadRole = "admin" });
        await bob.RequestAsync("block.sync", new { entries = new[] { new { accountKey = carol.Key, blocked = true, at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() } } });

        Tick(server, Later);
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("1 mention", push.GetProperty("body").GetString());
    }

    [Fact]
    public async Task Each_server_sums_up_only_its_own_items()
    {
        using var quiet = NewServer();
        using var busy = NewServer();
        using var bobQuiet = await quiet.JoinAsync("Bob");
        using var bobBusy = await busy.JoinAsync("Bob");
        using var alice = await busy.JoinAsync("Alice");
        var quietEndpoint = await SubscribeAsync(bobQuiet);
        var busyEndpoint = await SubscribeAsync(bobBusy);
        await bobQuiet.RequestAsync("alerts.set", new { quiet = AroundNow() });
        await bobBusy.RequestAsync("alerts.set", new { quiet = AroundNow() });
        await alice.RequestAsync("chat.send", new { channelId = busy.General, text = $"<@{bobBusy.Key}> over here" });

        Tick(quiet, Later);
        Tick(busy, Later);
        Assert.Equal("1 mention", (await busy.Push.WaitForAsync(busyEndpoint)).Single().GetProperty("body").GetString());
        await quiet.Push.NoneAsync(quietEndpoint);
    }

    [Fact]
    public void The_body_names_every_kind()
    {
        Assert.Equal("1 mention, 3 messages, 2 alert words, 1 post by someone you follow, 1 event, 2 reminders",
            QuietDigestFeature.Body(new QuietDigestCounts(1, 3, 2, 1, 1, 2)));
        Assert.Equal("", QuietDigestFeature.Body(new QuietDigestCounts(0, 0, 0, 0, 0, 0)));
    }

    [Fact]
    public async Task When_the_stretch_began_is_in_the_data_export()
    {
        using var server = NewServer();
        using var alice = await server.JoinAsync("Alice");
        await alice.RequestAsync("alerts.set", new { quiet = AllDay() });
        var data = await ComplianceTests.Download(server, (await alice.RequestAsync("data.export")).Body());
        var row = data.GetProperty("alertSettings")[0];
        Assert.Equal(JsonValueKind.Number, row.GetProperty("quiet_since").ValueKind);
    }

    // ── Time zones and clock changes ─────────────────────────────────────────

    private static QuietHours Q(int days, int from, int to, string zone, bool digest = true) => new(days, from, to, zone, false, digest);
    private static DateTimeOffset Utc(string iso) => DateTimeOffset.Parse(iso + "Z", System.Globalization.CultureInfo.InvariantCulture);
    private const int Saturday = 1 << 6;

    [Fact]
    public void A_stretch_ends_at_the_local_time_in_its_own_zone()
    {
        // Saturday 22:00 – Sunday 07:00 in New York (EST in January, UTC−5): 03:00 – 12:00 UTC.
        var quiet = Q(Saturday, 22 * 60, 7 * 60, "America/New_York");
        var (since, ended) = QuietDigestFeature.Advance(quiet, null, Utc("2026-01-11T11:59"));
        Assert.Equal(Utc("2026-01-11T03:00").ToUnixTimeMilliseconds(), since);
        Assert.Null(ended);
        Assert.Equal((since, (long?)null), QuietDigestFeature.Advance(quiet, since, Utc("2026-01-11T11:59")));
        Assert.Equal(((long?)null, since), QuietDigestFeature.Advance(quiet, since, Utc("2026-01-11T12:00")));
        // Outside quiet hours with nothing running: nothing happens.
        Assert.Equal(((long?)null, (long?)null), QuietDigestFeature.Advance(quiet, null, Utc("2026-01-11T12:00")));
        Assert.Equal(((long?)null, (long?)null), QuietDigestFeature.Advance(null, null, Utc("2026-01-11T12:00")));
    }

    [Fact]
    public void Clock_changes_move_the_end_in_utc()
    {
        // Stockholm, Saturday 22:00 – Sunday 07:00. Autumn (25 Oct 2026): starts 20:00 UTC (CEST), ends 06:00 UTC (CET).
        var quiet = Q(Saturday, 22 * 60, 7 * 60, "Europe/Stockholm");
        Assert.Equal(Utc("2026-10-24T20:00").ToUnixTimeMilliseconds(), QuietDigestFeature.StretchStart(quiet, Utc("2026-10-25T05:59")));
        Assert.Null(QuietDigestFeature.Advance(quiet, 1, Utc("2026-10-25T05:59")).Ended);
        Assert.Equal(1, QuietDigestFeature.Advance(quiet, 1, Utc("2026-10-25T06:00")).Ended);
        // Spring (29 Mar 2026): starts 21:00 UTC (CET), ends 05:00 UTC (CEST): an hour shorter.
        Assert.Equal(Utc("2026-03-28T21:00").ToUnixTimeMilliseconds(), QuietDigestFeature.StretchStart(quiet, Utc("2026-03-29T04:59")));
        Assert.Equal(1, QuietDigestFeature.Advance(quiet, 1, Utc("2026-03-29T05:00")).Ended);
    }

    [Fact]
    public void A_stretch_in_the_skipped_hour_never_starts()
    {
        // 02:00 – 02:30 on the Sunday the clocks skip from 02:00 to 03:00 (Stockholm): it never happens.
        var quiet = Q(1, 2 * 60, 2 * 60 + 30, "Europe/Stockholm");
        foreach (var at in new[] { "2026-03-29T00:59", "2026-03-29T01:00", "2026-03-29T01:15", "2026-03-29T01:30" })
            Assert.Null(QuietDigestFeature.Advance(quiet, null, Utc(at)).Since);
    }

    [Fact]
    public void An_all_week_stretch_reaches_back_a_week_at_most()
    {
        var now = Utc("2026-05-01T12:00");
        Assert.Equal((now - QuietDigestFeature.MaxStretch).ToUnixTimeMilliseconds(), QuietDigestFeature.StretchStart(Q(127, 0, 0, "UTC"), now));
    }
}
