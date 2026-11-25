namespace Iskra.Server.Storage;

/// <summary>A read receipt as the server keeps it: who sent it to whom (or to which group), when, and a sealed envelope.</summary>
public sealed record DmReceipt(string From, string To, string Envelope, long At);

public sealed record GroupReceipt(string GroupId, string From, long Version, string Envelope, long At);

/// <summary>
/// Read receipts for DMs and group DMs (ReceiptFeature). One row per reader and conversation: a new receipt replaces the
/// last one. The envelope is end-to-end encrypted like a message; the server can't read which message it names.
/// </summary>
public sealed partial class Store
{
    private const string ReceiptsMigration = """
        CREATE TABLE dm_receipts (
            from_key TEXT NOT NULL,
            to_key   TEXT NOT NULL,
            envelope TEXT NOT NULL,
            at       INTEGER NOT NULL,
            PRIMARY KEY (from_key, to_key)
        );
        CREATE INDEX dm_receipts_to ON dm_receipts(to_key);
        CREATE TABLE group_receipts (
            group_id TEXT NOT NULL,
            from_key TEXT NOT NULL,
            version  INTEGER NOT NULL,
            envelope TEXT NOT NULL,
            at       INTEGER NOT NULL,
            PRIMARY KEY (group_id, from_key)
        );
        CREATE TRIGGER group_receipts_group_gone AFTER DELETE ON groups BEGIN
            DELETE FROM group_receipts WHERE group_id = old.id;
        END;
        """;

    public void SaveDmReceipt(string from, string to, string envelope, long now) =>
        Exec("""
            INSERT INTO dm_receipts (from_key, to_key, envelope, at) VALUES ($f, $t, $e, $now)
            ON CONFLICT(from_key, to_key) DO UPDATE SET envelope = excluded.envelope, at = excluded.at;
            """, ("$f", from), ("$t", to), ("$e", envelope), ("$now", now));

    /// <summary>The newest receipt each person sent to <paramref name="to"/>, newest first.</summary>
    public List<DmReceipt> DmReceiptsFor(string to, int limit) =>
        Query("SELECT from_key, to_key, envelope, at FROM dm_receipts WHERE to_key = $t ORDER BY at DESC LIMIT $n;",
            r => new DmReceipt(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3)), ("$t", to), ("$n", limit));

    public void SaveGroupReceipt(string groupId, string from, long version, string envelope, long now) =>
        Exec("""
            INSERT INTO group_receipts (group_id, from_key, version, envelope, at) VALUES ($g, $f, $v, $e, $now)
            ON CONFLICT(group_id, from_key) DO UPDATE SET version = excluded.version, envelope = excluded.envelope, at = excluded.at;
            """, ("$g", groupId), ("$f", from), ("$v", version), ("$e", envelope), ("$now", now));

    /// <summary>The newest receipt of each person in a group.</summary>
    public List<GroupReceipt> GroupReceipts(string groupId) =>
        Query("SELECT group_id, from_key, version, envelope, at FROM group_receipts WHERE group_id = $g ORDER BY at DESC;",
            r => new GroupReceipt(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3), r.GetInt64(4)), ("$g", groupId));
}
