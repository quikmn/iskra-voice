namespace Iskra.Server.Storage;

/// <summary>Reads for channel exports (Features/ChannelExports.cs): pages of messages in a time range, and their sizes.</summary>
public sealed partial class Store
{
    // Disappearing messages (an expiry) are never exported, so an export can't outlive a timer.
    private const string ExportFilter = "channel_id = $ch AND expires_at IS NULL AND created_at >= $from AND created_at <= $to";

    /// <summary>The next page of a channel's (or thread's) messages in the range, oldest first, after <paramref name="afterId"/>.</summary>
    public List<Message> ExportMessages(long channelId, long from, long to, long afterId, int limit) =>
        Query($"SELECT {MessageColumns} FROM messages WHERE {ExportFilter} AND id > $after ORDER BY id LIMIT $limit;",
            ReadMessage, ("$ch", channelId), ("$from", from), ("$to", to), ("$after", afterId), ("$limit", limit));

    public int ExportMessageCount(long channelId, long from, long to) =>
        Convert.ToInt32(Scalar($"SELECT COUNT(*) FROM messages WHERE {ExportFilter};", ("$ch", channelId), ("$from", from), ("$to", to)));

    /// <summary>Bytes of the files attached to the messages in the range (each file counted once per channel).</summary>
    public long ExportAttachmentBytes(long channelId, long from, long to) =>
        Convert.ToInt64(Scalar($"""
            SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.id IN (
                SELECT j.value FROM messages, json_each(messages.attachments) j WHERE {ExportFilter} AND messages.attachments IS NOT NULL);
            """, ("$ch", channelId), ("$from", from), ("$to", to)));

    /// <summary>Every page of a docs channel with its text, in the channel's order.</summary>
    public List<DocPage> ExportDocPages(long channelId) =>
        DocPages(channelId).Select(p => GetDocPage(p.Id, withText: true)).OfType<DocPage>().ToList();
}
