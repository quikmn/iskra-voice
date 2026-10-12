namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string ProfileSyncMigration = """
        CREATE TABLE profile_stamps (
            account_key TEXT PRIMARY KEY,
            updated_at  INTEGER NOT NULL,
            by          TEXT NOT NULL
        );
        CREATE TRIGGER profilesync_gone AFTER DELETE ON members BEGIN
            DELETE FROM profile_stamps WHERE account_key = old.account_key;
        END;
        """;

    /// <summary>The newest profile stamp this server accepted from the account, if any.</summary>
    public (long UpdatedAt, string By)? GetProfileStamp(string accountKey) =>
        Query("SELECT updated_at, by FROM profile_stamps WHERE account_key = $key;",
            r => ((long, string)?)(r.GetInt64(0), r.GetString(1)), ("$key", accountKey)).FirstOrDefault();

    /// <summary>Records the stamp unless a newer one is stored (one statement, so two sessions can't race). Returns whether it was taken.</summary>
    public bool TryAcceptProfileStamp(string accountKey, long updatedAt, string by) =>
        Scalar("""
            INSERT INTO profile_stamps (account_key, updated_at, by) VALUES ($key, $at, $by)
            ON CONFLICT(account_key) DO UPDATE SET updated_at = excluded.updated_at, by = excluded.by
            WHERE (excluded.updated_at, excluded.by) >= (profile_stamps.updated_at, profile_stamps.by)
            RETURNING 1;
            """, ("$key", accountKey), ("$at", updatedAt), ("$by", by)) is not null;

    /// <summary>The account's own page, for its other devices.</summary>
    public ProfilePage? GetPageOf(string accountKey) =>
        Query("SELECT account_key, page_id, html, sha256, updated_at FROM profile_pages WHERE account_key = $key;",
            r => new ProfilePage(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4)), ("$key", accountKey)).FirstOrDefault();
}
