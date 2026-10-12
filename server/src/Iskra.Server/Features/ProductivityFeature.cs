using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Productivity: edit history, reminders, scheduled messages and the mention inbox. Saved messages need nothing new
/// here: apps keep them in a synced preference, sealed so servers can't read it (see PROTOCOL.md).
/// </summary>
public static class ProductivityFeature
{
    public static void Register(Router router)
    {
        EditHistoryFeature.Register(router);
        ReminderFeature.Register(router);
        ScheduledFeature.Register(router);
        InboxFeature.Register(router);
    }

    /// <summary>base64url of at least a nonce and a tag (40 bytes): something only the account's devices can open.</summary>
    internal static string Sealed(Body body, string name, int maxLength)
    {
        var data = body.String(name, maxLength);
        try
        {
            if (System.Buffers.Text.Base64Url.DecodeFromChars(data).Length >= 40) return data;
        }
        catch (FormatException) { }
        throw RequestException.BadRequest($"'{name}' must be base64url ciphertext.");
    }
}

/// <summary>
/// Earlier versions of edited channel messages. The author and people who can manage messages may read them; a deleted
/// message takes its history with it. DMs and groups can't be edited.
/// </summary>
public static class EditHistoryFeature
{
    /// <summary>Earlier versions kept per message (the oldest go first).</summary>
    public const int MaxVersions = 20;

    public static void Register(Router router) => router.Add("chat.edits", Versions);

    /// <summary>Called right before an edit is stored: keeps the text being replaced.</summary>
    public static void Record(Store store, Message message) =>
        store.AddMessageVersion(message.Id, message.Text, message.EditedAt ?? message.CreatedAt, MaxVersions);

    public static bool CanSee(Member me, Message message) =>
        message.AuthorKey == me.AccountKey || Permissions.Has(me, Perm.ManageMessages);

    private static object Versions(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        ChatFeature.ReadableChannel(s, me, message.ChannelId);
        if (!CanSee(me, message)) throw RequestException.Forbidden("Only the author and moderators can see earlier versions.", "history_author_mods");
        return new
        {
            versions = s.World.Store.MessageVersions(message.Id).Select(v => new { text = v.Text, at = v.WrittenAt }),
        };
    }
}
