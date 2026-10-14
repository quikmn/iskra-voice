namespace Iskra.Server.Templates;

public static partial class ServerTemplates
{
    /// <summary>
    /// What a checked template sets up, for `iskra-server templates --json` (the desktop app's preview before creating a
    /// server). `roles` stays a list of names for older apps; `roleDetails` has the rest.
    /// </summary>
    public static object Preview(string id, ServerTemplate t) => new
    {
        id,
        version = t.Version,
        name = t.Name,
        description = t.Description,
        categories = t.Categories.Select(c => new { name = c.Name, channels = c.Channels.Select(ChannelPreview) }),
        channels = t.Channels.Select(ChannelPreview),
        roles = t.Roles.Select(r => r.Name),
        roleDetails = t.Roles.Select(r => new { name = r.Name, color = r.Color, icon = r.Icon, permissions = r.Permissions }),
        builtinRoles = t.BuiltinRoles.ToDictionary(b => b.Key, b => new { color = b.Value.Color, abilities = b.Value.Abilities, permissions = b.Value.Permissions }),
        rules = t.Rules is not null,
        afk = t.Afk is { } afk ? new { channel = afk.Channel, minutes = afk.Minutes, canTalk = afk.CanTalk } : null,
        settings = t.Settings is { } s ? new
        {
            notifyDefault = s.NotifyDefault,
            limits = s.Limits is not null,
            builtinBots = s.BuiltinBots,
            bugInbox = s.BugInbox,
        } : null,
    };

    private static object ChannelPreview(TemplateChannel c) => new
    {
        name = c.Name,
        kind = c.Kind,
        userLimit = c.UserLimit,
        readRole = c.ReadRole,
        writeRole = c.WriteRole ?? c.ReadRole,
        hifi = c.Hifi,
        slowmode = c.Slowmode,
        overrides = c.Overrides.Select(o => new { role = o.Role, allow = o.Allow, deny = o.Deny }),
        tags = c.Tags.Select(tag => tag.Name),
    };
}
