namespace Iskra.Server.Storage;

/// <summary>Per-server avatars (MemberAvatarFeature): a picture shown instead of the profile picture on this server only.</summary>
public sealed partial class Store
{
    private const string MemberAvatarsMigration = """
        CREATE TABLE member_avatars (
            account_key TEXT PRIMARY KEY,
            file_id     TEXT NOT NULL,
            set_at      INTEGER NOT NULL
        );
        CREATE TRIGGER member_avatar_gone AFTER DELETE ON members BEGIN
            DELETE FROM member_avatars WHERE account_key = old.account_key;
        END;
        """;

    private static string FileColumnsOf(string alias) => string.Join(", ", FileColumns.Split(", ").Select(c => alias + "." + c));

    /// <summary>A file's columns starting at <paramref name="o"/> (after other columns in the same row).</summary>
    private static StoredFile ReadFileFrom(Microsoft.Data.Sqlite.SqliteDataReader r, int o) =>
        new(r.GetString(o), r.GetString(o + 1), r.GetString(o + 2), r.GetInt64(o + 3), r.GetString(o + 4), NullableInt(r, o + 5), NullableInt(r, o + 6), r.GetString(o + 7), r.GetInt64(o + 8));

    /// <summary>The member's picture on this server, or null (none, or its file is gone).</summary>
    public StoredFile? GetMemberAvatar(string accountKey) =>
        Query($"SELECT {FileColumnsOf("f")} FROM member_avatars a JOIN files f ON f.id = a.file_id WHERE a.account_key = $k;", ReadFile, ("$k", accountKey)).FirstOrDefault();

    /// <summary>Everyone's, for the member list in one query.</summary>
    public Dictionary<string, StoredFile> AllMemberAvatars() =>
        Query($"SELECT a.account_key, {FileColumnsOf("f")} FROM member_avatars a JOIN files f ON f.id = a.file_id;",
            r => (Key: r.GetString(0), File: ReadFileFrom(r, 1))).ToDictionary(x => x.Key, x => x.File);

    public void SetMemberAvatar(string accountKey, string fileId, long now) =>
        Exec("""
            INSERT INTO member_avatars (account_key, file_id, set_at) VALUES ($k, $f, $now)
            ON CONFLICT(account_key) DO UPDATE SET file_id = excluded.file_id, set_at = excluded.set_at;
            """, ("$k", accountKey), ("$f", fileId), ("$now", now));

    public void ClearMemberAvatar(string accountKey) => Exec("DELETE FROM member_avatars WHERE account_key = $k;", ("$k", accountKey));
}
