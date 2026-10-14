using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The base roles (owner … guest) as apps list them next to custom roles: their colour (adjustable), and what they can do
/// (fixed, from <see cref="BaseRoles"/>, the same table the server's checks use).
/// </summary>
public static partial class RoleFeature
{
    /// <summary>Highest first.</summary>
    public static List<object> PublicBaseRoles(Store store)
    {
        var colors = store.BaseRoleColors();
        var all = PermList((Perm)~0L);
        return Roles.All.Reverse().Select(role => (object)new
        {
            id = role,
            color = colors.GetValueOrDefault(role),
            abilities = BaseRoles.AbilitiesOf(role),
            permissions = Roles.Rank(role) >= Roles.Rank(Roles.Admin) ? all : [],
        }).ToList();
    }

    /// <summary>`role.base.update`: a base role's colour ("" clears). The owner styles any; other role managers those below admin.</summary>
    private static object UpdateBase(Session s, Member me, Body body)
    {
        RequireManager(me);
        var role = body.String("role", 16);
        if (!Roles.IsValid(role)) throw RequestException.BadRequest($"'role' must be one of: {string.Join(", ", Roles.All)}.");
        if (!BaseRoles.CanStyle(me, role)) throw RequestException.Forbidden("You can only change built-in roles below your own.", "rank_base_roles");
        var before = s.World.Store.BaseRoleColors().GetValueOrDefault(role);
        var color = Color(body, before);
        if (color != before)
        {
            s.World.Store.SetBaseRoleColor(role, color);
            Audit.Record(s, "role.base", details: new { role, from = before, to = color });
            RolesChanged(s);
        }
        return new { baseRole = PublicBaseRoles(s.World.Store)[Roles.All.Length - 1 - Roles.Rank(role)] };
    }
}
