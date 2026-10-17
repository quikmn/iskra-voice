using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public sealed record StarboardConfig
{
    public long? ChannelId { get; init; }
    public string Emoji { get; init; } = "⭐";
    public int Threshold { get; init; } = 3;
}

public sealed record BirthdayConfig
{
    public long? ChannelId { get; init; }
    public string Time { get; init; } = "09:00";
    public string? TimeZone { get; init; }
}

public sealed record WelcomeConfig
{
    public long? ChannelId { get; init; }
    public string Message { get; init; } = "";
    public string PrivateMessage { get; init; } = "";
}

/// <summary>
/// Settings and shared bits of the built-in bots that act on what happens rather than on a command: Starboard
/// (StarboardBot.cs), Birthdays (BirthdayBot.cs) and Welcome (BuiltinBotRuntime). Each posts in the channel an admin
/// picks, as long as it can see that channel (its role and the channel's overrides decide), never in an encrypted one.
/// </summary>
public static partial class MoreBuiltinBots
{
    public const int MaxTemplate = 1000;
    public const int MinThreshold = 1, MaxThreshold = 50;
    public static readonly string[] Configurable = ["starboard", "birthdays", "welcome"];

    public static void Register(Router router)
    {
        router.Add("builtin.bots.config.get", GetConfig);
        router.Add("builtin.bots.config.set", SetConfig);
        BirthdayBot.Register(router);
    }

    /// <summary>The bot's member while it's on, else null.</summary>
    public static Member? BotIfOn(Store store, string id) =>
        store.BuiltinBots().FirstOrDefault(r => r.Id == id) is { } row ? store.GetMember(row.AccountKey) : null;

    public static BuiltinBotFeature.Kind KindOf(string id) => BuiltinBotFeature.Bots.First(b => b.Id == id);

    // ── Settings ─────────────────────────────────────────────────────────────

    public static T Config<T>(Store store, string id) where T : new()
    {
        if (store.BuiltinBotConfig(id) is not { } raw) return new T();
        try
        {
            return JsonSerializer.Deserialize<T>(raw, Json.Options) ?? new T();
        }
        catch (JsonException)
        {
            return new T();
        }
    }

    private static void Save<T>(Store store, string id, T config, long now) =>
        store.SetBuiltinBotConfig(id, JsonSerializer.Serialize(config, Json.Options), now);

    private static string Configurable_(Body body)
    {
        var id = body.String("bot", 32);
        if (!Configurable.Contains(id) && !BuiltinBots3.Ids.Contains(id)) throw RequestException.BadRequest("That built-in bot has no settings.", "builtin_bot_no_settings");
        return id;
    }

    private static void RequireAdmin(Member me)
    {
        if (!BaseRoles.Allows(me, BaseAbility.Bots)) throw RequestException.Forbidden("Only admins can change built-in bots' settings.", "builtin_bots_config_admin");
    }

    private static object GetConfig(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var id = Configurable_(body);
        return new { bot = id, config = View(s, id) };
    }

    internal static object View(Session s, string id) => BuiltinBots3.Ids.Contains(id) ? BuiltinBots3.View(s.World.Store, id) : id switch
    {
        "starboard" => Config<StarboardConfig>(s.World.Store, id),
        "birthdays" => BirthdayView(Config<BirthdayConfig>(s.World.Store, id), s.Time),
        _ => Config<WelcomeConfig>(s.World.Store, id),
    };

    private static object BirthdayView(BirthdayConfig c, TimeProvider time) =>
        new { channelId = c.ChannelId, time = c.Time, timeZone = c.TimeZone, serverTimeZone = time.LocalTimeZone.Id };

    [GeneratedRegex(@"^([01]\d|2[0-3]):([0-5]\d)$", RegexOptions.CultureInvariant)]
    private static partial Regex TimePattern();

    private static object SetConfig(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var id = Configurable_(body);
        if (BuiltinBots3.Ids.Contains(id)) return BuiltinBots3.SetConfig(s, me, body, id);
        var store = s.World.Store;
        var changed = new List<string>();
        long? Channel(long? current)
        {
            if (!body.Has("channelId")) return current;
            changed.Add("channelId");
            if (body.IsNull("channelId")) return null;
            var channel = store.GetChannel(body.Long("channelId"));
            if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
            if (channel.Kind != "text" || E2eeChannelFeature.IsEncrypted(store, channel))
                throw RequestException.BadRequest("Pick a text channel that isn't encrypted.", "builtin_bot_channel");
            return channel.Id;
        }
        string Template(string name, string current)
        {
            if (!body.Has(name)) return current;
            changed.Add(name);
            var raw = body.OptionalString(name, MaxTemplate * 2) ?? "";
            if (raw.Trim().Length == 0) return "";
            return Text.Normalize(raw, MaxTemplate, allowNewlines: true)
                ?? throw RequestException.BadRequest($"Keep it to {MaxTemplate} characters.", "builtin_bot_template", new { max = MaxTemplate });
        }

        switch (id)
        {
            case "starboard":
            {
                var c = Config<StarboardConfig>(store, id);
                var emoji = c.Emoji;
                if (body.OptionalString("emoji", 64) is { } raw)
                {
                    emoji = EmojiFeature.Reaction(store, raw) ?? throw RequestException.BadRequest("That isn't a valid reaction.", "builtin_bot_emoji");
                    changed.Add("emoji");
                }
                var threshold = c.Threshold;
                if (body.OptionalLong("threshold", MinThreshold, MaxThreshold) is { } n)
                {
                    threshold = (int)n;
                    changed.Add("threshold");
                }
                Save(store, id, c with { ChannelId = Channel(c.ChannelId), Emoji = emoji, Threshold = threshold }, s.Now);
                break;
            }
            case "birthdays":
            {
                var c = Config<BirthdayConfig>(store, id);
                var time = c.Time;
                if (body.OptionalString("time", 5) is { } t)
                {
                    if (!TimePattern().IsMatch(t)) throw RequestException.BadRequest("Pick a time like 09:00.", "builtin_bot_time");
                    time = t;
                    changed.Add("time");
                }
                var zone = c.TimeZone;
                if (body.Has("timeZone"))
                {
                    zone = body.IsNull("timeZone") ? null : EventFeature.TimeZone(body.String("timeZone", 64));
                    changed.Add("timeZone");
                }
                Save(store, id, c with { ChannelId = Channel(c.ChannelId), Time = time, TimeZone = zone }, s.Now);
                break;
            }
            default:
            {
                var c = Config<WelcomeConfig>(store, id);
                var channelId = Channel(c.ChannelId);
                Save(store, id, c with { ChannelId = channelId, Message = Template("message", c.Message), PrivateMessage = Template("privateMessage", c.PrivateMessage) }, s.Now);
                break;
            }
        }
        if (changed.Count > 0)
            Audit.Record(s, "builtin.bot.config", store.BuiltinBots().FirstOrDefault(r => r.Id == id)?.AccountKey, details: new { bot = id, changed });
        return new { bot = id, config = View(s, id) };
    }

    /// <summary>
    /// Turning one on: Starboard gets its channel (#starboard, made if missing: everyone reads, only admins write);
    /// Birthdays and Welcome start in the first channel everyone can read. Admins can pick another channel later.
    /// </summary>
    internal static void TurnedOn(Session s, string id)
    {
        BuiltinBots3.TurnedOn(s, id);
        if (!Configurable.Contains(id)) return;
        var store = s.World.Store;
        Channel? Usable(long? channelId) =>
            channelId is { } cid && store.GetChannel(cid) is { Kind: "text" } c && !E2eeChannelFeature.IsEncrypted(store, c) ? c : null;
        Channel? FirstOpen() => store.AllChannels()
            .Where(c => c.Kind == "text" && Roles.Rank(c.ReadRole) <= Roles.Rank(Roles.Member) && !E2eeChannelFeature.IsEncrypted(store, c))
            .OrderBy(c => c.Position).ThenBy(c => c.Id).FirstOrDefault();
        switch (id)
        {
            case "starboard":
            {
                var c = Config<StarboardConfig>(store, id);
                if (Usable(c.ChannelId) is not null) return;
                var board = store.AllChannels().FirstOrDefault(ch => ch.Kind == "text" && ch.Name == "starboard" && !E2eeChannelFeature.IsEncrypted(store, ch));
                if (board is null)
                {
                    board = store.CreateChannel("starboard", "text", Roles.Member, Roles.Admin, s.Now);
                    Audit.Record(s, "channel.create", details: new { channelId = board.Id, name = board.Name, kind = "text", readRole = board.ReadRole, writeRole = board.WriteRole, bot = id });
                    ChannelFeature.BroadcastChannels(s);
                }
                Save(store, id, c with { ChannelId = board.Id }, s.Now);
                break;
            }
            case "birthdays":
            {
                var c = Config<BirthdayConfig>(store, id);
                if (Usable(c.ChannelId) is null) Save(store, id, c with { ChannelId = FirstOpen()?.Id }, s.Now);
                break;
            }
            default:
            {
                var c = Config<WelcomeConfig>(store, id);
                if (Usable(c.ChannelId) is null) Save(store, id, c with { ChannelId = FirstOpen()?.Id }, s.Now);
                break;
            }
        }
    }

    /// <summary>The channel the bot posts in: a text channel it can see, not encrypted; else null (it stays quiet).</summary>
    public static Channel? PostChannel(Store store, Member bot, long? channelId, long now) =>
        channelId is { } id && store.GetChannel(id) is { Kind: "text" } channel && Permissions.CanRead(bot, channel)
        && !E2eeChannelFeature.IsEncrypted(store, channel) && store.TimedOutUntil(bot.AccountKey, now) is null
            ? channel : null;

    // ── Posting outside a request ────────────────────────────────────────────

    /// <summary>A message from the bot (with what it means attached) that everyone who can read the channel sees.</summary>
    public static Message Post(Store store, Hub hub, PushService? push, Member bot, Channel channel, string text, JsonObject reply, long now)
    {
        var message = store.AddBuiltinMessage(channel.Id, bot.AccountKey,
            Text.Normalize(text, ChatFeature.MaxMessageLength, allowNewlines: true) ?? "…", reply.ToJsonString(), now);
        hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = MessageViews.Public(store, message) }));
        push?.ChatMessage(channel, message, pings: false);
        return message;
    }

    /// <summary>The bot's card changed (a new star count, an edited original): everyone reading sees the new one.</summary>
    public static void Rewrite(Store store, Hub hub, Channel channel, long messageId, string text, JsonObject reply)
    {
        store.UpdateBuiltinMessage(messageId, Text.Normalize(text, ChatFeature.MaxMessageLength, allowNewlines: true) ?? "…", reply.ToJsonString());
        if (store.GetMessage(messageId) is { } message)
            hub.BroadcastToReaders(channel, Frames.Event("chat.edited", new { message = MessageViews.Public(store, message) }));
    }

    internal static JsonObject Reply(string bot, string kind, string forKey, object? extra = null)
    {
        var reply = new JsonObject { ["bot"] = bot, ["kind"] = kind, ["for"] = forKey };
        if (extra is not null && JsonSerializer.SerializeToNode(extra, Json.Options) is JsonObject more)
            foreach (var (name, value) in more.ToList())
            {
                more.Remove(name);
                reply[name] = value;
            }
        return reply;
    }

    /// <summary>Fills {name}, {server} and {memberCount} in an admin's welcome text.</summary>
    public static string Fill(string template, string name, string server, int memberCount) =>
        template.Replace("{name}", name, StringComparison.Ordinal).Replace("{server}", server, StringComparison.Ordinal)
            .Replace("{memberCount}", memberCount.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
}
