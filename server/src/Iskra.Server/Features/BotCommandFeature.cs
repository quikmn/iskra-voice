using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Bot commands and cards: a bot describes the /commands it answers (apps suggest them as people type; the command is
/// still sent as a normal message), and may attach cards to its messages, in the webhook embed format.
/// </summary>
public static partial class BotCommandFeature
{
    public const int MaxCommands = 50;
    public const int MaxOptions = 25;
    public const int MaxChoices = 25;
    public const int MaxListBytes = 16 * 1024;
    public const int MaxNameLength = 32;
    public const int MaxDescription = 100;
    public const int MaxDataPicture = 16 * 1024;

    private static readonly HashSet<string> OptionTypes = ["string", "integer", "number", "boolean", "user", "channel", "role"];

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]{0,31}$")]
    private static partial Regex NamePattern();

    public static void Register(Router router)
    {
        router.Add("bot.commands.set", Set);
        router.Add("bot.commands.available", Available);
    }

    /// <summary>For <c>welcome.botCommands</c>: every member bot with a non-empty list.</summary>
    public static List<object> All(Store store) =>
        store.AllBotCommands().Select(c => (object)new { bot = c.AccountKey, commands = Json(c.Commands) }).ToList();

    private static JsonElement Json(string raw)
    {
        using var doc = JsonDocument.Parse(raw);
        return doc.RootElement.Clone();
    }

    private static object Set(Session s, Member me, Body body)
    {
        if (!s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Only bots can register commands.");
        var list = Commands(body.Element("commands"));
        var raw = list.ToJsonString();
        if (Encoding.UTF8.GetByteCount(raw) > MaxListBytes)
            throw RequestException.BadRequest($"The command list can be at most {MaxListBytes / 1024} KB.");
        s.World.Store.SetBotCommands(me.AccountKey, list.Count == 0 ? null : raw, s.Now);
        var commands = Json(raw);
        s.Hub.Broadcast(Frames.Event("bot.commands", new { bot = me.AccountKey, commands }));
        return new { commands };
    }

    /// <summary>Bots with commands that can read and post here: the ones worth suggesting.</summary>
    private static object Available(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        var parent = channel.Kind == "thread" && store.GetThread(channel.Id) is { } thread ? store.GetChannel(thread.ParentId) : channel;
        if (parent is null || E2eeChannelFeature.IsEncrypted(store, parent) || channel.Kind is not ("text" or "thread" or "voice" or "stage"))
            return new { bots = Array.Empty<string>() };
        var bots = store.AllBotCommands()
            .Select(c => store.GetMember(c.AccountKey))
            .Where(m => m is not null && Permissions.CanSend(m, channel))
            .Select(m => m!.AccountKey)
            .ToList();
        return new { bots };
    }

    // ── Validation ───────────────────────────────────────────────────────────

    private static JsonArray Commands(JsonElement list)
    {
        if (list.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest("'commands' must be a list.");
        if (list.GetArrayLength() > MaxCommands) throw RequestException.BadRequest($"A bot can have at most {MaxCommands} commands.");
        var output = new JsonArray();
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var command in list.EnumerateArray())
        {
            if (command.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each command must be an object.");
            var name = Name(command, "command");
            if (!names.Add(name)) throw RequestException.BadRequest($"The command '{name}' is listed twice.");
            var item = new JsonObject { ["name"] = name, ["description"] = Line(command, "description", MaxDescription, $"/{name}")! };
            if (Line(command, "usage", MaxDescription, $"/{name}", required: false) is { } usage) item["usage"] = usage;
            if (Get(command, "options") is { } options)
            {
                var parsed = Options(options, name);
                if (parsed.Count > 0) item["options"] = parsed;
            }
            output.Add(item);
        }
        return output;
    }

    private static JsonArray Options(JsonElement list, string command)
    {
        if (list.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest($"/{command}: 'options' must be a list.");
        if (list.GetArrayLength() > MaxOptions) throw RequestException.BadRequest($"/{command}: at most {MaxOptions} options.");
        var output = new JsonArray();
        var names = new HashSet<string>(StringComparer.Ordinal);
        var optionalSeen = false;
        foreach (var option in list.EnumerateArray())
        {
            if (option.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest($"/{command}: each option must be an object.");
            var name = Name(option, $"/{command} option");
            if (!names.Add(name)) throw RequestException.BadRequest($"/{command}: the option '{name}' is listed twice.");
            var where = $"/{command} {name}";
            var type = Get(option, "type") is { ValueKind: JsonValueKind.String } t ? t.GetString()! : null;
            if (type is null || !OptionTypes.Contains(type))
                throw RequestException.BadRequest($"{where}: 'type' must be one of {string.Join(", ", OptionTypes)}.");
            var required = Get(option, "required") switch
            {
                null => false,
                { ValueKind: JsonValueKind.True } => true,
                { ValueKind: JsonValueKind.False } => false,
                _ => throw RequestException.BadRequest($"{where}: 'required' must be true or false."),
            };
            if (required && optionalSeen) throw RequestException.BadRequest($"{where}: required options must come before optional ones.");
            optionalSeen |= !required;
            var item = new JsonObject { ["name"] = name, ["description"] = Line(option, "description", MaxDescription, where)!, ["type"] = type };
            if (required) item["required"] = true;
            if (Get(option, "choices") is { } choices)
            {
                if (type is not ("string" or "integer" or "number")) throw RequestException.BadRequest($"{where}: only string, integer and number options have choices.");
                if (choices.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest($"{where}: 'choices' must be a list.");
                if (choices.GetArrayLength() > MaxChoices) throw RequestException.BadRequest($"{where}: at most {MaxChoices} choices.");
                var parsed = new JsonArray();
                foreach (var choice in choices.EnumerateArray())
                {
                    if (choice.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest($"{where}: each choice must be an object.");
                    parsed.Add(new JsonObject { ["name"] = Line(choice, "name", MaxDescription, where)!, ["value"] = ChoiceValue(choice, type, where) });
                }
                if (parsed.Count > 0) item["choices"] = parsed;
            }
            output.Add(item);
        }
        return output;
    }

    private static JsonNode ChoiceValue(JsonElement choice, string type, string where)
    {
        var value = Get(choice, "value") ?? throw RequestException.BadRequest($"{where}: each choice needs a 'value'.");
        switch (type)
        {
            case "string":
                if (value.ValueKind != JsonValueKind.String || value.GetString() is not { Length: >= 1 and <= MaxDescription } text
                    || Text.Normalize(text, MaxDescription, allowNewlines: false) is not { } clean)
                    throw RequestException.BadRequest($"{where}: string choices need a value of 1–{MaxDescription} characters.");
                return JsonValue.Create(clean)!;
            case "integer":
                if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var whole) || Math.Abs(whole) > 9007199254740991)
                    throw RequestException.BadRequest($"{where}: integer choices need a whole number.");
                return JsonValue.Create(whole)!;
            default:
                if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number))
                    throw RequestException.BadRequest($"{where}: number choices need a number.");
                return JsonValue.Create(number)!;
        }
    }

    private static JsonElement? Get(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value : null;

    private static string Name(JsonElement element, string what)
    {
        var name = Get(element, "name") is { ValueKind: JsonValueKind.String } n ? n.GetString()! : null;
        if (name is null || !NamePattern().IsMatch(name))
            throw RequestException.BadRequest($"Each {what} needs a 'name' of 1–{MaxNameLength} characters: a–z, 0–9, _ and -, starting with a letter or digit.");
        return name;
    }

    private static string? Line(JsonElement element, string field, int max, string where, bool required = true)
    {
        if (Get(element, field) is not { } value)
            return required ? throw RequestException.BadRequest($"{where}: '{field}' is required.") : null;
        if (value.ValueKind != JsonValueKind.String) throw RequestException.BadRequest($"{where}: '{field}' must be a string.");
        return Text.Normalize(value.GetString(), max, allowNewlines: false)
            ?? throw RequestException.BadRequest($"{where}: '{field}' must be 1–{max} characters on one line.");
    }

    // ── Cards ────────────────────────────────────────────────────────────────

    [GeneratedRegex("^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$")]
    private static partial Regex DataPicture();

    [GeneratedRegex("^/files/([A-Za-z0-9_-]{16,64})(/[^?#]*)?$")]
    private static partial Regex FilePicture();

    /// <summary>Cards for a message, validated (null when the body has none). Only bots may send them.</summary>
    public static (string Json, List<string> Files)? Parse(Session s, Member me, Body body)
    {
        if (body.OptionalElement("cards") is not { } list) return null;
        if (!s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Only bots can attach cards.");
        var files = new List<string>();
        string Picture(string url)
        {
            if (url.StartsWith("data:", StringComparison.Ordinal))
            {
                if (url.Length > MaxDataPicture || !DataPicture().IsMatch(url))
                    throw new PayloadException($"Card pictures as data: URLs must be PNG, JPEG, GIF or WebP in base64, at most {MaxDataPicture / 1024} KB.");
                return url;
            }
            var match = FilePicture().Match(url);
            var file = match.Success ? s.World.Store.GetFile(match.Groups[1].Value) : null;
            if (file is null) throw new PayloadException("Card pictures must be files uploaded to this server (/files/...) or data: URLs.");
            if (file.Uploader != me.AccountKey) throw new PayloadException("Card pictures must be files the bot uploaded itself.");
            if (!file.Type.StartsWith("image/", StringComparison.Ordinal) || file.Type.Contains("svg", StringComparison.OrdinalIgnoreCase))
                throw new PayloadException("Card pictures must be PNG, JPEG, GIF or WebP images.");
            files.Add(file.Id);
            return Uploads.UrlOf(file);
        }
        try
        {
            var cards = WebhookPayload.ParseEmbeds(list, "cards", Picture);
            return (cards.ToJsonString(), files);
        }
        catch (PayloadException e)
        {
            throw RequestException.BadRequest(e.Message);
        }
    }

    public static void Saved(Store store, long messageId, (string Json, List<string> Files)? cards)
    {
        if (cards is { } c && c.Json != "[]") store.SetMessageCards(messageId, c.Json, c.Files);
    }

    /// <summary>The <c>cards</c> part of a message: null unless a bot attached some.</summary>
    public static JsonElement? View(Store store, long messageId) =>
        store.GetMessageCards(messageId) is { } raw ? Json(raw) : null;
}
