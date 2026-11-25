namespace Iskra.Server.Storage;

/// <summary>Join sounds (JoinSoundFeature): the soundboard sound a member picked to be played when they enter a voice channel.</summary>
public sealed partial class Store
{
    private const string JoinSoundsMigration = """
        CREATE TABLE join_sounds (
            account_key TEXT PRIMARY KEY,
            sound_id    TEXT NOT NULL,
            set_at      INTEGER NOT NULL
        );
        CREATE TRIGGER join_sound_member_gone AFTER DELETE ON members BEGIN
            DELETE FROM join_sounds WHERE account_key = old.account_key;
        END;
        CREATE TRIGGER join_sound_sound_gone AFTER DELETE ON sounds BEGIN
            DELETE FROM join_sounds WHERE sound_id = old.id;
        END;
        CREATE TABLE join_sound_settings (
            id      INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER NOT NULL
        );
        """;

    /// <summary>The member's join sound, or null (none picked, or the sound was deleted).</summary>
    public Sound? GetJoinSound(string accountKey) =>
        Query($"SELECT {string.Join(", ", SoundColumns.Split(", ").Select(c => "s." + c))} FROM join_sounds j JOIN sounds s ON s.id = j.sound_id WHERE j.account_key = $k;",
            ReadSound, ("$k", accountKey)).FirstOrDefault();

    public void SetJoinSound(string accountKey, string soundId, long now) =>
        Exec("""
            INSERT INTO join_sounds (account_key, sound_id, set_at) VALUES ($k, $s, $now)
            ON CONFLICT(account_key) DO UPDATE SET sound_id = excluded.sound_id, set_at = excluded.set_at;
            """, ("$k", accountKey), ("$s", soundId), ("$now", now));

    public void ClearJoinSound(string accountKey) => Exec("DELETE FROM join_sounds WHERE account_key = $k;", ("$k", accountKey));

    /// <summary>Whether join sounds are played on this server (on unless the owner turned them off).</summary>
    public bool JoinSoundsEnabled() => Scalar("SELECT enabled FROM join_sound_settings WHERE id = 1;") is not { } value || Convert.ToInt32(value) != 0;

    public void SetJoinSoundsEnabled(bool enabled) =>
        Exec("INSERT INTO join_sound_settings (id, enabled) VALUES (1, $e) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled;", ("$e", enabled ? 1 : 0));
}
