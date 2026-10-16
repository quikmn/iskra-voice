using Iskra.Server.Features;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Templates;

public static partial class ServerTemplates
{
    /// <summary>
    /// Adds a template to a server that's already in use (`iskra-server templates apply`), additive only: roles, categories
    /// and channels it doesn't have yet (channels matched by name and kind anywhere on the server, categories and roles by
    /// name), and settings that are still at their defaults. Never deletes, renames or changes what's there, and never
    /// touches members or messages. Returns what it adds (or would add, when <paramref name="apply"/> is false).
    /// </summary>
    public static List<string> Merge(World world, ServerTemplate template, bool apply, long now)
    {
        var store = world.Store;
        var plan = new List<string>();

        // Roles, by name.
        var roleIds = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        var pickable = store.AllRoles().Where(r => r.SelfAssign).Select(r => r.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var r in store.AllRoles()) roleIds.TryAdd(r.Name, r.Id);
        foreach (var role in template.Roles)
        {
            if (roleIds.ContainsKey(role.Name)) continue;
            if (store.RoleCount() >= RoleFeature.MaxRoles)
            {
                plan.Add($"(skipped) role {role.Name}: the server already has {RoleFeature.MaxRoles} roles");
                continue;
            }
            plan.Add($"role {role.Name}");
            if (role.SelfAssign) pickable.Add(role.Name);
            if (!apply) { roleIds[role.Name] = 0; continue; }
            var created = store.CreateRole(role.Name, role.Color, role.Icon, role.Hoist,
                role.Permissions.Aggregate(Perm.None, (all, p) => all | RoleFeature.PermNames[p]), now);
            if (role.Mentionable || role.SelfAssign) store.UpdateRole(created with { Mentionable = role.Mentionable, SelfAssign = role.SelfAssign });
            roleIds[role.Name] = created.Id;
        }

        // Pick groups by title, only when every role in them is one members may pick here (a role the server already
        // had under that name may not be).
        var groupTitles = store.AllRoleGroups().Select(g => g.Title).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var group in template.RoleGroups)
        {
            if (groupTitles.Contains(group.Title)) continue;
            if (groupTitles.Count >= RoleFeature.MaxGroups)
            {
                plan.Add($"(skipped) pick group {group.Title}: the server already has {RoleFeature.MaxGroups} groups");
                continue;
            }
            if (!group.Roles.All(pickable.Contains))
            {
                plan.Add($"(skipped) pick group {group.Title}: a role in it isn't one members can pick on this server");
                continue;
            }
            plan.Add($"pick group {group.Title} ({string.Join(", ", group.Roles)})");
            groupTitles.Add(group.Title);
            if (apply) store.CreateRoleGroup(group.Title, group.Question, group.Multi, group.Roles.Select(n => roleIds[n]).ToArray(), now);
        }

        // Categories by name, channels by name and kind.
        var categories = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in store.AllCategories()) categories.TryAdd(c.Name, c.Id);
        var have = store.AllChannels().Select(c => (c.Name.ToLowerInvariant(), c.Kind)).ToHashSet();
        var channelIds = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in store.AllChannels()) channelIds.TryAdd($"{c.Kind}:{c.Name}", c.Id);

        void Add(TemplateChannel c, string? categoryName)
        {
            if (!have.Add((c.Name.ToLowerInvariant(), c.Kind)))
            {
                // A channel it has: only its starting content, where it has none yet.
                if (channelIds.TryGetValue($"{c.Kind}:{c.Name}", out var existing)) AddContent(world, store.GetChannel(existing), c, apply, plan, now);
                return;
            }
            long? categoryId = null;
            if (categoryName is not null)
            {
                if (!categories.TryGetValue(categoryName, out var id))
                {
                    if (categories.Count >= OrganizeFeature.MaxCategories)
                    {
                        plan.Add($"(skipped) category {categoryName}: the server already has {OrganizeFeature.MaxCategories} categories");
                        categories[categoryName] = 0;
                    }
                    else
                    {
                        plan.Add($"category {categoryName}");
                        categories[categoryName] = id = apply ? store.CreateCategory(categoryName).Id : 0;
                    }
                }
                categoryId = id == 0 ? null : id;
            }
            var where = categoryName is null ? "" : $" in {categoryName}";
            var who = c.ReadRole != Sessions.Roles.Member || c.WriteRole != c.ReadRole ? $" (read: {c.ReadRole}, write: {c.WriteRole})" : "";
            plan.Add($"{c.Kind} channel {c.Name}{where}{who}");
            if (!apply)
            {
                AddContent(world, null, c, apply: false, plan, now);
                return;
            }
            var channel = store.CreateChannel(c.Name, c.Kind, c.ReadRole, c.WriteRole ?? c.ReadRole, now);
            if (c.UserLimit > 0) store.SetUserLimit(channel.Id, c.UserLimit);
            if (c.Hifi) store.SetHifi(channel.Id, true);
            if (c.Slowmode > 0) store.SetSlowmode(channel.Id, c.Slowmode);
            if (c.Tags.Length > 0) store.SetForumTags(channel.Id, c.Tags.Select(t => ((long?)null, t.Name, t.Emoji)).ToList());
            foreach (var o in c.Overrides)
                if (roleIds.TryGetValue(o.Role, out var roleId) && roleId > 0)
                    store.SetOverride(channel.Id, roleId, ChannelPerms(o.Allow), ChannelPerms(o.Deny));
            channelIds.TryAdd($"{c.Kind}:{c.Name}", channel.Id);
            store.MoveChannel(channel.Id, categoryId, beforeId: null);
            AddContent(world, channel, c, apply: true, plan, now);
        }
        foreach (var c in template.Channels) Add(c, null);
        foreach (var category in template.Categories)
            foreach (var c in category.Channels) Add(c, category.Name);

        // Built-in roles: a colour where there's none, powers where nobody changed them.
        var colors = store.BaseRoleColors();
        var changed = store.BaseRoleChanges();
        foreach (var (role, style) in template.BuiltinRoles)
        {
            if (style.Color is not null && !colors.ContainsKey(role))
            {
                plan.Add($"colour {style.Color} for the built-in role {role}");
                if (apply) store.SetBaseRoleColor(role, style.Color);
            }
            if (role != Sessions.Roles.Owner && (style.Abilities is not null || style.Permissions is not null) && !changed.ContainsKey(role))
            {
                var defaults = BaseRoles.Effective(role, null);
                var abilities = style.Abilities?.Aggregate(0L, (all, n) => BaseRoles.TryParse(n, out var a) ? all | BaseRoles.Bit(a) : all) ?? defaults.Abilities;
                var perms = style.Permissions?.Aggregate(Perm.None, (all, n) => all | RoleFeature.PermNames[n]) ?? defaults.Perms;
                if (BaseRoles.ChangeFor(role, abilities, perms) is { } change)
                {
                    plan.Add($"powers for the built-in role {role}: {string.Join(", ", BaseRoles.Names(abilities).Concat(RoleFeature.PermList(perms)))}");
                    if (apply) store.SetBaseRoleChange(role, change);
                }
            }
        }

        if (template.Rules is { } rules && (rules.Text.Length > 0 || rules.Welcome.Length > 0) && store.Rules() is null)
        {
            plan.Add("server rules");
            if (apply) store.SaveRules(new ServerRules(rules.Text, rules.Welcome, rules.Required, rules.Required ? 1 : 0, now, ""));
        }
        if (template.Afk is { } afk && store.Afk().ChannelId is null)
        {
            plan.Add($"AFK channel {afk.Channel} ({afk.Minutes} min)");
            if (apply && channelIds.TryGetValue($"voice:{afk.Channel}", out var afkId))
                store.SaveAfk(new AfkSettings(afkId, afk.Minutes, afk.CanTalk.Where(Sessions.Roles.IsValid).ToArray(),
                    afk.CanTalk.Where(n => roleIds.TryGetValue(n, out var id) && id > 0).Select(n => roleIds[n]).ToArray()));
        }

        if (template.Settings is { } settings)
        {
            if (settings.NotifyDefault is { } notify && notify != NotifyFeature.Auto && store.NotifyDefault() is null)
            {
                plan.Add($"default notifications: {notify}");
                if (apply) store.SetNotifyDefault(notify);
            }
            if (settings.Limits is { } l)
            {
                var fresh = new WorldSettings();
                var w = world.Settings;
                int Pick(int? wanted, int current, int defaultValue, string name)
                {
                    if (wanted is not { } v || current != defaultValue || v == current) return current;
                    plan.Add($"limit {name}: {v}");
                    return v;
                }
                var next = w with
                {
                    MaxUploadMb = Pick(l.MaxUploadMb, w.MaxUploadMb, fresh.MaxUploadMb, "maxUploadMb"),
                    UploadQuota = w.UploadQuota with
                    {
                        MemberMbPerDay = Pick(l.MemberMbPerDay, w.UploadQuota.MemberMbPerDay, fresh.UploadQuota.MemberMbPerDay, "memberMbPerDay"),
                        GuestMbPerDay = Pick(l.GuestMbPerDay, w.UploadQuota.GuestMbPerDay, fresh.UploadQuota.GuestMbPerDay, "guestMbPerDay"),
                    },
                    Limits = w.Limits with
                    {
                        SoundMaxSeconds = Pick(l.SoundMaxSeconds, w.Limits.SoundMaxSeconds, fresh.Limits.SoundMaxSeconds, "soundMaxSeconds"),
                        SoundMaxMb = Pick(l.SoundMaxMb, w.Limits.SoundMaxMb, fresh.Limits.SoundMaxMb, "soundMaxMb"),
                        EmojiMaxKb = Pick(l.EmojiMaxKb, w.Limits.EmojiMaxKb, fresh.Limits.EmojiMaxKb, "emojiMaxKb"),
                        StickerMaxKb = Pick(l.StickerMaxKb, w.Limits.StickerMaxKb, fresh.Limits.StickerMaxKb, "stickerMaxKb"),
                    },
                };
                if (apply && next != w) world.UpdateSettings(_ => next);
            }
            var on = store.BuiltinBots().Where(b => store.GetMember(b.AccountKey) is not null).Select(b => b.Id).ToHashSet();
            foreach (var bot in settings.BuiltinBots.Where(b => !on.Contains(b)))
            {
                plan.Add($"built-in bot {bot}");
                if (apply)
                {
                    var kind = BuiltinBotFeature.Bots.First(k => k.Id == bot);
                    BuiltinBotFeature.Enable(store, kind, "", now);
                }
            }
            if (settings.BugInbox is { } skipped && !world.Settings.BugInbox.Accept)
                plan.Add(ServerTemplates.BugInboxSkipped(skipped));
            else if (settings.BugInbox is { } inbox && !store.GetBugInbox().Enabled)
            {
                // Reports can carry email addresses: never into a channel more people can read than the template says.
                var wanted = template.AllChannels.First(c => c.Kind == "text" && c.Name.Equals(inbox, StringComparison.OrdinalIgnoreCase)).ReadRole;
                var current = channelIds.TryGetValue($"text:{inbox}", out var inboxId) ? store.GetChannel(inboxId) : null;
                if (current is not null && Sessions.Roles.Rank(current.ReadRole) < Sessions.Roles.Rank(wanted))
                    plan.Add($"(skipped) bug inbox in {inbox}: {current.ReadRole}s can read #{current.Name}, the template says {wanted}");
                else
                {
                    plan.Add($"bug inbox in {inbox}");
                    if (apply && current is not null) store.SetBugInbox(true, current.Id);
                }
            }
            if (settings.Translation && !world.Settings.Translate.Offer)
            {
                plan.Add("translation offered to members");
                if (apply) world.UpdateSettings(w => w with { Translate = w.Translate with { Offer = true } });
            }
        }

        if (apply && plan.Count > 0)
            SecurityLog.Record(store, now, "server.template.merge", details: new { added = plan.Count, channels = store.AllChannels().Count });
        return plan;
    }
}
