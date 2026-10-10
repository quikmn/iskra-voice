namespace Iskra.Server.Storage;

/// <summary>An end-to-end encrypted DM attachment: opaque ciphertext in uploads/, readable only by the accounts in its access list.</summary>
public sealed record DmFile(string FileId, string Uploader, long? MessageId);

public sealed partial class Store
{
    private const string DmFilesMigration = """
        CREATE TABLE dm_files (
            file_id     TEXT PRIMARY KEY,
            uploader    TEXT NOT NULL,
            message_id  INTEGER
        );
        CREATE INDEX dm_files_message ON dm_files(message_id);
        CREATE TABLE dm_file_access (
            file_id     TEXT NOT NULL,
            account_key TEXT NOT NULL,
            PRIMARY KEY (file_id, account_key)
        );
        """;

    /// <summary>Called when the upload finishes; <paramref name="access"/> is everyone in the conversation (the uploader included).</summary>
    public void AddDmFile(string fileId, string uploader, IEnumerable<string> access)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            using (var cmd = Command("INSERT INTO dm_files (file_id, uploader) VALUES ($f, $u);", [("$f", fileId), ("$u", uploader)]))
            {
                cmd.Transaction = tx;
                cmd.ExecuteNonQuery();
            }
            foreach (var account in access.Distinct())
            {
                using var add = Command("INSERT INTO dm_file_access (file_id, account_key) VALUES ($f, $a);", [("$f", fileId), ("$a", account)]);
                add.Transaction = tx;
                add.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    public DmFile? GetDmFile(string fileId) =>
        Query("SELECT file_id, uploader, message_id FROM dm_files WHERE file_id = $f;",
            r => new DmFile(r.GetString(0), r.GetString(1), NullableLong(r, 2)), ("$f", fileId)).FirstOrDefault();

    public bool CanReadDmFile(string fileId, string accountKey) =>
        Scalar("SELECT 1 FROM dm_file_access WHERE file_id = $f AND account_key = $a;", ("$f", fileId), ("$a", accountKey)) is not null;

    public List<string> DmFileAccess(string fileId) =>
        Query("SELECT account_key FROM dm_file_access WHERE file_id = $f ORDER BY account_key;", r => r.GetString(0), ("$f", fileId));

    /// <summary>Ties uploaded files to the DM that carries them, so the sweep keeps them.</summary>
    public void LinkDmFiles(long messageId, IEnumerable<string> fileIds)
    {
        foreach (var id in fileIds)
            Exec("UPDATE dm_files SET message_id = $m WHERE file_id = $f AND message_id IS NULL;", ("$m", messageId), ("$f", id));
    }

    /// <summary>Access rows of DM files whose upload the sweep removed.</summary>
    public void ForgetDeletedDmFiles() =>
        Exec("""
            DELETE FROM dm_file_access WHERE file_id NOT IN (SELECT id FROM files);
            DELETE FROM dm_files WHERE file_id NOT IN (SELECT id FROM files);
            """);
}
