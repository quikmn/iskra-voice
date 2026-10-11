using System.Net;
using System.Security.Authentication;
using Iskra.Server.Hosting;
using Iskra.Server.Tests.Support;
using Microsoft.AspNetCore.Http;

namespace Iskra.Server.Tests;

public class SecurityHeadersTests
{
    private static string Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) ? string.Join(",", values)
        : response.Content.Headers.TryGetValues(name, out var content) ? string.Join(",", content) : "";

    [Fact]
    public async Task Every_response_refuses_sniffing_referrers_and_framing()
    {
        using var server = new IskraServer();
        using var response = await server.CreateClient().GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("nosniff", Header(response, "X-Content-Type-Options"));
        Assert.Equal("no-referrer", Header(response, "Referrer-Policy"));
        Assert.Equal("DENY", Header(response, "X-Frame-Options"));
        Assert.Equal("default-src 'none'; frame-ancestors 'none'", Header(response, "Content-Security-Policy"));
        Assert.Equal("", Header(response, "Strict-Transport-Security")); // plain HTTP

        using var missing = await server.CreateClient().GetAsync("/files/nope/x.png");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("DENY", Header(missing, "X-Frame-Options"));
    }

    [Fact]
    public async Task A_handlers_own_policy_is_kept_and_gains_frame_ancestors()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var ticket = (await alice.RequestAsync("upload.begin", new { name = "a.png", size = 8 })).Body().GetProperty("url").GetString();
        using var put = await server.CreateClient().PutAsync(ticket, new ByteArrayContent([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        var url = System.Text.Json.JsonDocument.Parse(await put.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("url").GetString();

        using var file = await server.CreateClient().GetAsync(url);
        var csp = Header(file, "Content-Security-Policy");
        Assert.StartsWith("default-src 'none'; img-src 'self'", csp);
        Assert.Contains("sandbox", csp);
        Assert.EndsWith("frame-ancestors 'none'", csp);
    }

    [Fact]
    public void Profile_pages_may_be_framed_and_hsts_is_only_for_names_over_https()
    {
        static HttpContext Context(string path, string host, bool https)
        {
            var context = new DefaultHttpContext();
            context.Request.Path = path;
            context.Request.Host = new HostString(host);
            context.Request.Scheme = https ? "https" : "http";
            return context;
        }

        var page = Context("/pages/abc", "chat.example.com", https: true);
        page.Response.Headers.ContentSecurityPolicy = "default-src 'none'";
        SecurityHeaders.Apply(page);
        Assert.False(page.Response.Headers.ContainsKey("X-Frame-Options"));
        Assert.Equal("default-src 'none'", page.Response.Headers.ContentSecurityPolicy.ToString());
        Assert.Equal(SecurityHeaders.Hsts, page.Response.Headers.StrictTransportSecurity.ToString());

        foreach (var host in new[] { "203.0.113.5", "[2001:db8::1]", "localhost", "intranet" })
        {
            var context = Context("/", host, https: true);
            SecurityHeaders.Apply(context);
            Assert.False(context.Response.Headers.ContainsKey("Strict-Transport-Security"), host);
        }
        var plain = Context("/", "chat.example.com", https: false);
        SecurityHeaders.Apply(plain);
        Assert.False(plain.Response.Headers.ContainsKey("Strict-Transport-Security"));
    }

    [Fact]
    public void Https_allows_only_tls_1_2_and_1_3()
    {
#pragma warning disable SYSLIB0039 // checking the old protocols are off
        Assert.Equal(SslProtocols.None, SecurityHeaders.Protocols & (SslProtocols.Tls | SslProtocols.Tls11));
#pragma warning restore SYSLIB0039
        Assert.Equal(SslProtocols.Tls12 | SslProtocols.Tls13, SecurityHeaders.Protocols);
    }
}
