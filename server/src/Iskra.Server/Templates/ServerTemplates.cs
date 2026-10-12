using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Iskra.Server.Features;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Templates;

/// <summary>A starter template that fails validation. The message says what to fix, in plain words.</summary>
public sealed class TemplateException(string message) : Exception(message);

public sealed record TemplateChannel
{
    public string Name { get; init; } = "";
    /// <summary>"text" (default) or "voice".</summary>
    public string Kind { get; init; } = "text";
    /// <summary>Voice only: how many people fit (0 = no limit).</summary>
    public int UserLimit { get; init; }
    public string ReadRole { get; init; } = Roles.Member;
    public string? WriteRole { get; init; }
}

public sealed record TemplateCategory
{
    public string Name { get; init; } = "";
    public TemplateChannel[] Channels { get; init; } = [];
}

public sealed record TemplateRole
{
    public string Name { get; init; } = "";
    public string? Color { get; init; }
    public string? Icon { get; init; }
    public bool Hoist { get; init; }
    public bool Mentionable { get; init; }
    public string[] Permissions { get; init; } = [];
}

public sealed record TemplateRules
{
    public string Text { get; init; } = "";
    public string Welcome { get; init; } = "";
    /// <summary>Members must agree before they can write (the owner never has to).</summary>
    public bool Required { get; init; }
}

/// <summary>
/// A starter template (server/src/Iskra.Server/Templates/*.json, or your own file; format in docs/hosting.md):
/// categories with channels, uncategorized channels, custom roles and rules. Applied once, to a new server.
/// </summary>
public sealed record ServerTemplate
{
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public TemplateCategory[] Categories { get; init; } = [];
    /// <summary>Channels outside any category (listed first).</summary>
    public TemplateChannel[] Channels { get; init; } = [];
    public TemplateRole[] Roles { get; init; } = [];
    public TemplateRules? Rules { get; init; }
}

public static partial class ServerTemplates
{
    /// <summary>The templates that come with the server, in the order the setup wizard shows them.</summary>
    public static readonly string[] BuiltIn = ["gaming", "friends", "tabletop", "empty"];

    public const int MaxFileBytes = 64 * 1024;
    public const int MaxChannels = 100;
    public const int MaxRoles = 20;
    public const int MaxNameLength = 60;
    public const int MaxDescriptionLength = 300;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    [GeneratedRegex("^[a-z0-9-]{1,40}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();

    /// <summary>A built-in template by id ("gaming"), or a .json file of your own.</summary>
    public static ServerTemplate Load(string nameOrPath)
    {
        var key = nameOrPath.Trim();
        if (IdPattern().IsMatch(key.ToLowerInvariant()) && !key.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            var id = key.ToLowerInvariant();
            if (!BuiltIn.Contains(id))
                throw new TemplateException($"There's no template called '{key}'. Use one of: {string.Join(", ", BuiltIn)}, or the path to a .json file.");
            using var stream = typeof(ServerTemplates).Assembly.GetManifestResourceStream($"templates.{id}.json")
                ?? throw new TemplateException($"The built-in template '{id}' is missing from this build.");
            using var reader = new StreamReader(stream);
            return Parse(reader.ReadToEnd(), id);
        }
        var file = Path.GetFullPath(key);
        if (!File.Exists(file)) throw new TemplateException($"Template file not found: {file}");
        if (new FileInfo(file).Length > MaxFileBytes) throw new TemplateException($"Template file {file} is larger than {MaxFileBytes / 1024} KB.");
        return Parse(File.ReadAllText(file), Path.GetFileName(file));
    }

    /// <summary>Reads and checks a template. Throws <see cref="TemplateException"/> naming the first problem.</summary>
    public static ServerTemplate Parse(string json, string source)
    {
        ServerTemplate? template;
        try
        {
            template = JsonSerializer.Deserialize<ServerTemplate>(json, Options);
        }
        catch (JsonException ex)
        {
            var where = ex.LineNumber is { } line ? $" (line {line + 1})" : "";
            throw new TemplateException($"Template '{source}' isn't valid: {Plain(ex)}{where}.");
        }
        if (template is null) throw new TemplateException($"Template '{source}' is empty.");
        return Validate(template, source);
    }

    private static string Plain(JsonException ex) =>
        ex.Message.Contains("could not be mapped", StringComparison.Ordinal) && ex.Path is { } path
            ? $"unknown field at {path}"
            : ex.Message.Split(" Path:")[0].TrimEnd('.');

    private static ServerTemplate Validate(ServerTemplate t, string source)
    {
        string Fail(string what) => throw new TemplateException($"Template '{source}': {what}");

        var name = Text.Normalize(t.Name, MaxNameLength, allowNewlines: false) ?? Fail($"'name' must be 1–{MaxNameLength} characters.");
        var description = t.Description.Trim().Length == 0 ? ""
            : Text.Normalize(t.Description, MaxDescriptionLength, allowNewlines: false) ?? Fail($"'description' can be up to {MaxDescriptionLength} characters.");

        var total = 0;
        TemplateChannel Check(TemplateChannel c, string where)
        {
            total++;
            var channelName = Text.Normalize(c.Name, ChannelFeature.MaxNameLength, allowNewlines: false)
                ?? Fail($"{where}: channel names must be 1–{ChannelFeature.MaxNameLength} characters.");
            var kind = c.Kind.Trim().ToLowerInvariant();
            if (kind is not ("text" or "voice")) Fail($"{where} ('{channelName}'): 'kind' must be \"text\" or \"voice\", not \"{c.Kind}\".");
            if (c.UserLimit < 0 || c.UserLimit > VoiceLimitFeature.MaxUserLimit)
                Fail($"{where} ('{channelName}'): 'userLimit' must be 0 (no limit) to {VoiceLimitFeature.MaxUserLimit}.");
            if (c.UserLimit > 0 && kind != "voice") Fail($"{where} ('{channelName}'): only voice channels have a 'userLimit'.");
            var read = c.ReadRole.Trim().ToLowerInvariant();
            var write = (c.WriteRole ?? read).Trim().ToLowerInvariant();
            foreach (var role in new[] { read, write })
                if (!Sessions.Roles.IsValid(role) || role == Sessions.Roles.Owner)
                    Fail($"{where} ('{channelName}'): roles must be guest, member, trusted or admin, not \"{role}\".");
            if (Sessions.Roles.Rank(write) < Sessions.Roles.Rank(read))
                Fail($"{where} ('{channelName}'): 'writeRole' can't be lower than 'readRole'.");
            return new TemplateChannel { Name = channelName, Kind = kind, UserLimit = c.UserLimit, ReadRole = read, WriteRole = write };
        }

        var channels = t.Channels.Select((c, i) => Check(c, $"channel {i + 1}")).ToArray();
        if (t.Categories.Length > OrganizeFeature.MaxCategories) Fail($"at most {OrganizeFeature.MaxCategories} categories.");
        var categories = t.Categories.Select((cat, i) =>
        {
            var catName = Text.Normalize(cat.Name, OrganizeFeature.MaxCategoryNameLength, allowNewlines: false)
                ?? Fail($"category {i + 1}: names must be 1–{OrganizeFeature.MaxCategoryNameLength} characters.");
            return new TemplateCategory { Name = catName, Channels = cat.Channels.Select((c, j) => Check(c, $"category '{catName}', channel {j + 1}")).ToArray() };
        }).ToArray();
        if (total > MaxChannels) Fail($"at most {MaxChannels} channels.");

        if (t.Roles.Length > MaxRoles) Fail($"at most {MaxRoles} roles.");
        var roles = t.Roles.Select((r, i) =>
        {
            var roleName = Names.Normalize(r.Name) ?? Fail($"role {i + 1}: names must be 1–{Names.MaxLength} characters.");
            if (roleName.Equals("everyone", StringComparison.OrdinalIgnoreCase) || Sessions.Roles.IsValid(roleName.ToLowerInvariant()))
                Fail($"role '{roleName}': that name is taken by a built-in level.");
            if (r.Color is { Length: > 0 } color && !ColorPattern().IsMatch(color)) Fail($"role '{roleName}': 'color' must look like #rrggbb.");
            string? icon = null;
            if (!string.IsNullOrWhiteSpace(r.Icon))
            {
                icon = Text.Normalize(r.Icon, RoleFeature.MaxIconLength, allowNewlines: false);
                if (icon is null || icon.Any(char.IsWhiteSpace)) Fail($"role '{roleName}': 'icon' must be one emoji.");
            }
            foreach (var perm in r.Permissions)
                if (!RoleFeature.PermNames.ContainsKey(perm))
                    Fail($"role '{roleName}': unknown permission '{perm}'. Known: {string.Join(", ", RoleFeature.PermNames.Keys)}.");
            return r with { Name = roleName, Color = string.IsNullOrEmpty(r.Color) ? null : r.Color.ToLowerInvariant(), Icon = icon };
        }).ToArray();
        if (roles.Select(r => r.Name.ToLowerInvariant()).Distinct().Count() != roles.Length) Fail("two roles have the same name.");

        TemplateRules? rules = null;
        if (t.Rules is { } given)
        {
            var text = given.Text.Trim().Length == 0 ? "" : Text.Normalize(given.Text, RulesFeature.MaxTextLength, allowNewlines: true)
                ?? Fail($"'rules.text' can be up to {RulesFeature.MaxTextLength} characters.");
            var welcome = given.Welcome.Trim().Length == 0 ? "" : Text.Normalize(given.Welcome, RulesFeature.MaxWelcomeLength, allowNewlines: true)
                ?? Fail($"'rules.welcome' can be up to {RulesFeature.MaxWelcomeLength} characters.");
            if (given.Required && text.Length == 0) Fail("'rules.required' needs 'rules.text'.");
            rules = new TemplateRules { Text = text, Welcome = welcome, Required = given.Required };
        }

        return new ServerTemplate { Name = name, Description = description, Categories = categories, Channels = channels, Roles = roles, Rules = rules };
    }

    /// <summary>What happened when a template was asked for.</summary>
    public enum Outcome { Applied, AlreadyApplied, NotNew }

    /// <summary>
    /// Sets up a new server from a template, once. A server that already has a template, members, categories, roles
    /// or more than the starting #general isn't touched (<see cref="Outcome.NotNew"/>), so a leftover setting or
    /// flag can never pile channels onto a server that's in use.
    /// </summary>
    public static Outcome Apply(World world, ServerTemplate template, string id, long now)
    {
        var store = world.Store;
        if (store.AppliedTemplate() is not null) return Outcome.AlreadyApplied;
        if (!store.IsNewServer()) return Outcome.NotNew;

        // The starting #general becomes the template's first text channel, so there's never an extra one.
        var starter = store.AllChannels().FirstOrDefault();
        long? Place(TemplateChannel c, long? categoryId)
        {
            Channel channel;
            if (starter is not null && c.Kind == "text")
            {
                channel = starter with { Name = c.Name, ReadRole = c.ReadRole, WriteRole = c.WriteRole ?? c.ReadRole };
                store.UpdateChannel(channel);
                starter = null;
            }
            else channel = store.CreateChannel(c.Name, c.Kind, c.ReadRole, c.WriteRole ?? c.ReadRole, now);
            if (c.UserLimit > 0) store.SetUserLimit(channel.Id, c.UserLimit);
            store.MoveChannel(channel.Id, categoryId, beforeId: null);
            return channel.Id;
        }

        foreach (var channel in template.Channels) Place(channel, null);
        foreach (var category in template.Categories)
        {
            var created = store.CreateCategory(category.Name);
            foreach (var channel in category.Channels) Place(channel, created.Id);
        }
        // Listed highest first; each new role starts at the bottom, below the ones before it.
        foreach (var role in template.Roles)
        {
            var perms = role.Permissions.Aggregate(Perm.None, (all, p) => all | RoleFeature.PermNames[p]);
            var created = store.CreateRole(role.Name, role.Color, role.Icon, role.Hoist, perms, now);
            if (role.Mentionable) store.UpdateRole(created with { Mentionable = true });
        }
        if (template.Rules is { } rules && (rules.Text.Length > 0 || rules.Welcome.Length > 0))
            store.SaveRules(new ServerRules(rules.Text, rules.Welcome, rules.Required, rules.Required ? 1 : 0, now, ""));

        store.MarkTemplateApplied(id, now);
        SecurityLog.Record(store, now, "server.template", details: new { template = id, channels = store.AllChannels().Count, roles = template.Roles.Length });
        return Outcome.Applied;
    }

    /// <summary>
    /// On startup (server.json "Template", or --template): sets up a new server from the template once. Reads the
    /// template only when it's still needed, so a template file removed after setup never stops the server.
    /// Throws <see cref="TemplateException"/> for a template that can't be used.
    /// </summary>
    public static Outcome ApplyOnStart(World world, string nameOrPath, long now)
    {
        if (world.Store.AppliedTemplate() is not null) return Outcome.AlreadyApplied;
        if (!world.Store.IsNewServer()) return Outcome.NotNew;
        return Apply(world, Load(nameOrPath), IdOf(nameOrPath), now);
    }

    /// <summary>A short id for the security log and the marker: the built-in id, or the file name.</summary>
    public static string IdOf(string nameOrPath)
    {
        var key = nameOrPath.Trim();
        return IdPattern().IsMatch(key.ToLowerInvariant()) && !key.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
            ? key.ToLowerInvariant()
            : Path.GetFileName(key);
    }
}
