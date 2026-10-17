using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>One post, video or stream from a feed. <see cref="Id"/> is a hash of its id (or link, or title).</summary>
public sealed record FeedItem(string Id, string Title, string? Url, long? PublishedAt);

public sealed record FeedDocument(string? Title, string? Link, List<FeedItem> Items);

/// <summary>Why a fetch failed: <c>unreachable</c>, <c>blocked</c>, <c>http</c>, <c>not_feed</c>, <c>too_large</c>, <c>rate_limited</c>, <c>twitch_setup</c>, <c>twitch_auth</c>.</summary>
public sealed class FeedException(string code, TimeSpan? retryAfter = null, int? status = null) : Exception($"Feed fetch failed: {code}")
{
    public string Code { get; } = code;
    public TimeSpan? RetryAfter { get; } = retryAfter;
    public int? Status { get; } = status;
}

/// <summary>The address isn't one the Feeds bot may reach.</summary>
public sealed class FeedAddressException() : Exception("That address isn't allowed for a feed.");

public sealed record FeedResponse(bool NotModified, byte[] Body, string? MediaType, string? ETag, string? LastModified, Uri FinalUri);

public sealed record TwitchUser(string Id, string Login, string DisplayName);

public sealed record TwitchStream(string Id, string Login, string UserName, string Title, string? Game, long? StartedAt);

/// <summary>
/// Fetches feeds for the Feeds bot with the link previews' protections: only public addresses, checked after DNS on
/// every connection (so redirects and DNS rebinding can't reach a private one), a LocalOnly server only loopback; no
/// cookies or proxy, a size cap, timeouts, at most 3 redirects. XML is read without DTDs or external entities.
/// </summary>
public sealed partial class FeedFetcher : IDisposable
{
    public const int MaxBytes = 2 * 1024 * 1024;
    public const int MaxItems = 100;
    public const int MaxTitle = 300;
    public const int MaxUrl = 2048;

    private readonly HttpClient _http;
    private readonly object _tokenGate = new();
    private (string ClientId, string Token, DateTimeOffset Expires)? _token;
    private readonly TimeProvider _time;

    public string YouTubeBase { get; }
    public string TwitchAuthBase { get; }
    public string TwitchApiBase { get; }

    public FeedFetcher(IConfiguration config, World world, TimeProvider time)
        : this(world.Settings.LocalOnly, config.GetValue<bool>("Feeds:AllowLoopbackForTests"), null, time,
            config["Feeds:YouTubeUrl"], config["Feeds:TwitchAuthUrl"], config["Feeds:TwitchApiUrl"])
    {
    }

    /// <param name="resolve">DNS lookup (tests hand in their own).</param>
    public FeedFetcher(bool localOnly, bool allowLoopback, Func<string, CancellationToken, Task<IPAddress[]>>? resolve, TimeProvider time,
        string? youTube = null, string? twitchAuth = null, string? twitchApi = null)
    {
        _time = time;
        YouTubeBase = (youTube ?? "https://www.youtube.com").TrimEnd('/');
        TwitchAuthBase = (twitchAuth ?? "https://id.twitch.tv").TrimEnd('/');
        TwitchApiBase = (twitchApi ?? "https://api.twitch.tv").TrimEnd('/');
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true, // every new connection goes through Connect again
            MaxAutomaticRedirections = 3,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            UseCookies = false,
            UseProxy = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            MaxResponseHeadersLength = 64,
            ConnectCallback = Connect(localOnly, allowLoopback, resolve ?? ((host, cancel) => Dns.GetHostAddressesAsync(host, cancel))),
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Iskra-Feeds/1");
    }

    // ── Addresses ────────────────────────────────────────────────────────────

    /// <summary>A LocalOnly server reaches only loopback; others only public addresses (loopback only for tests).</summary>
    public static bool MayConnect(IPAddress address, bool localOnly, bool allowLoopback)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (localOnly) return IPAddress.IsLoopback(address);
        if (IPAddress.IsLoopback(address)) return allowLoopback;
        return LinkPreviews.IsPublic(address);
    }

    private static Func<SocketsHttpConnectionContext, CancellationToken, ValueTask<Stream>> Connect(bool localOnly, bool allowLoopback,
        Func<string, CancellationToken, Task<IPAddress[]>> resolve) =>
        async (context, cancel) =>
        {
            var host = context.DnsEndPoint.Host;
            var addresses = IPAddress.TryParse(host.Trim('[', ']'), out var literal) ? [literal] : await resolve(host, cancel);
            // The address checked is the address connected to: a second lookup can't swap in a private one.
            var allowed = addresses.Where(a => MayConnect(a, localOnly, allowLoopback)).ToList();
            if (allowed.Count == 0) throw new FeedAddressException();
            Exception? last = null;
            foreach (var address in allowed)
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(address, context.DnsEndPoint.Port, cancel);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch (SocketException ex)
                {
                    socket.Dispose();
                    last = ex;
                }
            }
            throw last!;
        };

    /// <summary>An http(s) address without a user name or password, at most 512 characters; null otherwise.</summary>
    public static Uri? CheckUrl(string url)
    {
        url = url.Trim();
        if (url.Length > 512 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
            || uri.Host.Length == 0 || !string.IsNullOrEmpty(uri.UserInfo)) return null;
        return uri;
    }

    // ── Fetching ─────────────────────────────────────────────────────────────

    private const string FeedAccept = "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1";

    /// <summary>GET with the last answer's validators; 304 is <see cref="FeedResponse.NotModified"/>.</summary>
    public Task<FeedResponse> GetAsync(Uri uri, string? etag, string? lastModified, CancellationToken cancel, string accept = FeedAccept)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Accept.ParseAdd(accept);
        if (etag is not null) request.Headers.TryAddWithoutValidation("If-None-Match", etag);
        if (lastModified is not null) request.Headers.TryAddWithoutValidation("If-Modified-Since", lastModified);
        return SendAsync(request, cancel);
    }

    private async Task<FeedResponse> SendAsync(HttpRequestMessage request, CancellationToken cancel)
    {
        using var _ = request;
        try
        {
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel);
            var final = response.RequestMessage?.RequestUri ?? request.RequestUri!;
            if (response.StatusCode == HttpStatusCode.NotModified) return new FeedResponse(true, [], null, null, null, final);
            if (response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable)
                throw new FeedException("rate_limited", RetryAfter(response), (int)response.StatusCode);
            if (!response.IsSuccessStatusCode) throw new FeedException("http", RetryAfter(response), (int)response.StatusCode);
            if (response.Content.Headers.ContentLength > MaxBytes) throw new FeedException("too_large");
            await using var stream = await response.Content.ReadAsStreamAsync(cancel);
            var buffer = new byte[MaxBytes + 1];
            var read = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, cancel);
            if (read > MaxBytes) throw new FeedException("too_large");
            return new FeedResponse(false, buffer[..read], response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant(),
                response.Headers.ETag?.ToString(), response.Content.Headers.LastModified?.ToString("R", CultureInfo.InvariantCulture), final);
        }
        catch (FeedException) { throw; }
        catch (Exception ex) when (Blocked(ex)) { throw new FeedException("blocked"); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or SocketException or InvalidOperationException)
        {
            if (cancel.IsCancellationRequested) throw;
            throw new FeedException("unreachable");
        }
    }

    private static bool Blocked(Exception? ex)
    {
        for (; ex is not null; ex = ex.InnerException)
            if (ex is FeedAddressException) return true;
        return false;
    }

    private TimeSpan? RetryAfter(HttpResponseMessage response)
    {
        if (response.Headers.RetryAfter is { } after)
        {
            if (after.Delta is { } delta) return delta;
            if (after.Date is { } date) return date - _time.GetUtcNow();
        }
        // Twitch: Ratelimit-Reset is a Unix time in seconds.
        if (response.Headers.TryGetValues("Ratelimit-Reset", out var reset) && long.TryParse(reset.FirstOrDefault(), out var at))
            return DateTimeOffset.FromUnixTimeSeconds(at) - _time.GetUtcNow();
        return null;
    }

    /// <summary>XML-ish answers (and text/plain, which some servers use for feeds).</summary>
    public static bool IsXml(string? mediaType) =>
        mediaType is null or "text/plain" or "application/octet-stream" || mediaType.EndsWith("xml", StringComparison.Ordinal);

    public static bool IsHtml(string? mediaType) => mediaType is "text/html" or "application/xhtml+xml";

    // ── Parsing ──────────────────────────────────────────────────────────────

    /// <summary>
    /// RSS (0.9x, 1.0, 2.0) or Atom, YouTube's included. No DTD is read, no entity from one, nothing external; null when
    /// it isn't a feed. Items in document order (newest first in most feeds), at most <see cref="MaxItems"/>.
    /// </summary>
    public static FeedDocument? Parse(byte[] bytes)
    {
        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Ignore,
            XmlResolver = null,
            MaxCharactersInDocument = MaxBytes * 2L,
            MaxCharactersFromEntities = 1024,
            IgnoreComments = true,
            IgnoreProcessingInstructions = true,
        };
        XDocument doc;
        try
        {
            using var reader = XmlReader.Create(new MemoryStream(bytes), settings);
            doc = XDocument.Load(reader);
        }
        catch (Exception ex) when (ex is XmlException or ArgumentException or InvalidOperationException or DecoderFallbackException)
        {
            return null;
        }
        var root = doc.Root;
        if (root is null || root.Name.LocalName is not ("rss" or "feed" or "RDF")) return null;
        var atom = root.Name.LocalName == "feed";
        var channel = atom ? root : root.Elements().FirstOrDefault(e => e.Name.LocalName == "channel") ?? root;
        var title = Clean(Child(channel, "title")?.Value, 100);
        var link = atom ? AtomLink(channel) : LinkOf(Child(channel, "link")?.Value);
        var items = new List<FeedItem>();
        foreach (var e in root.Descendants().Where(e => e.Name.LocalName is "item" or "entry").Take(MaxItems))
        {
            var itemLink = AtomLink(e) ?? LinkOf(Child(e, "link")?.Value);
            var guid = Child(e, "guid");
            if (itemLink is null && guid is not null && guid.Attribute("isPermaLink")?.Value != "false") itemLink = LinkOf(guid.Value);
            var itemTitle = Clean(Child(e, "title")?.Value, MaxTitle) ?? Clean(Child(e, "description")?.Value, 120) ?? "";
            var id = Child(e, "videoId")?.Value ?? guid?.Value ?? Child(e, "id")?.Value ?? itemLink ?? (itemTitle + "|" + Child(e, "pubDate")?.Value);
            if (string.IsNullOrWhiteSpace(id)) continue;
            var published = Date(Child(e, "pubDate")?.Value ?? Child(e, "published")?.Value ?? Child(e, "updated")?.Value ?? Child(e, "date")?.Value);
            items.Add(new FeedItem(Hash(id.Trim()), itemTitle, itemLink, published));
        }
        return new FeedDocument(title, link, items);
    }

    private static XElement? Child(XElement e, string localName) => e.Elements().FirstOrDefault(c => c.Name.LocalName == localName);

    /// <summary>An Atom entry's (or feed's) page: rel="alternate" or no rel.</summary>
    private static string? AtomLink(XElement e)
    {
        var links = e.Elements().Where(c => c.Name.LocalName == "link" && c.Attribute("href") is not null).ToList();
        var best = links.FirstOrDefault(l => l.Attribute("rel")?.Value is null or "alternate");
        return best is null ? null : LinkOf(best.Attribute("href")!.Value);
    }

    /// <summary>An absolute http(s) link, at most <see cref="MaxUrl"/> characters, or null.</summary>
    public static string? LinkOf(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo)) return null;
        var text = uri.AbsoluteUri;
        return text.Length <= MaxUrl ? text : null;
    }

    private static long? Date(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        raw = raw.Trim();
        if (DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)) return parsed.ToUnixTimeMilliseconds();
        // RFC 822 with a zone name ("Tue, 10 Jun 2003 04:00:00 GMT" parses; "EST" etc. don't): drop the zone.
        var cut = raw.LastIndexOf(' ');
        return cut > 0 && DateTimeOffset.TryParse(raw[..cut], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out parsed)
            ? parsed.ToUnixTimeMilliseconds() : null;
    }

    /// <summary>Item ids are kept hashed: short, and nothing from the feed is stored but what was posted.</summary>
    public static string Hash(string id) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(id)))[..32];

    /// <summary>One line of text: no control or invisible formatting characters, spaces collapsed, at most <paramref name="max"/>.</summary>
    public static string? Clean(string? raw, int max)
    {
        if (raw is null) return null;
        var text = new StringBuilder();
        var space = false;
        foreach (var c in WebUtility.HtmlDecode(raw).Normalize(NormalizationForm.FormC))
        {
            if (char.IsWhiteSpace(c))
            {
                space = text.Length > 0;
                continue;
            }
            if (c != '‍' && char.GetUnicodeCategory(c) is UnicodeCategory.Control or UnicodeCategory.Format
                or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
                continue;
            if (space) text.Append(' ');
            space = false;
            text.Append(c);
        }
        var result = text.ToString().Trim();
        if (result.Length == 0) return null;
        if (result.Length > max) result = result[..(char.IsHighSurrogate(result[max - 2]) ? max - 2 : max - 1)] + "…";
        return result;
    }

    // ── Web pages ────────────────────────────────────────────────────────────

    [GeneratedRegex(@"<link\b[^>]*>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LinkTag();

    [GeneratedRegex(@"\b(rel|type|href)\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Attribute();

    /// <summary>The feed a web page names (<c>&lt;link rel="alternate" type="application/rss+xml"&gt;</c>), or null.</summary>
    public static Uri? DiscoverFeed(byte[] html, Uri page)
    {
        var text = Encoding.UTF8.GetString(html, 0, Math.Min(html.Length, 512 * 1024));
        foreach (Match tag in LinkTag().Matches(text))
        {
            var attrs = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (Match m in Attribute().Matches(tag.Value))
                attrs.TryAdd(m.Groups[1].Value.ToLowerInvariant(),
                    WebUtility.HtmlDecode(m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Success ? m.Groups[3].Value : m.Groups[4].Value));
            if (!attrs.TryGetValue("rel", out var rel) || !rel.Split(' ').Contains("alternate", StringComparer.OrdinalIgnoreCase)) continue;
            if (!attrs.TryGetValue("type", out var type) || type.ToLowerInvariant() is not ("application/rss+xml" or "application/atom+xml")) continue;
            if (attrs.TryGetValue("href", out var href) && Uri.TryCreate(page, href, out var feed) && CheckUrl(feed.AbsoluteUri) is { } ok) return ok;
        }
        return null;
    }

    // ── YouTube ──────────────────────────────────────────────────────────────

    [GeneratedRegex(@"^UC[A-Za-z0-9_-]{22}$", RegexOptions.CultureInvariant)]
    public static partial Regex YouTubeChannelId();

    [GeneratedRegex(@"(?:youtube\.com/channel/|""externalId""\s*:\s*""|""channelId""\s*:\s*""|channel_id=)(UC[A-Za-z0-9_-]{22})", RegexOptions.CultureInvariant)]
    private static partial Regex YouTubeIdInPage();

    [GeneratedRegex(@"^@[A-Za-z0-9._-]{1,100}$", RegexOptions.CultureInvariant)]
    private static partial Regex YouTubeHandle();

    public static string YouTubeFeedPath(string channelId) => $"/feeds/videos.xml?channel_id={channelId}";

    /// <summary>
    /// What the admin typed: a channel id, a channel or feed address (id), or a handle / <c>/c/</c> / <c>/user/</c> address
    /// (a page to look the id up on). Null when it's neither.
    /// </summary>
    public (string? Id, Uri? Page) ParseYouTube(string input)
    {
        input = input.Trim();
        if (YouTubeChannelId().IsMatch(input)) return (input, null);
        if (YouTubeHandle().IsMatch(input)) return (null, new Uri(YouTubeBase + "/" + Uri.EscapeDataString(input).Replace("%40", "@")));
        if (!input.Contains("://")) input = "https://" + input;
        if (CheckUrl(input) is not { } uri) return (null, null);
        var host = uri.Host.ToLowerInvariant();
        var ours = Uri.TryCreate(YouTubeBase, UriKind.Absolute, out var b) && uri.Authority.Equals(b.Authority, StringComparison.OrdinalIgnoreCase);
        if (!ours && host is not ("youtube.com" or "www.youtube.com" or "m.youtube.com")) return (null, null);
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length >= 2 && segments[0] == "channel" && YouTubeChannelId().IsMatch(segments[1])) return (segments[1], null);
        var query = System.Web.HttpUtility.ParseQueryString(uri.Query)["channel_id"];
        if (query is not null && YouTubeChannelId().IsMatch(query)) return (query, null);
        if (segments.Length >= 1 && (segments[0].StartsWith('@') || (segments.Length >= 2 && segments[0] is "c" or "user")))
        {
            var path = segments[0].StartsWith('@') ? segments[0] : segments[0] + "/" + segments[1];
            return (null, new Uri(YouTubeBase + "/" + path));
        }
        return (null, null);
    }

    /// <summary>Looks a channel's id up on its public page (no API key). Null when the page doesn't say.</summary>
    public async Task<string?> ResolveYouTubeAsync(Uri page, CancellationToken cancel)
    {
        var response = await GetAsync(page, null, null, cancel, "text/html");
        if (response.NotModified) return null;
        var text = Encoding.UTF8.GetString(response.Body);
        // The canonical link names the channel itself (other ids on the page can be recommendations).
        var canonical = Regex.Match(text, @"<link\s+rel=""canonical""\s+href=""[^""]*/channel/(UC[A-Za-z0-9_-]{22})""", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        if (canonical.Success) return canonical.Groups[1].Value;
        var any = YouTubeIdInPage().Match(text);
        return any.Success ? any.Groups[1].Value : null;
    }

    // ── Twitch (Helix, app access token) ─────────────────────────────────────

    [GeneratedRegex(@"^[A-Za-z0-9_]{1,25}$", RegexOptions.CultureInvariant)]
    public static partial Regex TwitchLogin();

    /// <summary>A login, or a twitch.tv address; null otherwise.</summary>
    public static string? ParseTwitch(string input)
    {
        input = input.Trim().TrimStart('@');
        if (TwitchLogin().IsMatch(input)) return input.ToLowerInvariant();
        if (!input.Contains("://")) input = "https://" + input;
        if (CheckUrl(input) is not { } uri || uri.Host.ToLowerInvariant() is not ("twitch.tv" or "www.twitch.tv" or "m.twitch.tv")) return null;
        var first = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return first is not null && TwitchLogin().IsMatch(first) ? first.ToLowerInvariant() : null;
    }

    public void ForgetTwitchToken()
    {
        lock (_tokenGate) _token = null;
    }

    private async Task<string> TwitchTokenAsync(string clientId, string secret, bool fresh, CancellationToken cancel)
    {
        lock (_tokenGate)
            if (!fresh && _token is { } t && t.ClientId == clientId && t.Expires > _time.GetUtcNow()) return t.Token;
        using var request = new HttpRequestMessage(HttpMethod.Post, TwitchAuthBase + "/oauth2/token")
        {
            Content = new FormUrlEncodedContent([new("client_id", clientId), new("client_secret", secret), new("grant_type", "client_credentials")]),
        };
        FeedResponse response;
        try
        {
            response = await SendAsync(request, cancel);
        }
        catch (FeedException e) when (e.Code == "http" && e.Status is 400 or 401 or 403)
        {
            throw new FeedException("twitch_auth", status: e.Status);
        }
        try
        {
            using var doc = JsonDocument.Parse(response.Body);
            var token = doc.RootElement.GetProperty("access_token").GetString() ?? throw new FeedException("twitch_auth");
            var seconds = doc.RootElement.TryGetProperty("expires_in", out var e) && e.TryGetInt64(out var s) ? s : 3600;
            lock (_tokenGate) _token = (clientId, token, _time.GetUtcNow().AddSeconds(Math.Max(60, seconds - 60)));
            return token;
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            throw new FeedException("twitch_auth");
        }
    }

    /// <summary>Gets a token with these credentials (to check them before they're saved).</summary>
    public Task CheckTwitchAsync(string clientId, string secret, CancellationToken cancel) => TwitchTokenAsync(clientId, secret, fresh: true, cancel);

    private async Task<JsonElement> HelixAsync(string clientId, string secret, string pathAndQuery, CancellationToken cancel)
    {
        for (var attempt = 0; ; attempt++)
        {
            var token = await TwitchTokenAsync(clientId, secret, fresh: attempt > 0, cancel);
            var request = new HttpRequestMessage(HttpMethod.Get, TwitchApiBase + pathAndQuery);
            request.Headers.TryAddWithoutValidation("Client-Id", clientId);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            try
            {
                var response = await SendAsync(request, cancel);
                using var doc = JsonDocument.Parse(response.Body);
                return doc.RootElement.GetProperty("data").Clone();
            }
            catch (FeedException e) when (e.Code == "http" && e.Status == 401 && attempt == 0)
            {
                ForgetTwitchToken(); // expired or revoked: one more try with a new one
            }
            catch (FeedException e) when (e.Code == "http" && e.Status == 401)
            {
                throw new FeedException("twitch_auth", status: 401);
            }
            catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
            {
                throw new FeedException("not_feed");
            }
        }
    }

    public async Task<TwitchUser?> TwitchUserAsync(string clientId, string secret, string login, CancellationToken cancel)
    {
        var data = await HelixAsync(clientId, secret, "/helix/users?login=" + Uri.EscapeDataString(login), cancel);
        if (data.ValueKind != JsonValueKind.Array || data.GetArrayLength() == 0) return null;
        var u = data[0];
        return new TwitchUser(Str(u, "id") ?? "", Str(u, "login") ?? login, Clean(Str(u, "display_name"), 100) ?? login);
    }

    /// <summary>The channel's live stream, or null when it's offline.</summary>
    public async Task<TwitchStream?> TwitchStreamAsync(string clientId, string secret, string login, CancellationToken cancel)
    {
        var data = await HelixAsync(clientId, secret, "/helix/streams?user_login=" + Uri.EscapeDataString(login), cancel);
        if (data.ValueKind != JsonValueKind.Array) return null;
        foreach (var s in data.EnumerateArray())
        {
            if (Str(s, "type") is { } type && type != "live") continue;
            var started = Str(s, "started_at") is { } at && DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d)
                ? d.ToUnixTimeMilliseconds() : (long?)null;
            var id = Str(s, "id");
            if (string.IsNullOrEmpty(id)) continue;
            return new TwitchStream(id, Str(s, "user_login") ?? login, Clean(Str(s, "user_name"), 100) ?? login,
                Clean(Str(s, "title"), MaxTitle) ?? "", Clean(Str(s, "game_name"), 100), started);
        }
        return null;
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public void Dispose() => _http.Dispose();
}
