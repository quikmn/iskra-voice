namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string ClipsMigration = """
        CREATE TABLE clip_notices (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
        );
        """;

    /// <summary>Posts a "saved a clip" notice (a message with no text, by the person who saved it) in one transaction.</summary>
    public Message AddClipNotice(long channelId, string authorKey, long now)
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
            using (var notice = Command("INSERT INTO clip_notices (message_id) VALUES ($id);", [("$id", id)]))
            {
                notice.Transaction = tx;
                notice.ExecuteNonQuery();
            }
            tx.Commit();
            return new Message(id, channelId, authorKey, "", now, null, [], null);
        }
    }

    public bool IsClipNotice(long messageId) => Scalar("SELECT 1 FROM clip_notices WHERE message_id = $id;", ("$id", messageId)) is not null;
}
