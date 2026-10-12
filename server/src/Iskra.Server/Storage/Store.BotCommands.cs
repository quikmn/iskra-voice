namespace Iskra.Server.Storage;

/// <summary>A bot's registered commands (validated JSON), and the cards on bots' messages.</summary>
public sealed record BotCommandList(string AccountKey, string Commands, long UpdatedAt);

public sealed partial class Store
{
    private const string BotCommandsMigration = """
        CREATE TABLE bot_commands (
            account_key TEXT PRIMARY KEY REFERENCES members(account_key) ON DELETE CASCADE,
            commands    TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE bot_cards (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            cards       TEXT NOT NULL,
            files       TEXT
        );
        """;

    // ── Commands ─────────────────────────────────────────────────────────────

    public void SetBotCommands(string accountKey, string? commands, long now)
    {
        if (commands is null) Exec("DELETE FROM bot_commands WHERE account_key = $key;", ("$key", accountKey));
        else
            Exec("""
                INSERT INTO bot_commands (account_key, commands, updated_at) VALUES ($key, $commands, $now)
                ON CONFLICT(account_key) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at;
                """, ("$key", accountKey), ("$commands", commands), ("$now", now));
    }

    /// <summary>Every member bot's list (bots that left are gone with their member row).</summary>
    public List<BotCommandList> AllBotCommands() =>
        Query("SELECT b.account_key, b.commands, b.updated_at FROM bot_commands b JOIN members m ON m.account_key = b.account_key ORDER BY m.name;",
            r => new BotCommandList(r.GetString(0), r.GetString(1), r.GetInt64(2)));

    // ── Cards ────────────────────────────────────────────────────────────────

    /// <summary>Sets (or with null removes) a message's cards; <paramref name="files"/> are the uploads its pictures use.</summary>
    public void SetMessageCards(long messageId, string? cards, IReadOnlyCollection<string> files)
    {
        if (cards is null) Exec("DELETE FROM bot_cards WHERE message_id = $m;", ("$m", messageId));
        else
            Exec("""
                INSERT INTO bot_cards (message_id, cards, files) VALUES ($m, $cards, $files)
                ON CONFLICT(message_id) DO UPDATE SET cards = excluded.cards, files = excluded.files;
                """, ("$m", messageId), ("$cards", cards),
                ("$files", files.Count == 0 ? null : System.Text.Json.JsonSerializer.Serialize(files)));
    }

    public string? GetMessageCards(long messageId) =>
        Scalar("SELECT cards FROM bot_cards WHERE message_id = $m;", ("$m", messageId)) as string;

    /// <summary>Uploads shown in cards, kept by the upload sweep.</summary>
    public List<string> CardFileIds() =>
        Query("SELECT j.value FROM bot_cards c, json_each(c.files) j WHERE c.files IS NOT NULL;", r => r.GetString(0));
}
