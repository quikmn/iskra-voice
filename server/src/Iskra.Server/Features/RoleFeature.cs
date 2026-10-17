using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Custom roles on top of the levels (guest … owner): named, coloured, ordered, granting permissions, with per-channel
/// overrides. People who can manage roles only touch roles below their own highest one, and only grant permissions they have.
/// Also voice moderation (server mute, move), which these permissions unlock.
/// </summary>
public static partial class RoleFeature
{
    public const int MaxRoles = 100;
    public const int MaxIconLength = 16;

    public static readonly IReadOnlyDictionary<string, Perm> PermNames = new Dictionary<string, Perm>
    {
        ["manageMessages"] = Perm.ManageMessages,
        ["timeoutMembers"] = Perm.TimeoutMembers,
        ["kickMembers"] = Perm.KickMembers,
        ["banMembers"] = Perm.BanMembers,
        ["manageChannels"] = Perm.ManageChannels,
        ["manageRoles"] = Perm.ManageRoles,
        ["viewAuditLog"] = Perm.ViewAuditLog,
        ["manageExpressions"] = Perm.ManageExpressions,
        ["manageWebhooks"] = Perm.ManageWebhooks,
        ["mentionEveryone"] = Perm.MentionEveryone,
        ["moveMembers"] = Perm.MoveMembers,
        ["muteMembers"] = Perm.MuteMembers,
        ["manageAutoMod"] = Perm.ManageAutoMod,
        ["prioritySpeaker"] = Perm.PrioritySpeaker,
        ["sendTts"] = Perm.SendTts,
        ["exportChannels"] = Perm.ExportChannels,
    };

    private static readonly IReadOnlyDictionary<string, ChannelPerm> ChannelNames = new Dictionary<string, ChannelPerm>
    {
        ["view"] = ChannelPerm.View, ["send"] = ChannelPerm.Send, ["connect"] = ChannelPerm.Connect, ["speak"] = ChannelPerm.Speak,
        ["setVoiceStatus"] = ChannelPerm.SetVoiceStatus,
    };

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();

    public static void Register(Router router)
    {
        router.Add("role.list", (s, _, _) => RoleList(s.World.Store));
        router.Add("role.base.update", UpdateBase);
        router.Add("role.create", Create);
        router.Add("role.update", Update);
        router.Add("role.delete", Delete);
        router.Add("role.reorder", Reorder);
        router.Add("member.roles.set", SetMemberRoles);
        router.Add("channel.overrides.set", SetOverride);
        router.Add("voice.mute", Mute);
        router.Add("voice.move", Move);
        router.Add("role.group.create", CreateGroup);
        router.Add("role.group.update", UpdateGroup);
        router.Add("role.group.delete", DeleteGroup);
        router.Add("roles.self", SetSelf);
    }

    public static string[] PermList(Perm perms) => PermNames.Where(p => perms.HasFlag(p.Value)).Select(p => p.Key).ToArray();
    public static string[] ChannelPermNames(ChannelPerm perms) => ChannelNames.Where(p => perms.HasFlag(p.Value)).Select(p => p.Key).ToArray();

    public static object Public(CustomRole r) => new
    {
        id = r.Id, name = r.Name, color = r.Color, icon = r.Icon, hoist = r.Hoist, mentionable = r.Mentionable, position = r.Position,
        permissions = PermList(r.Perms), selfAssign = r.SelfAssign,
    };

    /// <summary>`role.list` and the `roles` event: custom roles, built-in roles and the pick groups.</summary>
    private static object RoleList(Store store) =>
        new { roles = store.AllRoles().Select(Public), baseRoles = PublicBaseRoles(store), groups = PublicGroups(store) };

    // ── Validation ───────────────────────────────────────────────────────────

    private static void RequireManager(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageRoles)) throw RequestException.Forbidden("You can't manage roles on this server.", "manage_roles");
    }

    private static CustomRole ManageableRole(Session s, Member me, long id)
    {
        var role = s.World.Store.GetRole(id) ?? throw RequestException.NotFound("Role");
        if (!Permissions.IsAbove(me, role.Position)) throw RequestException.Forbidden("You can only manage roles below your own highest role.", "rank_manage_roles");
        return role;
    }

    private static Perm ParsePerms(Body body, Member me, Perm fallback)
    {
        if (!body.Has("permissions")) return fallback;
        var perms = Perm.None;
        foreach (var name in body.OptionalStringArray("permissions", PermNames.Count, 32))
            perms |= PermNames.TryGetValue(name, out var p) ? p : throw RequestException.BadRequest($"Unknown permission '{name}'.");
        // You can only hand out what you have yourself.
        if ((perms & ~Permissions.Effective(me) & ~fallback) != Perm.None)
            throw RequestException.Forbidden("You can only give permissions you have yourself.", "rank_permissions");
        return perms;
    }

    private static string RoleName(string raw)
    {
        var name = Names.Normalize(raw) ?? throw RequestException.BadRequest($"Role names must be 1–{Sessions.Names.MaxLength} characters.", "role_name", new { max = Sessions.Names.MaxLength });
        // Built-in roles are listed next to custom ones: no lookalikes.
        if (Roles.IsValid(name.ToLowerInvariant()) || name.Equals("everyone", StringComparison.OrdinalIgnoreCase))
            throw RequestException.BadRequest("That name belongs to a built-in role.", "role_name_builtin");
        return name;
    }

    /// <summary>"" or absent clears; otherwise #rrggbb.</summary>
    private static string? Color(Body body, string? fallback)
    {
        if (!body.Has("color")) return fallback;
        var raw = body.OptionalString("color", 16);
        if (string.IsNullOrEmpty(raw)) return null;
        return ColorPattern().IsMatch(raw) ? raw.ToLowerInvariant() : throw RequestException.BadRequest("'color' must look like #rrggbb.");
    }

    /// <summary>An emoji (≤ 16 characters, no spaces); "" clears.</summary>
    private static string? Icon(Body body, string? fallback)
    {
        if (!body.Has("icon")) return fallback;
        var raw = body.OptionalString("icon", MaxIconLength * 2);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var icon = Text.Normalize(raw, MaxIconLength, allowNewlines: false);
        return icon is null || icon.Any(char.IsWhiteSpace) ? throw RequestException.BadRequest("'icon' must be one emoji.") : icon;
    }

    private static void RolesChanged(Session s)
    {
        s.Hub.Broadcast(Frames.Event("roles", RoleList(s.World.Store)));
    }

    /// <summary>After role membership, deletion or overrides change: members, channel lists and voice follow.</summary>
    private static void AccessChanged(Session s, IEnumerable<string> accountKeys)
    {
        foreach (var key in accountKeys.Distinct())
            if (s.World.Store.GetMember(key) is { } member)
                s.Hub.Broadcast(Frames.Event("member.updated", new { member = s.Hub.PublicMember(member) }));
        ChannelFeature.BroadcastChannels(s);
        s.Voice.EnforceAccess();
    }

    // ── Roles ────────────────────────────────────────────────────────────────

    private static object Create(Session s, Member me, Body body)
    {
        RequireManager(me);
        if (s.World.Store.RoleCount() >= MaxRoles) throw RequestException.BadRequest($"A server can have up to {MaxRoles} roles.", "roles_max", new { max = MaxRoles });
        var name = RoleName(body.String("name", 128));
        var perms = ParsePerms(body, me, Perm.None);
        var selfAssign = body.OptionalBool("selfAssign") ?? false;
        CheckSelfAssign(selfAssign, perms);
        var role = s.World.Store.CreateRole(name, Color(body, null), Icon(body, null), body.OptionalBool("hoist") ?? false, perms, s.Now);
        if (body.OptionalBool("mentionable") == true || selfAssign)
        {
            role = role with { Mentionable = body.OptionalBool("mentionable") ?? false, SelfAssign = selfAssign };
            s.World.Store.UpdateRole(role);
        }
        Audit.Record(s, "role.create", details: new { id = role.Id, name = role.Name, permissions = PermList(role.Perms), selfAssign });
        RolesChanged(s);
        return new { role = Public(role) };
    }

    /// <summary>A role members pick themselves can never carry a permission: whatever it grants, anyone could take.</summary>
    private static void CheckSelfAssign(bool selfAssign, Perm perms)
    {
        if (selfAssign && perms != Perm.None)
            throw RequestException.BadRequest("A role members pick themselves can't have permissions.", "role_self_assign_perms");
    }

    private static object Update(Session s, Member me, Body body)
    {
        RequireManager(me);
        var role = ManageableRole(s, me, body.Long("id"));
        var updated = role with
        {
            Name = body.OptionalString("name", 128) is { } raw && raw != role.Name ? RoleName(raw) : role.Name,
            Color = Color(body, role.Color),
            Icon = Icon(body, role.Icon),
            Hoist = body.OptionalBool("hoist") ?? role.Hoist,
            Mentionable = body.OptionalBool("mentionable") ?? role.Mentionable,
            Perms = ParsePerms(body, me, role.Perms),
            SelfAssign = body.OptionalBool("selfAssign") ?? role.SelfAssign,
        };
        CheckSelfAssign(updated.SelfAssign, updated.Perms);
        s.World.Store.UpdateRole(updated);
        if (role.SelfAssign && !updated.SelfAssign) s.World.Store.RemoveRoleFromGroups(role.Id); // no longer anyone's to pick
        Audit.Record(s, "role.update", details: new
        {
            id = role.Id, name = updated.Name,
            added = PermList(updated.Perms & ~role.Perms), removed = PermList(role.Perms & ~updated.Perms),
            selfAssign = updated.SelfAssign == role.SelfAssign ? (bool?)null : updated.SelfAssign,
        });
        RolesChanged(s);
        if (role.SelfAssign != updated.SelfAssign) AccessChanged(s, s.World.Store.MembersWithRole(role.Id)); // their rank follows
        return new { role = Public(updated) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireManager(me);
        var role = ManageableRole(s, me, body.Long("id"));
        var holders = s.World.Store.MembersWithRole(role.Id);
        s.World.Store.DeleteRole(role.Id);
        Audit.Record(s, "role.delete", details: new { id = role.Id, name = role.Name });
        RolesChanged(s);
        AccessChanged(s, holders);
        return null;
    }

    /// <summary>`ids`: every role, highest first. Roles at or above your own highest stay where they are.</summary>
    private static object Reorder(Session s, Member me, Body body)
    {
        RequireManager(me);
        var roles = s.World.Store.AllRoles();
        var ids = LongArray(body, "ids");
        if (ids.Count != roles.Count || ids.Distinct().Count() != ids.Count || !roles.All(r => ids.Contains(r.Id)))
            throw RequestException.BadRequest("'ids' must list every role once, highest first.");
        foreach (var role in roles)
        {
            var newPosition = roles.Count - ids.IndexOf(role.Id);
            if (newPosition != role.Position && (!Permissions.IsAbove(me, role.Position) || !Permissions.IsAbove(me, newPosition)))
                throw RequestException.Forbidden("You can only move roles below your own highest role.", "rank_move_roles");
        }
        s.World.Store.ReorderRoles(ids);
        Audit.Record(s, "role.reorder");
        RolesChanged(s);
        AccessChanged(s, []);
        return new { roles = s.World.Store.AllRoles().Select(Public) };
    }

    private static List<long> LongArray(Body body, string name)
    {
        var element = body.Element(name);
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxRoles)
            throw RequestException.BadRequest($"'{name}' must be a list of up to {MaxRoles} ids.");
        return element.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id : throw RequestException.BadRequest($"'{name}' must be a list of ids."))
            .ToList();
    }

    /// <summary>Replaces a member's custom roles. Every role added or removed must be below your highest; the member must be you or ranked below you.</summary>
    private static object SetMemberRoles(Session s, Member me, Body body)
    {
        RequireManager(me);
        var target = s.World.Store.GetMember(body.String("accountKey", 64)) ?? throw RequestException.NotFound("Member");
        if (target.AccountKey != me.AccountKey && !Permissions.Outranks(me, target))
            throw RequestException.Forbidden("You can only manage members ranked below you.", "rank_members");
        var wanted = LongArray(body, "roles").Distinct().ToList();
        var all = s.World.Store.AllRoles().ToDictionary(r => r.Id);
        if (wanted.Any(id => !all.ContainsKey(id))) throw RequestException.BadRequest("Unknown role.");
        var added = wanted.Except(target.RoleIds).ToList();
        var removed = target.RoleIds.Except(wanted).ToList();
        if (added.Concat(removed).Any(id => !Permissions.IsAbove(me, all[id].Position)))
            throw RequestException.Forbidden("You can only give or take roles below your own highest role.", "rank_give_roles");

        if (added.Count + removed.Count > 0)
        {
            s.World.Store.SetMemberRoles(target.AccountKey, wanted);
            Audit.Record(s, "member.roles", target.AccountKey, details: new
            {
                added = added.Select(id => all[id].Name), removed = removed.Select(id => all[id].Name),
            });
            AccessChanged(s, [target.AccountKey]);
        }
        return new { member = s.Hub.PublicMember(s.World.Store.GetMember(target.AccountKey)!) };
    }

    // ── Channel overrides ────────────────────────────────────────────────────

    private static ChannelPerm ParseChannelPerms(Body body, string name)
    {
        var perms = ChannelPerm.None;
        foreach (var item in body.OptionalStringArray(name, ChannelNames.Count, 16))
            perms |= ChannelNames.TryGetValue(item, out var p) ? p : throw RequestException.BadRequest($"Unknown channel permission '{item}'.");
        return perms;
    }

    /// <summary>`allow` and `deny` both empty removes the override.</summary>
    private static object SetOverride(Session s, Member me, Body body)
    {
        if (!Permissions.Has(me, Perm.ManageChannels)) throw RequestException.Forbidden("You can't manage channels on this server.", "manage_channels");
        var channel = ChannelFeature.ManagedChannel(s, me, body);
        var role = ManageableRole(s, me, body.Long("roleId"));
        var allow = ParseChannelPerms(body, "allow");
        var deny = ParseChannelPerms(body, "deny");
        if ((allow & deny) != ChannelPerm.None) throw RequestException.BadRequest("A permission can't be both allowed and denied.", "perm_both");
        E2eeChannelFeature.CheckCapacity(s.World.Store, channel with
        {
            Overrides = [.. channel.Overrides.Where(o => o.RoleId != role.Id), .. (allow | deny) == ChannelPerm.None ? [] : new[] { new ChannelOverride(role.Id, allow, deny) }],
        });

        s.World.Store.SetOverride(channel.Id, role.Id, allow, deny);
        Audit.Record(s, "channel.overrides", details: new
        {
            channelId = channel.Id, name = channel.Name, role = role.Name, allow = ChannelPermNames(allow), deny = ChannelPermNames(deny),
        });
        AccessChanged(s, []);
        var updated = s.World.Store.GetChannel(channel.Id)!;
        return new { channel = Hub.PublicChannel(updated, s.World.Store.Slowmode(channel.Id), s.World.Store.UserLimit(channel.Id), E2eeChannelFeature.Info(s.World.Store, channel.Id), s.World.Store.IsHifi(channel.Id), s.World.Store.Topic(channel.Id), s.World.Store.IsLobby(channel.Id), RoomFeature.View(s.World.Store, channel.Id)) };
    }

    // ── Voice moderation ─────────────────────────────────────────────────────

    /// <summary>The person and the voice channel they're in (which you must be able to see).</summary>
    internal static (Member Target, Channel Channel) InVoice(Session s, Member me, Body body, Perm perm)
    {
        if (!Permissions.Has(me, perm)) throw RequestException.Forbidden();
        var target = s.World.Store.GetMember(body.String("accountKey", 64)) ?? throw RequestException.NotFound("Member");
        if (target.AccountKey != me.AccountKey && !Permissions.Outranks(me, target))
            throw RequestException.Forbidden("You can only manage members ranked below you.", "rank_members");
        if (s.Voice.ChannelOfMember(target.AccountKey) is not { } channelId || s.World.Store.GetChannel(channelId) is not { } channel
            || !Permissions.CanRead(me, channel))
            throw RequestException.BadRequest("They aren't in a voice channel.", "they_not_in_voice");
        return (target, channel);
    }

    private static object? Mute(Session s, Member me, Body body)
    {
        var (target, channel) = InVoice(s, me, body, Perm.MuteMembers);
        var muted = body.OptionalBool("muted") ?? throw RequestException.BadRequest("'muted' is required.");
        s.Voice.SetServerMuted(target.AccountKey, muted, Permissions.CanWrite(target, channel));
        Audit.Record(s, muted ? "voice.mute" : "voice.unmute", target.AccountKey, details: new { channelId = channel.Id, channelName = channel.Name });
        return null;
    }

    /// <summary>Moves someone to another voice channel: their app joins it, and they leave the old one.</summary>
    private static object? Move(Session s, Member me, Body body)
    {
        var (target, from) = InVoice(s, me, body, Perm.MoveMembers);
        var to = s.World.Store.GetChannel(body.Long("channelId"));
        if (to is null || to.Kind != "voice" || !Permissions.CanRead(me, to)) throw RequestException.NotFound("Channel");
        if (to.Id == from.Id) return null;
        if (!Permissions.CanConnect(target, to)) throw RequestException.Forbidden("They can't join that channel.", "they_cant_join");
        E2eeVoiceFeature.CheckMove(s.World.Store, target, to);

        s.Voice.Move(target.AccountKey, to.Id, s.Now); // moving fills a full channel too
        Audit.Record(s, "voice.move", target.AccountKey, details: new { from = from.Name, to = to.Name, channelId = to.Id });
        return null;
    }
}
