namespace Iskra.Server.Storage;

/// <summary>A "looking for group" post: a message plus who it's for, how many, when and where.</summary>
public sealed record LfgPost(long MessageId, string Game, int Slots, long? StartAt, long? VoiceChannelId, string? Note, long ExpiresAt,
    long? ClosedAt, long? FullAt)
{
    public bool IsClosed(long now) => ClosedAt is not null || now >= ExpiresAt;
}

public sealed partial class Store
{
    private const string LfgMigration = """
        CREATE TABLE lfg_posts (
            message_id        INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            game              TEXT NOT NULL,
            slots             INTEGER NOT NULL,
            start_at          INTEGER,
            voice_channel_id  INTEGER REFERENCES channels(id) ON DELETE SET NULL,
            note              TEXT,
            expires_at        INTEGER NOT NULL,
            closed_at         INTEGER,
            full_at           INTEGER
        );
        CREATE INDEX lfg_posts_open ON lfg_posts(expires_at) WHERE closed_at IS NULL;
        CREATE TABLE lfg_members (
            message_id   INTEGER NOT NULL REFERENCES lfg_posts(message_id) ON DELETE CASCADE,
            account_key  TEXT NOT NULL,
            joined_at    INTEGER NOT NULL,
            PRIMARY KEY (message_id, account_key)
        );
        CREATE TABLE lfg_notify (
            account_key  TEXT PRIMARY KEY,
            created_at   INTEGER NOT NULL
        );
        """;

    private const string LfgColumns = "message_id, game, slots, start_at, voice_channel_id, note, expires_at, closed_at, full_at";

    private static LfgPost ReadLfg(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetInt32(2), NullableLong(r, 3), NullableLong(r, 4), r.IsDBNull(5) ? null : r.GetString(5),
            r.GetInt64(6), NullableLong(r, 7), NullableLong(r, 8));

    /// <summary>The post's message and the post, written together.</summary>
    public (Message Message, LfgPost Post) AddLfg(long channelId, string authorKey, string text, LfgPost post, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            long id;
            using (var insert = Command("INSERT INTO messages (channel_id, author_key, text, created_at) VALUES ($ch, $author, $text, $now) RETURNING id;",
                       [("$ch", channelId), ("$author", authorKey), ("$text", text), ("$now", now)]))
            {
                insert.Transaction = tx;
                id = Convert.ToInt64(insert.ExecuteScalar());
            }
            using (var cmd = Command("""
                       INSERT INTO lfg_posts (message_id, game, slots, start_at, voice_channel_id, note, expires_at)
                       VALUES ($m, $game, $slots, $start, $voice, $note, $exp);
                       """, [("$m", id), ("$game", post.Game), ("$slots", post.Slots), ("$start", post.StartAt), ("$voice", post.VoiceChannelId),
                       ("$note", post.Note), ("$exp", post.ExpiresAt)]))
            {
                cmd.Transaction = tx;
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            return (new Message(id, channelId, authorKey, text, now, null, [], null), post with { MessageId = id });
        }
    }

    public LfgPost? GetLfg(long messageId) =>
        Query($"SELECT {LfgColumns} FROM lfg_posts WHERE message_id = $m;", ReadLfg, ("$m", messageId)).FirstOrDefault();

    /// <summary>Who joined, in join order (current members only).</summary>
    public List<string> LfgMembers(long messageId) =>
        Query("""
            SELECT l.account_key FROM lfg_members l JOIN members m ON m.account_key = l.account_key
            WHERE l.message_id = $m ORDER BY l.joined_at, l.rowid;
            """, r => r.GetString(0), ("$m", messageId));

    /// <summary>
    /// Joins if there's room (counting current members only). Returns whether the account is in afterwards, and whether
    /// this join filled the post for the first time (then <c>full_at</c> is set, so it never pings again).
    /// </summary>
    public (bool Joined, bool FirstFull) JoinLfg(long messageId, string accountKey, int slots, long now)
    {
        lock (_gate)
        {
            var members = LfgMembers(messageId);
            if (members.Contains(accountKey)) return (true, false);
            if (members.Count >= slots) return (false, false);
            Exec("INSERT INTO lfg_members (message_id, account_key, joined_at) VALUES ($m, $a, $now);", ("$m", messageId), ("$a", accountKey), ("$now", now));
            var first = members.Count + 1 >= slots
                && Convert.ToInt64(Scalar("UPDATE lfg_posts SET full_at = $now WHERE message_id = $m AND full_at IS NULL RETURNING 1;",
                    ("$m", messageId), ("$now", now)) ?? 0L) == 1;
            return (true, first);
        }
    }

    /// <summary>True if the account had joined.</summary>
    public bool LeaveLfg(long messageId, string accountKey)
    {
        lock (_gate)
        {
            using var cmd = Command("DELETE FROM lfg_members WHERE message_id = $m AND account_key = $a;", [("$m", messageId), ("$a", accountKey)]);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    /// <summary>Marks a post closed. Returns false if it already was.</summary>
    public bool CloseLfg(long messageId, long at)
    {
        lock (_gate)
        {
            using var cmd = Command("UPDATE lfg_posts SET closed_at = $at WHERE message_id = $m AND closed_at IS NULL;", [("$m", messageId), ("$at", at)]);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    /// <summary>Open posts whose time is up.</summary>
    public List<LfgPost> ExpiredLfg(long now) =>
        Query($"SELECT {LfgColumns} FROM lfg_posts WHERE closed_at IS NULL AND expires_at <= $now LIMIT 100;", ReadLfg, ("$now", now));

    public bool LfgNotifyOn(string accountKey) => Scalar("SELECT 1 FROM lfg_notify WHERE account_key = $a;", ("$a", accountKey)) is not null;

    public void SetLfgNotify(string accountKey, bool on, long now)
    {
        if (on) Exec("INSERT INTO lfg_notify (account_key, created_at) VALUES ($a, $now) ON CONFLICT DO NOTHING;", ("$a", accountKey), ("$now", now));
        else Exec("DELETE FROM lfg_notify WHERE account_key = $a;", ("$a", accountKey));
    }

    /// <summary>Members who want to hear about new posts.</summary>
    public List<string> LfgNotifyAccounts() =>
        Query("SELECT n.account_key FROM lfg_notify n JOIN members m ON m.account_key = n.account_key;", r => r.GetString(0));
}
