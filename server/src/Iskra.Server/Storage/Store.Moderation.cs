namespace Iskra.Server.Storage;

/// <summary>One entry of an account's block list. Unblocks stay as entries (Blocked = false) so the newest change wins everywhere.</summary>
public sealed record BlockEntry(string AccountKey, bool Blocked, long At);
public sealed record MemberTimeout(string AccountKey, long Until, string Reason, string By, long At);
public sealed record AuditEntry(long Id, long At, string Action, string Actor, string ActorName, string? Target, string? TargetName,
    string? Reason, string? Details);

public sealed partial class Store
{
    private const string ModerationMigration = """
        CREATE TABLE blocks (
            account_key TEXT NOT NULL,
            blocked_key TEXT NOT NULL,
            blocked     INTEGER NOT NULL,
            at          INTEGER NOT NULL,
            PRIMARY KEY (account_key, blocked_key)
        );
        CREATE INDEX blocks_by_target ON blocks(blocked_key) WHERE blocked = 1;
        CREATE TABLE timeouts (
            account_key TEXT PRIMARY KEY,
            until       INTEGER NOT NULL,
            reason      TEXT NOT NULL,
            by_key      TEXT NOT NULL,
            at          INTEGER NOT NULL
        );
        CREATE TABLE channel_slowmode (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            seconds     INTEGER NOT NULL
        );
        CREATE TABLE audit_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            at          INTEGER NOT NULL,
            action      TEXT NOT NULL,
            actor       TEXT NOT NULL,
            actor_name  TEXT NOT NULL,
            target      TEXT,
            target_name TEXT,
            reason      TEXT,
            details     TEXT
        );
        CREATE INDEX audit_by_time ON audit_log(at);
        """;

    // ── Blocks ───────────────────────────────────────────────────────────────

    public List<BlockEntry> Blocks(string accountKey) =>
        Query("SELECT blocked_key, blocked, at FROM blocks WHERE account_key = $a ORDER BY at;",
            r => new BlockEntry(r.GetString(0), r.GetInt64(1) != 0, r.GetInt64(2)), ("$a", accountKey));

    /// <summary>Replaces the account's whole list in one transaction (the caller merged it).</summary>
    public void SaveBlocks(string accountKey, IReadOnlyCollection<BlockEntry> entries)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            using (var clear = Command("DELETE FROM blocks WHERE account_key = $a;", [("$a", accountKey)]))
            {
                clear.Transaction = tx;
                clear.ExecuteNonQuery();
            }
            foreach (var e in entries)
            {
                using var insert = Command("INSERT INTO blocks (account_key, blocked_key, blocked, at) VALUES ($a, $b, $on, $at);",
                    [("$a", accountKey), ("$b", e.AccountKey), ("$on", e.Blocked ? 1 : 0), ("$at", e.At)]);
                insert.Transaction = tx;
                insert.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    /// <summary>True if either account has blocked the other.</summary>
    public bool EitherBlocked(string a, string b) =>
        Scalar("""
            SELECT 1 FROM blocks WHERE blocked = 1
            AND ((account_key = $a AND blocked_key = $b) OR (account_key = $b AND blocked_key = $a)) LIMIT 1;
            """, ("$a", a), ("$b", b)) is not null;

    // ── Timeouts ─────────────────────────────────────────────────────────────

    public MemberTimeout? GetTimeout(string accountKey) =>
        Query("SELECT account_key, until, reason, by_key, at FROM timeouts WHERE account_key = $a;",
            r => new MemberTimeout(r.GetString(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetInt64(4)), ("$a", accountKey)).FirstOrDefault();

    /// <summary>The end of the member's timeout, if one is still running.</summary>
    public long? TimedOutUntil(string accountKey, long now) => GetTimeout(accountKey) is { } t && t.Until > now ? t.Until : null;

    public void SetTimeout(MemberTimeout t) =>
        Exec("""
            INSERT INTO timeouts (account_key, until, reason, by_key, at) VALUES ($a, $u, $r, $by, $at)
            ON CONFLICT(account_key) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_key = excluded.by_key, at = excluded.at;
            """, ("$a", t.AccountKey), ("$u", t.Until), ("$r", t.Reason), ("$by", t.By), ("$at", t.At));

    public bool RemoveTimeout(string accountKey)
    {
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM timeouts WHERE account_key = $a;", ("$a", accountKey)) is null) return false;
            Exec("DELETE FROM timeouts WHERE account_key = $a;", ("$a", accountKey));
            return true;
        }
    }

    /// <summary>Deletes timeouts that have run out and returns whose they were.</summary>
    public List<string> EndExpiredTimeouts(long now)
    {
        lock (_gate)
        {
            var expired = Query("SELECT account_key FROM timeouts WHERE until <= $now;", r => r.GetString(0), ("$now", now));
            if (expired.Count > 0) Exec("DELETE FROM timeouts WHERE until <= $now;", ("$now", now));
            return expired;
        }
    }

    // ── Slowmode ─────────────────────────────────────────────────────────────

    public int Slowmode(long channelId) =>
        Convert.ToInt32(Scalar("SELECT seconds FROM channel_slowmode WHERE channel_id = $c;", ("$c", channelId)) ?? 0L);

    public Dictionary<long, int> AllSlowmodes() =>
        Query("SELECT channel_id, seconds FROM channel_slowmode;", r => (r.GetInt64(0), r.GetInt32(1))).ToDictionary(x => x.Item1, x => x.Item2);

    public void SetSlowmode(long channelId, int seconds)
    {
        if (seconds <= 0) Exec("DELETE FROM channel_slowmode WHERE channel_id = $c;", ("$c", channelId));
        else Exec("""
            INSERT INTO channel_slowmode (channel_id, seconds) VALUES ($c, $s)
            ON CONFLICT(channel_id) DO UPDATE SET seconds = excluded.seconds;
            """, ("$c", channelId), ("$s", seconds));
    }

    // ── Audit log ────────────────────────────────────────────────────────────

    public void AddAudit(long at, string action, string actor, string actorName, string? target, string? targetName, string? reason, string? details) =>
        Exec("""
            INSERT INTO audit_log (at, action, actor, actor_name, target, target_name, reason, details)
            VALUES ($at, $action, $actor, $an, $target, $tn, $reason, $details);
            """, ("$at", at), ("$action", action), ("$actor", actor), ("$an", actorName), ("$target", target), ("$tn", targetName),
            ("$reason", reason), ("$details", details));

    /// <summary>Newest first. <paramref name="person"/> matches the actor or the target.</summary>
    public List<AuditEntry> Audit(string? action, string? person, long? before, int limit) =>
        Query("""
            SELECT id, at, action, actor, actor_name, target, target_name, reason, details FROM audit_log
            WHERE ($action IS NULL OR action = $action)
              AND ($person IS NULL OR actor = $person OR target = $person)
              AND ($before IS NULL OR id < $before)
            ORDER BY id DESC LIMIT $limit;
            """,
            r => new AuditEntry(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetString(4),
                r.IsDBNull(5) ? null : r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6),
                r.IsDBNull(7) ? null : r.GetString(7), r.IsDBNull(8) ? null : r.GetString(8)),
            ("$action", action), ("$person", person), ("$before", before), ("$limit", limit));

    public int PruneAudit(long olderThan)
    {
        lock (_gate)
        {
            var count = Convert.ToInt32(Scalar("SELECT COUNT(*) FROM audit_log WHERE at < $t;", ("$t", olderThan)));
            if (count > 0) Exec("DELETE FROM audit_log WHERE at < $t;", ("$t", olderThan));
            return count;
        }
    }
}
