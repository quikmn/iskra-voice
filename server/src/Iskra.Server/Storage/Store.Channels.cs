namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string ChannelColumns = "id, name, kind, position, read_role, write_role, category_id";
    private const string MessageColumns = "id, channel_id, author_key, text, created_at, edited_at, attachments, reply_to";

    private static Channel ReadChannel(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetString(4), r.GetString(5)) { CategoryId = NullableLong(r, 6) };

    private static Message ReadMessage(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetInt64(4), NullableLong(r, 5),
            r.IsDBNull(6) ? [] : System.Text.Json.JsonSerializer.Deserialize<string[]>(r.GetString(6)) ?? [], NullableLong(r, 7));

    /// <summary>Text and voice channels (threads live under their channel and aren't listed).</summary>
    public List<Channel> AllChannels() =>
        Query($"SELECT {ChannelColumns} FROM channels WHERE parent_id IS NULL ORDER BY position, id;", ReadChannel);

    /// <summary>A channel or a thread. Threads always carry their parent channel's roles.</summary>
    public Channel? GetChannel(long id) =>
        Query($"SELECT {ThreadAwareColumns} FROM channels c LEFT JOIN channels p ON p.id = c.parent_id WHERE c.id = $id;",
            ReadChannel, ("$id", id)).FirstOrDefault();

    public Channel CreateChannel(string name, string kind, string readRole, string writeRole, long now)
    {
        lock (_gate)
        {
            var position = Convert.ToInt32(Scalar("SELECT COALESCE(MAX(position), -1) + 1 FROM channels;"));
            var id = Convert.ToInt64(Scalar("""
                INSERT INTO channels (name, kind, position, read_role, write_role, created_at)
                VALUES ($name, $kind, $pos, $read, $write, $now) RETURNING id;
                """, ("$name", name), ("$kind", kind), ("$pos", position), ("$read", readRole), ("$write", writeRole), ("$now", now)));
            return new Channel(id, name, kind, position, readRole, writeRole);
        }
    }

    public void UpdateChannel(Channel channel) =>
        Exec("UPDATE channels SET name = $name, read_role = $read, write_role = $write WHERE id = $id;",
            ("$id", channel.Id), ("$name", channel.Name), ("$read", channel.ReadRole), ("$write", channel.WriteRole));

    public void DeleteChannel(long id) => Exec("DELETE FROM channels WHERE id = $id;", ("$id", id));

    // ── Messages ─────────────────────────────────────────────────────────────

    public Message AddMessage(long channelId, string authorKey, string text, long now, string[]? attachments = null, long? replyTo = null)
    {
        attachments ??= [];
        var id = Convert.ToInt64(Scalar("""
            INSERT INTO messages (channel_id, author_key, text, created_at, attachments, reply_to)
            VALUES ($ch, $author, $text, $now, $att, $reply) RETURNING id;
            """, ("$ch", channelId), ("$author", authorKey), ("$text", text), ("$now", now),
            ("$att", attachments.Length == 0 ? null : System.Text.Json.JsonSerializer.Serialize(attachments)), ("$reply", replyTo)));
        return new Message(id, channelId, authorKey, text, now, null, attachments, replyTo);
    }

    public Message? GetMessage(long id) =>
        Query($"SELECT {MessageColumns} FROM messages WHERE id = $id;", ReadMessage, ("$id", id)).FirstOrDefault();

    public void EditMessage(long id, string text, long now) =>
        Exec("UPDATE messages SET text = $text, edited_at = $now WHERE id = $id;", ("$id", id), ("$text", text), ("$now", now));

    public void DeleteMessage(long id) => Exec("DELETE FROM messages WHERE id = $id;", ("$id", id));

    /// <summary>
    /// Up to <paramref name="limit"/> messages, oldest first. With <paramref name="before"/>: the newest ones before that id
    /// (scrolling back). With <paramref name="after"/>: the oldest ones after that id (catching up after a reconnect).
    /// </summary>
    public List<Message> History(long channelId, long? before, long? after, int limit)
    {
        if (after is not null)
        {
            return Query($"SELECT {MessageColumns} FROM messages WHERE channel_id = $ch AND id > $after ORDER BY id LIMIT $limit;",
                ReadMessage, ("$ch", channelId), ("$after", after), ("$limit", limit));
        }
        var rows = Query($"SELECT {MessageColumns} FROM messages WHERE channel_id = $ch AND id < $before ORDER BY id DESC LIMIT $limit;",
            ReadMessage, ("$ch", channelId), ("$before", before ?? long.MaxValue), ("$limit", limit));
        rows.Reverse();
        return rows;
    }
}
