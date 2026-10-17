using System.Text;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The Starboard bot: a message that gets enough of the chosen reaction (⭐ ×3 unless an admin picks otherwise; the
/// author's own and bots' don't count) gets a card in the starboard channel, linking back to it. The card keeps its
/// count and the original's text current, and goes when the original does. A message only gets a card when everyone
/// who can read the starboard can also read where it was posted, so nothing leaks from a more private channel.
/// </summary>
public static class StarboardBot
{
    public const string Id = "starboard";
    public const int MaxExcerpt = 300;
    private static readonly object Gate = new(); // two stars at once must not make two cards

    /// <summary>After a reaction was added or taken back.</summary>
    public static void Reacted(Session s, Channel channel, Message message) => Update(s.World.Store, s.Hub, channel, message, s.Now, edited: false);

    /// <summary>After the original was edited (<paramref name="message"/> has the new text).</summary>
    public static void Edited(Session s, Channel channel, Message message) => Update(s.World.Store, s.Hub, channel, message, s.Now, edited: true);

    /// <summary>Before the original is deleted: its card goes too, and readers of the starboard hear of it.</summary>
    public static void Deleting(Session s, Message message)
    {
        var store = s.World.Store;
        lock (Gate)
        {
            if (store.GetStarboardCard(message.Id) is not { } card) return;
            store.DeleteStarboardCard(message.Id);
            if (card.CardId is not { } cardId || store.GetChannel(card.BoardChannelId) is not { } board) return;
            store.DeleteMessage(cardId);
            s.Hub.BroadcastToReaders(board, Frames.Event("chat.deleted", new { id = cardId, channelId = board.Id }));
        }
    }

    /// <summary>How many people reacted with the emoji, not counting the author or bots.</summary>
    public static int Count(Store store, Message message, string emoji) =>
        store.Reactions(message.Id).Where(r => r.Emoji == emoji).SelectMany(r => r.Accounts)
            .Distinct(StringComparer.Ordinal).Count(k => k != message.AuthorKey && !store.IsBot(k));

    /// <summary>
    /// Whether a message from <paramref name="source"/> may go on <paramref name="board"/>: the bot can see it, it isn't
    /// encrypted, and everyone who can read the board can read the source (its level is no higher, no role is kept out
    /// of it, and every role let into the board is let into it too). Threads count as their parent channel.
    /// </summary>
    public static bool MayFeature(Store store, Member bot, Channel source, Channel board)
    {
        if (source.Kind is not ("text" or "thread" or "voice" or "stage") || source.Id == board.Id) return false;
        var parent = source.Kind == "thread" && store.GetThread(source.Id) is { } thread ? store.GetChannel(thread.ParentId) : source;
        if (parent is null || E2eeChannelFeature.IsEncrypted(store, parent) || E2eeChannelFeature.IsEncrypted(store, source)) return false;
        if (!Permissions.CanRead(bot, parent) || !Permissions.CanRead(bot, source)) return false;
        if (parent.Overrides.Any(o => o.Deny.HasFlag(ChannelPerm.View))) return false;
        if (Roles.Rank(parent.ReadRole) > Roles.Rank(board.ReadRole)) return false;
        foreach (var let in board.Overrides.Where(o => o.Allow.HasFlag(ChannelPerm.View)))
            if (parent.ReadRole != Roles.Guest && !parent.Overrides.Any(o => o.RoleId == let.RoleId && o.Allow.HasFlag(ChannelPerm.View))) return false;
        return true;
    }

    private static void Update(Store store, Hub hub, Channel channel, Message message, long now, bool edited)
    {
        if (MoreBuiltinBots.BotIfOn(store, Id) is not { } bot) return;
        if (store.IsBot(message.AuthorKey)) return; // bots' messages (the cards too) never go on the board
        var config = MoreBuiltinBots.Config<StarboardConfig>(store, Id);
        lock (Gate)
        {
            var existing = store.GetStarboardCard(message.Id);
            var count = Count(store, message, config.Emoji);
            if (existing is not null)
            {
                // A card stays once made (also below the threshold), showing the current count; one a moderator deleted stays gone.
                if (existing.CardId is not { } cardId || (count == existing.Count && !edited)) return;
                if (store.GetChannel(existing.BoardChannelId) is not { } oldBoard) return;
                if (!MayFeature(store, bot, channel, oldBoard)) return; // the source became more private: nothing new reaches the board
                store.SaveStarboardCard(existing with { Count = count });
                var (text, reply) = Card(store, channel, message, config.Emoji, count);
                MoreBuiltinBots.Rewrite(store, hub, oldBoard, cardId, text, reply);
                return;
            }
            if (edited || count < config.Threshold) return;
            if (MoreBuiltinBots.PostChannel(store, bot, config.ChannelId, now) is not { } board) return;
            if (!MayFeature(store, bot, channel, board)) return;
            var (cardText, cardReply) = Card(store, channel, message, config.Emoji, count);
            var card = MoreBuiltinBots.Post(store, hub, null, bot, board, cardText, cardReply, now);
            store.SaveStarboardCard(new StarboardCard(message.Id, card.Id, board.Id, count));
        }
    }

    /// <summary>One line, the newlines folded, cut at <see cref="MaxExcerpt"/>.</summary>
    public static string Excerpt(string text)
    {
        var line = new StringBuilder(Math.Min(text.Length, MaxExcerpt + 1));
        foreach (var c in text)
        {
            if (line.Length > MaxExcerpt) break;
            line.Append(c is '\n' or '\t' ? ' ' : c);
        }
        var s = line.ToString().Trim();
        return s.Length <= MaxExcerpt ? s : s[..(MaxExcerpt - 1)].TrimEnd() + "…";
    }

    private static (string Text, System.Text.Json.Nodes.JsonObject Reply) Card(Store store, Channel channel, Message message, string emoji, int count)
    {
        var author = store.GetMember(message.AuthorKey);
        var name = author is null ? "someone" : store.DisplayName(author);
        var excerpt = Excerpt(message.Text);
        var image = message.Attachments.Select(store.GetFile).OfType<StoredFile>().FirstOrDefault(f => f.Type.StartsWith("image/", StringComparison.Ordinal));
        var text = $"{emoji} {count} · {name} in #{channel.Name}" + (excerpt.Length > 0 ? $": {excerpt}" : "");
        var reply = MoreBuiltinBots.Reply(Id, "star", message.AuthorKey, new
        {
            emoji,
            count,
            channelId = channel.Id,
            channelName = channel.Name,
            messageId = message.Id,
            at = message.CreatedAt,
            excerpt,
            image = image is null ? null : new { url = Files.Uploads.UrlOf(image), width = image.Width, height = image.Height },
        });
        return (text, reply);
    }
}
