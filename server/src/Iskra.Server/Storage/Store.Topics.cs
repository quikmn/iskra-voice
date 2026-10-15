namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string TopicsMigration = """
        CREATE TABLE channel_topics (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            topic       TEXT NOT NULL
        );
        """;

    // ── Channel topics ───────────────────────────────────────────────────────

    /// <summary>The channel's topic, or "" for none.</summary>
    public string Topic(long channelId) =>
        Scalar("SELECT topic FROM channel_topics WHERE channel_id = $c;", ("$c", channelId)) as string ?? "";

    public Dictionary<long, string> AllTopics() =>
        Query("SELECT channel_id, topic FROM channel_topics;", r => (r.GetInt64(0), r.GetString(1))).ToDictionary(x => x.Item1, x => x.Item2);

    /// <summary>Sets the topic; "" removes it.</summary>
    public void SetTopic(long channelId, string topic)
    {
        if (topic.Length == 0) Exec("DELETE FROM channel_topics WHERE channel_id = $c;", ("$c", channelId));
        else Exec("INSERT INTO channel_topics (channel_id, topic) VALUES ($c, $t) ON CONFLICT(channel_id) DO UPDATE SET topic = excluded.topic;",
            ("$c", channelId), ("$t", topic));
    }

    /// <summary>Whether a message by <paramref name="authorKey"/> is in the channel (template content is added once).</summary>
    public bool HasMessageFrom(long channelId, string authorKey) =>
        Scalar("SELECT 1 FROM messages WHERE channel_id = $c AND author_key = $a LIMIT 1;", ("$c", channelId), ("$a", authorKey)) is not null;
}
