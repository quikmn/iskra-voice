using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The Feeds bot's settings (see <see cref="FeedService"/>): what it follows and where it posts, for admins; the Twitch
/// app credentials, for the owner (the secret is never sent back).
/// </summary>
public static partial class FeedsFeature
{
    public static readonly string[] Kinds = ["rss", "youtube", "twitch"];

    public static void Register(Router router)
    {
        router.Add("feeds.get", Get);
        router.AddAsync("feeds.add", Add);
        router.Add("feeds.update", Update);
        router.Add("feeds.remove", Remove);
        router.AddAsync("feeds.check", Check);
        router.AddAsync("feeds.twitch.set", SetTwitch);
    }

    private static FeedService Service(Session s) => s.Hub.Feeds ?? throw new RequestException("unavailable", "Feeds aren't available on this server.");

    private static void RequireAdmin(Member me)
    {
        if (!BaseRoles.Allows(me, BaseAbility.Bots)) throw RequestException.Forbidden("Only admins can manage feeds.", "feeds_admin");
    }

    private static void RequireOn(Store store)
    {
        if (MoreBuiltinBots.BotIfOn(store, FeedService.Id) is null) throw RequestException.BadRequest("Turn on the Feeds bot first.", "feeds_off");
    }

    // ── Views ────────────────────────────────────────────────────────────────

    public static object View(Store store, FeedSubscription f) => new
    {
        id = f.Id,
        kind = f.Kind,
        source = f.Source,
        name = f.Name,
        url = f.Url,
        channelId = f.ChannelId,
        mention = f.Mention,
        mentionRoleId = f.MentionRoleId,
        template = f.Template,
        intervalMinutes = f.IntervalMinutes,
        paused = f.Paused,
        createdBy = f.CreatedBy,
        createdAt = f.CreatedAt,
        lastCheckAt = f.LastCheckAt,
        lastOkAt = f.LastOkAt,
        lastPostAt = f.LastPostAt,
        nextCheckAt = f.NextAt,
        failures = f.Failures,
        lastError = f.LastError,
        canPing = FeedService.CanPing(store, f),
    };

    private static object TwitchView(Store store) => new
    {
        configured = store.GetFeedSetting(FeedService.TwitchClientId) is { Length: > 0 } && store.GetFeedSetting(FeedService.TwitchSecret) is { Length: > 0 },
        clientId = store.GetFeedSetting(FeedService.TwitchClientId),
    };

    private static object Get(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        return new
        {
            subscriptions = store.FeedSubscriptions().Select(f => View(store, f)),
            twitch = TwitchView(store),
            max = FeedService.MaxSubscriptions,
        };
    }

    // ── Fields ───────────────────────────────────────────────────────────────

    private static long Channel(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var channel = store.GetChannel(body.Long("channelId"));
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
        if (channel.Kind != "text" || E2eeChannelFeature.IsEncrypted(store, channel))
            throw RequestException.BadRequest("Pick a text channel that isn't encrypted.", "builtin_bot_channel");
        return channel.Id;
    }

    /// <summary>
    /// The mention: none, a role, @everyone or @here. An admin may only pick a group, or a role that isn't mentionable,
    /// if they may mention everyone themselves.
    /// </summary>
    private static (string? Mention, long? RoleId) Mention(Session s, Member me, Body body, string? current, long? currentRole)
    {
        if (!body.Has("mention") && !body.IsNull("mention") && !body.Has("mentionRoleId")) return (current, currentRole);
        var mention = body.IsNull("mention") ? null : body.OptionalString("mention", 16) ?? current;
        switch (mention)
        {
            case null:
                return (null, null);
            case "everyone" or "here":
                if (mention != current && !PushService.CanPingGroups(me))
                    throw RequestException.Forbidden("You can't mention everyone, so you can't pick that.", "feeds_mention_denied");
                return (mention, null);
            case "role":
                var roleId = body.OptionalLong("mentionRoleId") ?? currentRole ?? throw RequestException.BadRequest("'mentionRoleId' is required.");
                var role = s.World.Store.GetRole(roleId) ?? throw RequestException.NotFound("Role");
                if (roleId != currentRole && !role.Mentionable && !PushService.CanPingGroups(me))
                    throw RequestException.Forbidden("You can't mention everyone, so you can't pick that.", "feeds_mention_denied");
                return ("role", roleId);
            default:
                throw RequestException.BadRequest("'mention' must be role, everyone, here or null.");
        }
    }

    private static string Template(Body body, string current)
    {
        if (!body.Has("template")) return body.IsNull("template") ? "" : current;
        var raw = body.OptionalString("template", FeedService.MaxTemplate * 2) ?? "";
        if (raw.Trim().Length == 0) return "";
        return Text.Normalize(raw, FeedService.MaxTemplate, allowNewlines: true)
            ?? throw RequestException.BadRequest($"Keep the template to {FeedService.MaxTemplate} characters.", "feeds_template", new { max = FeedService.MaxTemplate });
    }

    private static int Interval(Body body, string kind, int current)
    {
        var (min, max, _) = FeedService.Interval(kind);
        if (body.OptionalLong("intervalMinutes") is not { } n) return current;
        if (n < min || n > max) throw RequestException.BadRequest($"Check every {min}–{max} minutes.", "feeds_interval", new { min, max });
        return (int)n;
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static async Task<object?> Add(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        RequireOn(store);
        var service = Service(s);
        var kind = body.String("kind", 16);
        if (!Kinds.Contains(kind)) throw RequestException.BadRequest("Pick RSS, YouTube or Twitch.", "feeds_kind");
        var input = body.String("source", 512).Trim();
        if (input.Length == 0) throw RequestException.BadRequest("'source' is required.");
        if (store.CountFeedSubscriptions() >= FeedService.MaxSubscriptions) TooMany();
        var channelId = Channel(s, me, body);
        var (mention, roleId) = Mention(s, me, body, null, null);
        var template = Template(body, "");
        var interval = Interval(body, kind, FeedService.Interval(kind).Default);

        if (!s.TryTakeLimit("feeds.added")) throw new RequestException("rate_limited", "You're adding feeds too fast. Try again in a minute.", "feeds_slow");
        var resolved = await service.ResolveAsync(kind, input, CancellationToken.None);
        if (store.FeedSubscriptions().Any(f => f.Kind == kind && f.ChannelId == channelId && string.Equals(f.Source, resolved.Source, StringComparison.OrdinalIgnoreCase)))
            throw RequestException.BadRequest("That's already posted in this channel.", "feeds_duplicate");
        if (store.CountFeedSubscriptions() >= FeedService.MaxSubscriptions) TooMany();
        var now = s.Now;
        var sub = store.AddFeedSubscription(new FeedSubscription(0, kind, resolved.Source, resolved.Name, resolved.Url, channelId, mention, roleId,
            template, interval, false, me.AccountKey, now, resolved.ETag, resolved.LastModified,
            now + interval * 60_000L + Random.Shared.NextInt64(0, interval * 6_000L + 1), 0, null, null, null, null, null, null), resolved.Seen, now);
        Audit.Record(s, "feed.add", BotKey(store), details: new { id = sub.Id, kind, channelId, mention });
        return new { subscription = View(store, sub) };
    }

    private static void TooMany() =>
        throw RequestException.BadRequest($"A server can follow up to {FeedService.MaxSubscriptions} feeds. Remove one first.", "feeds_max",
            new { max = FeedService.MaxSubscriptions });

    private static string? BotKey(Store store) => store.BuiltinBots().FirstOrDefault(r => r.Id == FeedService.Id)?.AccountKey;

    private static FeedSubscription Find(Store store, Body body) =>
        store.GetFeedSubscription(body.Long("id")) ?? throw RequestException.NotFound("Feed");

    private static object Update(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var sub = Find(store, body);
        var changed = new List<string>();
        var channelId = sub.ChannelId;
        if (body.Has("channelId"))
        {
            channelId = Channel(s, me, body);
            if (channelId != sub.ChannelId) changed.Add("channelId");
        }
        var (mention, roleId) = Mention(s, me, body, sub.Mention, sub.MentionRoleId);
        if (mention != sub.Mention || roleId != sub.MentionRoleId) changed.Add("mention");
        var template = Template(body, sub.Template);
        if (template != sub.Template) changed.Add("template");
        var interval = Interval(body, sub.Kind, sub.IntervalMinutes);
        if (interval != sub.IntervalMinutes) changed.Add("intervalMinutes");
        var paused = body.OptionalBool("paused") ?? sub.Paused;
        if (paused != sub.Paused) changed.Add("paused");
        if (changed.Count > 0)
        {
            store.UpdateFeedSettings(sub.Id, channelId, mention, roleId, template, interval, paused);
            Audit.Record(s, "feed.update", BotKey(store), details: new { id = sub.Id, changed });
        }
        return new { subscription = View(store, store.GetFeedSubscription(sub.Id)!) };
    }

    private static object Remove(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var sub = Find(store, body);
        if (store.RemoveFeedSubscription(sub.Id)) Audit.Record(s, "feed.remove", BotKey(store), details: new { id = sub.Id, kind = sub.Kind });
        return new { };
    }

    public const long CheckCooldownMs = 60_000;

    private static async Task<object?> Check(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        RequireOn(store);
        var sub = Find(store, body);
        if (sub.LastManualAt is { } last && s.Now - last < CheckCooldownMs)
        {
            var seconds = (int)Math.Ceiling((CheckCooldownMs - (s.Now - last)) / 1000.0);
            throw RequestException.BadRequest($"You can check again in {seconds} seconds.", "feeds_check_wait", new { seconds });
        }
        await Service(s).CheckAsync(sub.Id, manual: true, CancellationToken.None);
        return new { subscription = View(store, store.GetFeedSubscription(sub.Id) ?? sub) };
    }

    [GeneratedRegex(@"^[A-Za-z0-9]{8,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex TwitchCredential();

    private static async Task<object?> SetTwitch(Session s, Member me, Body body)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can set up Twitch.", "feeds_twitch_owner");
        var store = s.World.Store;
        var clientId = body.String("clientId", 64).Trim();
        var secret = body.String("clientSecret", 64).Trim();
        var service = Service(s);
        if (clientId.Length == 0 && secret.Length == 0)
        {
            store.SetFeedSetting(FeedService.TwitchClientId, null);
            store.SetFeedSetting(FeedService.TwitchSecret, null);
            service.Fetcher.ForgetTwitchToken();
            Audit.Record(s, "feed.twitch", details: new { configured = false });
            return new { twitch = TwitchView(store) };
        }
        if (!TwitchCredential().IsMatch(clientId) || !TwitchCredential().IsMatch(secret))
            throw RequestException.BadRequest("Twitch didn't accept the client id and secret.", "feeds_twitch_credentials");
        try
        {
            await service.Fetcher.CheckTwitchAsync(clientId, secret, CancellationToken.None);
        }
        catch (FeedException e)
        {
            throw e.Code == "twitch_auth"
                ? RequestException.BadRequest("Twitch didn't accept the client id and secret.", "feeds_twitch_credentials")
                : RequestException.BadRequest("Couldn't reach that address. Check it and try again.", "feeds_unreachable");
        }
        store.SetFeedSetting(FeedService.TwitchClientId, clientId);
        store.SetFeedSetting(FeedService.TwitchSecret, secret);
        Audit.Record(s, "feed.twitch", details: new { configured = true });
        return new { twitch = TwitchView(store) };
    }
}
