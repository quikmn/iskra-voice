using System.Net;
using System.Security.Cryptography;
using System.Text;
using Iskra.Server.Crypto;
using Iskra.Server.Hosting;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The calendar: members' birthdays for the calendar view, and calendar feeds. A feed is a private address
/// (<c>GET /calendar/{token}.ics</c>) that a member's calendar app (Google, Outlook, Apple) fetches this server's events
/// from: off until the member makes one, one per member, replaced or removed by them at any time, and only a hash of
/// the token is stored. The owner can turn feeds off for the whole server. See PROTOCOL.md, "Calendar".
/// </summary>
public static class CalendarFeature
{
    public static void Register(Router router, CalendarFeeds feeds)
    {
        router.Add("calendar.birthdays", (s, _, _) => new { birthdays = Birthdays(s.World.Store) });
        router.Add("calendar.feed.get", (s, me, _) => new { feed = feeds.View(me) });
        router.Add("calendar.feed.create", (s, me, _) =>
        {
            var store = s.World.Store;
            if (!store.CalendarFeedsAllowed()) throw RequestException.Forbidden("Calendar links are turned off on this server.", "calendar_feeds_off");
            if (store.IsBot(me.AccountKey)) throw RequestException.BadRequest("Bots don't have calendar links.", "calendar_feed_bot");
            var token = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32));
            var replaced = store.GetCalendarFeed(me.AccountKey) is not null;
            store.SetCalendarFeed(me.AccountKey, CalendarFeeds.Hash(token), s.Now);
            SecurityLog.Record(s, "calendar.feed.created", details: new { replaced });
            return new { feed = feeds.View(me), path = CalendarFeeds.PathFor(token) };
        });
        router.Add("calendar.feed.remove", (s, me, _) =>
        {
            if (s.World.Store.GetCalendarFeed(me.AccountKey) is not null)
            {
                s.World.Store.RemoveCalendarFeed(me.AccountKey);
                SecurityLog.Record(s, "calendar.feed.removed");
            }
            return new { feed = feeds.View(me) };
        });
        router.Add("calendar.settings.update", (s, me, body) =>
        {
            if (!BaseRoles.Allows(me, BaseAbility.RunServer)) throw RequestException.Forbidden("Only the owner can change this.", "owner_calendar");
            var allowed = body.OptionalBool("feeds") ?? throw RequestException.BadRequest("'feeds' is required.");
            var store = s.World.Store;
            if (store.CalendarFeedsAllowed() != allowed)
            {
                store.SetCalendarFeedsAllowed(allowed);
                // Turning feeds off ends every link: one made later is a new address.
                if (!allowed) store.RemoveAllCalendarFeeds();
                Audit.Record(s, "calendar.settings", details: new { feeds = allowed });
                s.Hub.Broadcast(Frames.Event("calendar.settings", new { feeds = allowed }));
            }
            return new { feed = feeds.View(me) };
        });
    }

    /// <summary>
    /// The birthdays members shared with the Birthdays bot (day and month), for the calendar view. The same people
    /// <c>/birthday list</c> shows any member; nothing while the bot is off.
    /// </summary>
    private static IEnumerable<object> Birthdays(Store store)
    {
        if (MoreBuiltinBots.BotIfOn(store, BirthdayBot.Id) is null) return [];
        return store.AllBirthdays()
            .Where(b => store.GetMember(b.AccountKey) is not null && !store.IsBot(b.AccountKey))
            .Select(b => (object)new { accountKey = b.AccountKey, month = b.Month, day = b.Day });
    }
}

/// <summary>The HTTP side of calendar feeds, and what the app is told about them.</summary>
public sealed class CalendarFeeds(World world, TimeProvider time, IConfiguration config)
{
    /// <summary>Per feed: 12 fetches at once, then one every 30 seconds. Calendar services ask a few times a day.</summary>
    public const double Burst = 12, PerSecond = 1 / 30.0;

    /// <summary>Per client address, for unknown tokens: 20 at once, then one a second.</summary>
    public const double FailBurst = 20, FailPerSecond = 1;

    private const int MaxTokenLength = 64;

    private readonly BoundedTable<string, WebhookIngress.TokenBucket> _feeds = new(10_000, b => b.Available);
    private readonly BoundedTable<IPAddress, WebhookIngress.TokenBucket> _failures = new(10_000, b => b.Available);

    public static string Hash(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public static string PathFor(string token) => $"/calendar/{token}.ics";

    public static bool IsFeedPath(PathString path) => path.StartsWithSegments("/calendar");

    /// <summary>
    /// As for webhooks: the token is in the address, so plain HTTP from another machine is refused, not redirected.
    /// </summary>
    public static bool RefuseOverPlainHttp(HttpContext context) =>
        !context.Request.IsHttps && IsFeedPath(context.Request.Path) && Networks.IsElsewhere(context);

    public static Task WriteUseHttpsAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.ContentType = "text/plain; charset=utf-8";
        return context.Response.WriteAsync("Use https:// for this calendar link. Its address was sent unencrypted: make a new link in Iskra.");
    }

    public static void Map(WebApplication app) =>
        app.MapGet("/calendar/{file}", (HttpContext context, string file, CalendarFeeds feeds) => feeds.Serve(context, file));

    /// <summary>
    /// Where calendar services on the internet reach this server over HTTPS: the internet hosting address, else
    /// PublicUrl, else the HTTPS domain. Null when there is none, or it isn't a public https:// address.
    /// </summary>
    public string? Address()
    {
        if (config["Calendar:AddressForTests"] is { Length: > 0 } forTests) return forTests.TrimEnd('/');
        var s = world.Settings;
        var url = world.InternetUrl ?? s.PublicUrl ?? (s.Https.Enabled ? s.Https.DefaultUrl : null);
        return url is not null && IsPublicHttps(url) ? url.TrimEnd('/') : null;
    }

    /// <summary>An https:// address whose host isn't this machine, a private network, or a name only a local network knows.</summary>
    public static bool IsPublicHttps(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        var host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        if (host.Length == 0 || host == "localhost") return false;
        if (IPAddress.TryParse(host.Trim('[', ']'), out var ip)) return !Networks.IsNonPublic(ip);
        if (!host.Contains('.')) return false;
        string[] local = [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".ts.net"];
        return !local.Any(suffix => host.EndsWith(suffix, StringComparison.Ordinal));
    }

    /// <summary>What a member's app shows: whether feeds are allowed, whether they have one, and the server's public address.</summary>
    public object View(Member me)
    {
        var store = world.Store;
        var feed = store.GetCalendarFeed(me.AccountKey);
        return new
        {
            allowed = store.CalendarFeedsAllowed(),
            on = feed is not null,
            createdAt = feed?.CreatedAt,
            fetchedAt = feed?.FetchedAt,
            address = Address(),
        };
    }

    public IResult Serve(HttpContext context, string file)
    {
        var headers = context.Response.Headers;
        headers.CacheControl = "private, no-store";
        headers["X-Robots-Tag"] = "noindex";
        var store = world.Store;
        var token = file.EndsWith(".ics", StringComparison.Ordinal) ? file[..^4] : file;
        var feed = token.Length is > 0 and <= MaxTokenLength && store.CalendarFeedsAllowed() ? store.CalendarFeedByHash(Hash(token)) : null;
        var member = feed is null ? null : store.GetMember(feed.AccountKey);
        if (feed is null || member is null)
        {
            // Tokens are 256-bit, so guessing is hopeless; this keeps junk traffic cheap. A removed link looks like one that never was.
            var failures = _failures.GetOrAdd(AddressLimits.Network(context.Connection.RemoteIpAddress), _ => new WebhookIngress.TokenBucket(FailBurst, FailPerSecond, time));
            return failures.TryTake(out var failWait) ? Results.NotFound() : TooMany(context, failWait);
        }
        if (!_feeds.GetOrAdd(feed.TokenHash, _ => new WebhookIngress.TokenBucket(Burst, PerSecond, time)).TryTake(out var wait))
            return TooMany(context, wait);

        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        // When it was last fetched, for the member ("Last fetched …"); written at most every ten minutes.
        if (feed.FetchedAt is not { } fetched || now - fetched > 600_000) store.CalendarFeedFetched(feed.AccountKey, now);
        return Results.Text(CalendarIcs.Build(world, member, now), "text/calendar", Encoding.UTF8);
    }

    private static IResult TooMany(HttpContext context, TimeSpan wait)
    {
        context.Response.Headers.RetryAfter = Math.Ceiling(wait.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Results.StatusCode(StatusCodes.Status429TooManyRequests);
    }
}
