namespace Iskra.Server.Storage;

/// <summary>A bot's registered commands (validated JSON), and the cards on bots' messages.</summary>
public sealed record BotCommandList(string AccountKey, string Commands, long UpdatedAt, bool Interactions = false);

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

    public void SetBotCommands(string accountKey, string? commands, long now, bool interactions = false)
    {
        if (commands is null) Exec("DELETE FROM bot_commands WHERE account_key = $key;", ("$key", accountKey));
        else
            Exec("""
                INSERT INTO bot_commands (account_key, commands, updated_at, interactions) VALUES ($key, $commands, $now, $i)
                ON CONFLICT(account_key) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at, interactions = excluded.interactions;
                """, ("$key", accountKey), ("$commands", commands), ("$now", now), ("$i", interactions ? 1 : 0));
    }

    public BotCommandList? GetBotCommands(string accountKey) =>
        Query("SELECT account_key, commands, updated_at, interactions FROM bot_commands WHERE account_key = $key;",
            r => new BotCommandList(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3) != 0), ("$key", accountKey)).FirstOrDefault();

    /// <summary>Every member bot's list (bots that left are gone with their member row).</summary>
    public List<BotCommandList> AllBotCommands() =>
        Query("SELECT b.account_key, b.commands, b.updated_at, b.interactions FROM bot_commands b JOIN members m ON m.account_key = b.account_key ORDER BY m.name;",
            r => new BotCommandList(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3) != 0));

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
