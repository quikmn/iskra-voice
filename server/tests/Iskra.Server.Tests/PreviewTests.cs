using System.Net;
using System.Text;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class PreviewTests
{
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.1.2.3")]
    [InlineData("172.20.0.1")]
    [InlineData("192.168.1.1")]
    [InlineData("169.254.169.254")] // cloud metadata
    [InlineData("100.64.0.1")]      // CGNAT
    [InlineData("0.0.0.0")]
    [InlineData("::1")]
    [InlineData("fc00::1")]
    [InlineData("fe80::1")]
    [InlineData("::ffff:127.0.0.1")]
    public void Private_addresses_are_never_fetched(string ip) => Assert.False(LinkPreviews.IsPublic(IPAddress.Parse(ip)));

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("2001:4860:4860::8888")]
    public void Public_addresses_are_allowed(string ip) => Assert.True(LinkPreviews.IsPublic(IPAddress.Parse(ip)));

    [Fact]
    public void Open_graph_tags_are_read()
    {
        var html = """
            <html><head><title>Fallback</title>
            <meta property="og:site_name" content="Iskra">
            <meta content="Voice &amp; text, yours" property="og:description">
            <meta property="og:title" content="Iskra 2">
            </head></html>
            """;
        var preview = LinkPreviews.Parse("https://iskra.foo", html)!;
        Assert.Equal("Iskra 2", preview.Title);
        Assert.Equal("Voice & text, yours", preview.Description);
        Assert.Equal("Iskra", preview.SiteName);

        Assert.Equal("Just a title", LinkPreviews.Parse("https://x", "<title>Just a title</title>")!.Title);
        Assert.Null(LinkPreviews.Parse("https://x", "<p>nothing useful</p>"));
    }

    /// <summary>A tiny local web server for one test.</summary>
    private sealed class Site : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }

        public Site(Func<HttpListenerContext, Task> handle)
        {
            var port = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            port.Start();
            var number = ((IPEndPoint)port.LocalEndpoint).Port;
            port.Stop();
            Url = $"http://127.0.0.1:{number}/";
            _listener.Prefixes.Add(Url);
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (_listener.IsListening)
                {
                    try { await handle(await _listener.GetContextAsync()); } catch (Exception) { }
                }
            });
        }

        public void Dispose() => _listener.Close();
    }

    private static Task Page(HttpListenerContext c, string html)
    {
        c.Response.ContentType = "text/html; charset=utf-8";
        var bytes = Encoding.UTF8.GetBytes(html);
        c.Response.OutputStream.Write(bytes);
        c.Response.Close();
        return Task.CompletedTask;
    }

    [Fact]
    public async Task Previews_work_end_to_end_but_loopback_is_blocked_by_default()
    {
        using var site = new Site(c => Page(c, """<meta property="og:title" content="Local page">"""));

        using (var server = new IskraServer())
        using (var alice = await server.JoinAsync("Alice"))
        {
            var blocked = await alice.RequestAsync("link.preview", new { url = site.Url });
            Assert.Equal(JsonValueKindNull, blocked.Body().GetProperty("preview").ValueKind);
        }

        using (var server = new IskraServer { AllowLoopbackPreviews = true })
        using (var alice = await server.JoinAsync("Alice"))
        {
            var preview = (await alice.RequestAsync("link.preview", new { url = site.Url })).Body().GetProperty("preview");
            Assert.Equal("Local page", preview.GetProperty("title").GetString());
        }
    }

    [Fact]
    public async Task Redirects_to_private_addresses_are_blocked()
    {
        using var site = new Site(c =>
        {
            c.Response.Redirect("http://169.254.169.254/latest/meta-data/");
            c.Response.Close();
            return Task.CompletedTask;
        });
        using var server = new IskraServer { AllowLoopbackPreviews = true };
        using var alice = await server.JoinAsync("Alice");
        var result = await alice.RequestAsync("link.preview", new { url = site.Url });
        Assert.Equal(JsonValueKindNull, result.Body().GetProperty("preview").ValueKind);
    }

    [Fact]
    public async Task Only_http_urls_are_previewed()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        foreach (var url in new[] { "file:///etc/passwd", "ftp://example.com", "http://user:pw@example.com" })
            Assert.Equal(JsonValueKindNull, (await alice.RequestAsync("link.preview", new { url })).Body().GetProperty("preview").ValueKind);
    }

    private const System.Text.Json.JsonValueKind JsonValueKindNull = System.Text.Json.JsonValueKind.Null;
}
