using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Quiet hours: on these days (bit 0 = Sunday) from <see cref="From"/> to <see cref="To"/> (minutes after midnight) in a time zone.</summary>
public sealed record QuietHours(int Days, int From, int To, string TimeZone, bool Mentions);

/// <summary>
/// Keyword alerts, follows and quiet hours, as far as this server needs them. Apps match alert words and follows
/// themselves (they can read encrypted channels and DMs; the server can't). A member who wants alerts while Iskra is
/// closed opts in, and their words and follows are stored here so push can match them (words only in channels that
/// aren't encrypted; a follow needs just the author and the channel). Quiet hours are stored where push is on, so
/// pushes stay silent (or stop) during them.
/// </summary>
public static class AlertFeature
{
    public const int MaxWords = 25;
    public const int MaxWordLength = 50;
    public const int MaxFollows = 50;
    public const int MaxTimeZoneLength = 64;

    public static void Register(Router router)
    {
        router.Add("alerts.get", Get);
        router.Add("alerts.set", Set);
    }

    // ── Wire ─────────────────────────────────────────────────────────────────

    public static object View(AlertSettingsRecord? record) => new
    {
        words = record?.Words ?? [],
        follows = (record?.Follows ?? []).Select(f => new { member = f.Member, role = f.Role, channelId = f.ChannelId }),
        quiet = record?.Quiet is { } quiet ? ParseStored(quiet) : null,
    };

    private static object Get(Session s, Member me, Body body) => new { alerts = View(s.World.Store.GetAlerts(me.AccountKey)) };

    private static object Set(Session s, Member me, Body body)
    {
        var words = CleanWords(body.OptionalStringArray("words", MaxWords, MaxWordLength));
        var follows = ParseFollows(body.OptionalElement("follows"));
        var quiet = body.OptionalElement("quiet") is { } element ? ParseQuiet(new Body(element)) : null;
        var store = s.World.Store;
        store.SaveAlerts(me.AccountKey, words, follows, quiet is null ? null : JsonSerializer.Serialize(quiet, Json.Options), s.Now);
        var alerts = View(store.GetAlerts(me.AccountKey));
        s.Hub.SendToAccount(me.AccountKey, Frames.Event("alerts.updated", new { alerts }));
        return new { alerts };
    }

    /// <summary>Trimmed, inner spaces collapsed, no control characters, no duplicates (ignoring case).</summary>
    public static string[] CleanWords(IEnumerable<string> words)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var clean = new List<string>();
        foreach (var raw in words)
        {
            if (raw.Any(char.IsControl)) throw RequestException.BadRequest("Alert words can't contain control characters.", "alerts_word");
            var word = Regex.Replace(raw.Trim(), @"\s+", " ");
            if (word.Length == 0) continue;
            if (seen.Add(word)) clean.Add(word);
        }
        return [.. clean];
    }

    /// <summary>
    /// Follows from the body: each a person (`member`) or a role (`role`, an id), in one channel (`channelId`) or anywhere
    /// here. Only the shape is checked (people leave, roles and channels go: a stale follow just never matches); the same
    /// follow twice is kept once.
    /// </summary>
    public static FollowRule[] ParseFollows(JsonElement? element)
    {
        if (element is not { } list) return [];
        if (list.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest("'follows' must be a list.");
        if (list.GetArrayLength() > MaxFollows) throw RequestException.BadRequest($"You can follow up to {MaxFollows} people and roles per server.", "alerts_follows", new { max = MaxFollows });
        var seen = new HashSet<FollowRule>();
        var follows = new List<FollowRule>();
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each follow is an object.");
            var body = new Body(item);
            var member = body.OptionalString("member", 64);
            var role = body.OptionalLong("role", min: 1);
            if ((member is null) == (role is null)) throw RequestException.BadRequest("A follow is a person or a role.", "alerts_follow");
            if (member is not null && !Regex.IsMatch(member, "^[A-Za-z0-9_-]{43}$")) throw RequestException.BadRequest("A follow is a person or a role.", "alerts_follow");
            var follow = new FollowRule(member, role, body.OptionalLong("channelId", min: 1));
            if (seen.Add(follow)) follows.Add(follow);
        }
        return [.. follows];
    }

    public static QuietHours ParseQuiet(Body body)
    {
        var days = (int)(body.OptionalLong("days", 1, 127) ?? throw RequestException.BadRequest("Quiet hours need days, a start and an end.", "alerts_quiet"));
        var from = (int)(body.OptionalLong("from", 0, 1439) ?? throw RequestException.BadRequest("Quiet hours need days, a start and an end.", "alerts_quiet"));
        var to = (int)(body.OptionalLong("to", 0, 1439) ?? throw RequestException.BadRequest("Quiet hours need days, a start and an end.", "alerts_quiet"));
        var zone = body.String("timeZone", MaxTimeZoneLength);
        if (Zone(zone) is null) throw RequestException.BadRequest("That time zone isn't known here.", "alerts_time_zone");
        return new QuietHours(days, from, to, zone, body.OptionalBool("mentions") ?? false);
    }

    private static QuietHours? ParseStored(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<QuietHours>(json, Json.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static TimeZoneInfo? Zone(string id) => TimeZoneInfo.TryFindSystemTimeZoneById(id, out var zone) ? zone : null;

    // ── Quiet hours ──────────────────────────────────────────────────────────

    /// <summary>
    /// Is <paramref name="now"/> inside the quiet hours? From and to are wall-clock times in the schedule's time zone;
    /// a stretch that crosses midnight belongs to the day it starts on, and from = to means the whole day.
    /// </summary>
    public static bool Active(QuietHours quiet, DateTimeOffset now)
    {
        if (Zone(quiet.TimeZone) is not { } zone) return false;
        var local = TimeZoneInfo.ConvertTime(now, zone);
        var minute = local.Hour * 60 + local.Minute;
        var today = (int)local.DayOfWeek;
        var yesterday = (today + 6) % 7;
        bool On(int day) => (quiet.Days & (1 << day)) != 0;
        if (quiet.From == quiet.To) return On(today);
        if (quiet.From < quiet.To) return On(today) && minute >= quiet.From && minute < quiet.To;
        return (On(today) && minute >= quiet.From) || (On(yesterday) && minute < quiet.To);
    }

    /// <summary>The member's quiet hours stored here, if any.</summary>
    public static QuietHours? QuietOf(Store store, string accountKey) =>
        store.GetAlerts(accountKey)?.Quiet is { } json ? ParseStored(json) : null;

    // ── Matching ─────────────────────────────────────────────────────────────

    private static readonly ConcurrentDictionary<string, Regex> Patterns = new(StringComparer.Ordinal);

    /// <summary>
    /// One pattern for a list of words: each matched as a whole word or phrase (no letter, digit or underscore right
    /// before or after it), ignoring case. Apps use the same rule.
    /// </summary>
    public static Regex Pattern(string[] words)
    {
        var key = string.Join('\n', words);
        if (Patterns.TryGetValue(key, out var hit)) return hit;
        var alternatives = words.Select(w => string.Join(@"\s+", w.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(Regex.Escape)));
        var pattern = new Regex($@"(?<![\p{{L}}\p{{N}}\p{{M}}_])(?:{string.Join('|', alternatives)})(?![\p{{L}}\p{{N}}\p{{M}}_])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
        if (Patterns.Count > 1000) Patterns.Clear();
        Patterns[key] = pattern;
        return pattern;
    }

    public static bool Matches(string[] words, string text)
    {
        if (words.Length == 0 || text.Length == 0) return false;
        try
        {
            return Pattern(words).IsMatch(text);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }

    /// <summary>
    /// Members whose stored alert words are in a new message (never in encrypted channels: the server can't read them).
    /// Who may read the channel, blocks and the author are checked by the callers, as for mentions.
    /// </summary>
    public static IEnumerable<string> KeywordTargets(Store store, Channel channel, Message message)
    {
        if (message.Text.Length == 0 || store.GetE2ee(channel.Id) is not null) yield break;
        foreach (var record in store.AllAlertWords())
            if (record.AccountKey != message.AuthorKey && Matches(record.Words, message.Text)) yield return record.AccountKey;
    }

    /// <summary>Does one of these follows cover a message by <paramref name="author"/> in <paramref name="channelId"/>? Apps use the same rule.</summary>
    public static bool FollowMatches(IEnumerable<FollowRule> follows, Member author, long channelId) =>
        follows.Any(f => (f.ChannelId is null || f.ChannelId == channelId)
            && (f.Member is not null ? f.Member == author.AccountKey : f.Role is { } role && Array.IndexOf(author.RoleIds, role) >= 0));

    /// <summary>
    /// Members who follow the author (or one of the author's roles) in this channel or anywhere here. Encrypted channels
    /// count too: who posted where isn't secret, only what. Readers, blocks and the author are checked by the callers.
    /// </summary>
    public static IEnumerable<string> FollowTargets(Store store, Channel channel, Message message)
    {
        if (store.GetMember(message.AuthorKey) is not { } author) yield break;
        foreach (var record in store.AllAlertFollows())
            if (record.AccountKey != author.AccountKey && FollowMatches(record.Follows, author, channel.Id)) yield return record.AccountKey;
    }
}
