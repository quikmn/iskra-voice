using System.Net;
using Iskra.Server.Gifs;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The GIF picker, through this server (see <see cref="GifService"/>): status, admin setup, search, trending and categories,
/// GIF messages, and the media proxy at GET /gifs/media.
/// </summary>
public static class GifFeature
{
    public const long MaxMediaBytes = 15 * 1024 * 1024;
    private static readonly string[] MediaTypes = ["image/gif", "image/webp", "image/png", "image/jpeg"];

    public static void Register(Router router)
    {
        router.Add("gif.status", (s, _, _) => Status(s.Gifs));
        router.Add("gif.configure", Configure);
        router.AddAsync("gif.trending", Trending);
        router.AddAsync("gif.search", Search);
        router.AddAsync("gif.categories", Categories);
    }

    private static object Status(GifService gifs) => new { enabled = gifs.Enabled, provider = gifs.Enabled ? GifService.Provider : null };

    private static object? Configure(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can set up GIFs.");
        var key = body.OptionalString("key", 256)?.Trim() ?? throw RequestException.BadRequest("'key' is required (\"\" turns GIFs off).");
        if (key.Length > 0 && !GifService.ValidKey(key)) throw RequestException.BadRequest("That doesn't look like a KLIPY API key.");
        s.Gifs.Configure(key.Length == 0 ? null : key);
        s.Hub.Broadcast(Frames.Event("gif.status", Status(s.Gifs)));
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

    /// <summary>chat.send's optional <c>gif</c> (a token from a search result). A GIF is sent on its own.</summary>
    public static GifItem? Parse(Session s, Body body, string[] attachments, string text)
    {
        var token = body.OptionalString("gif", 4096);
        if (token is null) return null;
        if (attachments.Length > 0 || text.Length > 0 || body.OptionalString("sticker", 64) is not null)
            throw RequestException.BadRequest("A GIF is sent on its own.");
        return s.Gifs.ReadToken(token) ?? throw RequestException.BadRequest("Unknown GIF.");
    }

    public static void Saved(Store store, Message message, GifItem? gif)
    {
        if (gif is not null) store.SetMessageGif(message.Id, new SentGif(GifService.Provider, gif.Id, gif.Title, gif.Url, gif.Preview, gif.Width, gif.Height));
    }

    public static object? View(Store store, long messageId) =>
        store.GetMessageGif(messageId) is { } g
            ? new
            {
                provider = g.Provider, id = g.Id, title = g.Title, width = g.Width, height = g.Height,
                url = GifService.MediaPath(store, g.Url), preview = GifService.MediaPath(store, g.Preview),
            }
            : null;

    // ── Media proxy ──────────────────────────────────────────────────────────

    /// <summary>
    /// GET /gifs/media?u=&amp;s=: streams a file from the provider's media hosts (signed links only, public addresses only,
    /// images only, size-capped, nothing stored), so viewers' addresses never reach the provider.
    /// </summary>
    public static async Task ServeMedia(HttpContext context, GifService gifs, IGifUpstream upstream, Hub hub)
    {
        Files.Uploads.AllowCors(context);
        var response = context.Response;
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
