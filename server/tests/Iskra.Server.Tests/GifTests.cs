using System.Net;
using System.Text.Json;
using Iskra.Server.Gifs;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class GifTests
{
    private const string Key = "test-klipy-key-123";

    private static async Task<(User Admin, User Bob)> Setup(IskraServer server)
    {
        var admin = await server.JoinAsync("Admin", "admin");
        var bob = await server.JoinAsync("Bob");
        Assert.Equal("result", (await admin.RequestAsync("gif.configure", new { key = Key, mode = "proxy" })).Type());
        return (admin, bob);
    }

    [Fact]
    public async Task Through_the_server_the_key_never_reaches_anyone()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        Assert.False((await bob.RequestAsync("gif.status")).Body().GetProperty("enabled").GetBoolean());
        Assert.Equal("unavailable", (await bob.RequestAsync("gif.trending")).ErrorCode());

        Assert.Equal("forbidden", (await bob.RequestAsync("gif.configure", new { key = Key })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("gif.configure", new { key = "has spaces and ;" })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("gif.configure", new { })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("gif.configure", new { key = Key, mode = "sideways" })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("gif.configure", new { key = Key, mode = "proxy" })).Type());
        var status = await bob.EventAsync("gif.status");
        Assert.True(status.Body().GetProperty("enabled").GetBoolean());
        Assert.Equal("proxy", status.Body().GetProperty("mode").GetString());
        Assert.Equal("klipy", status.Body().GetProperty("provider").GetString());
        Assert.DoesNotContain(Key, status.GetRawText());

        var trending = await bob.RequestAsync("gif.trending");
        Assert.DoesNotContain(Key, trending.GetRawText());
        using var carol = await server.JoinAsync("Carol");
        Assert.DoesNotContain(Key, carol.Welcome.GetRawText());

        Assert.Equal("result", (await admin.RequestAsync("gif.configure", new { key = "" })).Type());
        Assert.False((await bob.EventAsync("gif.status")).Body().GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Search_goes_through_the_server_with_one_customer_id_and_is_cached()
    {
        using var server = new IskraServer();
        var (admin, bob) = await Setup(server);
        using (admin)
        using (bob)
        {
            var result = (await bob.RequestAsync("gif.search", new { q = "cats" })).Body();
            Assert.Equal(2, result.GetProperty("gifs").GetArrayLength());
            Assert.True(result.GetProperty("hasNext").GetBoolean());
            var gif = result.GetProperty("gifs")[0];
            Assert.StartsWith("/gifs/media?u=", gif.GetProperty("url").GetString());
            Assert.StartsWith("/gifs/media?u=", gif.GetProperty("preview").GetString());
            Assert.DoesNotContain("klipy.com", gif.GetProperty("url").GetString());

            await admin.RequestAsync("gif.search", new { q = "CATS" }); // the same search: from the cache
            Assert.Single(server.Gifs.Requests);
            await admin.RequestAsync("gif.search", new { q = "dogs" });
            var uris = server.Gifs.Requests.ToArray();
            Assert.All(uris, u => Assert.Equal("api.klipy.com", u.Host));
            Assert.All(uris, u => Assert.StartsWith($"/api/v1/{Key}/gifs/search", u.AbsolutePath));
            var customers = uris.Select(u => System.Web.HttpUtility.ParseQueryString(u.Query)["customer_id"]).Distinct().ToList();
            Assert.Single(customers); // one id for the whole server, not per member
            Assert.DoesNotContain(bob.Key, string.Join(" ", uris.Select(u => u.ToString())));
            Assert.DoesNotContain(admin.Key, string.Join(" ", uris.Select(u => u.ToString())));

            Assert.Equal("bad_request", (await bob.RequestAsync("gif.search", new { q = "" })).ErrorCode());
            Assert.Equal("bad_request", (await bob.RequestAsync("gif.search", new { q = "x", page = 0 })).ErrorCode());
        }
    }

    [Fact]
    public async Task Ads_and_media_from_other_hosts_are_left_out()
    {
        using var server = new IskraServer();
        server.Gifs.Json = uri => uri.AbsolutePath.EndsWith("/categories") ? FakeGifUpstream.Categories : FakeGifUpstream.Page("ok", 1, false,
            FakeGifUpstream.Item("ad", type: "ad"), FakeGifUpstream.Item("evil", host: "evil.example"), FakeGifUpstream.Item("local", host: "127.0.0.1"));
        var (admin, bob) = await Setup(server);
        using (admin)
        using (bob)
        {
            var gifs = (await bob.RequestAsync("gif.trending")).Body().GetProperty("gifs");
            Assert.Equal(1, gifs.GetArrayLength());
            Assert.Equal("ok-1", gifs[0].GetProperty("id").GetString());

            var categories = (await bob.RequestAsync("gif.categories")).Body().GetProperty("categories");
            Assert.Equal(2, categories.GetArrayLength());
            Assert.StartsWith("/gifs/media?", categories[0].GetProperty("preview").GetString());
            Assert.Equal(JsonValueKind.Null, categories[1].GetProperty("preview").ValueKind);

            server.Gifs.Json = _ => null;
            Assert.Equal("unavailable", (await bob.RequestAsync("gif.search", new { q = "down" })).ErrorCode());
            server.Gifs.Json = _ => "<html>not json";
            Assert.Equal("unavailable", (await bob.RequestAsync("gif.search", new { q = "junk" })).ErrorCode());
        }
    }

    [Fact]
    public async Task A_gif_message_is_shown_through_the_proxy()
    {
        using var server = new IskraServer();
        var (admin, bob) = await Setup(server);
        using (admin)
        using (bob)
        {
            var token = (await bob.RequestAsync("gif.trending")).Body().GetProperty("gifs")[0].GetProperty("token").GetString()!;
            var sent = await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", gif = token });
            Assert.Equal("result", sent.Type());
            var gif = sent.Body().GetProperty("message").GetProperty("gif");
            Assert.Equal("cat-1", gif.GetProperty("id").GetString());
            Assert.Equal(220, gif.GetProperty("width").GetInt32());
            var url = gif.GetProperty("url").GetString()!;

            var http = server.CreateClient();
            using (var response = await http.GetAsync(url))
            {
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.Equal("image/gif", response.Content.Headers.ContentType?.MediaType);
                Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
                Assert.Equal("GIF89a-fake", await response.Content.ReadAsStringAsync());
            }
            Assert.Equal("https://static.klipy.com/ii/cat-1/md.webp", server.Gifs.MediaRequests.Single().ToString());

            // Tampering: a forged token, other text with it, or a link to anything else.
            var forged = token[..^3] + (token.EndsWith("AAA") ? "BBB" : "AAA");
            Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", gif = forged })).ErrorCode());
            Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "hi", gif = token })).ErrorCode());
            var id = sent.Body().GetProperty("message").GetProperty("id").GetInt64();
            Assert.Equal("bad_request", (await bob.RequestAsync("chat.edit", new { id, text = "x" })).ErrorCode());

            var other = Iskra.Server.Crypto.Ed25519.ToB64u("https://static.klipy.com/ii/other.gif"u8.ToArray());
            var sig = System.Web.HttpUtility.ParseQueryString(url[(url.IndexOf('?') + 1)..])["s"];
            Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync($"/gifs/media?u={other}&s={sig}")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync("/gifs/media")).StatusCode);

            // Only images come back, and not too big.
            server.Gifs.Media = _ => ("text/html", "<script>"u8.ToArray(), null);
            Assert.Equal(HttpStatusCode.BadGateway, (await http.GetAsync(url)).StatusCode);
            server.Gifs.Media = _ => ("image/gif", "GIF89a"u8.ToArray(), 100L * 1024 * 1024);
            Assert.Equal(HttpStatusCode.BadGateway, (await http.GetAsync(url)).StatusCode);
        }
    }

    [Fact]
    public async Task Direct_mode_is_the_default_and_apps_talk_to_klipy_themselves()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        Assert.Equal("result", (await admin.RequestAsync("gif.configure", new { key = Key })).Type());
        var status = (await bob.EventAsync("gif.status")).Body();
        Assert.Equal("direct", status.GetProperty("mode").GetString());
        Assert.Equal(Key, status.GetProperty("key").GetString()); // apps need it to call KLIPY
        var bobId = status.GetProperty("customerId").GetString()!;
        var adminId = (await admin.RequestAsync("gif.status")).Body().GetProperty("customerId").GetString()!;
        Assert.NotEqual(bobId, adminId);
        Assert.DoesNotContain(bob.Key[..10], bobId);

        // The server's search and media proxy stay off.
        Assert.Equal("unavailable", (await bob.RequestAsync("gif.trending")).ErrorCode());
        Assert.Empty(server.Gifs.Requests);

        // Apps send what KLIPY gave them, but only KLIPY's media addresses.
        object Gif(string url) => new { id = "cat-9", title = "A cat", url, preview = url, width = 200, height = 150 };
        var sent = await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", gif = Gif("https://static.klipy.com/ii/cat-9/md.gif") });
        Assert.Equal("result", sent.Type());
        var gif = sent.Body().GetProperty("message").GetProperty("gif");
        Assert.True(gif.GetProperty("direct").GetBoolean());
        Assert.Equal("https://static.klipy.com/ii/cat-9/md.gif", gif.GetProperty("url").GetString());
        foreach (var bad in new[] { "https://evil.example/x.gif", "http://static.klipy.com/x.gif", "https://static.klipy.com.evil.example/x.gif", "https://127.0.0.1/x.gif" })
            Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", gif = Gif(bad) })).ErrorCode());
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync("/gifs/media?u=x&s=y")).StatusCode);

        // Switching to the proxy shows the same message through the server.
        await admin.RequestAsync("gif.configure", new { mode = "proxy" });
        var proxied = (await bob.EventAsync("gif.status")).Body();
        Assert.Equal(JsonValueKind.Null, proxied.GetProperty("key").ValueKind);
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        var shown = history.EnumerateArray().Last().GetProperty("gif");
        Assert.False(shown.GetProperty("direct").GetBoolean());
        Assert.StartsWith("/gifs/media?u=", shown.GetProperty("url").GetString());
        // …and in proxy mode an app can't post an address of its own.
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", gif = Gif("https://static.klipy.com/ii/x/md.gif") })).ErrorCode());
    }

    [Theory]
    [InlineData("https://static.klipy.com/ii/a.gif", true)]
    [InlineData("https://static2.klipy.com/ii/a.gif", true)]
    [InlineData("http://static.klipy.com/ii/a.gif", false)]
    [InlineData("https://static.klipy.com:8443/ii/a.gif", false)]
    [InlineData("https://user:pw@static.klipy.com/ii/a.gif", false)]
    [InlineData("https://static.klipy.com.evil.example/a.gif", false)]
    [InlineData("https://evil.example/static.klipy.com/a.gif", false)]
    [InlineData("https://169.254.169.254/latest/meta-data", false)]
    [InlineData("file:///etc/passwd", false)]
    public void Only_the_providers_media_hosts_are_proxied(string url, bool ok) => Assert.Equal(ok, GifService.IsMediaUrl(url));
}
