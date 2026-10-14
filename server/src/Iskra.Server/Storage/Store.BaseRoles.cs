using Iskra.Server.Sessions;

namespace Iskra.Server.Storage;

/// <summary>What a base role can do on this server, when it differs from the defaults (Sessions/BaseRoles.cs).</summary>
public sealed record BasePowers(long Abilities, Perm Perms);

/// <summary>A base role's powers as changes from its defaults, so abilities added later follow their defaults.</summary>
public sealed record BaseRoleChange(string[] GrantAbilities, string[] RevokeAbilities, Perm GrantPerms, Perm RevokePerms);

/// <summary>How the base roles (guest … owner) look (their colour) and any changes to what they can do.</summary>
public sealed partial class Store
{
    private const string BaseRolesMigration = """
        CREATE TABLE base_role_styles (
            role        TEXT PRIMARY KEY,
            color       TEXT
        );
        """;

    private const string BaseRolePowersMigration = """
        CREATE TABLE base_role_powers (
            role             TEXT PRIMARY KEY,
            grant_abilities  TEXT NOT NULL DEFAULT '',
            revoke_abilities TEXT NOT NULL DEFAULT '',
            grant_perms      INTEGER NOT NULL DEFAULT 0,
            revoke_perms     INTEGER NOT NULL DEFAULT 0
        );
        """;

    /// <summary>Base role → colour, for the roles that have one.</summary>
    public Dictionary<string, string> BaseRoleColors() =>
        Query("SELECT role, color FROM base_role_styles WHERE color IS NOT NULL;", r => (r.GetString(0), r.GetString(1)))
            .ToDictionary(x => x.Item1, x => x.Item2);

    /// <summary>null clears.</summary>
    public void SetBaseRoleColor(string role, string? color)
    {
        if (color is null) Exec("DELETE FROM base_role_styles WHERE role = $r;", ("$r", role));
        else Exec("INSERT INTO base_role_styles (role, color) VALUES ($r, $c) ON CONFLICT(role) DO UPDATE SET color = excluded.color;", ("$r", role), ("$c", color));
    }

    // ── Powers ───────────────────────────────────────────────────────────────

    private static string[] SplitNames(string raw) => raw.Split(',', StringSplitOptions.RemoveEmptyEntries);

    /// <summary>Base roles whose powers were changed, with the changes.</summary>
    public Dictionary<string, BaseRoleChange> BaseRoleChanges() =>
        Query("SELECT role, grant_abilities, revoke_abilities, grant_perms, revoke_perms FROM base_role_powers;",
                r => (r.GetString(0), new BaseRoleChange(SplitNames(r.GetString(1)), SplitNames(r.GetString(2)), (Perm)r.GetInt64(3), (Perm)r.GetInt64(4))))
            .ToDictionary(x => x.Item1, x => x.Item2);

    /// <summary>null (or no change at all) goes back to the defaults.</summary>
    public void SetBaseRoleChange(string role, BaseRoleChange? change)
    {
        if (change is null || (change.GrantAbilities.Length == 0 && change.RevokeAbilities.Length == 0 && change.GrantPerms == Perm.None && change.RevokePerms == Perm.None))
            Exec("DELETE FROM base_role_powers WHERE role = $r;", ("$r", role));
        else
            Exec("""
                INSERT INTO base_role_powers (role, grant_abilities, revoke_abilities, grant_perms, revoke_perms) VALUES ($r, $ga, $ra, $gp, $rp)
                ON CONFLICT(role) DO UPDATE SET grant_abilities = excluded.grant_abilities, revoke_abilities = excluded.revoke_abilities,
                    grant_perms = excluded.grant_perms, revoke_perms = excluded.revoke_perms;
                """, ("$r", role), ("$ga", string.Join(',', change.GrantAbilities)), ("$ra", string.Join(',', change.RevokeAbilities)),
                ("$gp", (long)change.GrantPerms), ("$rp", (long)change.RevokePerms));
        _basePowers = null;
    }

    /// <summary>Effective powers of the changed base roles (cached: every member lookup needs them).</summary>
    private volatile Dictionary<string, BasePowers>? _basePowers;

    public Dictionary<string, BasePowers> ChangedBasePowers() =>
        _basePowers ??= BaseRoleChanges().ToDictionary(c => c.Key, c => BaseRoles.Effective(c.Key, c.Value));

    /// <summary>Attaches the member's base role powers when they differ from the defaults.</summary>
    private Member WithBase(Member m) =>
        ChangedBasePowers().TryGetValue(m.Role, out var powers) ? m with { Base = powers } : m;
}
