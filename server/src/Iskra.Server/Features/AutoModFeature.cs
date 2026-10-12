using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public sealed record AutoModAction(long TimeoutMs = 0, bool Alert = false);
public sealed record AutoModWords(bool Enabled, string[] Blocked, string[] Allowed, AutoModAction Action);
public sealed record AutoModMentions(bool Enabled, int Max, AutoModAction Action);
/// <summary>Flood (any messages) and duplicates (the same text): more than <c>Count</c> within <c>Seconds</c>.</summary>
public sealed record AutoModRate(bool Enabled, int Count, int Seconds, AutoModAction Action);
public sealed record AutoModLinks(bool Enabled, string Mode, string[] AllowedDomains, AutoModAction Action);

public sealed record AutoModConfig(bool Enabled, AutoModWords Words, AutoModMentions Mentions, AutoModRate Flood, AutoModRate Duplicates,
    AutoModLinks Links, long[] ExemptRoles, long[] ExemptChannels, long? AlertChannelId)
{
    /// <summary>Off, with every rule off: nothing changes until an admin turns it on.</summary>
    public static readonly AutoModConfig Default = new(false,
        new(false, [], [], new()), new(false, 10, new()), new(false, 8, 10, new()), new(false, 3, 60, new()),
        new(false, "invites", [], new()), [], [], null);
}

/// <summary>
/// AutoMod: server-side rules that stop messages before they are stored or sent to anyone. Blocked words, mention spam,
/// flooding, repeated messages and links. A blocked message can also time its sender out and post an alert in a chosen
/// channel. Admins and the owner are never checked; chosen roles and channels can be exempt. Settings are compiled
/// once when they change. End-to-end encrypted DMs and groups can't be read by the server, so AutoMod never sees them.
/// </summary>
public static class AutoModFeature
{
    public const int MaxBlocked = 500;
    public const int MaxAllowed = 100;
    public const int MaxWordLength = 50;
    public const int MaxWildcards = 4;
    public const int MaxDomains = 50;
    public const int MaxExemptRoles = 100;
    public const int MaxExemptChannels = 500;
    public const int SnippetLength = 120;
    /// <summary>At most one audit entry and alert per member and rule in this time (a timeout or the rate limits stop the rest).</summary>
    public const long ReportIntervalMs = 30_000;
    /// <summary>Alerts are posted by this author, which can never be an account key.</summary>
    public const string Author = "automod:";

    private static readonly ConditionalWeakTable<World, Engine> Engines = new();

    public static void Register(Router router)
    {
        router.Add("automod.get", Get);
        router.Add("automod.update", Update);
    }

    private static Engine EngineFor(World world) => Engines.GetValue(world, _ => new Engine());

    private static void RequireManager(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageAutoMod)) throw RequestException.Forbidden("You can't manage AutoMod on this server.", "manage_automod");
    }

    private static object Get(Session s, Member me, Body body)
    {
        RequireManager(me);
        return new { automod = View(s.World.Store, EngineFor(s.World).Current(s.World.Store).Config) };
    }

    /// <summary>The settings, without roles and channels that were deleted since.</summary>
    private static AutoModConfig View(Store store, AutoModConfig c)
    {
        var roles = store.AllRoles().Select(r => r.Id).ToHashSet();
        var channels = store.AllChannels().Select(ch => ch.Id).ToHashSet();
        return c with
        {
            ExemptRoles = c.ExemptRoles.Where(roles.Contains).ToArray(),
            ExemptChannels = c.ExemptChannels.Where(channels.Contains).ToArray(),
            AlertChannelId = c.AlertChannelId is { } id && channels.Contains(id) ? id : null,
        };
    }

    private static object Update(Session s, Member me, Body body)
    {
        RequireManager(me);
        var element = body.Element("automod");
        if (element.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'automod' must be an object.");
        var config = Parse(s, me, new Body(element));
        s.World.Store.SaveAutoModConfig(JsonSerializer.Serialize(config, Json.Options), s.Now);
        EngineFor(s.World).Set(config);
        var rules = new (string Name, bool On)[]
        {
            ("words", config.Words.Enabled), ("mentions", config.Mentions.Enabled), ("flood", config.Flood.Enabled),
            ("duplicates", config.Duplicates.Enabled), ("links", config.Links.Enabled),
        };
        Audit.Record(s, "automod.update", details: new
        {
            enabled = config.Enabled, rules = rules.Where(r => r.On).Select(r => r.Name), blockedWords = config.Words.Blocked.Length,
        });
        return new { automod = View(s.World.Store, config) };
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    private static AutoModConfig Parse(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var d = AutoModConfig.Default;

        Body Section(string name) =>
            body.OptionalElement(name) is { } e
                ? e.ValueKind == JsonValueKind.Object ? new Body(e) : throw RequestException.BadRequest($"'{name}' must be an object.")
                : new Body(JsonDocument.Parse("{}").RootElement);

        AutoModAction Action(Body rule)
        {
            if (rule.OptionalElement("action") is not { } element) return new();
            if (element.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'action' must be an object.");
            var section = new Body(element);
            var timeout = section.OptionalLong("timeoutMs", min: 0) ?? 0;
            if (timeout != 0 && !ModerationFeature.TimeoutDurations.Contains(timeout))
                throw RequestException.BadRequest("'timeoutMs' must be 0 or one of the timeout lengths (60 s, 5 min, 1 hour, 1 day, 1 week).");
            if (timeout != 0 && !Permissions.Has(me, Perm.TimeoutMembers))
                throw RequestException.Forbidden("You can't time members out, so AutoMod can't either.", "automod_timeout_perm");
            return new AutoModAction(timeout, section.OptionalBool("alert") ?? false);
        }

        var words = Section("words");
        var mentions = Section("mentions");
        var flood = Section("flood");
        var duplicates = Section("duplicates");
        var links = Section("links");

        var mode = links.OptionalString("mode", 16) ?? "invites";
        if (mode is not ("invites" or "all")) throw RequestException.BadRequest("'links.mode' must be \"invites\" or \"all\".");
        var domains = links.OptionalStringArray("allowedDomains", MaxDomains, 200)
            .Select(x => x.Trim().ToLowerInvariant())
            .Select(x => x.StartsWith("https://") ? x[8..] : x.StartsWith("http://") ? x[7..] : x)
            .Select(x => x.StartsWith("*.") ? x[2..] : x.StartsWith("www.") ? x[4..] : x)
            .Select(x => x.TrimEnd('/'))
            .Where(x => x.Length > 0).Distinct().ToArray();
        if (domains.FirstOrDefault(x => !AutoModRules.IsDomain(x)) is { } badDomain)
            throw RequestException.BadRequest($"\"{AutoModRules.Cut(badDomain, 40)}\" isn't a domain like example.com.");

        var exemptRoles = LongList(body, "exemptRoles", MaxExemptRoles);
        var roles = store.AllRoles().Select(r => r.Id).ToHashSet();
        if (exemptRoles.Any(id => !roles.Contains(id))) throw RequestException.BadRequest("Unknown role in 'exemptRoles'.");
        var exemptChannels = LongList(body, "exemptChannels", MaxExemptChannels);
        foreach (var id in exemptChannels)
            if (store.GetChannel(id) is not { Kind: not "thread" } ch || !Permissions.CanRead(me, ch))
                throw RequestException.BadRequest("Unknown channel in 'exemptChannels'.");
        var alertChannel = body.OptionalLong("alertChannelId", min: 1);
        if (alertChannel is { } alertId && (store.GetChannel(alertId) is not { Kind: "text" } alert || !Permissions.CanRead(me, alert)))
            throw RequestException.BadRequest("Alerts can only go to a text channel you can see.", "automod_alert_channel");
        if (alertChannel is { } alertChannelId && store.GetE2ee(alertChannelId) is not null)
            throw RequestException.BadRequest("Alerts can't go to an end-to-end encrypted channel.", "automod_alert_e2ee");

        return new AutoModConfig(
            body.OptionalBool("enabled") ?? false,
            new AutoModWords(words.OptionalBool("enabled") ?? false,
                WordList(words, "blocked", MaxBlocked), WordList(words, "allowed", MaxAllowed), Action(words)),
            new AutoModMentions(mentions.OptionalBool("enabled") ?? false,
                (int)(mentions.OptionalLong("max", 1, 50) ?? d.Mentions.Max), Action(mentions)),
            new AutoModRate(flood.OptionalBool("enabled") ?? false,
                (int)(flood.OptionalLong("count", 2, 50) ?? d.Flood.Count), (int)(flood.OptionalLong("seconds", 2, 120) ?? d.Flood.Seconds), Action(flood)),
            new AutoModRate(duplicates.OptionalBool("enabled") ?? false,
                (int)(duplicates.OptionalLong("count", 1, 20) ?? d.Duplicates.Count),
                (int)(duplicates.OptionalLong("seconds", 5, 3600) ?? d.Duplicates.Seconds), Action(duplicates)),
            new AutoModLinks(links.OptionalBool("enabled") ?? false, mode, domains, Action(links)),
            exemptRoles, exemptChannels, alertChannel);
    }

    /// <summary>Trimmed, blank lines dropped, duplicates (as AutoMod reads them) merged.</summary>
    private static string[] WordList(Body section, string name, int max)
    {
        var raw = section.OptionalStringArray(name, max, MaxWordLength * 2);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var list = new List<string>();
        foreach (var entry in raw.Select(x => x.Trim()).Where(x => x.Length > 0))
        {
            if (entry.Length > MaxWordLength || entry.Any(char.IsControl))
                throw RequestException.BadRequest($"Words and phrases can be up to {MaxWordLength} characters.", "automod_word_length", new { max = MaxWordLength });
            if (entry.Count(c => c == '*') > MaxWildcards) throw RequestException.BadRequest($"Use at most {MaxWildcards} * in one entry.", "automod_wildcards", new { max = MaxWildcards });
            var pattern = WordMatcher.Pattern(entry);
            if (pattern.Length == 0) throw RequestException.BadRequest($"\"{AutoModRules.Cut(entry, 20)}\" needs at least one letter or digit.");
            if (seen.Add(string.Join(' ', pattern))) list.Add(entry);
        }
        return [.. list];
    }

    private static long[] LongList(Body body, string name, int max)
    {
        if (body.OptionalElement(name) is not { } e) return [];
        if (e.ValueKind != JsonValueKind.Array || e.GetArrayLength() > max) throw RequestException.BadRequest($"'{name}' must be a list of at most {max} ids.");
        return e.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.Number && x.TryGetInt64(out var id) && id > 0
            ? id : throw RequestException.BadRequest($"'{name}' must be a list of ids.")).Distinct().ToArray();
    }

    // ── Enforcement ──────────────────────────────────────────────────────────

    /// <summary>
    /// Checks text a member is about to post (<paramref name="what"/>: message, edit, poll, post, thread, event, watch) and
    /// throws <c>automod</c> if a rule blocks it, after timing out, auditing and alerting as configured. Messages, polls
    /// and forum posts also count towards the flood and repeat rules. <paramref name="channel"/> is null for events.
    /// </summary>
    internal static void Check(Session s, Member me, Channel? channel, string text, string what)
    {
        var engine = EngineFor(s.World);
        var c = engine.Current(s.World.Store);
        if (!c.Config.Enabled || Exempt(s.World.Store, c, me, channel)) return;

        var isNew = what is "message" or "poll" or "post";
        var folded = FoldedText.Of(text);
        var config = c.Config;
        string? rule = null;
        string? snippet = null;
        AutoModAction? action = null;
        string? reason = null;

        if (config.Words.Enabled && c.Words.Find(folded) is { Count: > 0 } hits)
        {
            (rule, action, snippet, reason) = ("words", config.Words.Action, WordMatcher.Masked(folded, hits, SnippetLength),
                "it contains a word that isn't allowed on this server");
        }
        else if (config.Mentions.Enabled && AutoModRules.Mentions(text) > config.Mentions.Max)
        {
            (rule, action, reason) = ("mentions", config.Mentions.Action, $"it mentions too many people (the limit is {config.Mentions.Max})");
        }
        else if (config.Links.Enabled && AutoModRules.HasBlockedLink(folded.Text, config.Links.Mode == "invites", c.Domains))
        {
            (rule, action, reason) = ("links", config.Links.Action,
                config.Links.Mode == "invites" ? "invite links to other servers aren't allowed here" : "links aren't allowed here");
        }
        else if (isNew && engine.Repeats(me.AccountKey, config, AutoModRules.Repeatable(folded), s.Now) is { } repeat)
        {
            (rule, action, reason) = repeat == "flood"
                ? ("flood", config.Flood.Action, "you're sending messages too fast")
                : ("duplicates", config.Duplicates.Action, "you've sent the same message too many times");
        }
        if (rule is null) return;

        snippet ??= AutoModRules.Cut(text, SnippetLength);
        var timeout = Enforce(s, engine, config, me, channel, rule, action!, snippet, what);
        var suffix = timeout > 0 ? $" You're timed out for {Duration(timeout)}." : "";
        var key = rule == "links" && config.Links.Mode == "invites" ? "automod_invites" : $"automod_{rule}";
        throw new RequestException("automod", $"Blocked by AutoMod: {reason}.{suffix}", key,
            new { max = config.Mentions.Max, timeoutMs = timeout });
    }

    private static bool Exempt(Store store, Compiled c, Member me, Channel? channel)
    {
        if (Permissions.IsAdmin(me)) return true;
        if (me.RoleIds.Any(c.ExemptRoles.Contains)) return true;
        if (channel is null) return false;
        if (c.ExemptChannels.Contains(channel.Id)) return true;
        return channel.Kind == "thread" && store.GetThread(channel.Id) is { } t && c.ExemptChannels.Contains(t.ParentId);
    }

    /// <summary>Times out, audits and alerts. Returns the timeout given (0 if none).</summary>
    private static long Enforce(Session s, Engine engine, AutoModConfig config, Member me, Channel? channel, string rule,
        AutoModAction action, string snippet, string what)
    {
        var store = s.World.Store;
        var timeout = 0L;
        if (action.TimeoutMs > 0)
        {
            var until = s.Now + action.TimeoutMs;
            if ((store.TimedOutUntil(me.AccountKey, s.Now) ?? 0) < until)
            {
                store.SetTimeout(new MemberTimeout(me.AccountKey, until, $"AutoMod: {RuleName(rule)}", Author, s.Now));
                s.Hub.Broadcast(Frames.Event("member.updated", new { member = s.Hub.PublicMember(me) }));
                s.Voice.RemoveEverywhere(me.AccountKey);
                timeout = action.TimeoutMs;
            }
        }
        if (!engine.ShouldReport(me.AccountKey, rule, s.Now) && timeout == 0) return 0;

        // Audit (never the text itself).
        store.AddAudit(s.Now, "automod.block", Author, "AutoMod", me.AccountKey, me.Name, RuleName(rule),
            JsonSerializer.Serialize(new { rule, what, channelId = channel?.Id, channelName = channel?.Name, timeoutMs = timeout }, Json.Options));

        if (!action.Alert || config.AlertChannelId is not { } alertId || store.GetChannel(alertId) is not { Kind: "text" } alertChannel) return timeout;
        // Name the channel and quote the message only if everyone who can read the alert could read the original.
        var visible = channel is null || Roles.Rank(channel.ReadRole) <= Roles.Rank(alertChannel.ReadRole);
        var details = new
        {
            rule, what, member = me.AccountKey, memberName = me.Name,
            channelId = visible ? channel?.Id : null, channelName = visible ? channel?.Name : null,
            snippet = visible ? snippet : null, timeoutMs = timeout,
        };
        var message = store.AddAutoModAlert(alertChannel.Id, Author, s.Now, JsonSerializer.Serialize(details, Json.Options));
        s.Hub.BroadcastToReaders(alertChannel, Frames.Event("chat.message", new { message = MessageViews.Public(store, message) }));
        return timeout;
    }

    private static string RuleName(string rule) => rule switch
    {
        "words" => "blocked word",
        "mentions" => "mention spam",
        "flood" => "sending too fast",
        "duplicates" => "repeated message",
        "links" => "link",
        _ => rule,
    };

    private static string Duration(long ms) => ms switch
    {
        60_000 => "60 seconds",
        300_000 => "5 minutes",
        3_600_000 => "1 hour",
        86_400_000 => "1 day",
        _ => "1 week",
    };

    /// <summary>The <c>automod</c> part of an alert message, or null for every other message.</summary>
    public static object? MessageView(Store store, Message m)
    {
        if (m.AuthorKey != Author || store.AutoModAlert(m.Id) is not { } details) return null;
        using var doc = JsonDocument.Parse(details);
        return doc.RootElement.Clone();
    }

    // ── Compiled settings and recent messages ────────────────────────────────

    private sealed record Compiled(AutoModConfig Config, WordMatcher Words, HashSet<long> ExemptRoles, HashSet<long> ExemptChannels, string[] Domains)
    {
        public static Compiled From(AutoModConfig c) =>
            new(c, new WordMatcher(c.Words.Blocked, c.Words.Allowed), [.. c.ExemptRoles], [.. c.ExemptChannels], c.Links.AllowedDomains);
    }

    private sealed class Engine
    {
        private volatile Compiled? _current;
        private readonly ConcurrentDictionary<string, Queue<(long At, string Text)>> _recent = new();
        private readonly ConcurrentDictionary<(string, string), long> _reported = new();

        public Compiled Current(Store store)
        {
            if (_current is { } c) return c;
            AutoModConfig config;
            try { config = store.AutoModConfig() is { } json ? Sane(JsonSerializer.Deserialize<AutoModConfig>(json, Json.Options)) : AutoModConfig.Default; }
            catch (JsonException) { config = AutoModConfig.Default; }
            return _current = Compiled.From(config);
        }

        public void Set(AutoModConfig config) => _current = Compiled.From(config);

        /// <summary>Settings saved by an older or newer server may miss parts: those take the defaults.</summary>
        private static AutoModConfig Sane(AutoModConfig? c)
        {
            var d = AutoModConfig.Default;
            if (c is null) return d;
            return c with
            {
                Words = c.Words is null ? d.Words : c.Words with { Blocked = c.Words.Blocked ?? [], Allowed = c.Words.Allowed ?? [], Action = c.Words.Action ?? new() },
                Mentions = c.Mentions is null ? d.Mentions : c.Mentions with { Action = c.Mentions.Action ?? new() },
                Flood = c.Flood is null ? d.Flood : c.Flood with { Action = c.Flood.Action ?? new() },
                Duplicates = c.Duplicates is null ? d.Duplicates : c.Duplicates with { Action = c.Duplicates.Action ?? new() },
                Links = c.Links is null ? d.Links : c.Links with { AllowedDomains = c.Links.AllowedDomains ?? [], Action = c.Links.Action ?? new(), Mode = c.Links.Mode ?? "invites" },
                ExemptRoles = c.ExemptRoles ?? [],
                ExemptChannels = c.ExemptChannels ?? [],
            };
        }

        /// <summary>"flood" or "duplicates" if this message breaks one of them; otherwise remembers it and returns null.</summary>
        public string? Repeats(string account, AutoModConfig config, string text, long now)
        {
            if (!config.Flood.Enabled && !config.Duplicates.Enabled) return null;
            if (text.Length > 500) text = text[..500];
            var recent = _recent.GetOrAdd(account, _ => new Queue<(long, string)>());
            lock (recent)
            {
                while (recent.Count > 0 && (now - recent.Peek().At > 3_600_000 || recent.Count > 100)) recent.Dequeue();
                if (config.Flood.Enabled && recent.Count(r => now - r.At < config.Flood.Seconds * 1000L) >= config.Flood.Count) return "flood";
                if (config.Duplicates.Enabled && text.Length > 0
                    && recent.Count(r => r.Text == text && now - r.At < config.Duplicates.Seconds * 1000L) >= config.Duplicates.Count)
                    return "duplicates";
                recent.Enqueue((now, text));
            }
            if (_recent.Count > 10_000)
                foreach (var (key, queue) in _recent)
                    lock (queue) if (queue.Count == 0 || now - queue.Last().At > 3_600_000) _recent.TryRemove(key, out _);
            return null;
        }

        public bool ShouldReport(string account, string rule, long now)
        {
            var key = (account, rule);
            if (_reported.TryGetValue(key, out var last) && now - last < ReportIntervalMs) return false;
            _reported[key] = now;
            if (_reported.Count > 10_000)
                foreach (var (k, at) in _reported)
                    if (now - at > ReportIntervalMs) _reported.TryRemove(k, out _);
            return true;
        }
    }
}
