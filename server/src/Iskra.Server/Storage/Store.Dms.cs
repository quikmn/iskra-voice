using Iskra.Server.Crypto;

namespace Iskra.Server.Storage;

public sealed partial class Store
{
    // ── Devices: the signed device certificates members connected with ──────

    public void SaveDevice(DeviceCert cert, long now) =>
        Exec("""
            INSERT INTO devices (device_key, account_key, created, sig, last_seen) VALUES ($dev, $acc, $created, $sig, $now)
            ON CONFLICT(device_key) DO UPDATE SET last_seen = excluded.last_seen;
            """, ("$dev", cert.DeviceKey), ("$acc", cert.AccountKey), ("$created", cert.Created), ("$sig", cert.Sig), ("$now", now));

    /// <summary>Certificates for an account's devices (revoked ones excluded), most recently seen first.</summary>
    public List<DeviceCert> Devices(string accountKey) =>
        Query("""
            SELECT account_key, device_key, created, sig FROM devices
            WHERE account_key = $acc AND device_key NOT IN (SELECT device_key FROM device_revocations WHERE account_key = $acc)
            ORDER BY last_seen DESC LIMIT 20;
            """,
            r => new DeviceCert(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3)), ("$acc", accountKey));

    // ── Direct messages: opaque encrypted envelopes ─────────────────────────

    private const string DmColumns = "id, from_key, to_key, envelope, created_at";

    private static DirectMessage ReadDm(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4));

    public DirectMessage AddDm(string from, string to, string envelope, long now)
    {
        var id = Convert.ToInt64(Scalar("INSERT INTO dms (from_key, to_key, envelope, created_at) VALUES ($from, $to, $env, $now) RETURNING id;",
            ("$from", from), ("$to", to), ("$env", envelope), ("$now", now)));
        return new DirectMessage(id, from, to, envelope, now);
    }

    /// <summary>Messages between two accounts, oldest first (newest page unless <paramref name="before"/> is given).</summary>
    public List<DirectMessage> DmHistory(string a, string b, long? before, int limit)
    {
        var rows = Query($"""
            SELECT {DmColumns} FROM dms
            WHERE ((from_key = $a AND to_key = $b) OR (from_key = $b AND to_key = $a)) AND id < $before
            ORDER BY id DESC LIMIT $limit;
            """, ReadDm, ("$a", a), ("$b", b), ("$before", before ?? long.MaxValue), ("$limit", limit));
        rows.Reverse();
        return rows;
    }

    /// <summary>Everyone this account has DMs with, with the newest message id and time.</summary>
    public List<(string With, long LastId, long LastAt)> DmConversations(string me) =>
        Query("""
            SELECT CASE WHEN from_key = $me THEN to_key ELSE from_key END AS peer, MAX(id), MAX(created_at)
            FROM dms WHERE from_key = $me OR to_key = $me
            GROUP BY peer ORDER BY MAX(id) DESC LIMIT 200;
            """, r => (r.GetString(0), r.GetInt64(1), r.GetInt64(2)), ("$me", me));
}
