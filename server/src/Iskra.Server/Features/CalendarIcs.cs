using System.Globalization;
using System.Text;
using Iskra.Server.Crypto;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The iCalendar (RFC 5545) text of a member's calendar feed: every event the server still has that the member can see.
/// One VEVENT per event row with a UID that never changes. The open occurrence of a repeating event carries the RRULE
/// (its start in the creator's zone, so it keeps its wall-clock time across clock changes); occurrences that are over
/// are plain events. SEQUENCE and LAST-MODIFIED follow the row's changes, and a cancelled event stays as STATUS:CANCELLED
/// (for the 30 days the server keeps it), so calendar apps take edits and cancellations.
/// </summary>
public static class CalendarIcs
{
    public static string Build(World world, Member member, long now)
    {
        var store = world.Store;
        var serverKey = Ed25519.ToB64u(world.ServerPublicKey);
        var events = store.AllEvents().Where(e => Visible(store, member, e)).ToList();
        var lines = new List<string>
        {
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Iskra//Calendar feed//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            $"X-WR-CALNAME:{Text(world.Settings.Name)}",
            $"NAME:{Text(world.Settings.Name)}",
            "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
            "X-PUBLISHED-TTL:PT1H",
        };
        foreach (var zone in events.Where(Zoned).Select(e => e.TimeZone).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
            lines.AddRange(TimeZoneLines(zone, now));
        foreach (var e in events) lines.AddRange(EventLines(world, e, serverKey, now));
        lines.Add("END:VCALENDAR");
        var text = new StringBuilder();
        foreach (var line in lines) text.Append(Fold(line)).Append("\r\n");
        return text.ToString();
    }

    /// <summary>
    /// What the member may see (as in the app), minus events in an end-to-end encrypted channel: nothing about those
    /// channels leaves the server in a feed.
    /// </summary>
    internal static bool Visible(Store store, Member member, ServerEvent e) =>
        EventFeature.CanSee(store, member, e)
        && !(e.LocationKind == "voice" && e.ChannelId is { } id && store.GetE2ee(id) is not null);

    /// <summary>The open occurrence of a series outside UTC: its times are written in its own zone, with the RRULE.</summary>
    private static bool Zoned(ServerEvent e) => e.IsOpen && e.Repeats && e.TimeZone != "UTC";

    public static string Uid(ServerEvent e, string serverKey) => $"event-{e.Id}-{serverKey}@iskra";

    private static IEnumerable<string> EventLines(World world, ServerEvent e, string serverKey, long now)
    {
        var store = world.Store;
        var zoned = Zoned(e);
        string Stamp(long ms) => zoned ? $";TZID={e.TimeZone}:{Local(ms, e.TimeZone)}" : $":{Utc(ms)}";
        yield return "BEGIN:VEVENT";
        yield return $"UID:{Uid(e, serverKey)}";
        yield return $"DTSTAMP:{Utc(now)}";
        yield return $"DTSTART{Stamp(e.StartAt)}";
        yield return $"DTEND{Stamp(e.EndAt)}";
        if (e.IsOpen && Rule(e) is { } rule) yield return $"RRULE:{rule}";
        yield return $"SUMMARY:{Text(e.Title)}";
        if (e.Description is { Length: > 0 } description) yield return $"DESCRIPTION:{Text(description)}";
        var place = e.LocationKind == "voice"
            ? e.ChannelId is { } id && store.GetChannel(id) is { } channel ? $"{channel.Name} · {world.Settings.Name}" : world.Settings.Name
            : e.Location ?? "";
        if (place.Length > 0) yield return $"LOCATION:{Text(place)}";
        yield return $"CREATED:{Utc(e.CreatedAt)}";
        yield return $"LAST-MODIFIED:{Utc(e.UpdatedAt ?? e.CreatedAt)}";
        yield return $"SEQUENCE:{e.Sequence.ToString(CultureInfo.InvariantCulture)}";
        yield return $"STATUS:{(e.Status == "cancelled" ? "CANCELLED" : "CONFIRMED")}";
        yield return "TRANSP:OPAQUE";
        yield return "END:VEVENT";
    }

    /// <summary>
    /// The RRULE of a repeating event. A monthly event on the 29th, 30th or 31st falls on the month's last day in shorter
    /// months, as <see cref="EventFeature.NextStart"/> does.
    /// </summary>
    public static string? Rule(ServerEvent e)
    {
        string? rule = e.Repeat switch
        {
            "daily" => "FREQ=DAILY",
            "weekly" => "FREQ=WEEKLY",
            "biweekly" => "FREQ=WEEKLY;INTERVAL=2",
            "monthly" => Monthly(e),
            _ => null,
        };
        if (rule is null) return null;
        return e.Until is { } until ? $"{rule};UNTIL={Utc(until)}" : rule;
    }

    private static string Monthly(ServerEvent e)
    {
        var day = LocalTime(e.StartAt, e.TimeZone).Day;
        if (day <= 28) return "FREQ=MONTHLY";
        return $"FREQ=MONTHLY;BYMONTHDAY={string.Join(',', Enumerable.Range(28, day - 27))};BYSETPOS=-1";
    }

    // ── Values ───────────────────────────────────────────────────────────────

    private static string Utc(long ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);

    private static DateTime LocalTime(long ms, string zone) =>
        TimeZoneInfo.ConvertTimeFromUtc(DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime, TimeZoneInfo.FindSystemTimeZoneById(zone));

    private static string Local(long ms, string zone) => LocalTime(ms, zone).ToString("yyyyMMdd'T'HHmmss", CultureInfo.InvariantCulture);

    /// <summary>A TEXT value: backslash, semicolon, comma and line breaks escaped; other control characters dropped.</summary>
    public static string Text(string value)
    {
        var text = new StringBuilder(value.Length + 8);
        foreach (var c in value.ReplaceLineEndings("\n"))
        {
            switch (c)
            {
                case '\\': text.Append(@"\\"); break;
                case ';': text.Append(@"\;"); break;
                case ',': text.Append(@"\,"); break;
                case '\n': text.Append(@"\n"); break;
                default:
                    if (!char.IsControl(c) || c == '\t') text.Append(c);
                    break;
            }
        }
        return text.ToString();
    }

    /// <summary>Lines longer than 75 bytes continue on the next line after CRLF and a space, never splitting a character.</summary>
    public static string Fold(string line)
    {
        if (Encoding.UTF8.GetByteCount(line) <= 75) return line;
        var folded = new StringBuilder(line.Length + 16);
        var bytes = 0;
        var limit = 75;
        foreach (var rune in line.EnumerateRunes())
        {
            var size = rune.Utf8SequenceLength;
            if (bytes + size > limit)
            {
                folded.Append("\r\n ");
                bytes = 0;
                limit = 74; // the leading space counts
            }
            folded.Append(rune.ToString());
            bytes += size;
        }
        return folded.ToString();
    }

    // ── VTIMEZONE ────────────────────────────────────────────────────────────

    /// <summary>
    /// A VTIMEZONE for an IANA zone: the offset in effect a year ago, then one STANDARD or DAYLIGHT part per clock
    /// change from then until five years ahead (a series runs at most two). Calendar apps that know the zone by its
    /// name use their own rules; this is for the ones that need the definition.
    /// </summary>
    internal static IEnumerable<string> TimeZoneLines(string zone, long now)
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(zone);
        var from = DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime.Date.AddYears(-1);
        var to = from.AddYears(6);
        yield return "BEGIN:VTIMEZONE";
        yield return $"TZID:{zone}";
        var offset = tz.GetUtcOffset(from);
        foreach (var line in Observance(tz.IsDaylightSavingTime(from), new DateTime(1970, 1, 1), offset, offset)) yield return line;
        for (var day = from; day < to; day = day.AddDays(1))
        {
            var next = tz.GetUtcOffset(day.AddDays(1));
            if (next == offset) continue;
            // The second the offset changes, by halving the day.
            DateTime low = day, high = day.AddDays(1);
            while ((high - low).TotalSeconds > 1)
            {
                var middle = low.AddSeconds(Math.Floor((high - low).TotalSeconds / 2));
                if (tz.GetUtcOffset(middle) == offset) low = middle;
                else high = middle;
            }
            foreach (var line in Observance(tz.IsDaylightSavingTime(high), high + offset, offset, next)) yield return line;
            offset = next;
        }
        yield return "END:VTIMEZONE";
    }

    private static IEnumerable<string> Observance(bool daylight, DateTime localStart, TimeSpan from, TimeSpan to)
    {
        var name = daylight ? "DAYLIGHT" : "STANDARD";
        yield return $"BEGIN:{name}";
        yield return $"DTSTART:{localStart.ToString("yyyyMMdd'T'HHmmss", CultureInfo.InvariantCulture)}";
        yield return $"TZOFFSETFROM:{Offset(from)}";
        yield return $"TZOFFSETTO:{Offset(to)}";
        yield return $"END:{name}";
    }

    private static string Offset(TimeSpan offset)
    {
        var sign = offset < TimeSpan.Zero ? '-' : '+';
        var abs = offset.Duration();
        return $"{sign}{abs.Hours:00}{abs.Minutes:00}{(abs.Seconds != 0 ? abs.Seconds.ToString("00", CultureInfo.InvariantCulture) : "")}";
    }
}
