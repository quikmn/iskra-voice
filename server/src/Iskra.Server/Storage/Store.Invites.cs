namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string InviteColumns = "code, created_by, created_at, expires_at, max_uses, uses, role, revoked, approve, label";

    private static Invite ReadInvite(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetInt64(2), NullableLong(r, 3), NullableInt(r, 4), r.GetInt32(5), r.GetString(6), r.GetInt32(7) != 0)
        { Approve = r.GetInt64(8) != 0, Label = r.IsDBNull(9) ? null : r.GetString(9) };

    public Invite CreateInvite(string code, string createdBy, string role, long now, long? expiresAt, int? maxUses, bool approve = false, string? label = null)
    {
        Exec($"""
            INSERT INTO invites (code, created_by, created_at, expires_at, max_uses, role, approve, label)
            VALUES ($code, $by, $now, $exp, $max, $role, $approve, $label);
            """, ("$code", code), ("$by", createdBy), ("$now", now), ("$exp", expiresAt), ("$max", maxUses), ("$role", role), ("$approve", approve ? 1 : 0), ("$label", label));
        return new Invite(code, createdBy, now, expiresAt, maxUses, 0, role, false) { Approve = approve, Label = label };
    }

    public Invite? GetInvite(string code) =>
        Query($"SELECT {InviteColumns} FROM invites WHERE code = $code;", ReadInvite, ("$code", code)).FirstOrDefault();

    /// <summary>Invites that can still be used, newest first.</summary>
    public List<Invite> ActiveInvites(long now) =>
        Query($"""
            SELECT {InviteColumns} FROM invites
            WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > $now) AND (max_uses IS NULL OR uses < max_uses)
            ORDER BY created_at DESC;
            """, ReadInvite, ("$now", now));

    public void RevokeInvite(string code) => Exec("UPDATE invites SET revoked = 1 WHERE code = $code;", ("$code", code));

    /// <summary>Checks and uses an invite in one step (so two people can't both take the last use). Returns it, or null.</summary>
    public Invite? TryUseInvite(string code, long now)
    {
        lock (_gate)
        {
            var invite = GetInvite(code);
            if (invite is null || invite.Revoked) return null;
            if (invite.ExpiresAt is { } exp && exp <= now) return null;
            if (invite.MaxUses is { } max && invite.Uses >= max) return null;
            Exec("UPDATE invites SET uses = uses + 1 WHERE code = $code;", ("$code", code));
            return invite with { Uses = invite.Uses + 1 };
        }
    }
}
