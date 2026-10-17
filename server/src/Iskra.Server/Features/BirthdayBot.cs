using System.Globalization;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The Birthdays bot: members who want to share theirs give a day and a month (never a year), with /birthday or in their
/// server profile, and the bot wishes them a happy birthday once a year, in the chosen channel at the chosen time of day
/// (in the chosen time zone, else the server's). Only stored for people who opted in; it goes when they leave.
/// </summary>
public static partial class BirthdayBot
{
    public const string Id = "birthdays";
    public const int MaxListed = 20;
    public const int ListDays = 60;

    public static void Register(Router router)
    {
        router.Add("birthday.get", (s, me, _) => new { birthday = View(s.World.Store.GetBirthday(me.AccountKey)) });
        router.Add("birthday.set", Set);
        router.Add("birthday.remove", (s, me, _) =>
        {
            s.World.Store.RemoveBirthday(me.AccountKey);
            return new { birthday = (object?)null };
        });
    }

    private static object? View(Birthday? b) => b is null ? null : new { month = b.Month, day = b.Day };

    private static void Check(int month, int day)
    {
        if (month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(2024, month))
            throw RequestException.BadRequest("That isn't a date.", "birthday_date");
    }

    private static object Set(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        if (MoreBuiltinBots.BotIfOn(store, Id) is null) throw RequestException.BadRequest("Birthdays aren't on in this server.", "birthdays_off");
        if (store.IsBot(me.AccountKey)) throw RequestException.BadRequest("Bots don't have birthdays.", "birthday_bot");
        var month = (int)(body.OptionalLong("month", 1, 12) ?? throw RequestException.BadRequest("'month' is required."));
        var day = (int)(body.OptionalLong("day", 1, 31) ?? throw RequestException.BadRequest("'day' is required."));
        Check(month, day);
        store.SetBirthday(me.AccountKey, month, day, s.Now);
        return new { birthday = new { month, day } };
    }

    // ── /birthday ────────────────────────────────────────────────────────────

    private static readonly string[] Months =
        ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    private static readonly string[] Manader =
        ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

    private static int MonthOf(string word)
    {
        word = word.TrimEnd('.').ToLowerInvariant();
        if (word.Length < 3) return 0;
        for (var i = 0; i < 12; i++)
            if (Months[i].StartsWith(word, StringComparison.Ordinal) || Manader[i].StartsWith(word, StringComparison.Ordinal)) return i + 1;
        return 0;
    }

    [GeneratedRegex(@"^(\d{1,2})(?:st|nd|rd|th|:e|:a)?$", RegexOptions.CultureInvariant)]
    private static partial Regex DayWord();

    [GeneratedRegex(@"^(\d{1,2})[./](\d{1,2})\.?$", RegexOptions.CultureInvariant)]
    private static partial Regex Numeric();

    /// <summary>"14 March", "March 14", "14th of March", "14 mars", "14/3" or "14.3" (day first): the month and day, or null.</summary>
    public static (int Month, int Day)? ParseDate(string text)
    {
        text = text.Trim();
        if (text.Length is 0 or > 40) return null;
        int month = 0, day = 0;
        if (Numeric().Match(text) is { Success: true } n)
        {
            day = int.Parse(n.Groups[1].Value, CultureInfo.InvariantCulture);
            month = int.Parse(n.Groups[2].Value, CultureInfo.InvariantCulture);
        }
        else
        {
            foreach (var word in text.Split([' ', ','], StringSplitOptions.RemoveEmptyEntries))
            {
                if (word is "of" or "den") continue;
                if (DayWord().Match(word) is { Success: true } d && day == 0) day = int.Parse(d.Groups[1].Value, CultureInfo.InvariantCulture);
                else if (MonthOf(word) is > 0 and var m && month == 0) month = m;
                else return null;
            }
        }
        if (month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(2024, month)) return null;
        return (month, day);
    }

    internal static void Command(Session s, Member me, Member bot, Channel channel, string args)
    {
        var store = s.World.Store;
        var kind = MoreBuiltinBots.KindOf(Id);
        var space = args.IndexOf(' ');
        var verb = (space < 0 ? args : args[..space]).ToLowerInvariant();
        var rest = space < 0 ? "" : args[(space + 1)..].Trim();
        if (verb is "ta" && rest.Equals("bort", StringComparison.OrdinalIgnoreCase)) (verb, rest) = ("remove", "");
        switch (verb)
        {
            case "set" or "sätt":
                if (ParseDate(rest) is not var (month, day))
                {
                    Usage();
                    return;
                }
                store.SetBirthday(me.AccountKey, month, day, s.Now);
                BuiltinBotFeature.Private(s, bot, me, channel, $"🎂 Saved: {Months[month - 1][..1].ToUpperInvariant()}{Months[month - 1][1..]} {day}. Only the day and month are kept.",
                    BuiltinBotFeature.Reply(kind, "birthday.set", me, new { month, day }));
                return;
            case "remove" or "delete" or "clear":
                store.RemoveBirthday(me.AccountKey);
                BuiltinBotFeature.Private(s, bot, me, channel, "🎂 Your birthday is removed from this server.", BuiltinBotFeature.Reply(kind, "birthday.removed", me));
                return;
            case "list" or "lista":
            {
                var today = Today(store, s.Time, DateTimeOffset.FromUnixTimeMilliseconds(s.Now));
                var upcoming = Upcoming(store, today);
                var text = upcoming.Count == 0 ? "🎂 No birthdays in the next two months."
                    : "🎂 Coming up: " + string.Join(", ", upcoming.Select(u => $"{u.Name} ({Months[u.Month - 1][..3]} {u.Day})"));
                BuiltinBotFeature.Private(s, bot, me, channel, text.Length <= 1000 ? text : text[..999] + "…", BuiltinBotFeature.Reply(kind, "birthday.list", me,
                    new { upcoming = upcoming.Select(u => new { accountKey = u.AccountKey, month = u.Month, day = u.Day }) }));
                return;
            }
            default:
                Usage();
                return;
        }

        void Usage() => BuiltinBotFeature.Private(s, bot, me, channel, "🎂 Try /birthday set 14 March, /birthday remove or /birthday list (only the day and month, never the year).",
            BuiltinBotFeature.Reply(kind, "birthday.usage", me));
    }

    /// <summary>Birthdays in the next <see cref="ListDays"/> days (today first), at most <see cref="MaxListed"/>.</summary>
    internal static List<(string AccountKey, string Name, int Month, int Day)> Upcoming(Store store, DateOnly today)
    {
        var list = new List<(int InDays, string AccountKey, string Name, int Month, int Day)>();
        foreach (var b in store.AllBirthdays())
        {
            if (store.GetMember(b.AccountKey) is not { } m || store.IsBot(m.AccountKey)) continue;
            var next = NextOccurrence(b.Month, b.Day, today);
            var days = next.DayNumber - today.DayNumber;
            if (days < ListDays) list.Add((days, m.AccountKey, store.DisplayName(m), b.Month, b.Day));
        }
        return list.OrderBy(x => x.InDays).ThenBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase).Take(MaxListed)
            .Select(x => (x.AccountKey, x.Name, x.Month, x.Day)).ToList();
    }

    /// <summary>The day it's celebrated on or after <paramref name="from"/> (29 February: the 28th in other years).</summary>
    internal static DateOnly NextOccurrence(int month, int day, DateOnly from)
    {
        for (var year = from.Year; ; year++)
        {
            var d = month == 2 && day == 29 && !DateTime.IsLeapYear(year) ? 28 : day;
            var date = new DateOnly(year, month, d);
            if (date >= from) return date;
        }
    }

    private static TimeZoneInfo Zone(BirthdayConfig config, TimeProvider time) =>
        config.TimeZone is { } id && TimeZoneInfo.TryFindSystemTimeZoneById(id, out var zone) ? zone : time.LocalTimeZone;

    internal static DateOnly Today(Store store, TimeProvider time, DateTimeOffset at) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, Zone(MoreBuiltinBots.Config<BirthdayConfig>(store, Id), time)).DateTime);

    // ── The greeting ─────────────────────────────────────────────────────────

    /// <summary>
    /// Once the chosen time has come on someone's birthday (in the chosen zone), one greeting for everyone celebrating
    /// today who hasn't had one this year. A server that was off at that time catches up later the same day.
    /// </summary>
    public static void Tick(Store store, Hub hub, PushService? push, TimeProvider time, DateTimeOffset at)
    {
        if (MoreBuiltinBots.BotIfOn(store, Id) is not { } bot) return;
        var config = MoreBuiltinBots.Config<BirthdayConfig>(store, Id);
        var now = at.ToUnixTimeMilliseconds();
        if (MoreBuiltinBots.PostChannel(store, bot, config.ChannelId, now) is not { } channel) return;
        var local = TimeZoneInfo.ConvertTime(at, Zone(config, time));
        var parts = config.Time.Split(':');
        if (parts.Length != 2 || !int.TryParse(parts[0], out var hour) || !int.TryParse(parts[1], out var minute)) (hour, minute) = (9, 0);
        if (local.Hour * 60 + local.Minute < hour * 60 + minute) return;
        var today = DateOnly.FromDateTime(local.DateTime);
        var due = store.AllBirthdays()
            .Where(b => b.LastPostedYear != today.Year && NextOccurrence(b.Month, b.Day, today) == today)
            .Select(b => store.GetMember(b.AccountKey)).OfType<Member>().Where(m => !store.IsBot(m.AccountKey)).Take(MaxListed).ToList();
        if (due.Count == 0) return;
        foreach (var m in due) store.BirthdayPosted(m.AccountKey, today.Year);
        var names = due.Select(store.DisplayName).ToList();
        var who = names.Count == 1 ? names[0] : string.Join(", ", names[..^1]) + " and " + names[^1];
        MoreBuiltinBots.Post(store, hub, push, bot, channel, $"🎂 It's {who}'s birthday today!",
            MoreBuiltinBots.Reply(Id, "birthday", due[0].AccountKey, new { people = due.Select(m => m.AccountKey) }), now);
    }
}
