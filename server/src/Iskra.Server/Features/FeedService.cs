using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Logging;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Runs the Feeds bot: checks each subscription when it's due (its interval plus up to 10% jitter, longer after
/// failures), and posts what's new in its channel. Nothing is fetched while the bot is off. Checks every 15 seconds
/// whether anything is due (Feeds:TickMs; 0 turns the timer off, for tests that check by hand).
/// </summary>
public sealed partial class FeedService : BackgroundService
{
    public const string Id = "feeds";
    public const int MaxSubscriptions = 25;
    public const int MaxPostsPerCheck = 5;
    public const int MaxTemplate = 500;
    public const long MentionCooldownMs = 10 * 60_000;
    public const long MaxBackoffMs = 6 * 3600_000;
    public const string TwitchClientId = "twitch.clientId", TwitchSecret = "twitch.clientSecret";

    /// <summary>Allowed check intervals in minutes, by kind.</summary>
    public static (int Min, int Max, int Default) Interval(string kind) => kind == "twitch" ? (2, 60, 3) : (5, 1440, 15);

    private readonly World _world;
    private readonly Hub _hub;
    private readonly PushService _push;
    private readonly TimeProvider _time;
    private readonly ILogger<FeedService> _log;
    private readonly long _tickMs;
    private readonly ConcurrentDictionary<long, byte> _running = new();
    private readonly ConcurrentDictionary<long, byte> _queued = new();
    private readonly SemaphoreSlim _parallel = new(4);

    public FeedService(World world, Hub hub, PushService push, FeedFetcher fetcher, TimeProvider time, IConfiguration config, ILogger<FeedService> log)
    {
        _world = world;
        _hub = hub;
        _push = push;
        Fetcher = fetcher;
        _time = time;
        _log = log;
        _tickMs = config.GetValue("Feeds:TickMs", 15_000L);
        hub.Feeds = this;
    }

    public FeedFetcher Fetcher { get; }

    private long Now => _time.GetUtcNow().ToUnixTimeMilliseconds();

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (_tickMs <= 0) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(_tickMs), _time);
        try
        {
            // Not awaited: a slow site holds up only its own check (each has a deadline), never the next tick.
            while (await timer.WaitForNextTickAsync(stopping)) _ = TickAsync(stopping);
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Checks every subscription that's due (at most 4 at once). Nothing while the bot is off.</summary>
    internal async Task TickAsync(CancellationToken cancel = default)
    {
        try
        {
            var store = _world.Store;
            if (MoreBuiltinBots.BotIfOn(store, Id) is null) return;
            var now = Now;
            var due = store.FeedSubscriptions().Where(f => !f.Paused && f.NextAt <= now && _queued.TryAdd(f.Id, 0)).ToList();
            await Task.WhenAll(due.Select(async f =>
            {
                try
                {
                    await _parallel.WaitAsync(cancel);
                    try { await CheckAsync(f.Id, manual: false, cancel); }
                    finally { _parallel.Release(); }
                }
                finally { _queued.TryRemove(f.Id, out _); }
            }));
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not ObjectDisposedException)
        {
            _log.Warn(ex, "BOT-110", "sched", "tick-failed", ("what", "feeds"));
        }
    }

    /// <summary>The Twitch app credentials the owner gave, or null.</summary>
    public (string ClientId, string Secret)? TwitchCredentials()
    {
        var store = _world.Store;
        return store.GetFeedSetting(TwitchClientId) is { Length: > 0 } id && store.GetFeedSetting(TwitchSecret) is { Length: > 0 } secret ? (id, secret) : null;
    }

    // ── Checking ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Checks one subscription now (unless a check of it is already running), posts what's new and schedules the next
    /// check. Returns false when it was already running.
    /// </summary>
    public async Task<bool> CheckAsync(long id, bool manual, CancellationToken cancel = default)
    {
        if (!_running.TryAdd(id, 0)) return false;
        try
        {
            var store = _world.Store;
            if (store.GetFeedSubscription(id) is not { } sub) return true;
            var now = Now;
            try
            {
                var (items, etag, lastModified) = await FetchAsync(sub, cancel);
                if (items is not null) Deliver(sub, items, Now);
                store.FeedChecked(sub.Id, now, NextCheck(sub, now), true, null, 0, etag, lastModified, manual);
            }
            catch (FeedException e)
            {
                var failures = Math.Min(sub.Failures + 1, 30);
                var wait = Math.Min(sub.IntervalMinutes * 60_000L << Math.Min(failures, 16), MaxBackoffMs);
                if (e.RetryAfter is { } after) wait = Math.Clamp((long)after.TotalMilliseconds, wait, MaxBackoffMs);
                store.FeedChecked(sub.Id, now, now + wait, false, e.Code, failures, null, null, manual);
            }
            return true;
        }
        finally
        {
            _running.TryRemove(id, out _);
        }
    }

    private long NextCheck(FeedSubscription sub, long now)
    {
        var interval = sub.IntervalMinutes * 60_000L;
        return now + interval + Random.Shared.NextInt64(0, interval / 10 + 1);
    }

    /// <summary>The items in the source now (null: unchanged since last time), and the validators for next time.</summary>
    private async Task<(List<FeedItem>? Items, string? ETag, string? LastModified)> FetchAsync(FeedSubscription sub, CancellationToken cancel)
    {
        if (sub.Kind == "twitch")
        {
            var credentials = TwitchCredentials() ?? throw new FeedException("twitch_setup");
            var stream = await Fetcher.TwitchStreamAsync(credentials.ClientId, credentials.Secret, sub.Source, cancel);
            return (stream is null ? [] : [TwitchItem(stream)], null, null);
        }
        var uri = new Uri(FeedUrl(sub));
        var response = await Fetcher.GetAsync(uri, sub.ETag, sub.LastModified, cancel);
        if (response.NotModified) return (null, null, null);
        if (!FeedFetcher.IsXml(response.MediaType) || FeedFetcher.Parse(response.Body) is not { } doc) throw new FeedException("not_feed");
        return (doc.Items, response.ETag, response.LastModified);
    }

    public string FeedUrl(FeedSubscription sub) =>
        sub.Kind == "youtube" ? Fetcher.YouTubeBase + FeedFetcher.YouTubeFeedPath(sub.Source) : sub.Source;

    public static FeedItem TwitchItem(TwitchStream stream) =>
        new(FeedFetcher.Hash("stream:" + stream.Id), stream.Title, $"https://www.twitch.tv/{stream.Login}", stream.StartedAt);

    /// <summary>Posts the items not seen before (oldest first, at most 5) and marks everything in the source as seen.</summary>
    internal void Deliver(FeedSubscription fetched, List<FeedItem> items, long now)
    {
        var store = _world.Store;
        // As it is now, after the fetch: removed meanwhile means nothing at all; its current channel, mention and text.
        if (store.GetFeedSubscription(fetched.Id) is not { } sub) return;
        var unseen = store.UnseenFeedItems(sub.Id, items.Select(i => i.Id));
        // Feeds list the newest first: oldest first is the reverse, or by date where every new item has one.
        var fresh = items.Where(i => unseen.Remove(i.Id)).Reverse().ToList();
        if (fresh.All(i => i.PublishedAt is not null)) fresh = fresh.OrderBy(i => i.PublishedAt).ToList();
        store.MarkFeedItemsSeen(sub.Id, items.Select(i => i.Id).Distinct().Reverse(), now);
        if (fresh.Count == 0 || sub.Paused) return;
        if (MoreBuiltinBots.BotIfOn(store, Id) is not { } bot) return;
        if (MoreBuiltinBots.PostChannel(store, bot, sub.ChannelId, now) is not { } channel || !Permissions.CanSend(bot, channel)) return;
        var mention = sub.Mention is not null && (sub.LastMentionAt is not { } last || now - last >= MentionCooldownMs);
        foreach (var item in fresh.TakeLast(MaxPostsPerCheck))
        {
            Post(sub, bot, channel, item, mention, now);
            store.FeedPosted(sub.Id, now, mention);
            mention = false;
        }
    }

    // ── Posting ──────────────────────────────────────────────────────────────

    private void Post(FeedSubscription sub, Member bot, Channel channel, FeedItem item, bool mention, long now)
    {
        var store = _world.Store;
        var prefix = mention ? MentionToken(sub) : null;
        var custom = sub.Template.Length > 0;
        // Mentions are defused in the whole filled text: only the subscription's own mention (checked when set) stays.
        var body = Defuse(custom ? Fill(sub.Template, item.Title, item.Url, sub.Name) : DefaultText(sub.Kind, item.Title, item.Url, sub.Name));
        if (body.Length > MaxPostText) body = body[..(char.IsHighSurrogate(body[MaxPostText - 2]) ? MaxPostText - 2 : MaxPostText - 1)] + "…";
        var text = prefix is null ? body : prefix + " " + body;
        var reply = MoreBuiltinBots.Reply(Id, "feed.item", bot.AccountKey, new
        {
            source = sub.Kind,
            subscriptionId = sub.Id,
            name = sub.Name,
            title = item.Title,
            url = item.Url,
            mention = prefix is null ? null : sub.Mention,
            mentionRoleId = prefix is null ? null : sub.MentionRoleId,
            text = custom ? text : null,
        });
        var message = store.AddBuiltinMessage(channel.Id, bot.AccountKey,
            Text.Normalize(text, ChatFeature.MaxMessageLength, allowNewlines: true) ?? "…", reply.ToJsonString(), now);
        _hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = MessageViews.Public(store, message) }));
        _push.ChatMessage(channel, message, pings: prefix is not null);
    }

    private static string? MentionToken(FeedSubscription sub) => sub.Mention switch
    {
        "everyone" => "@everyone",
        "here" => "@here",
        "role" when sub.MentionRoleId is { } role => $"<@&{role}>",
        _ => null,
    };

    /// <summary>The plain English post when there's no template (apps word it in their own language from <c>builtin</c>).</summary>
    public static string DefaultText(string kind, string title, string? url, string name)
    {
        var line = kind switch
        {
            "youtube" => $"▶️ {Escape(name)} posted a new video: **{Escape(title)}**",
            "twitch" => $"🔴 {Escape(name)} is live: **{Escape(title)}**",
            _ => $"📰 {Escape(name)}: **{Escape(title)}**",
        };
        return url is null ? line : line + "\n" + url;
    }

    /// <summary>A post's text (without the mention) is cut to this, so a template can't grow it past a message.</summary>
    public const int MaxPostText = 3000;

    /// <summary>
    /// An admin's template with {title}, {url} and {name} filled in (escaped: they come from the feed). The caller
    /// defuses mentions in the result (<see cref="Defuse"/>), so a placeholder can't complete one either.
    /// </summary>
    public static string Fill(string template, string title, string? url, string name) =>
        template.Replace("{title}", Escape(title), StringComparison.Ordinal).Replace("{name}", Escape(name), StringComparison.Ordinal)
            .Replace("{url}", url ?? "", StringComparison.Ordinal);

    [GeneratedRegex(@"@(everyone|here)\b", RegexOptions.CultureInvariant)]
    private static partial Regex GroupMention();

    /// <summary>Text from a feed: markdown characters escaped, and a joiner after every @, so it can never mention anyone.</summary>
    public static string Escape(string text)
    {
        var sb = new StringBuilder(text.Length + 8);
        foreach (var c in text)
        {
            if (c is '\\' or '`' or '*' or '_' or '~' or '|' or '<' or '>' or '$' or '[' or ']') sb.Append('\\');
            sb.Append(c);
            if (c == '@') sb.Append('‍'); // a joiner after every @: no @everyone, @here or <@…> from a feed
        }
        return sb.ToString();
    }

    /// <summary>No @everyone, @here or &lt;@…&gt; (people, roles) left that could ping.</summary>
    public static string Defuse(string text) =>
        GroupMention().Replace(text, m => "@‍" + m.Groups[1].Value).Replace("<@", "<‍@", StringComparison.Ordinal);

    /// <summary>Whether this subscription's mention will notify people, given the Feeds bot's own permissions.</summary>
    public static bool CanPing(Store store, FeedSubscription sub)
    {
        if (sub.Mention is null) return true;
        if (MoreBuiltinBots.BotIfOn(store, Id) is not { } bot) return false;
        if (PushService.CanPingGroups(bot)) return true;
        return sub.Mention == "role" && sub.MentionRoleId is { } id && store.GetRole(id) is { Mentionable: true };
    }

    // ── Adding ───────────────────────────────────────────────────────────────

    /// <summary>What a new subscription follows: its canonical source, name, page, validators and the items there now.</summary>
    public sealed record Resolved(string Source, string Name, string Url, string? ETag, string? LastModified, List<string> Seen);

    /// <summary>Looks the source up once (also checking it works). Throws <see cref="RequestException"/> with a feeds_* key.</summary>
    public async Task<Resolved> ResolveAsync(string kind, string input, CancellationToken cancel)
    {
        try
        {
            switch (kind)
            {
                case "twitch":
                {
                    var credentials = TwitchCredentials()
                        ?? throw RequestException.BadRequest("Twitch needs the owner to add a Twitch app's client id and secret first.", "feeds_twitch_setup");
                    var login = FeedFetcher.ParseTwitch(input)
                        ?? throw RequestException.BadRequest("That isn't a Twitch channel name.", "feeds_twitch_login");
                    var user = await Fetcher.TwitchUserAsync(credentials.ClientId, credentials.Secret, login, cancel)
                        ?? throw RequestException.BadRequest("There's no Twitch channel by that name.", "feeds_twitch_unknown");
                    var stream = await Fetcher.TwitchStreamAsync(credentials.ClientId, credentials.Secret, user.Login, cancel);
                    return new Resolved(user.Login, user.DisplayName, $"https://www.twitch.tv/{user.Login}", null, null,
                        stream is null ? [] : [TwitchItem(stream).Id]);
                }
                case "youtube":
                {
                    var (channelId, page) = Fetcher.ParseYouTube(input);
                    if (channelId is null && page is not null) channelId = await Fetcher.ResolveYouTubeAsync(page, cancel);
                    if (channelId is null)
                        throw RequestException.BadRequest("Couldn't find that YouTube channel. Paste its channel id (it starts with UC).", "feeds_youtube_channel");
                    var response = await Fetcher.GetAsync(new Uri(Fetcher.YouTubeBase + FeedFetcher.YouTubeFeedPath(channelId)), null, null, cancel);
                    if (FeedFetcher.Parse(response.Body) is not { } doc)
                        throw RequestException.BadRequest("Couldn't find that YouTube channel. Paste its channel id (it starts with UC).", "feeds_youtube_channel");
                    return new Resolved(channelId, doc.Title ?? channelId, $"https://www.youtube.com/channel/{channelId}", response.ETag, response.LastModified,
                        doc.Items.Select(i => i.Id).ToList());
                }
                default:
                {
                    var uri = FeedFetcher.CheckUrl(input.Contains("://") ? input : "https://" + input.Trim())
                        ?? throw RequestException.BadRequest("That isn't a web address of a feed.", "feeds_url");
                    var response = await Fetcher.GetAsync(uri, null, null, cancel);
                    if (FeedFetcher.IsHtml(response.MediaType) && FeedFetcher.DiscoverFeed(response.Body, response.FinalUri) is { } named)
                    {
                        uri = named; // a web page that names its feed
                        response = await Fetcher.GetAsync(uri, null, null, cancel);
                    }
                    if (!FeedFetcher.IsXml(response.MediaType) || FeedFetcher.Parse(response.Body) is not { } doc)
                        throw RequestException.BadRequest("That address isn't an RSS or Atom feed.", "feeds_not_feed");
                    return new Resolved(uri.AbsoluteUri, doc.Title ?? uri.Host, uri.AbsoluteUri, response.ETag, response.LastModified,
                        doc.Items.Select(i => i.Id).ToList());
                }
            }
        }
        catch (FeedException e)
        {
            if (kind == "youtube" && e.Code is "http" or "not_feed")
                throw RequestException.BadRequest("Couldn't find that YouTube channel. Paste its channel id (it starts with UC).", "feeds_youtube_channel");
            throw e.Code switch
            {
                "too_large" => RequestException.BadRequest("That feed is too big (over 2 MB).", "feeds_too_large"),
                "not_feed" => RequestException.BadRequest("That address isn't an RSS or Atom feed.", "feeds_not_feed"),
                "twitch_auth" => RequestException.BadRequest("Twitch didn't accept the client id and secret.", "feeds_twitch_credentials"),
                _ => RequestException.BadRequest("Couldn't reach that address. Check it and try again.", "feeds_unreachable"),
            };
        }
    }
}
