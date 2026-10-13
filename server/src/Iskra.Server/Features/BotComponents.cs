using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Buttons and select menus on bots' messages, and the forms (modals) bots show: validated into a clean copy that keeps
/// only the known fields. Limits in PROTOCOL.md "Bot interactions".
/// </summary>
public static class BotComponents
{
    public const int MaxRows = 5;
    public const int MaxButtons = 5;
    public const int MaxBytes = 8 * 1024;
    public const int MaxCustomId = 100;
    public const int MaxLabel = 80;
    public const int MaxPlaceholder = 100;
    public const int MaxUrl = 512;
    public const int MaxOptions = 25;
    public const int MaxOptionText = 100;
    public const int MaxFields = 5;
    public const int MaxModalTitle = 45;
    public const int MaxFieldLabel = 45;
    public const int MaxParagraph = 4000;
    public const int MaxShort = 1000;

    private static readonly HashSet<string> Styles = ["primary", "secondary", "success", "danger", "link"];

    /// <summary>The components of a <c>chat.send</c>/<c>chat.edit</c>/<c>interaction.respond</c> body (null when absent). Bots only.</summary>
    public static JsonArray? Parse(Session s, Member me, Body body)
    {
        if (body.OptionalElement("components") is not { } list) return null;
        if (!s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Only bots can add buttons and menus.");
        return Rows(list);
    }

    public static JsonArray Rows(JsonElement list)
    {
        if (list.ValueKind != JsonValueKind.Array) throw Bad("'components' must be a list of rows.");
        if (list.GetArrayLength() > MaxRows) throw Bad($"At most {MaxRows} rows of components.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var rows = new JsonArray();
        foreach (var row in list.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object || Str(row, "type") != "row") throw Bad("Each component row must be { type: \"row\", items }.");
            if (Get(row, "items") is not { ValueKind: JsonValueKind.Array } items || items.GetArrayLength() == 0)
                throw Bad("Each row needs 'items'.");
            var parsed = new JsonArray();
            var kinds = items.EnumerateArray().Select(i => i.ValueKind == JsonValueKind.Object ? Str(i, "type") : null).ToList();
            if (kinds.All(k => k == "button"))
            {
                if (kinds.Count > MaxButtons) throw Bad($"A row can have at most {MaxButtons} buttons.");
                foreach (var item in items.EnumerateArray()) parsed.Add(Button(item, ids));
            }
            else if (kinds is ["select"]) parsed.Add(Select(items[0], ids));
            else throw Bad("A row has 1–5 buttons or exactly one select menu.");
            rows.Add(new JsonObject { ["type"] = "row", ["items"] = parsed });
        }
        if (Encoding.UTF8.GetByteCount(rows.ToJsonString()) > MaxBytes) throw Bad($"Components can be at most {MaxBytes / 1024} KB.");
        return rows;
    }

    private static JsonObject Button(JsonElement item, HashSet<string> ids)
    {
        var style = Str(item, "style") ?? "secondary";
        if (!Styles.Contains(style)) throw Bad($"Button 'style' must be one of {string.Join(", ", Styles)}.");
        var button = new JsonObject { ["type"] = "button", ["label"] = Line(item, "label", MaxLabel, "button"), ["style"] = style };
        if (style == "link")
        {
            var url = Str(item, "url");
            if (url is null || url.Length > MaxUrl || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
                throw Bad($"Link buttons need an http(s) 'url' of at most {MaxUrl} characters.");
            if (Get(item, "customId") is not null) throw Bad("Link buttons have a 'url', not a 'customId'.");
            button["url"] = uri.AbsoluteUri;
        }
        else
        {
            if (Get(item, "url") is not null) throw Bad("Only link buttons have a 'url'.");
            button["customId"] = CustomId(item, ids);
        }
        if (Flag(item, "disabled")) button["disabled"] = true;
        return button;
    }

    private static JsonObject Select(JsonElement item, HashSet<string> ids)
    {
        var select = new JsonObject { ["type"] = "select", ["customId"] = CustomId(item, ids) };
        if (Line(item, "placeholder", MaxPlaceholder, "select menu", required: false) is { } placeholder) select["placeholder"] = placeholder;
        if (Get(item, "options") is not { ValueKind: JsonValueKind.Array } options || options.GetArrayLength() is 0 or > MaxOptions)
            throw Bad($"A select menu needs 1–{MaxOptions} 'options'.");
        var values = new HashSet<string>(StringComparer.Ordinal);
        var parsed = new JsonArray();
        foreach (var option in options.EnumerateArray())
        {
            if (option.ValueKind != JsonValueKind.Object) throw Bad("Each select option must be an object.");
            var value = Line(option, "value", MaxOptionText, "select option")!;
            if (!values.Add(value)) throw Bad($"The select option value '{value}' is listed twice.");
            var o = new JsonObject { ["label"] = Line(option, "label", MaxOptionText, "select option"), ["value"] = value };
            if (Line(option, "description", MaxOptionText, "select option", required: false) is { } description) o["description"] = description;
            if (Flag(option, "default")) o["default"] = true;
            parsed.Add(o);
        }
        select["options"] = parsed;
        var min = Int(item, "minValues") ?? 1;
        var max = Int(item, "maxValues") ?? 1;
        if (min < 0 || max < 1 || min > max || max > parsed.Count)
            throw Bad("A select menu needs 0 ≤ minValues ≤ maxValues ≤ the number of options, and maxValues ≥ 1.");
        if (min != 1) select["minValues"] = min;
        if (max != 1) select["maxValues"] = max;
        if (Flag(item, "disabled")) select["disabled"] = true;
        return select;
    }

    /// <summary>A form a bot shows: a title and 1–5 text fields.</summary>
    public static JsonObject Modal(JsonElement modal)
    {
        if (modal.ValueKind != JsonValueKind.Object) throw Bad("'modal' must be an object.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var result = new JsonObject { ["customId"] = CustomId(modal, ids), ["title"] = Line(modal, "title", MaxModalTitle, "modal") };
        if (Get(modal, "fields") is not { ValueKind: JsonValueKind.Array } fields || fields.GetArrayLength() is 0 or > MaxFields)
            throw Bad($"A modal needs 1–{MaxFields} 'fields'.");
        ids.Clear();
        var parsed = new JsonArray();
        foreach (var field in fields.EnumerateArray())
        {
            if (field.ValueKind != JsonValueKind.Object) throw Bad("Each modal field must be an object.");
            var style = Str(field, "style") ?? "short";
            if (style is not ("short" or "paragraph")) throw Bad("Modal field 'style' must be short or paragraph.");
            var limit = style == "short" ? MaxShort : MaxParagraph;
            var maxLength = Int(field, "maxLength") ?? (style == "short" ? 200 : MaxParagraph);
            if (maxLength < 1 || maxLength > limit) throw Bad($"Modal field 'maxLength' must be 1–{limit}.");
            var f = new JsonObject
            {
                ["customId"] = CustomId(field, ids), ["label"] = Line(field, "label", MaxFieldLabel, "modal field"), ["style"] = style,
                ["required"] = Get(field, "required") is not { ValueKind: JsonValueKind.False }, ["maxLength"] = maxLength,
            };
            if (Line(field, "placeholder", MaxPlaceholder, "modal field", required: false) is { } placeholder) f["placeholder"] = placeholder;
            if (Get(field, "value") is { } v)
            {
                var value = v.ValueKind == JsonValueKind.String ? Text.Normalize(v.GetString(), maxLength, allowNewlines: style == "paragraph") : null;
                if (value is null) throw Bad("Modal field 'value' must be text within 'maxLength'.");
                f["value"] = value;
            }
            parsed.Add(f);
        }
        result["fields"] = parsed;
        return result;
    }

    // ── Lookups for clicks ───────────────────────────────────────────────────

    /// <summary>The clickable component with this id (not disabled, not a link), or null.</summary>
    public static JsonObject? Find(JsonArray? rows, string customId)
    {
        if (rows is null) return null;
        foreach (var row in rows)
        foreach (var item in row!["items"]!.AsArray())
        {
            var o = item!.AsObject();
            if (o["customId"]?.GetValue<string>() != customId) continue;
            return o["disabled"] is not null ? null : o;
        }
        return null;
    }

    /// <summary>Checks select values against the menu; buttons take none.</summary>
    public static string[] Values(JsonObject component, string[] values)
    {
        if (component["type"]!.GetValue<string>() == "button")
        {
            if (values.Length > 0) throw Bad("Buttons don't take 'values'.");
            return values;
        }
        var allowed = component["options"]!.AsArray().Select(o => o!["value"]!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
        var min = component["minValues"]?.GetValue<int>() ?? 1;
        var max = component["maxValues"]?.GetValue<int>() ?? 1;
        if (values.Length < min || values.Length > max || values.Distinct().Count() != values.Length || values.Any(v => !allowed.Contains(v)))
            throw Bad("Pick values from the menu's options.");
        return values;
    }

    public static JsonArray? Load(Store store, long messageId) =>
        store.GetMessageComponents(messageId) is { } raw ? JsonNode.Parse(raw)!.AsArray() : null;

    /// <summary>The <c>components</c> part of a message: null unless a bot added some.</summary>
    public static JsonElement? View(Store store, long messageId)
    {
        if (store.GetMessageComponents(messageId) is not { } raw) return null;
        using var doc = JsonDocument.Parse(raw);
        return doc.RootElement.Clone();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static RequestException Bad(string message) => RequestException.BadRequest(message);

    private static JsonElement? Get(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? v : null;

    private static string? Str(JsonElement e, string name) =>
        Get(e, name) is { } v ? v.ValueKind == JsonValueKind.String ? v.GetString() : throw Bad($"'{name}' must be a string.") : null;

    private static bool Flag(JsonElement e, string name) => Get(e, name) switch
    {
        null => false,
        { ValueKind: JsonValueKind.True } => true,
        { ValueKind: JsonValueKind.False } => false,
        _ => throw Bad($"'{name}' must be true or false."),
    };

    private static int? Int(JsonElement e, string name) =>
        Get(e, name) is { } v ? v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : throw Bad($"'{name}' must be a whole number.") : null;

    private static string? Line(JsonElement e, string name, int max, string what, bool required = true)
    {
        var raw = Str(e, name);
        if (raw is null) return required ? throw Bad($"Each {what} needs a '{name}'.") : null;
        return Text.Normalize(raw, max, allowNewlines: false) ?? throw Bad($"A {what}'s '{name}' must be 1–{max} characters on one line.");
    }

    private static string CustomId(JsonElement e, HashSet<string> ids)
    {
        var id = Str(e, "customId");
        if (id is null || id.Length is 0 or > MaxCustomId || id.Any(c => c < 0x20 || c > 0x7e))
            throw Bad($"'customId' must be 1–{MaxCustomId} characters of printable ASCII.");
        if (!ids.Add(id)) throw Bad($"The customId '{id}' is used twice.");
        return id;
    }
}
