using System.Net;
using System.Security.Authentication;

namespace Iskra.Server.Hosting;

/// <summary>
/// Headers every response gets unless its handler chose its own: no MIME sniffing, no referrer, never framed by another
/// site (profile pages are framed by the app, and set their own policy), and HSTS on HTTPS for a domain name.
/// </summary>
public static class SecurityHeaders
{
    /// <summary>TLS 1.2 and 1.3 only, for every HTTPS listener.</summary>
    public const SslProtocols Protocols = SslProtocols.Tls12 | SslProtocols.Tls13;

    public const string Hsts = "max-age=31536000";

    public static void Use(WebApplication app) => app.Use((context, next) =>
    {
        context.Response.OnStarting(() =>
        {
            Apply(context);
            return Task.CompletedTask;
        });
        return next(context);
    });

    internal static void Apply(HttpContext context)
    {
        var headers = context.Response.Headers;
        if (!headers.ContainsKey("X-Content-Type-Options")) headers.XContentTypeOptions = "nosniff";
        if (!headers.ContainsKey("Referrer-Policy")) headers["Referrer-Policy"] = "no-referrer";
        if (!context.Request.Path.StartsWithSegments("/pages") && !context.Request.Path.StartsWithSegments("/activities"))
        {
            headers.XFrameOptions = "DENY";
            var csp = headers.ContentSecurityPolicy.ToString();
            if (csp.Length == 0) headers.ContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";
            else if (!csp.Contains("frame-ancestors", StringComparison.Ordinal)) headers.ContentSecurityPolicy = csp + "; frame-ancestors 'none'";
        }
        // A certificate is for a name; an IP address or localhost never gets HSTS (it would outlive a test certificate).
        if (context.Request.IsHttps && !headers.ContainsKey("Strict-Transport-Security") && IsDomainName(context.Request.Host.Host))
            headers.StrictTransportSecurity = Hsts;
    }

    internal static bool IsDomainName(string host) =>
        host.Length > 0 && !IPAddress.TryParse(host.Trim('[', ']'), out _)
        && !host.Equals("localhost", StringComparison.OrdinalIgnoreCase) && host.Contains('.');
}
