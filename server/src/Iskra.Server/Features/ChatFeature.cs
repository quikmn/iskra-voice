using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public static class ChatFeature
{
    public const int MaxMessageLength = 4000;
    public const int MaxHistory = 100;

    public static void Register(Router router)
    {
        router.Add("chat.send", Send);
        router.Add("chat.edit", Edit);
        router.Add("chat.delete", Delete);
        router.Add("chat.history", History);
        router.Add("chat.typing", Typing);
        router.Add("chat.react", React);
        router.Add("upload.begin", BeginUpload);
    }

    public const int MaxAttachments = 10;
    public const int MaxReactionsPerMessage = 20;

    /// <summary>
    /// Channels the member can't read are reported as not found, so their existence doesn't leak.
    /// </summary>
    internal static Channel ReadableChannel(Session s, Member me, long id)
    {
        var channel = s.World.Store.GetChannel(id);
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
        return channel;
    }

    private static string MessageText(Body body) =>
        Text.Normalize(body.String("text", MaxMessageLength * 2), MaxMessageLength, allowNewlines: true)
        ?? throw RequestException.BadRequest($"Messages must be 1–{MaxMessageLength} characters.", "message_length", new { max = MaxMessageLength });

    private static object View(Session s, Message m) => MessageViews.Public(s.World.Store, m);

    private static object Send(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind is not ("text" or "thread" or "voice" or "stage")) throw RequestException.BadRequest("You can't send messages to that channel.", "cant_send_there");
        if (!Permissions.CanSend(me, channel)) throw RequestException.Forbidden("You can't send messages in this channel.", "cant_send_here");
        ForumFeature.CheckReply(s, me, channel);
        if (E2eeChannelFeature.Sealed(s, me, channel, body) is { } sealedMsg) return E2eeChannelFeature.Send(s, me, channel, body, sealedMsg);

        // Files must be ones you uploaded yourself.
        var attachments = body.OptionalStringArray("attachments", MaxAttachments, 64);
        foreach (var id in attachments)
        {
            var file = s.World.Store.GetFile(id);
            if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown attachment.");
        }
        var cards = BotCommandFeature.Parse(s, me, body);
        var rawText = body.OptionalString("text", MaxMessageLength * 2) ?? "";
        var text = rawText.Trim().Length == 0 && (attachments.Length > 0 || cards is { Json: not "[]" } || body.OptionalString("sticker", 64) is not null || body.OptionalElement("gif") is not null)
            ? ""
            : Text.Normalize(rawText, MaxMessageLength, allowNewlines: true)
              ?? throw RequestException.BadRequest($"Messages must be 1–{MaxMessageLength} characters.", "message_length", new { max = MaxMessageLength });
        var voice = VoiceMessageFeature.Parse(s, body, attachments, text);
        var sticker = StickerFeature.Parse(s, body, attachments, text);
        var gif = GifFeature.Parse(s, body, attachments, text);

        long? replyTo = body.OptionalLong("replyTo", min: 1);
        if (replyTo is { } replyId && s.World.Store.GetMessage(replyId)?.ChannelId != channel.Id)
            throw RequestException.BadRequest("You can only reply to messages in the same channel.");

        // A retry of a send that already went through (the reply was lost with the connection): same answer, nothing new.
        var nonce = Nonce(body);
        if (nonce is not null && s.World.Store.NonceUsed(me.AccountKey, nonce)) return Repeat(s, me, nonce);
        AutoModFeature.Check(s, me, channel, text, "message");
        ModerationFeature.CheckSlowmode(s, me, channel);

        Message message;
        if (nonce is null) message = s.World.Store.AddMessage(channel.Id, me.AccountKey, text, s.Now, attachments, replyTo);
        else
        {
            var (stored, created) = s.World.Store.AddMessageOnce(nonce, channel.Id, me.AccountKey, text, s.Now, attachments, replyTo);
            if (!created) return Repeat(s, me, nonce);
            message = stored!;
        }
        VoiceMessageFeature.Saved(s.World.Store, message, voice);
        if (sticker is not null) s.World.Store.SetMessageSticker(message.Id, sticker);
        GifFeature.Saved(s.World.Store, message, gif);
        BotCommandFeature.Saved(s.World.Store, message.Id, cards);
        var publicMessage = View(s, message);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = publicMessage, nonce }));
        ThreadFeature.Touched(s, channel);
        s.Push.ChatMessage(channel, message);
        s.Hub.Outhooks?.MessageCreated(channel, message);
        InboxFeature.Record(s, channel, message);
        BuiltinBotFeature.Heard(s, me, channel, message);
        return new { message = publicMessage, nonce };
    }

    public const int MinNonceLength = 8;
    public const int MaxNonceLength = 64;

    internal static string? Nonce(Body body)
    {
        var nonce = body.OptionalString("nonce", MaxNonceLength);
        if (nonce is null) return null;
        if (nonce.Length < MinNonceLength || !nonce.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            throw RequestException.BadRequest($"'nonce' must be {MinNonceLength}–{MaxNonceLength} characters of a–z, A–Z, 0–9, - and _.");
        return nonce;
    }

    internal static object Repeat(Session s, Member me, string nonce) =>
        s.World.Store.MessageForNonce(me.AccountKey, nonce) is { } earlier
            ? new { message = View(s, earlier), nonce }
            : throw RequestException.NotFound("Message"); // sent, then deleted

    private static object Edit(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        var channel = ReadableChannel(s, me, message.ChannelId);
        if (message.AuthorKey != me.AccountKey) throw RequestException.Forbidden("You can only edit your own messages.", "own_messages_edit");
        if (E2eeChannelFeature.Sealed(s, me, channel, body) is { } sealedMsg) return E2eeChannelFeature.Edit(s, channel, message, sealedMsg);
        if (s.World.Store.GetPoll(message.Id) is not null) throw RequestException.BadRequest("Polls can't be edited.", "poll_no_edit");
        if (VoiceMessageFeature.IsVoice(s.World.Store, message.Id)) throw RequestException.BadRequest("Voice messages can't be edited.");
        ClipFeature.CheckEdit(s.World.Store, message);
        if (s.World.Store.GetMessageSticker(message.Id) is not null) throw RequestException.BadRequest("Stickers can't be edited.", "sticker_no_edit");
        if (s.World.Store.GetMessageGif(message.Id) is not null) throw RequestException.BadRequest("GIFs can't be edited.", "gif_no_edit");

        // Bots may replace their cards; with cards the text may be empty.
        var cards = BotCommandFeature.Parse(s, me, body);
        var hasCards = cards is { Json: not "[]" } || (cards is null && s.World.Store.GetMessageCards(message.Id) is not null);
        var text = hasCards && (body.OptionalString("text", MaxMessageLength * 2) ?? "").Trim().Length == 0 ? "" : MessageText(body);
        AutoModFeature.Check(s, me, channel, text, "edit");
        if (text != message.Text) EditHistoryFeature.Record(s.World.Store, message);
        s.World.Store.EditMessage(message.Id, text, s.Now);
        if (cards is { } newCards) s.World.Store.SetMessageCards(message.Id, newCards.Json == "[]" ? null : newCards.Json, newCards.Files);
        var edited = View(s, message with { Text = text, EditedAt = s.Now });
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.edited", new { message = edited }));
        ForumFeature.Edited(s, channel, message);
        return new { message = edited };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        var channel = ReadableChannel(s, me, message.ChannelId);
        var author = s.World.Store.GetMember(message.AuthorKey);
        if (!Permissions.CanDeleteMessage(me, message, author)) throw RequestException.Forbidden();
        ClipFeature.CheckDelete(s.World.Store, me, message);
        if (message.AuthorKey != me.AccountKey)
            Audit.Record(s, "message.delete", author?.AccountKey,
                details: new { channelId = channel.Id, channelName = channel.Name, messageId = message.Id, author = message.AuthorKey });

        s.World.Store.DeleteMessage(message.Id);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.deleted", new { id = message.Id, channelId = channel.Id }));
        ThreadFeature.Touched(s, channel);
        ForumFeature.RootDeleted(s, channel, message.Id);
        return null;
    }

    private static object History(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        var before = body.OptionalLong("before", min: 0);
        var after = body.OptionalLong("after", min: 0);
        var around = body.OptionalLong("around", min: 1);
        if (new[] { before, after, around }.Count(x => x is not null) > 1)
            throw RequestException.BadRequest("Use one of 'before', 'after' or 'around'.");
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxHistory) ?? 50);
        if (around is not null) return SearchFeature.Around(s, channel, around.Value, limit);

        var messages = s.World.Store.History(channel.Id, before, after, limit);
        return new { messages = messages.Select(m => View(s, m)), hasMore = messages.Count == limit };
    }

    private static object? React(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        var channel = ReadableChannel(s, me, message.ChannelId);
        var emoji = EmojiFeature.Reaction(s.World.Store, body.String("emoji", 64))
            ?? throw RequestException.BadRequest("That isn't a valid reaction.");
        var on = body.OptionalBool("on") ?? true;

        var reactions = s.World.Store.Reactions(message.Id);
        if (on && !reactions.Any(r => r.Emoji == emoji) && reactions.Count >= MaxReactionsPerMessage)
            throw RequestException.BadRequest("This message has too many different reactions.", "reactions_full");
        var had = reactions.Any(r => r.Emoji == emoji && r.Accounts.Contains(me.AccountKey));
        s.World.Store.SetReaction(message.Id, me.AccountKey, emoji, on, s.Now);
        if (on && !had) s.Hub.Outhooks?.ReactionAdded(channel, message, me.AccountKey, emoji);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.reactions",
            new { id = message.Id, channelId = channel.Id, reactions = MessageViews.Reactions(s.World.Store, message.Id) }));
        return null;
    }

    private static object BeginUpload(Session s, Member me, Body body)
    {
        var size = body.OptionalLong("size", min: 1) ?? throw RequestException.BadRequest("'size' is required.");
        if (size > s.Uploads.MaxBytes)
            throw RequestException.BadRequest($"Files can be up to {s.Uploads.MaxBytes / 1024 / 1024} MB on this server.", "file_size", new { mb = s.Uploads.MaxBytes / 1024 / 1024 });
        if (!s.Hub.Limits.TryTake(me.AccountKey, "upload.begin")) throw new RequestException("rate_limited", "Slow down a little.");
        var token = s.Uploads.Issue(me.AccountKey, me.Role, body.OptionalString("name", 512) ?? "file", size)
            ?? throw new RequestException("rate_limited",
                $"You've reached today's upload limit on this server ({s.Uploads.DailyQuota(me.Role)!.Value / 1024 / 1024} MB a day). Try again later.",
                "upload_quota", new { mb = s.Uploads.DailyQuota(me.Role)!.Value / 1024 / 1024 });
        return new { url = $"/upload/{token}", maxBytes = s.Uploads.MaxBytes, partBytes = Files.Uploads.PartBytes };
    }

    private static object? Typing(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        if (!Permissions.CanSend(me, channel)) throw RequestException.Forbidden();
        if (PresenceFeature.Invisible(s.World.Store, me.AccountKey)) return null; // typing would give an invisible member away

        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.typing", new { channelId = channel.Id, accountKey = me.AccountKey }), except: me.AccountKey);
        return null;
    }
}
