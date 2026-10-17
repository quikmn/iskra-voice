namespace Iskra.Server.Storage;

/// <summary>Server-wide permissions a custom role can grant. Admins have all of them by default, the owner always.</summary>
[Flags]
public enum Perm : long
{
    None = 0,
    ManageMessages = 1 << 0,
    TimeoutMembers = 1 << 1,
    KickMembers = 1 << 2,
    BanMembers = 1 << 3,
    ManageChannels = 1 << 4,
    ManageRoles = 1 << 5,
    ViewAuditLog = 1 << 6,
    ManageExpressions = 1 << 7,
    ManageWebhooks = 1 << 8,
    MentionEveryone = 1 << 9,
    MoveMembers = 1 << 10,
    MuteMembers = 1 << 11,
    ManageAutoMod = 1 << 12,
    PrioritySpeaker = 1 << 13,
}

/// <summary>What a channel override can allow or deny for a role.</summary>
[Flags]
public enum ChannelPerm : long
{
    None = 0,
    View = 1 << 0,
    Send = 1 << 1,
    Connect = 1 << 2,
    Speak = 1 << 3,
    /// <summary>Setting a voice channel's status (VoiceStatusFeature). Comes with the write level, like speaking.</summary>
    SetVoiceStatus = 1 << 4,
    All = View | Send | Connect | Speak | SetVoiceStatus,
}

/// <summary>A custom role. Position 1 is the lowest; higher numbers are higher in the hierarchy.</summary>
public sealed record CustomRole(long Id, string Name, string? Color, string? Icon, bool Hoist, int Position, Perm Perms, long CreatedAt)
{
    /// <summary>Anyone may @mention it (otherwise only people who may mention everyone).</summary>
    public bool Mentionable { get; init; }
    /// <summary>Members give it to and take it from themselves (RoleFeature.SelfAssign). Never grants permissions, never counts in the hierarchy.</summary>
    public bool SelfAssign { get; init; }
}
public sealed record ChannelOverride(long RoleId, ChannelPerm Allow, ChannelPerm Deny);

/// <summary>
/// A question new members answer by picking self-assignable roles ("Platform: PC / PlayStation / Xbox"). <paramref name="Multi"/>:
/// several answers at once; otherwise picking one drops the others. <paramref name="RoleIds"/> in the order shown.
/// </summary>
public sealed record RoleGroup(long Id, string Title, string Question, bool Multi, int Position, long[] RoleIds);

public sealed partial class Store
{
    private const string RolesMigration = """
        CREATE TABLE roles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            color       TEXT,
            icon        TEXT,
            hoist       INTEGER NOT NULL DEFAULT 0,
            position    INTEGER NOT NULL,
            perms       INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE member_roles (
            account_key TEXT NOT NULL,
            role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            PRIMARY KEY (account_key, role_id)
        );
        CREATE INDEX member_roles_by_role ON member_roles(role_id);
        CREATE TABLE channel_overrides (
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            allow       INTEGER NOT NULL,
            deny        INTEGER NOT NULL,
            PRIMARY KEY (channel_id, role_id)
        );
        """;

    private const string RoleGroupsMigration = """
        CREATE TABLE role_groups (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            question    TEXT NOT NULL,
            multi       INTEGER NOT NULL DEFAULT 0,
            position    INTEGER NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE role_group_roles (
            group_id    INTEGER NOT NULL REFERENCES role_groups(id) ON DELETE CASCADE,
            role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            position    INTEGER NOT NULL,
            PRIMARY KEY (group_id, role_id)
        );
        """;

    private const string RoleColumns = "id, name, color, icon, hoist, position, perms, created_at, mentionable, self_assign";

    private static CustomRole ReadRole(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3),
            r.GetInt64(4) != 0, r.GetInt32(5), (Perm)r.GetInt64(6), r.GetInt64(7)) { Mentionable = r.GetInt64(8) != 0, SelfAssign = r.GetInt64(9) != 0 };

    /// <summary>Highest first.</summary>
    public List<CustomRole> AllRoles() => Query($"SELECT {RoleColumns} FROM roles ORDER BY position DESC;", ReadRole);

    public CustomRole? GetRole(long id) => Query($"SELECT {RoleColumns} FROM roles WHERE id = $id;", ReadRole, ("$id", id)).FirstOrDefault();

    public int RoleCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM roles;"));

    /// <summary>New roles start at the bottom of the hierarchy.</summary>
    public CustomRole CreateRole(string name, string? color, string? icon, bool hoist, Perm perms, long now)
    {
        lock (_gate)
        {
            Exec("UPDATE roles SET position = position + 1;");
            var id = Convert.ToInt64(Scalar("""
                INSERT INTO roles (name, color, icon, hoist, position, perms, created_at) VALUES ($n, $c, $i, $h, 1, $p, $t) RETURNING id;
                """, ("$n", name), ("$c", color), ("$i", icon), ("$h", hoist ? 1 : 0), ("$p", (long)perms), ("$t", now)));
            return GetRole(id)!;
        }
    }

    public void UpdateRole(CustomRole role) =>
        Exec("UPDATE roles SET name = $n, color = $c, icon = $i, hoist = $h, perms = $p, mentionable = $m, self_assign = $s WHERE id = $id;",
            ("$id", role.Id), ("$n", role.Name), ("$c", role.Color), ("$i", role.Icon), ("$h", role.Hoist ? 1 : 0), ("$p", (long)role.Perms),
            ("$m", role.Mentionable ? 1 : 0), ("$s", role.SelfAssign ? 1 : 0));

    public void DeleteRole(long id)
    {
        lock (_gate)
        {
            Exec("DELETE FROM roles WHERE id = $id;", ("$id", id));
            NormalizeRolePositions();
        }
    }

    /// <summary>Sets the order, highest first (the caller checked it lists every role once).</summary>
    public void ReorderRoles(IReadOnlyList<long> highestFirst)
    {
        lock (_gate)
        {
            for (var i = 0; i < highestFirst.Count; i++)
                Exec("UPDATE roles SET position = $p WHERE id = $id;", ("$p", highestFirst.Count - i), ("$id", highestFirst[i]));
        }
    }

    private void NormalizeRolePositions()
    {
        var ids = Query("SELECT id FROM roles ORDER BY position DESC;", r => r.GetInt64(0));
        ReorderRoles(ids);
    }

    // ── Members' roles ───────────────────────────────────────────────────────

    public void SetMemberRoles(string accountKey, IEnumerable<long> roleIds)
    {
        lock (_gate)
        {
            Exec("DELETE FROM member_roles WHERE account_key = $a;", ("$a", accountKey));
            foreach (var id in roleIds.Distinct())
                Exec("INSERT INTO member_roles (account_key, role_id) VALUES ($a, $r);", ("$a", accountKey), ("$r", id));
        }
    }

    public List<string> MembersWithRole(long roleId) =>
        Query("SELECT account_key FROM member_roles WHERE role_id = $r;", r => r.GetString(0), ("$r", roleId));

    /// <summary>
    /// Fills in the member's custom roles: ids (highest first), combined permissions and highest position. Self-assignable
    /// roles are listed but grant nothing and don't lift the member in the hierarchy: anyone could pick them.
    /// </summary>
    private Member WithRoles(Member m, List<(long Id, int Position, Perm Perms, bool SelfAssign)> roles)
    {
        var ranking = roles.Where(r => !r.SelfAssign).ToList();
        return m with
        {
            RoleIds = roles.OrderByDescending(r => r.Position).Select(r => r.Id).ToArray(),
            Perms = ranking.Aggregate(Perm.None, (all, r) => all | r.Perms),
            TopPosition = ranking.Count == 0 ? 0 : ranking.Max(r => r.Position),
        };
    }

    private Member? HydrateMember(Member? m) =>
        m is null ? null : WithRoles(WithBase(m), Query("""
            SELECT r.id, r.position, r.perms, r.self_assign FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.account_key = $a;
            """, r => (r.GetInt64(0), r.GetInt32(1), (Perm)r.GetInt64(2), r.GetInt64(3) != 0), ("$a", m.AccountKey)));

    private List<Member> HydrateMembers(List<Member> members)
    {
        if (ChangedBasePowers().Count > 0) members = members.Select(WithBase).ToList();
        var all = Query("""
            SELECT mr.account_key, r.id, r.position, r.perms, r.self_assign FROM member_roles mr JOIN roles r ON r.id = mr.role_id;
            """, r => (Key: r.GetString(0), Role: (r.GetInt64(1), r.GetInt32(2), (Perm)r.GetInt64(3), r.GetInt64(4) != 0)));
        if (all.Count == 0) return members;
        var byKey = all.GroupBy(x => x.Key).ToDictionary(g => g.Key, g => g.Select(x => x.Role).ToList());
        return members.Select(m => byKey.TryGetValue(m.AccountKey, out var roles) ? WithRoles(m, roles) : m).ToList();
    }

    // ── Pick groups (onboarding) ─────────────────────────────────────────────

    /// <summary>In the order shown, each with its roles in order.</summary>
    public List<RoleGroup> AllRoleGroups()
    {
        lock (_gate)
        {
            var roles = Query("SELECT group_id, role_id FROM role_group_roles ORDER BY position;", r => (Group: r.GetInt64(0), Role: r.GetInt64(1)))
                .GroupBy(x => x.Group).ToDictionary(g => g.Key, g => g.Select(x => x.Role).ToArray());
            return Query("SELECT id, title, question, multi, position FROM role_groups ORDER BY position, id;",
                r => new RoleGroup(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt64(3) != 0, r.GetInt32(4), roles.GetValueOrDefault(r.GetInt64(0)) ?? []));
        }
    }

    public RoleGroup? GetRoleGroup(long id) => AllRoleGroups().FirstOrDefault(g => g.Id == id);

    public int RoleGroupCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM role_groups;"));

    /// <summary>New groups go last.</summary>
    public RoleGroup CreateRoleGroup(string title, string question, bool multi, IReadOnlyList<long> roleIds, long now)
    {
        lock (_gate)
        {
            var position = Convert.ToInt32(Scalar("SELECT COALESCE(MAX(position), 0) + 1 FROM role_groups;"));
            var id = Convert.ToInt64(Scalar("""
                INSERT INTO role_groups (title, question, multi, position, created_at) VALUES ($t, $q, $m, $p, $now) RETURNING id;
                """, ("$t", title), ("$q", question), ("$m", multi ? 1 : 0), ("$p", position), ("$now", now)));
            SetRoleGroupRoles(id, roleIds);
            return GetRoleGroup(id)!;
        }
    }

    public void UpdateRoleGroup(RoleGroup group)
    {
        lock (_gate)
        {
            Exec("UPDATE role_groups SET title = $t, question = $q, multi = $m WHERE id = $id;",
                ("$id", group.Id), ("$t", group.Title), ("$q", group.Question), ("$m", group.Multi ? 1 : 0));
            SetRoleGroupRoles(group.Id, group.RoleIds);
        }
    }

    private void SetRoleGroupRoles(long groupId, IReadOnlyList<long> roleIds)
    {
        Exec("DELETE FROM role_group_roles WHERE group_id = $g;", ("$g", groupId));
        for (var i = 0; i < roleIds.Count; i++)
            Exec("INSERT OR IGNORE INTO role_group_roles (group_id, role_id, position) VALUES ($g, $r, $p);", ("$g", groupId), ("$r", roleIds[i]), ("$p", i));
    }

    public void DeleteRoleGroup(long id) => Exec("DELETE FROM role_groups WHERE id = $id;", ("$id", id));

    /// <summary>When a role stops being self-assignable, no group offers it any more.</summary>
    public void RemoveRoleFromGroups(long roleId) => Exec("DELETE FROM role_group_roles WHERE role_id = $r;", ("$r", roleId));

    // ── Channel overrides ────────────────────────────────────────────────────

    public void SetOverride(long channelId, long roleId, ChannelPerm allow, ChannelPerm deny)
    {
        if (allow == ChannelPerm.None && deny == ChannelPerm.None)
            Exec("DELETE FROM channel_overrides WHERE channel_id = $c AND role_id = $r;", ("$c", channelId), ("$r", roleId));
        else
            Exec("""
                INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES ($c, $r, $a, $d)
                ON CONFLICT(channel_id, role_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny;
                """, ("$c", channelId), ("$r", roleId), ("$a", (long)allow), ("$d", (long)deny));
    }

    private Dictionary<long, ChannelOverride[]> OverridesByChannel() =>
        Query("SELECT channel_id, role_id, allow, deny FROM channel_overrides;",
                r => (Channel: r.GetInt64(0), Override: new ChannelOverride(r.GetInt64(1), (ChannelPerm)r.GetInt64(2), (ChannelPerm)r.GetInt64(3))))
            .GroupBy(x => x.Channel).ToDictionary(g => g.Key, g => g.Select(x => x.Override).ToArray());

    /// <summary>Attaches overrides; threads use their parent channel's.</summary>
    private List<Channel> WithOverrides(List<Channel> channels, Func<Channel, long>? parentOf = null)
    {
        var overrides = OverridesByChannel();
        if (overrides.Count == 0) return channels;
        return channels.Select(c => overrides.TryGetValue(parentOf?.Invoke(c) ?? c.Id, out var o) ? c with { Overrides = o } : c).ToList();
    }

    private Channel? WithOverrides(Channel? channel)
    {
        if (channel is null) return null;
        var owner = Convert.ToInt64(Scalar("SELECT COALESCE(parent_id, id) FROM channels WHERE id = $id;", ("$id", channel.Id)) ?? channel.Id);
        var overrides = Query("SELECT role_id, allow, deny FROM channel_overrides WHERE channel_id = $c;",
            r => new ChannelOverride(r.GetInt64(0), (ChannelPerm)r.GetInt64(1), (ChannelPerm)r.GetInt64(2)), ("$c", owner));
        return overrides.Count == 0 ? channel : channel with { Overrides = [.. overrides] };
    }

    private Dictionary<long, long> ThreadParents() =>
        Query("SELECT id, parent_id FROM channels WHERE parent_id IS NOT NULL;", r => (r.GetInt64(0), r.GetInt64(1)))
            .ToDictionary(x => x.Item1, x => x.Item2);
}
