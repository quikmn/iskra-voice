namespace Iskra.Server.Storage;

public sealed record DeviceInfo(string DeviceKey, long Created, string? Name, string? Platform, long LastSeen);
public sealed record DeviceRevocation(string AccountKey, string DeviceKey, long RevokedAt, string Sig);
public sealed record SignedPrekey(string DeviceKey, string Prekey, long Created, string Sig);

public sealed partial class Store
{
    // ── Device details: names and platforms (cosmetic, set by the account's own devices) ──

    /// <summary>An account's devices on this server (revoked ones excluded), most recently seen first.</summary>
    public List<DeviceInfo> DeviceInfos(string accountKey) =>
        Query("""
            SELECT device_key, created, name, platform, last_seen FROM devices
            WHERE account_key = $acc AND device_key NOT IN (SELECT device_key FROM device_revocations WHERE account_key = $acc)
            ORDER BY last_seen DESC LIMIT 50;
            """,
            r => new DeviceInfo(r.GetString(0), r.GetInt64(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt64(4)),
            ("$acc", accountKey));

    /// <summary>The device's own description: platform always, name only if none was chosen yet.</summary>
    public void DescribeDevice(string deviceKey, string? name, string? platform) =>
        Exec("UPDATE devices SET name = COALESCE(name, $name), platform = COALESCE($platform, platform) WHERE device_key = $dev;",
            ("$dev", deviceKey), ("$name", name), ("$platform", platform));

    /// <summary>Renames one of the account's devices. False if this server doesn't know that device.</summary>
    public bool RenameDevice(string accountKey, string deviceKey, string name)
    {
        lock (_gate)
        {
            using var cmd = Command("UPDATE devices SET name = $name WHERE device_key = $dev AND account_key = $acc;",
                [("$dev", deviceKey), ("$acc", accountKey), ("$name", name)]);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    // ── Revocations: account-signed statements, kept forever ────────────────

    public bool IsDeviceRevoked(string accountKey, string deviceKey) =>
        Scalar("SELECT 1 FROM device_revocations WHERE account_key = $acc AND device_key = $dev;", ("$acc", accountKey), ("$dev", deviceKey)) is not null;

    public int CountRevocations(string accountKey) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM device_revocations WHERE account_key = $acc;", ("$acc", accountKey)));

    /// <summary>Stores a (verified) revocation and forgets the device's prekey. Idempotent.</summary>
    public void AddRevocation(DeviceRevocation r) =>
        Exec("""
            INSERT INTO device_revocations (account_key, device_key, revoked_at, sig) VALUES ($acc, $dev, $at, $sig)
            ON CONFLICT(account_key, device_key) DO NOTHING;
            DELETE FROM prekeys WHERE device_key = $dev AND device_key IN (SELECT device_key FROM devices WHERE account_key = $acc);
            """, ("$acc", r.AccountKey), ("$dev", r.DeviceKey), ("$at", r.RevokedAt), ("$sig", r.Sig));

    public List<DeviceRevocation> Revocations(string accountKey) =>
        Query("SELECT account_key, device_key, revoked_at, sig FROM device_revocations WHERE account_key = $acc ORDER BY revoked_at LIMIT 200;",
            r => new DeviceRevocation(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3)), ("$acc", accountKey));

    // ── Signed prekeys: the latest one per device ───────────────────────────

    /// <summary>Keeps the newest prekey per device; an older or equal one is ignored.</summary>
    public void SavePrekey(SignedPrekey p) =>
        Exec("""
            INSERT INTO prekeys (device_key, prekey, created, sig) VALUES ($dev, $key, $created, $sig)
            ON CONFLICT(device_key) DO UPDATE SET prekey = excluded.prekey, created = excluded.created, sig = excluded.sig
            WHERE excluded.created > prekeys.created;
            """, ("$dev", p.DeviceKey), ("$key", p.Prekey), ("$created", p.Created), ("$sig", p.Sig));

    /// <summary>Prekeys of an account's current (not revoked) devices.</summary>
    public List<SignedPrekey> Prekeys(string accountKey) =>
        Query("""
            SELECT p.device_key, p.prekey, p.created, p.sig FROM prekeys p JOIN devices d ON d.device_key = p.device_key
            WHERE d.account_key = $acc AND p.device_key NOT IN (SELECT device_key FROM device_revocations WHERE account_key = $acc)
            ORDER BY d.last_seen DESC LIMIT 20;
            """, r => new SignedPrekey(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3)), ("$acc", accountKey));
}
