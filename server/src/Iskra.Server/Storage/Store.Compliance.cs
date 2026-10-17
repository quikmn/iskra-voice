using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>One security event (see SecurityLog). Never holds message text, invite codes, passphrases or keys' secrets.</summary>
public sealed record SecurityEvent(long Id, long At, string Event, string? Account, string? Ip, string? Details);

/// <summary>The security log, retention deletes and the rows behind "Download my data".</summary>
public sealed partial class Store
{
    private const string ComplianceMigration = """
        CREATE TABLE security_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            at          INTEGER NOT NULL,
            event       TEXT NOT NULL,
            account_key TEXT,
            ip          TEXT,
            details     TEXT
        );
        CREATE INDEX security_log_by_time ON security_log(at);
        CREATE INDEX security_log_by_account ON security_log(account_key);
        CREATE INDEX IF NOT EXISTS messages_by_time ON messages(created_at);
        CREATE INDEX IF NOT EXISTS dms_by_time ON dms(created_at);
        CREATE INDEX IF NOT EXISTS group_messages_by_time ON group_messages(created_at);
        """;

    // ── Security log ─────────────────────────────────────────────────────────

    public void AddSecurityEvent(long at, string evt, string? account, string? ip, string? details) =>
        Exec("INSERT INTO security_log (at, event, account_key, ip, details) VALUES ($at, $e, $a, $ip, $d);",
            ("$at", at), ("$e", evt), ("$a", account), ("$ip", ip), ("$d", details));

    /// <summary>Newest first.</summary>
    public List<SecurityEvent> SecurityEvents(string? evt, string? account, long? before, int limit) =>
        Query("""
            SELECT id, at, event, account_key, ip, details FROM security_log
            WHERE ($e IS NULL OR event = $e)
              AND ($a IS NULL OR account_key = $a)
              AND ($before IS NULL OR id < $before)
            ORDER BY id DESC LIMIT $limit;
            """,
            r => new SecurityEvent(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3),
                r.IsDBNull(4) ? null : r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5)),
            ("$e", evt), ("$a", account), ("$before", before), ("$limit", limit));

    public int PruneSecurityLog(long olderThan) => DeleteOlder("security_log", "at", olderThan);

    /// <summary>Whether this device has signed in here before (a new one goes in the security log).</summary>
    public bool HasDevice(string deviceKey) =>
        Scalar("SELECT 1 FROM devices WHERE device_key = $d;", ("$d", deviceKey)) is not null;

    // ── Retention ────────────────────────────────────────────────────────────

    /// <summary>
    /// Deletes up to <paramref name="batch"/> channel messages older than <paramref name="cutoff"/> (reactions, pins, polls and
    /// the search index follow through foreign keys and triggers). Returns (id, channel) of each.
    /// </summary>
    public List<(long Id, long ChannelId)> DeleteMessagesBefore(long cutoff, int batch) =>
        Query("""
            DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at < $cutoff ORDER BY id LIMIT $n)
            RETURNING id, channel_id;
            """, r => (r.GetInt64(0), r.GetInt64(1)), ("$cutoff", cutoff), ("$n", batch));

    /// <summary>End-to-end encrypted DM and group envelopes older than <paramref name="cutoff"/>. Returns how many went.</summary>
    public int DeleteEnvelopesBefore(long cutoff) => DeleteOlder("dms", "created_at", cutoff) + DeleteOlder("group_messages", "created_at", cutoff);

    /// <summary>
    /// File records older than <paramref name="cutoff"/> that only messages, DMs or nothing refer to: avatars, emoji, stickers,
    /// sounds, webhooks, event covers, imported authors and ids in <paramref name="keep"/> stay. Returns the deleted files' hashes.
    /// </summary>
    public List<string> DeleteOldMessageFiles(long cutoff, IReadOnlyCollection<string> keep) =>
        Query("""
            DELETE FROM files
            WHERE created_at < $cutoff
              AND id NOT IN (SELECT value FROM json_each($keep))
              AND id NOT IN (
                SELECT avatar_file FROM profiles WHERE avatar_file IS NOT NULL
                UNION SELECT file_id FROM emojis
                UNION SELECT file_id FROM stickers
                UNION SELECT file_id FROM sounds
                UNION SELECT avatar FROM webhooks WHERE avatar IS NOT NULL
                UNION SELECT avatar FROM webhook_messages WHERE avatar IS NOT NULL
                UNION SELECT image_file FROM events WHERE image_file IS NOT NULL
                UNION SELECT avatar_file FROM imported_authors WHERE avatar_file IS NOT NULL
                UNION SELECT file_id FROM server_images
                UNION SELECT file_id FROM member_avatars)
            RETURNING sha256;
            """, r => r.GetString(0), ("$cutoff", cutoff), ("$keep", JsonSerializer.Serialize(keep)));

    private int DeleteOlder(string table, string column, long cutoff)
    {
        // Table and column names are constants from this file, never input.
        lock (_gate)
        {
            using var cmd = Command($"DELETE FROM {table} WHERE {column} < $t;", [("$t", cutoff)]);
            return cmd.ExecuteNonQuery();
        }
    }

    // ── Export ───────────────────────────────────────────────────────────────

    /// <summary>A member, banned, rotated, deleted or former account this server still has something about, or someone waiting to join.</summary>
    public bool KnowsAccount(string accountKey) =>
        KeyKnown(accountKey) || GetDeletion(accountKey) is not null || GetJoinRequest(accountKey) is not null
        || Scalar("SELECT 1 FROM messages WHERE author_key = $k LIMIT 1;", ("$k", accountKey)) is not null;

    /// <summary>
    /// Writes the rows of <paramref name="sql"/> as a JSON array of objects (column name → value). Runs on the read-only
    /// connection, so a big export doesn't hold up everyone else's writes. The SQL comes from DataExport, never from input.
    /// </summary>
    public void WriteRows(Utf8JsonWriter json, string sql, params (string Name, object? Value)[] args)
    {
        lock (_readerGate)
        {
            using var cmd = Reader().CreateCommand();
            cmd.CommandText = sql;
            foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
            using var reader = cmd.ExecuteReader();
            json.WriteStartArray();
            while (reader.Read())
            {
                json.WriteStartObject();
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    json.WritePropertyName(reader.GetName(i));
                    WriteValue(json, reader, i);
                }
                json.WriteEndObject();
            }
            json.WriteEndArray();
        }
    }

    private static void WriteValue(Utf8JsonWriter json, SqliteDataReader reader, int i)
    {
        if (reader.IsDBNull(i))
        {
            json.WriteNullValue();
            return;
        }
        switch (reader.GetValue(i))
        {
            case long l: json.WriteNumberValue(l); break;
            case double d: json.WriteNumberValue(d); break;
            case byte[] b: json.WriteBase64StringValue(b); break;
            case var other: json.WriteStringValue(Convert.ToString(other, System.Globalization.CultureInfo.InvariantCulture)); break;
        }
    }
}
