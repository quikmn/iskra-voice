namespace Iskra.Server.Storage;

/// <summary>A browser's Web Push subscription, one per device (the endpoint is the push service's URL for it).</summary>
public sealed record PushSubscriptionRecord(string DeviceKey, string AccountKey, string Endpoint, string P256dh, string Auth, long UpdatedAt);

public sealed partial class Store
{
    private const string PushColumns = "device_key, account_key, endpoint, p256dh, auth, updated_at";

    private static PushSubscriptionRecord ReadPush(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt64(5));

    /// <summary>
    /// Saves the device's subscription (replacing its old one). An endpoint belongs to one device only, and an account
    /// keeps at most <paramref name="maxPerAccount"/> subscriptions: the least recently refreshed ones go first.
    /// </summary>
    public void SavePushSubscription(string accountKey, string deviceKey, string endpoint, string p256dh, string auth, long now, int maxPerAccount) =>
        Exec("""
            DELETE FROM push_subscriptions WHERE endpoint = $endpoint AND device_key <> $dev;
            INSERT INTO push_subscriptions (device_key, account_key, endpoint, p256dh, auth, created_at, updated_at)
            VALUES ($dev, $acc, $endpoint, $p256dh, $auth, $now, $now)
            ON CONFLICT(device_key) DO UPDATE SET account_key = excluded.account_key, endpoint = excluded.endpoint,
                p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at;
            DELETE FROM push_subscriptions WHERE account_key = $acc AND device_key NOT IN
                (SELECT device_key FROM push_subscriptions WHERE account_key = $acc ORDER BY updated_at DESC, rowid DESC LIMIT $max);
            """, ("$dev", deviceKey), ("$acc", accountKey), ("$endpoint", endpoint), ("$p256dh", p256dh), ("$auth", auth),
            ("$now", now), ("$max", maxPerAccount));

    public PushSubscriptionRecord? PushSubscriptionFor(string deviceKey) =>
        Query($"SELECT {PushColumns} FROM push_subscriptions WHERE device_key = $dev;", ReadPush, ("$dev", deviceKey)).FirstOrDefault();

    public List<PushSubscriptionRecord> PushSubscriptions(string accountKey) =>
        Query($"SELECT {PushColumns} FROM push_subscriptions WHERE account_key = $acc;", ReadPush, ("$acc", accountKey));

    public void DeletePushSubscription(string deviceKey) =>
        Exec("DELETE FROM push_subscriptions WHERE device_key = $dev;", ("$dev", deviceKey));

    /// <summary>The push service said the subscription is gone (404/410).</summary>
    public void DeletePushEndpoint(string endpoint) =>
        Exec("DELETE FROM push_subscriptions WHERE endpoint = $endpoint;", ("$endpoint", endpoint));
}
