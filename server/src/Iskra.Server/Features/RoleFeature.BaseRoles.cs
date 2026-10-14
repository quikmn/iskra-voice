using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The base roles (owner … guest) as apps list them next to custom roles: their colour, and what they can do (from
/// <see cref="BaseRoles"/>, the same table the server's checks use). Both are adjustable, powers within safety rules.
/// </summary>
public static partial class RoleFeature
{
    /// <summary>Highest first.</summary>
    public static List<object> PublicBaseRoles(Store store)
    {
        var colors = store.BaseRoleColors();
        var changed = store.ChangedBasePowers();
        return Roles.All.Reverse().Select(role => PublicBaseRole(role, colors.GetValueOrDefault(role), changed.GetValueOrDefault(role))).ToList();
    }

    private static object PublicBaseRole(string role, string? color, BasePowers? changed)
    {
        var powers = role == Roles.Owner || changed is null ? BaseRoles.Effective(role, null) : changed;
        var (adjustable, adjustablePerms) = BaseRoles.Adjustable(role);
        return new
        {
            id = role,
            color,
            abilities = BaseRoles.Names(powers.Abilities),
            permissions = PermList(powers.Perms),
            changed = changed is not null && role != Roles.Owner,
            defaults = new { abilities = BaseRoles.AbilitiesOf(role), permissions = PermList(BaseRoles.DefaultPerms(role)) },
            adjustable = new { abilities = BaseRoles.Names(adjustable), permissions = PermList(adjustablePerms) },
        };
    }

    private static object PublicBaseRole(Store store, string role) =>
        PublicBaseRole(role, store.BaseRoleColors().GetValueOrDefault(role), store.ChangedBasePowers().GetValueOrDefault(role));

    /// <summary>
    /// `role.base.update`: a base role's colour ("" clears) and/or its powers (`abilities`, `permissions`: the whole set
    /// it should have; or `reset`). Colour: the owner styles any, other role managers those below admin. Powers: never the
    /// owner's role; only roles below your own; only powers you have yourself; within what the role may get.
    /// </summary>
    private static object UpdateBase(Session s, Member me, Body body)
    {
        RequireManager(me);
        var role = body.String("role", 16);
        if (!Roles.IsValid(role)) throw RequestException.BadRequest($"'role' must be one of: {string.Join(", ", Roles.All)}.");
        var store = s.World.Store;
        var reset = body.OptionalBool("reset") == true;
        var powers = reset || body.Has("abilities") || body.Has("permissions");
        if (reset && (body.Has("abilities") || body.Has("permissions")))
            throw RequestException.BadRequest("Send 'reset' or the powers, not both.");

        // Check everything before changing anything.
        string? color = null, colorBefore = null;
        if (body.Has("color"))
        {
            if (!BaseRoles.CanStyle(me, role)) throw RequestException.Forbidden("You can only change built-in roles below your own.", "rank_base_roles");
            colorBefore = store.BaseRoleColors().GetValueOrDefault(role);
            color = Color(body, colorBefore);
        }
        BasePowers? current = null, wanted = null;
        if (powers)
        {
            if (role == Roles.Owner) throw RequestException.Forbidden("The owner can always do everything; that never changes.", "base_role_owner");
            if (!BaseRoles.CanAdjust(me, role)) throw RequestException.Forbidden("You can only change built-in roles below your own.", "rank_base_roles");
            current = BaseRoles.Effective(role, store.BaseRoleChanges().GetValueOrDefault(role));
            wanted = reset ? BaseRoles.Effective(role, null) : new BasePowers(
                body.Has("abilities") ? ParseAbilities(body) : current.Abilities,
                body.Has("permissions") ? ParseBasePerms(body) : current.Perms);
            var changedAbilities = wanted.Abilities ^ current.Abilities;
            var changedPerms = wanted.Perms ^ current.Perms;
            var (adjustable, adjustablePerms) = BaseRoles.Adjustable(role);
            if ((changedAbilities & ~adjustable) != 0 || (changedPerms & ~adjustablePerms) != Perm.None)
                throw RequestException.BadRequest(
                    role is Roles.Guest or Roles.Member
                        ? "Guests and members can only get everyday powers: inviting, events, pinning, mentioning everyone and sounds."
                        : "Some powers always stay with the owner.",
                    "base_power_not_allowed", new { role });
            if ((changedAbilities & ~BaseRoles.AbilitiesOf(me)) != 0 || (changedPerms & ~Permissions.Effective(me)) != Perm.None)
                throw RequestException.Forbidden("You can only give or take powers you have yourself.", "base_power_not_yours");
        }

        var changed = false;
        if (body.Has("color") && color != colorBefore)
        {
            store.SetBaseRoleColor(role, color);
            Audit.Record(s, "role.base", details: new { role, from = colorBefore, to = color });
            changed = true;
        }
        if (current is not null && wanted is not null && wanted != current)
        {
            store.SetBaseRoleChange(role, BaseRoles.ChangeFor(role, wanted.Abilities, wanted.Perms));
            Audit.Record(s, "role.base.powers", details: new
            {
                role, reset,
                added = BaseRoles.Names(wanted.Abilities & ~current.Abilities).Concat(PermList(wanted.Perms & ~current.Perms)),
                removed = BaseRoles.Names(current.Abilities & ~wanted.Abilities).Concat(PermList(current.Perms & ~wanted.Perms)),
            });
            changed = true;
        }
        else if (reset && store.BaseRoleChanges().ContainsKey(role))
        {
            store.SetBaseRoleChange(role, null); // stored changes that no longer change anything
            changed = true;
        }
        if (changed) RolesChanged(s);
        return new { baseRole = PublicBaseRole(store, role) };
    }

    private static long ParseAbilities(Body body)
    {
        var mask = 0L;
        foreach (var name in body.OptionalStringArray("abilities", BaseRoles.Abilities.Count, 32))
            mask |= BaseRoles.TryParse(name, out var ability) ? BaseRoles.Bit(ability) : throw RequestException.BadRequest($"Unknown ability '{name}'.");
        return mask;
    }

    private static Perm ParseBasePerms(Body body)
    {
        var perms = Perm.None;
        foreach (var name in body.OptionalStringArray("permissions", PermNames.Count, 32))
            perms |= PermNames.TryGetValue(name, out var p) ? p : throw RequestException.BadRequest($"Unknown permission '{name}'.");
        return perms;
    }
}
