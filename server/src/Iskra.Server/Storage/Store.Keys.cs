using System.Text.RegularExpressions;
using Iskra.Server.Crypto;

namespace Iskra.Server.Storage;

/// <summary>A signed hand-over from one account key to the next (see "Account key rotation" in PROTOCOL.md).</summary>
public sealed record Rotation(string OldKey, string NewKey, long RotatedAt, string OldSig, string NewSig);

/// <summary>A rotation as this server applied it, plus a contesting claim on the same old key, if any.</summary>
public sealed record AppliedRotation(Rotation Rotation, long AppliedAt, Rotation? Contest, long? ContestedAt, string? RoleBefore, long? ResolvedAt)
{
    public bool Disputed => Contest is not null && ResolvedAt is null;
}

public sealed partial class Store
{
    private const string KeysMigration = """
        CREATE TABLE account_rotations (
            old_key      TEXT PRIMARY KEY,
            new_key      TEXT NOT NULL UNIQUE,
            rotated_at   INTEGER NOT NULL,
            old_sig      TEXT NOT NULL,
            new_sig      TEXT NOT NULL,
            applied_at   INTEGER NOT NULL,
            contest      TEXT,
            contested_at INTEGER,
            role_before  TEXT,
            resolved_at  INTEGER
        );
        CREATE TABLE rotation_handovers (
            new_key     TEXT NOT NULL,
            device_key  TEXT NOT NULL,
            seal        TEXT NOT NULL,
            PRIMARY KEY (new_key, device_key)
        );
        """;

    private const string RotationColumns = "old_key, new_key, rotated_at, old_sig, new_sig, applied_at, contest, contested_at, role_before, resolved_at";

    private static AppliedRotation ReadRotation(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(new Rotation(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3), r.GetString(4)), r.GetInt64(5),
            r.IsDBNull(6) ? null : System.Text.Json.JsonSerializer.Deserialize<Rotation>(r.GetString(6)),
            NullableLong(r, 7), r.IsDBNull(8) ? null : r.GetString(8), NullableLong(r, 9));

    /// <summary>The rotation away from <paramref name="oldKey"/>, if this server applied one.</summary>
    public AppliedRotation? RotationFrom(string oldKey) =>
        Query($"SELECT {RotationColumns} FROM account_rotations WHERE old_key = $k;", ReadRotation, ("$k", oldKey)).FirstOrDefault();

    /// <summary>The rotation that made <paramref name="newKey"/> the account, if any.</summary>
    public AppliedRotation? RotationTo(string newKey) =>
        Query($"SELECT {RotationColumns} FROM account_rotations WHERE new_key = $k;", ReadRotation, ("$k", newKey)).FirstOrDefault();

    /// <summary>Most recently applied first.</summary>
    public List<AppliedRotation> RecentRotations(int limit) =>
        Query($"SELECT {RotationColumns} FROM account_rotations ORDER BY applied_at DESC LIMIT $n;", ReadRotation, ("$n", limit));

    /// <summary>Was this key ever used here (member, ban, device, or either end of a rotation)?</summary>
    public bool KeyKnown(string accountKey) =>
        Scalar("""
            SELECT 1 WHERE EXISTS (SELECT 1 FROM members WHERE account_key = $k) OR EXISTS (SELECT 1 FROM bans WHERE account_key = $k)
              OR EXISTS (SELECT 1 FROM devices WHERE account_key = $k) OR EXISTS (SELECT 1 FROM account_rotations WHERE old_key = $k OR new_key = $k);
            """, ("$k", accountKey)) is not null;

    public string? HandoverFor(string newKey, string deviceKey) =>
        Scalar("SELECT seal FROM rotation_handovers WHERE new_key = $k AND device_key = $d;", ("$k", newKey), ("$d", deviceKey)) as string;

    /// <summary>Adds sealed hand-overs and device certificates for an already applied rotation (idempotent).</summary>
    public void AddHandovers(string newKey, IReadOnlyList<(string DeviceKey, string Seal)> handovers, IReadOnlyList<DeviceCert> certs, string oldKey, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            foreach (var (device, seal) in handovers)
                Run(tx, "INSERT INTO rotation_handovers (new_key, device_key, seal) VALUES ($k, $d, $s) ON CONFLICT DO NOTHING;",
                    ("$k", newKey), ("$d", device), ("$s", seal));
            foreach (var cert in certs) SaveRotatedCert(tx, cert, oldKey, now);
            tx.Commit();
        }
    }

    public void DropHandover(string newKey, string deviceKey) =>
        Exec("DELETE FROM rotation_handovers WHERE new_key = $k AND device_key = $d;", ("$k", newKey), ("$d", deviceKey));

    /// <summary>
    /// Moves everything this server keeps about <paramref name="from"/> to <paramref name="to"/> in one transaction:
    /// membership, role, profile, messages, reactions, DMs, files, bans, votes, push subscriptions and anything a
    /// feature adds later. Devices are only kept if <paramref name="certs"/> re-certifies them under the new key.
    /// </summary>
    private void Rekey(Microsoft.Data.Sqlite.SqliteTransaction tx, string from, string to, IReadOnlyList<DeviceCert> certs, long now)
    {
        // Devices: the old certificates are signed by the old key, so only re-certified ones survive.
        var keep = System.Text.Json.JsonSerializer.Serialize(certs.Select(c => c.DeviceKey));
        Run(tx, """
            DELETE FROM prekeys WHERE device_key IN (SELECT device_key FROM devices WHERE account_key = $old AND device_key NOT IN (SELECT value FROM json_each($keep)));
            DELETE FROM push_subscriptions WHERE account_key = $old AND device_key NOT IN (SELECT value FROM json_each($keep));
            DELETE FROM devices WHERE account_key = $old AND device_key NOT IN (SELECT value FROM json_each($keep));
            """, ("$old", from), ("$keep", keep));
        foreach (var cert in certs) SaveRotatedCert(tx, cert, from, now);

        foreach (var (table, column) in AccountKeyColumns(tx))
            Run(tx, $"UPDATE \"{table}\" SET \"{column}\" = $new WHERE \"{column}\" = $old;", ("$old", from), ("$new", to));
        // Account keys outside the naming convention: the audit log's actor and target, and a group's member list (JSON).
        // Group changes (group_changes) are signed statements and stay as they were signed.
        Run(tx, """
            UPDATE audit_log SET actor = $new WHERE actor = $old;
            UPDATE audit_log SET target = $new WHERE target = $old;
            UPDATE groups SET members = (SELECT json_group_array(CASE WHEN value = $old THEN $new ELSE value END) FROM json_each(groups.members))
            WHERE EXISTS (SELECT 1 FROM json_each(groups.members) WHERE value = $old);
            """, ("$old", from), ("$new", to));
        _bots = null;
    }

    /// <summary>A re-certified device: kept (with its prekey) if it belonged to the old key or the new one, or new here.</summary>
    private void SaveRotatedCert(Microsoft.Data.Sqlite.SqliteTransaction tx, DeviceCert cert, string oldKey, long now) =>
        Run(tx, """
            INSERT INTO devices (device_key, account_key, created, sig, last_seen) VALUES ($dev, $acc, $created, $sig, $now)
            ON CONFLICT(device_key) DO UPDATE SET account_key = excluded.account_key, created = excluded.created, sig = excluded.sig
            WHERE devices.account_key IN ($old, $acc);
            """, ("$dev", cert.DeviceKey), ("$acc", cert.AccountKey), ("$created", cert.Created), ("$sig", cert.Sig), ("$now", now), ("$old", oldKey));

    // Tables whose rows a rotation must never rewrite: signed statements stay under the key that signed them.
    private static readonly HashSet<string> RotationSkipTables =
        new(["migrations", "account_rotations", "rotation_handovers", "device_revocations", "devices", "group_changes"],StringComparer.OrdinalIgnoreCase);

    // Convention for every table (also future ones): account keys live in TEXT columns named account_key, *_key or *_by
    // (or uploader). Device keys are not account keys.
    private static readonly Regex AccountColumn = new("^(account_key|[a-z_]+_key|[a-z_]+_by|uploader)$", RegexOptions.CultureInvariant);

    private List<(string Table, string Column)> AccountKeyColumns(Microsoft.Data.Sqlite.SqliteTransaction tx)
    {
        var tables = new List<string>();
        using (var cmd = Command("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%';", []))
        {
            cmd.Transaction = tx;
            using var r = cmd.ExecuteReader();
            while (r.Read()) tables.Add(r.GetString(0));
        }
        var columns = new List<(string, string)>();
        foreach (var table in tables.Where(t => !RotationSkipTables.Contains(t) && !t.Contains("_fts", StringComparison.Ordinal)))
        {
            using var cmd = Command($"SELECT name, type FROM pragma_table_info('{table.Replace("'", "''")}');", []);
            cmd.Transaction = tx;
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                var name = r.GetString(0);
                var type = r.IsDBNull(1) ? "" : r.GetString(1);
                if (name != "device_key" && AccountColumn.IsMatch(name) && (type.Length == 0 || type.Contains("TEXT", StringComparison.OrdinalIgnoreCase)))
                    columns.Add((table, name));
            }
        }
        return columns;
    }

    private void Run(Microsoft.Data.Sqlite.SqliteTransaction tx, string sql, params (string Name, object? Value)[] args)
    {
        using var cmd = Command(sql, args);
        cmd.Transaction = tx;
        cmd.ExecuteNonQuery();
    }

    /// <summary>Applies a (verified) first rotation away from <paramref name="r"/>.OldKey and moves the account. Callers check the rules first.</summary>
    public void ApplyRotation(Rotation r, IReadOnlyList<DeviceCert> certs, IReadOnlyList<(string DeviceKey, string Seal)> handovers, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            Run(tx, $"INSERT INTO account_rotations ({RotationColumns}) VALUES ($old, $new, $at, $os, $ns, $now, NULL, NULL, NULL, NULL);",
                ("$old", r.OldKey), ("$new", r.NewKey), ("$at", r.RotatedAt), ("$os", r.OldSig), ("$ns", r.NewSig), ("$now", now));
            Rekey(tx, r.OldKey, r.NewKey, certs, now);
            foreach (var (device, seal) in handovers)
                Run(tx, "INSERT INTO rotation_handovers (new_key, device_key, seal) VALUES ($k, $d, $s) ON CONFLICT DO NOTHING;",
                    ("$k", r.NewKey), ("$d", device), ("$s", seal));
            tx.Commit();
        }
    }

    /// <summary>Records a second, different claim on an old key and caps the current holder's role until an admin decides.</summary>
    public void RecordContest(string oldKey, Rotation contest, string currentKey, string role, string cappedRole, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            Run(tx, "UPDATE account_rotations SET contest = $c, contested_at = $now, role_before = $role, resolved_at = NULL WHERE old_key = $old AND contest IS NULL;",
                ("$c", System.Text.Json.JsonSerializer.Serialize(contest)), ("$now", now), ("$role", role), ("$old", oldKey));
            Run(tx, "UPDATE members SET role = $capped WHERE account_key = $k;", ("$capped", cappedRole), ("$k", currentKey));
            tx.Commit();
        }
    }

    /// <summary>
    /// An admin settles a dispute. Keeping the current key restores its role; picking the contesting key moves the
    /// account to it (with its own devices) and records the losing claim as the contest.
    /// </summary>
    public void ResolveDispute(AppliedRotation applied, bool keepContest, IReadOnlyList<DeviceCert> contestCerts, long now)
    {
        var current = applied.Rotation.NewKey;
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            var holder = current;
            if (keepContest && applied.Contest is { } c)
            {
                Run(tx, """
                    UPDATE account_rotations SET new_key = $nk, rotated_at = $at, new_sig = $ns, old_sig = $os, contest = $loser WHERE old_key = $old;
                    DELETE FROM rotation_handovers WHERE new_key = $cur;
                    """,
                    ("$nk", c.NewKey), ("$at", c.RotatedAt), ("$ns", c.NewSig), ("$os", c.OldSig),
                    ("$loser", System.Text.Json.JsonSerializer.Serialize(applied.Rotation)), ("$old", applied.Rotation.OldKey), ("$cur", current));
                Rekey(tx, current, c.NewKey, contestCerts, now);
                holder = c.NewKey;
            }
            if (applied.RoleBefore is { } role) Run(tx, "UPDATE members SET role = $role WHERE account_key = $k;", ("$role", role), ("$k", holder));
            Run(tx, "UPDATE account_rotations SET resolved_at = $now WHERE old_key = $old;", ("$now", now), ("$old", applied.Rotation.OldKey));
            tx.Commit();
        }
    }
}
