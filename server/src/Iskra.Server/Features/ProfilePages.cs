using System.Text.RegularExpressions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Serves members' profile pages: one self-contained HTML file each, locked in a sandbox.
/// The page gets an opaque origin (no storage, no cookies, nothing of the app's), can run inline
/// scripts and styles, can show data: images and this server's files, and can't fetch, submit,
/// frame, open windows or navigate the app. See PROTOCOL.md, "Profiles", for the full model.
/// </summary>
public static partial class ProfilePages
{
    [GeneratedRegex("^[A-Za-z0-9_-]{16,64}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex(@"^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$")]
    private static partial Regex HostPattern();

    [GeneratedRegex(@"^\s*<!doctype[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex Doctype();

    /// <summary>
    /// Runs before the page's own code. WebRTC isn't covered by CSP in today's browsers, so take it away
    /// (best effort: STUN requests could otherwise reveal the viewer's IP address).
    /// </summary>
    public const string Prelude =
        "<script>(()=>{for(const k of[\"RTCPeerConnection\",\"webkitRTCPeerConnection\",\"RTCDataChannel\",\"RTCIceTransport\",\"WebTransport\"])" +
        "try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}})()</script>";

    /// <summary>Apps allowed to frame pages: the official web app, the desktop app, local development, and this server's AppUrl.</summary>
    public static string FrameAncestors(World world)
    {
        var list = new List<string> { "'self'", "https://app.iskra.foo", "app://iskra", "http://localhost:*", "http://127.0.0.1:*" };
        if (Uri.TryCreate(world.Settings.AppUrl, UriKind.Absolute, out var app) && app.Scheme is "http" or "https")
        {
            var origin = $"{app.Scheme}://{app.IdnHost}{(app.IsDefaultPort ? "" : $":{app.Port}")}";
            if (HostPattern().IsMatch(origin[(app.Scheme.Length + 3)..]) && !list.Contains(origin)) list.Add(origin);
        }
        return string.Join(' ', list);
    }

    public static string Policy(World world, string? selfOrigin) =>
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        $"img-src data: blob:{(selfOrigin is null ? "" : $" {selfOrigin}/files/")}; font-src data:; media-src 'none'; " +
        "connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; " +
        $"manifest-src 'none'; base-uri 'none'; frame-ancestors {FrameAncestors(world)}";

    public const string PermissionsPolicy =
        "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), " +
        "gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), " +
        "screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()";

    /// <summary>The prelude goes right after a doctype (so the page keeps standards mode), otherwise first.</summary>
    public static string WithPrelude(string html)
    {
        var doctype = Doctype().Match(html);
        return doctype.Success ? html[..doctype.Length] + Prelude + html[doctype.Length..] : Prelude + html;
    }

    public static IResult Serve(HttpContext context, World world, string id)
    {
        if (!IdPattern().IsMatch(id) || !ProfileFeature.PagesEnabled(world.Store)) return Results.NotFound();
        var page = world.Store.GetPageById(id);
        if (page is null) return Results.NotFound();

        var host = context.Request.Host.Value;
        var self = host is not null && HostPattern().IsMatch(host) ? $"{(context.Request.IsHttps ? "https" : "http")}://{host}" : null;
        var headers = context.Response.Headers;
        headers.ContentSecurityPolicy = Policy(world, self);
        headers["Permissions-Policy"] = PermissionsPolicy;
        headers.XContentTypeOptions = "nosniff";
        headers["Referrer-Policy"] = "no-referrer";
        headers["X-DNS-Prefetch-Control"] = "off";
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers.CacheControl = "no-store";
        return Results.Content(WithPrelude(page.Html), "text/html; charset=utf-8");
    }
}
