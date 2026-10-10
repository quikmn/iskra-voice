namespace Iskra.Server.Storage;

public sealed record ForumTag(long Id, long ChannelId, string Name, string? Emoji, int Position);

/// <summary>A forum post: a thread under a forum channel, whose root message (in the forum) is the first message.</summary>
public sealed record ForumPost(ThreadInfo Thread, long? PinnedAt, bool Closed, bool Locked, long[] Tags, Message? Root, string? LastAuthor)
{
    public long Id => Thread.Id;
    public long LastActivity => Thread.LastActivity;
}

/// <summary>
/// Forum channels: a channel of kind "forum" whose posts are threads (see Store.Threads). Each post's first message
/// is the thread's root, stored in the forum channel itself; replies live in the thread.
/// </summary>
public sealed partial class Store
{
    private const string ForumsMigration = """
        CREATE TABLE forum_tags (
            id          INTEGER PRIMARY KEY,
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            emoji       TEXT,
            position    INTEGER NOT NULL
        );
        CREATE INDEX forum_tags_by_channel ON forum_tags(channel_id, position);
        CREATE TABLE forum_posts (
            thread_id   INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            forum_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            pinned_at   INTEGER,
            closed      INTEGER NOT NULL DEFAULT 0,
            locked      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX forum_posts_by_forum ON forum_posts(forum_id);
        CREATE TABLE forum_post_tags (
            thread_id   INTEGER NOT NULL REFERENCES forum_posts(thread_id) ON DELETE CASCADE,
            tag_id      INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
            PRIMARY KEY (thread_id, tag_id)
        );
        """;

    private static ForumTag ReadTag(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt32(4));

    public List<ForumTag> ForumTags(long channelId) =>
        Query("SELECT id, channel_id, name, emoji, position FROM forum_tags WHERE channel_id = $ch ORDER BY position, id;", ReadTag, ("$ch", channelId));

    /// <summary>
    /// Replaces a forum's tags. Entries with an id keep it (and stay on their posts); tags left out are removed from every post.
    /// </summary>
    public List<ForumTag> SetForumTags(long channelId, IReadOnlyList<(long? Id, string Name, string? Emoji)> tags)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            void Run(string sql, params (string, object?)[] args)
            {
                using var cmd = Command(sql, args);
                cmd.Transaction = tx;
                cmd.ExecuteNonQuery();
            }
            var keep = tags.Where(t => t.Id is not null).Select(t => t.Id!.Value).ToList();
            Run("DELETE FROM forum_tags WHERE channel_id = $ch AND id NOT IN (SELECT value FROM json_each($keep));",
                ("$ch", channelId), ("$keep", System.Text.Json.JsonSerializer.Serialize(keep)));
            for (var i = 0; i < tags.Count; i++)
            {
                var (id, name, emoji) = tags[i];
                if (id is { } existing)
                    Run("UPDATE forum_tags SET name = $name, emoji = $emoji, position = $pos WHERE id = $id AND channel_id = $ch;",
                        ("$id", existing), ("$ch", channelId), ("$name", name), ("$emoji", emoji), ("$pos", i));
                else
                    Run("INSERT INTO forum_tags (channel_id, name, emoji, position) VALUES ($ch, $name, $emoji, $pos);",
                        ("$ch", channelId), ("$name", name), ("$emoji", emoji), ("$pos", i));
            }
            tx.Commit();
        }
        return ForumTags(channelId);
    }

    /// <summary>The first message and its thread, written together, so a post never exists half-made.</summary>
    public ThreadInfo CreateForumPost(Channel forum, string authorKey, string title, string text, string[] attachments, long[] tags, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            object? Run(string sql, params (string, object?)[] args)
            {
                using var cmd = Command(sql, args);
                cmd.Transaction = tx;
                return cmd.ExecuteScalar();
            }
            var rootId = Convert.ToInt64(Run("""
                INSERT INTO messages (channel_id, author_key, text, created_at, attachments) VALUES ($ch, $author, $text, $now, $att) RETURNING id;
                """, ("$ch", forum.Id), ("$author", authorKey), ("$text", text), ("$now", now),
                ("$att", attachments.Length == 0 ? null : System.Text.Json.JsonSerializer.Serialize(attachments))));
            var id = Convert.ToInt64(Run("""
                INSERT INTO channels (name, kind, position, read_role, write_role, created_at, parent_id)
                VALUES ($name, 'thread', 0, $read, $write, $now, $parent) RETURNING id;
                """, ("$name", title), ("$read", forum.ReadRole), ("$write", forum.WriteRole), ("$now", now), ("$parent", forum.Id)));
            Run("INSERT INTO threads (channel_id, root_id, created_by, created_at) VALUES ($id, $root, $by, $now);",
                ("$id", id), ("$root", rootId), ("$by", authorKey), ("$now", now));
            Run("INSERT INTO forum_posts (thread_id, forum_id) VALUES ($id, $forum);", ("$id", id), ("$forum", forum.Id));
            foreach (var tag in tags) Run("INSERT INTO forum_post_tags (thread_id, tag_id) VALUES ($id, $tag);", ("$id", id), ("$tag", tag));
            tx.Commit();
            return new ThreadInfo(id, forum.Id, rootId, title, authorKey, now, 0, null);
        }
    }

    private const string PostSelect = """
        SELECT c.id, c.parent_id, t.root_id, c.name, t.created_by, t.created_at,
            (SELECT COUNT(*) FROM messages WHERE channel_id = c.id),
            (SELECT created_at FROM messages WHERE channel_id = c.id ORDER BY id DESC LIMIT 1),
            fp.pinned_at, fp.closed, fp.locked,
            (SELECT json_group_array(tag_id) FROM forum_post_tags WHERE thread_id = fp.thread_id),
            (SELECT author_key FROM messages WHERE channel_id = c.id ORDER BY id DESC LIMIT 1),
            r.id, r.channel_id, r.author_key, r.text, r.created_at, r.edited_at, r.attachments, r.reply_to
        FROM forum_posts fp JOIN channels c ON c.id = fp.thread_id JOIN threads t ON t.channel_id = c.id
        LEFT JOIN messages r ON r.id = t.root_id
        """;

    private static ForumPost ReadPost(Microsoft.Data.Sqlite.SqliteDataReader r)
    {
        var thread = ReadThread(r);
        var tags = r.IsDBNull(11) ? [] : System.Text.Json.JsonSerializer.Deserialize<long[]>(r.GetString(11)) ?? [];
        Message? root = r.IsDBNull(13) ? null : new Message(r.GetInt64(13), r.GetInt64(14), r.GetString(15), r.GetString(16), r.GetInt64(17),
            NullableLong(r, 18), r.IsDBNull(19) ? [] : System.Text.Json.JsonSerializer.Deserialize<string[]>(r.GetString(19)) ?? [], NullableLong(r, 20));
        return new ForumPost(thread, NullableLong(r, 8), r.GetInt64(9) != 0, r.GetInt64(10) != 0, tags, root, r.IsDBNull(12) ? null : r.GetString(12));
    }

    public ForumPost? GetForumPost(long threadId) =>
        Query($"{PostSelect} WHERE fp.thread_id = $id;", ReadPost, ("$id", threadId)).FirstOrDefault();

    /// <summary>Every post in a forum (at most a channel's thread limit), unsorted: the feature sorts and filters.</summary>
    public List<ForumPost> ForumPosts(long forumId) =>
        Query($"{PostSelect} WHERE fp.forum_id = $forum;", ReadPost, ("$forum", forumId));

    public int PinnedPostCount(long forumId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM forum_posts WHERE forum_id = $f AND pinned_at IS NOT NULL;", ("$f", forumId)));

    public void SetPostState(long threadId, long? pinnedAt, bool closed, bool locked) =>
        Exec("UPDATE forum_posts SET pinned_at = $pin, closed = $closed, locked = $locked WHERE thread_id = $id;",
            ("$id", threadId), ("$pin", pinnedAt), ("$closed", closed ? 1 : 0), ("$locked", locked ? 1 : 0));

    public void SetPostTags(long threadId, long[] tags)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            using (var del = Command("DELETE FROM forum_post_tags WHERE thread_id = $id;", [("$id", threadId)]))
            {
                del.Transaction = tx;
                del.ExecuteNonQuery();
            }
            foreach (var tag in tags)
            {
                using var ins = Command("INSERT INTO forum_post_tags (thread_id, tag_id) VALUES ($id, $tag);", [("$id", threadId), ("$tag", tag)]);
                ins.Transaction = tx;
                ins.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    /// <summary>The post whose first message this is, if any.</summary>
    public long? PostForRoot(long rootId) =>
        Scalar("SELECT fp.thread_id FROM forum_posts fp JOIN threads t ON t.channel_id = fp.thread_id WHERE t.root_id = $root;", ("$root", rootId))
            is { } id ? Convert.ToInt64(id) : null;
}
