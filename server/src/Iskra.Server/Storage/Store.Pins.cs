namespace Iskra.Server.Storage;

public sealed record Pin(long MessageId, long ChannelId, string PinnedBy, long PinnedAt);

public sealed partial class Store
{
    private const string PinsMigration = """
        CREATE TABLE pins (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            channel_id  INTEGER NOT NULL,
            pinned_by   TEXT NOT NULL,
            pinned_at   INTEGER NOT NULL
        );
        CREATE INDEX pins_by_channel ON pins(channel_id, pinned_at);
        """;

    /// <summary>Pins a message. False if it was already pinned.</summary>
    public bool AddPin(long messageId, long channelId, string by, long now)
    {
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM pins WHERE message_id = $m;", ("$m", messageId)) is not null) return false;
            Exec("INSERT INTO pins (message_id, channel_id, pinned_by, pinned_at) VALUES ($m, $ch, $by, $now);",
                ("$m", messageId), ("$ch", channelId), ("$by", by), ("$now", now));
            return true;
        }
    }

    /// <summary>Unpins a message. False if it wasn't pinned.</summary>
    public bool RemovePin(long messageId)
    {
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM pins WHERE message_id = $m;", ("$m", messageId)) is null) return false;
            Exec("DELETE FROM pins WHERE message_id = $m;", ("$m", messageId));
            return true;
        }
    }

    public bool IsPinned(long messageId) => Scalar("SELECT 1 FROM pins WHERE message_id = $m;", ("$m", messageId)) is not null;

    public int PinCount(long channelId) => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM pins WHERE channel_id = $ch;", ("$ch", channelId)));

    /// <summary>A channel's pins, most recently pinned first.</summary>
    public List<Pin> Pins(long channelId) =>
        Query("SELECT message_id, channel_id, pinned_by, pinned_at FROM pins WHERE channel_id = $ch ORDER BY pinned_at DESC, message_id DESC;",
            r => new Pin(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetInt64(3)), ("$ch", channelId));
}
