namespace Iskra.Server.Storage;

/// <summary>What everyone may see of a member's profile (no page HTML: that is served over HTTP).</summary>
public sealed record PublicProfile(string? Bio, string? Pronouns, string? Accent, StoredFile? Avatar, string? PageId, string? PageSha256);

public sealed record ProfilePage(string AccountKey, string PageId, string Html, string Sha256, long UpdatedAt);

public sealed partial class Store
{
    public PublicProfile GetPublicProfile(string accountKey) =>
        Query($"""
            SELECT p.bio, p.pronouns, p.accent, pg.page_id, pg.sha256, {string.Join(", ", FileColumns.Split(", ").Select(c => "f." + c))}
            FROM (SELECT $key AS k) x
            LEFT JOIN profiles p ON p.account_key = x.k
            LEFT JOIN files f ON f.id = p.avatar_file
            LEFT JOIN profile_pages pg ON pg.account_key = x.k;
            """,
            r => new PublicProfile(
                ProfileText(r, 0), ProfileText(r, 1), ProfileText(r, 2),
                r.IsDBNull(5) ? null : new StoredFile(r.GetString(5), r.GetString(6), r.GetString(7), r.GetInt64(8), r.GetString(9),
                    NullableInt(r, 10), NullableInt(r, 11), r.GetString(12), r.GetInt64(13)),
                ProfileText(r, 3), ProfileText(r, 4)),
            ("$key", accountKey)).Single();

    /// <summary>Updates the given fields; null leaves a field as it is, "" clears it.</summary>
    public void UpdateProfile(string accountKey, string? bio = null, string? pronouns = null, string? accent = null, string? avatarFile = null)
    {
        Exec("""
            INSERT INTO profiles (account_key) VALUES ($key) ON CONFLICT(account_key) DO NOTHING;
            UPDATE profiles SET
                bio = CASE WHEN $bio IS NULL THEN bio ELSE NULLIF($bio, '') END,
                pronouns = CASE WHEN $pronouns IS NULL THEN pronouns ELSE NULLIF($pronouns, '') END,
                accent = CASE WHEN $accent IS NULL THEN accent ELSE NULLIF($accent, '') END,
                avatar_file = CASE WHEN $avatar IS NULL THEN avatar_file ELSE NULLIF($avatar, '') END
            WHERE account_key = $key;
            """, ("$key", accountKey), ("$bio", bio), ("$pronouns", pronouns), ("$accent", accent), ("$avatar", avatarFile));
    }

    // ── Pages ────────────────────────────────────────────────────────────────

    public ProfilePage? GetPageById(string pageId) =>
        Query("SELECT account_key, page_id, html, sha256, updated_at FROM profile_pages WHERE page_id = $id;",
            r => new ProfilePage(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4)), ("$id", pageId)).FirstOrDefault();

    /// <summary>Publishing gives the page a new id, so old links (and caches) stop working.</summary>
    public void SetPage(string accountKey, string pageId, string html, string sha256, long now) =>
        Exec("""
            INSERT INTO profile_pages (account_key, page_id, html, sha256, updated_at) VALUES ($key, $id, $html, $sha, $now)
            ON CONFLICT(account_key) DO UPDATE SET page_id = excluded.page_id, html = excluded.html, sha256 = excluded.sha256, updated_at = excluded.updated_at;
            """, ("$key", accountKey), ("$id", pageId), ("$html", html), ("$sha", sha256), ("$now", now));

    public bool RemovePage(string accountKey)
    {
        var before = Convert.ToInt32(Scalar("SELECT COUNT(*) FROM profile_pages WHERE account_key = $key;", ("$key", accountKey)));
        Exec("DELETE FROM profile_pages WHERE account_key = $key;", ("$key", accountKey));
        return before > 0;
    }

    public List<string> AccountsWithPages() => Query("SELECT account_key FROM profile_pages;", r => r.GetString(0));

    // ── Options ──────────────────────────────────────────────────────────────

    public string? GetProfileOption(string name) =>
        Scalar("SELECT value FROM profile_options WHERE name = $n;", ("$n", name)) as string;

    public void SetProfileOption(string name, string value) =>
        Exec("INSERT INTO profile_options (name, value) VALUES ($n, $v) ON CONFLICT(name) DO UPDATE SET value = excluded.value;",
            ("$n", name), ("$v", value));

    private static string? ProfileText(Microsoft.Data.Sqlite.SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
}
