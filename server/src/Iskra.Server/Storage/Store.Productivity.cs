namespace Iskra.Server.Storage;

/// <summary>An earlier version of an edited message: its text and when that text was written.</summary>
public sealed record MessageVersion(string Text, long WrittenAt);

/// <summary>
/// A reminder. <c>Data</c> is sealed by the owner's devices (what it's about, a note); the server only reads the time,
/// plus the message for reminders about a channel message (null for DMs and groups).
/// </summary>
public sealed record Reminder(long Id, string AccountKey, long DueAt, string Data, long? ChannelId, long? MessageId, long CreatedAt, long? FiredAt);

/// <summary>
/// A message waiting to be sent: plain text for a channel, or an end-to-end encrypted envelope (made when it was
/// scheduled) for a DM or group. Status: pending, sending (being sent now), failed.
/// </summary>
public sealed record ScheduledMessage(long Id, string AccountKey, string Kind, long? ChannelId, string? PeerKey, string? GroupId,
    long? GroupVersion, string? Text, long? ReplyTo, string? Envelope, long SendAt, long CreatedAt, string Status, string? Error);

/// <summary>A channel message that pinged someone: a mention, a reply, a role mention or @everyone/@here.</summary>
public sealed record InboxItem(long MessageId, long ChannelId, string Kind, long CreatedAt);

/// <summary>Edit history, reminders, scheduled messages and the mention inbox.</summary>
public sealed partial class Store
{
    private const string ProductivityMigration = """
        CREATE TABLE message_edits (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            text        TEXT NOT NULL,
            written_at  INTEGER NOT NULL
        );
        CREATE INDEX message_edits_by_message ON message_edits(message_id, id);
        CREATE TABLE reminders (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            account_key TEXT NOT NULL,
            due_at      INTEGER NOT NULL,
            data        TEXT NOT NULL,
            channel_id  INTEGER,
            message_id  INTEGER,
            created_at  INTEGER NOT NULL,
            fired_at    INTEGER
        );
        CREATE INDEX reminders_due ON reminders(due_at) WHERE fired_at IS NULL;
        CREATE INDEX reminders_by_account ON reminders(account_key, due_at);
        CREATE TABLE scheduled_messages (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            account_key   TEXT NOT NULL,
            kind          TEXT NOT NULL,
            channel_id    INTEGER,
            peer_key      TEXT,
            group_id      TEXT,
            group_version INTEGER,
            text          TEXT,
            reply_to      INTEGER,
            envelope      TEXT,
            send_at       INTEGER NOT NULL,
            created_at    INTEGER NOT NULL,
            status        TEXT NOT NULL,
            error         TEXT
        );
        CREATE INDEX scheduled_due ON scheduled_messages(send_at) WHERE status = 'pending';
        CREATE INDEX scheduled_by_account ON scheduled_messages(account_key, send_at);
        CREATE TABLE inbox_items (
            account_key TEXT NOT NULL,
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            channel_id  INTEGER NOT NULL,
            kind        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (account_key, message_id)
        );
        """;

    // ── Edit history ─────────────────────────────────────────────────────────

    /// <summary>Keeps the text a message had before an edit, dropping the oldest beyond <paramref name="keep"/>.</summary>
    public void AddMessageVersion(long messageId, string text, long writtenAt, int keep)
    {
        lock (_gate)
        {
            Exec("INSERT INTO message_edits (message_id, text, written_at) VALUES ($m, $t, $w);", ("$m", messageId), ("$t", text), ("$w", writtenAt));
            Exec("""
                DELETE FROM message_edits WHERE message_id = $m AND id NOT IN
                    (SELECT id FROM message_edits WHERE message_id = $m ORDER BY id DESC LIMIT $keep);
                """, ("$m", messageId), ("$keep", keep));
        }
    }

    /// <summary>Earlier versions, oldest first.</summary>
    public List<MessageVersion> MessageVersions(long messageId) =>
        Query("SELECT text, written_at FROM message_edits WHERE message_id = $m ORDER BY id;",
            r => new MessageVersion(r.GetString(0), r.GetInt64(1)), ("$m", messageId));

    // ── Reminders ────────────────────────────────────────────────────────────

    private const string ReminderColumns = "id, account_key, due_at, data, channel_id, message_id, created_at, fired_at";

    private static Reminder ReadReminder(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetInt64(2), r.GetString(3), NullableLong(r, 4), NullableLong(r, 5), r.GetInt64(6), NullableLong(r, 7));

    public Reminder AddReminder(string accountKey, long dueAt, string data, long? channelId, long? messageId, long now)
    {
        var id = Convert.ToInt64(Scalar("""
            INSERT INTO reminders (account_key, due_at, data, channel_id, message_id, created_at) VALUES ($a, $due, $d, $c, $m, $now) RETURNING id;
            """, ("$a", accountKey), ("$due", dueAt), ("$d", data), ("$c", channelId), ("$m", messageId), ("$now", now)));
        return new Reminder(id, accountKey, dueAt, data, channelId, messageId, now, null);
    }

    public Reminder? GetReminder(long id) =>
        Query($"SELECT {ReminderColumns} FROM reminders WHERE id = $id;", ReadReminder, ("$id", id)).FirstOrDefault();

    public List<Reminder> Reminders(string accountKey) =>
        Query($"SELECT {ReminderColumns} FROM reminders WHERE account_key = $a ORDER BY due_at, id;", ReadReminder, ("$a", accountKey));

    public int CountReminders(string accountKey) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM reminders WHERE account_key = $a;", ("$a", accountKey)));

    public void UpdateReminder(long id, long dueAt, string data) =>
        Exec("UPDATE reminders SET due_at = $due, data = $d, fired_at = NULL WHERE id = $id;", ("$id", id), ("$due", dueAt), ("$d", data));

    public void DeleteReminder(long id) => Exec("DELETE FROM reminders WHERE id = $id;", ("$id", id));

    /// <summary>Reminders whose time has come and that haven't fired yet.</summary>
    public List<Reminder> DueReminders(long now, int limit) =>
        Query($"SELECT {ReminderColumns} FROM reminders WHERE fired_at IS NULL AND due_at <= $now ORDER BY due_at LIMIT $limit;",
            ReadReminder, ("$now", now), ("$limit", limit));

    /// <summary>Marks a reminder fired. False if another tick already did (or it was deleted or moved meanwhile).</summary>
    public bool MarkReminderFired(long id, long dueAt, long now)
    {
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM reminders WHERE id = $id AND fired_at IS NULL AND due_at = $due;", ("$id", id), ("$due", dueAt)) is null) return false;
            Exec("UPDATE reminders SET fired_at = $now WHERE id = $id;", ("$id", id), ("$now", now));
            return true;
        }
    }

    public void PruneReminders(long firedBefore) =>
        Exec("DELETE FROM reminders WHERE fired_at IS NOT NULL AND fired_at < $t;", ("$t", firedBefore));

    // ── Scheduled messages ───────────────────────────────────────────────────

    private const string ScheduledColumns =
        "id, account_key, kind, channel_id, peer_key, group_id, group_version, text, reply_to, envelope, send_at, created_at, status, error";

    private static ScheduledMessage ReadScheduled(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetString(2), NullableLong(r, 3), r.IsDBNull(4) ? null : r.GetString(4),
            r.IsDBNull(5) ? null : r.GetString(5), NullableLong(r, 6), r.IsDBNull(7) ? null : r.GetString(7), NullableLong(r, 8),
            r.IsDBNull(9) ? null : r.GetString(9), r.GetInt64(10), r.GetInt64(11), r.GetString(12), r.IsDBNull(13) ? null : r.GetString(13));

    public ScheduledMessage AddScheduled(ScheduledMessage m)
    {
        var id = Convert.ToInt64(Scalar("""
            INSERT INTO scheduled_messages (account_key, kind, channel_id, peer_key, group_id, group_version, text, reply_to, envelope, send_at, created_at, status)
            VALUES ($a, $kind, $c, $p, $g, $gv, $t, $r, $e, $at, $now, 'pending') RETURNING id;
            """, ("$a", m.AccountKey), ("$kind", m.Kind), ("$c", m.ChannelId), ("$p", m.PeerKey), ("$g", m.GroupId), ("$gv", m.GroupVersion),
            ("$t", m.Text), ("$r", m.ReplyTo), ("$e", m.Envelope), ("$at", m.SendAt), ("$now", m.CreatedAt)));
        return m with { Id = id, Status = "pending", Error = null };
    }

    public ScheduledMessage? GetScheduled(long id) =>
        Query($"SELECT {ScheduledColumns} FROM scheduled_messages WHERE id = $id;", ReadScheduled, ("$id", id)).FirstOrDefault();

    public List<ScheduledMessage> ScheduledOf(string accountKey) =>
        Query($"SELECT {ScheduledColumns} FROM scheduled_messages WHERE account_key = $a ORDER BY send_at, id;", ReadScheduled, ("$a", accountKey));

    public int CountScheduled(string accountKey) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM scheduled_messages WHERE account_key = $a;", ("$a", accountKey)));

    /// <summary>New time and/or content; the message goes back to pending (a failed one gets another try).</summary>
    /// <summary>A new envelope also counts as made now (<paramref name="now"/>), for the 30-day limit.</summary>
    public void UpdateScheduled(long id, long sendAt, string? text, string? envelope, long? groupVersion, long now) =>
        Exec("""
            UPDATE scheduled_messages SET send_at = $at, text = COALESCE($t, text), envelope = COALESCE($e, envelope),
                group_version = COALESCE($gv, group_version), created_at = CASE WHEN $e IS NULL THEN created_at ELSE $now END,
                status = 'pending', error = NULL
            WHERE id = $id AND status <> 'sending';
            """, ("$id", id), ("$at", sendAt), ("$t", text), ("$e", envelope), ("$gv", groupVersion), ("$now", now));

    public void DeleteScheduled(long id) => Exec("DELETE FROM scheduled_messages WHERE id = $id;", ("$id", id));

    public List<ScheduledMessage> DueScheduled(long now, int limit) =>
        Query($"SELECT {ScheduledColumns} FROM scheduled_messages WHERE status = 'pending' AND send_at <= $now ORDER BY send_at, id LIMIT $limit;",
            ReadScheduled, ("$now", now), ("$limit", limit));

    /// <summary>Claims a due message for sending (pending → sending). False if it changed or someone else took it.</summary>
    public bool ClaimScheduled(long id, long sendAt)
    {
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM scheduled_messages WHERE id = $id AND status = 'pending' AND send_at = $at;", ("$id", id), ("$at", sendAt)) is null)
                return false;
            Exec("UPDATE scheduled_messages SET status = 'sending' WHERE id = $id;", ("$id", id));
            return true;
        }
    }

    public void FailScheduled(long id, string error) =>
        Exec("UPDATE scheduled_messages SET status = 'failed', error = $e WHERE id = $id;", ("$id", id), ("$e", error));

    /// <summary>After a restart nothing is mid-send: what was being sent goes back to pending (the send nonce stops doubles).</summary>
    public void ResetSendingScheduled() => Exec("UPDATE scheduled_messages SET status = 'pending' WHERE status = 'sending';");

    // ── Inbox ────────────────────────────────────────────────────────────────

    public void AddInboxItems(long messageId, long channelId, long now, IEnumerable<(string AccountKey, string Kind)> items)
    {
        lock (_gate)
        {
            foreach (var (key, kind) in items)
                Exec("""
                    INSERT INTO inbox_items (account_key, message_id, channel_id, kind, created_at) VALUES ($a, $m, $c, $k, $now)
                    ON CONFLICT DO NOTHING;
                    """, ("$a", key), ("$m", messageId), ("$c", channelId), ("$k", kind), ("$now", now));
        }
    }

    /// <summary>Newest first, before a message id.</summary>
    public List<InboxItem> InboxItems(string accountKey, long? before, int limit) =>
        Query("""
            SELECT message_id, channel_id, kind, created_at FROM inbox_items
            WHERE account_key = $a AND message_id < $before ORDER BY message_id DESC LIMIT $limit;
            """, r => new InboxItem(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetInt64(3)),
            ("$a", accountKey), ("$before", before ?? long.MaxValue), ("$limit", limit));

    /// <summary>Drops old items, and per account everything beyond the newest <paramref name="keep"/>.</summary>
    public void PruneInbox(long olderThan, int keep) =>
        Exec("""
            DELETE FROM inbox_items WHERE created_at < $t;
            DELETE FROM inbox_items WHERE rowid IN (
                SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY account_key ORDER BY message_id DESC) AS n FROM inbox_items) WHERE n > $keep);
            """, ("$t", olderThan), ("$keep", keep));
}
