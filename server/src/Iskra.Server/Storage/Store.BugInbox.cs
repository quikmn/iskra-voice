namespace Iskra.Server.Storage;

/// <summary>The bug inbox setting: on or off, and the channel reports go to (one row).</summary>
public sealed record BugInboxSettings(bool Enabled, long? ChannelId);

public sealed partial class Store
{
    private const string BugInboxMigration = """
        CREATE TABLE bug_inbox (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            enabled     INTEGER NOT NULL DEFAULT 0,
            channel_id  INTEGER REFERENCES channels(id) ON DELETE SET NULL
        );
        """;

    public BugInboxSettings GetBugInbox() =>
        Query("SELECT enabled, channel_id FROM bug_inbox WHERE id = 1;",
            r => new BugInboxSettings(r.GetInt64(0) != 0, r.IsDBNull(1) ? null : r.GetInt64(1))).FirstOrDefault()
        ?? new BugInboxSettings(false, null);

    public void SetBugInbox(bool enabled, long? channelId) =>
        Exec("""
            INSERT INTO bug_inbox (id, enabled, channel_id) VALUES (1, $on, $ch)
            ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, channel_id = excluded.channel_id;
            """, ("$on", enabled ? 1 : 0), ("$ch", channelId));

    /// <summary>Bug reports (from <paramref name="authorKey"/>) older than <paramref name="cutoff"/>, whatever the channel's retention.</summary>
    public List<(long Id, long ChannelId)> DeleteBugReportsBefore(string authorKey, long cutoff) =>
        Query("DELETE FROM messages WHERE author_key = $a AND created_at < $cutoff RETURNING id, channel_id;",
            r => (r.GetInt64(0), r.GetInt64(1)), ("$a", authorKey), ("$cutoff", cutoff));

    /// <summary>One bug report as a webhook-style message (author <c>webhook:bug-inbox</c>), with its files attached.</summary>
    public Message AddBugReportMessage(long channelId, string authorKey, string webhookId, string name, string text, string embeds, string[] attachments, long now)
    {
        lock (_gate)
        {
            Exec("BEGIN IMMEDIATE;");
            try
            {
                var message = AddMessage(channelId, authorKey, text, now, attachments);
                Exec("INSERT INTO webhook_messages (message_id, webhook_id, name, avatar, embeds) VALUES ($m, $w, $name, NULL, $embeds);",
                    ("$m", message.Id), ("$w", webhookId), ("$name", name), ("$embeds", embeds));
                Exec("COMMIT;");
                return message;
            }
            catch
            {
                Exec("ROLLBACK;");
                throw;
            }
        }
    }
}
