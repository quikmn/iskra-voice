using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Bot interactions: a person invokes a bot's registered command (options checked against its declared schema), clicks
/// a button or select menu on a bot's message, or submits a form the bot showed; the bot gets an <c>interaction</c> with
/// a short-lived token and answers in public, in private (only the invoker sees it, never stored), defers, updates the
/// message, or shows a form. In encrypted channels every answer is private. See PROTOCOL.md "Bot interactions".
/// </summary>
public static class InteractionFeature
{
    public const int MaxOptionString = 1000;
    public const int MaxArgs = 4000;
    public const int MaxValues = 25;

    public static void Register(Router router)
    {
        router.Add("interaction.invoke", Invoke);
        router.Add("interaction.respond", Respond);
    }

    /// <summary>The <c>interaction</c> part of a message: who asked the bot for it (null for other messages).</summary>
    public static object? MessageView(Store store, long messageId) =>
        store.GetInteractionStamp(messageId) is { } stamp ? new { id = stamp.Id, user = stamp.UserKey, command = stamp.Command } : null;

    // ── Invoking ─────────────────────────────────────────────────────────────

    private static object Invoke(Session s, Member me, Body body)
    {
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't use other bots' commands or buttons.");
        if (body.Has("modalId")) return SubmitModal(s, me, body);
        if (body.Has("responseId")) return ClickAnswer(s, me, body);
        if (body.Has("messageId")) return ClickMessage(s, me, body);
        return Command(s, me, body);
    }

    private static object Command(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (channel, encrypted) = Usable(s, me, body.Long("channelId"));
        var bot = BotFor(s, body.String("bot", 64), channel, encrypted);
        var name = body.String("command", 32);
        var commands = store.GetBotCommands(bot.AccountKey) is { } list ? JsonNode.Parse(list.Commands)!.AsArray() : [];
        var command = commands.Select(c => c!.AsObject()).FirstOrDefault(c => c["name"]!.GetValue<string>() == name)
            ?? throw RequestException.NotFound("Command");
        if (!Allowed(me, command))
            throw RequestException.Forbidden($"You can't use /{name}.", "command_not_allowed", new { name });
        var options = Options(s, me, command, body.OptionalElement("options"));
        string? args = null;
        if (body.OptionalString("args", MaxArgs * 2) is { } raw && raw.Trim().Length > 0)
            args = Text.Normalize(raw, MaxArgs, allowNewlines: false) ?? throw RequestException.BadRequest($"'args' must be one line of at most {MaxArgs} characters.");

        var pending = s.Hub.Interactions.Start(bot.AccountKey, me.AccountKey, channel.Id, "command", name, null, null, encrypted);
        var payload = Payload(pending);
        payload["command"] = name;
        payload["options"] = options;
        if (args is not null) payload["args"] = args;
        return Deliver(s, pending, payload);
    }

    private static object ClickMessage(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var message = store.GetMessage(body.Long("messageId")) ?? throw RequestException.NotFound("Message");
        var (channel, encrypted) = Usable(s, me, message.ChannelId);
        var component = BotComponents.Find(BotComponents.Load(store, message.Id), body.String("customId", BotComponents.MaxCustomId))
            ?? throw RequestException.NotFound("Button");
        var values = BotComponents.Values(component, body.OptionalStringArray("values", MaxValues, BotComponents.MaxOptionText));
        var bot = BotFor(s, message.AuthorKey, channel, encrypted);
        var pending = s.Hub.Interactions.Start(bot.AccountKey, me.AccountKey, channel.Id, "component", null, message.Id, null, encrypted);
        var payload = Payload(pending);
        payload["messageId"] = message.Id;
        payload["customId"] = component["customId"]!.GetValue<string>();
        payload["values"] = new JsonArray(values.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray());
        return Deliver(s, pending, payload);
    }

    private static object ClickAnswer(Session s, Member me, Body body)
    {
        var answer = s.Hub.Interactions.Answer(body.String("responseId", 64), me.AccountKey) ?? throw RequestException.NotFound("Answer");
        var (channel, encrypted) = Usable(s, me, answer.ChannelId);
        var component = BotComponents.Find(answer.Content["components"] as JsonArray, body.String("customId", BotComponents.MaxCustomId))
            ?? throw RequestException.NotFound("Button");
        var values = BotComponents.Values(component, body.OptionalStringArray("values", MaxValues, BotComponents.MaxOptionText));
        var bot = BotFor(s, answer.Bot, channel, encrypted);
        var pending = s.Hub.Interactions.Start(bot.AccountKey, me.AccountKey, channel.Id, "component", null, null, answer.Id, encrypted);
        var payload = Payload(pending);
        payload["responseId"] = answer.Id;
        payload["customId"] = component["customId"]!.GetValue<string>();
        payload["values"] = new JsonArray(values.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray());
        return Deliver(s, pending, payload);
    }

    private static object SubmitModal(Session s, Member me, Body body)
    {
        var registry = s.Hub.Interactions;
        var modalId = body.String("modalId", 64);
        var modal = registry.Modal(modalId, me.AccountKey) ?? throw RequestException.NotFound("Form");
        var (channel, encrypted) = Usable(s, me, modal.ChannelId);
        var fields = Fields(modal.Spec, body.Element("fields"));
        var bot = BotFor(s, modal.Bot, channel, encrypted);
        if (!registry.UseModal(modalId)) throw RequestException.NotFound("Form"); // single use: a second submit loses
        var pending = registry.Start(bot.AccountKey, me.AccountKey, channel.Id, "modal", null, null, null, encrypted);
        var payload = Payload(pending);
        payload["customId"] = modal.Spec["customId"]!.GetValue<string>();
        payload["fields"] = fields;
        return Deliver(s, pending, payload);
    }

    private static JsonObject Payload(Pending p) => new()
    {
        ["id"] = p.Id, ["kind"] = p.Kind, ["channelId"] = p.ChannelId, ["user"] = p.User, ["private"] = p.Private, ["expiresAt"] = p.ExpiresAt,
    };

    private static object Deliver(Session s, Pending pending, JsonObject payload)
    {
        s.Hub.SendToAccount(pending.Bot, Frames.Event("interaction", payload));
        return new { id = pending.Id, expiresAt = pending.ExpiresAt, @private = pending.Private };
    }

    /// <summary>A channel the person can read and post in, and whether it's end-to-end encrypted.</summary>
    private static (Channel Channel, bool Encrypted) Usable(Session s, Member me, long channelId)
    {
        var store = s.World.Store;
        var channel = ChatFeature.ReadableChannel(s, me, channelId);
        if (channel.Kind is not ("text" or "thread" or "voice" or "stage")) throw RequestException.NotFound("Channel");
        if (!Permissions.CanSend(me, channel)) throw RequestException.Forbidden("You can't send messages in this channel.", "cant_send_here");
        var parent = channel.Kind == "thread" && store.GetThread(channel.Id) is { } thread ? store.GetChannel(thread.ParentId) ?? channel : channel;
        return (channel, E2eeChannelFeature.IsEncrypted(store, parent));
    }

    /// <summary>The bot, if it takes interactions, may answer here and is connected.</summary>
    private static Member BotFor(Session s, string botKey, Channel channel, bool encrypted)
    {
        var store = s.World.Store;
        var bot = store.GetMember(botKey);
        if (bot is null || !store.IsBot(botKey) || store.GetBotCommands(botKey) is not { Interactions: true }) throw RequestException.NotFound("Bot");
        if (encrypted ? !Permissions.CanRead(bot, channel) : !Permissions.CanSend(bot, channel))
            throw RequestException.BadRequest($"{bot.Name} can't answer in this channel.", "bot_cant_post", new { name = bot.Name });
        if (!s.Hub.IsOnline(botKey)) throw RequestException.BadRequest($"{bot.Name} is offline right now.", "bot_offline", new { name = bot.Name });
        return bot;
    }

    private static bool Allowed(Member me, JsonObject command)
    {
        if (command["role"]?.GetValue<string>() is { } role && Roles.Rank(me.Role) < Roles.Rank(role)) return false;
        if (command["permission"]?.GetValue<string>() is { } permission && !Permissions.Has(me, RoleFeature.PermNames[permission])) return false;
        return true;
    }

    private static JsonObject Options(Session s, Member me, JsonObject command, JsonElement? given)
    {
        var declared = (command["options"] as JsonArray ?? []).Select(o => o!.AsObject()).ToList();
        var result = new JsonObject();
        if (given is { } g)
        {
            if (g.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'options' must be an object.");
            var count = 0;
            foreach (var property in g.EnumerateObject())
            {
                if (++count > BotCommandFeature.MaxOptions) throw RequestException.BadRequest($"At most {BotCommandFeature.MaxOptions} options.");
                var option = declared.FirstOrDefault(o => o["name"]!.GetValue<string>() == property.Name)
                    ?? throw OptionError(property.Name.Length <= 32 ? property.Name : property.Name[..32]);
                if (property.Value.ValueKind == JsonValueKind.Null) continue;
                result[property.Name] = Value(s, me, option, property.Value);
            }
        }
        foreach (var option in declared)
        {
            var name = option["name"]!.GetValue<string>();
            if (option["required"] is not null && !result.ContainsKey(name)) throw OptionError(name);
        }
        return result;
    }

    private static RequestException OptionError(string name) =>
        RequestException.BadRequest($"The option '{name}' is missing or not valid.", "command_option", new { name });

    private static JsonNode Value(Session s, Member me, JsonObject option, JsonElement value)
    {
        var store = s.World.Store;
        var name = option["name"]!.GetValue<string>();
        JsonNode node;
        switch (option["type"]!.GetValue<string>())
        {
            case "string":
                node = value.ValueKind == JsonValueKind.String && Text.Normalize(value.GetString(), MaxOptionString, allowNewlines: false) is { } text
                    ? JsonValue.Create(text)! : throw OptionError(name);
                break;
            case "integer":
                node = value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var whole) && Math.Abs(whole) <= 9007199254740991
                    ? JsonValue.Create(whole)! : throw OptionError(name);
                break;
            case "number":
                node = value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number)
                    ? JsonValue.Create(number)! : throw OptionError(name);
                break;
            case "boolean":
                node = value.ValueKind is JsonValueKind.True or JsonValueKind.False ? JsonValue.Create(value.GetBoolean())! : throw OptionError(name);
                break;
            case "user":
                node = value.ValueKind == JsonValueKind.String && value.GetString() is { Length: <= 64 } key && store.GetMember(key) is not null
                    ? JsonValue.Create(key)! : throw OptionError(name);
                break;
            case "channel":
                node = value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var channelId)
                    && store.GetChannel(channelId) is { } channel && Permissions.CanRead(me, channel)
                    ? JsonValue.Create(channelId)! : throw OptionError(name);
                break;
            case "role":
                node = value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var roleId) && store.GetRole(roleId) is not null
                    ? JsonValue.Create(roleId)! : throw OptionError(name);
                break;
            default:
                throw OptionError(name);
        }
        if (option["choices"] is JsonArray choices && !choices.Any(c => JsonNode.DeepEquals(c!["value"], node)))
            throw OptionError(name);
        return node;
    }

    private static JsonObject Fields(JsonObject modal, JsonElement given)
    {
        if (given.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'fields' must be an object.");
        var specs = modal["fields"]!.AsArray().Select(f => f!.AsObject()).ToList();
        var result = new JsonObject();
        foreach (var property in given.EnumerateObject())
        {
            var spec = specs.FirstOrDefault(f => f["customId"]!.GetValue<string>() == property.Name)
                ?? throw RequestException.BadRequest("That form has no such field.");
            if (property.Value.ValueKind != JsonValueKind.String) throw RequestException.BadRequest("Form fields are text.");
            var raw = property.Value.GetString()!;
            if (raw.Trim().Length == 0) continue;
            var paragraph = spec["style"]!.GetValue<string>() == "paragraph";
            var label = spec["label"]!.GetValue<string>();
            result[property.Name] = Text.Normalize(raw, spec["maxLength"]!.GetValue<int>(), allowNewlines: paragraph)
                ?? throw RequestException.BadRequest($"{label}: too long, or not valid text.", "form_field", new { label });
        }
        foreach (var spec in specs)
        {
            var id = spec["customId"]!.GetValue<string>();
            if (!result.ContainsKey(id))
            {
                var label = spec["label"]!.GetValue<string>();
                if (spec["required"]!.GetValue<bool>())
                    throw RequestException.BadRequest($"{label}: please fill this in.", "form_required", new { label });
                result[id] = "";
            }
        }
        return result;
    }

    // ── Answering ────────────────────────────────────────────────────────────

    private static object? Respond(Session s, Member me, Body body)
    {
        var registry = s.Hub.Interactions;
        var pending = registry.Get(body.String("id", 64), me.AccountKey) ?? throw RequestException.NotFound("Interaction");
        var type = body.OptionalString("type", 16) ?? "reply";
        if (type is not ("reply" or "defer" or "update" or "modal")) throw RequestException.BadRequest("'type' must be reply, defer, update or modal.");
        pending.Reserve(type);
        try
        {
            object? result;
            switch (type)
            {
                case "defer":
                    s.Hub.SendToAccount(pending.User, Frames.Event("interaction.state", new { id = pending.Id, bot = pending.Bot, state = "deferred" }));
                    return null;
                case "modal":
                    var spec = BotComponents.Modal(body.Element("modal"));
                    var modal = registry.OpenModal(pending, spec);
                    s.Hub.SendToAccount(pending.User, Frames.Event("interaction.modal",
                        new { modalId = modal.Id, interaction = pending.Id, bot = pending.Bot, channelId = pending.ChannelId, modal = spec }));
                    result = null;
                    break;
                case "update":
                    result = pending.ResponseId is { } responseId ? UpdateAnswer(s, me, body, pending, responseId) : UpdateMessage(s, me, body, pending);
                    break;
                default:
                    result = (body.OptionalBool("private") ?? false) || pending.Private ? PrivateReply(s, me, body, pending) : PublicReply(s, me, body, pending);
                    break;
            }
            s.Hub.SendToAccount(pending.User, Frames.Event("interaction.state", new { id = pending.Id, bot = pending.Bot, state = "done" }));
            return result;
        }
        catch
        {
            pending.Release(type);
            throw;
        }
    }

    private static object PublicReply(Session s, Member me, Body body, Pending pending)
    {
        if ((ModerationFeature.Gate(s, me, "chat.send") ?? RulesFeature.Gate(s, me, "chat.send")) is { } refused) throw refused;
        var message = new JsonObject { ["channelId"] = pending.ChannelId };
        foreach (var field in (string[])["text", "cards", "components"])
            if (body.OptionalElement(field) is { } value) message[field] = JsonNode.Parse(value.GetRawText());
        var stamp = new InteractionStamp(pending.Id, pending.User, pending.Command);
        return ChatFeature.Send(s, me, new Body(JsonSerializer.SerializeToElement(message)), saved: m => s.World.Store.SetInteractionStamp(m.Id, stamp));
    }

    private static object? UpdateMessage(Session s, Member me, Body body, Pending pending)
    {
        var edit = new JsonObject { ["id"] = pending.MessageId };
        foreach (var field in (string[])["text", "cards", "components"])
            edit[field] = body.OptionalElement(field) is { } value ? JsonNode.Parse(value.GetRawText()) : field == "text" ? "" : new JsonArray();
        return s.Router.Invoke(s, me, "chat.edit", JsonSerializer.SerializeToElement(edit));
    }

    /// <summary>Text, cards and components of a private answer, validated like a message (never stored).</summary>
    private static JsonObject PrivateContent(Session s, Member me, Body body)
    {
        var cards = BotCommandFeature.Parse(s, me, body);
        var components = BotComponents.Parse(s, me, body);
        var raw = body.OptionalString("text", ChatFeature.MaxMessageLength * 2) ?? "";
        string text = "";
        if (raw.Trim().Length > 0)
            text = Text.Normalize(raw, ChatFeature.MaxMessageLength, allowNewlines: true)
                ?? throw RequestException.BadRequest($"Messages must be 1–{ChatFeature.MaxMessageLength} characters.", "message_length", new { max = ChatFeature.MaxMessageLength });
        else if (cards is not { Json: not "[]" } && components is not { Count: > 0 })
            throw RequestException.BadRequest("An answer needs text, cards or components.");
        return new JsonObject
        {
            ["text"] = text,
            ["cards"] = cards is { } c ? JsonNode.Parse(c.Json) : new JsonArray(),
            ["components"] = components ?? [],
        };
    }

    private static object PrivateReply(Session s, Member me, Body body, Pending pending)
    {
        var answer = s.Hub.Interactions.AddAnswer(pending, PrivateContent(s, me, body), s.Now);
        s.Hub.SendToAccount(pending.User, AnswerFrame(answer, updated: false));
        return new { responseId = answer.Id };
    }

    private static object UpdateAnswer(Session s, Member me, Body body, Pending pending, string responseId)
    {
        var answer = s.Hub.Interactions.Answer(responseId, pending.User) ?? throw RequestException.NotFound("Answer");
        answer.Content = PrivateContent(s, me, body);
        s.Hub.SendToAccount(pending.User, AnswerFrame(answer, updated: true));
        return new { responseId = answer.Id };
    }

    /// <summary>
    /// A private answer from a built-in (server-run) bot to the person who used its command: hints and errors that shouldn't
    /// land in the channel. <paramref name="builtin"/> lets apps show it in their own language.
    /// </summary>
    public static void PrivateNote(Session s, string bot, string user, long channelId, string text, JsonObject builtin)
    {
        var registry = s.Hub.Interactions;
        var pending = registry.Start(bot, user, channelId, "command", null, null, null, isPrivate: true, capped: false);
        var content = new JsonObject { ["text"] = text, ["cards"] = new JsonArray(), ["components"] = new JsonArray(), ["builtin"] = builtin };
        s.Hub.SendToAccount(user, AnswerFrame(registry.AddAnswer(pending, content, s.Now), updated: false));
    }

    private static string AnswerFrame(PrivateAnswer a, bool updated)
    {
        var body = new JsonObject
        {
            ["responseId"] = a.Id, ["interaction"] = a.InteractionId, ["bot"] = a.Bot, ["channelId"] = a.ChannelId, ["createdAt"] = a.CreatedAt,
        };
        foreach (var (key, value) in a.Content) body[key] = value?.DeepClone();
        if (updated) body["updated"] = true;
        return Frames.Event("interaction.response", body);
    }
}

/// <summary>One interaction waiting for its bot: the token, who asked, where, and how it may still be answered.</summary>
public sealed class Pending(string id, string bot, string user, long channelId, string kind, string? command, long? messageId, string? responseId,
    bool isPrivate, long expiresAt)
{
    public const int MaxAnswers = 5;
    public string Id { get; } = id;
    public string Bot { get; } = bot;
    public string User { get; } = user;
    public long ChannelId { get; } = channelId;
    public string Kind { get; } = kind;
    public string? Command { get; } = command;
    public long? MessageId { get; } = messageId;
    public string? ResponseId { get; } = responseId;
    public bool Private { get; } = isPrivate;
    public long ExpiresAt { get; } = expiresAt;

    private readonly Lock _gate = new();
    private int _answers;
    private bool _deferred;

    /// <summary>Takes an answer slot for this kind of answer, or refuses it.</summary>
    public void Reserve(string type)
    {
        lock (_gate)
        {
            switch (type)
            {
                case "defer":
                    if (_answers > 0 || _deferred) throw RequestException.BadRequest("Defer only as the first answer.");
                    _deferred = true;
                    return;
                case "modal":
                    if (_answers > 0 || Kind == "modal") throw RequestException.BadRequest("A form can only be the first answer, and not to a form.");
                    break;
                case "update":
                    if (Kind != "component") throw RequestException.BadRequest("Only answers to buttons and menus can update.");
                    break;
            }
            if (_answers >= MaxAnswers) throw RequestException.BadRequest($"An interaction takes at most {MaxAnswers} answers.");
            _answers++;
        }
    }

    public void Release(string type)
    {
        lock (_gate)
        {
            if (type == "defer") _deferred = false;
            else _answers--;
        }
    }
}

/// <summary>A private answer, kept only in memory (for clicks on its components) until it expires.</summary>
public sealed class PrivateAnswer(string id, string interactionId, string bot, string user, long channelId, JsonObject content, long createdAt, long expiresAt)
{
    public string Id { get; } = id;
    public string InteractionId { get; } = interactionId;
    public string Bot { get; } = bot;
    public string User { get; } = user;
    public long ChannelId { get; } = channelId;
    public long CreatedAt { get; } = createdAt;
    public long ExpiresAt { get; } = expiresAt;
    public JsonObject Content { get; set; } = content;
}

public sealed record OpenModal(string Id, string Bot, string User, long ChannelId, JsonObject Spec, long ExpiresAt);

/// <summary>Interaction tokens, private answers and open forms: in memory, 15 minutes each, gone with a restart.</summary>
public sealed class InteractionRegistry(TimeProvider time)
{
    public const long LifetimeMs = 15 * 60_000;
    public const int MaxLive = 10_000;
    public const int MaxAnswersPerUser = 50;
    /// <summary>Open interactions per person, so one member can't use up <see cref="MaxLive"/> for everyone.</summary>
    public const int MaxPendingPerUser = 100;

    private readonly ConcurrentDictionary<string, Pending> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PrivateAnswer> _answers = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, OpenModal> _modals = new(StringComparer.Ordinal);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    private static string NewId() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));

    /// <param name="capped">False for a built-in bot's own note (the person's command was limited already).</param>
    public Pending Start(string bot, string user, long channelId, string kind, string? command, long? messageId, string? responseId, bool isPrivate,
        bool capped = true)
    {
        Prune(_pending, p => p.ExpiresAt);
        if (_pending.Count >= MaxLive) throw new RequestException("rate_limited", "Too many interactions right now; try again in a moment.");
        var now = Now;
        if (capped && _pending.Values.Count(p => p.User == user && p.ExpiresAt > now) >= MaxPendingPerUser)
            throw new RequestException("rate_limited", "You've used a lot of bot commands just now; try again in a few minutes.");
        var pending = new Pending(NewId(), bot, user, channelId, kind, command, messageId, responseId, isPrivate, Now + LifetimeMs);
        _pending[pending.Id] = pending;
        return pending;
    }

    /// <summary>An unexpired interaction for this bot (another bot's token is unknown to it).</summary>
    public Pending? Get(string id, string bot) =>
        _pending.TryGetValue(id, out var p) && p.Bot == bot && p.ExpiresAt > Now ? p : null;

    public PrivateAnswer AddAnswer(Pending pending, JsonObject content, long now)
    {
        Prune(_answers, a => a.ExpiresAt);
        var mine = _answers.Values.Where(a => a.User == pending.User).OrderBy(a => a.CreatedAt).ToList();
        foreach (var old in mine.Take(Math.Max(0, mine.Count - MaxAnswersPerUser + 1))) _answers.TryRemove(old.Id, out _);
        if (_answers.Count >= MaxLive) throw new RequestException("rate_limited", "Too many answers right now; try again in a moment.");
        var answer = new PrivateAnswer(NewId(), pending.Id, pending.Bot, pending.User, pending.ChannelId, content, now, now + LifetimeMs);
        _answers[answer.Id] = answer;
        return answer;
    }

    /// <summary>A private answer that belongs to this person and hasn't expired.</summary>
    public PrivateAnswer? Answer(string id, string user) =>
        _answers.TryGetValue(id, out var a) && a.User == user && a.ExpiresAt > Now ? a : null;

    public OpenModal OpenModal(Pending pending, JsonObject spec)
    {
        Prune(_modals, m => m.ExpiresAt);
        if (_modals.Count >= MaxLive) throw new RequestException("rate_limited", "Too many open forms right now; try again in a moment.");
        var modal = new OpenModal(NewId(), pending.Bot, pending.User, pending.ChannelId, spec, Now + LifetimeMs);
        _modals[modal.Id] = modal;
        return modal;
    }

    public OpenModal? Modal(string id, string user) =>
        _modals.TryGetValue(id, out var m) && m.User == user && m.ExpiresAt > Now ? m : null;

    /// <summary>Uses up a form; false if it was already submitted.</summary>
    public bool UseModal(string id) => _modals.TryRemove(id, out _);

    private void Prune<T>(ConcurrentDictionary<string, T> map, Func<T, long> expiresAt)
    {
        if (map.Count < MaxLive / 2) return;
        var now = Now;
        foreach (var (key, value) in map)
            if (expiresAt(value) <= now) map.TryRemove(key, out _);
    }
}
