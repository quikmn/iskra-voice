namespace Iskra.Server.Storage;

/// <summary>A starboard card: the starred message, the bot's card about it (null once someone deleted the card) and the count it shows.</summary>
public sealed record StarboardCard(long SourceId, long? CardId, long BoardChannelId, int Count);

/// <summary>A member's birthday (day and month only, never a year), and the last year it was announced.</summary>
public sealed record Birthday(string AccountKey, int Month, int Day, long SetAt, int? LastPostedYear);

public sealed partial class Store
{
    // Starboard, Birthdays and Welcome. Birthdays and waiting welcomes go with the member (left, kicked, banned, deleted).
    // A starred message that's deleted takes its card with it (any way it goes: by hand, retention, disappearing).
    private const string BuiltinBots2Migration = """
        CREATE TABLE builtin_bot_config (
            id          TEXT PRIMARY KEY,
            config      TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE starboard_cards (
            source_id   INTEGER PRIMARY KEY,
            card_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
            board_id    INTEGER NOT NULL,
            count       INTEGER NOT NULL
        );
        CREATE INDEX starboard_cards_card ON starboard_cards(card_id);
        CREATE TRIGGER starboard_source_gone AFTER DELETE ON messages BEGIN
            DELETE FROM messages WHERE id IN (SELECT card_id FROM starboard_cards WHERE source_id = OLD.id);
            DELETE FROM starboard_cards WHERE source_id = OLD.id;
        END;
        CREATE TABLE birthdays (
            account_key      TEXT PRIMARY KEY REFERENCES members(account_key) ON DELETE CASCADE,
            month            INTEGER NOT NULL,
            day              INTEGER NOT NULL,
            set_at           INTEGER NOT NULL,
            last_posted_year INTEGER
        );
        CREATE TABLE welcome_pending (
            account_key TEXT PRIMARY KEY REFERENCES members(account_key) ON DELETE CASCADE,
            joined_at   INTEGER NOT NULL
        );
        """;

    // ── Config ───────────────────────────────────────────────────────────────

    public string? BuiltinBotConfig(string id) =>
        Scalar("SELECT config FROM builtin_bot_config WHERE id = $id;", ("$id", id)) as string;

    public void SetBuiltinBotConfig(string id, string config, long now) =>
        Exec("""
            INSERT INTO builtin_bot_config (id, config, updated_at) VALUES ($id, $config, $now)
            ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at;
            """, ("$id", id), ("$config", config), ("$now", now));

    /// <summary>Changes a built-in bot's message and what it means together (no "edited" mark: the bot keeps its card current).</summary>
    public void UpdateBuiltinMessage(long messageId, string text, string reply)
    {
        lock (_gate)
        {
            Exec("BEGIN IMMEDIATE;");
            try
            {
                Exec("UPDATE messages SET text = $text WHERE id = $id;", ("$id", messageId), ("$text", text));
                Exec("UPDATE builtin_replies SET reply = $reply WHERE message_id = $id;", ("$id", messageId), ("$reply", reply));
                Exec("COMMIT;");
            }
            catch
            {
                Exec("ROLLBACK;");
                throw;
            }
        }
    }

    // ── Starboard ────────────────────────────────────────────────────────────

    public StarboardCard? GetStarboardCard(long sourceId) =>
        Query("SELECT source_id, card_id, board_id, count FROM starboard_cards WHERE source_id = $s;",
            r => new StarboardCard(r.GetInt64(0), r.IsDBNull(1) ? null : r.GetInt64(1), r.GetInt64(2), r.GetInt32(3)), ("$s", sourceId)).FirstOrDefault();

    public bool IsStarboardCard(long messageId) =>
        Scalar("SELECT 1 FROM starboard_cards WHERE card_id = $m;", ("$m", messageId)) is not null;

    public void SaveStarboardCard(StarboardCard card) =>
        Exec("""
            INSERT INTO starboard_cards (source_id, card_id, board_id, count) VALUES ($s, $c, $b, $n)
            ON CONFLICT(source_id) DO UPDATE SET card_id = excluded.card_id, board_id = excluded.board_id, count = excluded.count;
            """, ("$s", card.SourceId), ("$c", card.CardId), ("$b", card.BoardChannelId), ("$n", card.Count));

    public void DeleteStarboardCard(long sourceId) => Exec("DELETE FROM starboard_cards WHERE source_id = $s;", ("$s", sourceId));

    // ── Birthdays ────────────────────────────────────────────────────────────

    private static Birthday ReadBirthday(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetInt32(1), r.GetInt32(2), r.GetInt64(3), r.IsDBNull(4) ? null : r.GetInt32(4));

    public Birthday? GetBirthday(string accountKey) =>
        Query("SELECT account_key, month, day, set_at, last_posted_year FROM birthdays WHERE account_key = $k;", ReadBirthday, ("$k", accountKey)).FirstOrDefault();

    public List<Birthday> AllBirthdays() =>
        Query("SELECT account_key, month, day, set_at, last_posted_year FROM birthdays ORDER BY month, day;", ReadBirthday);

    /// <summary>Saves the date; the year it was last announced stays (once a year per person, whatever the date).</summary>
    public void SetBirthday(string accountKey, int month, int day, long now) =>
        Exec("""
            INSERT INTO birthdays (account_key, month, day, set_at) VALUES ($k, $m, $d, $now)
            ON CONFLICT(account_key) DO UPDATE SET month = excluded.month, day = excluded.day, set_at = excluded.set_at;
            """, ("$k", accountKey), ("$m", month), ("$d", day), ("$now", now));

    public bool RemoveBirthday(string accountKey)
    {
        lock (_gate)
        {
            var had = Scalar("SELECT 1 FROM birthdays WHERE account_key = $k;", ("$k", accountKey)) is not null;
            Exec("DELETE FROM birthdays WHERE account_key = $k;", ("$k", accountKey));
            return had;
        }
    }

    public void BirthdayPosted(string accountKey, int year) =>
        Exec("UPDATE birthdays SET last_posted_year = $y WHERE account_key = $k;", ("$k", accountKey), ("$y", year));

    // ── Welcome ──────────────────────────────────────────────────────────────

    public void AddWelcomePending(string accountKey, long now) =>
        Exec("INSERT OR IGNORE INTO welcome_pending (account_key, joined_at) VALUES ($k, $now);", ("$k", accountKey), ("$now", now));

    /// <summary>True (and forgotten) when this member was waiting to be welcomed.</summary>
    public bool TakeWelcomePending(string accountKey)
    {
        lock (_gate)
        {
            var had = Scalar("SELECT 1 FROM welcome_pending WHERE account_key = $k;", ("$k", accountKey)) is not null;
            if (had) Exec("DELETE FROM welcome_pending WHERE account_key = $k;", ("$k", accountKey));
            return had;
        }
    }
}
