namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string RecordingMigration = """
        CREATE TABLE record_optouts (
            account_key TEXT PRIMARY KEY,
            at          INTEGER NOT NULL
        );
        CREATE TABLE record_notices (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            kind        TEXT NOT NULL
        );
        """;

    /// <summary>Everyone who said "don't record me" (loaded once; RecordingRegistry keeps it in step).</summary>
    public HashSet<string> RecordOptOuts() => Query("SELECT account_key FROM record_optouts;", r => r.GetString(0)).ToHashSet();

    public void SetRecordOptOut(string accountKey, bool optOut, long now)
    {
        if (optOut) Exec("INSERT INTO record_optouts (account_key, at) VALUES ($k, $at) ON CONFLICT(account_key) DO NOTHING;", ("$k", accountKey), ("$at", now));
        else Exec("DELETE FROM record_optouts WHERE account_key = $k;", ("$k", accountKey));
    }

    /// <summary>Posts a "started/stopped recording this call" line (by the recorder) in one transaction.</summary>
    public Message AddRecordNotice(long channelId, string authorKey, string kind, string text, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            long id;
            using (var insert = Command("""
                INSERT INTO messages (channel_id, author_key, text, created_at) VALUES ($ch, $a, $t, $now) RETURNING id;
                """, [("$ch", channelId), ("$a", authorKey), ("$t", text), ("$now", now)]))
            {
                insert.Transaction = tx;
                id = Convert.ToInt64(insert.ExecuteScalar());
            }
            using (var notice = Command("INSERT INTO record_notices (message_id, kind) VALUES ($id, $kind);", [("$id", id), ("$kind", kind)]))
            {
                notice.Transaction = tx;
                notice.ExecuteNonQuery();
            }
            tx.Commit();
            return new Message(id, channelId, authorKey, text, now, null, [], null);
        }
    }

    /// <summary>"start" or "stop" for a recording line, else null.</summary>
    public string? RecordNoticeKind(long messageId) => Scalar("SELECT kind FROM record_notices WHERE message_id = $id;", ("$id", messageId)) as string;
}
