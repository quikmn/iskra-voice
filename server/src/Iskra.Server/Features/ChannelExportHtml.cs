using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Iskra.Server.Features;

/// <summary>
/// Message formatting for channel exports, as safe HTML: every piece of user text is escaped first and only this
/// renderer's own fixed tags are added (no attribute ever carries user text except an escaped http(s) link).
/// Mirrors the client's chat formatting (ui/markdown.tsx) closely enough to read well: code, spoilers, bold, italic,
/// strike, quotes, headings, subtext, lists, links, mentions, custom emoji and timestamps.
/// </summary>
public static partial class ExportMarkdown
{
    public interface IContext
    {
        /// <summary>Display name for a mentioned account (null: unknown).</summary>
        string? NameOf(string accountKey);
        string? RoleName(long roleId);
        string FormatTime(long ms);
    }

    public static string Escape(string text) => WebUtility.HtmlEncode(text);

    /// <summary>
    /// Text used as a name or label, without bidi controls and other invisible format characters (Unicode Cf, e.g.
    /// U+202E that makes "gnp.exe" look like "exe.png"). The emoji joiner (U+200D) stays.
    /// </summary>
    public static string Label(string text)
    {
        static bool Hidden(char c) => c != '‍' && char.GetUnicodeCategory(c) == UnicodeCategory.Format;
        if (!text.Any(Hidden)) return text;
        return new string(text.Where(c => !Hidden(c)).ToArray());
    }

    [GeneratedRegex(@"\Ghttps?://[^\s<>""']+[^\s<>""'.,;:!?)\]]")]
    private static partial Regex UrlAt();
    [GeneratedRegex(@"\G\[([^\]\n]{1,200})\]\((https?://[^\s<>""')]+)\)")]
    private static partial Regex MaskedAt();
    [GeneratedRegex(@"\G<@([A-Za-z0-9_-]{43})>")]
    private static partial Regex MentionAt();
    [GeneratedRegex(@"\G<@&(\d{1,12})>")]
    private static partial Regex RoleAt();
    [GeneratedRegex(@"\G<a?:([A-Za-z0-9_]{1,32}):([A-Za-z0-9_-]{1,64})>")]
    private static partial Regex EmojiAt();
    [GeneratedRegex(@"\G<t:(-?\d{1,13})(?::[tTdDfFR])?>")]
    private static partial Regex TimestampAt();
    [GeneratedRegex(@"<@([A-Za-z0-9_-]{43})>")]
    private static partial Regex Mentions();
    [GeneratedRegex(@"<@&(\d{1,12})>")]
    private static partial Regex RoleMentions();
    [GeneratedRegex(@"^(\d{1,3})\. (.*)$")]
    private static partial Regex Numbered();

    /// <summary>The text with mentions turned into names (no account keys in an export).</summary>
    public static string PlainMentions(string text, IContext ctx)
    {
        if (!text.Contains("<@", StringComparison.Ordinal)) return text;
        text = Mentions().Replace(text, m => "@" + (ctx.NameOf(m.Groups[1].Value) ?? "?"));
        return RoleMentions().Replace(text, m => "@" + (long.TryParse(m.Groups[1].Value, out var id) ? ctx.RoleName(id) ?? "?" : "?"));
    }

    private sealed record Rule(string Open, string Close, string Tag, bool Raw = false, bool WordEdges = false);

    private static readonly Rule[] Inline =
    [
        new("`", "`", "code", Raw: true),
        new("||", "||", "spoiler"),
        new("**", "**", "strong"),
        new("~~", "~~", "s"),
        new("*", "*", "em"),
        new("_", "_", "em", WordEdges: true),
    ];

    private const int MaxDepth = 6;

    /// <summary>Message text as HTML: blocks (code fences, quotes, headings, lists) and inline formatting.</summary>
    public static string ToHtml(string text, IContext ctx)
    {
        var html = new StringBuilder();
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var paragraph = new List<string>();
        void FlushParagraph()
        {
            if (paragraph.Count == 0) return;
            html.Append("<p>").Append(string.Join("<br>", paragraph.Select(l => InlineHtml(l, ctx)))).Append("</p>");
            paragraph.Clear();
        }
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.StartsWith("```", StringComparison.Ordinal) && !(line.Length > 6 && line.EndsWith("```", StringComparison.Ordinal)))
            {
                FlushParagraph();
                var code = new List<string>();
                var j = i + 1;
                for (; j < lines.Length && !lines[j].StartsWith("```", StringComparison.Ordinal); j++) code.Add(lines[j]);
                if (j >= lines.Length) { paragraph.Add(line); continue; } // never closed: plain text
                html.Append("<pre><code>").Append(Escape(string.Join('\n', code))).Append("</code></pre>");
                i = j;
                continue;
            }
            if (line.StartsWith("> ", StringComparison.Ordinal) || line == ">")
            {
                FlushParagraph();
                var quote = new List<string>();
                for (; i < lines.Length && (lines[i].StartsWith("> ", StringComparison.Ordinal) || lines[i] == ">"); i++)
                    quote.Add(lines[i].Length > 2 ? lines[i][2..] : "");
                i--;
                html.Append("<blockquote>").Append(string.Join("<br>", quote.Select(l => InlineHtml(l, ctx)))).Append("</blockquote>");
                continue;
            }
            var heading = line.StartsWith("### ", StringComparison.Ordinal) ? 3 : line.StartsWith("## ", StringComparison.Ordinal) ? 2 : line.StartsWith("# ", StringComparison.Ordinal) ? 1 : 0;
            if (heading > 0)
            {
                FlushParagraph();
                var tag = $"h{heading + 2}";
                html.Append('<').Append(tag).Append(" class=\"md-h\">").Append(InlineHtml(line[(heading + 1)..], ctx)).Append("</").Append(tag).Append('>');
                continue;
            }
            if (line.StartsWith("-# ", StringComparison.Ordinal))
            {
                FlushParagraph();
                html.Append("<p class=\"subtext\">").Append(InlineHtml(line[3..], ctx)).Append("</p>");
                continue;
            }
            if (IsBullet(line) || Numbered().IsMatch(line))
            {
                FlushParagraph();
                var ordered = !IsBullet(line);
                html.Append(ordered ? "<ol>" : "<ul>");
                for (; i < lines.Length; i++)
                {
                    if (!ordered && IsBullet(lines[i])) html.Append("<li>").Append(InlineHtml(lines[i][2..], ctx)).Append("</li>");
                    else if (ordered && Numbered().Match(lines[i]) is { Success: true } n) html.Append("<li>").Append(InlineHtml(n.Groups[2].Value, ctx)).Append("</li>");
                    else break;
                }
                i--;
                html.Append(ordered ? "</ol>" : "</ul>");
                continue;
            }
            paragraph.Add(line);
        }
        FlushParagraph();
        return html.ToString();
    }

    private static bool IsBullet(string line) => line.StartsWith("- ", StringComparison.Ordinal) || line.StartsWith("* ", StringComparison.Ordinal);

    public static string InlineHtml(string text, IContext ctx) => InlineHtml(text, ctx, 0, links: true);

    private static string InlineHtml(string text, IContext ctx, int depth, bool links)
    {
        var html = new StringBuilder();
        var plain = new StringBuilder();
        void Flush()
        {
            if (plain.Length == 0) return;
            html.Append(Escape(plain.ToString()));
            plain.Clear();
        }
        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (c == '<')
            {
                if (MentionAt().Match(text, i) is { Success: true } mention)
                {
                    Flush();
                    html.Append("<span class=\"mention\">@").Append(Escape(ctx.NameOf(mention.Groups[1].Value) ?? "?")).Append("</span>");
                    i += mention.Length;
                    continue;
                }
                if (RoleAt().Match(text, i) is { Success: true } role)
                {
                    Flush();
                    var name = long.TryParse(role.Groups[1].Value, out var id) ? ctx.RoleName(id) : null;
                    html.Append("<span class=\"mention\">@").Append(Escape(name ?? "?")).Append("</span>");
                    i += role.Length;
                    continue;
                }
                if (EmojiAt().Match(text, i) is { Success: true } emoji)
                {
                    plain.Append(':').Append(emoji.Groups[1].Value).Append(':');
                    i += emoji.Length;
                    continue;
                }
                if (TimestampAt().Match(text, i) is { Success: true } stamp && long.TryParse(stamp.Groups[1].Value, out var seconds)
                    && Math.Abs(seconds) < 253_402_300_799)
                {
                    Flush();
                    html.Append("<span class=\"stamp\">").Append(Escape(ctx.FormatTime(seconds * 1000))).Append("</span>");
                    i += stamp.Length;
                    continue;
                }
            }
            if (links && c == '[' && MaskedAt().Match(text, i) is { Success: true } masked)
            {
                Flush();
                html.Append(Link(masked.Groups[2].Value, InlineHtml(masked.Groups[1].Value, ctx, depth + 1, links: false)));
                i += masked.Length;
                continue;
            }
            if (links && c == 'h' && (i == 0 || !char.IsLetterOrDigit(text[i - 1])) && UrlAt().Match(text, i) is { Success: true } url)
            {
                Flush();
                html.Append(Link(url.Value, Escape(url.Value)));
                i += url.Length;
                continue;
            }
            if (depth < MaxDepth && Match(text, i) is { } found)
            {
                Flush();
                var (rule, inner, end) = found;
                var body = rule.Raw ? Escape(inner) : InlineHtml(inner, ctx, depth + 1, links);
                html.Append(rule.Tag == "spoiler" ? "<span class=\"spoiler\" tabindex=\"0\">" : $"<{rule.Tag}>").Append(body)
                    .Append(rule.Tag == "spoiler" ? "</span>" : $"</{rule.Tag}>");
                i = end;
                continue;
            }
            plain.Append(c);
            i++;
        }
        Flush();
        return html.ToString();
    }

    private static (Rule Rule, string Inner, int End)? Match(string text, int at)
    {
        foreach (var rule in Inline)
        {
            if (string.CompareOrdinal(text, at, rule.Open, 0, rule.Open.Length) != 0) continue;
            if (rule.WordEdges && at > 0 && char.IsLetterOrDigit(text[at - 1])) continue;
            var start = at + rule.Open.Length;
            var close = text.IndexOf(rule.Close, start, StringComparison.Ordinal);
            if (close <= start) continue;
            if (rule.WordEdges && close + 1 < text.Length && char.IsLetterOrDigit(text[close + 1])) continue;
            return (rule, text[start..close], close + rule.Close.Length);
        }
        return null;
    }

    /// <summary>Only http(s) links, escaped, opening elsewhere without telling the site where they came from.</summary>
    public static string Link(string url, string innerHtml) =>
        url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            ? $"<a href=\"{Escape(url)}\" rel=\"noopener noreferrer nofollow\" target=\"_blank\">{innerHtml}</a>"
            : innerHtml;
}

/// <summary>The fixed words and look of an exported channel page (channel.html): no script, a strict CSP, nothing from the network.</summary>
public static class ExportPage
{
    public static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> Words = new Dictionary<string, IReadOnlyDictionary<string, string>>
    {
        ["en"] = new Dictionary<string, string>
        {
            ["exported"] = "Exported by {0} on {1}", ["range"] = "From {0} to {1}", ["start"] = "the beginning", ["now"] = "the export",
            ["edited"] = "edited", ["pinned"] = "Pinned", ["thread"] = "Thread", ["threads"] = "Threads", ["poll"] = "Poll",
            ["votes"] = "{0} votes", ["vote"] = "1 vote", ["pollClosed"] = "Ended", ["deletedReply"] = "Replying to a deleted message",
            ["comments"] = "Comments", ["closed"] = "Closed", ["locked"] = "Locked", ["sticker"] = "Sticker", ["gif"] = "GIF",
            ["voiceMessage"] = "Voice message ({0})", ["forwarded"] = "Forwarded", ["empty"] = "No messages in this range.",
            ["noPosts"] = "No posts in this range.", ["noPages"] = "No pages.", ["updated"] = "Updated by {0} on {1}",
            ["formerMember"] = "Former member", ["messages"] = "{0} messages", ["posts"] = "{0} posts", ["pages"] = "{0} pages",
            ["notIncluded"] = "not included", ["footer"] = "Exported from Iskra. Times are in {0}.",
        },
        ["sv"] = new Dictionary<string, string>
        {
            ["exported"] = "Exporterad av {0} den {1}", ["range"] = "Från {0} till {1}", ["start"] = "början", ["now"] = "exporten",
            ["edited"] = "redigerad", ["pinned"] = "Fäst", ["thread"] = "Tråd", ["threads"] = "Trådar", ["poll"] = "Omröstning",
            ["votes"] = "{0} röster", ["vote"] = "1 röst", ["pollClosed"] = "Avslutad", ["deletedReply"] = "Svar på ett borttaget meddelande",
            ["comments"] = "Kommentarer", ["closed"] = "Stängd", ["locked"] = "Låst", ["sticker"] = "Klistermärke", ["gif"] = "GIF",
            ["voiceMessage"] = "Röstmeddelande ({0})", ["forwarded"] = "Vidarebefordrat", ["empty"] = "Inga meddelanden i det här intervallet.",
            ["noPosts"] = "Inga inlägg i det här intervallet.", ["noPages"] = "Inga sidor.", ["updated"] = "Uppdaterad av {0} den {1}",
            ["formerMember"] = "Tidigare medlem", ["messages"] = "{0} meddelanden", ["posts"] = "{0} inlägg", ["pages"] = "{0} sidor",
            ["notIncluded"] = "inte med", ["footer"] = "Exporterad från Iskra. Tiderna är i {0}.",
        },
    };

    /// <summary>The page's only stylesheet; the CSP allows exactly this text (by its hash) and nothing else.</summary>
    public const string Css = """
        :root{color-scheme:dark;--bg:#1e1f24;--panel:#26272e;--line:#34353d;--text:#e6e6ea;--muted:#9a9ba6;--accent:#f0803c;--link:#7cb7ff;--code:#17181c}
        @media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f6f8;--panel:#fff;--line:#e2e2e8;--text:#1d1e22;--muted:#686a75;--accent:#c9561a;--link:#1f5fbf;--code:#eeeef2}}
        *{box-sizing:border-box}
        body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
        header.top{padding:20px 16px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
        .wrap{max-width:928px;margin:0 auto}
        header.top .server{color:var(--muted);font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
        h1{margin:4px 0 6px;font-size:22px}
        .meta,.topic{margin:2px 0;color:var(--muted);font-size:13px}
        main{max-width:960px;margin:0 auto;padding:8px 16px 40px}
        .msg{display:flex;gap:12px;padding:8px 0}
        .msg+.msg{border-top:1px solid transparent}
        .avatar{flex:none;width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff}
        .c0{background:#c9561a}.c1{background:#3b7dd8}.c2{background:#3ba55c}.c3{background:#9b59b6}.c4{background:#d4a017}.c5{background:#d24b6a}.c6{background:#1f9e9e}.c7{background:#6d6f78}
        .body{min-width:0;flex:1}
        .head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
        .author{font-weight:600}
        .tag{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--line);color:var(--muted)}
        time,.edited,.muted{color:var(--muted);font-size:12px}
        .pin{color:var(--accent);font-size:12px}
        .text p{margin:2px 0;overflow-wrap:anywhere}
        .reply{color:var(--muted);font-size:13px;margin-bottom:2px;overflow-wrap:anywhere}
        .reply b{color:var(--text);font-weight:600}
        a{color:var(--link)}
        code{background:var(--code);padding:1px 4px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:13px}
        pre{background:var(--code);padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap}
        pre code{padding:0;background:none}
        blockquote{margin:4px 0;padding-left:10px;border-left:3px solid var(--line)}
        .subtext{color:var(--muted);font-size:12px}
        .md-h{margin:6px 0 2px}
        .mention{background:rgba(124,183,255,.15);color:var(--link);border-radius:4px;padding:0 2px}
        .spoiler{background:var(--muted);color:transparent;border-radius:4px;cursor:pointer}
        .spoiler:hover,.spoiler:focus{background:var(--line);color:inherit}
        .files{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
        .files img,.files video{max-width:min(420px,100%);max-height:360px;border-radius:6px;display:block}
        .file{display:inline-block;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
        .card{margin-top:6px;padding:8px 10px;border-left:3px solid var(--accent);border-radius:4px;background:var(--panel);max-width:520px}
        .card ul{margin:4px 0;padding-left:18px}
        .reactions{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0;padding:0;list-style:none}
        .reactions li{padding:1px 8px;border:1px solid var(--line);border-radius:10px;background:var(--panel);font-size:13px}
        section.thread{margin:8px 0 4px;padding:4px 0 4px 12px;border-left:2px solid var(--line)}
        section.thread h3,section.post h2,section.page h2{margin:6px 0;font-size:15px}
        section.post,section.page{margin:14px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
        section.post h2,section.page h2{font-size:17px}
        .empty{color:var(--muted);padding:24px 0}
        footer{max-width:960px;margin:0 auto;padding:0 16px 24px;color:var(--muted);font-size:12px}
        """;

    public static readonly string CssHash = "sha256-" + Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(Css)));

    public static string Csp =>
        $"default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src '{CssHash}'; base-uri 'none'; form-action 'none'";

    public static string Head(string lang, string title) => $"""
        <!doctype html>
        <html lang="{lang}">
        <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="{Csp}">
        <meta name="referrer" content="no-referrer">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{ExportMarkdown.Escape(title)}</title>
        <style>{Css}</style>
        </head>
        <body>

        """;

    public static string Initial(string name)
    {
        var e = StringInfo.GetTextElementEnumerator(name.Trim());
        return e.MoveNext() ? ((string)e.Current).ToUpperInvariant() : "?";
    }
}
