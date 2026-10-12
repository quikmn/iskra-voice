namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string HifiMigration = """
        CREATE TABLE voice_hifi (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE
        );
        """;

    // ── Hi-fi voice channels ─────────────────────────────────────────────────

    public bool IsHifi(long channelId) =>
        Scalar("SELECT 1 FROM voice_hifi WHERE channel_id = $c;", ("$c", channelId)) is not null;

    public HashSet<long> AllHifi() =>
        Query("SELECT channel_id FROM voice_hifi;", r => r.GetInt64(0)).ToHashSet();

    public void SetHifi(long channelId, bool on)
    {
        if (on) Exec("INSERT INTO voice_hifi (channel_id) VALUES ($c) ON CONFLICT(channel_id) DO NOTHING;", ("$c", channelId));
        else Exec("DELETE FROM voice_hifi WHERE channel_id = $c;", ("$c", channelId));
    }
}
