namespace Iskra.Server.Storage;

/// <summary>The server's icon and banner (ServerImageFeature): one uploaded file each, or none.</summary>
public sealed partial class Store
{
    private const string ServerImagesMigration = """
        CREATE TABLE server_images (
            kind        TEXT PRIMARY KEY CHECK (kind IN ('icon', 'banner')),
            file_id     TEXT NOT NULL,
            set_by      TEXT NOT NULL,
            set_at      INTEGER NOT NULL
        );
        """;

    /// <summary>The icon's or banner's file, or null when there is none (or its file is gone).</summary>
    public StoredFile? GetServerImage(string kind) =>
        Query($"""
            SELECT {string.Join(", ", FileColumns.Split(", ").Select(c => "f." + c))}
            FROM server_images i JOIN files f ON f.id = i.file_id WHERE i.kind = $k;
            """, ReadFile, ("$k", kind)).FirstOrDefault();

    public void SetServerImage(string kind, string fileId, string by, long now) =>
        Exec("""
            INSERT INTO server_images (kind, file_id, set_by, set_at) VALUES ($k, $f, $by, $now)
            ON CONFLICT(kind) DO UPDATE SET file_id = excluded.file_id, set_by = excluded.set_by, set_at = excluded.set_at;
            """, ("$k", kind), ("$f", fileId), ("$by", by), ("$now", now));

    public void ClearServerImage(string kind) => Exec("DELETE FROM server_images WHERE kind = $k;", ("$k", kind));
}
