using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public sealed record TagsConfig
{
    public long? ManagerRoleId { get; init; }
}

public sealed record SuggestionsConfig
{
    public long? ChannelId { get; init; }
    public long? StaffRoleId { get; init; }
    public bool Anonymous { get; init; }
}

public sealed record GiveawaysConfig
{
    public long? StaffRoleId { get; init; }
}

public sealed record CountingConfig
{
    public long? ChannelId { get; init; }
    public bool Math { get; init; }
}

/// <summary>
/// Settings and shared bits of Tags (TagsBot.cs), Suggestions (SuggestionsBot.cs), Giveaways (GiveawayBot.cs) and
/// Counting (CountingBot.cs). Their settings go through <c>builtin.bots.config.get/set</c> like Starboard's; a role
/// that may manage them (staff) can't be one members give themselves.
/// </summary>
public static class BuiltinBots3
{
    public static readonly string[] Ids = [TagsBot.Id, SuggestionsBot.Id, GiveawayBot.Id, CountingBot.Id];

    public static void Register(Router router)
    {
        router.Add("builtin.cards.mine", Mine);
        TagsBot.Register(router);
        SuggestionsBot.Register(router);
        GiveawayBot.Register(router);
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    internal static object View(Store store, string id) => id switch
    {
        TagsBot.Id => MoreBuiltinBots.Config<TagsConfig>(store, id),
        SuggestionsBot.Id => MoreBuiltinBots.Config<SuggestionsConfig>(store, id),
        GiveawayBot.Id => MoreBuiltinBots.Config<GiveawaysConfig>(store, id),
        _ => CountingView(store),
    };

    private static object CountingView(Store store)
    {
        var c = MoreBuiltinBots.Config<CountingConfig>(store, CountingBot.Id);
        var state = c.ChannelId is { } channelId ? store.GetCounting(channelId) : null;
        return new { channelId = c.ChannelId, math = c.Math, current = state?.Current ?? 0, best = state?.Best ?? 0, bestAt = state?.BestAt };
    }

    private static void Save<T>(Store store, string id, T config, long now) =>
        store.SetBuiltinBotConfig(id, System.Text.Json.JsonSerializer.Serialize(config, Json.Options), now);

    /// <summary>A channel field: a text channel the admin can read, not encrypted; null turns it off.</summary>
    private static long? ChannelField(Session s, Member me, Body body, long? current, List<string> changed)
    {
        if (!body.Has("channelId") && !body.IsNull("channelId")) return current;
        changed.Add("channelId");
        if (body.IsNull("channelId")) return null;
        var store = s.World.Store;
        var channel = store.GetChannel(body.Long("channelId"));
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
        if (channel.Kind != "text" || E2eeChannelFeature.IsEncrypted(store, channel))
            throw RequestException.BadRequest("Pick a text channel that isn't encrypted.", "builtin_bot_channel");
        return channel.Id;
    }

    /// <summary>A staff or manager role: an existing role that members can't give themselves; null means admins only.</summary>
    private static long? RoleField(Session s, Body body, string name, long? current, List<string> changed)
    {
        if (!body.Has(name) && !body.IsNull(name)) return current;
        changed.Add(name);
        if (body.IsNull(name)) return null;
        var role = s.World.Store.GetRole(body.Long(name)) ?? throw RequestException.NotFound("Role");
        if (role.SelfAssign) throw RequestException.BadRequest("Pick a role members can't give themselves.", "builtin_bot_role");
        return role.Id;
    }

    private static bool Flag(Body body, string name, bool current, List<string> changed)
    {
        if (body.OptionalBool(name) is not { } value) return current;
        changed.Add(name);
        return value;
    }

    /// <summary>The settings of one of these bots (the caller checked the admin and the bot).</summary>
    internal static object SetConfig(Session s, Member me, Body body, string id)
    {
        var store = s.World.Store;
        var changed = new List<string>();
        switch (id)
        {
            case TagsBot.Id:
            {
                var c = MoreBuiltinBots.Config<TagsConfig>(store, id);
                Save(store, id, c with { ManagerRoleId = RoleField(s, body, "managerRoleId", c.ManagerRoleId, changed) }, s.Now);
                break;
            }
            case SuggestionsBot.Id:
            {
                var c = MoreBuiltinBots.Config<SuggestionsConfig>(store, id);
                Save(store, id, c with
                {
                    ChannelId = ChannelField(s, me, body, c.ChannelId, changed),
                    StaffRoleId = RoleField(s, body, "staffRoleId", c.StaffRoleId, changed),
                    Anonymous = Flag(body, "anonymous", c.Anonymous, changed),
                }, s.Now);
                break;
            }
            case GiveawayBot.Id:
            {
                var c = MoreBuiltinBots.Config<GiveawaysConfig>(store, id);
                Save(store, id, c with { StaffRoleId = RoleField(s, body, "staffRoleId", c.StaffRoleId, changed) }, s.Now);
                break;
            }
            default:
            {
                var c = MoreBuiltinBots.Config<CountingConfig>(store, id);
                var next = c with { ChannelId = ChannelField(s, me, body, c.ChannelId, changed), Math = Flag(body, "math", c.Math, changed) };
                Save(store, id, next, s.Now);
                if (next.ChannelId != c.ChannelId) CountingBot.ChannelChosen(store, s.Hub, next.ChannelId, s.Now);
                break;
            }
        }
        if (changed.Count > 0)
            Audit.Record(s, "builtin.bot.config", store.BuiltinBots().FirstOrDefault(r => r.Id == id)?.AccountKey, details: new { bot = id, changed });
        return new { bot = id, config = View(store, id) };
    }

    /// <summary>
    /// Turning one on: Suggestions gets #suggestions (made if missing: members read, admins write), Counting gets #counting
    /// (made if missing: members read and write) and its card there.
    /// </summary>
    internal static void TurnedOn(Session s, string id)
    {
        var store = s.World.Store;
        Channel? Usable(long? channelId) =>
            channelId is { } cid && store.GetChannel(cid) is { Kind: "text" } c && !E2eeChannelFeature.IsEncrypted(store, c) ? c : null;
        Channel Named(string name, string writeRole)
        {
            var found = store.AllChannels().FirstOrDefault(ch => ch.Kind == "text" && ch.Name == name && !E2eeChannelFeature.IsEncrypted(store, ch));
            if (found is not null) return found;
            var made = store.CreateChannel(name, "text", Roles.Member, writeRole, s.Now);
            Audit.Record(s, "channel.create", details: new { channelId = made.Id, name = made.Name, kind = "text", readRole = made.ReadRole, writeRole = made.WriteRole, bot = id });
            ChannelFeature.BroadcastChannels(s);
            return made;
        }
        switch (id)
        {
            case SuggestionsBot.Id:
            {
                var c = MoreBuiltinBots.Config<SuggestionsConfig>(store, id);
                if (Usable(c.ChannelId) is null) Save(store, id, c with { ChannelId = Named("suggestions", Roles.Admin).Id }, s.Now);
                break;
            }
            case CountingBot.Id:
            {
                var c = MoreBuiltinBots.Config<CountingConfig>(store, id);
                if (Usable(c.ChannelId) is null)
                {
                    c = c with { ChannelId = Named("counting", Roles.Member).Id };
                    Save(store, id, c, s.Now);
                }
                CountingBot.ChannelChosen(store, s.Hub, c.ChannelId, s.Now);
                break;
            }
        }
    }

    // ── Shared ───────────────────────────────────────────────────────────────

    /// <summary>Admins, or members with the bot's staff role (one that members can't give themselves).</summary>
    public static bool IsStaff(Store store, Member member, long? roleId) =>
        BaseRoles.Allows(member, BaseAbility.Bots)
        || (roleId is { } id && member.RoleIds.Contains(id) && store.GetRole(id) is { SelfAssign: false });

    /// <summary>The bot's card that a request is about: the message exists, the person can read its channel and the bot wrote it.</summary>
    internal static (Message Message, Channel Channel) Card(Session s, Member me, Body body, string bot)
    {
        var store = s.World.Store;
        var message = store.GetMessage(body.Long("messageId")) ?? throw RequestException.NotFound("Message");
        var channel = ChatFeature.ReadableChannel(s, me, message.ChannelId);
        if (store.BuiltinIdOf(message.AuthorKey) != bot) throw RequestException.NotFound("Message");
        return (message, channel);
    }

    /// <summary>
    /// Like <see cref="MoreBuiltinBots.Post"/>, with <paramref name="saved"/> run before anyone hears of the message (so a
    /// card's row exists by the time someone can click on it).
    /// </summary>
    internal static Message PostCard(Store store, Hub hub, PushService? push, Member bot, Channel channel, string text, JsonObject reply, long now,
        Action<Message> saved)
    {
        var message = store.AddBuiltinMessage(channel.Id, bot.AccountKey,
            Sessions.Text.Normalize(text, ChatFeature.MaxMessageLength, allowNewlines: true) ?? "…", reply.ToJsonString(), now);
        saved(message);
        hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = MessageViews.Public(store, message) }));
        push?.ChatMessage(channel, message, pings: false);
        return message;
    }

    /// <summary>A bot message that may ping (giveaway winners): pushes and mentions like a person's message.</summary>
    internal static Message PostPinging(Store store, Hub hub, PushService? push, Member bot, Channel channel, string text, JsonObject reply, long now)
    {
        var message = MoreBuiltinBots.Post(store, hub, null, bot, channel, text, reply, now);
        push?.ChatMessage(channel, message, pings: true);
        return message;
    }

    // ── Your own state on cards ──────────────────────────────────────────────

    public const int MaxMine = 100;

    /// <summary>Your votes on suggestion cards and the giveaways you entered, for the cards an app shows.</summary>
    private static object Mine(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        if (body.OptionalElement("messageIds") is not { ValueKind: System.Text.Json.JsonValueKind.Array } list || list.GetArrayLength() > MaxMine)
            throw RequestException.BadRequest($"'messageIds' must be a list of at most {MaxMine} ids.");
        var ids = new HashSet<long>();
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind != System.Text.Json.JsonValueKind.Number || !item.TryGetInt64(out var id)) throw RequestException.BadRequest("'messageIds' must be ids.");
            if (store.GetMessage(id) is { } m && store.GetChannel(m.ChannelId) is { } channel && Permissions.CanRead(me, channel)) ids.Add(id);
        }
        var votes = store.MySuggestionVotes(me.AccountKey, ids);
        return new
        {
            votes = votes.ToDictionary(v => v.Key.ToString(System.Globalization.CultureInfo.InvariantCulture), v => v.Value),
            entered = store.MyGiveawayEntries(me.AccountKey, ids).Order().ToList(),
        };
    }
}
