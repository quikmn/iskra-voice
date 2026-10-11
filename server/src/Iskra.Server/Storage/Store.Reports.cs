namespace Iskra.Server.Storage;

/// <summary>
/// A report to a server's moderators. Message reports keep a copy of the message as it was when reported (text and
/// attachment ids); DM reports keep the decrypted messages the reporter chose to share (JSON), which the server can't check.
/// </summary>
public sealed record Report(long Id, long At, string Kind, string Reason, string? Note, string? ReporterKey, string ReporterName,
    string TargetKey, string TargetName, long? MessageId, long? ChannelId, string? ChannelName, string? Text, string[] Attachments,
    long? MessageAt, string? Dm, string Status, string? ResolvedBy, string? ResolvedName, long? ResolvedAt, string? Outcome, string? ResolutionNote);

public sealed partial class Store
{
    // Account keys follow the naming convention (reporter_key, target_key, resolved_by), so key rotations move them.
    private const string ReportsMigration = """
        CREATE TABLE reports (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            at              INTEGER NOT NULL,
            kind            TEXT NOT NULL,
            reason          TEXT NOT NULL,
            note            TEXT,
            reporter_key    TEXT,
            reporter_name   TEXT NOT NULL,
            target_key      TEXT NOT NULL,
            target_name     TEXT NOT NULL,
            message_id      INTEGER,
            channel_id      INTEGER,
            channel_name    TEXT,
            text            TEXT,
            attachments     TEXT,
            message_at      INTEGER,
            dm              TEXT,
            status          TEXT NOT NULL DEFAULT 'open',
            resolved_by     TEXT,
            resolved_name   TEXT,
            resolved_at     INTEGER,
            outcome         TEXT,
            resolution_note TEXT
        );
        CREATE INDEX reports_by_status ON reports(status, id);
        CREATE INDEX reports_by_reporter ON reports(reporter_key, status);
        """;

    private const string ReportColumns = """
        id, at, kind, reason, note, reporter_key, reporter_name, target_key, target_name, message_id, channel_id, channel_name,
        text, attachments, message_at, dm, status, resolved_by, resolved_name, resolved_at, outcome, resolution_note
        """;

    private static Report ReadReport(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), NullableString(r, 4), NullableString(r, 5), r.GetString(6),
            r.GetString(7), r.GetString(8), NullableLong(r, 9), NullableLong(r, 10), NullableString(r, 11), NullableString(r, 12),
            r.IsDBNull(13) ? [] : System.Text.Json.JsonSerializer.Deserialize<string[]>(r.GetString(13)) ?? [],
            NullableLong(r, 14), NullableString(r, 15), r.GetString(16), NullableString(r, 17), NullableString(r, 18), NullableLong(r, 19),
            NullableString(r, 20), NullableString(r, 21));

    private static string? NullableString(Microsoft.Data.Sqlite.SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);

    public long AddReport(Report report) =>
        Convert.ToInt64(Scalar("""
            INSERT INTO reports (at, kind, reason, note, reporter_key, reporter_name, target_key, target_name, message_id, channel_id,
                                 channel_name, text, attachments, message_at, dm)
            VALUES ($at, $kind, $reason, $note, $rk, $rn, $tk, $tn, $mid, $cid, $cn, $text, $att, $mat, $dm)
            RETURNING id;
            """,
            ("$at", report.At), ("$kind", report.Kind), ("$reason", report.Reason), ("$note", report.Note), ("$rk", report.ReporterKey),
            ("$rn", report.ReporterName), ("$tk", report.TargetKey), ("$tn", report.TargetName), ("$mid", report.MessageId),
            ("$cid", report.ChannelId), ("$cn", report.ChannelName), ("$text", report.Text),
            ("$att", report.Attachments.Length == 0 ? null : System.Text.Json.JsonSerializer.Serialize(report.Attachments)),
            ("$mat", report.MessageAt), ("$dm", report.Dm)));

    public Report? GetReport(long id) =>
        Query($"SELECT {ReportColumns} FROM reports WHERE id = $id;", ReadReport, ("$id", id)).FirstOrDefault();

    /// <summary>Every report with this status, newest first (open reports are capped, resolved ones expire).</summary>
    public List<Report> ReportsByStatus(string status) =>
        Query($"SELECT {ReportColumns} FROM reports WHERE status = $s ORDER BY id DESC;", ReadReport, ("$s", status));

    /// <summary>An open report by this person about this message or person (reports aren't duplicated).</summary>
    public long? OpenReportBy(string reporter, string kind, string target, long? messageId) =>
        Scalar("""
            SELECT id FROM reports WHERE status = 'open' AND reporter_key = $r AND kind = $k AND target_key = $t
              AND (message_id = $m OR (message_id IS NULL AND $m IS NULL)) LIMIT 1;
            """, ("$r", reporter), ("$k", kind), ("$t", target), ("$m", messageId)) is long id ? id : null;

    public int OpenReportsBy(string reporter) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM reports WHERE status = 'open' AND reporter_key = $r;", ("$r", reporter)));

    public int OpenReportCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM reports WHERE status = 'open';"));

    public void ResolveReport(long id, string by, string byName, long at, string outcome, string? note) =>
        Exec("""
            UPDATE reports SET status = 'resolved', resolved_by = $by, resolved_name = $bn, resolved_at = $at, outcome = $o, resolution_note = $n
            WHERE id = $id;
            """, ("$id", id), ("$by", by), ("$bn", byName), ("$at", at), ("$o", outcome), ("$n", note));

    /// <summary>Resolved reports older than the cutoff are deleted (like the audit log).</summary>
    public void PruneReports(long cutoff) =>
        Exec("DELETE FROM reports WHERE status = 'resolved' AND resolved_at < $c;", ("$c", cutoff));

    /// <summary>Files that open or recent reports still show, so the upload sweep keeps them while moderators look.</summary>
    public List<string> ReportFileIds() =>
        Query("SELECT DISTINCT j.value FROM reports r, json_each(r.attachments) j WHERE r.attachments IS NOT NULL;", r => r.GetString(0));
}
