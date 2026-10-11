using Iskra.Server.Files;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>How a message looks on the wire: text plus attachments, the message it replies to, and reactions.</summary>
public static class MessageViews
{
    public static object Public(Store store, Message m)
    {
        object? reply = null;
        if (m.ReplyTo is { } replyId)
        {
            var original = store.GetMessage(replyId);
            reply = original is null
                ? new { id = replyId, deleted = true }
                : new { id = original.Id, author = original.AuthorKey, text = Excerpt(original.Text), hasAttachments = original.Attachments.Length > 0 };
        }
        return new
        {
            id = m.Id,
            channelId = m.ChannelId,
            author = m.AuthorKey,
            text = m.Text,
            createdAt = m.CreatedAt,
            editedAt = m.EditedAt,
            attachments = m.Attachments.Select(store.GetFile).OfType<StoredFile>().Select(Uploads.Public),
            replyTo = reply,
            reactions = Reactions(store, m.Id),
            pinned = store.IsPinned(m.Id),
            thread = ThreadFeature.Summary(store, m.Id),
            webhook = WebhookFeature.MessageView(store, m),
            poll = PollFeature.View(store, m.Id),
            voice = VoiceMessageFeature.View(store, m.Id),
            sticker = StickerFeature.View(store, m.Id),
        };
    }

    public static IEnumerable<object> Reactions(Store store, long messageId) =>
        store.Reactions(messageId).Select(r => new { emoji = r.Emoji, accounts = r.Accounts });

    private static string Excerpt(string text) => text.Length <= 140 ? text : text[..140] + "…";
}
