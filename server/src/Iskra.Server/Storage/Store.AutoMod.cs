namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string AutoModMigration = """
        CREATE TABLE automod (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            config      TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE automod_alerts (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            details     TEXT NOT NULL
        );
        """;

    /// <summary>The AutoMod settings as JSON, or null if they were never saved.</summary>
    public string? AutoModConfig() => Scalar("SELECT config FROM automod WHERE id = 1;") as string;

    public void SaveAutoModConfig(string json, long now) =>
        Exec("""
            INSERT INTO automod (id, config, updated_at) VALUES (1, $c, $t)
            ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at;
            """, ("$c", json), ("$t", now));

    /// <summary>Posts an AutoMod alert (a message with no text, authored by AutoMod) in one transaction.</summary>
    public Message AddAutoModAlert(long channelId, string authorKey, long now, string details)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            long id;
            using (var insert = Command("""
                INSERT INTO messages (channel_id, author_key, text, created_at) VALUES ($ch, $a, '', $now) RETURNING id;
                """, [("$ch", channelId), ("$a", authorKey), ("$now", now)]))
            {
                insert.Transaction = tx;
                id = Convert.ToInt64(insert.ExecuteScalar());
            }
            using (var alert = Command("INSERT INTO automod_alerts (message_id, details) VALUES ($id, $d);", [("$id", id), ("$d", details)]))
            {
                alert.Transaction = tx;
                alert.ExecuteNonQuery();
            }
            tx.Commit();
            return new Message(id, channelId, authorKey, "", now, null, [], null);
        }
    }

    public string? AutoModAlert(long messageId) =>
        Scalar("SELECT details FROM automod_alerts WHERE message_id = $id;", ("$id", messageId)) as string;
}
