using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Reports to a server's moderators: a message (kept as it was when reported), a person, or messages from an end-to-end
/// encrypted conversation that the reporter chose to share. Moderators see a queue; the reported person never sees a
/// report about them, nor who made it.
/// </summary>
public static class ReportFeature
{
    public static readonly string[] Reasons = ["spam", "harassment", "hate", "sexual", "violence", "self_harm", "illegal", "other"];
    public static readonly string[] Outcomes = ["dismissed", "deleted", "timeout", "kick", "ban", "other"];
    public const int MaxNote = 500;
    public const int MaxResolutionNote = 200;
    public const int MaxSharedMessages = 20;
    public const int MaxSharedText = 2000;
    public const int MaxOpenPerReporter = 20;
    public const int MaxOpen = 2000;
    public static readonly TimeSpan Retention = TimeSpan.FromDays(90);
    private const long ClockSkew = 10 * 60 * 1000;

    public static void Register(Router router)
    {
        router.Add("report.create", Create);
        router.Add("report.list", List);
        router.Add("report.resolve", Resolve);
        router.Add("report.count", (s, me, _) => new { open = OpenFor(s.World.Store, me) });
    }

    /// <summary>Moderators: anyone who can delete others' messages, time out, kick or ban (admins and the owner always).</summary>
    public static bool IsModerator(Member m) =>
        Permissions.Has(m, Perm.ManageMessages) || Permissions.Has(m, Perm.TimeoutMembers)
        || Permissions.Has(m, Perm.KickMembers) || Permissions.Has(m, Perm.BanMembers);

    /// <summary>
    /// A moderator sees a report unless it is about them. A message report also needs the channel to be readable
    /// (a deleted channel: admins only), so a report never shows more than the moderator could read anyway.
    /// </summary>
    public static bool CanSee(Store store, Member m, Report r)
    {
        if (!IsModerator(m) || r.TargetKey == m.AccountKey) return false;
        if (r.ChannelId is not { } channelId) return true;
        var channel = store.GetChannel(channelId);
        return channel is null ? Permissions.IsAdmin(m) : Permissions.CanRead(m, channel);
    }

    public static int OpenFor(Store store, Member m) =>
        IsModerator(m) ? store.ReportsByStatus("open").Count(r => CanSee(store, m, r)) : 0;

    private static string? Note(Body body, string field, int max)
    {
        var raw = body.OptionalString(field, max * 2);
        if (raw is null || raw.Trim().Length == 0) return null;
        return Text.Normalize(raw, max, allowNewlines: true) ?? throw RequestException.BadRequest($"'{field}' can be up to {max} characters.");
    }

    private static object? Create(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var reason = body.String("reason", 16);
        if (!Reasons.Contains(reason)) throw RequestException.BadRequest($"'reason' must be one of: {string.Join(", ", Reasons)}.");
        var note = Note(body, "note", MaxNote);
        var messageId = body.OptionalLong("messageId", min: 1);
        var accountKey = body.OptionalString("accountKey", 64);
        if ((messageId is null) == (accountKey is null)) throw RequestException.BadRequest("Report either 'messageId' or 'accountKey'.");

        Report report;
        if (messageId is { } id)
        {
            var message = store.GetMessage(id) ?? throw RequestException.NotFound("Message");
            var channel = ChatFeature.ReadableChannel(s, me, message.ChannelId);
            // An encrypted channel's message: the reporter may share what they read (moderators are told it can't be checked).
            var encrypted = E2eeChannelFeature.IsEncrypted(store, channel);
            if (body.Has("messages") && !encrypted) throw RequestException.BadRequest("'messages' goes with 'accountKey'.");
            if (message.AuthorKey == me.AccountKey) throw RequestException.BadRequest("You can't report your own message.", "report_own_message");
            if (message.AuthorKey.StartsWith(AutoModFeature.Author, StringComparison.Ordinal))
                throw RequestException.BadRequest("AutoMod alerts can't be reported.", "report_automod");
            report = New(s, me, "message", reason, note, message.AuthorKey) with
            {
                MessageId = message.Id, ChannelId = channel.Id, ChannelName = channel.Name, Text = message.Text,
                Attachments = message.Attachments, MessageAt = message.CreatedAt,
                Dm = encrypted ? SharedMessages(s, me, message.AuthorKey, body) : null,
            };
        }
        else
        {
            if (accountKey == me.AccountKey) throw RequestException.BadRequest("You can't report yourself.", "report_self");
            if (store.GetMember(accountKey!) is null) throw RequestException.NotFound("Member");
            var shared = SharedMessages(s, me, accountKey!, body);
            report = New(s, me, shared is null ? "member" : "dm", reason, note, accountKey!) with { Dm = shared };
        }

        // The same report twice is the same report.
        if (store.OpenReportBy(me.AccountKey, report.Kind, report.TargetKey, report.MessageId) is { } existing)
            return new { id = existing, already = true };
        if (store.OpenReportsBy(me.AccountKey) >= MaxOpenPerReporter)
            throw new RequestException("rate_limited", "You have a lot of open reports here. Wait for the moderators to look at them.", "reports_many_open");
        if (store.OpenReportCount() >= MaxOpen)
            throw new RequestException("rate_limited", "This server has too many open reports right now. Try again later.", "reports_server_full");
        if (!s.Hub.Limits.TryTake(me.AccountKey, "report.create"))
            throw new RequestException("rate_limited", "You're reporting very fast. Wait a few minutes and try again.", "reports_too_fast");

        store.PruneReports(s.Now - (long)Retention.TotalMilliseconds);
        var reportId = store.AddReport(report);
        CountsChanged(s);
        return new { id = reportId, already = false };
    }

    private static Report New(Session s, Member me, string kind, string reason, string? note, string target) =>
        new(0, s.Now, kind, reason, note, me.AccountKey, me.Name, target, NameOf(s.World.Store, target), null, null, null, null, [], null, null,
            "open", null, null, null, null, null);

    private static string NameOf(Store store, string key) =>
        store.GetMember(key)?.Name ?? ImportFeature.AuthorName(store, key) ?? "";

    /// <summary>
    /// Messages from an encrypted conversation, shared by the reporter (the server can't check them: moderators are told so).
    /// Each is written by the reporter or the reported person.
    /// </summary>
    private static string? SharedMessages(Session s, Member me, string target, Body body)
    {
        if (body.OptionalElement("messages") is not { } raw) return null;
        if (raw.ValueKind != JsonValueKind.Array || raw.GetArrayLength() is 0 or > MaxSharedMessages)
            throw RequestException.BadRequest($"'messages' must have 1–{MaxSharedMessages} items.");
        var list = new List<object>();
        foreach (var item in raw.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each message must be an object.");
            var m = new Body(item);
            var author = m.String("author", 64);
            if (author != me.AccountKey && author != target) throw RequestException.BadRequest("Shared messages must be from you or the person you report.", "report_shared");
            var text = Text.Normalize(m.OptionalString("text", MaxSharedText * 2), MaxSharedText, allowNewlines: true)
                ?? throw RequestException.BadRequest($"Shared messages must be 1–{MaxSharedText} characters.", "report_shared_length", new { max = MaxSharedText });
            var at = m.OptionalLong("at", 0, s.Now + ClockSkew) ?? throw RequestException.BadRequest("'at' is required.");
            list.Add(new { author, text, at });
        }
        return JsonSerializer.Serialize(list, Json.Options);
    }

    private static object List(Session s, Member me, Body body)
    {
        if (!IsModerator(me)) throw RequestException.Forbidden("Only moderators can see reports.", "mods_reports");
        var status = body.OptionalString("status", 16) ?? "open";
        if (status is not ("open" or "resolved")) throw RequestException.BadRequest("'status' must be open or resolved.");
        var before = body.OptionalLong("before", min: 1);
        var limit = (int)(body.OptionalLong("limit", min: 1, max: 50) ?? 50);
        var store = s.World.Store;
        var visible = store.ReportsByStatus(status).Where(r => (before is null || r.Id < before) && CanSee(store, me, r)).Take(limit + 1).ToList();
        return new { reports = visible.Take(limit).Select(r => View(store, r)), hasMore = visible.Count > limit };
    }

    private static object Resolve(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var report = store.GetReport(body.Long("id"));
        if (report is null || !CanSee(store, me, report)) throw RequestException.NotFound("Report");
        if (report.Status != "open") throw new RequestException("conflict", "Someone already handled this report.", "report_handled");
        var outcome = body.String("outcome", 16);
        if (!Outcomes.Contains(outcome)) throw RequestException.BadRequest($"'outcome' must be one of: {string.Join(", ", Outcomes)}.");
        var note = Note(body, "note", MaxResolutionNote);

        store.ResolveReport(report.Id, me.AccountKey, me.Name, s.Now, outcome, note);
        // Never the reporter: the reported person may be able to read the audit log.
        Audit.Record(s, "report.resolve", report.TargetKey.StartsWith(WebhookFeature.AuthorPrefix, StringComparison.Ordinal) ? null : report.TargetKey,
            note, new { reportId = report.Id, kind = report.Kind, reason = report.Reason, outcome });
        CountsChanged(s);
        return new { report = View(store, store.GetReport(report.Id)!) };
    }

    /// <summary>Tells every online moderator how many open reports they can see.</summary>
    private static void CountsChanged(Session s)
    {
        var store = s.World.Store;
        var open = store.ReportsByStatus("open");
        foreach (var session in s.Hub.Sessions)
        {
            if (session.CurrentMember() is not { } m || !IsModerator(m)) continue;
            session.Send(Frames.Event("report.count", new { open = open.Count(r => CanSee(store, m, r)) }));
        }
    }

    public static object View(Store store, Report r) => new
    {
        id = r.Id, at = r.At, kind = r.Kind, reason = r.Reason, note = r.Note, status = r.Status,
        reporter = r.ReporterKey, reporterName = r.ReporterName, target = r.TargetKey, targetName = r.TargetName,
        message = r.Kind == "message"
            ? new
            {
                id = r.MessageId, channelId = r.ChannelId, channelName = r.ChannelName, text = r.Text ?? "", createdAt = r.MessageAt,
                attachments = r.Attachments.Select(store.GetFile).OfType<StoredFile>().Select(Uploads.Public),
                deleted = r.MessageId is not { } mid || store.GetMessage(mid) is null,
            }
            : null,
        messages = r.Dm is null ? (JsonElement?)null : JsonDocument.Parse(r.Dm).RootElement.Clone(),
        resolution = r.Status == "resolved"
            ? new { by = r.ResolvedBy, byName = r.ResolvedName, at = r.ResolvedAt, outcome = r.Outcome, note = r.ResolutionNote }
            : null,
    };
}
