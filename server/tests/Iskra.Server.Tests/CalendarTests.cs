using System.Net;
using System.Text;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class CalendarTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private const long Hour = 3_600_000;

    private static object Plan(string title = "Raid night", long? start = null, string zone = "Europe/Stockholm", string? repeat = null,
        object? location = null, string description = "Bring snacks")
    {
        var s = start ?? Now + Hour;
        return new { title, description, startAt = s, endAt = s + 2 * Hour, timeZone = zone, location = location ?? new { text = "Viktor's place" }, repeat = repeat ?? "none" };
    }

    private static async Task<long> Create(User user, object plan)
    {
        var reply = await user.RequestAsync("event.create", plan);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("event").GetProperty("id").GetInt64();
    }

    private static async Task<string> Subscribe(User user)
    {
        var reply = await user.RequestAsync("calendar.feed.create");
        Assert.Equal("result", reply.Type());
        Assert.True(reply.Body().GetProperty("feed").GetProperty("on").GetBoolean());
        return reply.Body().GetProperty("path").GetString()!;
    }

    private static async Task<string> Fetch(IskraServer server, string path)
    {
        using var response = await server.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/calendar", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
        return Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync());
    }

    private static async Task<HttpStatusCode> Status(IskraServer server, string path)
    {
        using var response = await server.CreateClient().GetAsync(path);
        return response.StatusCode;
    }

    // ── A small RFC 5545 reader: unfolds lines and splits the components ──────

    /// <summary>The content lines, unfolded. Checks what RFC 5545 section 3.1 asks of the raw text on the way.</summary>
    private static List<string> Lines(string ics)
    {
        Assert.EndsWith("\r\n", ics);
        Assert.DoesNotContain("\n", ics.Replace("\r\n", ""));
        Assert.DoesNotContain("\r", ics.Replace("\r\n", ""));
        var lines = new List<string>();
        foreach (var raw in ics[..^2].Split("\r\n"))
        {
            Assert.True(Encoding.UTF8.GetByteCount(raw) <= 75, $"a line of {Encoding.UTF8.GetByteCount(raw)} bytes: {raw}");
            Assert.NotEqual("", raw);
            if (raw[0] == ' ') lines[^1] += raw[1..];
            else lines.Add(raw);
        }
        return lines;
    }

    private sealed record Component(string Kind, List<string> Lines)
    {
        /// <summary>The value of a property (after the first colon outside parameters), or null.</summary>
        public string? Value(string name) => Line(name) is { } line ? line[(line.IndexOf(':') + 1)..] : null;
        public string? Line(string name) => Lines.FirstOrDefault(l => l.StartsWith(name + ":", StringComparison.Ordinal) || l.StartsWith(name + ";", StringComparison.Ordinal));
    }

    private static List<Component> Components(string ics, string kind)
    {
        var lines = Lines(ics);
        Assert.Equal("BEGIN:VCALENDAR", lines[0]);
        Assert.Equal("END:VCALENDAR", lines[^1]);
        Assert.Contains("VERSION:2.0", lines);
        Assert.Contains(lines, l => l.StartsWith("PRODID:", StringComparison.Ordinal));
        var found = new List<Component>();
        var depth = new Stack<string>();
        Component? current = null;
        foreach (var line in lines)
        {
            if (line.StartsWith("BEGIN:", StringComparison.Ordinal))
            {
                depth.Push(line[6..]);
                if (line[6..] == kind && current is null) current = new Component(kind, []);
                continue;
            }
            if (line.StartsWith("END:", StringComparison.Ordinal))
            {
                Assert.Equal(depth.Pop(), line[4..]);
                if (line[4..] == kind && current is not null && !depth.Contains(kind))
                {
                    found.Add(current);
                    current = null;
                }
                continue;
            }
            // name *(";" param) ":" value
            Assert.Matches(@"^[A-Z0-9-]+(;[A-Z0-9-]+=[^;:]+)*:", line);
            current?.Lines.Add(line);
        }
        Assert.Empty(depth);
        return found;
    }

    private static List<Component> Events(string ics)
    {
        var events = Components(ics, "VEVENT");
        foreach (var e in events)
        {
            // Required in every VEVENT of a calendar with a METHOD (RFC 5545 3.6.1).
            Assert.NotNull(e.Value("UID"));
            Assert.Matches(@"^\d{8}T\d{6}Z$", e.Value("DTSTAMP")!);
            Assert.NotNull(e.Line("DTSTART"));
            Assert.Matches(@"^\d{8}T\d{6}Z$", e.Value("LAST-MODIFIED")!);
            Assert.Matches(@"^\d+$", e.Value("SEQUENCE")!);
        }
        Assert.Equal(events.Count, events.Select(e => e.Value("UID")).Distinct().Count());
        return events;
    }

    private static Component Event(string ics, string title) => Assert.Single(Events(ics), e => e.Value("SUMMARY") == CalendarIcs.Text(title));

    // ── Tokens ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task A_feed_is_off_until_made_and_only_a_hash_of_its_token_is_stored()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var before = (await alice.RequestAsync("calendar.feed.get")).Body().GetProperty("feed");
        Assert.True(before.GetProperty("allowed").GetBoolean());
        Assert.False(before.GetProperty("on").GetBoolean());
        Assert.Equal(JsonValueKind.Null, before.GetProperty("address").ValueKind); // a test server isn't on the internet
        Assert.Null(server.World.Store.GetCalendarFeed(alice.Key));

        var path = await Subscribe(alice);
        Assert.Matches(@"^/calendar/[A-Za-z0-9_-]{43}\.ics$", path);
        var token = path["/calendar/".Length..^4];
        var stored = server.World.Store.GetCalendarFeed(alice.Key)!;
        Assert.Equal(CalendarFeeds.Hash(token), stored.TokenHash);
        Assert.DoesNotContain(token, stored.TokenHash);
        // The token is nowhere in the database file's feed table, and the member's state never repeats it.
        var state = (await alice.RequestAsync("calendar.feed.get")).Body();
        Assert.DoesNotContain(token, state.GetRawText());
        Assert.True(state.GetProperty("feed").GetProperty("on").GetBoolean());

        await Fetch(server, path);
        Assert.NotNull(server.World.Store.GetCalendarFeed(alice.Key)!.FetchedAt);
        Assert.Single(server.World.Store.SecurityEvents("calendar.feed.created", alice.Key, null, 10));
    }

    [Fact]
    public async Task A_new_link_ends_the_old_one_and_turning_it_off_ends_it()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var first = await Subscribe(alice);
        await Fetch(server, first);
        var second = await Subscribe(alice);
        Assert.NotEqual(first, second);
        Assert.Equal(HttpStatusCode.NotFound, await Status(server, first));
        await Fetch(server, second);

        var off = (await alice.RequestAsync("calendar.feed.remove")).Body().GetProperty("feed");
        Assert.False(off.GetProperty("on").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, await Status(server, second));
        Assert.Null(server.World.Store.GetCalendarFeed(alice.Key));
        Assert.Single(server.World.Store.SecurityEvents("calendar.feed.removed", alice.Key, null, 10));

        // Not a token, too long, no extension, another path: all the same answer.
        Assert.Equal(HttpStatusCode.NotFound, await Status(server, "/calendar/nope.ics"));
        Assert.Equal(HttpStatusCode.NotFound, await Status(server, "/calendar/" + new string('a', 200) + ".ics"));
        Assert.Equal(HttpStatusCode.NotFound, await Status(server, "/calendar/"));
    }

    [Fact]
    public async Task A_member_who_leaves_loses_their_feed()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Olga", "owner");
        using var bob = await server.JoinAsync("Bob");
        var path = await Subscribe(bob);
        await Fetch(server, path);
        Assert.Equal("result", (await owner.RequestAsync("member.kick", new { accountKey = bob.Key })).Type());
        Assert.Equal(HttpStatusCode.NotFound, await Status(server, path));
        Assert.Null(server.World.Store.GetCalendarFeed(bob.Key));
    }

    [Fact]
    public async Task The_owner_can_turn_feeds_off_for_the_server()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Olga", "owner");
        using var admin = await server.JoinAsync("Adam", "admin");
        using var bob = await server.JoinAsync("Bob");
        var path = await Subscribe(bob);

        Assert.Equal("forbidden", (await admin.RequestAsync("calendar.settings.update", new { feeds = false })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("calendar.settings.update", new { })).ErrorCode());
        var off = (await owner.RequestAsync("calendar.settings.update", new { feeds = false })).Body().GetProperty("feed");
        Assert.False(off.GetProperty("allowed").GetBoolean());
        Assert.False((await bob.EventAsync("calendar.settings")).Body().GetProperty("feeds").GetBoolean());

        Assert.Equal(HttpStatusCode.NotFound, await Status(server, path));
        var mine = (await bob.RequestAsync("calendar.feed.get")).Body().GetProperty("feed");
        Assert.False(mine.GetProperty("allowed").GetBoolean());
        Assert.False(mine.GetProperty("on").GetBoolean());
        Assert.Equal("forbidden", (await bob.RequestAsync("calendar.feed.create")).ErrorCode());

        // Back on: the old link stays dead, a new one works.
        await owner.RequestAsync("calendar.settings.update", new { feeds = true });
        Assert.Equal(HttpStatusCode.NotFound, await Status(server, path));
        await Fetch(server, await Subscribe(bob));
    }

    [Fact]
    public async Task Fetches_are_rate_limited_per_feed_and_wrong_tokens_per_address()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var path = await Subscribe(alice);
        var http = server.CreateClient();
        var statuses = new List<HttpStatusCode>();
        string? retryAfter = null;
        for (var i = 0; i < (int)CalendarFeeds.Burst + 2; i++)
        {
            using var r = await http.GetAsync(path);
            statuses.Add(r.StatusCode);
            if (r.StatusCode == HttpStatusCode.TooManyRequests) retryAfter = r.Headers.RetryAfter?.ToString();
        }
        Assert.Equal((int)CalendarFeeds.Burst, statuses.Count(s => s == HttpStatusCode.OK));
        Assert.Equal(HttpStatusCode.TooManyRequests, statuses[^1]);
        Assert.True(int.Parse(retryAfter!) is > 0 and <= 30);

        var wrong = new List<HttpStatusCode>();
        for (var i = 0; i < (int)CalendarFeeds.FailBurst + 2; i++) wrong.Add(await Status(server, $"/calendar/wrong{i}.ics"));
        Assert.Equal((int)CalendarFeeds.FailBurst, wrong.Count(s => s == HttpStatusCode.NotFound));
        Assert.Equal(HttpStatusCode.TooManyRequests, wrong[^1]);
    }

    // ── Content ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task The_feed_is_valid_icalendar_with_escaped_and_folded_text()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var title = "Raid night; bring potions, flasks \\ and a long title, past 75 bytes — åäö 🎉";
        var description = "Line one\nLine two; with, punctuation";
        var start = Now + 3 * Hour;
        await Create(alice, Plan(title: title, start: start, description: description, zone: "UTC"));
        var ics = await Fetch(server, await Subscribe(alice));

        var e = Event(ics, title);
        Assert.Equal(@"Raid night\; bring potions\, flasks \\ and a long title\, past 75 bytes — åäö 🎉", e.Value("SUMMARY"));
        Assert.Equal(@"Line one\nLine two\; with\, punctuation", e.Value("DESCRIPTION"));
        Assert.Equal("Viktor's place", e.Value("LOCATION"));
        Assert.Equal("CONFIRMED", e.Value("STATUS"));
        Assert.Equal("0", e.Value("SEQUENCE"));
        Assert.Null(e.Line("RRULE"));
        // A one-off is in UTC.
        var utc = DateTimeOffset.FromUnixTimeMilliseconds(start).UtcDateTime;
        Assert.Equal($"DTSTART:{utc:yyyyMMdd'T'HHmmss'Z'}", e.Line("DTSTART"));
        Assert.Equal($"DTEND:{utc.AddHours(2):yyyyMMdd'T'HHmmss'Z'}", e.Line("DTEND"));
        Assert.Empty(Components(ics, "VTIMEZONE"));
        // The folded title was really folded in the raw text.
        Assert.Contains("\r\n ", ics);
        Assert.Contains("METHOD:PUBLISH", Lines(ics));
        Assert.Contains("X-WR-CALNAME:" + CalendarIcs.Text(server.World.Settings.Name), Lines(ics));
    }

    [Fact]
    public void Folding_never_splits_a_character_and_unfolds_to_the_same_line()
    {
        foreach (var line in new[] { "SUMMARY:" + new string('é', 80), "SUMMARY:" + string.Concat(Enumerable.Repeat("🎉", 40)), "SUMMARY:" + new string('a', 74) + "é" + new string('b', 200), "SUMMARY:short" })
        {
            var folded = CalendarIcs.Fold(line);
            foreach (var part in folded.Split("\r\n")) Assert.True(Encoding.UTF8.GetByteCount(part) <= 75);
            Assert.Equal(line, folded.Replace("\r\n ", ""));
            Assert.DoesNotContain('�', folded);
        }
        Assert.Equal(@"a\\b\;c\,d\ne", CalendarIcs.Text("a\\b;c,d\r\ne\u0007"));
    }

    [Fact]
    public async Task A_repeating_event_has_an_rrule_in_its_own_zone_with_a_vtimezone()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var zone = TimeZoneInfo.FindSystemTimeZoneById("Europe/Stockholm");
        var start = Now + 26 * Hour;
        await Create(alice, Plan(title: "Weekly raid", start: start, repeat: "weekly"));
        await Create(alice, Plan(title: "Every other week", start: start + Hour, repeat: "biweekly", zone: "America/Guayaquil"));
        await Create(alice, Plan(title: "Daily standup", start: start, repeat: "daily", zone: "UTC"));
        var ics = await Fetch(server, await Subscribe(alice));

        var weekly = Event(ics, "Weekly raid");
        Assert.Equal("FREQ=WEEKLY", weekly.Value("RRULE"));
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTimeOffset.FromUnixTimeMilliseconds(start).UtcDateTime, zone);
        Assert.Equal($"DTSTART;TZID=Europe/Stockholm:{local:yyyyMMdd'T'HHmmss}", weekly.Line("DTSTART"));
        Assert.Equal($"DTEND;TZID=Europe/Stockholm:{local.AddHours(2):yyyyMMdd'T'HHmmss}", weekly.Line("DTEND"));
        Assert.Equal("FREQ=WEEKLY;INTERVAL=2", Event(ics, "Every other week").Value("RRULE"));
        Assert.StartsWith("DTSTART;TZID=America/Guayaquil:", Event(ics, "Every other week").Line("DTSTART"));
        // UTC needs no zone.
        Assert.Equal("FREQ=DAILY", Event(ics, "Daily standup").Value("RRULE"));
        Assert.Matches(@"^DTSTART:\d{8}T\d{6}Z$", Event(ics, "Daily standup").Line("DTSTART")!);

        // Every TZID used is defined once (RFC 5545 3.2.19), with the right offsets.
        var zones = Components(ics, "VTIMEZONE");
        Assert.Equal(["America/Guayaquil", "Europe/Stockholm"], zones.Select(z => z.Value("TZID")));
        var stockholm = zones[1].Lines;
        Assert.Contains("TZOFFSETFROM:+0100", stockholm);
        Assert.Contains("TZOFFSETTO:+0200", stockholm);
        Assert.Contains("TZOFFSETFROM:+0200", stockholm);
        Assert.Contains("TZOFFSETTO:+0100", stockholm);
        // Summer time starts at 02:00 local time on a Sunday in March; it ends at 03:00.
        Assert.Contains(stockholm, l => System.Text.RegularExpressions.Regex.IsMatch(l, @"^DTSTART:\d{4}03\d{2}T020000$"));
        Assert.Contains(stockholm, l => System.Text.RegularExpressions.Regex.IsMatch(l, @"^DTSTART:\d{4}10\d{2}T030000$"));
        // Ecuador has no clock changes: one part.
        Assert.Equal(["TZID:America/Guayaquil", "DTSTART:19700101T000000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0500"], zones[0].Lines);
    }

    [Fact]
    public void Rules_follow_the_servers_own_repeats()
    {
        static ServerEvent At(string repeat, DateTime utc, string zone = "Europe/Stockholm", long? until = null) =>
            new(1, "x", null, new DateTimeOffset(utc, TimeSpan.Zero).ToUnixTimeMilliseconds(), 0, zone, "place", null, "y", null, "k", 0, "scheduled", null, repeat, until);
        Assert.Null(CalendarIcs.Rule(At("none", new DateTime(2026, 1, 15, 18, 0, 0))));
        Assert.Equal("FREQ=MONTHLY", CalendarIcs.Rule(At("monthly", new DateTime(2026, 1, 15, 18, 0, 0))));
        Assert.Equal("FREQ=MONTHLY", CalendarIcs.Rule(At("monthly", new DateTime(2026, 1, 28, 18, 0, 0))));
        // The 31st: the last day of shorter months, as the server's own next occurrence.
        Assert.Equal("FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1", CalendarIcs.Rule(At("monthly", new DateTime(2026, 1, 31, 18, 0, 0))));
        Assert.Equal("FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1", CalendarIcs.Rule(At("monthly", new DateTime(2026, 4, 30, 18, 0, 0))));
        // The day of the month is the creator's: 23:30 UTC on the 30th is the 31st in Stockholm.
        Assert.Equal("FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1", CalendarIcs.Rule(At("monthly", new DateTime(2026, 1, 30, 23, 30, 0))));
        var until = new DateTimeOffset(2026, 12, 31, 22, 59, 59, TimeSpan.Zero).ToUnixTimeMilliseconds();
        Assert.Equal("FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T225959Z", CalendarIcs.Rule(At("biweekly", new DateTime(2026, 1, 15, 18, 0, 0), until: until)));
    }

    [Fact]
    public async Task Edits_and_cancellations_keep_the_uid_and_raise_the_sequence()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var id = await Create(alice, Plan(title: "Movie night"));
        var keep = await Create(alice, Plan(title: "Stays"));
        var path = await Subscribe(alice);
        var before = Event(await Fetch(server, path), "Movie night");

        Assert.Equal("result", (await alice.RequestAsync("event.update", new { id, title = "Movie night (moved)", startAt = Now + 5 * Hour, endAt = Now + 7 * Hour })).Type());
        var edited = Event(await Fetch(server, path), "Movie night (moved)");
        Assert.Equal(before.Value("UID"), edited.Value("UID"));
        Assert.True(int.Parse(edited.Value("SEQUENCE")!) > int.Parse(before.Value("SEQUENCE")!));
        Assert.NotEqual(before.Line("DTSTART"), edited.Line("DTSTART"));
        Assert.True(string.CompareOrdinal(edited.Value("LAST-MODIFIED"), before.Value("LAST-MODIFIED")) >= 0);

        Assert.Equal("result", (await alice.RequestAsync("event.cancel", new { id })).Type());
        var ics = await Fetch(server, path);
        var cancelled = Event(ics, "Movie night (moved)");
        Assert.Equal(before.Value("UID"), cancelled.Value("UID"));
        Assert.Equal("CANCELLED", cancelled.Value("STATUS"));
        Assert.True(int.Parse(cancelled.Value("SEQUENCE")!) > int.Parse(edited.Value("SEQUENCE")!));
        // The other event didn't change.
        Assert.Equal("0", Event(ics, "Stays").Value("SEQUENCE"));
        Assert.EndsWith($"event-{keep}-{Iskra.Server.Crypto.Ed25519.ToB64u(server.World.ServerPublicKey)}@iskra", Event(ics, "Stays").Value("UID"));
    }

    [Fact]
    public async Task A_skipped_occurrence_is_cancelled_and_the_next_one_carries_the_series()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var id = await Create(alice, Plan(title: "Weekly raid", start: Now + 2 * Hour, repeat: "weekly"));
        var path = await Subscribe(alice);
        Assert.Equal("result", (await alice.RequestAsync("event.cancel", new { id, scope = "one" })).Type());

        var events = Events(await Fetch(server, path)).Where(e => e.Value("SUMMARY") == "Weekly raid").ToList();
        Assert.Equal(2, events.Count);
        var skipped = Assert.Single(events, e => e.Value("STATUS") == "CANCELLED");
        var next = Assert.Single(events, e => e.Value("STATUS") == "CONFIRMED");
        // The skipped one is a plain cancelled event (in UTC, no rule); the series goes on from the next occurrence.
        Assert.Null(skipped.Line("RRULE"));
        Assert.Matches(@"^DTSTART:\d{8}T\d{6}Z$", skipped.Line("DTSTART")!);
        Assert.Equal("FREQ=WEEKLY", next.Value("RRULE"));
        Assert.StartsWith("DTSTART;TZID=Europe/Stockholm:", next.Line("DTSTART"));
        Assert.NotEqual(skipped.Value("UID"), next.Value("UID"));

        // The whole series cancelled: nothing repeats any more.
        var nextId = server.World.Store.OpenEvents().Single().Id;
        await alice.RequestAsync("event.cancel", new { id = nextId });
        Assert.DoesNotContain(Lines(await Fetch(server, path)), l => l.StartsWith("RRULE", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_feed_only_has_what_its_member_can_see_and_names_nobody()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        var officers = store.CreateChannel("officers", "voice", "admin", "admin", 0).Id;
        var lounge = store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        var vault = store.CreateChannel("vault", "voice", "member", "member", 0).Id;
        using var admin = await server.JoinAsync("Adam Adminsson", "admin");
        using var bob = await server.JoinAsync("Bob Bobsson");
        await Create(admin, Plan(title: "Officer meeting", location: new { channelId = officers }));
        await Create(admin, Plan(title: "Open lounge", location: new { channelId = lounge }));
        var secret = await Create(admin, Plan(title: "Vault night", location: new { channelId = vault }));
        await bob.RequestAsync("event.interest", new { id = secret, on = true });
        // The vault becomes an end-to-end encrypted channel.
        store.SaveE2eeChange(new E2eeChannel(vault, "chain", 1, "head", [admin.Key, bob.Key], Now), new E2eeChange(1, "{}", "sig", admin.Key, Now), [], fresh: true);

        var bobs = await Fetch(server, await Subscribe(bob));
        Assert.Equal(["Open lounge"], Events(bobs).Select(e => e.Value("SUMMARY")));
        Assert.Equal($"lounge · {server.World.Settings.Name}", Event(bobs, "Open lounge").Value("LOCATION"));
        Assert.DoesNotContain("Officer", bobs);
        Assert.DoesNotContain("officers", bobs);
        Assert.DoesNotContain("Vault", bobs);

        var admins = await Fetch(server, await Subscribe(admin));
        Assert.Equal(["Officer meeting", "Open lounge"], Events(admins).Select(e => e.Value("SUMMARY")).Order());
        // No member names, no account keys, no attendees.
        foreach (var ics in new[] { bobs, admins })
        {
            Assert.DoesNotContain("Adam", ics);
            Assert.DoesNotContain("Bob", ics);
            Assert.DoesNotContain(admin.Key, ics);
            Assert.DoesNotContain(bob.Key, ics);
            Assert.DoesNotContain("ATTENDEE", ics);
            Assert.DoesNotContain("ORGANIZER", ics);
        }

        // Losing access takes the event out of the feed on the next fetch.
        var path = await Subscribe(bob);
        Assert.Equal("result", (await admin.RequestAsync("event.update", new { id = store.OpenEvents().Single(e => e.Title == "Open lounge").Id, location = new { channelId = officers } })).Type());
        Assert.Empty(Events(await Fetch(server, path)));
    }

    // ── Address and birthdays ────────────────────────────────────────────────

    [Theory]
    [InlineData("https://chat.example.org", true)]
    [InlineData("https://chat.example.org:8443/", true)]
    [InlineData("https://203-0-113-7.sslip.io", true)]
    [InlineData("https://203.0.113.7", true)]
    [InlineData("http://chat.example.org", false)]
    [InlineData("https://localhost:47070", false)]
    [InlineData("https://192.168.1.20", false)]
    [InlineData("https://10.0.0.5:443", false)]
    [InlineData("https://100.101.102.103", false)]
    [InlineData("https://[::1]", false)]
    [InlineData("https://nas", false)]
    [InlineData("https://nas.local", false)]
    [InlineData("https://box.tailnet.ts.net", false)]
    [InlineData("not a url", false)]
    public void Only_a_public_https_address_can_carry_a_feed(string url, bool expected) =>
        Assert.Equal(expected, CalendarFeeds.IsPublicHttps(url));

    [Fact]
    public async Task The_app_is_told_the_public_address_when_there_is_one()
    {
        using var server = new IskraServer { Settings = { ["Calendar:AddressForTests"] = "https://chat.example.org/" } };
        using var alice = await server.JoinAsync("Alice");
        var feed = (await alice.RequestAsync("calendar.feed.get")).Body().GetProperty("feed");
        Assert.Equal("https://chat.example.org", feed.GetProperty("address").GetString());
    }

    [Fact]
    public async Task Birthdays_are_listed_only_while_the_birthdays_bot_is_on()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Olga", "owner");
        using var bob = await server.JoinAsync("Bob");
        Assert.Empty((await bob.RequestAsync("calendar.birthdays")).Body().GetProperty("birthdays").EnumerateArray());

        Assert.Equal("result", (await owner.RequestAsync("builtin.bots.set", new { bot = "birthdays", enabled = true })).Type());
        Assert.Equal("result", (await owner.RequestAsync("birthday.set", new { month = 3, day = 14 })).Type());
        var listed = (await bob.RequestAsync("calendar.birthdays")).Body().GetProperty("birthdays").EnumerateArray().Single();
        Assert.Equal(owner.Key, listed.GetProperty("accountKey").GetString());
        Assert.Equal(3, listed.GetProperty("month").GetInt32());
        Assert.Equal(14, listed.GetProperty("day").GetInt32());

        await owner.RequestAsync("builtin.bots.set", new { bot = "birthdays", enabled = false });
        Assert.Empty((await bob.RequestAsync("calendar.birthdays")).Body().GetProperty("birthdays").EnumerateArray());
    }
}
