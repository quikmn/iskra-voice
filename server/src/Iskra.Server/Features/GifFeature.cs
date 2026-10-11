using System.Net;
using Iskra.Server.Gifs;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The GIF picker (KLIPY). Two modes an admin picks: "direct" (default; members' apps get the key and talk to KLIPY
/// themselves, as KLIPY's standard terms require) or "proxy" (search and media through this server, see
/// <see cref="GifService"/>; only with KLIPY's written approval). Also GIF messages and the media proxy at GET /gifs/media.
/// </summary>
public static class GifFeature
{
    public const long MaxMediaBytes = 15 * 1024 * 1024;
    private static readonly string[] MediaTypes = ["image/gif", "image/webp", "image/png", "image/jpeg"];

    public static void Register(Router router)
    {
        router.Add("gif.status", (s, me, _) => Status(s.Gifs, me.AccountKey));
        router.Add("gif.configure", Configure);
        router.AddAsync("gif.trending", Trending);
        router.AddAsync("gif.search", Search);
        router.AddAsync("gif.categories", Categories);
    }

    /// <summary>What a member's app needs. In direct mode that includes the key and their own KLIPY customer id.</summary>
    private static object Status(GifService gifs, string accountKey)
    {
        var key = gifs.DirectKey;
        return new
        {
            enabled = gifs.Enabled,
            provider = gifs.Enabled ? GifService.Provider : null,
            mode = gifs.Mode,
            key,
            customerId = key is null ? null : gifs.CustomerIdFor(accountKey),
        };
    }

    private static object? Configure(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can set up GIFs.");
        var key = body.OptionalString("key", 256)?.Trim();
        var mode = body.OptionalString("mode", 16);
        if (key is null && mode is null) throw RequestException.BadRequest("Send 'key' (\"\" turns GIFs off) and/or 'mode'.");
        if (mode is not null and not ("direct" or "proxy")) throw RequestException.BadRequest("'mode' must be direct or proxy.");
        if (key is { Length: > 0 } && !GifService.ValidKey(key)) throw RequestException.BadRequest("That doesn't look like a KLIPY API key.");
        if (key is not null) s.Gifs.Configure(key.Length == 0 ? null : key);
        if (mode is not null) s.Gifs.SetMode(mode);
        // Each member gets their own status (their customer id differs).
        foreach (var session in s.Hub.Sessions)
            if (session.AccountKey is { } account) session.Send(Frames.Event("gif.status", Status(s.Gifs, account)));
        return null;
    }

    private static int Page(Body body) => (int)(body.OptionalLong("page", min: 1, max: GifService.MaxPage) ?? 1);

    private static async Task<object?> Run<T>(Func<Task<T?>> work, Func<T, object> view) where T : class
    {
        try
        {
            var result = await work();
            return result is null ? throw new RequestException("unavailable", "Couldn't reach the GIF service.") : view(result);
        }
        catch (GifUnavailable e)
        {
            throw new RequestException("unavailable", e.Message);
        }
    }

    private static object PageView(Session s, GifPage page) => new { gifs = page.Items.Select(s.Gifs.View), hasNext = page.HasNext };

    private static Task<object?> Trending(Session s, Member me, Body body)
    {
        var page = Page(body);
        return Run(() => s.Gifs.TrendingAsync(page), p => PageView(s, p));
    }

    private static Task<object?> Search(Session s, Member me, Body body)
    {
        var query = Text.Normalize(body.String("q", GifService.MaxQueryLength * 2), GifService.MaxQueryLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Searches are 1–{GifService.MaxQueryLength} characters.");
        var page = Page(body);
        return Run(() => s.Gifs.SearchAsync(query, page), p => PageView(s, p));
    }

    private static Task<object?> Categories(Session s, Member me, Body body) =>
        Run(() => s.Gifs.CategoriesAsync(), list => new
        {
            categories = list.Select(c => new { name = c.Name, query = c.Query, preview = c.Preview is null ? null : s.Gifs.MediaPath(c.Preview) }),
        });

    // ── Messages ─────────────────────────────────────────────────────────────

    /// <summary>
    /// chat.send's optional <c>gif</c>: a token from the server's search (proxy mode), or in direct mode the GIF as the
    /// app got it from KLIPY, <c>{ id, title, url, preview, width, height }</c>, with both addresses on KLIPY's media
    /// hosts. A GIF is sent on its own.
    /// </summary>
    public static GifItem? Parse(Session s, Body body, string[] attachments, string text)
    {
        if (body.OptionalElement("gif") is not { } element) return null;
        if (attachments.Length > 0 || text.Length > 0 || body.OptionalString("sticker", 64) is not null)
            throw RequestException.BadRequest("A GIF is sent on its own.");
        if (element.ValueKind == System.Text.Json.JsonValueKind.String)
            return s.Gifs.ReadToken(element.GetString()!) ?? throw RequestException.BadRequest("Unknown GIF.");
        if (element.ValueKind != System.Text.Json.JsonValueKind.Object) throw RequestException.BadRequest("'gif' must be a token or an object.");
        if (!s.Gifs.Enabled || s.Gifs.Proxied) throw RequestException.BadRequest("Send GIFs from this server's search.");
        var gif = new Body(element);
        var id = gif.String("id", 128);
        var url = gif.String("url", 1024);
        var preview = gif.OptionalString("preview", 1024) ?? url;
        if (!GifService.IsMediaUrl(url) || !GifService.IsMediaUrl(preview)) throw RequestException.BadRequest("GIFs must come from KLIPY.");
        var title = Text.Normalize(gif.OptionalString("title", 200) ?? "", 100, allowNewlines: false) ?? "GIF";
        var width = (int)(gif.OptionalLong("width", 0, 4096) ?? 0);
        var height = (int)(gif.OptionalLong("height", 0, 4096) ?? 0);
        return new GifItem(id, title, url, preview, width, height);
    }

    public static void Saved(Store store, Message message, GifItem? gif)
    {
        if (gif is not null) store.SetMessageGif(message.Id, new SentGif(GifService.Provider, gif.Id, gif.Title, gif.Url, gif.Preview, gif.Width, gif.Height));
    }

    /// <summary>
    /// A GIF message as the server is set up now: through the proxy (relative paths), or in direct mode KLIPY's own
    /// addresses (<c>direct: true</c>; apps show those only after a click unless the viewer chose otherwise).
    /// </summary>
    public static object? View(Store store, long messageId)
    {
        if (store.GetMessageGif(messageId) is not { } g) return null;
        var proxied = GifService.ModeOf(store) == "proxy";
        return new
        {
            provider = g.Provider, id = g.Id, title = g.Title, width = g.Width, height = g.Height, direct = !proxied,
            url = proxied ? GifService.MediaPath(store, g.Url) : g.Url,
            preview = proxied ? GifService.MediaPath(store, g.Preview) : g.Preview,
        };
    }

    // ── Media proxy ──────────────────────────────────────────────────────────

    /// <summary>
    /// GET /gifs/media?u=&amp;s=: streams a file from the provider's media hosts (signed links only, public addresses only,
    /// images only, size-capped, nothing stored), so viewers' addresses never reach the provider.
    /// </summary>
    public static async Task ServeMedia(HttpContext context, GifService gifs, IGifUpstream upstream, Hub hub)
    {
        Files.Uploads.AllowCors(context);
        var response = context.Response;
        if (!gifs.Proxied)
        {
            response.StatusCode = StatusCodes.Status404NotFound; // direct mode: apps load KLIPY's files themselves
            return;
        }
        var uri = gifs.CheckMediaLink(context.Request.Query["u"], context.Request.Query["s"]);
        if (uri is null)
        {
            response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        var client = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (!hub.Limits.TryTake(client, "gif.media"))
        {
            response.StatusCode = StatusCodes.Status429TooManyRequests;
            return;
        }

        try
        {
            using var upstreamResponse = await upstream.GetMediaAsync(uri, context.RequestAborted);
            var type = upstreamResponse.Content.Headers.ContentType?.MediaType;
            if (upstreamResponse.StatusCode != HttpStatusCode.OK || type is null || !MediaTypes.Contains(type)
                || upstreamResponse.Content.Headers.ContentLength > MaxMediaBytes)
            {
                response.StatusCode = StatusCodes.Status502BadGateway;
                return;
            }
            response.ContentType = type;
            if (upstreamResponse.Content.Headers.ContentLength is { } length) response.ContentLength = length;
            response.Headers.XContentTypeOptions = "nosniff";
            response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
            response.Headers.CacheControl = "private, max-age=86400";
            await using var stream = await upstreamResponse.Content.ReadAsStreamAsync(context.RequestAborted);
            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = await stream.ReadAsync(buffer, context.RequestAborted)) > 0)
            {
                total += read;
                if (total > MaxMediaBytes)
                {
                    context.Abort(); // too big after all: cut it off
                    return;
                }
                await response.Body.WriteAsync(buffer.AsMemory(0, read), context.RequestAborted);
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException)
        {
            if (!response.HasStarted) response.StatusCode = StatusCodes.Status502BadGateway;
        }
    }
}
