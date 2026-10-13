namespace Iskra.Server.Storage;

public sealed record Webhook(string Id, long ChannelId, string Name, string? Avatar, string SecretHash, bool Mentions,
    string CreatedBy, long CreatedAt, long? LastUsedAt);

/// <summary>How a webhook message was signed off: the name and avatar it posted with, plus its embeds (JSON).</summary>
public sealed record WebhookPost(long MessageId, string WebhookId, string Name, string? Avatar, string? Embeds);

public sealed partial class Store
{
    private const string BotsMigration = """
        CREATE TABLE bots (
            account_key TEXT PRIMARY KEY,
            invited_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE bot_invites (
            code        TEXT PRIMARY KEY REFERENCES invites(code) ON DELETE CASCADE
        );
        CREATE TABLE webhooks (
            id          TEXT PRIMARY KEY,
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            avatar      TEXT,
            secret_hash TEXT NOT NULL,
            mentions    INTEGER NOT NULL DEFAULT 0,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            last_used_at INTEGER
        );
        CREATE INDEX webhooks_by_channel ON webhooks(channel_id);
        CREATE TABLE webhook_messages (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            webhook_id  TEXT NOT NULL,
            name        TEXT NOT NULL,
            avatar      TEXT,
            embeds      TEXT
        );
        """;

    // ── Bot accounts ─────────────────────────────────────────────────────────

    /// <summary>Bot account → whether it may read all messages (see BotScope).</summary>
    private Dictionary<string, bool>? _bots;

    private Dictionary<string, bool> Bots() =>
        _bots ??= Query("SELECT account_key, read_all FROM bots;", r => (Key: r.GetString(0), ReadAll: r.GetInt64(1) != 0))
            .ToDictionary(b => b.Key, b => b.ReadAll, StringComparer.Ordinal);

    /// <summary>Asked for every member on every broadcast, so it's cached in memory.</summary>
    public bool IsBot(string accountKey)
    {
        lock (_gate) return Bots().ContainsKey(accountKey);
    }

    /// <summary>A bot that may read every message in the channels it can see (people: false).</summary>
    public bool BotReadsAll(string accountKey)
    {
        lock (_gate) return Bots().TryGetValue(accountKey, out var all) && all;
    }

    public void AddBot(string accountKey, string invitedBy, long now, bool readAll = true)
    {
        lock (_gate)
        {
            Exec("INSERT OR IGNORE INTO bots (account_key, invited_by, created_at) VALUES ($key, $by, $now);",
                ("$key", accountKey), ("$by", invitedBy), ("$now", now));
            Exec("UPDATE bots SET read_all = $all WHERE account_key = $key;", ("$key", accountKey), ("$all", readAll ? 1 : 0));
            _bots = null;
        }
    }

    public void SetBotReadAll(string accountKey, bool readAll)
    {
        lock (_gate)
        {
            Exec("UPDATE bots SET read_all = $all WHERE account_key = $key;", ("$key", accountKey), ("$all", readAll ? 1 : 0));
            _bots = null;
        }
    }

    public void MarkBotInvite(string code, bool readAll = false) =>
        Exec("INSERT OR IGNORE INTO bot_invites (code, read_all) VALUES ($code, $all);", ("$code", code), ("$all", readAll ? 1 : 0));

    public bool BotInviteReadsAll(string code) =>
        Scalar("SELECT read_all FROM bot_invites WHERE code = $code;", ("$code", code)) is long all && all != 0;

    public bool IsBotInvite(string code) => Scalar("SELECT 1 FROM bot_invites WHERE code = $code;", ("$code", code)) is not null;

    // ── Webhooks ─────────────────────────────────────────────────────────────

    private const string WebhookColumns = "id, channel_id, name, avatar, secret_hash, mentions, created_by, created_at, last_used_at";

    private static Webhook ReadWebhook(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetInt64(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4), r.GetInt32(5) != 0,
            r.GetString(6), r.GetInt64(7), NullableLong(r, 8));

    public void AddWebhook(Webhook w) =>
        Exec($"INSERT INTO webhooks ({WebhookColumns}) VALUES ($id, $ch, $name, $avatar, $hash, $mentions, $by, $now, NULL);",
            ("$id", w.Id), ("$ch", w.ChannelId), ("$name", w.Name), ("$avatar", w.Avatar), ("$hash", w.SecretHash),
            ("$mentions", w.Mentions ? 1 : 0), ("$by", w.CreatedBy), ("$now", w.CreatedAt));

    public Webhook? GetWebhook(string id) =>
        Query($"SELECT {WebhookColumns} FROM webhooks WHERE id = $id;", ReadWebhook, ("$id", id)).FirstOrDefault();

    public List<Webhook> Webhooks(long? channelId) =>
        Query($"SELECT {WebhookColumns} FROM webhooks WHERE $ch IS NULL OR channel_id = $ch ORDER BY created_at;", ReadWebhook, ("$ch", channelId));

    public int CountWebhooks(long channelId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM webhooks WHERE channel_id = $ch;", ("$ch", channelId)));

    public void UpdateWebhook(Webhook w) =>
        Exec("UPDATE webhooks SET channel_id = $ch, name = $name, avatar = $avatar, secret_hash = $hash, mentions = $mentions WHERE id = $id;",
            ("$id", w.Id), ("$ch", w.ChannelId), ("$name", w.Name), ("$avatar", w.Avatar), ("$hash", w.SecretHash), ("$mentions", w.Mentions ? 1 : 0));

    public void DeleteWebhook(string id) => Exec("DELETE FROM webhooks WHERE id = $id;", ("$id", id));

    /// <summary>Stores a webhook's message and how it was signed, in one step.</summary>
    public Message AddWebhookMessage(Webhook hook, string authorKey, string text, string name, string? embeds, long now)
    {
        lock (_gate)
        {
            // Plain BEGIN/COMMIT: the shared helpers don't take a transaction object, and the lock keeps others out.
            Exec("BEGIN IMMEDIATE;");
            try
            {
                var message = AddMessage(hook.ChannelId, authorKey, text, now);
                Exec("INSERT INTO webhook_messages (message_id, webhook_id, name, avatar, embeds) VALUES ($m, $w, $name, $avatar, $embeds);",
                    ("$m", message.Id), ("$w", hook.Id), ("$name", name), ("$avatar", hook.Avatar), ("$embeds", embeds));
                Exec("UPDATE webhooks SET last_used_at = $now WHERE id = $id;", ("$id", hook.Id), ("$now", now));
                Exec("COMMIT;");
                return message;
            }
            catch
            {
                Exec("ROLLBACK;");
                throw;
            }
        }
    }

    public WebhookPost? GetWebhookPost(long messageId) =>
        Query("SELECT message_id, webhook_id, name, avatar, embeds FROM webhook_messages WHERE message_id = $m;",
            r => new WebhookPost(r.GetInt64(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4)),
            ("$m", messageId)).FirstOrDefault();
}
