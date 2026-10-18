using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The moderators' tool pack: deleting many messages at once, warnings, private notes about a person, a person's
/// moderation history (from the audit log) and the list of people who left (so a report about someone who's gone
/// can still be acted on). Moderators are the people with the reports power (<see cref="ReportFeature.IsModerator"/>);
/// every request checks that and, where it acts on someone, that they rank below.
/// </summary>
public static class ModPackFeature
{
    public const int MaxBulkDelete = 100;
    public const int MaxNoteLength = 1000;
    public const int MaxNotesPerPerson = 50;
    public const int MaxDeparted = 100;
    public const int MaxHistory = 100;
    public static readonly long[] DeleteWindows = [24 * 3600_000L, 7 * 24 * 3600_000L];
    /// <summary>What a person's history shows: actions that name them as the target.</summary>
    public static readonly string[] HistoryActions =
    [
        "member.warn", "member.timeout", "member.timeout.remove", "member.kick", "member.ban", "member.unban",
        "message.delete", "automod.block", "report.resolve", "join.approve", "member.join",
    ];

    public static void Register(Router router)
    {
        router.Add("chat.delete.bulk", DeleteBulk);
        router.Add("member.warn", Warn);
        router.Add("member.notes.list", ListNotes);
        router.Add("member.notes.add", AddNote);
        router.Add("member.notes.delete", DeleteNote);
        router.Add("member.history", History);
        router.Add("member.departed", Departed);
    }

    private static void RequireModerator(Member me)
    {
        if (!ReportFeature.IsModerator(me)) throw RequestException.Forbidden("Only moderators can do that.", "mods_only");
    }

    // ── Bulk delete ──────────────────────────────────────────────────────────

    /// <summary>
    /// Deletes up to 100 messages of one channel in one go, each checked as `chat.delete` would (your own, or someone
    /// below you with manageMessages), with one audit entry. Ids that are already gone are skipped.
    /// </summary>
    private static object DeleteBulk(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        var element = body.Element("ids");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() is 0 or > MaxBulkDelete)
            throw RequestException.BadRequest($"'ids' must be a list of 1–{MaxBulkDelete} message ids.", "bulk_delete_max", new { max = MaxBulkDelete });
        var ids = element.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id : throw RequestException.BadRequest("'ids' must be a list of ids."))
            .Distinct().ToList();
        if (!Permissions.Has(me, Perm.ManageMessages)) throw RequestException.Forbidden("You can't delete other people's messages here.", "manage_messages");

        var messages = ids.Select(store.GetMessage).OfType<Message>().Where(m => m.ChannelId == channel.Id).ToList();
        var authors = new Dictionary<string, Member?>();
        foreach (var message in messages)
        {
            if (!authors.TryGetValue(message.AuthorKey, out var author)) authors[message.AuthorKey] = author = store.GetMember(message.AuthorKey);
            if (!Permissions.CanDeleteMessage(me, message, author))
                throw RequestException.Forbidden("Some of these messages are from people you don't outrank.", "bulk_delete_rank");
            ClipFeature.CheckDelete(store, me, message);
            RecordingFeature.CheckDelete(store, me, message);
        }
        if (messages.Count == 0) return new { deleted = 0 };

        var deleted = store.DeleteMessages(messages.Select(m => m.Id).ToList());
        Audit.Record(s, "message.delete.bulk", details: new
        {
            channelId = channel.Id, channelName = channel.Name, count = deleted.Count,
            authors = messages.Select(m => m.AuthorKey).Distinct().Select(k => authors[k]?.Name ?? ImportFeature.AuthorName(store, k) ?? "").Where(n => n.Length > 0).Distinct().Take(10),
        });
        foreach (var (id, _) in deleted)
        {
            s.Hub.BroadcastToReaders(channel, Frames.Event("chat.deleted", new { id, channelId = channel.Id }));
            ForumFeature.RootDeleted(s, channel, id);
            s.Hub.Outhooks?.MessageDeleted(channel, id);
        }
        ThreadFeature.Touched(s, channel);
        return new { deleted = deleted.Count };
    }

    /// <summary>
    /// Deletes what the person wrote in the last <paramref name="windowMs"/> everywhere (ban and delete recent messages),
    /// telling each channel's readers. Returns how many went.
    /// </summary>
    internal static int DeleteRecent(Session s, string accountKey, long windowMs)
    {
        var store = s.World.Store;
        var deleted = store.DeleteMessagesByAuthorSince(accountKey, s.Now - windowMs);
        foreach (var group in deleted.GroupBy(d => d.ChannelId))
        {
            if (store.GetChannel(group.Key) is not { } channel) continue;
            foreach (var (id, _) in group)
            {
                s.Hub.BroadcastToReaders(channel, Frames.Event("chat.deleted", new { id, channelId = channel.Id }));
                ForumFeature.RootDeleted(s, channel, id);
                s.Hub.Outhooks?.MessageDeleted(channel, id);
            }
            ThreadFeature.Touched(s, channel);
        }
        return deleted.Count;
    }

    /// <summary>`deleteMessagesMs` on a ban: 24 hours or 7 days, or nothing.</summary>
    internal static long? DeleteWindow(Body body)
    {
        var window = body.OptionalLong("deleteMessagesMs", min: 0);
        if (window is null or 0) return null;
        if (!DeleteWindows.Contains(window.Value)) throw RequestException.BadRequest("'deleteMessagesMs' must be 24 hours or 7 days.", "ban_delete_window");
        return window;
    }

    // ── Warnings ─────────────────────────────────────────────────────────────

    /// <summary>A formal warning: an audit entry with the reason, and a notice to the person (their apps show it).</summary>
    private static object? Warn(Session s, Member me, Body body)
    {
        RequireModerator(me);
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("You can't do that to yourself.", "not_to_self");
        var target = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (!Permissions.Outranks(me, target)) throw RequestException.Forbidden("You can only manage members ranked below you.", "rank_members");
        var reason = Text.Normalize(body.String("reason", MemberFeature.MaxReasonLength * 2), MemberFeature.MaxReasonLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"'reason' must be 1–{MemberFeature.MaxReasonLength} characters.", "warn_reason", new { max = MemberFeature.MaxReasonLength });
        Audit.Record(s, "member.warn", target.AccountKey, reason);
        s.Hub.SendToAccount(target.AccountKey, Frames.Event("member.warned", new { reason, by = me.AccountKey, byName = me.Name, at = s.Now }));
        return null;
    }

    // ── Notes ────────────────────────────────────────────────────────────────

    private static object NoteView(ModNote n) => new { id = n.Id, text = n.Text, author = n.AuthorKey, authorName = n.AuthorName, createdAt = n.CreatedAt };

    private static object ListNotes(Session s, Member me, Body body)
    {
        RequireModerator(me);
        return new { notes = s.World.Store.ModNotes(body.String("accountKey", 64)).Select(NoteView) };
    }

    /// <summary>About anyone, member or not (notes outlive a kick, so a returning troublemaker is recognised).</summary>
    private static object AddNote(Session s, Member me, Body body)
    {
        RequireModerator(me);
        var store = s.World.Store;
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("You can't do that to yourself.", "not_to_self");
        if (store.GetMember(key) is { } target && !Permissions.Outranks(me, target))
            throw RequestException.Forbidden("You can only manage members ranked below you.", "rank_members");
        var text = Text.Normalize(body.String("text", MaxNoteLength * 2), MaxNoteLength, allowNewlines: true)
            ?? throw RequestException.BadRequest($"Notes can be 1–{MaxNoteLength} characters.", "note_length", new { max = MaxNoteLength });
        if (store.CountModNotes(key) >= MaxNotesPerPerson)
            throw RequestException.BadRequest($"Up to {MaxNotesPerPerson} notes per person. Delete an old one first.", "notes_max", new { max = MaxNotesPerPerson });
        var note = store.AddModNote(key, text, me.AccountKey, me.Name, s.Now);
        Audit.Record(s, "member.note.add", key, details: new { noteId = note.Id, name = NameOf(store, key) }); // never the text
        return new { note = NoteView(note) };
    }

    private static object? DeleteNote(Session s, Member me, Body body)
    {
        RequireModerator(me);
        var note = s.World.Store.GetModNote(body.Long("id")) ?? throw RequestException.NotFound("Note");
        if (note.AuthorKey != me.AccountKey && !Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only the note's author or an admin can delete it.", "note_author");
        s.World.Store.DeleteModNote(note.Id);
        Audit.Record(s, "member.note.delete", note.AccountKey, details: new { noteId = note.Id, name = NameOf(s.World.Store, note.AccountKey) });
        return null;
    }

    private static string NameOf(Store store, string key) => store.GetMember(key)?.Name ?? store.GetDeparture(key)?.Name ?? "";

    // ── History and people who left ──────────────────────────────────────────

    private static object History(Session s, Member me, Body body)
    {
        RequireModerator(me);
        var key = body.String("accountKey", 64);
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxHistory) ?? 50);
        return new
        {
            entries = s.World.Store.AuditAbout(key, HistoryActions, limit).Select(e => new
            {
                id = e.Id, at = e.At, action = e.Action, actor = e.Actor, actorName = e.ActorName, target = e.Target, targetName = e.TargetName, reason = e.Reason,
                details = e.Details is null ? (JsonElement?)null : JsonDocument.Parse(e.Details).RootElement.Clone(),
            }),
        };
    }

    private static object Departed(Session s, Member me, Body body)
    {
        RequireModerator(me);
        var store = s.World.Store;
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxDeparted) ?? 50);
        return new
        {
            people = store.Departures(limit).Select(d => new
            {
                accountKey = d.AccountKey, name = d.Name, reason = d.Reason, at = d.At,
                by = d.ByKey, byName = d.ByKey is null ? null : store.GetMember(d.ByKey)?.Name,
                banned = store.IsBanned(d.AccountKey),
            }),
        };
    }
}
