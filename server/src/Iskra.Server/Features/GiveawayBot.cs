using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The Giveaways bot: staff start one with <c>/giveaway 1h Steam key</c> (optionally <c>2w</c> for two winners and a
/// role people must have), members enter with the card's Enter button, and when the time is up the server draws the
/// winners fairly (the system's secure random generator, every eligible entrant equally likely) and announces them with
/// a mention. Giveaways are in the database, so a restart doesn't lose them: one that was due while the server was off
/// ends at the next check. Bots and people who left never win.
/// </summary>
public static partial class GiveawayBot
{
    public const string Id = "giveaways";
    public const int MaxPrize = 200;
    public const int MaxWinners = 10;
    public const int MaxOpen = 25;
    public const long MinDurationMs = 60_000;
    public const long MaxDurationMs = 30L * 24 * 60 * 60_000;
    /// <summary>A giveaway can be rerolled this long after it ended; then its entries are deleted.</summary>
    public const int RerollDays = 7;

    private static readonly BuiltinBotFeature.Kind Kind = MoreBuiltinBots.KindOf(Id);

    public static void Register(Router router)
    {
        router.Add("giveaway.enter", Enter);
        router.Add("giveaway.end", (s, me, body) => Staff(s, me, body, "end"));
        router.Add("giveaway.cancel", (s, me, body) => Staff(s, me, body, "cancel"));
        router.Add("giveaway.reroll", (s, me, body) => Staff(s, me, body, "reroll"));
    }

    private static GiveawaysConfig Config(Store store) => MoreBuiltinBots.Config<GiveawaysConfig>(store, Id);

    private static Member RequireOn(Store store) =>
        MoreBuiltinBots.BotIfOn(store, Id) ?? throw RequestException.BadRequest("Giveaways aren't on in this server.", "giveaways_off");

    private static void RequireStaff(Store store, Member me)
    {
        if (!BuiltinBots3.IsStaff(store, me, Config(store).StaffRoleId))
            throw RequestException.Forbidden("Only admins and giveaway staff can do that.", "giveaways_staff");
    }

    // ── The draw ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Up to <paramref name="count"/> different people from <paramref name="pool"/>, each equally likely (a partial
    /// Fisher–Yates shuffle). <paramref name="next"/>(n) returns 0 ≤ i &lt; n: the secure generator on the server, a
    /// seeded one in tests.
    /// </summary>
    public static List<string> Draw(IReadOnlyList<string> pool, int count, Func<int, int>? next = null)
    {
        next ??= RandomNumberGenerator.GetInt32;
        var items = pool.ToArray();
        var take = Math.Min(count, items.Length);
        for (var i = 0; i < take; i++)
        {
            var j = i + next(items.Length - i);
            (items[i], items[j]) = (items[j], items[i]);
        }
        return items.Take(take).ToList();
    }

    /// <summary>Who may win now: entrants who are still members, aren't bots, have the role (if one is needed) and weren't drawn before.</summary>
    public static List<string> Eligible(Store store, Giveaway g) =>
        store.GiveawayEntrants(g.MessageId)
            .Where(k => !g.Drawn.Contains(k) && !store.IsBot(k) && store.GetMember(k) is { } m && (g.RoleId is not { } role || m.RoleIds.Contains(role)))
            .ToList();

    // ── The card ─────────────────────────────────────────────────────────────

    private static string Status(Giveaway g) => g.Cancelled ? "cancelled" : g.EndedAt is null ? "open" : "ended";

    private static (string Text, JsonObject Reply) Card(Store store, Giveaway g)
    {
        var entrants = store.CountGiveawayEntrants(g.MessageId);
        var prize = FeedService.Defuse(g.Prize);
        var role = g.RoleId is { } id ? store.GetRole(id)?.Name : null;
        var names = g.WinnerKeys.Select(k => store.GetMember(k) is { } m ? store.DisplayName(m) : "a former member").ToList();
        var ends = DateTimeOffset.FromUnixTimeMilliseconds(g.EndsAt).ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture);
        var text = Status(g) switch
        {
            "cancelled" => $"🎉 Giveaway (cancelled): {prize}",
            "ended" => $"🎉 Giveaway: {prize}\n" + (names.Count == 0 ? "Ended without a winner." : $"Won by {string.Join(", ", names)}") + $" · {entrants} entered",
            _ => $"🎉 Giveaway: {prize}\n{g.Winners} winner{(g.Winners == 1 ? "" : "s")} · {entrants} entered · ends {ends}"
                + (role is null ? "" : $" · for {role}") + "\nPress Enter to take part.",
        };
        var reply = MoreBuiltinBots.Reply(Id, "giveaway", g.HostKey ?? "", new
        {
            prize,
            winners = g.Winners,
            roleId = g.RoleId,
            endsAt = g.EndsAt,
            endedAt = g.EndedAt,
            entrants,
            status = Status(g),
            winnerKeys = g.WinnerKeys,
        });
        return (text, reply);
    }

    private static void Refresh(Store store, Hub hub, long messageId)
    {
        if (store.GetGiveaway(messageId) is not { } g || store.GetChannel(g.ChannelId) is not { } channel) return;
        var (text, reply) = Card(store, g);
        MoreBuiltinBots.Rewrite(store, hub, channel, messageId, text, reply);
    }

    private static void Announce(Store store, Hub hub, PushService? push, Member bot, Giveaway g, List<string> winners, bool reroll, long now)
    {
        if (store.GetChannel(g.ChannelId) is not { } channel || MoreBuiltinBots.PostChannel(store, bot, channel.Id, now) is null) return;
        var prize = FeedService.Defuse(g.Prize);
        if (winners.Count == 0)
        {
            MoreBuiltinBots.Post(store, hub, null, bot, channel, $"🎉 The giveaway for {prize} ended, but nobody who entered can win.",
                MoreBuiltinBots.Reply(Id, "giveaway.none", g.HostKey ?? "", new { prize, giveawayId = g.MessageId }), now);
            return;
        }
        var mentions = string.Join(", ", winners.Select(k => $"<@{k}>"));
        BuiltinBots3.PostPinging(store, hub, push, bot, channel, $"🎉 Congratulations {mentions}! You won {prize}.",
            MoreBuiltinBots.Reply(Id, "giveaway.won", winners[0], new { prize, winners, giveawayId = g.MessageId, reroll }), now);
    }

    // ── Ending ───────────────────────────────────────────────────────────────

    /// <summary>Draws the winners and announces them (once: a second call for the same giveaway does nothing).</summary>
    public static void End(Store store, Hub hub, PushService? push, Giveaway g, long now, Func<int, int>? next = null)
    {
        if (MoreBuiltinBots.BotIfOn(store, Id) is not { } bot) return; // it ends when the bot is on again
        var winners = Draw(Eligible(store, g), g.Winners, next);
        if (!store.EndGiveaway(g.MessageId, winners, cancelled: false, now)) return;
        Refresh(store, hub, g.MessageId);
        Announce(store, hub, push, bot, store.GetGiveaway(g.MessageId)!, winners, reroll: false, now);
    }

    private static long _nextForget;

    /// <summary>Called every second by the built-in bots' runtime: ends the giveaways that are due, and forgets old entries.</summary>
    public static void Tick(Store store, Hub hub, PushService? push, long now)
    {
        foreach (var g in store.DueGiveaways(now)) End(store, hub, push, g, now);
        if (now >= Interlocked.Read(ref _nextForget))
        {
            Interlocked.Exchange(ref _nextForget, now + 60_000);
            ForgetOld(store, now);
        }
    }

    /// <summary>Entries of giveaways that ended more than <see cref="RerollDays"/> ago are deleted.</summary>
    public static int ForgetOld(Store store, long now) => store.ForgetGiveawayEntries(now - RerollDays * 24L * 60 * 60_000);

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object Enter(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (message, _) = BuiltinBots3.Card(s, me, body, Id);
        RequireOn(store);
        var g = store.GetGiveaway(message.Id) ?? throw RequestException.NotFound("Giveaway");
        var entered = body.OptionalBool("entered") ?? throw RequestException.BadRequest("'entered' is required.");
        if (g.EndedAt is not null || g.EndsAt <= s.Now) throw RequestException.BadRequest("This giveaway has ended.", "giveaway_ended");
        if (store.IsBot(me.AccountKey)) throw RequestException.BadRequest("Bots can't enter giveaways.", "giveaway_bot");
        if (entered && g.RoleId is { } roleId && !me.RoleIds.Contains(roleId))
        {
            var role = store.GetRole(roleId)?.Name ?? "";
            throw RequestException.BadRequest($"Only members with the {role} role can enter.", "giveaway_role", new { role });
        }
        if (store.SetGiveawayEntry(message.Id, me.AccountKey, entered, s.Now)) Refresh(store, s.Hub, message.Id);
        return new { entered, entrants = store.CountGiveawayEntrants(message.Id) };
    }

    private static object Staff(Session s, Member me, Body body, string action)
    {
        var store = s.World.Store;
        var (message, _) = BuiltinBots3.Card(s, me, body, Id);
        var g = store.GetGiveaway(message.Id) ?? throw RequestException.NotFound("Giveaway");
        var count = (int)(body.OptionalLong("count", 1, MaxWinners) ?? 1);
        Act(s, me, g, action, count);
        return new { giveaway = new { messageId = g.MessageId, status = Status(store.GetGiveaway(g.MessageId)!) } };
    }

    /// <summary>End now, cancel or reroll (staff only), from a request or a command.</summary>
    private static void Act(Session s, Member me, Giveaway g, string action, int count)
    {
        var store = s.World.Store;
        RequireStaff(store, me);
        var bot = RequireOn(store);
        switch (action)
        {
            case "end":
                if (g.EndedAt is not null) throw RequestException.BadRequest("This giveaway has ended.", "giveaway_ended");
                Audit.Record(s, "giveaway.end", details: new { messageId = g.MessageId });
                End(store, s.Hub, s.Push, g, s.Now);
                break;
            case "cancel":
                if (g.EndedAt is not null) throw RequestException.BadRequest("This giveaway has ended.", "giveaway_ended");
                Audit.Record(s, "giveaway.cancel", details: new { messageId = g.MessageId });
                if (store.EndGiveaway(g.MessageId, [], cancelled: true, s.Now)) Refresh(store, s.Hub, g.MessageId);
                break;
            default:
            {
                if (g.EndedAt is not { } endedAt || g.Cancelled) throw RequestException.BadRequest("That giveaway hasn't ended yet.", "giveaway_not_ended");
                if (s.Now - endedAt > RerollDays * 24L * 60 * 60_000)
                    throw RequestException.BadRequest($"Giveaways can be rerolled for {RerollDays} days after they end.", "giveaway_reroll_expired", new { days = RerollDays });
                var winners = Draw(Eligible(store, g), count);
                if (winners.Count == 0) throw RequestException.BadRequest("Nobody else who entered can win.", "giveaway_nobody");
                Audit.Record(s, "giveaway.reroll", details: new { messageId = g.MessageId, count = winners.Count });
                store.RerollGiveaway(g.MessageId, winners, [.. g.Drawn, .. winners]);
                Refresh(store, s.Hub, g.MessageId);
                Announce(store, s.Hub, s.Push, bot, store.GetGiveaway(g.MessageId)!, winners, reroll: true, s.Now);
                break;
            }
        }
    }

    // ── /giveaway ────────────────────────────────────────────────────────────

    public sealed record Start(long DurationMs, int Winners, long? RoleId, string Prize);

    [GeneratedRegex(@"^(?:\d{1,5}[mhd])+$", RegexOptions.CultureInvariant)]
    private static partial Regex DurationToken();

    [GeneratedRegex(@"(\d{1,5})([mhd])", RegexOptions.CultureInvariant)]
    private static partial Regex DurationPart();

    [GeneratedRegex(@"^(\d{1,2})w$", RegexOptions.CultureInvariant)]
    private static partial Regex WinnersToken();

    [GeneratedRegex(@"^<@&(\d{1,18})>$", RegexOptions.CultureInvariant)]
    private static partial Regex RoleToken();

    /// <summary>"1h30m 2w &lt;@&amp;4&gt; Steam key": the duration, winners (1 unless given), a role people must have, the prize. Null if it isn't that.</summary>
    public static Start? Parse(string args)
    {
        var tokens = args.Split((char[])[' ', '\t', '\n'], StringSplitOptions.RemoveEmptyEntries).ToList();
        if (tokens.Count < 2 || !DurationToken().IsMatch(tokens[0].ToLowerInvariant())) return null;
        long ms = 0;
        foreach (Match m in DurationPart().Matches(tokens[0].ToLowerInvariant()))
            ms += long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) * (m.Groups[2].Value switch { "m" => 60_000L, "h" => 3_600_000L, _ => 86_400_000L });
        var i = 1;
        var winners = 1;
        long? role = null;
        for (; i < tokens.Count - 1; i++)
        {
            if (WinnersToken().Match(tokens[i].ToLowerInvariant()) is { Success: true } w) winners = int.Parse(w.Groups[1].Value, CultureInfo.InvariantCulture);
            else if (RoleToken().Match(tokens[i]) is { Success: true } r) role = long.Parse(r.Groups[1].Value, CultureInfo.InvariantCulture);
            else break;
        }
        var prize = string.Join(' ', tokens.Skip(i));
        return prize.Length == 0 ? null : new Start(ms, winners, role, prize);
    }

    public static void Command(Session s, Member me, Member bot, Channel channel, string args)
    {
        var store = s.World.Store;
        var first = args.Split(' ', 2)[0].ToLowerInvariant();
        if (first is "end" or "cancel" or "reroll")
        {
            var rest = args.Length > first.Length ? args[first.Length..].Trim() : "";
            var count = 1;
            if (first == "reroll" && rest.Length > 0 && (!int.TryParse(rest, NumberStyles.None, CultureInfo.InvariantCulture, out count) || count is < 1 or > MaxWinners))
                throw RequestException.BadRequest($"Pick 1–{MaxWinners} winners.", "giveaway_winners", new { max = MaxWinners });
            RequireStaff(store, me);
            var g = store.LatestGiveaway(channel.Id, open: first != "reroll")
                ?? throw RequestException.BadRequest("There's no giveaway here to do that with.", "giveaway_none_here");
            Act(s, me, g, first, count);
            return;
        }
        RequireStaff(store, me);
        if (Parse(args) is not { } start)
        {
            BuiltinBotFeature.Private(s, bot, me, channel, "🎉 Start a giveaway like this: /giveaway 1h 2w Steam key (2w: two winners).", BuiltinBotFeature.Reply(Kind, "giveaway.usage", me));
            return;
        }
        if (start.DurationMs < MinDurationMs || start.DurationMs > MaxDurationMs)
            throw RequestException.BadRequest("A giveaway lasts from 1 minute up to 30 days.", "giveaway_duration");
        if (start.Winners is < 1 or > MaxWinners)
            throw RequestException.BadRequest($"Pick 1–{MaxWinners} winners.", "giveaway_winners", new { max = MaxWinners });
        if (start.RoleId is { } roleId && store.GetRole(roleId) is null) throw RequestException.NotFound("Role");
        var prize = Text.Normalize(start.Prize, MaxPrize, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Keep the prize to {MaxPrize} characters.", "giveaway_prize", new { max = MaxPrize });
        if (store.CountOpenGiveaways() >= MaxOpen)
            throw RequestException.BadRequest($"A server can run up to {MaxOpen} giveaways at once.", "giveaways_max", new { max = MaxOpen });
        var draft = new Giveaway(0, channel.Id, me.AccountKey, prize, start.Winners, start.RoleId, s.Now + start.DurationMs, null, false, [], [], s.Now);
        var (text, reply) = Card(store, draft);
        BuiltinBots3.PostCard(store, s.Hub, s.Push, bot, channel, text, reply, s.Now, m => store.AddGiveaway(draft with { MessageId = m.Id }));
        ThreadFeature.Touched(s, channel);
    }
}
