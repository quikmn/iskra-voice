namespace Iskra.Server.Storage;

/// <summary>How the base roles (guest … owner) look: their colour. Their powers are fixed (Sessions/BaseRoles.cs).</summary>
public sealed partial class Store
{
    private const string BaseRolesMigration = """
        CREATE TABLE base_role_styles (
            role        TEXT PRIMARY KEY,
            color       TEXT
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
}
