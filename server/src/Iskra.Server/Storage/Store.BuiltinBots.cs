namespace Iskra.Server.Storage;

/// <summary>A built-in bot's identity on this server (kept when it's turned off, so its old messages keep their author).</summary>
public sealed record BuiltinBotRow(string Id, string AccountKey, long CreatedAt);

public sealed partial class Store
{
    private const string BuiltinBotsMigration = """
        CREATE TABLE builtin_bots (
            id          TEXT PRIMARY KEY,
            account_key TEXT NOT NULL UNIQUE,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE builtin_replies (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            reply       TEXT NOT NULL
        );
        """;

    private Dictionary<string, string>? _builtinByKey;

    public List<BuiltinBotRow> BuiltinBots() =>
        Query("SELECT id, account_key, created_at FROM builtin_bots ORDER BY id;", r => new BuiltinBotRow(r.GetString(0), r.GetString(1), r.GetInt64(2)));

    /// <summary>Which built-in bot this account is (null for everyone else). Asked for every message and member view, so cached.</summary>
    public string? BuiltinIdOf(string accountKey)
    {
        lock (_gate)
        {
            _builtinByKey ??= BuiltinBots().ToDictionary(b => b.AccountKey, b => b.Id, StringComparer.Ordinal);
            return _builtinByKey.GetValueOrDefault(accountKey);
        }
    }

    /// <summary>The bot's account key, made once (the first time it's turned on) and kept from then on.</summary>
    public string BuiltinBotKey(string id, Func<string> newKey, long now)
    {
        lock (_gate)
        {
            if (Scalar("SELECT account_key FROM builtin_bots WHERE id = $id;", ("$id", id)) is string key) return key;
            key = newKey();
            Exec("INSERT INTO builtin_bots (id, account_key, created_at) VALUES ($id, $key, $now);", ("$id", id), ("$key", key), ("$now", now));
            _builtinByKey?.Add(key, id);
            return key;
        }
    }

    /// <summary>A built-in bot's message and what it means (for apps to show in their own language), in one step.</summary>
    public Message AddBuiltinMessage(long channelId, string authorKey, string text, string reply, long now)
    {
        lock (_gate)
        {
            Exec("BEGIN IMMEDIATE;");
            try
            {
                var message = AddMessage(channelId, authorKey, text, now);
                Exec("INSERT INTO builtin_replies (message_id, reply) VALUES ($m, $reply);", ("$m", message.Id), ("$reply", reply));
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

    public string? GetBuiltinReply(long messageId) =>
        Scalar("SELECT reply FROM builtin_replies WHERE message_id = $m;", ("$m", messageId)) as string;
}
