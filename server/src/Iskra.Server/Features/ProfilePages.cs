using System.Text.RegularExpressions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Serves members' profile pages: one self-contained HTML file each, locked in a sandbox.
/// The page gets an opaque origin (no storage, no cookies, nothing of the app's), inline styles (and
/// inline scripts only if the viewer turns them on), data: images and this server's files, and can't
/// fetch, submit, frame, open windows or navigate the app. See PROTOCOL.md, "Profiles", for the full model.
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
    /// Runs before the page's own code when the viewer turned its scripts on. WebRTC isn't covered by CSP in
    /// today's browsers, so take it away, and keep the page out of child frames (a same-origin about:blank
    /// frame would have its own, untouched RTCPeerConnection). Best effort: scripts are off by default.
    /// The client's PAGE_PRELUDE is the same string.
    /// </summary>
    public const string Prelude = """<script>(()=>{const W=window,d=(o,k,v)=>{try{Object.defineProperty(o,k,{...v,configurable:false})}catch{}},no=()=>null;for(const k of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceTransport","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","WebTransport"])d(W,k,{value:undefined,writable:false});for(const C of[W.HTMLIFrameElement,W.HTMLFrameElement,W.HTMLObjectElement,W.HTMLEmbedElement])if(C){d(C.prototype,"contentWindow",{get:no});d(C.prototype,"contentDocument",{get:no});d(C.prototype,"getSVGDocument",{value:no,writable:false})}d(W,"frames",{get:no});d(W,"length",{get:()=>0});const bad=/^(?:.*:)?(?:i?frame|object|embed)$/i,D=Document.prototype,ce=D.createElement,cn=D.createElementNS,stop=()=>{throw new DOMException("Frames are off","NotSupportedError")};d(D,"createElement",{value:function(n,o){if(bad.test(String(n)))stop();return ce.call(this,n,o)},writable:false});d(D,"createElementNS",{value:function(s,n,o){if(bad.test(String(n)))stop();return cn.call(this,s,n,o)},writable:false})})()</script>""";

    /// <summary>Apps allowed to frame pages: the official web app, the desktop app, the phone app, local development, and this server's AppUrl.</summary>
    public static string FrameAncestors(World world)
    {
        var list = new List<string> { "'self'", "https://app.iskra.foo", "app://iskra", "capacitor://localhost", "http://localhost:*", "http://127.0.0.1:*" };
        if (Uri.TryCreate(world.Settings.AppUrl, UriKind.Absolute, out var app) && app.Scheme is "http" or "https")
        {
            var origin = $"{app.Scheme}://{app.IdnHost}{(app.IsDefaultPort ? "" : $":{app.Port}")}";
            if (HostPattern().IsMatch(origin[(app.Scheme.Length + 3)..]) && !list.Contains(origin)) list.Add(origin);
        }
        return string.Join(' ', list);
    }

    /// <summary>Without <paramref name="scripts"/> the page is static HTML and CSS: the sandbox has no allow-scripts.</summary>
    public static string Policy(World world, string? selfOrigin, bool scripts = false) =>
        (scripts ? "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " : "sandbox; default-src 'none'; script-src 'none'; ") +
        "style-src 'unsafe-inline'; " +
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
        // Scripts only when the viewer opted in (?scripts=1); the frame's own sandbox attribute matches.
        var scripts = context.Request.Query["scripts"] == "1";
        headers.ContentSecurityPolicy = Policy(world, self, scripts);
        headers["Permissions-Policy"] = PermissionsPolicy;
        headers.XContentTypeOptions = "nosniff";
        headers["Referrer-Policy"] = "no-referrer";
        headers["X-DNS-Prefetch-Control"] = "off";
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers.CacheControl = "no-store";
        return Results.Content(scripts ? WithPrelude(page.Html) : page.Html, "text/html; charset=utf-8");
    }
}
