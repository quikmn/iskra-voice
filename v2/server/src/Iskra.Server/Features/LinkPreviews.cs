using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public sealed record LinkPreview(string Url, string? SiteName, string? Title, string? Description);

/// <summary>
/// Title and description for links in chat. The server fetches the page so viewers' IPs aren't sent to every
/// site, and it can only ever reach public addresses: the IP is checked after DNS resolution, on every
/// connection (so redirects and DNS rebinding can't sneak in a private address).
/// </summary>
public sealed partial class LinkPreviews : IDisposable
{
    private const int MaxBytes = 512 * 1024;
    private readonly HttpClient _http;
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, LinkPreview? Preview)> _cache = new();
    private readonly TimeProvider _time;

    public LinkPreviews(IConfiguration config, TimeProvider time)
    {
        _time = time;
        var allowLoopback = config.GetValue<bool>("Previews:AllowLoopbackForTests");
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 3,
            ConnectTimeout = TimeSpan.FromSeconds(4),
            UseCookies = false,
            ConnectCallback = async (context, cancel) =>
            {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancel);
                var allowed = addresses.FirstOrDefault(a => IsPublic(a) || (allowLoopback && IPAddress.IsLoopback(a)))
                    ?? throw new HttpRequestException("That address isn't public.");
                var socket = new Socket(allowed.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(allowed, context.DnsEndPoint.Port, cancel);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            },
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(6) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (compatible; IskraLinkPreview/2.0)");
        _http.DefaultRequestHeaders.Accept.ParseAdd("text/html");
    }

    /// <summary>Only globally routable addresses: no loopback, private, link-local, CGNAT, multicast or metadata ranges.</summary>
    public static bool IsPublic(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (IPAddress.IsLoopback(address)) return false;
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return !(b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224
                || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)      // CGNAT
                || (b[0] == 169 && b[1] == 254)                    // link-local, cloud metadata
                || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
                || (b[0] == 192 && b[1] == 168)
                || (b[0] == 192 && b[1] == 0 && b[2] == 0)
                || (b[0] == 198 && (b[1] == 18 || b[1] == 19)));
        }
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var b = address.GetAddressBytes();
            return !(address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast
                || (b[0] & 0xFE) == 0xFC                           // unique local fc00::/7
                || address.Equals(IPAddress.IPv6None) || address.Equals(IPAddress.IPv6Any));
        }
        return false;
    }

    public async Task<LinkPreview?> GetAsync(string url, CancellationToken cancel)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo))
            return null;
        if (_cache.TryGetValue(uri.AbsoluteUri, out var cached) && _time.GetUtcNow() - cached.At < TimeSpan.FromHours(1))
            return cached.Preview;

        LinkPreview? preview = null;
        try
        {
            using var response = await _http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancel);
            if (response.IsSuccessStatusCode && response.Content.Headers.ContentType?.MediaType is "text/html" or "application/xhtml+xml")
            {
                await using var stream = await response.Content.ReadAsStreamAsync(cancel);
                var buffer = new byte[MaxBytes];
                var read = await stream.ReadAtLeastAsync(buffer, MaxBytes, throwOnEndOfStream: false, cancel);
                preview = Parse(response.RequestMessage?.RequestUri?.AbsoluteUri ?? uri.AbsoluteUri, Encoding.UTF8.GetString(buffer, 0, read));
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or SocketException) { }

        if (_cache.Count > 1000) _cache.Clear();
        _cache[uri.AbsoluteUri] = (_time.GetUtcNow(), preview);
        return preview;
    }

    [GeneratedRegex("""<meta\s+[^>]*?(?:property|name)\s*=\s*["'](?<key>og:[a-z_]+|twitter:[a-z_]+|description)["'][^>]*?content\s*=\s*["'](?<value>[^"']*)["']|<meta\s+[^>]*?content\s*=\s*["'](?<value>[^"']*)["'][^>]*?(?:property|name)\s*=\s*["'](?<key>og:[a-z_]+|twitter:[a-z_]+|description)["']""", RegexOptions.IgnoreCase)]
    private static partial Regex MetaTag();

    [GeneratedRegex("<title[^>]*>(?<t>[^<]{1,300})</title>", RegexOptions.IgnoreCase)]
    private static partial Regex TitleTag();

    public static LinkPreview? Parse(string url, string html)
    {
        var meta = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in MetaTag().Matches(html))
            meta.TryAdd(m.Groups["key"].Value, WebUtility.HtmlDecode(m.Groups["value"].Value).Trim());
        string? Pick(params string[] keys) => keys.Select(k => meta.GetValueOrDefault(k)).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

        var title = Pick("og:title", "twitter:title") ?? (TitleTag().Match(html) is { Success: true } t ? WebUtility.HtmlDecode(t.Groups["t"].Value).Trim() : null);
        var description = Pick("og:description", "twitter:description", "description");
        if (title is null && description is null) return null;
        return new LinkPreview(url, Clip(Pick("og:site_name"), 60), Clip(title, 200), Clip(description, 300));
    }

    private static string? Clip(string? s, int max) =>
        s is null ? null : Text.Normalize(s.Length > max ? s[..max] + "…" : s, max + 1, allowNewlines: false);

    public void Dispose() => _http.Dispose();
}

public static class PreviewFeature
{
    public static void Register(Router router) => router.AddAsync("link.preview", Preview);

    private static async Task<object?> Preview(Session s, Member me, Body body)
    {
        var url = body.String("url", 2048);
        return new { preview = await s.Previews.GetAsync(url, CancellationToken.None) };
    }
}
