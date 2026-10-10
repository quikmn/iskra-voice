namespace Iskra.Server.Storage;

public sealed record ThreadInfo(long Id, long ParentId, long RootId, string Name, string CreatedBy, long CreatedAt, int MessageCount, long? LastMessageAt)
{
    public long LastActivity => LastMessageAt ?? CreatedAt;
}

/// <summary>
/// A thread is a channel row of kind "thread" with a parent channel (deleting the parent deletes its threads),
/// so messages, replies, reactions, typing and pins work in threads unchanged. Its roles always come from the parent.
/// </summary>
public sealed partial class Store
{
    private const string ThreadsMigration = """
        ALTER TABLE channels ADD COLUMN parent_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
        CREATE INDEX channels_by_parent ON channels(parent_id);
        CREATE TABLE threads (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            root_id     INTEGER NOT NULL UNIQUE,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        """;

    private const string ThreadAwareColumns =
        "c.id, c.name, c.kind, c.position, COALESCE(p.read_role, c.read_role), COALESCE(p.write_role, c.write_role), c.category_id";

    private const string ThreadSelect = """
        SELECT c.id, c.parent_id, t.root_id, c.name, t.created_by, t.created_at,
            (SELECT COUNT(*) FROM messages WHERE channel_id = c.id),
            (SELECT created_at FROM messages WHERE channel_id = c.id ORDER BY id DESC LIMIT 1) AS last_at
        FROM threads t JOIN channels c ON c.id = t.channel_id
        """;

    private static ThreadInfo ReadThread(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetInt64(2), r.GetString(3), r.GetString(4), r.GetInt64(5), r.GetInt32(6), NullableLong(r, 7));

    public ThreadInfo CreateThread(Channel parent, long rootId, string name, string by, long now)
    {
        lock (_gate)
        {
            var id = Convert.ToInt64(Scalar("""
                INSERT INTO channels (name, kind, position, read_role, write_role, created_at, parent_id)
                VALUES ($name, 'thread', 0, $read, $write, $now, $parent) RETURNING id;
                """, ("$name", name), ("$read", parent.ReadRole), ("$write", parent.WriteRole), ("$now", now), ("$parent", parent.Id)));
            Exec("INSERT INTO threads (channel_id, root_id, created_by, created_at) VALUES ($id, $root, $by, $now);",
                ("$id", id), ("$root", rootId), ("$by", by), ("$now", now));
            return new ThreadInfo(id, parent.Id, rootId, name, by, now, 0, null);
        }
    }

    public ThreadInfo? GetThread(long id) =>
        Query($"{ThreadSelect} WHERE c.id = $id;", ReadThread, ("$id", id)).FirstOrDefault();

    public ThreadInfo? ThreadForRoot(long rootId) =>
        Query($"{ThreadSelect} WHERE t.root_id = $root;", ReadThread, ("$root", rootId)).FirstOrDefault();

    /// <summary>A channel's threads, most recently active first.</summary>
    public List<ThreadInfo> Threads(long parentId, int limit) =>
        Query($"{ThreadSelect} WHERE c.parent_id = $parent ORDER BY COALESCE(last_at, t.created_at) DESC, c.id DESC LIMIT $limit;",
            ReadThread, ("$parent", parentId), ("$limit", limit));

    public List<long> ThreadIds(long parentId) =>
        Query("SELECT id FROM channels WHERE parent_id = $parent;", r => r.GetInt64(0), ("$parent", parentId));

    public int ThreadCount(long parentId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM channels WHERE parent_id = $parent;", ("$parent", parentId)));

    public void RenameThread(long id, string name) =>
        Exec("UPDATE channels SET name = $name WHERE id = $id AND kind = 'thread';", ("$id", id), ("$name", name));

    /// <summary>Every channel and thread (threads with their parent's roles), for deciding what someone may search.</summary>
    public List<Channel> AllConversations() =>
        Query($"SELECT {ThreadAwareColumns} FROM channels c LEFT JOIN channels p ON p.id = c.parent_id;", ReadChannel);
}
