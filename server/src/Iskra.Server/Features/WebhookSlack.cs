using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Sessions;
using static Iskra.Server.Features.WebhookText;

namespace Iskra.Server.Features;

/// <summary>
/// Slack-compatible incoming webhooks (".../slack"), for tools that only speak Slack: <c>text</c> (Slack's mrkdwn turned
/// into Iskra markdown), <c>blocks</c> (header, section, context, rich_text, divider) and legacy <c>attachments</c>
/// become a message with cards. Images, buttons and icons are left out. Nothing ever pings.
/// </summary>
public static partial class WebhookSlack
{
    public static WebhookPostRequest Translate(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new PayloadException("The body must be a JSON object.");
        var embeds = new JsonArray();
        var total = 0;

        var fromBlocks = Blocks(root);
        if (fromBlocks is not null) Add(embeds, fromBlocks, ref total);
        foreach (var attachment in Array(root, "attachments").Take(WebhookPayload.MaxEmbeds))
            if (Attachment(attachment) is { } card) Add(embeds, card, ref total);

        // With blocks, Slack uses `text` only for notifications; without, it is the message.
        var text = fromBlocks is null ? Sanitize(Mrkdwn(StrLimited(root, "text", ChatFeature.MaxMessageLength * 2)), ChatFeature.MaxMessageLength) : null;
        if (string.IsNullOrEmpty(text) && embeds.Count == 0) throw new PayloadException("No text or blocks to post.");

        string? username = null;
        if (StrLimited(root, "username", 256) is { } name) username = Names.Normalize(Short(name, Names.MaxLength, ""));
        return new WebhookPostRequest(text ?? "", username, embeds.Count == 0 ? null : embeds, MentionRules.None);
    }

    private static void Add(JsonArray embeds, JsonObject card, ref int total)
    {
        var size = card.ToJsonString().Length;
        if (embeds.Count >= WebhookPayload.MaxEmbeds || total + size > WebhookPayload.MaxEmbedChars) return;
        total += size;
        embeds.Add(card);
    }

    private static string? StrLimited(JsonElement element, string name, int max) =>
        Str(element, name) is { } s ? (s.Length > max ? Cut(s, max) : s) : null;

    // ── Blocks ───────────────────────────────────────────────────────────────

    /// <summary>One card from Block Kit: the first header is its title, sections and rich text its text, context its footer.</summary>
    private static JsonObject? Blocks(JsonElement root)
    {
        var blocks = Array(root, "blocks");
        if (blocks.Count == 0) return null;
        string? title = null;
        var paragraphs = new List<string>();
        var footer = new List<string>();
        foreach (var block in blocks.Take(50))
        {
            switch (Str(block, "type"))
            {
                case "header":
                    if (title is null) title = Str(block, "text", "text");
                    else paragraphs.Add($"**{Str(block, "text", "text")}**");
                    break;
                case "section":
                    if (TextObject(block, "text") is { } sectionText) paragraphs.Add(sectionText);
                    var fields = Array(block, "fields").Select(f => TextOf(f)).OfType<string>().ToList();
                    if (fields.Count > 0) paragraphs.Add(string.Join("\n", fields));
                    break;
                case "context":
                    footer.AddRange(Array(block, "elements").Where(e => Str(e, "type") is "mrkdwn" or "plain_text").Select(TextOf).OfType<string>());
                    break;
                case "rich_text":
                    var rich = new System.Text.StringBuilder();
                    RichText(block, rich, 0);
                    if (rich.Length > 0) paragraphs.Add(rich.ToString().Trim());
                    break;
            }
        }
        var card = new JsonObject();
        if (Sanitize(Plain(title), 256) is { Length: > 0 } t) card["title"] = t.Replace('\n', ' ');
        if (Sanitize(string.Join("\n\n", paragraphs.Where(p => p.Length > 0)), 4096) is { Length: > 0 } d) card["description"] = d;
        if (Sanitize(string.Join(" · ", footer), 2048) is { Length: > 0 } f) card["footer"] = new JsonObject { ["text"] = f.Replace('\n', ' ') };
        return card.Count == 0 ? null : card;
    }

    /// <summary>A text object: mrkdwn is converted, plain_text kept as it is.</summary>
    private static string? TextOf(JsonElement text) =>
        StrLimited(text, "text", 4096) is not { } value ? null : Str(text, "type") == "mrkdwn" ? Mrkdwn(value) : value;

    private static string? TextObject(JsonElement block, string name) =>
        block.TryGetProperty(name, out var t) && t.ValueKind == JsonValueKind.Object ? TextOf(t) : null;

    /// <summary>The words of a rich_text block: text and links, list items on their own lines.</summary>
    private static void RichText(JsonElement element, System.Text.StringBuilder into, int depth)
    {
        if (depth > 6 || into.Length > 8000) return;
        foreach (var e in Array(element, "elements").Take(200))
        {
            switch (Str(e, "type"))
            {
                case "text": into.Append(Str(e, "text")); break;
                case "link":
                    var url = Str(e, "url");
                    var label = Str(e, "text");
                    into.Append(IsWebUrl(url) ? label is { Length: > 0 } ? $"[{label}]({url})" : url : label);
                    break;
                case "emoji": into.Append(Str(e, "unicode") is { } u && TryEmoji(u) is { } emoji ? emoji : $":{Str(e, "name")}:"); break;
                case "user": into.Append('@').Append(Str(e, "user_id")); break;
                case "channel": into.Append('#').Append(Str(e, "channel_id")); break;
                case "rich_text_list":
                    foreach (var item in Array(e, "elements").Take(100))
                    {
                        into.Append("\n- ");
                        RichText(item, into, depth + 1);
                    }
                    into.Append('\n');
                    break;
                case "rich_text_section" or "rich_text_quote" or "rich_text_preformatted":
                    RichText(e, into, depth + 1);
                    into.Append('\n');
                    break;
            }
        }
    }

    /// <summary>Slack's emoji "unicode" field is code points in hex joined by dashes ("1f44d" or "1f468-200d-1f4bb").</summary>
    private static string? TryEmoji(string hex)
    {
        try
        {
            return string.Concat(hex.Split('-').Take(8).Select(p => char.ConvertFromUtf32(int.Parse(p, NumberStyles.HexNumber, CultureInfo.InvariantCulture))));
        }
        catch (Exception ex) when (ex is FormatException or OverflowException or ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    // ── Attachments (the older format many tools still send) ─────────────────

    private static JsonObject? Attachment(JsonElement a)
    {
        if (a.ValueKind != JsonValueKind.Object) return null;
        var card = new JsonObject();
        if (Sanitize(Plain(Str(a, "title")), 256) is { Length: > 0 } title) card["title"] = title.Replace('\n', ' ');
        if (Str(a, "title_link") is { } link && IsWebUrl(link)) card["url"] = link;
        var text = string.Join("\n\n", new[] { StrLimited(a, "pretext", 4096), StrLimited(a, "text", 4096) }.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => Mrkdwn(s!)));
        if (text.Length == 0 && card.Count == 0) text = Mrkdwn(StrLimited(a, "fallback", 4096));
        if (Sanitize(text, 4096) is { Length: > 0 } description) card["description"] = description;
        if (Color(Str(a, "color")) is { } color) card["color"] = color;
        if (Sanitize(Str(a, "author_name"), 256) is { Length: > 0 } author)
        {
            var authorObj = new JsonObject { ["name"] = author.Replace('\n', ' ') };
            if (Str(a, "author_link") is { } authorLink && IsWebUrl(authorLink)) authorObj["url"] = authorLink;
            card["author"] = authorObj;
        }
        if (Sanitize(Str(a, "footer"), 2048) is { Length: > 0 } footer) card["footer"] = new JsonObject { ["text"] = footer.Replace('\n', ' ') };
        if (a.TryGetProperty("ts", out var ts) && (ts.ValueKind == JsonValueKind.Number && ts.TryGetDouble(out var seconds)
                || ts.ValueKind == JsonValueKind.String && double.TryParse(ts.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out seconds))
            && seconds is > 0 and < 32_503_680_000)
            card["timestamp"] = (long)(seconds * 1000);
        var fields = new JsonArray();
        foreach (var f in Array(a, "fields").Take(WebhookPayload.MaxFields))
        {
            var name = Sanitize(Plain(Str(f, "title")), 256)?.Replace('\n', ' ') ?? "";
            var value = Sanitize(Mrkdwn(StrLimited(f, "value", 1024)), 1024) ?? "";
            if (name.Length == 0 && value.Length == 0) continue;
            fields.Add(new JsonObject { ["name"] = name, ["value"] = value, ["inline"] = f.TryGetProperty("short", out var s) && s.ValueKind == JsonValueKind.True });
        }
        if (fields.Count > 0) card["fields"] = fields;
        return card.Count == 0 || (card.Count == 1 && card.ContainsKey("color")) ? null : card;
    }

    /// <summary>"#36a64f", "36a64f", or Slack's named colours good / warning / danger.</summary>
    private static int? Color(string? value) => value switch
    {
        null => null,
        "good" => 0x2EB67D,
        "warning" => 0xECB22E,
        "danger" => 0xE01E5A,
        _ when value.TrimStart('#') is { Length: 6 } hex && int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb) => rgb,
        _ => null,
    };

    // ── mrkdwn ───────────────────────────────────────────────────────────────

    [GeneratedRegex(@"<([^<>|\n]{1,2048})(?:\|([^<>\n]{0,512}))?>", RegexOptions.None, 1000)]
    private static partial Regex Special();

    [GeneratedRegex(@"(?<![\w*])\*(?=\S)([^*\n]{1,500}?)(?<=\S)\*(?![\w*])", RegexOptions.None, 1000)]
    private static partial Regex Bold();

    [GeneratedRegex(@"(?<![\w~])~(?=\S)([^~\n]{1,500}?)(?<=\S)~(?![\w~])", RegexOptions.None, 1000)]
    private static partial Regex Strike();

    /// <summary>
    /// Slack's mrkdwn to Iskra markdown: &lt;url|label&gt; links, &lt;@user&gt; / &lt;#channel&gt; / &lt;!here&gt; as plain
    /// text, *bold* and ~strike~, and its &amp;amp; &amp;lt; &amp;gt; escapes undone.
    /// </summary>
    public static string Mrkdwn(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        text = Special().Replace(text, m =>
        {
            var target = m.Groups[1].Value;
            var label = m.Groups[2].Success && m.Groups[2].Value.Length > 0 ? Unescape(m.Groups[2].Value) : null;
            return target[0] switch
            {
                '@' => "@" + (label ?? target[1..]),
                '#' => "#" + (label ?? target[1..]),
                '!' => target[1..].Split('^')[0] switch
                {
                    "here" or "channel" => "@here",
                    "everyone" => "@everyone",
                    _ => label ?? "",
                },
                _ when target.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase) => label ?? target[7..],
                _ when IsWebUrl(Unescape(target)) => label is null ? Unescape(target) : $"[{label.Replace("]", "\\]")}]({Unescape(target)})",
                _ => label ?? Unescape(target),
            };
        });
        text = Bold().Replace(text, "**$1**");
        text = Strike().Replace(text, "~~$1~~");
        return Unescape(text);
    }

    private static string Unescape(string s) => s.Replace("&lt;", "<").Replace("&gt;", ">").Replace("&amp;", "&");

    /// <summary>Plain text for titles: Slack's escapes undone.</summary>
    private static string? Plain(string? s) => s is null ? null : Unescape(s);
}
