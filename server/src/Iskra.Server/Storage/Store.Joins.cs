namespace Iskra.Server.Storage;

/// <summary>Someone who joined through an invite that needs a moderator's approval, until approved (then a member) or declined.</summary>
public sealed record JoinRequest(string AccountKey, string Name, string InviteCode, string Role, long RequestedAt, long? DeclinedAt);

/// <summary>Who may join right now and how newcomers are slowed (JoinFeature). Defaults: open, no newcomer slowmode.</summary>
public sealed record JoinSettings(bool InvitesPaused, long? PausedAt, string? PausedBy, int NewcomerHours, int NewcomerSlowmode)
{
    public static readonly JoinSettings Default = new(false, null, null, 0, 0);
}

public sealed partial class Store
{
    private const string JoinsMigration = """
        ALTER TABLE invites ADD COLUMN approve INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE join_requests (
            account_key  TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            invite_code  TEXT NOT NULL,
            role         TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            declined_at  INTEGER
        );
        CREATE TABLE join_settings (
            id                INTEGER PRIMARY KEY CHECK (id = 1),
            invites_paused    INTEGER NOT NULL DEFAULT 0,
            paused_at         INTEGER,
            paused_by         TEXT,
            newcomer_hours    INTEGER NOT NULL DEFAULT 0,
            newcomer_slowmode INTEGER NOT NULL DEFAULT 0
        );
        """;

    // ── Settings ─────────────────────────────────────────────────────────────

    public JoinSettings JoinSettings() =>
        Query("SELECT invites_paused, paused_at, paused_by, newcomer_hours, newcomer_slowmode FROM join_settings WHERE id = 1;",
            r => new JoinSettings(r.GetInt64(0) != 0, NullableLong(r, 1), r.IsDBNull(2) ? null : r.GetString(2), r.GetInt32(3), r.GetInt32(4)))
            .FirstOrDefault() ?? Storage.JoinSettings.Default;

    public void SaveJoinSettings(JoinSettings s) =>
        Exec("""
            INSERT INTO join_settings (id, invites_paused, paused_at, paused_by, newcomer_hours, newcomer_slowmode) VALUES (1, $p, $at, $by, $h, $s)
            ON CONFLICT(id) DO UPDATE SET invites_paused = excluded.invites_paused, paused_at = excluded.paused_at, paused_by = excluded.paused_by,
                newcomer_hours = excluded.newcomer_hours, newcomer_slowmode = excluded.newcomer_slowmode;
            """, ("$p", s.InvitesPaused ? 1 : 0), ("$at", s.PausedAt), ("$by", s.PausedBy), ("$h", s.NewcomerHours), ("$s", s.NewcomerSlowmode));

    // ── Join requests ────────────────────────────────────────────────────────

    private const string JoinColumns = "account_key, name, invite_code, role, requested_at, declined_at";

    private static JoinRequest ReadJoin(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4), NullableLong(r, 5));

    public JoinRequest? GetJoinRequest(string accountKey) =>
        Query($"SELECT {JoinColumns} FROM join_requests WHERE account_key = $a;", ReadJoin, ("$a", accountKey)).FirstOrDefault();

    /// <summary>Waiting for a decision, oldest first.</summary>
    public List<JoinRequest> PendingJoinRequests() =>
        Query($"SELECT {JoinColumns} FROM join_requests WHERE declined_at IS NULL ORDER BY requested_at, account_key;", ReadJoin);

    public int CountPendingJoins() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM join_requests WHERE declined_at IS NULL;"));

    public void AddJoinRequest(string accountKey, string name, string inviteCode, string role, long now) =>
        Exec("""
            INSERT INTO join_requests (account_key, name, invite_code, role, requested_at) VALUES ($a, $n, $c, $r, $t)
            ON CONFLICT(account_key) DO UPDATE SET name = excluded.name, invite_code = excluded.invite_code, role = excluded.role,
                requested_at = excluded.requested_at, declined_at = NULL;
            """, ("$a", accountKey), ("$n", name), ("$c", inviteCode), ("$r", role), ("$t", now));

    public void DeclineJoinRequest(string accountKey, long now) =>
        Exec("UPDATE join_requests SET declined_at = $t WHERE account_key = $a;", ("$a", accountKey), ("$t", now));

    public void RemoveJoinRequest(string accountKey) => Exec("DELETE FROM join_requests WHERE account_key = $a;", ("$a", accountKey));

    /// <summary>Requests nobody answered in a week, and refusals older than a day (the person then needs a new invite), are forgotten.</summary>
    public void PruneJoinRequests(long now) =>
        Exec("DELETE FROM join_requests WHERE (declined_at IS NULL AND requested_at < $p) OR (declined_at IS NOT NULL AND declined_at < $d);",
            ("$p", now - 7L * 24 * 3600 * 1000), ("$d", now - 24L * 3600 * 1000));
}
