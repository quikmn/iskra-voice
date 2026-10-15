using System.Text.Json.Nodes;
using Iskra.Server.Features;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Templates;

/// <summary>
/// "Save this server as a template": the server's setup as a template (format 2). Only structure and settings: never
/// members, messages, files, invites, keys or other secrets. Channels the person saving can't see are left out, and so
/// is the bug inbox unless the owner saves. Encrypted channels come out as ordinary ones (a template can't hold keys).
/// </summary>
public static class TemplateExport
{
    public static JsonObject Build(World world, Member me)
    {
        var store = world.Store;
        var channels = store.AllChannels().Where(c => ServerTemplates.Kinds.Contains(c.Kind) && Permissions.CanRead(me, c)).ToList();
        var roles = store.AllRoles(); // highest first
        var roleNames = roles.ToDictionary(r => r.Id, r => r.Name);
        var limits = store.AllUserLimits();
        var slowmodes = store.AllSlowmodes();
        var hifi = store.AllHifi();
        var topics = store.AllTopics();
        var timers = store.ChannelTimers().ToDictionary(t => t.ChannelId, t => t.Timer.Seconds);
        var format3 = false;
        // Settings that refer to a channel by name need the name to be unique.
        var unique = channels.GroupBy(c => c.Name, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() == 1).Select(g => g.Single().Id).ToHashSet();

        JsonObject Channel(Channel c)
        {
            var o = new JsonObject { ["name"] = c.Name };
            if (c.Kind != "text") o["kind"] = c.Kind;
            o["readRole"] = c.ReadRole;
            if (c.WriteRole != c.ReadRole || c.Kind == "docs") o["writeRole"] = c.WriteRole;
            if (limits.GetValueOrDefault(c.Id) is > 0 and var limit) o["userLimit"] = limit;
            if (hifi.Contains(c.Id) && c.Kind == "voice") o["hifi"] = true;
            if (slowmodes.GetValueOrDefault(c.Id) is > 0 and var slow && c.Kind is not ("docs" or "whiteboard")) o["slowmode"] = slow;
            var overrides = c.Overrides.Where(x => roleNames.ContainsKey(x.RoleId)).Select(x => (JsonNode)new JsonObject
            {
                ["role"] = roleNames[x.RoleId],
                ["allow"] = Names(RoleFeature.ChannelPermNames(x.Allow)),
                ["deny"] = Names(RoleFeature.ChannelPermNames(x.Deny)),
            }).ToArray();
            if (overrides.Length > 0) o["overrides"] = new JsonArray(overrides);
            if (c.Kind == "forum" && store.ForumTags(c.Id) is { Count: > 0 } tags)
                o["tags"] = new JsonArray(tags.Select(t => (JsonNode)new JsonObject { ["name"] = t.Name, ["emoji"] = t.Emoji }).ToArray());
            if (topics.GetValueOrDefault(c.Id) is { Length: > 0 } topic) o["topic"] = topic;
            if (timers.GetValueOrDefault(c.Id) is > 0 and var seconds && c.Kind is "text" or "voice") o["disappear"] = seconds;
            format3 |= o.ContainsKey("topic") || o.ContainsKey("disappear");
            return o;
        }

        var template = new JsonObject
        {
            ["version"] = ServerTemplates.CurrentVersion,
            ["name"] = Text.Normalize(world.Settings.Name, ServerTemplates.MaxNameLength, allowNewlines: false) ?? "My server",
            ["description"] = "",
        };
        var loose = channels.Where(c => c.CategoryId is null).Select(c => (JsonNode)Channel(c)).ToArray();
        if (loose.Length > 0) template["channels"] = new JsonArray(loose);
        var categories = store.AllCategories().OrderBy(c => c.Position)
            .Select(cat => (cat, inside: channels.Where(c => c.CategoryId == cat.Id).ToList()))
            .Where(x => x.inside.Count > 0)
            .Select(x => (JsonNode)new JsonObject { ["name"] = x.cat.Name, ["channels"] = new JsonArray(x.inside.Select(c => (JsonNode)Channel(c)).ToArray()) })
            .ToArray();
        if (categories.Length > 0) template["categories"] = new JsonArray(categories);

        if (roles.Count > 0)
            template["roles"] = new JsonArray(roles.Select(r =>
            {
                var o = new JsonObject { ["name"] = r.Name };
                if (r.Color is not null) o["color"] = r.Color;
                if (r.Icon is not null) o["icon"] = r.Icon;
                if (r.Hoist) o["hoist"] = true;
                if (r.Mentionable) o["mentionable"] = true;
                o["permissions"] = Names(RoleFeature.PermList(r.Perms));
                return (JsonNode)o;
            }).ToArray());

        var colors = store.BaseRoleColors();
        var changed = store.ChangedBasePowers();
        var builtin = new JsonObject();
        foreach (var role in Roles.All.Reverse())
        {
            var o = new JsonObject();
            if (colors.GetValueOrDefault(role) is { } color) o["color"] = color;
            if (role != Roles.Owner && changed.GetValueOrDefault(role) is { } powers)
            {
                o["abilities"] = Names(BaseRoles.Names(powers.Abilities));
                o["permissions"] = Names(RoleFeature.PermList(powers.Perms));
            }
            if (o.Count > 0) builtin[role] = o;
        }
        if (builtin.Count > 0) template["builtinRoles"] = builtin;

        if (store.Rules() is { } rules && (rules.Text.Length > 0 || rules.Welcome.Length > 0))
        {
            var o = new JsonObject();
            if (rules.Text.Length > 0) o["text"] = rules.Text;
            if (rules.Welcome.Length > 0) o["welcome"] = rules.Welcome;
            if (rules.Required && rules.Text.Length > 0) o["required"] = true;
            template["rules"] = o;
        }

        var afk = store.Afk();
        if (afk.ChannelId is { } afkId && channels.FirstOrDefault(c => c.Id == afkId) is { Kind: "voice" } afkChannel && unique.Contains(afkId))
            template["afk"] = new JsonObject
            {
                ["channel"] = afkChannel.Name,
                ["minutes"] = afk.IdleMinutes,
                ["canTalk"] = Names(afk.TalkLevels.Concat(afk.TalkRoles.Where(roleNames.ContainsKey).Select(id => roleNames[id]))),
            };

        var settings = new JsonObject();
        if (store.NotifyDefault() is { } notify) settings["notifyDefault"] = notify;
        var limitsJson = Limits(world.Settings);
        if (limitsJson.Count > 0) settings["limits"] = limitsJson;
        var bots = BuiltinBotFeature.Bots.Where(b => store.BuiltinBots().FirstOrDefault(r => r.Id == b.Id) is { } row && store.GetMember(row.AccountKey) is not null)
            .Select(b => b.Id).ToArray();
        if (bots.Length > 0) settings["builtinBots"] = Names(bots);
        if (me.Role == Roles.Owner && world.Settings.BugInbox.Accept && store.GetBugInbox() is { Enabled: true, ChannelId: { } inboxId }
            && channels.FirstOrDefault(c => c.Id == inboxId) is { Kind: "text" } inbox && unique.Contains(inboxId))
            settings["bugInbox"] = inbox.Name;
        if (world.Settings.Translate.Offer) settings["translation"] = true;
        if (settings.Count > 0) template["settings"] = settings;
        // Format 3 only when it uses format 3's fields, so servers that read format 2 can still use the file.
        if (!format3 && !settings.ContainsKey("translation")) template["version"] = 2;
        return template;
    }

    /// <summary>Limits that differ from a new server's.</summary>
    private static JsonObject Limits(WorldSettings w)
    {
        var fresh = new WorldSettings();
        var o = new JsonObject();
        void Add(string name, int value, int defaultValue)
        {
            if (value != defaultValue) o[name] = value;
        }
        Add("maxUploadMb", w.MaxUploadMb, fresh.MaxUploadMb);
        Add("memberMbPerDay", w.UploadQuota.MemberMbPerDay, fresh.UploadQuota.MemberMbPerDay);
        Add("guestMbPerDay", w.UploadQuota.GuestMbPerDay, fresh.UploadQuota.GuestMbPerDay);
        Add("soundMaxSeconds", w.Limits.SoundMaxSeconds, fresh.Limits.SoundMaxSeconds);
        Add("soundMaxMb", w.Limits.SoundMaxMb, fresh.Limits.SoundMaxMb);
        Add("emojiMaxKb", w.Limits.EmojiMaxKb, fresh.Limits.EmojiMaxKb);
        Add("stickerMaxKb", w.Limits.StickerMaxKb, fresh.Limits.StickerMaxKb);
        return o;
    }

    private static JsonArray Names(IEnumerable<string> names) => new(names.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray());
}
