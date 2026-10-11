namespace Iskra.Server.Storage;

/// <summary>
/// The server's rules. <paramref name="Version"/> goes up when everyone has to agree again; members who agreed
/// to an older version (or never) must agree before they can write while <paramref name="Required"/> is on.
/// </summary>
public sealed record ServerRules(string Text, string Welcome, bool Required, int Version, long UpdatedAt, string UpdatedBy);

public sealed partial class Store
{
    private const string VoiceLimitsMigration = """
        CREATE TABLE voice_limits (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            user_limit  INTEGER NOT NULL
        );
        """;

    private const string RulesMigration = """
        CREATE TABLE server_rules (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            text        TEXT NOT NULL,
            welcome     TEXT NOT NULL,
            required    INTEGER NOT NULL,
            version     INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            updated_by  TEXT NOT NULL
        );
        CREATE TABLE rules_accepted (
            account_key TEXT PRIMARY KEY,
            version     INTEGER NOT NULL,
            at          INTEGER NOT NULL
        );
        """;

    // ── Voice channel user limits ────────────────────────────────────────────

    /// <summary>0 = no limit.</summary>
    public int UserLimit(long channelId) =>
        Convert.ToInt32(Scalar("SELECT user_limit FROM voice_limits WHERE channel_id = $c;", ("$c", channelId)) ?? 0L);

    public Dictionary<long, int> AllUserLimits() =>
        Query("SELECT channel_id, user_limit FROM voice_limits;", r => (r.GetInt64(0), r.GetInt32(1))).ToDictionary(x => x.Item1, x => x.Item2);

    public void SetUserLimit(long channelId, int limit)
    {
        if (limit <= 0) Exec("DELETE FROM voice_limits WHERE channel_id = $c;", ("$c", channelId));
        else Exec("""
            INSERT INTO voice_limits (channel_id, user_limit) VALUES ($c, $l)
            ON CONFLICT(channel_id) DO UPDATE SET user_limit = excluded.user_limit;
            """, ("$c", channelId), ("$l", limit));
    }

    // ── Rules ────────────────────────────────────────────────────────────────

    public ServerRules? Rules() =>
        Query("SELECT text, welcome, required, version, updated_at, updated_by FROM server_rules WHERE id = 1;",
            r => new ServerRules(r.GetString(0), r.GetString(1), r.GetInt64(2) != 0, r.GetInt32(3), r.GetInt64(4), r.GetString(5))).FirstOrDefault();

    public void SaveRules(ServerRules rules) =>
        Exec("""
            INSERT INTO server_rules (id, text, welcome, required, version, updated_at, updated_by) VALUES (1, $t, $w, $r, $v, $at, $by)
            ON CONFLICT(id) DO UPDATE SET text = excluded.text, welcome = excluded.welcome, required = excluded.required,
                version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
            """, ("$t", rules.Text), ("$w", rules.Welcome), ("$r", rules.Required ? 1 : 0), ("$v", rules.Version),
            ("$at", rules.UpdatedAt), ("$by", rules.UpdatedBy));

    /// <summary>The newest rules version this account agreed to (0 = never).</summary>
    public int AcceptedRulesVersion(string accountKey) =>
        Convert.ToInt32(Scalar("SELECT version FROM rules_accepted WHERE account_key = $a;", ("$a", accountKey)) ?? 0L);

    public void AcceptRules(string accountKey, int version, long now) =>
        Exec("""
            INSERT INTO rules_accepted (account_key, version, at) VALUES ($a, $v, $at)
            ON CONFLICT(account_key) DO UPDATE SET version = excluded.version, at = excluded.at;
            """, ("$a", accountKey), ("$v", version), ("$at", now));

    /// <summary>Everyone who is a member right now counts as having agreed to <paramref name="version"/>.</summary>
    public void AcceptRulesForAllMembers(int version, long now) =>
        Exec("""
            INSERT INTO rules_accepted (account_key, version, at) SELECT account_key, $v, $at FROM members WHERE true
            ON CONFLICT(account_key) DO UPDATE SET version = MAX(version, excluded.version), at = excluded.at;
            """, ("$v", version), ("$at", now));

    /// <summary>Members who have to agree (not the owner, not bots), and how many of them agreed to <paramref name="version"/> or later.</summary>
    public (int Agreed, int Members) RulesAgreement(int version)
    {
        var rows = Query("""
            SELECT m.account_key, COALESCE(a.version, 0) FROM members m LEFT JOIN rules_accepted a ON a.account_key = m.account_key
            WHERE m.role != 'owner';
            """, r => (Key: r.GetString(0), Version: r.GetInt32(1)));
        var people = rows.Where(r => !IsBot(r.Key)).ToList();
        return (people.Count(r => r.Version >= version), people.Count);
    }
}
