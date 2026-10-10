namespace Iskra.Server.Storage;

/// <summary>Upload quotas and the sweep of files nothing refers to.</summary>
public sealed partial class Store
{
    private const string SecurityMigration = """
        CREATE INDEX IF NOT EXISTS files_by_uploader ON files(uploader, created_at);
        CREATE INDEX IF NOT EXISTS files_by_sha ON files(sha256);
        """;

    /// <summary>Bytes this account has uploaded since <paramref name="since"/>.</summary>
    public long UploadedBytesSince(string accountKey, long since) =>
        Convert.ToInt64(Scalar("SELECT COALESCE(SUM(size), 0) FROM files WHERE uploader = $a AND created_at >= $since;",
            ("$a", accountKey), ("$since", since)));

    /// <summary>Every profile page's HTML (pages may show this server's files by URL).</summary>
    public List<string> AllPageHtml() => Query("SELECT html FROM profile_pages;", r => r.GetString(0));

    /// <summary>
    /// Deletes file records older than <paramref name="cutoff"/> that no message, avatar, emoji, sound, webhook or
    /// webhook post refers to, nor any id in <paramref name="keep"/>. One statement, so a reference added meanwhile
    /// is respected. Returns the deleted files' hashes.
    /// </summary>
    public List<string> DeleteUnreferencedFiles(long cutoff, IReadOnlyCollection<string> keep) =>
        Query("""
            DELETE FROM files
            WHERE created_at < $cutoff
              AND id NOT IN (SELECT value FROM json_each($keep))
              AND id NOT IN (
                SELECT j.value FROM messages m, json_each(m.attachments) j WHERE m.attachments IS NOT NULL
                UNION SELECT avatar_file FROM profiles WHERE avatar_file IS NOT NULL
                UNION SELECT file_id FROM emojis
                UNION SELECT file_id FROM sounds
                UNION SELECT avatar FROM webhooks WHERE avatar IS NOT NULL
                UNION SELECT avatar FROM webhook_messages WHERE avatar IS NOT NULL)
            RETURNING sha256;
            """, r => r.GetString(0), ("$cutoff", cutoff), ("$keep", System.Text.Json.JsonSerializer.Serialize(keep)));

    public bool ContentInUse(string sha256) =>
        Scalar("SELECT 1 FROM files WHERE sha256 = $sha LIMIT 1;", ("$sha", sha256)) is not null;
}
