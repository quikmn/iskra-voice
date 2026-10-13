namespace Iskra.Server.Storage;

/// <summary>
/// One entry of the signed key log (see "Key transparency" in PROTOCOL.md). <c>Data</c> is the exact JSON that was hashed.
/// A join or name entry commits to the name with a salted hash; <c>Name</c> and <c>NameSalt</c> open it, and are erased
/// when the account is deleted (the entry itself, and so the chain, stays).
/// </summary>
public sealed record KeyLogEntry(long Seq, long At, string Data, byte[] Hash, string Sig, string? Name = null, byte[]? NameSalt = null);

public sealed partial class Store
{
    // No *_key / *_by columns on purpose: a key rotation rewrites those, and this log must never change.
    private const string KeyLogMigration = """
        CREATE TABLE keylog (
            seq   INTEGER PRIMARY KEY,
            at    INTEGER NOT NULL,
            data  TEXT NOT NULL,
            hash  BLOB NOT NULL,
            sig   TEXT NOT NULL
        );
        """;

    /// <summary>The name a join/name entry commits to, kept beside it (not hashed) so deleting an account can erase it.</summary>
    private const string KeyLog2Migration = """
        ALTER TABLE keylog ADD COLUMN name TEXT;
        ALTER TABLE keylog ADD COLUMN name_salt BLOB;
        """;

    private const string KeyLogColumns = "seq, at, data, hash, sig, name, name_salt";

    private static KeyLogEntry ReadKeyLog(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), (byte[])r.GetValue(3), r.GetString(4),
            r.IsDBNull(5) ? null : r.GetString(5), r.IsDBNull(6) ? null : (byte[])r.GetValue(6));

    public KeyLogEntry? KeyLogLast() =>
        Query($"SELECT {KeyLogColumns} FROM keylog ORDER BY seq DESC LIMIT 1;", ReadKeyLog).FirstOrDefault();

    /// <summary>Entries after <paramref name="after"/>, oldest first.</summary>
    public List<KeyLogEntry> KeyLogEntries(long after, int limit) =>
        Query($"SELECT {KeyLogColumns} FROM keylog WHERE seq > $a ORDER BY seq LIMIT $n;", ReadKeyLog, ("$a", after), ("$n", limit));

    /// <summary>
    /// Erases the names (and salts) logged for an account and the keys it rotated away from. Runs inside DeleteAccount.
    /// Entries from before name commitments carry the name in the hashed data and can't change without breaking the chain.
    /// </summary>
    private const string KeyLogForgetNames = """
        WITH RECURSIVE keys(k) AS (SELECT $k UNION SELECT old_key FROM account_rotations JOIN keys ON new_key = keys.k)
        UPDATE keylog SET name = NULL, name_salt = NULL
        WHERE name IS NOT NULL AND json_extract(data, '$.key') IN (SELECT k FROM keys)
        """;

    /// <summary>Every rotation, oldest applied first (the key log follows them).</summary>
    public List<AppliedRotation> AllRotationsForLog() =>
        Query($"SELECT {RotationColumns} FROM account_rotations ORDER BY applied_at, old_key;", ReadRotation);

    public void KeyLogAppend(KeyLogEntry entry) =>
        Exec("INSERT INTO keylog (seq, at, data, hash, sig, name, name_salt) VALUES ($s, $at, $d, $h, $sig, $name, $salt);",
            ("$s", entry.Seq), ("$at", entry.At), ("$d", entry.Data), ("$h", entry.Hash), ("$sig", entry.Sig), ("$name", entry.Name), ("$salt", entry.NameSalt));
}
