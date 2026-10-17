using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The Counting bot: in the counting channel each number must be the next one, and nobody counts twice in a row. A
/// right number gets ✅; a wrong one, or a second in a row, gets ❌ and the count starts over (with a short line saying
/// so). Other messages are just chat. The best streak shows on the bot's pinned card there. The count is kept by the
/// server (with the message that made it), so editing or deleting a number doesn't change it: the bot says what the
/// next number is instead. There are no points and no ranking of people.
/// </summary>
public static partial class CountingBot
{
    public const string Id = "counting";
    public const int MaxExpression = 40;
    private static readonly object Gate = new();

    private static CountingConfig Config(Store store) => MoreBuiltinBots.Config<CountingConfig>(store, Id);

    // ── Numbers ──────────────────────────────────────────────────────────────

    [GeneratedRegex(@"^\d{1,15}$", RegexOptions.CultureInvariant)]
    private static partial Regex Plain();

    [GeneratedRegex(@"^[0-9+\-*/×÷x() ]+$", RegexOptions.CultureInvariant)]
    private static partial Regex MathChars();

    /// <summary>
    /// The number a message says: plain digits, or with <paramref name="math"/> a sum like <c>(3+4)*2</c> (+ − × ÷ and
    /// brackets; a division must come out whole). Null when the message isn't a count (it's chat), or the sum isn't whole.
    /// </summary>
    public static long? Value(string text, bool math)
    {
        text = text.Trim();
        if (Plain().IsMatch(text)) return long.Parse(text, CultureInfo.InvariantCulture);
        if (!math || text.Length > MaxExpression || !MathChars().IsMatch(text) || !text.Any(char.IsAsciiDigit)) return null;
        try
        {
            var parser = new Expression(text.Replace(" ", "", StringComparison.Ordinal));
            var value = parser.Sum();
            if (!parser.Done || value != decimal.Truncate(value) || value < 0 || value > 999_999_999_999_999m) return null;
            return (long)value;
        }
        catch (Exception e) when (e is FormatException or OverflowException or DivideByZeroException)
        {
            return null;
        }
    }

    /// <summary>A tiny calculator: sums of products of numbers and bracketed sums.</summary>
    private sealed class Expression(string text)
    {
        private int _at;
        public bool Done => _at == text.Length;
        private char Peek => _at < text.Length ? text[_at] : '\0';

        public decimal Sum()
        {
            var value = Product();
            while (Peek is '+' or '-')
            {
                var op = text[_at++];
                value = op == '+' ? value + Product() : value - Product();
            }
            return value;
        }

        private decimal Product()
        {
            var value = Unit();
            while (Peek is '*' or '/' or '×' or '÷' or 'x')
            {
                var op = text[_at++];
                var right = Unit();
                value = op is '/' or '÷' ? value / right : value * right;
            }
            return value;
        }

        private decimal Unit()
        {
            if (Peek == '(')
            {
                _at++;
                var inner = Sum();
                if (Peek != ')') throw new FormatException();
                _at++;
                return inner;
            }
            var start = _at;
            while (char.IsAsciiDigit(Peek)) _at++;
            if (_at == start || _at - start > 15) throw new FormatException();
            return decimal.Parse(text.AsSpan(start, _at - start), CultureInfo.InvariantCulture);
        }
    }

    // ── Counting ─────────────────────────────────────────────────────────────

    /// <summary>Called for every plain channel message (people's, not bots'), after it's stored and sent.</summary>
    public static void Heard(Session s, Member me, Channel channel, Message message)
    {
        if (channel.Kind != "text") return;
        var store = s.World.Store;
        if (MoreBuiltinBots.BotIfOn(store, Id) is not { } bot) return;
        var config = Config(store);
        if (config.ChannelId != channel.Id || store.IsBot(me.AccountKey)) return;
        if (MoreBuiltinBots.PostChannel(store, bot, channel.Id, s.Now) is null) return;
        if (Value(message.Text, config.Math) is not { } said) return; // not a number: just chat
        var name = store.DisplayName(me);
        lock (Gate)
        {
            EnsureCard(store, s.Hub, bot, channel, config, s.Now);
            var state = store.GetCounting(channel.Id);
            var next = state.Current + 1;
            if (state.LastKey != me.AccountKey && said == next)
            {
                var best = next > state.Best;
                state = state with { Current = next, LastKey = me.AccountKey, LastMessageId = message.Id };
                if (best) state = state with { Best = next, BestAt = s.Now };
                store.SaveCounting(state);
                React(store, s.Hub, channel, message, bot.AccountKey, "✅", s.Now);
                if (best) RefreshCard(store, s.Hub, channel, config);
                return;
            }
            React(store, s.Hub, channel, message, bot.AccountKey, "❌", s.Now);
            if (state.Current == 0)
            {
                // Nothing to lose yet: just a private hint.
                BuiltinBotFeature.Private(s, bot, me, channel, "🔢 The count starts at 1.",
                    MoreBuiltinBots.Reply(Id, "counting.start", me.AccountKey));
                return;
            }
            var twice = state.LastKey == me.AccountKey;
            store.SaveCounting(state with { Current = 0, LastKey = null, LastMessageId = null });
            var text = twice
                ? $"❌ {name} counted twice in a row, so the count of {state.Current} starts over. Next is 1."
                : $"❌ {name} said {said}, but the next number was {next}. The count of {state.Current} starts over. Next is 1.";
            MoreBuiltinBots.Post(store, s.Hub, null, bot, channel, text, MoreBuiltinBots.Reply(Id, "counting.broken", me.AccountKey, new
            {
                reason = twice ? "double" : "wrong",
                count = state.Current,
                expected = next,
                said,
                best = state.Best,
            }), s.Now);
        }
    }

    /// <summary>After a message was edited: if it's the last number counted and doesn't say it any more, the bot says what's next.</summary>
    public static void Edited(Session s, Channel channel, Message message) => Changed(s, channel, message, edited: true);

    /// <summary>Before a message is deleted: the same, if it's the last number counted.</summary>
    public static void Deleting(Session s, Channel channel, Message message) => Changed(s, channel, message, edited: false);

    private static void Changed(Session s, Channel channel, Message message, bool edited)
    {
        var store = s.World.Store;
        if (MoreBuiltinBots.BotIfOn(store, Id) is not { } bot) return;
        var config = Config(store);
        if (config.ChannelId != channel.Id || MoreBuiltinBots.PostChannel(store, bot, channel.Id, s.Now) is null) return;
        lock (Gate)
        {
            var state = store.GetCounting(channel.Id);
            if (state.LastMessageId != message.Id || state.Current == 0) return;
            if (edited && Value(message.Text, config.Math) == state.Current) return;
            // The count stays; this message just isn't watched any more (a second edit says nothing new).
            store.SaveCounting(state with { LastMessageId = null });
            var who = store.GetMember(message.AuthorKey) is { } m ? store.DisplayName(m) : "Someone";
            var how = edited ? "edited" : "deleted";
            MoreBuiltinBots.Post(store, s.Hub, null, bot, channel, $"⚠️ {who} {how} their {state.Current}. The count goes on: next is {state.Current + 1}.",
                MoreBuiltinBots.Reply(Id, "counting.changed", message.AuthorKey, new { how, count = state.Current, next = state.Current + 1 }), s.Now);
        }
    }

    private static void React(Store store, Hub hub, Channel channel, Message message, string botKey, string emoji, long now)
    {
        store.SetReaction(message.Id, botKey, emoji, true, now);
        hub.BroadcastToReaders(channel, Frames.Event("chat.reactions",
            new { id = message.Id, channelId = channel.Id, reactions = MessageViews.Reactions(store, message.Id) }));
    }

    // ── The card ─────────────────────────────────────────────────────────────

    private static (string Text, JsonObject Reply) Card(CountingState state, CountingConfig config, string botKey)
    {
        var text = "🔢 Counting: say the next number, one at a time (nobody twice in a row)."
            + (config.Math ? " Simple sums like 3+4 count too." : "") + $"\nBest streak: {state.Best}";
        return (text, MoreBuiltinBots.Reply(Id, "counting.card", botKey, new { best = state.Best, bestAt = state.BestAt, math = config.Math }));
    }

    /// <summary>The counting channel was picked (or the bot turned on, or a setting changed): its card is there, current.</summary>
    internal static void ChannelChosen(Store store, Hub hub, long? channelId, long now)
    {
        if (channelId is null || MoreBuiltinBots.BotIfOn(store, Id) is not { } bot || store.GetChannel(channelId.Value) is not { } channel) return;
        if (MoreBuiltinBots.PostChannel(store, bot, channel.Id, now) is null) return;
        lock (Gate)
        {
            var config = Config(store);
            if (!EnsureCard(store, hub, bot, channel, config, now)) RefreshCard(store, hub, channel, config);
        }
    }

    /// <summary>Posts and pins the card if the channel has none (true if it did).</summary>
    private static bool EnsureCard(Store store, Hub hub, Member bot, Channel channel, CountingConfig config, long now)
    {
        var state = store.GetCounting(channel.Id);
        if (state.CardId is { } id && store.GetMessage(id) is not null) return false;
        var (text, reply) = Card(state, config, bot.AccountKey);
        var card = MoreBuiltinBots.Post(store, hub, null, bot, channel, text, reply, now);
        store.SaveCounting(state with { CardId = card.Id });
        if (store.PinCount(channel.Id) < PinFeature.MaxPins && store.AddPin(card.Id, channel.Id, bot.AccountKey, now))
            hub.BroadcastToReaders(channel, Frames.Event("chat.pinned", new { id = card.Id, channelId = channel.Id, on = true, by = bot.AccountKey, at = now }));
        return true;
    }

    private static void RefreshCard(Store store, Hub hub, Channel channel, CountingConfig config)
    {
        var state = store.GetCounting(channel.Id);
        if (state.CardId is not { } id || store.GetMessage(id) is not { } card) return;
        var (text, reply) = Card(state, config, card.AuthorKey);
        MoreBuiltinBots.Rewrite(store, hub, channel, id, text, reply);
    }
}
