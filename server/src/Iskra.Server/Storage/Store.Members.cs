namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string MemberColumns = "account_key, name, role, joined_at";

    private static Member ReadMember(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3));

    public Member? GetMember(string accountKey) =>
        Query($"SELECT {MemberColumns} FROM members WHERE account_key = $key;", ReadMember, ("$key", accountKey)).FirstOrDefault();

    public List<Member> AllMembers() =>
        Query($"SELECT {MemberColumns} FROM members ORDER BY joined_at;", ReadMember);

    public int CountMembers() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM members;"));

    public bool HasOwner() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM members WHERE role = 'owner';")) > 0;

    public Member AddMember(string accountKey, string name, string role, long now)
    {
        Exec($"INSERT INTO members ({MemberColumns}) VALUES ($key, $name, $role, $now);",
            ("$key", accountKey), ("$name", name), ("$role", role), ("$now", now));
        return new Member(accountKey, name, role, now);
    }

    public void SetMemberName(string accountKey, string name) =>
        Exec("UPDATE members SET name = $name WHERE account_key = $key;", ("$key", accountKey), ("$name", name));

    public void SetMemberRole(string accountKey, string role) =>
        Exec("UPDATE members SET role = $role WHERE account_key = $key;", ("$key", accountKey), ("$role", role));

    public void RemoveMember(string accountKey) =>
        Exec("DELETE FROM members WHERE account_key = $key;", ("$key", accountKey));

    // ── Bans ─────────────────────────────────────────────────────────────────

    public bool IsBanned(string accountKey) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM bans WHERE account_key = $key;", ("$key", accountKey))) > 0;

    public void AddBan(string accountKey, string reason, string bannedBy, long now) =>
        Exec("""
            INSERT INTO bans (account_key, reason, banned_by, banned_at) VALUES ($key, $reason, $by, $now)
            ON CONFLICT(account_key) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, banned_at = excluded.banned_at;
            """, ("$key", accountKey), ("$reason", reason), ("$by", bannedBy), ("$now", now));

    public bool RemoveBan(string accountKey)
    {
        var before = Convert.ToInt32(Scalar("SELECT COUNT(*) FROM bans WHERE account_key = $key;", ("$key", accountKey)));
        Exec("DELETE FROM bans WHERE account_key = $key;", ("$key", accountKey));
        return before > 0;
    }

    public List<Ban> AllBans() =>
        Query("SELECT account_key, reason, banned_by, banned_at FROM bans ORDER BY banned_at;",
            r => new Ban(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3)));
}
