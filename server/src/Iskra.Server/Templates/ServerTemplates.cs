using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Iskra.Server.Features;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Templates;

/// <summary>A starter template that fails validation. The message says what to fix, in plain words.</summary>
public sealed class TemplateException(string message) : Exception(message);

/// <summary>What a template role may or may not do in one channel (on top of the channel's readRole/writeRole).</summary>
public sealed record TemplateOverride
{
    /// <summary>One of the template's roles, by name.</summary>
    public string Role { get; init; } = "";
    /// <summary>view, send, connect, speak.</summary>
    public string[] Allow { get; init; } = [];
    public string[] Deny { get; init; } = [];
}

/// <summary>A forum tag.</summary>
public sealed record TemplateTag
{
    public string Name { get; init; } = "";
    public string? Emoji { get; init; }
}

public sealed record TemplateChannel
{
    public string Name { get; init; } = "";
    /// <summary>"text" (default), "voice", "forum", "stage", "docs" or "whiteboard".</summary>
    public string Kind { get; init; } = "text";
    /// <summary>Voice only: how many people fit (0 = no limit).</summary>
    public int UserLimit { get; init; }
    public string ReadRole { get; init; } = Roles.Member;
    public string? WriteRole { get; init; }
    /// <summary>Voice only: hi-fi audio allowed.</summary>
    public bool Hifi { get; init; }
    /// <summary>Seconds between messages per person (0 = off; one of the slowmode steps).</summary>
    public int Slowmode { get; init; }
    public TemplateOverride[] Overrides { get; init; } = [];
    /// <summary>Forum only.</summary>
    public TemplateTag[] Tags { get; init; } = [];
    /// <summary>One line saying what the channel is for (format 3).</summary>
    public string? Topic { get; init; }
    /// <summary>Text channels only: messages posted once, as the server (format 3).</summary>
    public TemplateMessage[] Messages { get; init; } = [];
    /// <summary>Docs channels only: starting pages (format 3).</summary>
    public TemplatePage[] Pages { get; init; } = [];
    /// <summary>Text and voice channels: messages disappear after this many seconds (0 = off; format 3).</summary>
    public int Disappear { get; init; }
}

/// <summary>A message a template posts once, as the server, in the app's Markdown.</summary>
public sealed record TemplateMessage
{
    public string Text { get; init; } = "";
    public bool Pin { get; init; }
}

/// <summary>A docs page a template writes once, in the app's Markdown.</summary>
public sealed record TemplatePage
{
    public string Title { get; init; } = "";
    public string Text { get; init; } = "";
    /// <summary>The server's "Start here" page (at most one in a template).</summary>
    public bool StartHere { get; init; }
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

/// <summary>A base role (owner … guest): its colour and, optionally, everything it can do (absent: the defaults).</summary>
public sealed record TemplateBuiltinRole
{
    public string? Color { get; init; }
    /// <summary>The whole set of abilities (Sessions/BaseRoles.cs); null keeps the defaults.</summary>
    public string[]? Abilities { get; init; }
    /// <summary>The whole set of custom-role permissions the role has by itself; null keeps the defaults.</summary>
    public string[]? Permissions { get; init; }
}

public sealed record TemplateRules
{
    public string Text { get; init; } = "";
    public string Welcome { get; init; } = "";
    /// <summary>Members must agree before they can write (the owner never has to).</summary>
    public bool Required { get; init; }
}

/// <summary>
/// The AFK channel: a voice channel of the template, by name. Idle people are moved there after <see cref="Minutes"/>
/// (0 = never), and only levels and template roles in <see cref="CanTalk"/> can talk and hear in it.
/// </summary>
public sealed record TemplateAfk
{
    public string Channel { get; init; } = "";
    public int Minutes { get; init; } = 30;
    /// <summary>Levels (owner, admin, trusted, member, guest) and names of the template's roles.</summary>
    public string[] CanTalk { get; init; } = [Sessions.Roles.Owner, Sessions.Roles.Admin];
}

/// <summary>Settings → Limits. Any left out keep the server's defaults.</summary>
public sealed record TemplateLimits
{
    public int? MaxUploadMb { get; init; }
    public int? MemberMbPerDay { get; init; }
    public int? GuestMbPerDay { get; init; }
    public int? SoundMaxSeconds { get; init; }
    public int? SoundMaxMb { get; init; }
    public int? EmojiMaxKb { get; init; }
    public int? StickerMaxKb { get; init; }
}

/// <summary>Server-wide settings (format 2).</summary>
public sealed record TemplateSettings
{
    /// <summary>"auto" (by the server's size), "all" or "mentions".</summary>
    public string? NotifyDefault { get; init; }
    public TemplateLimits? Limits { get; init; }
    /// <summary>Built-in bots to turn on: dice, polls, reminders.</summary>
    public string[] BuiltinBots { get; init; } = [];
    /// <summary>A text channel of the template, by name: bug reports land there (the bug inbox is on).</summary>
    public string? BugInbox { get; init; }
    /// <summary>Offer message translation to members (Server settings → Translation).</summary>
    public bool Translation { get; init; }
}

/// <summary>
/// A starter template (Templates/*.json, or your own file; format in docs/templates.md): channels of every kind with who
/// can see and use them, custom roles, what the built-in roles can do, rules, the AFK channel and server settings.
/// Applied once, to a new server. Format 1 (no "version") is still read; it's format 2 without the newer fields.
/// </summary>
public sealed record ServerTemplate
{
    /// <summary>The format: 1 (when absent), 2 or 3.</summary>
    public int Version { get; init; } = 1;
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public TemplateCategory[] Categories { get; init; } = [];
    /// <summary>Channels outside any category (listed first).</summary>
    public TemplateChannel[] Channels { get; init; } = [];
    public TemplateRole[] Roles { get; init; } = [];
    /// <summary>The base roles, keyed by role ("admin", "trusted", ...). Optional; any left out keep the defaults.</summary>
    public Dictionary<string, TemplateBuiltinRole> BuiltinRoles { get; init; } = [];
    public TemplateRules? Rules { get; init; }
    public TemplateAfk? Afk { get; init; }
    public TemplateSettings? Settings { get; init; }

    [JsonIgnore]
    public IEnumerable<TemplateChannel> AllChannels => Channels.Concat(Categories.SelectMany(c => c.Channels));
}

public static partial class ServerTemplates
{
    /// <summary>The templates that come with the server, in the order the setup wizard shows them.</summary>
    public static readonly string[] BuiltIn = ["gaming", "friends", "tabletop", "empty"];

    public const int CurrentVersion = 3;
    public const int MaxFileBytes = 256 * 1024;
    public const int MaxChannels = 500;
    public const int MaxRoles = RoleFeature.MaxRoles;
    public const int MaxNameLength = 60;
    public const int MaxDescriptionLength = 300;

    public static readonly string[] Kinds = ["text", "voice", "forum", "stage", "docs", "whiteboard"];
    private static readonly string[] ChannelPermNames = ["view", "send", "connect", "speak"];

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 16,
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
        if (json.Length > MaxFileBytes) throw new TemplateException($"Template '{source}' is larger than {MaxFileBytes / 1024} KB.");
        // A newer format gets a clear message instead of "unknown field".
        if (VersionOf(json) is int version && version > CurrentVersion)
            throw new TemplateException($"Template '{source}' was made by a newer version of Iskra (format {version}). Update iskra-server to use it.");
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

    private static int? VersionOf(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true, MaxDepth = 16 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            foreach (var p in doc.RootElement.EnumerateObject())
                if (p.Name.Equals("version", StringComparison.OrdinalIgnoreCase) && p.Value.TryGetInt32(out var v)) return v;
        }
        catch (JsonException) { } // the full parse reports it
        return null;
    }

    private static string Plain(JsonException ex) =>
        ex.Message.Contains("could not be mapped", StringComparison.Ordinal) && ex.Path is { } path
            ? $"unknown field at {path}"
            : ex.Message.Split(" Path:")[0].TrimEnd('.');

    private static ServerTemplate Validate(ServerTemplate t, string source)
    {
        string Fail(string what) => throw new TemplateException($"Template '{source}': {what}");

        if (t.Version < 1) Fail($"'version' must be 1 to {CurrentVersion}.");
        var name = Text.Normalize(t.Name, MaxNameLength, allowNewlines: false) ?? Fail($"'name' must be 1–{MaxNameLength} characters.");
        var description = t.Description.Trim().Length == 0 ? ""
            : Text.Normalize(t.Description, MaxDescriptionLength, allowNewlines: false) ?? Fail($"'description' can be up to {MaxDescriptionLength} characters.");

        // Roles first: channels refer to them.
        if (t.Roles.Length > MaxRoles) Fail($"at most {MaxRoles} roles.");
        var roles = t.Roles.Select((r, i) =>
        {
            var roleName = Names.Normalize(r.Name) ?? Fail($"role {i + 1}: names must be 1–{Names.MaxLength} characters.");
            if (roleName.Equals("everyone", StringComparison.OrdinalIgnoreCase) || Sessions.Roles.IsValid(roleName.ToLowerInvariant()))
                Fail($"role '{roleName}': that name is taken by a built-in role.");
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
            return r with { Name = roleName, Color = string.IsNullOrEmpty(r.Color) ? null : r.Color.ToLowerInvariant(), Icon = icon, Permissions = r.Permissions.Distinct().ToArray() };
        }).ToArray();
        if (roles.Select(r => r.Name.ToLowerInvariant()).Distinct().Count() != roles.Length) Fail("two roles have the same name.");
        string? RoleNamed(string raw) => roles.FirstOrDefault(r => r.Name.Equals(raw.Trim(), StringComparison.OrdinalIgnoreCase))?.Name;

        var total = 0;
        TemplateChannel Check(TemplateChannel c, string where)
        {
            total++;
            var channelName = Text.Normalize(c.Name, ChannelFeature.MaxNameLength, allowNewlines: false)
                ?? Fail($"{where}: channel names must be 1–{ChannelFeature.MaxNameLength} characters.");
            where = $"{where} ('{channelName}')";
            var kind = c.Kind.Trim().ToLowerInvariant();
            if (!Kinds.Contains(kind)) Fail($"{where}: 'kind' must be one of {string.Join(", ", Kinds)}, not \"{c.Kind}\".");
            if (c.UserLimit < 0 || c.UserLimit > VoiceLimitFeature.MaxUserLimit)
                Fail($"{where}: 'userLimit' must be 0 (no limit) to {VoiceLimitFeature.MaxUserLimit}.");
            if (c.UserLimit > 0 && kind != "voice") Fail($"{where}: only voice channels have a 'userLimit'.");
            if (c.Hifi && kind != "voice") Fail($"{where}: only voice channels can allow hi-fi audio.");
            if (!ModerationFeature.SlowmodeSteps.Contains(c.Slowmode))
                Fail($"{where}: 'slowmode' must be 0 (off) or one of {string.Join(", ", ModerationFeature.SlowmodeSteps.Skip(1))} seconds.");
            if (c.Slowmode > 0 && kind is ("docs" or "whiteboard")) Fail($"{where}: {kind} channels have no slowmode.");
            var read = c.ReadRole.Trim().ToLowerInvariant();
            // Docs: everyone reads, trusted and above edit, unless chosen otherwise (as when creating one in the app).
            var write = (c.WriteRole ?? (kind == "docs" && Sessions.Roles.Rank(read) < Sessions.Roles.Rank(Sessions.Roles.Trusted) ? Sessions.Roles.Trusted : read)).Trim().ToLowerInvariant();
            foreach (var role in new[] { read, write })
                if (!Sessions.Roles.IsValid(role)) Fail($"{where}: roles must be guest, member, trusted, admin or owner, not \"{role}\".");
            if (Sessions.Roles.Rank(write) < Sessions.Roles.Rank(read)) Fail($"{where}: 'writeRole' can't be lower than 'readRole'.");

            if (c.Overrides.Length > MaxRoles) Fail($"{where}: at most {MaxRoles} overrides.");
            var overrides = c.Overrides.Select(o =>
            {
                var role = RoleNamed(o.Role) ?? Fail($"{where}: override for '{o.Role}', which isn't one of the template's roles.");
                string[] Perms(string[] names) => names.Select(n => ChannelPermNames.Contains(n) ? n
                    : Fail($"{where}: unknown channel permission '{n}' for '{role}'. Known: {string.Join(", ", ChannelPermNames)}.")).Distinct().ToArray();
                var allow = Perms(o.Allow);
                var deny = Perms(o.Deny);
                if (allow.Intersect(deny).Any()) Fail($"{where}: '{role}' can't both allow and deny the same thing.");
                return new TemplateOverride { Role = role, Allow = allow, Deny = deny };
            }).Where(o => o.Allow.Length + o.Deny.Length > 0).ToArray();
            if (overrides.Select(o => o.Role).Distinct(StringComparer.OrdinalIgnoreCase).Count() != overrides.Length)
                Fail($"{where}: each role can only have one override per channel.");

            if (c.Tags.Length > 0 && kind != "forum") Fail($"{where}: only forums have tags.");
            if (c.Tags.Length > ForumFeature.MaxTags) Fail($"{where}: a forum can have up to {ForumFeature.MaxTags} tags.");
            var tags = c.Tags.Select(tag =>
            {
                var tagName = Text.Normalize(tag.Name, ForumFeature.MaxTagName, allowNewlines: false)
                    ?? Fail($"{where}: tag names must be 1–{ForumFeature.MaxTagName} characters.");
                string? emoji = null;
                if (!string.IsNullOrWhiteSpace(tag.Emoji))
                {
                    emoji = Text.Normalize(tag.Emoji, 16, allowNewlines: false);
                    if (emoji is null || emoji.Any(char.IsWhiteSpace)) Fail($"{where}: tag '{tagName}' needs one emoji or none.");
                }
                return new TemplateTag { Name = tagName, Emoji = emoji };
            }).ToArray();
            if (tags.Select(x => x.Name.ToLowerInvariant()).Distinct().Count() != tags.Length) Fail($"{where}: two tags have the same name.");
            var (topic, messages, pages) = CheckContent(c, kind, where, Fail);
            if (!DisappearFeature.Allowed.Contains(c.Disappear))
                Fail($"{where}: 'disappear' must be 0 (off) or one of {string.Join(", ", DisappearFeature.Allowed.Skip(1))} seconds.");
            if (c.Disappear > 0 && kind is not ("text" or "voice")) Fail($"{where}: only text and voice channels can have disappearing messages.");
            if (c.Disappear > 0 && messages.Length > 0) Fail($"{where}: a channel with disappearing messages can't have 'messages' (they would disappear).");

            return new TemplateChannel
            {
                Name = channelName, Kind = kind, UserLimit = c.UserLimit, ReadRole = read, WriteRole = write, Hifi = c.Hifi,
                Slowmode = c.Slowmode, Overrides = overrides, Tags = tags, Topic = topic, Messages = messages, Pages = pages, Disappear = c.Disappear,
            };
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
        var allChannels = channels.Concat(categories.SelectMany(c => c.Channels)).ToArray();
        CheckContentTotals(allChannels, Fail);

        var builtinRoles = new Dictionary<string, TemplateBuiltinRole>();
        foreach (var (key, value) in t.BuiltinRoles)
        {
            var role = key.Trim().ToLowerInvariant();
            if (!Sessions.Roles.IsValid(role))
                Fail($"builtinRoles: there's no base role called '{key}'. Use: {string.Join(", ", Sessions.Roles.All.Reverse())}.");
            if (builtinRoles.ContainsKey(role)) Fail($"builtinRoles: '{role}' is listed twice.");
            if (value is null) Fail($"builtinRoles.{role}: give an object, like {{ \"color\": \"#e0a33a\" }}.");
            if (value!.Color is { Length: > 0 } color && !ColorPattern().IsMatch(color)) Fail($"builtinRoles.{role}: 'color' must look like #rrggbb.");
            builtinRoles[role] = new TemplateBuiltinRole
            {
                Color = string.IsNullOrEmpty(value.Color) ? null : value.Color.ToLowerInvariant(),
                Abilities = value.Abilities?.Distinct().ToArray(),
                Permissions = value.Permissions?.Distinct().ToArray(),
            };
            if (value.Abilities is not null || value.Permissions is not null) CheckPowers(role, builtinRoles[role], Fail);
        }

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

        var afk = t.Afk is { } wanted ? CheckAfk(wanted, allChannels, roles, Fail) : null;
        var settings = t.Settings is { } s ? CheckSettings(s, allChannels, Fail) : null;

        return new ServerTemplate
        {
            Version = t.Version, Name = name, Description = description, Categories = categories, Channels = channels, Roles = roles,
            BuiltinRoles = builtinRoles, Rules = rules, Afk = afk, Settings = settings,
        };
    }

    /// <summary>The same safety rules as Server settings → Roles: the owner's role never changes, guests and members get everyday powers only.</summary>
    private static void CheckPowers(string role, TemplateBuiltinRole value, Func<string, string> fail)
    {
        if (role == Sessions.Roles.Owner) fail("builtinRoles.owner: the owner can always do everything, so only its 'color' can be set.");
        var defaults = BaseRoles.Effective(role, null);
        var abilities = defaults.Abilities;
        if (value.Abilities is { } names)
        {
            abilities = 0;
            foreach (var n in names)
                abilities |= BaseRoles.TryParse(n, out var a) ? BaseRoles.Bit(a)
                    : throw new TemplateException(fail($"builtinRoles.{role}: unknown ability '{n}'. Known: {string.Join(", ", BaseRoles.Abilities.Select(x => x.Name))}."));
        }
        var perms = defaults.Perms;
        if (value.Permissions is { } permNames)
        {
            perms = Perm.None;
            foreach (var n in permNames)
                perms |= RoleFeature.PermNames.TryGetValue(n, out var p) ? p
                    : throw new TemplateException(fail($"builtinRoles.{role}: unknown permission '{n}'. Known: {string.Join(", ", RoleFeature.PermNames.Keys)}."));
        }
        var (adjustable, adjustablePerms) = BaseRoles.Adjustable(role);
        var outside = BaseRoles.Names((abilities ^ defaults.Abilities) & ~adjustable).Concat(RoleFeature.PermList((perms ^ defaults.Perms) & ~adjustablePerms)).ToArray();
        if (outside.Length > 0)
            fail(role is Sessions.Roles.Guest or Sessions.Roles.Member
                ? $"builtinRoles.{role}: guests and members can only get everyday powers (invite, events, pin, mentionEveryone, uploadSounds), not {string.Join(", ", outside)}."
                : $"builtinRoles.{role}: {string.Join(", ", outside)} always stay with the owner.");
    }

    private static TemplateAfk CheckAfk(TemplateAfk afk, TemplateChannel[] channels, TemplateRole[] roles, Func<string, string> fail)
    {
        var named = channels.Where(c => c.Name.Equals(afk.Channel.Trim(), StringComparison.OrdinalIgnoreCase)).ToArray();
        if (afk.Channel.Trim().Length == 0) fail("'afk.channel' must name one of the template's voice channels.");
        if (named.Length == 0) fail($"'afk.channel': there's no channel called '{afk.Channel}'.");
        if (named.Length > 1) fail($"'afk.channel': more than one channel is called '{afk.Channel}'.");
        if (named[0].Kind != "voice") fail($"'afk.channel': '{named[0].Name}' isn't a voice channel.");
        if (!AfkFeature.Minutes.Contains(afk.Minutes)) fail("'afk.minutes' must be 0 (never move anyone), 5, 15, 30 or 60.");
        var canTalk = afk.CanTalk.Select(who =>
        {
            var key = who.Trim();
            if (Sessions.Roles.IsValid(key.ToLowerInvariant())) return key.ToLowerInvariant();
            return roles.FirstOrDefault(r => r.Name.Equals(key, StringComparison.OrdinalIgnoreCase))?.Name
                ?? fail($"'afk.canTalk': '{who}' is neither a level (owner, admin, trusted, member, guest) nor one of the template's roles.");
        }).Distinct().ToArray();
        return new TemplateAfk { Channel = named[0].Name, Minutes = afk.Minutes, CanTalk = canTalk };
    }

    /// <summary>The largest upload limit (MB) a template may set, as Settings → Limits.</summary>
    private const int MaxMb = 1024 * 1024;

    private static TemplateSettings CheckSettings(TemplateSettings s, TemplateChannel[] channels, Func<string, string> fail)
    {
        var notify = s.NotifyDefault?.Trim().ToLowerInvariant();
        if (notify is not null && !NotifyFeature.ServerDefaults.Contains(notify)) fail("'settings.notifyDefault' must be \"auto\", \"all\" or \"mentions\".");

        if (s.Limits is { } l)
        {
            void Range(int? value, string field, int min)
            {
                if (value is { } v && (v < min || v > MaxMb)) fail($"'settings.limits.{field}' must be {min} to {MaxMb}.");
            }
            Range(l.MaxUploadMb, "maxUploadMb", 1);
            Range(l.MemberMbPerDay, "memberMbPerDay", 0);
            Range(l.GuestMbPerDay, "guestMbPerDay", 0);
            Range(l.SoundMaxSeconds, "soundMaxSeconds", 0);
            Range(l.SoundMaxMb, "soundMaxMb", 0);
            Range(l.EmojiMaxKb, "emojiMaxKb", 0);
            Range(l.StickerMaxKb, "stickerMaxKb", 0);
        }

        var bots = s.BuiltinBots.Select(b => b.Trim().ToLowerInvariant()).Distinct().ToArray();
        foreach (var bot in bots)
            if (!BuiltinBotFeature.Bots.Any(k => k.Id == bot))
                fail($"'settings.builtinBots': there's no built-in bot called '{bot}'. Use: {string.Join(", ", BuiltinBotFeature.Bots.Select(k => k.Id))}.");

        string? bugInbox = null;
        if (!string.IsNullOrWhiteSpace(s.BugInbox))
        {
            var named = channels.Where(c => c.Name.Equals(s.BugInbox.Trim(), StringComparison.OrdinalIgnoreCase)).ToArray();
            if (named.Length != 1) fail($"'settings.bugInbox' must name exactly one of the template's text channels ('{s.BugInbox}').");
            if (named[0].Kind != "text") fail($"'settings.bugInbox': '{named[0].Name}' isn't a text channel.");
            bugInbox = named[0].Name;
        }
        return new TemplateSettings { NotifyDefault = notify, Limits = s.Limits, BuiltinBots = bots, BugInbox = bugInbox, Translation = s.Translation };
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

        // Roles first, so channels can name them. Listed highest first; each new role starts below the ones before it.
        var roleIds = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        foreach (var role in template.Roles)
        {
            var perms = role.Permissions.Aggregate(Perm.None, (all, p) => all | RoleFeature.PermNames[p]);
            var created = store.CreateRole(role.Name, role.Color, role.Icon, role.Hoist, perms, now);
            if (role.Mentionable) store.UpdateRole(created with { Mentionable = true });
            roleIds[role.Name] = created.Id;
        }

        // The starting #general becomes the template's first text channel, so there's never an extra one.
        var starter = store.AllChannels().FirstOrDefault();
        var channelIds = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        void Place(TemplateChannel c, long? categoryId)
        {
            var write = c.WriteRole ?? c.ReadRole;
            Channel channel;
            if (starter is not null && c.Kind == "text")
            {
                channel = starter with { Name = c.Name, ReadRole = c.ReadRole, WriteRole = write };
                store.UpdateChannel(channel);
                starter = null;
            }
            else channel = store.CreateChannel(c.Name, c.Kind, c.ReadRole, write, now);
            if (c.UserLimit > 0) store.SetUserLimit(channel.Id, c.UserLimit);
            if (c.Hifi) store.SetHifi(channel.Id, true);
            if (c.Slowmode > 0) store.SetSlowmode(channel.Id, c.Slowmode);
            if (c.Tags.Length > 0) store.SetForumTags(channel.Id, c.Tags.Select(t => ((long?)null, t.Name, t.Emoji)).ToList());
            foreach (var o in c.Overrides)
                store.SetOverride(channel.Id, roleIds[o.Role], ChannelPerms(o.Allow), ChannelPerms(o.Deny));
            channelIds.TryAdd(c.Name, channel.Id);
            store.MoveChannel(channel.Id, categoryId, beforeId: null);
            AddContent(world, channel, c, apply: true, [], now);
        }

        foreach (var channel in template.Channels) Place(channel, null);
        foreach (var category in template.Categories)
        {
            var created = store.CreateCategory(category.Name);
            foreach (var channel in category.Channels) Place(channel, created.Id);
        }
        foreach (var (role, style) in template.BuiltinRoles)
        {
            if (style.Color is not null) store.SetBaseRoleColor(role, style.Color);
            if (role != Sessions.Roles.Owner && (style.Abilities is not null || style.Permissions is not null))
            {
                var defaults = BaseRoles.Effective(role, null);
                var abilities = style.Abilities?.Aggregate(0L, (all, n) => BaseRoles.TryParse(n, out var a) ? all | BaseRoles.Bit(a) : all) ?? defaults.Abilities;
                var perms = style.Permissions?.Aggregate(Perm.None, (all, n) => all | RoleFeature.PermNames[n]) ?? defaults.Perms;
                store.SetBaseRoleChange(role, BaseRoles.ChangeFor(role, abilities, perms));
            }
        }
        if (template.Afk is { } afk && channelIds.TryGetValue(afk.Channel, out var afkId))
            store.SaveAfk(new AfkSettings(afkId, afk.Minutes,
                afk.CanTalk.Where(Sessions.Roles.IsValid).ToArray(), afk.CanTalk.Where(roleIds.ContainsKey).Select(n => roleIds[n]).ToArray()));
        if (template.Rules is { } rules && (rules.Text.Length > 0 || rules.Welcome.Length > 0))
            store.SaveRules(new ServerRules(rules.Text, rules.Welcome, rules.Required, rules.Required ? 1 : 0, now, ""));

        if (template.Settings is { } settings)
        {
            if (settings.NotifyDefault is { } notify) store.SetNotifyDefault(notify == NotifyFeature.Auto ? null : notify);
            if (settings.Limits is { } l)
                world.UpdateSettings(w => w with
                {
                    MaxUploadMb = l.MaxUploadMb ?? w.MaxUploadMb,
                    UploadQuota = w.UploadQuota with
                    {
                        MemberMbPerDay = l.MemberMbPerDay ?? w.UploadQuota.MemberMbPerDay,
                        GuestMbPerDay = l.GuestMbPerDay ?? w.UploadQuota.GuestMbPerDay,
                    },
                    Limits = w.Limits with
                    {
                        SoundMaxSeconds = l.SoundMaxSeconds ?? w.Limits.SoundMaxSeconds,
                        SoundMaxMb = l.SoundMaxMb ?? w.Limits.SoundMaxMb,
                        EmojiMaxKb = l.EmojiMaxKb ?? w.Limits.EmojiMaxKb,
                        StickerMaxKb = l.StickerMaxKb ?? w.Limits.StickerMaxKb,
                    },
                });
            foreach (var bot in settings.BuiltinBots)
                BuiltinBotFeature.Enable(store, BuiltinBotFeature.Bots.First(k => k.Id == bot), "", now);
            if (settings.BugInbox is { } inbox && channelIds.TryGetValue(inbox, out var inboxId)) store.SetBugInbox(true, inboxId);
            if (settings.Translation) world.UpdateSettings(w => w with { Translate = w.Translate with { Offer = true } });
        }

        store.MarkTemplateApplied(id, now);
        SecurityLog.Record(store, now, "server.template", details: new { template = id, channels = store.AllChannels().Count, roles = template.Roles.Length });
        return Outcome.Applied;
    }

    private static ChannelPerm ChannelPerms(string[] names) => names.Aggregate(ChannelPerm.None, (all, n) => all | n switch
    {
        "view" => ChannelPerm.View,
        "send" => ChannelPerm.Send,
        "connect" => ChannelPerm.Connect,
        "speak" => ChannelPerm.Speak,
        _ => ChannelPerm.None,
    });

    /// <summary>
    /// On startup (server.json "Template", or --template): sets up a new server from the template once. Reads the
    /// template only when it's still needed, so a template file removed after setup never stops the server.
    /// Throws <see cref="TemplateException"/> for a template that can't be used.
    /// </summary>
    public static Outcome ApplyOnStart(World world, string nameOrPath, long now)
    {
        if (world.Store.AppliedTemplate() is not null) return Outcome.AlreadyApplied;
        if (!world.Store.IsNewServer()) return Outcome.NotNew;
        return Apply(world, Load(ResolvePath(world, nameOrPath)), IdOf(nameOrPath), now);
    }

    /// <summary>A relative template file is looked for in the world folder first (where the desktop app puts one), then from here.</summary>
    private static string ResolvePath(World world, string nameOrPath)
    {
        var key = nameOrPath.Trim();
        if (!key.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || Path.IsPathRooted(key)) return key;
        var inWorld = Path.Combine(world.Path, key);
        return File.Exists(inWorld) ? inWorld : key;
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
