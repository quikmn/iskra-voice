using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The server's icon (square: the rail, the header, invites) and banner (wide: the top of the channel list). Set by whoever
/// has the <c>serverImages</c> ability (admins by default). Every picture is checked by its bytes and stored without its
/// metadata (EXIF, GPS, XMP, text, thumbnails). The icon alone is also public at <c>GET /icon</c>, for invite landings.
/// </summary>
public static class ServerImageFeature
{
    public const long MaxIconBytes = 1024 * 1024;
    public const long MaxBannerBytes = 3 * 1024 * 1024;
    public const int MinIconSide = 128;
    public const int MinBannerWidth = 480;
    public const int MinBannerHeight = 120;
    public const int MaxSide = 4096;
    /// <summary>How far an icon may be from square (5%).</summary>
    public const double IconSquareSlack = 0.05;
    public const double MinBannerAspect = 2.5;
    public const double MaxBannerAspect = 4.0;

    private static readonly string[] Types = ["image/png", "image/jpeg", "image/webp"];

    public const string Icon = "icon";
    public const string Banner = "banner";

    public static void Register(Router router) => router.Add("server.images.set", Set);

    /// <summary>What welcome and the <c>server.images</c> event carry: <c>{ icon: File | null, banner: File | null }</c>.</summary>
    public static object View(Store store) => new { icon = FileView(store.GetServerImage(Icon)), banner = FileView(store.GetServerImage(Banner)) };

    private static object? FileView(StoredFile? file) => file is null ? null : Uploads.Public(file);

    /// <summary>A short stamp of the icon's content for <c>GET /</c> (changes whenever the icon does), or null without one.</summary>
    public static string? IconVersion(Store store) => store.GetServerImage(Icon)?.Sha256[..16];

    private static object Set(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.ServerImages))
            throw RequestException.Forbidden("Only admins can change the server's icon and banner.", "server_images_admins");
        var icon = body.OptionalString(Icon, 64);
        var banner = body.OptionalString(Banner, 64);
        if (icon is null && banner is null) throw RequestException.BadRequest("Send 'icon', 'banner' or both.");

        var store = s.World.Store;
        // Check both before changing either, so a bad banner doesn't leave a new icon behind.
        var newIcon = icon is { Length: > 0 } ? Prepare(s, me, icon, Icon) : null;
        var newBanner = banner is { Length: > 0 } ? Prepare(s, me, banner, Banner) : null;

        Apply(s, Icon, icon, newIcon);
        Apply(s, Banner, banner, newBanner);
        // Only now that both are in place: the uploads with their metadata go (unless something else uses them).
        foreach (var (sent, used) in new[] { (icon, newIcon), (banner, newBanner) }.DistinctBy(p => p.Item1))
            if (sent is { Length: > 0 } && used is not null && used.Id != sent) s.Uploads.DeleteIfUnused(sent);
        Audit.Record(s, "server.images", details: new { icon = Change(icon), banner = Change(banner) });

        var view = View(store);
        s.Hub.Broadcast(Frames.Event("server.images", view));
        return view;
    }

    private static string? Change(string? sent) => sent is null ? null : sent.Length == 0 ? "removed" : "set";

    private static void Apply(Session s, string kind, string? sent, StoredFile? file)
    {
        if (sent is null) return;
        if (file is null) s.World.Store.ClearServerImage(kind);
        else s.World.Store.SetServerImage(kind, file.Id, s.AccountKey!, s.Now);
    }

    /// <summary>
    /// Checks an upload of yours as an icon or banner by its bytes (type, size, dimensions, shape) and returns the file to
    /// use: a copy without metadata, or the upload itself if it had none.
    /// </summary>
    private static StoredFile Prepare(Session s, Member me, string fileId, string kind)
    {
        var isIcon = kind == Icon;
        var store = s.World.Store;
        var current = store.GetServerImage(kind);
        if (current?.Id == fileId) return current;
        var file = store.GetFile(fileId);
        if (file is null || file.Uploader != me.AccountKey || store.GetDmFile(fileId) is not null)
            throw RequestException.BadRequest("Unknown image file.");
        var maxBytes = isIcon ? MaxIconBytes : MaxBannerBytes;
        if (file.Size > maxBytes) throw TooBig(isIcon, maxBytes);
        var bytes = s.Uploads.ReadContent(file, maxBytes) ?? throw TooBig(isIcon, maxBytes);

        // The type from the bytes themselves, never the name or what the upload said.
        var sniffed = FileSniffer.Sniff(bytes.AsSpan(0, Math.Min(bytes.Length, 64 * 1024)));
        if (!Types.Contains(sniffed.Type))
            throw RequestException.BadRequest("Server pictures must be PNG, JPEG or WebP images.", "server_image_type");

        byte[] clean;
        try
        {
            clean = ImageMetadata.Strip(bytes, sniffed.Type);
        }
        catch (ImageMetadata.Refused refused) when (refused.Animated)
        {
            throw RequestException.BadRequest("Server pictures can't be animated.", "server_image_animated");
        }
        catch (ImageMetadata.Refused)
        {
            throw RequestException.BadRequest("Couldn't read that image's size.", "image_size_unreadable");
        }

        var (width, height) = Size(clean, sniffed.Type);
        if (width is not { } w || height is not { } h || w < 1 || h < 1)
            throw RequestException.BadRequest("Couldn't read that image's size.", "image_size_unreadable");
        if (w > MaxSide || h > MaxSide) throw RequestException.BadRequest("That image is too large.", "image_too_large");
        if (isIcon)
        {
            if (w < MinIconSide || h < MinIconSide)
                throw RequestException.BadRequest($"Server icons must be at least {MinIconSide}×{MinIconSide} pixels.", "server_icon_small", new { min = MinIconSide });
            if (Math.Abs(w - h) > Math.Max(w, h) * IconSquareSlack)
                throw RequestException.BadRequest("Server icons must be square.", "server_icon_square");
        }
        else
        {
            if (w < MinBannerWidth || h < MinBannerHeight)
                throw RequestException.BadRequest($"Banners must be at least {MinBannerWidth}×{MinBannerHeight} pixels.", "server_banner_small",
                    new { width = MinBannerWidth, height = MinBannerHeight });
            var aspect = (double)w / h;
            if (aspect < MinBannerAspect || aspect > MaxBannerAspect)
                throw RequestException.BadRequest("Banners must be wide: 2.5 to 4 times as wide as they are high.", "server_banner_shape");
        }

        // The upload with its metadata is deleted by Set, once the whole request has gone through.
        return s.Uploads.StoreCopy(file, clean, sniffed.Type, w, h);
    }

    private static RequestException TooBig(bool isIcon, long maxBytes) => isIcon
        ? RequestException.BadRequest($"Server icons can be up to {maxBytes / 1024} KB.", "server_icon_size", new { kb = maxBytes / 1024 })
        : RequestException.BadRequest($"Banners can be up to {maxBytes / 1024 / 1024} MB.", "server_banner_size", new { mb = maxBytes / 1024 / 1024 });

    private static (int?, int?) Size(byte[] bytes, string type)
    {
        if (type == "image/jpeg")
        {
            using var stream = new MemoryStream(bytes, writable: false);
            return FileSniffer.JpegSize(stream);
        }
        var kind = FileSniffer.Sniff(bytes.AsSpan(0, Math.Min(bytes.Length, 64 * 1024)));
        return (kind.Width, kind.Height);
    }

    // ── GET /icon ────────────────────────────────────────────────────────────

    /// <summary>
    /// The icon alone, for invite landings before joining: any origin may show it, nothing else is in the answer, and
    /// it's never run as anything but an image. Cached briefly; a changed icon gets a new <c>?v=</c> from <c>GET /</c>.
    /// </summary>
    public static IResult ServeIcon(HttpContext context, World world, Uploads uploads)
    {
        var headers = context.Response.Headers;
        headers.AccessControlAllowOrigin = "*";
        headers.XContentTypeOptions = "nosniff";
        headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        headers["Cross-Origin-Resource-Policy"] = "cross-origin";
        var icon = world.Store.GetServerImage(Icon);
        if (icon is null || !Types.Contains(icon.Type) || icon.Size > MaxIconBytes) return Results.NotFound();
        var path = uploads.PathFor(icon.Sha256);
        if (!File.Exists(path)) return Results.NotFound();
        headers.CacheControl = "public, max-age=300";
        var etag = $"\"{icon.Sha256[..32]}\"";
        headers.ETag = etag;
        if (context.Request.Headers.IfNoneMatch.ToString() == etag) return Results.StatusCode(StatusCodes.Status304NotModified);
        return Results.File(path, icon.Type);
    }
}
