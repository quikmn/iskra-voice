namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string FileColumns = "id, sha256, name, size, type, width, height, uploader, created_at";

    private static StoredFile ReadFile(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3), r.GetString(4), NullableInt(r, 5), NullableInt(r, 6), r.GetString(7), r.GetInt64(8));

    public void AddFile(StoredFile f) =>
        Exec($"INSERT INTO files ({FileColumns}) VALUES ($id, $sha, $name, $size, $type, $w, $h, $up, $now);",
            ("$id", f.Id), ("$sha", f.Sha256), ("$name", f.Name), ("$size", f.Size), ("$type", f.Type),
            ("$w", f.Width), ("$h", f.Height), ("$up", f.Uploader), ("$now", f.CreatedAt));

    public StoredFile? GetFile(string id) =>
        Query($"SELECT {FileColumns} FROM files WHERE id = $id;", ReadFile, ("$id", id)).FirstOrDefault();

    // ── Reactions ────────────────────────────────────────────────────────────

    public bool SetReaction(long messageId, string accountKey, string emoji, bool on, long now)
    {
        if (on)
        {
            var before = Convert.ToInt32(Scalar("SELECT COUNT(*) FROM reactions WHERE message_id = $m AND account_key = $a AND emoji = $e;",
                ("$m", messageId), ("$a", accountKey), ("$e", emoji)));
            if (before > 0) return false;
            Exec("INSERT INTO reactions (message_id, account_key, emoji, created_at) VALUES ($m, $a, $e, $now);",
                ("$m", messageId), ("$a", accountKey), ("$e", emoji), ("$now", now));
            return true;
        }
        Exec("DELETE FROM reactions WHERE message_id = $m AND account_key = $a AND emoji = $e;", ("$m", messageId), ("$a", accountKey), ("$e", emoji));
        return true;
    }

    public int DistinctReactions(long messageId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = $m;", ("$m", messageId)));

    /// <summary>emoji → who reacted, in the order the emoji were first used.</summary>
    public List<(string Emoji, List<string> Accounts)> Reactions(long messageId) =>
        Query("SELECT emoji, account_key FROM reactions WHERE message_id = $m ORDER BY created_at;", r => (r.GetString(0), r.GetString(1)), ("$m", messageId))
            .GroupBy(x => x.Item1)
            .Select(g => (g.Key, g.Select(x => x.Item2).ToList()))
            .ToList();
}
