namespace Iskra.Server.Storage;

/// <summary>Stage channels: who an admin made a moderator of each stage (admins always are).</summary>
public sealed partial class Store
{
    private const string StagesMigration = """
        CREATE TABLE stage_moderators (
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            account_key TEXT NOT NULL,
            added_by    TEXT NOT NULL,
            added_at    INTEGER NOT NULL,
            PRIMARY KEY (channel_id, account_key)
        );
        -- Kicked or banned: no longer anyone's moderator, even if they come back.
        CREATE TRIGGER stage_moderators_member_gone AFTER DELETE ON members
        BEGIN DELETE FROM stage_moderators WHERE account_key = old.account_key; END;
        """;

    public const int MaxStageModerators = 25;

    public List<string> StageModerators(long channelId) =>
        Query("SELECT account_key FROM stage_moderators WHERE channel_id = $ch ORDER BY added_at, account_key;",
            r => r.GetString(0), ("$ch", channelId));

    public bool IsStageModerator(long channelId, string accountKey) =>
        Scalar("SELECT 1 FROM stage_moderators WHERE channel_id = $ch AND account_key = $a;", ("$ch", channelId), ("$a", accountKey)) is not null;

    /// <summary>Adds or removes a stage moderator. False if adding would go over <see cref="MaxStageModerators"/>.</summary>
    public bool SetStageModerator(long channelId, string accountKey, bool on, string by, long now)
    {
        lock (_gate)
        {
            if (!on)
            {
                Exec("DELETE FROM stage_moderators WHERE channel_id = $ch AND account_key = $a;", ("$ch", channelId), ("$a", accountKey));
                return true;
            }
            if (IsStageModerator(channelId, accountKey)) return true;
            if (Convert.ToInt32(Scalar("SELECT COUNT(*) FROM stage_moderators WHERE channel_id = $ch;", ("$ch", channelId))) >= MaxStageModerators)
                return false;
            Exec("INSERT INTO stage_moderators (channel_id, account_key, added_by, added_at) VALUES ($ch, $a, $by, $now);",
                ("$ch", channelId), ("$a", accountKey), ("$by", by), ("$now", now));
            return true;
        }
    }
}
