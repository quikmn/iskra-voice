using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Sessions;

namespace Iskra.Server.Features;

/// <summary>A webhook request the server can't accept; becomes a 400 with this message.</summary>
public sealed class PayloadException(string message) : Exception(message);

/// <summary>What a webhook asked to post, already validated: the text, an optional name override and embeds (our own JSON shape).</summary>
public sealed record WebhookPostRequest(string Text, string? Username, JsonArray? Embeds, MentionRules Mentions);

/// <summary>Which mentions a post may keep. Everything not allowed is turned into plain text that pings nobody.</summary>
public sealed record MentionRules(bool Users, IReadOnlySet<string>? OnlyUsers, bool Everyone)
{
    public static readonly MentionRules All = new(true, null, true);
    public static readonly MentionRules None = new(false, null, false);
}

/// <summary>
/// Parses Discord-style webhook payloads: <c>content</c>, <c>username</c>, <c>embeds</c> (text parts only) and
/// <c>allowed_mentions</c>, so tools that post to Discord webhooks mostly work unchanged. Limits follow Discord's
/// where they're stricter than ours.
/// </summary>
public static partial class WebhookPayload
{
    public const int MaxEmbeds = 10;
    public const int MaxFields = 25;
    public const int MaxEmbedChars = 6000;
    /// <summary>A card picture's URL; data: URLs up to 16 KB.</summary>
    public const int MaxPictureChars = 16 * 1024;

    public static WebhookPostRequest Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new PayloadException("The body must be a JSON object.");

        var content = OptionalString(root, "content", ChatFeature.MaxMessageLength * 2);
        var text = content is null ? null : Clean(content, ChatFeature.MaxMessageLength, newlines: true, "content");

        var name = OptionalString(root, "username", 256);
        string? username = null;
        if (name is not null)
        {
            var cut = StripInvisible(name).Trim();
            if (cut.Length > Names.MaxLength) cut = cut[..CutAt(cut, Names.MaxLength)];
            username = Names.Normalize(cut) ?? throw new PayloadException("'username' isn't a valid name.");
        }
        // avatar_url / avatarUrl are accepted but not shown: showing them would send every viewer's IP to that site.
        // The webhook's own avatar (set by an admin) is used instead.

        JsonArray? embeds = null;
        if (Field(root, "embeds") is { } embedList)
        {
            embeds = ParseEmbeds(embedList, "embeds", picture: null);
            if (embeds.Count == 0) embeds = null;
        }

        if (text is null && embeds is null) throw new PayloadException("Cannot send an empty message.");
        return new WebhookPostRequest(text ?? "", username, embeds, ParseMentions(root));
    }

    /// <summary>
    /// A list of embeds (webhooks) or cards (bots): the same format and limits. <paramref name="picture"/> checks a
    /// thumbnail or image URL and returns what to store; without it (webhooks) pictures are dropped.
    /// </summary>
    public static JsonArray ParseEmbeds(JsonElement list, string what, Func<string, string>? picture)
    {
        if (list.ValueKind != JsonValueKind.Array) throw new PayloadException($"'{what}' must be a list.");
        if (list.GetArrayLength() > MaxEmbeds) throw new PayloadException($"At most {MaxEmbeds} {what} per message.");
        var total = 0;
        var output = new JsonArray();
        foreach (var embed in list.EnumerateArray())
        {
            var parsed = ParseEmbed(embed, ref total, picture);
            if (parsed.Count > 0) output.Add(parsed);
        }
        if (total > MaxEmbedChars) throw new PayloadException($"{char.ToUpperInvariant(what[0])}{what[1..]} can have at most {MaxEmbedChars} characters in total.");
        return output;
    }

    private static JsonObject ParseEmbed(JsonElement embed, ref int total, Func<string, string>? picture)
    {
        if (embed.ValueKind != JsonValueKind.Object) throw new PayloadException("Each embed must be an object.");
        var output = new JsonObject();
        void Put(string key, string? value, ref int count)
        {
            if (string.IsNullOrEmpty(value)) return;
            output[key] = value;
            count += value.Length;
        }

        Put("title", CleanOptional(embed, "title", 256, newlines: false), ref total);
        Put("description", CleanOptional(embed, "description", 4096, newlines: true), ref total);
        if (Url(embed, "url") is { } url) output["url"] = url;
        if (Field(embed, "color") is { } color)
        {
            if (color.ValueKind != JsonValueKind.Number || !color.TryGetInt32(out var rgb) || rgb is < 0 or > 0xFFFFFF)
                throw new PayloadException("'color' must be a number from 0 to 16777215.");
            output["color"] = rgb;
        }
        if (OptionalString(embed, "timestamp", 64) is { } stamp)
        {
            if (!DateTimeOffset.TryParse(stamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var when))
                throw new PayloadException("'timestamp' must be an ISO 8601 date.");
            output["timestamp"] = when.ToUnixTimeMilliseconds();
        }
        if (Field(embed, "author") is { } author)
        {
            if (author.ValueKind != JsonValueKind.Object) throw new PayloadException("'author' must be an object.");
            var authorName = CleanOptional(author, "name", 256, newlines: false);
            if (authorName is not null)
            {
                total += authorName.Length;
                var a = new JsonObject { ["name"] = authorName };
                if (Url(author, "url") is { } authorUrl) a["url"] = authorUrl;
                output["author"] = a;
            }
        }
        if (Field(embed, "footer") is { } footer)
        {
            if (footer.ValueKind != JsonValueKind.Object) throw new PayloadException("'footer' must be an object.");
            if (CleanOptional(footer, "text", 2048, newlines: true) is { } footerText)
            {
                total += footerText.Length;
                output["footer"] = new JsonObject { ["text"] = footerText };
            }
        }
        if (Field(embed, "fields") is { } fields)
        {
            if (fields.ValueKind != JsonValueKind.Array) throw new PayloadException("'fields' must be a list.");
            if (fields.GetArrayLength() > MaxFields) throw new PayloadException($"At most {MaxFields} fields per embed.");
            var list = new JsonArray();
            foreach (var field in fields.EnumerateArray())
            {
                if (field.ValueKind != JsonValueKind.Object) throw new PayloadException("Each field must be an object.");
                var fieldName = CleanOptional(field, "name", 256, newlines: false) ?? "";
                var fieldValue = CleanOptional(field, "value", 1024, newlines: true) ?? "";
                if (fieldName.Length == 0 && fieldValue.Length == 0) continue;
                total += fieldName.Length + fieldValue.Length;
                var inline = Field(field, "inline") is { ValueKind: JsonValueKind.True };
                list.Add(new JsonObject { ["name"] = fieldName, ["value"] = fieldValue, ["inline"] = inline });
            }
            if (list.Count > 0) output["fields"] = list;
        }
        // Webhooks: images, thumbnails and videos are left out on purpose (no third-party content is loaded by viewers).
        // Bots: only pictures from this server or data: URLs, checked by the caller.
        if (picture is not null)
            foreach (var key in new[] { "thumbnail", "image" })
            {
                if (Field(embed, key) is not { } pic) continue;
                if (pic.ValueKind != JsonValueKind.Object) throw new PayloadException($"'{key}' must be an object with a 'url'.");
                if (OptionalString(pic, "url", MaxPictureChars) is { } picUrl) output[key] = new JsonObject { ["url"] = picture(picUrl) };
            }
        return output;
    }

    /// <summary>Discord's allowed_mentions: { parse: ["users", "everyone"], users: [ids] }. Absent means everything.</summary>
    private static MentionRules ParseMentions(JsonElement root)
    {
        if (Field(root, "allowed_mentions") is not { ValueKind: JsonValueKind.Object } allowed) return MentionRules.All;
        var parse = new HashSet<string>(StringComparer.Ordinal);
        if (Field(allowed, "parse") is { ValueKind: JsonValueKind.Array } p)
            foreach (var item in p.EnumerateArray().Take(10))
                if (item.ValueKind == JsonValueKind.String) parse.Add(item.GetString()!);
        HashSet<string>? only = null;
        if (Field(allowed, "users") is { ValueKind: JsonValueKind.Array } u)
            only = u.EnumerateArray().Take(100).Where(i => i.ValueKind == JsonValueKind.String).Select(i => i.GetString()!).ToHashSet(StringComparer.Ordinal);
        var users = parse.Contains("users") || only is { Count: > 0 };
        return new MentionRules(users, parse.Contains("users") ? null : only, parse.Contains("everyone"));
    }

    [GeneratedRegex(@"<@([A-Za-z0-9_-]{43})>")]
    private static partial Regex UserMention();

    [GeneratedRegex(@"@(everyone|here)\b")]
    private static partial Regex GroupMention();

    /// <summary>
    /// Turns mentions the post may not make into plain text: &lt;@key&gt; becomes "@Name" (no ping), and
    /// @everyone / @here get a zero-width joiner so they no longer match.
    /// </summary>
    public static string SanitizeMentions(string text, MentionRules rules, Func<string, string?> nameOf)
    {
        text = UserMention().Replace(text, m =>
        {
            var key = m.Groups[1].Value;
            var allowed = rules.Users && (rules.OnlyUsers is null || rules.OnlyUsers.Contains(key));
            return allowed ? m.Value : $"@{nameOf(key) ?? "unknown"}";
        });
        return rules.Everyone ? text : GroupMention().Replace(text, m => "@‍" + m.Groups[1].Value);
    }

    // ── Field helpers ───────────────────────────────────────────────────────

    private static JsonElement? Field(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value : null;

    private static string? OptionalString(JsonElement element, string name, int maxLength)
    {
        if (Field(element, name) is not { } value) return null;
        if (value.ValueKind != JsonValueKind.String) throw new PayloadException($"'{name}' must be a string.");
        var text = value.GetString()!;
        if (text.Length > maxLength) throw new PayloadException($"'{name}' is longer than {maxLength} characters.");
        return text;
    }

    private static string? CleanOptional(JsonElement element, string name, int maxLength, bool newlines)
    {
        var raw = OptionalString(element, name, maxLength * 2);
        return raw is null ? null : Clean(raw, maxLength, newlines, name);
    }

    /// <summary>The same rules as chat text, after dropping the zero-width spaces Discord tools use as blank filler.</summary>
    private static string? Clean(string raw, int maxLength, bool newlines, string name)
    {
        var stripped = StripInvisible(raw);
        if (stripped.Trim().Length == 0) return null;
        return Text.Normalize(stripped, maxLength, newlines)
            ?? throw new PayloadException($"'{name}' must be at most {maxLength} characters, with no invisible control characters.");
    }

    private static string StripInvisible(string text) =>
        text.Replace("​", "").Replace("⁠", "").Replace("﻿", "");

    private static string? Url(JsonElement element, string name)
    {
        var raw = OptionalString(element, name, 2048);
        if (raw is null) return null;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0)
            throw new PayloadException($"'{name}' must be an http(s) link.");
        return uri.AbsoluteUri;
    }

    /// <summary>A cut position that doesn't split a surrogate pair.</summary>
    private static int CutAt(string text, int max) => char.IsHighSurrogate(text[max - 1]) ? max - 1 : max;
}
