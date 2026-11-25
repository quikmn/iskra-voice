namespace Iskra.Server.Storage;

/// <summary>
/// A member's calendar feed: the address their calendar app fetches this server's events from (CalendarFeature).
/// Only a SHA-256 hash of the token in that address is kept.
/// </summary>
public sealed record CalendarFeed(string AccountKey, string TokenHash, long CreatedAt, long? FetchedAt);

public sealed partial class Store
{
    /// <summary>
    /// calendar-1: when an event last changed and how often (SEQUENCE and LAST-MODIFIED in calendar feeds), one feed per
    /// member (gone with the member), and whether the owner allows feeds.
    /// </summary>
    private const string CalendarMigration = """
        ALTER TABLE events ADD COLUMN updated_at INTEGER;
        ALTER TABLE events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE calendar_feeds (
            account_key TEXT PRIMARY KEY REFERENCES members(account_key) ON DELETE CASCADE,
            token_hash  TEXT NOT NULL UNIQUE,
            created_at  INTEGER NOT NULL,
            fetched_at  INTEGER
        );
        CREATE TABLE calendar_settings (
            id    INTEGER PRIMARY KEY CHECK (id = 1),
            feeds INTEGER NOT NULL DEFAULT 1
        );
        """;

    private static CalendarFeed ReadCalendarFeed(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetInt64(2), NullableLong(r, 3));

    public CalendarFeed? GetCalendarFeed(string accountKey) =>
        Query("SELECT account_key, token_hash, created_at, fetched_at FROM calendar_feeds WHERE account_key = $k;", ReadCalendarFeed, ("$k", accountKey)).FirstOrDefault();

    public CalendarFeed? CalendarFeedByHash(string tokenHash) =>
        Query("SELECT account_key, token_hash, created_at, fetched_at FROM calendar_feeds WHERE token_hash = $h;", ReadCalendarFeed, ("$h", tokenHash)).FirstOrDefault();

    /// <summary>Sets the member's feed token; one they had before stops working.</summary>
    public void SetCalendarFeed(string accountKey, string tokenHash, long now) =>
        Exec("""
            INSERT INTO calendar_feeds (account_key, token_hash, created_at) VALUES ($k, $h, $now)
            ON CONFLICT(account_key) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, fetched_at = NULL;
            """, ("$k", accountKey), ("$h", tokenHash), ("$now", now));

    public void RemoveCalendarFeed(string accountKey) =>
        Exec("DELETE FROM calendar_feeds WHERE account_key = $k;", ("$k", accountKey));

    public void RemoveAllCalendarFeeds() => Exec("DELETE FROM calendar_feeds;");

    public void CalendarFeedFetched(string accountKey, long now) =>
        Exec("UPDATE calendar_feeds SET fetched_at = $now WHERE account_key = $k;", ("$k", accountKey), ("$now", now));

    /// <summary>Whether members may make calendar feeds (the owner's choice; allowed unless turned off).</summary>
    public bool CalendarFeedsAllowed() =>
        Scalar("SELECT feeds FROM calendar_settings WHERE id = 1;") is not { } value || Convert.ToInt64(value) != 0;

    public void SetCalendarFeedsAllowed(bool allowed) =>
        Exec("INSERT INTO calendar_settings (id, feeds) VALUES (1, $f) ON CONFLICT(id) DO UPDATE SET feeds = excluded.feeds;", ("$f", allowed ? 1 : 0));

    /// <summary>Every event the server still has (open ones, and ended or cancelled ones from the last 30 days), oldest first.</summary>
    public List<ServerEvent> AllEvents() =>
        Query($"SELECT {EventColumns} FROM events ORDER BY start_at, id;", ReadEvent);
}
