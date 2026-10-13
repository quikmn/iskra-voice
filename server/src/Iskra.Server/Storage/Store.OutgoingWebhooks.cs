using System.Text.Json;

namespace Iskra.Server.Storage;

/// <summary>An outgoing webhook: the server POSTs chosen events to an admin's URL, signed with <see cref="Secret"/>.</summary>
public sealed record OutgoingWebhook(string Id, string Name, string Url, string[] Events, long[] ChannelIds, string Secret,
    bool AllowLocal, bool Enabled, int Failures, string? DisabledReason, string CreatedBy, long CreatedAt, long? LastDeliveryAt, string? LastOutcome);

/// <summary>One delivery attempt in the log: what happened, never what was sent.</summary>
public sealed record OutgoingDelivery(long Id, string HookId, string Delivery, string Event, int Attempt, long At, int? Status, string Outcome, int Ms);

public sealed partial class Store
{
    private const string OutgoingWebhooksMigration = """
        CREATE TABLE outgoing_webhooks (
            id               TEXT PRIMARY KEY,
            name             TEXT NOT NULL,
            url              TEXT NOT NULL,
            events           TEXT NOT NULL,
            channels         TEXT NOT NULL,
            secret           TEXT NOT NULL,
            allow_local      INTEGER NOT NULL DEFAULT 0,
            enabled          INTEGER NOT NULL DEFAULT 1,
            failures         INTEGER NOT NULL DEFAULT 0,
            disabled_reason  TEXT,
            created_by       TEXT NOT NULL,
            created_at       INTEGER NOT NULL,
            last_delivery_at INTEGER,
            last_outcome     TEXT
        );
        CREATE TABLE outgoing_webhook_log (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            hook_id  TEXT NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
            delivery TEXT NOT NULL,
            event    TEXT NOT NULL,
            attempt  INTEGER NOT NULL,
            at       INTEGER NOT NULL,
            status   INTEGER,
            outcome  TEXT NOT NULL,
            ms       INTEGER NOT NULL
        );
        CREATE INDEX outgoing_webhook_log_hook ON outgoing_webhook_log (hook_id, id);
        """;

    /// <summary>Delivery log entries kept per outgoing webhook.</summary>
    public const int OutgoingLogSize = 50;

    private const string OutgoingColumns =
        "id, name, url, events, channels, secret, allow_local, enabled, failures, disabled_reason, created_by, created_at, last_delivery_at, last_outcome";

    private static OutgoingWebhook ReadOutgoing(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), JsonSerializer.Deserialize<string[]>(r.GetString(3)) ?? [],
            JsonSerializer.Deserialize<long[]>(r.GetString(4)) ?? [], r.GetString(5), r.GetInt32(6) != 0, r.GetInt32(7) != 0,
            r.GetInt32(8), r.IsDBNull(9) ? null : r.GetString(9), r.GetString(10), r.GetInt64(11), NullableLong(r, 12),
            r.IsDBNull(13) ? null : r.GetString(13));

    public void AddOutgoingWebhook(OutgoingWebhook h) =>
        Exec($"INSERT INTO outgoing_webhooks ({OutgoingColumns}) VALUES ($id, $name, $url, $events, $ch, $secret, $local, $on, 0, NULL, $by, $at, NULL, NULL);",
            ("$id", h.Id), ("$name", h.Name), ("$url", h.Url), ("$events", JsonSerializer.Serialize(h.Events)),
            ("$ch", JsonSerializer.Serialize(h.ChannelIds)), ("$secret", h.Secret), ("$local", h.AllowLocal ? 1 : 0),
            ("$on", h.Enabled ? 1 : 0), ("$by", h.CreatedBy), ("$at", h.CreatedAt));

    public OutgoingWebhook? GetOutgoingWebhook(string id) =>
        Query($"SELECT {OutgoingColumns} FROM outgoing_webhooks WHERE id = $id;", ReadOutgoing, ("$id", id)).FirstOrDefault();

    public List<OutgoingWebhook> OutgoingWebhooks() =>
        Query($"SELECT {OutgoingColumns} FROM outgoing_webhooks ORDER BY created_at;", ReadOutgoing);

    public int CountOutgoingWebhooks() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM outgoing_webhooks;"));

    /// <summary>Saves what an admin can change. Turning a webhook on clears its failures.</summary>
    public void UpdateOutgoingWebhook(OutgoingWebhook h) =>
        Exec("""
            UPDATE outgoing_webhooks SET name = $name, url = $url, events = $events, channels = $ch, secret = $secret,
                allow_local = $local, enabled = $on,
                failures = CASE WHEN $on = 1 AND enabled = 0 THEN 0 ELSE failures END,
                disabled_reason = CASE WHEN $on = 1 THEN NULL WHEN enabled = 1 THEN NULL ELSE disabled_reason END
            WHERE id = $id;
            """,
            ("$id", h.Id), ("$name", h.Name), ("$url", h.Url), ("$events", JsonSerializer.Serialize(h.Events)),
            ("$ch", JsonSerializer.Serialize(h.ChannelIds)), ("$secret", h.Secret), ("$local", h.AllowLocal ? 1 : 0), ("$on", h.Enabled ? 1 : 0));

    public void DeleteOutgoingWebhook(string id)
    {
        Exec("DELETE FROM outgoing_webhook_log WHERE hook_id = $id;", ("$id", id));
        Exec("DELETE FROM outgoing_webhooks WHERE id = $id;", ("$id", id));
    }

    /// <summary>
    /// Records how a delivery ended. Success resets the failure count; a failure adds one, and at <paramref name="disableAfter"/>
    /// turns the webhook off. Returns true when this call turned it off.
    /// </summary>
    public bool FinishOutgoingDelivery(string id, bool ok, string outcome, long now, int disableAfter)
    {
        lock (_gate)
        {
            var hook = GetOutgoingWebhook(id);
            if (hook is null) return false;
            var failures = ok ? 0 : hook.Failures + 1;
            var disable = !ok && hook.Enabled && failures >= disableAfter;
            Exec("""
                UPDATE outgoing_webhooks SET failures = $f, last_delivery_at = $now, last_outcome = $outcome,
                    enabled = CASE WHEN $off = 1 THEN 0 ELSE enabled END,
                    disabled_reason = CASE WHEN $off = 1 THEN 'failures' ELSE disabled_reason END
                WHERE id = $id;
                """, ("$id", id), ("$f", failures), ("$now", now), ("$outcome", outcome), ("$off", disable ? 1 : 0));
            return disable;
        }
    }

    public void LogOutgoingDelivery(OutgoingDelivery d)
    {
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM outgoing_webhooks WHERE id = $id;", ("$id", d.HookId)) is null) return;
            Exec("INSERT INTO outgoing_webhook_log (hook_id, delivery, event, attempt, at, status, outcome, ms) VALUES ($h, $d, $e, $a, $at, $s, $o, $ms);",
                ("$h", d.HookId), ("$d", d.Delivery), ("$e", d.Event), ("$a", d.Attempt), ("$at", d.At), ("$s", d.Status), ("$o", d.Outcome), ("$ms", d.Ms));
            Exec("""
                DELETE FROM outgoing_webhook_log WHERE hook_id = $h AND id NOT IN
                    (SELECT id FROM outgoing_webhook_log WHERE hook_id = $h ORDER BY id DESC LIMIT $n);
                """, ("$h", d.HookId), ("$n", OutgoingLogSize));
        }
    }

    public List<OutgoingDelivery> OutgoingLog(string hookId) =>
        Query("SELECT id, hook_id, delivery, event, attempt, at, status, outcome, ms FROM outgoing_webhook_log WHERE hook_id = $h ORDER BY id DESC;",
            r => new OutgoingDelivery(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt32(4), r.GetInt64(5),
                NullableInt(r, 6), r.GetString(7), r.GetInt32(8)),
            ("$h", hookId));
}
