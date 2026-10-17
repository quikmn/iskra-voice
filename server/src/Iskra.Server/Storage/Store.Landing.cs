namespace Iskra.Server.Storage;

/// <summary>
/// The server's public page (what a browser sees at its address; LandingFeature). Off by default; every field to show is
/// a separate choice. Server data, not personal: no account keys here (the audit log says who changed it).
/// </summary>
public sealed record LandingSettings(bool Enabled, string Description, bool ShowRules, bool ShowCounts, bool Indexable, string? InviteCode)
{
    public static readonly LandingSettings Default = new(false, "", false, false, false, null);
}

public sealed partial class Store
{
    private const string LandingMigration = """
        CREATE TABLE landing_page (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            enabled     INTEGER NOT NULL DEFAULT 0,
            description TEXT NOT NULL DEFAULT '',
            show_rules  INTEGER NOT NULL DEFAULT 0,
            show_counts INTEGER NOT NULL DEFAULT 0,
            indexable   INTEGER NOT NULL DEFAULT 0,
            invite_code TEXT
        );
        """;

    public LandingSettings Landing() =>
        Query("SELECT enabled, description, show_rules, show_counts, indexable, invite_code FROM landing_page WHERE id = 1;",
            r => new LandingSettings(r.GetInt64(0) != 0, r.GetString(1), r.GetInt64(2) != 0, r.GetInt64(3) != 0, r.GetInt64(4) != 0,
                r.IsDBNull(5) ? null : r.GetString(5)))
            .FirstOrDefault() ?? LandingSettings.Default;

    public void SaveLanding(LandingSettings l) =>
        Exec("""
            INSERT INTO landing_page (id, enabled, description, show_rules, show_counts, indexable, invite_code) VALUES (1, $e, $d, $r, $c, $i, $code)
            ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, description = excluded.description, show_rules = excluded.show_rules,
                show_counts = excluded.show_counts, indexable = excluded.indexable, invite_code = excluded.invite_code;
            """, ("$e", l.Enabled ? 1 : 0), ("$d", l.Description), ("$r", l.ShowRules ? 1 : 0), ("$c", l.ShowCounts ? 1 : 0),
            ("$i", l.Indexable ? 1 : 0), ("$code", l.InviteCode));
}
