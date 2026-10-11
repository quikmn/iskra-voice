namespace Iskra.Server.Storage;

/// <summary>One entry of the signed key log (see "Key transparency" in PROTOCOL.md). <c>Data</c> is the exact JSON that was hashed.</summary>
public sealed record KeyLogEntry(long Seq, long At, string Data, byte[] Hash, string Sig);

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

    private static KeyLogEntry ReadKeyLog(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), (byte[])r.GetValue(3), r.GetString(4));

    public KeyLogEntry? KeyLogLast() =>
        Query("SELECT seq, at, data, hash, sig FROM keylog ORDER BY seq DESC LIMIT 1;", ReadKeyLog).FirstOrDefault();

    /// <summary>Entries after <paramref name="after"/>, oldest first.</summary>
    public List<KeyLogEntry> KeyLogEntries(long after, int limit) =>
        Query("SELECT seq, at, data, hash, sig FROM keylog WHERE seq > $a ORDER BY seq LIMIT $n;", ReadKeyLog, ("$a", after), ("$n", limit));

    /// <summary>Every rotation, oldest applied first (the key log follows them).</summary>
    public List<AppliedRotation> AllRotationsForLog() =>
        Query($"SELECT {RotationColumns} FROM account_rotations ORDER BY applied_at, old_key;", ReadRotation);

    public void KeyLogAppend(KeyLogEntry entry) =>
        Exec("INSERT INTO keylog (seq, at, data, hash, sig) VALUES ($s, $at, $d, $h, $sig);",
            ("$s", entry.Seq), ("$at", entry.At), ("$d", entry.Data), ("$h", entry.Hash), ("$sig", entry.Sig));
}
