namespace Iskra.Server.Storage;

/// <summary>A moderator's private note about a person (ModPackFeature). Never shown to the person.</summary>
public sealed record ModNote(long Id, string AccountKey, string Text, string AuthorKey, string AuthorName, long CreatedAt);

/// <summary>Someone who isn't a member any more: how they went (left, kicked, banned, deleted) and their last name here.</summary>
public sealed record Departure(string AccountKey, string Name, string Reason, string? ByKey, long At);

public sealed partial class Store
{
    private const string ModPackMigration = """
        CREATE TABLE mod_notes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            account_key TEXT NOT NULL,
            text        TEXT NOT NULL,
            author_key  TEXT NOT NULL,
            author_name TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX mod_notes_by_account ON mod_notes(account_key, id);
        CREATE TABLE departures (
            account_key TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            reason      TEXT NOT NULL,
            by_key      TEXT,
            at          INTEGER NOT NULL
        );
        """;

    // ── Moderator notes ──────────────────────────────────────────────────────

    private const string ModNoteColumns = "id, account_key, text, author_key, author_name, created_at";

    private static ModNote ReadModNote(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt64(5));

    /// <summary>Newest first.</summary>
    public List<ModNote> ModNotes(string accountKey) =>
        Query($"SELECT {ModNoteColumns} FROM mod_notes WHERE account_key = $a ORDER BY id DESC;", ReadModNote, ("$a", accountKey));

    public ModNote? GetModNote(long id) => Query($"SELECT {ModNoteColumns} FROM mod_notes WHERE id = $id;", ReadModNote, ("$id", id)).FirstOrDefault();

    public int CountModNotes(string accountKey) => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM mod_notes WHERE account_key = $a;", ("$a", accountKey)));

    public ModNote AddModNote(string accountKey, string text, string authorKey, string authorName, long now)
    {
        var id = Convert.ToInt64(Scalar("""
            INSERT INTO mod_notes (account_key, text, author_key, author_name, created_at) VALUES ($a, $t, $by, $bn, $now) RETURNING id;
            """, ("$a", accountKey), ("$t", text), ("$by", authorKey), ("$bn", authorName), ("$now", now)));
        return new ModNote(id, accountKey, text, authorKey, authorName, now);
    }

    public void DeleteModNote(long id) => Exec("DELETE FROM mod_notes WHERE id = $id;", ("$id", id));

    // ── People who left ──────────────────────────────────────────────────────

    public void RecordDeparture(string accountKey, string name, string reason, string? byKey, long now) =>
        Exec("""
            INSERT INTO departures (account_key, name, reason, by_key, at) VALUES ($a, $n, $r, $by, $at)
            ON CONFLICT(account_key) DO UPDATE SET name = excluded.name, reason = excluded.reason, by_key = excluded.by_key, at = excluded.at;
            """, ("$a", accountKey), ("$n", name), ("$r", reason), ("$by", byKey), ("$at", now));

    /// <summary>Newest first, only people who aren't members right now (someone who came back is just a member).</summary>
    public List<Departure> Departures(int limit) =>
        Query("""
            SELECT account_key, name, reason, by_key, at FROM departures
            WHERE account_key NOT IN (SELECT account_key FROM members) ORDER BY at DESC LIMIT $limit;
            """, r => new Departure(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt64(4)), ("$limit", limit));

    public Departure? GetDeparture(string accountKey) =>
        Query("SELECT account_key, name, reason, by_key, at FROM departures WHERE account_key = $a;",
            r => new Departure(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt64(4)), ("$a", accountKey)).FirstOrDefault();

    public void PruneDepartures(long olderThan) => Exec("DELETE FROM departures WHERE at < $t;", ("$t", olderThan));

    // ── Deleting many messages ───────────────────────────────────────────────

    /// <summary>Deletes the given messages (the caller checked each). Returns what went, with their channels.</summary>
    public List<(long Id, long ChannelId)> DeleteMessages(IReadOnlyCollection<long> ids) =>
        Query("DELETE FROM messages WHERE id IN (SELECT value FROM json_each($ids)) RETURNING id, channel_id;",
            r => (r.GetInt64(0), r.GetInt64(1)), ("$ids", System.Text.Json.JsonSerializer.Serialize(ids)));

    /// <summary>Deletes everything the account wrote since <paramref name="since"/> (ban and delete recent messages).</summary>
    public List<(long Id, long ChannelId)> DeleteMessagesByAuthorSince(string accountKey, long since) =>
        Query("DELETE FROM messages WHERE author_key = $a AND created_at >= $since RETURNING id, channel_id;",
            r => (r.GetInt64(0), r.GetInt64(1)), ("$a", accountKey), ("$since", since));

    /// <summary>Audit entries about one person (as the target), limited to the given actions; newest first.</summary>
    public List<AuditEntry> AuditAbout(string accountKey, IReadOnlyCollection<string> actions, int limit) =>
        Query("""
            SELECT id, at, action, actor, actor_name, target, target_name, reason, details FROM audit_log
            WHERE target = $k AND action IN (SELECT value FROM json_each($actions)) ORDER BY id DESC LIMIT $limit;
            """,
            r => new AuditEntry(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetString(4),
                r.IsDBNull(5) ? null : r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6),
                r.IsDBNull(7) ? null : r.GetString(7), r.IsDBNull(8) ? null : r.GetString(8)),
            ("$k", accountKey), ("$actions", System.Text.Json.JsonSerializer.Serialize(actions)), ("$limit", limit));
}
