namespace Iskra.Server.Storage;

/// <summary>
/// The AFK channel: where idle people are moved after <paramref name="IdleMinutes"/> (0 = never), and who can still talk
/// and hear there (levels and custom roles; everyone else is muted and deafened by the server).
/// </summary>
public sealed record AfkSettings(long? ChannelId, int IdleMinutes, string[] TalkLevels, long[] TalkRoles)
{
    public static readonly AfkSettings Default = new(null, 30, ["owner", "admin"], []);
}

public sealed partial class Store
{
    private const string AfkMigration = """
        CREATE TABLE afk_settings (
            id            INTEGER PRIMARY KEY CHECK (id = 1),
            channel_id    INTEGER REFERENCES channels(id) ON DELETE SET NULL,
            idle_minutes  INTEGER NOT NULL,
            talk_levels   TEXT NOT NULL,
            talk_roles    TEXT NOT NULL
        );
        """;

    // ── AFK channel ──────────────────────────────────────────────────────────

    /// <summary>The setting, with talk roles that no longer exist left out.</summary>
    public AfkSettings Afk()
    {
        var row = Query("SELECT channel_id, idle_minutes, talk_levels, talk_roles FROM afk_settings WHERE id = 1;",
            r => (Channel: NullableLong(r, 0), Minutes: r.GetInt32(1), Levels: r.GetString(2), Roles: r.GetString(3))).FirstOrDefault();
        if (row.Levels is null) return AfkSettings.Default;
        var existing = Query("SELECT id FROM roles;", r => r.GetInt64(0)).ToHashSet();
        var levels = row.Levels.Split(',', StringSplitOptions.RemoveEmptyEntries);
        var roles = row.Roles.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(id => long.TryParse(id, out var v) ? v : 0).Where(existing.Contains).ToArray();
        return new AfkSettings(row.Channel, row.Minutes, levels, roles);
    }

    public void SaveAfk(AfkSettings afk) =>
        Exec("""
            INSERT INTO afk_settings (id, channel_id, idle_minutes, talk_levels, talk_roles) VALUES (1, $c, $m, $l, $r)
            ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, idle_minutes = excluded.idle_minutes,
                talk_levels = excluded.talk_levels, talk_roles = excluded.talk_roles;
            """, ("$c", afk.ChannelId), ("$m", afk.IdleMinutes), ("$l", string.Join(',', afk.TalkLevels)), ("$r", string.Join(',', afk.TalkRoles)));
}
