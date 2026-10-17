using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Sessions;

namespace Iskra.Server.Features;

/// <summary>
/// Helpers for the vendor webhook formats (GitHub, Gitea, GitLab, Slack): reading their JSON safely, cutting
/// user-written text to our limits, building an embed, and checking the sender's signature.
/// </summary>
public static class WebhookText
{
    public static string? Str(JsonElement element, params string[] path)
    {
        foreach (var part in path)
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(part, out element)) return null;
        }
        return element.ValueKind == JsonValueKind.String ? element.GetString() : null;
    }

    public static long? Num(JsonElement element, params string[] path)
    {
        foreach (var part in path)
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(part, out element)) return null;
        }
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out var n) ? n : null;
    }

    public static List<JsonElement> Array(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var a) && a.ValueKind == JsonValueKind.Array
            ? a.EnumerateArray().ToList() : [];

    public static bool IsWebUrl(string? url) =>
        url is not null && url.Length <= 2048 && Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" && u.UserInfo.Length == 0;

    public static string Excerpt(string text, int max) => text.Length <= max ? text : Cut(text, max).TrimEnd() + "…";

    /// <summary>The first <paramref name="max"/> characters, without splitting a surrogate pair.</summary>
    public static string Cut(string text, int max) => text[..(char.IsHighSurrogate(text[max - 1]) ? max - 1 : max)];

    public static string Short(string text, int max, string fallback) => Sanitize(text, max) ?? fallback;

    /// <summary>Text from another service is user-written: same rules as chat, invisible characters dropped rather than rejected.</summary>
    public static string? Sanitize(string? text, int max)
    {
        if (text is null) return null;
        var visible = new string(text.Replace("\r\n", "\n").Where(ch => ch is '\n' or '\t' or '‍' ||
            CharUnicodeInfo.GetUnicodeCategory(ch) is not (UnicodeCategory.Control
                or UnicodeCategory.Format or UnicodeCategory.LineSeparator
                or UnicodeCategory.ParagraphSeparator)).ToArray());
        if (visible.Length > max) visible = Cut(visible, max - 1) + "…";
        return Text.Normalize(visible, max, allowNewlines: true);
    }

    /// <summary>A card: title (256), link, description (4096), colour and the sender's name. Never a picture.</summary>
    public static JsonObject Embed(string title, string? url, string? description, int color, string? author, string fallbackTitle)
    {
        var embed = new JsonObject { ["title"] = Short(title.Replace('\n', ' '), 256, fallbackTitle), ["color"] = color };
        if (IsWebUrl(url)) embed["url"] = url;
        var cleaned = Sanitize(description, 4096);
        if (!string.IsNullOrEmpty(cleaned)) embed["description"] = cleaned;
        if (author is not null && Names.Normalize(Short(author, 32, "")) is { } name) embed["author"] = new JsonObject { ["name"] = name };
        return embed;
    }

    /// <summary>
    /// "`abc1234` Subject · Author · 3 files", then the first paragraph of the message body on its own line
    /// (trailers such as Co-Authored-By left out). GitHub, Gitea and GitLab commits share this shape.
    /// </summary>
    public static string CommitLine(JsonElement commit)
    {
        var id = (Str(commit, "id") ?? "").PadRight(7)[..7];
        var message = (Str(commit, "message") ?? "").Replace("\r\n", "\n").Trim();
        var parts = message.Split("\n\n", 2);
        var subject = parts[0].Replace('\n', ' ');
        var author = Str(commit, "author", "name") ?? Str(commit, "author", "username") ?? "someone";
        var files = new[] { "added", "modified", "removed" }.Sum(k => Array(commit, k).Count);
        var line = $"`{id}` {Excerpt(subject, 160)} · {author}{(files > 0 ? $" · {files} file{(files == 1 ? "" : "s")}" : "")}";
        if (parts.Length > 1)
        {
            var paragraph = string.Join(' ', parts[1].Split("\n\n")[0].Split('\n')
                .Where(l => !Trailer.IsMatch(l))
                .Select(l => l.Trim())).Trim();
            if (paragraph.Length > 0) line += $"\n↳ {Excerpt(paragraph, 240)}";
        }
        return line;
    }

    private static readonly System.Text.RegularExpressions.Regex Trailer =
        new(@"^\s*[A-Za-z-]+-by:", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    /// <summary>Commit lines for a push, at most <paramref name="max"/>, then "…and N more".</summary>
    public static string CommitLines(List<JsonElement> commits, int total, int max = 8)
    {
        var shown = Math.Min(commits.Count, max);
        var text = string.Join("\n", commits.Take(shown).Select(CommitLine));
        return total > shown ? text + $"\n…and {total - shown} more" : text;
    }

    // ── Signatures ───────────────────────────────────────────────────────────

    /// <summary>
    /// GitHub's and Gitea's signature: hex HMAC-SHA256 of the raw body with the shared secret, as
    /// <c>sha256=&lt;hex&gt;</c> (X-Hub-Signature-256) or bare hex (X-Gitea-Signature). Compared in constant time.
    /// </summary>
    public static bool HmacMatches(string secret, byte[] body, string? presented)
    {
        if (string.IsNullOrEmpty(presented)) return false;
        var hex = presented.StartsWith("sha256=", StringComparison.OrdinalIgnoreCase) ? presented[7..] : presented;
        if (hex.Length != 64) return false;
        var expected = Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), body));
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(hex.ToLowerInvariant()));
    }

    /// <summary>GitLab's X-Gitlab-Token: the secret itself. Compared as hashes, in constant time.</summary>
    public static bool TokenMatches(string secret, string? presented) =>
        !string.IsNullOrEmpty(presented) && presented.Length <= 1024 && CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(secret)), SHA256.HashData(Encoding.UTF8.GetBytes(presented)));
}
