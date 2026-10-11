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
    };

    private static readonly IReadOnlyDictionary<string, ChannelPerm> ChannelNames = new Dictionary<string, ChannelPerm>
    {
        ["view"] = ChannelPerm.View, ["send"] = ChannelPerm.Send, ["connect"] = ChannelPerm.Connect, ["speak"] = ChannelPerm.Speak,
    };

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();

    public static void Register(Router router)
    {
        router.Add("role.list", (s, _, _) => new { roles = s.World.Store.AllRoles().Select(Public) });
        router.Add("role.create", Create);
        router.Add("role.update", Update);
        router.Add("role.delete", Delete);
        router.Add("role.reorder", Reorder);
        router.Add("member.roles.set", SetMemberRoles);
        router.Add("channel.overrides.set", SetOverride);
        router.Add("voice.mute", Mute);
        router.Add("voice.move", Move);
    }

    public static string[] PermList(Perm perms) => PermNames.Where(p => perms.HasFlag(p.Value)).Select(p => p.Key).ToArray();
    public static string[] ChannelPermNames(ChannelPerm perms) => ChannelNames.Where(p => perms.HasFlag(p.Value)).Select(p => p.Key).ToArray();

    public static object Public(CustomRole r) => new
    {
        id = r.Id, name = r.Name, color = r.Color, icon = r.Icon, hoist = r.Hoist, mentionable = r.Mentionable, position = r.Position,
        permissions = PermList(r.Perms),
    };

    // ── Validation ───────────────────────────────────────────────────────────

    private static void RequireManager(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageRoles)) throw RequestException.Forbidden("You can't manage roles on this server.");
    }

    private static CustomRole ManageableRole(Session s, Member me, long id)
    {
        var role = s.World.Store.GetRole(id) ?? throw RequestException.NotFound("Role");
        if (!Permissions.IsAbove(me, role.Position)) throw RequestException.Forbidden("You can only manage roles below your own highest role.");
        return role;
    }

    private static Perm ParsePerms(Body body, Member me, Perm fallback)
    {
        if (!body.Has("permissions")) return fallback;
        var perms = Perm.None;
        foreach (var name in body.OptionalStringArray("permissions", PermNames.Count, 32))
            perms |= PermNames.TryGetValue(name, out var p) ? p : throw RequestException.BadRequest($"Unknown permission '{name}'.");
        // You can only hand out what you have yourself.
        if (!Permissions.IsAdmin(me) && (perms & ~me.Perms & ~fallback) != Perm.None)
            throw RequestException.Forbidden("You can only give permissions you have yourself.");
        return perms;
    }

    private static string RoleName(string raw) =>
        Names.Normalize(raw) ?? throw RequestException.BadRequest($"Role names must be 1–{Sessions.Names.MaxLength} characters.");

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
        s.Hub.Broadcast(Frames.Event("roles", new { roles = s.World.Store.AllRoles().Select(Public) }));
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
        if (s.World.Store.RoleCount() >= MaxRoles) throw RequestException.BadRequest($"A server can have up to {MaxRoles} roles.");
        var name = RoleName(body.String("name", 128));
        var role = s.World.Store.CreateRole(name, Color(body, null), Icon(body, null), body.OptionalBool("hoist") ?? false,
            ParsePerms(body, me, Perm.None), s.Now);
        if (body.OptionalBool("mentionable") == true)
        {
            role = role with { Mentionable = true };
            s.World.Store.UpdateRole(role);
        }
        Audit.Record(s, "role.create", details: new { id = role.Id, name = role.Name, permissions = PermList(role.Perms) });
        RolesChanged(s);
        return new { role = Public(role) };
    }

    private static object Update(Session s, Member me, Body body)
    {
        RequireManager(me);
        var role = ManageableRole(s, me, body.Long("id"));
        var updated = role with
        {
            Name = body.OptionalString("name", 128) is { } raw ? RoleName(raw) : role.Name,
            Color = Color(body, role.Color),
            Icon = Icon(body, role.Icon),
            Hoist = body.OptionalBool("hoist") ?? role.Hoist,
            Mentionable = body.OptionalBool("mentionable") ?? role.Mentionable,
            Perms = ParsePerms(body, me, role.Perms),
        };
        s.World.Store.UpdateRole(updated);
        Audit.Record(s, "role.update", details: new
        {
            id = role.Id, name = updated.Name,
            added = PermList(updated.Perms & ~role.Perms), removed = PermList(role.Perms & ~updated.Perms),
        });
        RolesChanged(s);
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
                throw RequestException.Forbidden("You can only move roles below your own highest role.");
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
            throw RequestException.Forbidden("You can only manage members ranked below you.");
        var wanted = LongArray(body, "roles").Distinct().ToList();
        var all = s.World.Store.AllRoles().ToDictionary(r => r.Id);
        if (wanted.Any(id => !all.ContainsKey(id))) throw RequestException.BadRequest("Unknown role.");
        var added = wanted.Except(target.RoleIds).ToList();
        var removed = target.RoleIds.Except(wanted).ToList();
        if (added.Concat(removed).Any(id => !Permissions.IsAbove(me, all[id].Position)))
            throw RequestException.Forbidden("You can only give or take roles below your own highest role.");

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
        if (!Permissions.Has(me, Perm.ManageChannels)) throw RequestException.Forbidden("You can't manage channels on this server.");
        var channel = ChannelFeature.ManagedChannel(s, me, body);
        var role = ManageableRole(s, me, body.Long("roleId"));
        var allow = ParseChannelPerms(body, "allow");
        var deny = ParseChannelPerms(body, "deny");
        if ((allow & deny) != ChannelPerm.None) throw RequestException.BadRequest("A permission can't be both allowed and denied.");
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
        return new { channel = Hub.PublicChannel(updated, s.World.Store.Slowmode(channel.Id), s.World.Store.UserLimit(channel.Id), E2eeChannelFeature.Info(s.World.Store, channel.Id)) };
    }

    // ── Voice moderation ─────────────────────────────────────────────────────

    /// <summary>The person and the voice channel they're in (which you must be able to see).</summary>
    private static (Member Target, Channel Channel) InVoice(Session s, Member me, Body body, Perm perm)
    {
        if (!Permissions.Has(me, perm)) throw RequestException.Forbidden();
        var target = s.World.Store.GetMember(body.String("accountKey", 64)) ?? throw RequestException.NotFound("Member");
        if (target.AccountKey != me.AccountKey && !Permissions.Outranks(me, target))
            throw RequestException.Forbidden("You can only manage members ranked below you.");
        if (s.Voice.ChannelOfMember(target.AccountKey) is not { } channelId || s.World.Store.GetChannel(channelId) is not { } channel
            || !Permissions.CanRead(me, channel))
            throw RequestException.BadRequest("They aren't in a voice channel.");
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
        if (!Permissions.CanConnect(target, to)) throw RequestException.Forbidden("They can't join that channel.");

        s.Voice.GrantMovePass(target.AccountKey, to.Id, s.Now + VoiceLimitFeature.MovePassMs); // moving fills a full channel too
        s.Hub.SendToAccount(target.AccountKey, Frames.Event("voice.moved", new { channelId = to.Id }));
        s.Voice.Disconnect(target.AccountKey);
        Audit.Record(s, "voice.move", target.AccountKey, details: new { from = from.Name, to = to.Name, channelId = to.Id });
        return null;
    }
}
