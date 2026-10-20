using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Gifs;

/// <summary>Talks to the GIF provider. Swapped for a fake in tests.</summary>
public interface IGifUpstream
{
    /// <summary>An API response body, or null when the provider couldn't be reached or answered with an error.</summary>
    Task<string?> GetJsonAsync(Uri uri, CancellationToken cancel);

    /// <summary>A media file, streamed. The caller disposes the response.</summary>
    Task<HttpResponseMessage> GetMediaAsync(Uri uri, CancellationToken cancel);
}

/// <summary>Reaches the provider like link previews do: public addresses only (checked after DNS), no redirects, short timeouts.</summary>
public sealed class GifUpstream : IGifUpstream, IDisposable
{
    public const int MaxJsonBytes = 1024 * 1024;
    private readonly HttpClient _http;
    /// <summary>End-to-end tests only (and only with loopback allowed for tests): a local stand-in for the provider.</summary>
    private readonly Uri? _testUpstream;

    public GifUpstream(IConfiguration config)
    {
        if (config.GetValue<bool>("Previews:AllowLoopbackForTests") && Uri.TryCreate(config["Gifs:TestUpstream"], UriKind.Absolute, out var test))
            _testUpstream = test;
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(4),
            UseCookies = false,
            ConnectCallback = LinkPreviews.PublicOnlyConnect(config.GetValue<bool>("Previews:AllowLoopbackForTests")),
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("IskraGifProxy/1.0");
    }

    public async Task<string?> GetJsonAsync(Uri uri, CancellationToken cancel)
    {
        try
        {
            using var response = await _http.GetAsync(Route(uri, media: false), HttpCompletionOption.ResponseHeadersRead, cancel);
            if (!response.IsSuccessStatusCode) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(cancel);
            var buffer = new byte[MaxJsonBytes];
            var read = await stream.ReadAtLeastAsync(buffer, MaxJsonBytes, throwOnEndOfStream: false, cancel);
            return Encoding.UTF8.GetString(buffer, 0, read);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException) { return null; }
    }

    public Task<HttpResponseMessage> GetMediaAsync(Uri uri, CancellationToken cancel) =>
        _http.GetAsync(Route(uri, media: true), HttpCompletionOption.ResponseHeadersRead, cancel);

    private Uri Route(Uri uri, bool media) =>
        _testUpstream is null ? uri : new Uri(_testUpstream, (media ? "/media/" + uri.Host : "") + uri.PathAndQuery);

    public void Dispose() => _http.Dispose();
}

public sealed record GifItem(string Id, string Title, string Url, string Preview, int Width, int Height);
public sealed record GifPage(List<GifItem> Items, bool HasNext);
public sealed record GifCategory(string Name, string Query, string? Preview);

/// <summary>
/// GIF search through this server, so members' devices never contact the provider: the server holds the admin's API key
/// (never sent to clients), asks the provider on everyone's behalf with one pseudonymous customer id per server, caches
/// answers briefly, and hands out signed links to its own media proxy. Provider: KLIPY (Tenor's API closed in 2026).
/// </summary>
public sealed class GifService(World world, IGifUpstream upstream, TimeProvider time)
{
    public const string Provider = "klipy";
    public const string ApiBase = "https://api.klipy.com/api/v1/";
    public static readonly string[] MediaHosts = ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"];
    public const int PerPage = 24;
    public const int MaxPage = 50;
    public const int MaxQueryLength = 100;
    private const string KeySetting = "klipy-key";
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(5);

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, object Value)> _cache = new();
    private readonly Lock _budgetGate = new();
    private double _budget = 60;
    private long _budgetAt;

    // ── Settings ─────────────────────────────────────────────────────────────

    public bool Enabled => world.Store.GetGifSetting(KeySetting) is not null;

    /// <summary>
    /// "proxy" (the default): everything goes through this server, so members' devices never contact KLIPY.
    /// "direct" (an owner's explicit choice): members' devices get the key and call KLIPY and load GIFs themselves.
    /// </summary>
    public string Mode => ModeOf(world.Store);

    public static string ModeOf(Store store) => store.GetGifSetting("mode") == "direct" ? "direct" : "proxy";

    public bool Proxied => Mode == "proxy";

    public void SetMode(string mode)
    {
        world.Store.SetGifSetting("mode", mode == "direct" ? "direct" : null);
        _cache.Clear();
    }

    /// <summary>Direct mode: the key, for members' devices (KLIPY keys are per app, here per server).</summary>
    public string? DirectKey => Mode == "direct" ? world.Store.GetGifSetting(KeySetting) : null;

    /// <summary>Direct mode: a stable pseudonym per member for KLIPY's customer_id (not their account key).</summary>
    public string CustomerIdFor(string accountKey) => Sign("gif-customer", accountKey)[..22];

    /// <summary>Sets (or with null, removes) the provider key.</summary>
    public void Configure(string? key)
    {
        world.Store.SetGifSetting(KeySetting, key);
        _cache.Clear();
    }

    /// <summary>A key as the provider issues them: letters, digits, '-' and '_'.</summary>
    public static bool ValidKey(string key) => key.Length is >= 8 and <= 128 && key.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Store, byte[]> SigningKeys = new();

    /// <summary>Signs media links and GIF tokens. Kept in the world, so links in old messages keep working after a restart.</summary>
    private static byte[] SigningKey(Store store) => SigningKeys.GetValue(store, s =>
    {
        var stored = s.GetGifSetting("signing-key");
        if (stored is null || !Ed25519.TryFromB64u(stored, out var key) || key.Length != 32)
        {
            key = RandomNumberGenerator.GetBytes(32);
            s.SetGifSetting("signing-key", Ed25519.ToB64u(key));
        }
        return key;
    });

    private static string Sign(Store store, string context, string value) =>
        Ed25519.ToB64u(HMACSHA256.HashData(SigningKey(store), Encoding.UTF8.GetBytes($"iskra/{context}/v1\0{value}")));

    private string Sign(string context, string value) => Sign(world.Store, context, value);

    private bool Verify(string context, string value, string sig) =>
        Ed25519.TryFromB64u(sig, out var given) && Ed25519.TryFromB64u(Sign(context, value), out var good)
        && CryptographicOperations.FixedTimeEquals(given, good);

    /// <summary>One id for the whole server, so the provider can't tell members apart.</summary>
    private string CustomerId => Sign("gif-customer", "server")[..22];

    // ── Asking the provider ──────────────────────────────────────────────────

    /// <summary>A shared budget for calls to the provider (cached answers are free).</summary>
    private bool TakeBudget()
    {
        lock (_budgetGate)
        {
            var now = time.GetTimestamp();
            _budget = Math.Min(60, _budget + time.GetElapsedTime(_budgetAt, now).TotalSeconds * (60 / 60.0));
            _budgetAt = now;
            if (_budget < 1) return false;
            _budget -= 1;
            return true;
        }
    }

    private async Task<T?> Cached<T>(string cacheKey, string path, Func<string, T> parse) where T : class
    {
        var key = world.Store.GetGifSetting(KeySetting) ?? throw new GifUnavailable("GIFs aren't turned on for this server.");
        if (!Proxied) throw new GifUnavailable("On this server, apps load GIFs from KLIPY directly.");
        if (_cache.TryGetValue(cacheKey, out var hit) && time.GetUtcNow() - hit.At < CacheFor) return (T)hit.Value;
        if (!TakeBudget()) throw new GifUnavailable("Lots of GIF searches right now. Try again in a minute.");
        var json = await upstream.GetJsonAsync(new Uri($"{ApiBase}{Uri.EscapeDataString(key)}/gifs/{path}"), CancellationToken.None);
        if (json is null) throw new GifUnavailable("Couldn't reach the GIF service.");
        T value;
        try
        {
            value = parse(json);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            throw new GifUnavailable("The GIF service sent something unexpected.");
        }
        if (_cache.Count > 500) _cache.Clear();
        _cache[cacheKey] = (time.GetUtcNow(), value);
        return value;
    }

    public Task<GifPage?> TrendingAsync(int page) =>
        Cached($"t:{page}", $"trending?page={page}&per_page={PerPage}&customer_id={CustomerId}&content_filter=medium&format_filter=gif,webp", ParsePage);

    public Task<GifPage?> SearchAsync(string query, int page) =>
        Cached($"s:{page}:{query.ToLowerInvariant()}",
            $"search?page={page}&per_page={PerPage}&q={Uri.EscapeDataString(query)}&customer_id={CustomerId}&content_filter=medium&format_filter=gif,webp",
            ParsePage);

    public Task<List<GifCategory>?> CategoriesAsync() => Cached("c", "categories", ParseCategories);

    // ── Reading the provider's answers ───────────────────────────────────────

    /// <summary>KLIPY: { data: { data: [ { slug, title, type, file: { hd|md|sm|xs: { gif|webp: { url, width, height } } } } ], has_next } }.</summary>
    public static GifPage ParsePage(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var data = doc.RootElement.GetProperty("data");
        var items = new List<GifItem>();
        foreach (var item in data.GetProperty("data").EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            if (item.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String && type.GetString() != "gif") continue; // ads and others
            if (ParseItem(item) is { } gif) items.Add(gif);
        }
        var hasNext = data.TryGetProperty("has_next", out var next) && next.ValueKind == JsonValueKind.True;
        return new GifPage(items, hasNext);
    }

    private static GifItem? ParseItem(JsonElement item)
    {
        var id = Str(item, "slug") ?? Str(item, "id");
        if (id is null || id.Length > 128 || !item.TryGetProperty("file", out var file) || file.ValueKind != JsonValueKind.Object) return null;
        var full = Media(file, "md", "webp") ?? Media(file, "md", "gif") ?? Media(file, "hd", "webp") ?? Media(file, "hd", "gif");
        var preview = Media(file, "sm", "webp") ?? Media(file, "sm", "gif") ?? Media(file, "xs", "gif") ?? full;
        if (full is null || preview is null) return null;
        var title = Text.Normalize(Str(item, "title") ?? "", 100, allowNewlines: false) ?? "GIF";
        return new GifItem(id, title, full.Value.Url, preview.Value.Url, full.Value.Width, full.Value.Height);
    }

    private static (string Url, int Width, int Height)? Media(JsonElement file, string size, string format)
    {
        if (!file.TryGetProperty(size, out var s) || s.ValueKind != JsonValueKind.Object) return null;
        if (!s.TryGetProperty(format, out var f) || f.ValueKind != JsonValueKind.Object) return null;
        var url = Str(f, "url");
        if (url is null || !IsMediaUrl(url)) return null;
        var width = f.TryGetProperty("width", out var w) && w.TryGetInt32(out var wi) ? wi : 0;
        var height = f.TryGetProperty("height", out var h) && h.TryGetInt32(out var hi) ? hi : 0;
        return (url, Math.Clamp(width, 0, 4096), Math.Clamp(height, 0, 4096));
    }

    /// <summary>Categories: { data: { categories: [ { category, query, preview_url } ] } } (or the list as data).</summary>
    public static List<GifCategory> ParseCategories(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var data = doc.RootElement.GetProperty("data");
        var list = data.ValueKind == JsonValueKind.Array ? data : data.GetProperty("categories");
        var categories = new List<GifCategory>();
        foreach (var c in list.EnumerateArray())
        {
            if (c.ValueKind != JsonValueKind.Object) continue;
            var name = Text.Normalize(Str(c, "category") ?? Str(c, "name") ?? "", 40, allowNewlines: false);
            var query = Text.Normalize(Str(c, "query") ?? name ?? "", MaxQueryLength, allowNewlines: false);
            if (name is null || query is null) continue;
            var preview = Str(c, "preview_url");
            categories.Add(new GifCategory(name, query, preview is not null && IsMediaUrl(preview) ? preview : null));
            if (categories.Count >= 50) break;
        }
        return categories;
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>Only https on the default port, no credentials, and one of the provider's media hosts.</summary>
    public static bool IsMediaUrl(string url) =>
        url.Length <= 1024 && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.IsDefaultPort
        && uri.UserInfo.Length == 0 && uri.HostNameType == UriHostNameType.Dns && MediaHosts.Contains(uri.IdnHost.ToLowerInvariant());

    // ── What clients get ─────────────────────────────────────────────────────

    /// <summary>A path on this server that shows the provider's file (signed, so the proxy only fetches what we handed out).</summary>
    public string MediaPath(string url) => MediaPath(world.Store, url);

    public static string MediaPath(Store store, string url) =>
        $"/gifs/media?u={Ed25519.ToB64u(Encoding.UTF8.GetBytes(url))}&s={Sign(store, "gif-media", url)}";

    /// <summary>Checks a media link from <see cref="MediaPath"/>; the provider URL, or null.</summary>
    public Uri? CheckMediaLink(string? u, string? s)
    {
        if (u is null || s is null || !Ed25519.TryFromB64u(u, out var bytes, MaxEncoded)) return null;
        var url = Encoding.UTF8.GetString(bytes);
        return IsMediaUrl(url) && Verify("gif-media", url, s) ? new Uri(url) : null;
    }

    public object View(GifItem g) => new
    {
        id = g.Id, title = g.Title, width = g.Width, height = g.Height, url = MediaPath(g.Url), preview = MediaPath(g.Preview),
        token = Token(g),
    };

    /// <summary>What a client sends back to post a GIF: the item, signed, so nobody can post an arbitrary address.</summary>
    /// <summary>A token or media link, encoded: two addresses of up to 1024 characters each, an id and a title.</summary>
    private const int MaxEncoded = 4096;

    public string Token(GifItem g)
    {
        var json = JsonSerializer.Serialize(new[] { g.Id, g.Title, g.Url, g.Preview, g.Width.ToString(), g.Height.ToString() });
        var body = Ed25519.ToB64u(Encoding.UTF8.GetBytes(json));
        return $"{body}.{Sign("gif-token", body)}";
    }

    public GifItem? ReadToken(string token)
    {
        var dot = token.IndexOf('.');
        if (dot <= 0 || !Verify("gif-token", token[..dot], token[(dot + 1)..]) || !Ed25519.TryFromB64u(token[..dot], out var bytes, MaxEncoded)) return null;
        try
        {
            var parts = JsonSerializer.Deserialize<string[]>(bytes);
            if (parts is not { Length: 6 } || !IsMediaUrl(parts[2]) || !IsMediaUrl(parts[3])) return null;
            return new GifItem(parts[0], parts[1], parts[2], parts[3], int.Parse(parts[4]), int.Parse(parts[5]));
        }
        catch (Exception e) when (e is JsonException or FormatException or OverflowException) { return null; }
    }
}

public sealed class GifUnavailable(string message) : Exception(message);
