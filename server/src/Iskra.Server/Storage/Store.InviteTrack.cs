namespace Iskra.Server.Storage;

/// <summary>
/// Which invite a member joined with: its public id (never the code), label, maker and role as they were then, and who
/// let them in when it needed approval. Goes when they stop being a member.
/// </summary>
public sealed record JoinedVia(string AccountKey, string InviteId, string? Label, string? CreatedBy, string Role, string? ApprovedBy, long JoinedAt);

public sealed partial class Store
{
    private const string InviteTrackMigration = """
        ALTER TABLE invites ADD COLUMN label TEXT;
        CREATE TABLE member_invites (
            account_key TEXT PRIMARY KEY,
            invite_id   TEXT NOT NULL,
            label       TEXT,
            created_by  TEXT,
            role        TEXT NOT NULL,
            approved_by TEXT,
            joined_at   INTEGER NOT NULL
        );
        CREATE INDEX member_invites_invite ON member_invites (invite_id, joined_at);
        CREATE TRIGGER member_invites_gone AFTER DELETE ON members BEGIN
            DELETE FROM member_invites WHERE account_key = OLD.account_key;
        END;
        """;

    private const string JoinedViaColumns = "account_key, invite_id, label, created_by, role, approved_by, joined_at";

    private static JoinedVia ReadJoinedVia(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3),
            r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5), r.GetInt64(6));

    public void SaveJoinedVia(JoinedVia j) =>
        Exec($"""
            INSERT INTO member_invites ({JoinedViaColumns}) VALUES ($a, $i, $l, $c, $r, $by, $t)
            ON CONFLICT(account_key) DO UPDATE SET invite_id = excluded.invite_id, label = excluded.label, created_by = excluded.created_by,
                role = excluded.role, approved_by = excluded.approved_by, joined_at = excluded.joined_at;
            """, ("$a", j.AccountKey), ("$i", j.InviteId), ("$l", j.Label), ("$c", j.CreatedBy), ("$r", j.Role), ("$by", j.ApprovedBy), ("$t", j.JoinedAt));

    /// <summary>Current members' joins, newest first, optionally one person's or one invite's.</summary>
    public List<JoinedVia> JoinsVia(string? accountKey, string? inviteId, int limit) =>
        Query($"""
            SELECT {JoinedViaColumns} FROM member_invites
            WHERE ($a IS NULL OR account_key = $a) AND ($i IS NULL OR invite_id = $i)
            ORDER BY joined_at DESC, account_key LIMIT $n;
            """, ReadJoinedVia, ("$a", accountKey), ("$i", inviteId), ("$n", limit));
}
