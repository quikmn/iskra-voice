using System.Text.Json;

namespace Iskra.Server.Storage;

/// <summary>A disappearing-messages timer: how long new messages last (seconds, 0 = off), who set it and when.</summary>
public sealed record DisappearTimer(int Seconds, string SetBy, long SetAt);

/// <summary>What one sweep of expired messages took away.</summary>
public sealed record ExpiredSweep(
    List<(long Id, long ChannelId)> Messages,
    List<(long Id, long ParentId, long RootId)> Threads,
    int Envelopes,
    List<string> FileIds);

/// <summary>
/// Disappearing messages: a timer per channel, DM pair and group, and the expiry every message gets when it is stored
/// (<c>expires_at</c>, fixed then; a later timer change only affects new messages). Channel messages are stamped by a
/// trigger, so every way a message enters a channel (bots, webhooks, polls, clips) follows the timer.
/// </summary>
public sealed partial class Store
{
    private const string DisappearMigration = """
        CREATE TABLE channel_disappear (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            seconds     INTEGER NOT NULL,
            set_by      TEXT NOT NULL,
            set_at      INTEGER NOT NULL
        );
        CREATE TABLE dm_disappear (
            first_key   TEXT NOT NULL,
            second_key  TEXT NOT NULL,
            seconds     INTEGER NOT NULL,
            set_by      TEXT NOT NULL,
            set_at      INTEGER NOT NULL
        );
        CREATE INDEX dm_disappear_pair ON dm_disappear(first_key, second_key);
        CREATE TABLE group_disappear (
            group_id    TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
            seconds     INTEGER NOT NULL,
            set_by      TEXT NOT NULL,
            set_at      INTEGER NOT NULL
        );
        CREATE TABLE disappear_notices (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            seconds     INTEGER NOT NULL
        );
        CREATE TABLE disappear_files (
            kind        TEXT NOT NULL,
            message_id  INTEGER NOT NULL,
            file_id     TEXT NOT NULL,
            PRIMARY KEY (kind, message_id, file_id)
        );
        ALTER TABLE messages ADD COLUMN expires_at INTEGER;
        ALTER TABLE dms ADD COLUMN expires_at INTEGER;
        ALTER TABLE group_messages ADD COLUMN expires_at INTEGER;
        CREATE INDEX messages_expiring ON messages(expires_at) WHERE expires_at IS NOT NULL;
        CREATE INDEX dms_expiring ON dms(expires_at) WHERE expires_at IS NOT NULL;
        CREATE INDEX group_messages_expiring ON group_messages(expires_at) WHERE expires_at IS NOT NULL;
        CREATE TRIGGER messages_disappear AFTER INSERT ON messages WHEN NEW.expires_at IS NULL BEGIN
            UPDATE messages SET expires_at = NEW.created_at + 1000 * (
                SELECT seconds FROM channel_disappear
                WHERE channel_id = COALESCE((SELECT parent_id FROM channels WHERE id = NEW.channel_id), NEW.channel_id)
                  AND seconds > 0 AND set_at <= NEW.created_at)
            WHERE id = NEW.id;
        END;
        """;

    private static DisappearTimer ReadTimer(Microsoft.Data.Sqlite.SqliteDataReader r) => new(r.GetInt32(0), r.GetString(1), r.GetInt64(2));

    // ── Timers ───────────────────────────────────────────────────────────────

    public DisappearTimer? ChannelTimer(long channelId) =>
        Query("SELECT seconds, set_by, set_at FROM channel_disappear WHERE channel_id = $c;", ReadTimer, ("$c", channelId)).FirstOrDefault();

    public void SetChannelTimer(long channelId, int seconds, string by, long at) =>
        Exec("""
            INSERT INTO channel_disappear (channel_id, seconds, set_by, set_at) VALUES ($c, $s, $by, $at)
            ON CONFLICT(channel_id) DO UPDATE SET seconds = excluded.seconds, set_by = excluded.set_by, set_at = excluded.set_at;
            """, ("$c", channelId), ("$s", seconds), ("$by", by), ("$at", at));

    /// <summary>Timers of channels (id → timer); callers keep the ones the member can read.</summary>
    public List<(long ChannelId, DisappearTimer Timer)> ChannelTimers() =>
        Query("SELECT channel_id, seconds, set_by, set_at FROM channel_disappear;",
            r => (r.GetInt64(0), new DisappearTimer(r.GetInt32(1), r.GetString(2), r.GetInt64(3))));

    // A pair is stored in either order: key rotation moves keys in place, so the order isn't kept.
    public DisappearTimer? DmTimer(string a, string b) =>
        Query("""
            SELECT seconds, set_by, set_at FROM dm_disappear
            WHERE (first_key = $a AND second_key = $b) OR (first_key = $b AND second_key = $a)
            ORDER BY set_at DESC LIMIT 1;
            """, ReadTimer, ("$a", a), ("$b", b)).FirstOrDefault();

    public void SetDmTimer(string a, string b, int seconds, string by, long at)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            Run(tx, "DELETE FROM dm_disappear WHERE (first_key = $a AND second_key = $b) OR (first_key = $b AND second_key = $a);", ("$a", a), ("$b", b));
            Run(tx, "INSERT INTO dm_disappear (first_key, second_key, seconds, set_by, set_at) VALUES ($a, $b, $s, $by, $at);",
                ("$a", a), ("$b", b), ("$s", seconds), ("$by", by), ("$at", at));
            tx.Commit();
        }
    }

    /// <summary>Timers of this account's DM pairs (the other person → timer, newest per pair).</summary>
    public List<(string Peer, DisappearTimer Timer)> DmTimers(string me) =>
        Query("""
            SELECT CASE WHEN first_key = $me THEN second_key ELSE first_key END AS peer, seconds, set_by, MAX(set_at)
            FROM dm_disappear WHERE first_key = $me OR second_key = $me GROUP BY peer;
            """, r => (r.GetString(0), new DisappearTimer(r.GetInt32(1), r.GetString(2), r.GetInt64(3))), ("$me", me));

    public DisappearTimer? GroupTimer(string groupId) =>
        Query("SELECT seconds, set_by, set_at FROM group_disappear WHERE group_id = $g;", ReadTimer, ("$g", groupId)).FirstOrDefault();

    public void SetGroupTimer(string groupId, int seconds, string by, long at) =>
        Exec("""
            INSERT INTO group_disappear (group_id, seconds, set_by, set_at) VALUES ($g, $s, $by, $at)
            ON CONFLICT(group_id) DO UPDATE SET seconds = excluded.seconds, set_by = excluded.set_by, set_at = excluded.set_at;
            """, ("$g", groupId), ("$s", seconds), ("$by", by), ("$at", at));

    /// <summary>Timers of the groups this account is in.</summary>
    public List<(string GroupId, DisappearTimer Timer)> GroupTimers(string me) =>
        Query("""
            SELECT d.group_id, d.seconds, d.set_by, d.set_at FROM group_disappear d
            JOIN group_members m ON m.group_id = d.group_id WHERE m.account_key = $me;
            """, r => (r.GetString(0), new DisappearTimer(r.GetInt32(1), r.GetString(2), r.GetInt64(3))), ("$me", me));

    // ── Expiry of single messages ────────────────────────────────────────────

    /// <summary>A channel message's expiry, and the timer it announces if it is a timer change line.</summary>
    public (long? ExpiresAt, int? Notice) MessageExpiry(long messageId) =>
        Query("SELECT m.expires_at, n.seconds FROM messages m LEFT JOIN disappear_notices n ON n.message_id = m.id WHERE m.id = $m;",
            r => (NullableLong(r, 0), NullableInt(r, 1)), ("$m", messageId)).FirstOrDefault();

    /// <summary>A timer change line: never expires itself.</summary>
    public void MarkDisappearNotice(long messageId, int seconds)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            Run(tx, "UPDATE messages SET expires_at = NULL WHERE id = $m;", ("$m", messageId));
            Run(tx, "INSERT INTO disappear_notices (message_id, seconds) VALUES ($m, $s);", ("$m", messageId), ("$s", seconds));
            tx.Commit();
        }
    }

    /// <summary>
    /// Sets an expiry of <paramref name="table"/> row <paramref name="id"/> to the earlier of what it has and
    /// <paramref name="expiresAt"/>, and remembers its encrypted files so they go with it. Returns the expiry it has now.
    /// </summary>
    public long? StampExpiry(string kind, long id, long? expiresAt, IEnumerable<string> files)
    {
        // Constants only: the kind picks the table.
        var table = kind switch { "dm" => "dms", "group" => "group_messages", "channel" => "messages", _ => throw new ArgumentException(kind) };
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            if (expiresAt is { } at)
                Run(tx, $"UPDATE {table} SET expires_at = MIN(COALESCE(expires_at, $at), $at) WHERE id = $id;", ("$at", at), ("$id", id));
            long? now;
            using (var read = Command($"SELECT expires_at FROM {table} WHERE id = $id;", [("$id", id)]))
            {
                read.Transaction = tx;
                now = read.ExecuteScalar() is long l ? l : null;
            }
            if (now is not null)
                foreach (var file in files.Distinct())
                    Run(tx, "INSERT OR IGNORE INTO disappear_files (kind, message_id, file_id) VALUES ($k, $m, $f);", ("$k", kind), ("$m", id), ("$f", file));
            tx.Commit();
            return now;
        }
    }

    // ── The sweep ────────────────────────────────────────────────────────────

    /// <summary>
    /// Deletes up to <paramref name="batch"/> channel messages, DMs and group messages whose expiry has passed, with
    /// everything that hangs off them (reactions, pins, polls, edits, search entries through foreign keys and triggers),
    /// and threads started from them. Deleted rows are overwritten on disk (secure_delete). Returns what went, and the
    /// ids of their files for the caller to delete.
    /// </summary>
    public ExpiredSweep DeleteExpired(long now, int batch)
    {
        lock (_gate)
        {
            Exec("PRAGMA secure_delete = ON;");
            try
            {
                using var tx = _db.BeginTransaction();
                List<T> Read<T>(string sql, Func<Microsoft.Data.Sqlite.SqliteDataReader, T> map, params (string, object?)[] args)
                {
                    using var cmd = Command(sql, args);
                    cmd.Transaction = tx;
                    using var r = cmd.ExecuteReader();
                    var rows = new List<T>();
                    while (r.Read()) rows.Add(map(r));
                    return rows;
                }

                var due = Read("SELECT id FROM messages WHERE expires_at <= $now ORDER BY expires_at LIMIT $n;", r => r.GetInt64(0), ("$now", now), ("$n", batch));
                var ids = JsonSerializer.Serialize(due);
                // A thread started from a message that went goes with it (its replies were written later and go soon anyway).
                var threads = Read("""
                    SELECT t.channel_id, c.parent_id, t.root_id FROM threads t JOIN channels c ON c.id = t.channel_id
                    WHERE t.root_id IN (SELECT value FROM json_each($ids));
                    """, r => (r.GetInt64(0), r.GetInt64(1), r.GetInt64(2)), ("$ids", ids));
                var files = new List<string>();
                foreach (var (thread, _, _) in threads)
                {
                    files.AddRange(Read("SELECT j.value FROM messages m, json_each(m.attachments) j WHERE m.channel_id = $t AND m.attachments IS NOT NULL;",
                        r => r.GetString(0), ("$t", thread)));
                    files.AddRange(Read("""
                        SELECT f.file_id FROM disappear_files f JOIN messages m ON m.id = f.message_id WHERE f.kind = 'channel' AND m.channel_id = $t;
                        """, r => r.GetString(0), ("$t", thread)));
                    Run(tx, "DELETE FROM channels WHERE id = $t;", ("$t", thread));
                }
                var messages = Read("""
                    DELETE FROM messages WHERE id IN (SELECT value FROM json_each($ids)) RETURNING id, channel_id, attachments;
                    """, r => (Id: r.GetInt64(0), ChannelId: r.GetInt64(1), Attachments: r.IsDBNull(2) ? null : r.GetString(2)), ("$ids", ids));
                foreach (var m in messages)
                    if (m.Attachments is { } json)
                        files.AddRange(JsonSerializer.Deserialize<string[]>(json) ?? []);

                var dms = Read("DELETE FROM dms WHERE id IN (SELECT id FROM dms WHERE expires_at <= $now LIMIT $n) RETURNING id;",
                    r => r.GetInt64(0), ("$now", now), ("$n", batch));
                var groups = Read("DELETE FROM group_messages WHERE id IN (SELECT id FROM group_messages WHERE expires_at <= $now LIMIT $n) RETURNING id;",
                    r => r.GetInt64(0), ("$now", now), ("$n", batch));

                // Encrypted files of what went (DMs, groups, encrypted channels): they lose their link and access list first,
                // so nothing counts them as in use any more.
                void Gone(string kind, IEnumerable<long> rows)
                {
                    var list = JsonSerializer.Serialize(rows);
                    files.AddRange(Read($"""
                        DELETE FROM disappear_files WHERE kind = '{kind}' AND message_id IN (SELECT value FROM json_each($ids)) RETURNING file_id;
                        """, r => r.GetString(0), ("$ids", list)));
                }
                Gone("dm", dms);
                Gone("group", groups);
                Gone("channel", messages.Select(m => m.Id));
                // Rows of channel messages that went with their thread.
                Run(tx, "DELETE FROM disappear_files WHERE kind = 'channel' AND message_id NOT IN (SELECT id FROM messages);");
                var fileList = JsonSerializer.Serialize(files.Distinct());
                Run(tx, "DELETE FROM dm_file_access WHERE file_id IN (SELECT value FROM json_each($f));", ("$f", fileList));
                Run(tx, "DELETE FROM dm_files WHERE file_id IN (SELECT value FROM json_each($f));", ("$f", fileList));
                tx.Commit();
                if (threads.Count > 0) ChannelsDeleted();
                return new ExpiredSweep(messages.Select(m => (m.Id, m.ChannelId)).ToList(), threads, dms.Count + groups.Count, files.Distinct().ToList());
            }
            finally
            {
                Exec("PRAGMA secure_delete = FAST;");
            }
        }
    }

    /// <summary>
    /// Deletes the file records among <paramref name="ids"/> that nothing else uses (another message, an avatar, emoji,
    /// sticker, sound, webhook, event cover, imported author, a DM, or <paramref name="keep"/>). Returns their hashes.
    /// </summary>
    public List<string> DeleteFilesIfUnused(IReadOnlyCollection<string> ids, IReadOnlyCollection<string> keep) =>
        ids.Count == 0 ? [] : Query("""
            DELETE FROM files
            WHERE id IN (SELECT value FROM json_each($ids))
              AND id NOT IN (SELECT value FROM json_each($keep))
              AND id NOT IN (
                SELECT j.value FROM messages m, json_each(m.attachments) j WHERE m.attachments IS NOT NULL
                UNION SELECT avatar_file FROM profiles WHERE avatar_file IS NOT NULL
                UNION SELECT file_id FROM emojis
                UNION SELECT file_id FROM stickers
                UNION SELECT file_id FROM sounds
                UNION SELECT avatar FROM webhooks WHERE avatar IS NOT NULL
                UNION SELECT avatar FROM webhook_messages WHERE avatar IS NOT NULL
                UNION SELECT image_file FROM events WHERE image_file IS NOT NULL
                UNION SELECT avatar_file FROM imported_authors WHERE avatar_file IS NOT NULL
                UNION SELECT file_id FROM dm_files WHERE message_id IS NOT NULL)
            RETURNING sha256;
            """, r => r.GetString(0), ("$ids", JsonSerializer.Serialize(ids)), ("$keep", JsonSerializer.Serialize(keep)));

    /// <summary>
    /// Backups never hold disappearing messages: takes every message that will disappear (with its threads, reactions, pins
    /// and search entries) and its files out of a snapshot at <paramref name="path"/>, then rebuilds the file so nothing of
    /// them is left in free pages. Returns the content hashes no file record in the snapshot uses any more (the backup
    /// leaves those uploads out).
    /// </summary>
    public static HashSet<string> StripDisappearing(string path)
    {
        using var db = new Microsoft.Data.Sqlite.SqliteConnection(
            new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open();
        void Do(string sql)
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }
        List<string> Strings(string sql)
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = sql;
            using var r = cmd.ExecuteReader();
            var rows = new List<string>();
            while (r.Read()) rows.Add(r.GetString(0));
            return rows;
        }
        Do("PRAGMA foreign_keys = ON;");
        Do("""
            CREATE TEMP TABLE gone_files AS
                SELECT j.value AS id FROM messages m, json_each(m.attachments) j
                WHERE m.attachments IS NOT NULL AND (m.expires_at IS NOT NULL
                    OR m.channel_id IN (SELECT t.channel_id FROM threads t JOIN messages r ON r.id = t.root_id WHERE r.expires_at IS NOT NULL))
                UNION SELECT file_id FROM disappear_files;
            DELETE FROM channels WHERE id IN (SELECT t.channel_id FROM threads t JOIN messages r ON r.id = t.root_id WHERE r.expires_at IS NOT NULL);
            DELETE FROM messages WHERE expires_at IS NOT NULL;
            DELETE FROM dms WHERE expires_at IS NOT NULL;
            DELETE FROM group_messages WHERE expires_at IS NOT NULL;
            DELETE FROM disappear_files;
            DELETE FROM dm_file_access WHERE file_id IN (SELECT id FROM gone_files);
            DELETE FROM dm_files WHERE file_id IN (SELECT id FROM gone_files);
            """);
        var hashes = Strings("""
            DELETE FROM files WHERE id IN (SELECT id FROM gone_files) AND id NOT IN (
                SELECT j.value FROM messages m, json_each(m.attachments) j WHERE m.attachments IS NOT NULL
                UNION SELECT avatar_file FROM profiles WHERE avatar_file IS NOT NULL
                UNION SELECT file_id FROM emojis
                UNION SELECT file_id FROM stickers
                UNION SELECT file_id FROM sounds
                UNION SELECT avatar FROM webhooks WHERE avatar IS NOT NULL
                UNION SELECT avatar FROM webhook_messages WHERE avatar IS NOT NULL
                UNION SELECT image_file FROM events WHERE image_file IS NOT NULL
                UNION SELECT avatar_file FROM imported_authors WHERE avatar_file IS NOT NULL
                UNION SELECT file_id FROM dm_files WHERE message_id IS NOT NULL
                UNION SELECT j.value FROM reports r, json_each(r.attachments) j WHERE r.attachments IS NOT NULL
                UNION SELECT file_id FROM doc_files)
            RETURNING sha256;
            """).ToHashSet();
        hashes.ExceptWith(Strings("SELECT sha256 FROM files;"));
        Do("DROP TABLE gone_files;");
        Do("VACUUM;");
        return hashes;
    }

    /// <summary>
    /// Writes deleted pages back out of the write-ahead log, so expired messages don't linger in iskra.db-wal. Best effort:
    /// a reader holding an old snapshot just means the next sweep finishes it.
    /// </summary>
    public void CheckpointAfterDelete()
    {
        try { Exec("PRAGMA wal_checkpoint(TRUNCATE);"); }
        catch (Microsoft.Data.Sqlite.SqliteException) { /* busy: next time */ }
    }

    /// <summary>
    /// Asks the search index to overwrite deleted entries too (SQLite 3.44+); older SQLite builds keep the default, where
    /// deleted words go when the index merges.
    /// </summary>
    public void SecureSearchDeletes()
    {
        try { Exec("INSERT INTO messages_fts (messages_fts, rank) VALUES ('secure-delete', 1);"); }
        catch (Microsoft.Data.Sqlite.SqliteException) { /* not supported by this SQLite */ }
    }
}
