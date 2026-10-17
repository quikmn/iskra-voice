using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The Suggestions bot: <c>/suggest an idea</c> (or the Suggest button on its prompt card) becomes a card in the
/// suggestions channel with 👍 and 👎 votes (one per person, changeable). Admins and a staff role mark it accepted,
/// declined or implemented, with a reason if they like; the author hears about it privately. With anonymous
/// suggestions on, cards don't name the author, but the server keeps who it was so staff can look it up (audited).
/// </summary>
public static class SuggestionsBot
{
    public const string Id = "suggestions";
    public const int MaxText = 1000;
    public const int MaxReason = 300;
    /// <summary>Suggestions per person per <see cref="WindowMinutes"/>.</summary>
    public const int PerPerson = 3;
    public const int WindowMinutes = 10;
    public static readonly string[] Statuses = ["open", "accepted", "declined", "implemented"];

    private static readonly BuiltinBotFeature.Kind Kind = MoreBuiltinBots.KindOf(Id);

    public static void Register(Router router)
    {
        router.Add("suggestion.create", (s, me, body) =>
        {
            var card = Create(s, me, body.String("text", MaxText * 2));
            return new { messageId = card.MessageId, channelId = card.ChannelId };
        });
        router.Add("suggestion.vote", Vote);
        router.Add("suggestion.decide", Decide);
        router.Add("suggestion.author", Author);
        router.Add("suggestions.prompt", Prompt);
    }

    private static SuggestionsConfig Config(Store store) => MoreBuiltinBots.Config<SuggestionsConfig>(store, Id);

    private static Member RequireOn(Store store) =>
        MoreBuiltinBots.BotIfOn(store, Id) ?? throw RequestException.BadRequest("Suggestions aren't on in this server.", "suggestions_off");

    private static void RequireStaff(Store store, Member me)
    {
        if (!BuiltinBots3.IsStaff(store, me, Config(store).StaffRoleId))
            throw RequestException.Forbidden("Only admins and suggestion staff can do that.", "suggestions_staff");
    }

    // ── The card ─────────────────────────────────────────────────────────────

    private static string StatusWord(string status) => status switch
    {
        "accepted" => "Accepted",
        "declined" => "Declined",
        "implemented" => "Implemented",
        _ => "Open",
    };

    private static (string Text, JsonObject Reply) Card(Store store, Suggestion sg, string botKey)
    {
        var (up, down) = store.SuggestionVotes(sg.MessageId);
        var author = !sg.Anonymous && sg.AuthorKey is { } key && store.GetMember(key) is { } m ? store.DisplayName(m) : null;
        var head = sg.Anonymous ? "💡 Anonymous suggestion" : $"💡 Suggestion from {author ?? "a former member"}";
        var status = StatusWord(sg.Status) + (sg.Reason is { Length: > 0 } r ? $": {FeedService.Defuse(r)}" : "");
        var text = $"{head}\n{FeedService.Defuse(sg.Text)}\n👍 {up} · 👎 {down} · {status}";
        var reply = MoreBuiltinBots.Reply(Id, "suggestion", sg.Anonymous ? botKey : sg.AuthorKey ?? botKey, new
        {
            text = FeedService.Defuse(sg.Text),
            anonymous = sg.Anonymous,
            author = sg.Anonymous ? null : sg.AuthorKey,
            status = sg.Status,
            reason = sg.Reason is null ? null : FeedService.Defuse(sg.Reason),
            decidedBy = sg.DecidedBy,
            up,
            down,
        });
        return (text, reply);
    }

    private static void Refresh(Store store, Hub hub, long messageId)
    {
        if (store.GetSuggestion(messageId) is not { } sg || store.GetChannel(sg.ChannelId) is not { } channel) return;
        if (store.GetMessage(messageId) is not { } message) return;
        var (text, reply) = Card(store, sg, message.AuthorKey);
        MoreBuiltinBots.Rewrite(store, hub, channel, messageId, text, reply);
    }

    /// <summary>Posts a suggestion card for <paramref name="me"/> (checks and limits included).</summary>
    public static Suggestion Create(Session s, Member me, string raw)
    {
        var store = s.World.Store;
        var bot = RequireOn(store);
        if (store.IsBot(me.AccountKey)) throw RequestException.BadRequest("Bots can't make suggestions.", "suggestion_bot");
        var config = Config(store);
        if (MoreBuiltinBots.PostChannel(store, bot, config.ChannelId, s.Now) is not { } channel)
            throw RequestException.BadRequest("Suggestions have no channel yet. Ask an admin to pick one.", "suggestions_channel");
        if (raw.Trim().Length == 0 || Text.Normalize(raw, MaxText, allowNewlines: true) is not { } text)
            throw RequestException.BadRequest($"A suggestion is 1–{MaxText} characters.", "suggestion_text", new { max = MaxText });
        if (store.CountSuggestionsSince(me.AccountKey, s.Now - WindowMinutes * 60_000L) >= PerPerson)
            throw RequestException.BadRequest($"You can make {PerPerson} suggestions every {WindowMinutes} minutes. Try again soon.", "suggestions_slow",
                new { max = PerPerson, minutes = WindowMinutes });
        var draft = new Suggestion(0, channel.Id, me.AccountKey, config.Anonymous, text, "open", null, null, null, s.Now);
        var (cardText, reply) = Card(store, draft, bot.AccountKey);
        var sg = draft;
        BuiltinBots3.PostCard(store, s.Hub, s.Push, bot, channel, cardText, reply, s.Now, m =>
        {
            sg = draft with { MessageId = m.Id };
            store.AddSuggestion(sg);
        });
        return sg;
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object Vote(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (message, _) = BuiltinBots3.Card(s, me, body, Id);
        RequireOn(store);
        var sg = store.GetSuggestion(message.Id) ?? throw RequestException.NotFound("Suggestion");
        if (store.IsBot(me.AccountKey)) throw RequestException.BadRequest("Bots can't vote on suggestions.", "suggestion_bot_vote");
        if (sg.Status != "open") throw RequestException.BadRequest("Voting has ended for this suggestion.", "suggestion_closed");
        var vote = (int)(body.OptionalLong("vote", -1, 1) ?? throw RequestException.BadRequest("'vote' is required."));
        store.SetSuggestionVote(message.Id, me.AccountKey, vote, s.Now);
        Refresh(store, s.Hub, message.Id);
        var (up, down) = store.SuggestionVotes(message.Id);
        return new { vote, up, down };
    }

    private static object Decide(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (message, channel) = BuiltinBots3.Card(s, me, body, Id);
        RequireStaff(store, me);
        var bot = RequireOn(store);
        var sg = store.GetSuggestion(message.Id) ?? throw RequestException.NotFound("Suggestion");
        var status = body.String("status", 16);
        if (!Statuses.Contains(status)) throw RequestException.BadRequest("'status' must be open, accepted, declined or implemented.");
        string? reason = null;
        if (body.OptionalString("reason", MaxReason * 2) is { } raw && raw.Trim().Length > 0)
            reason = Text.Normalize(raw, MaxReason, allowNewlines: false)
                ?? throw RequestException.BadRequest($"Keep the reason to one line of {MaxReason} characters.", "suggestion_reason", new { max = MaxReason });
        Audit.Record(s, "suggestion.decide", sg.Anonymous ? null : sg.AuthorKey, reason, new { messageId = message.Id, status });
        store.DecideSuggestion(message.Id, status, status == "open" ? null : reason, me.AccountKey, s.Now);
        Refresh(store, s.Hub, message.Id);
        // The author hears about it privately (if they're online now; the card says it anyway).
        if (status != "open" && sg.AuthorKey is { } author && author != me.AccountKey && store.GetMember(author) is not null)
            InteractionFeature.PrivateNote(s.Hub, s.Now, bot.AccountKey, author, channel.Id,
                Text.Normalize($"💡 Your suggestion was {status}{(reason is null ? "." : $": {reason}")}", ChatFeature.MaxMessageLength, allowNewlines: false) ?? "💡",
                MoreBuiltinBots.Reply(Id, "suggestion.decided", author, new { messageId = message.Id, status, reason }));
        return new { status, reason };
    }

    private static object Author(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (message, _) = BuiltinBots3.Card(s, me, body, Id);
        RequireStaff(store, me);
        var sg = store.GetSuggestion(message.Id) ?? throw RequestException.NotFound("Suggestion");
        if (sg.Anonymous) Audit.Record(s, "suggestion.author", sg.AuthorKey, details: new { messageId = message.Id });
        return new { accountKey = sg.AuthorKey };
    }

    private static object Prompt(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.Bots)) throw RequestException.Forbidden("Only admins can change built-in bots' settings.", "builtin_bots_config_admin");
        var store = s.World.Store;
        var bot = RequireOn(store);
        if (MoreBuiltinBots.PostChannel(store, bot, Config(store).ChannelId, s.Now) is not { } channel)
            throw RequestException.BadRequest("Suggestions have no channel yet. Ask an admin to pick one.", "suggestions_channel");
        var message = MoreBuiltinBots.Post(store, s.Hub, null, bot, channel, "💡 Got an idea for this server? Use /suggest followed by your idea, or the Suggest button.",
            MoreBuiltinBots.Reply(Id, "suggestion.prompt", me.AccountKey), s.Now);
        return new { messageId = message.Id, channelId = channel.Id };
    }

    // ── /suggest ─────────────────────────────────────────────────────────────

    /// <summary>
    /// <c>/suggest an idea</c>: the card goes to the suggestions channel and the command message is removed (so an
    /// anonymous suggestion stays anonymous, and the channel it was typed in stays tidy). The answer is private.
    /// </summary>
    public static void Command(Session s, Member me, Member bot, Channel channel, Message message, string args)
    {
        if (args.Length == 0)
        {
            BuiltinBotFeature.Private(s, bot, me, channel, "💡 Make a suggestion like this: /suggest Movie night on Fridays", BuiltinBotFeature.Reply(Kind, "suggestion.usage", me));
            return;
        }
        var sg = Create(s, me, args);
        RemoveCommand(s, channel, message);
        var where = s.World.Store.GetChannel(sg.ChannelId)?.Name ?? "";
        BuiltinBotFeature.Private(s, bot, me, channel, $"💡 Thanks! Your suggestion is in #{where}.",
            BuiltinBotFeature.Reply(Kind, "suggestion.posted", me, new { channelId = sg.ChannelId, messageId = sg.MessageId }));
    }

    private static void RemoveCommand(Session s, Channel channel, Message message)
    {
        var store = s.World.Store;
        if (store.GetMessage(message.Id) is null) return;
        StarboardBot.Deleting(s, message);
        store.DeleteMessage(message.Id);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.deleted", new { id = message.Id, channelId = channel.Id }));
        s.Hub.Outhooks?.MessageDeleted(channel, message.Id);
        ThreadFeature.Touched(s, channel);
        ForumFeature.RootDeleted(s, channel, message.Id);
    }
}
