using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>The Feeds bot: RSS/Atom, YouTube and Twitch posts, what it may fetch, dedupe, backoff, mentions and permissions.</summary>
public class FeedTests
{
    // ── A local site that plays the feed (and YouTube, and Twitch) ───────────

    private sealed record Hit(string Method, string Path, string? IfNoneMatch, string? IfModifiedSince, string? Authorization);

    private sealed class Site : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public ConcurrentQueue<Hit> Hits { get; } = new();
        public Func<HttpListenerContext, Task> Handle { get; set; } = c => Reply(c, 404, "text/plain", "nothing");

        public Site()
        {
            var port = new TcpListener(IPAddress.Loopback, 0);
            port.Start();
            var number = ((IPEndPoint)port.LocalEndpoint).Port;
            port.Stop();
            Url = $"http://127.0.0.1:{number}";
            _listener.Prefixes.Add(Url + "/");
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (_listener.IsListening)
                {
                    try
                    {
                        var c = await _listener.GetContextAsync();
                        Hits.Enqueue(new Hit(c.Request.HttpMethod, c.Request.Url!.PathAndQuery, c.Request.Headers["If-None-Match"],
                            c.Request.Headers["If-Modified-Since"], c.Request.Headers["Authorization"]));
                        await Handle(c);
                    }
                    catch (Exception) { }
                }
            });
        }

        public void Dispose() => _listener.Close();
    }

    private static Task Reply(HttpListenerContext c, int status, string type, string body, params (string Name, string Value)[] headers)
    {
        c.Response.StatusCode = status;
        c.Response.ContentType = type;
        foreach (var (name, value) in headers) c.Response.Headers[name] = value;
        var bytes = Encoding.UTF8.GetBytes(body);
        if (status != 304) c.Response.OutputStream.Write(bytes);
        c.Response.Close();
        return Task.CompletedTask;
    }

    private static string Rss(string title, params (string Id, string Title)[] items) => $"""
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>{title}</title><link>https://blog.example/</link>
        {string.Concat(items.Select(i => $"<item><title>{WebUtility.HtmlEncode(i.Title)}</title><link>https://blog.example/{i.Id}</link><guid>{i.Id}</guid></item>"))}
        </channel></rss>
        """;

    private static string YouTube(string channelId, string name, params (string Id, string Title)[] videos)
    {
        var entries = new StringBuilder();
        for (var i = 0; i < videos.Length; i++)
        {
            var (id, title) = videos[i];
            var day = (10 + videos.Length - i).ToString("00");
            entries.Append($"<entry><id>yt:video:{id}</id><yt:videoId>{id}</yt:videoId><yt:channelId>{channelId}</yt:channelId>")
                .Append($"<title>{title}</title><link rel=\"alternate\" href=\"https://www.youtube.com/watch?v={id}\"/>")
                .Append($"<author><name>{name}</name></author><published>2026-10-{day}T10:00:00+00:00</published>")
                .Append($"<media:group><media:thumbnail url=\"https://i1.ytimg.com/vi/{id}/hqdefault.jpg\" width=\"480\" height=\"360\"/></media:group></entry>");
        }
        return $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
              <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id={channelId}"/>
              <id>yt:channel:{channelId[2..]}</id><yt:channelId>{channelId[2..]}</yt:channelId>
              <title>{name}</title>
              <link rel="alternate" href="https://www.youtube.com/channel/{channelId}"/>
              <author><name>{name}</name><uri>https://www.youtube.com/channel/{channelId}</uri></author>
              {entries}
            </feed>
            """;
    }

    // ── Server helpers ───────────────────────────────────────────────────────

    private static IskraServer Server(Site? site = null, bool loopback = true)
    {
        var settings = new Dictionary<string, string> { ["Feeds:TickMs"] = "0", ["Feeds:AllowLoopbackForTests"] = loopback.ToString() };
        if (site is not null)
        {
            settings["Feeds:YouTubeUrl"] = site.Url;
            settings["Feeds:TwitchAuthUrl"] = site.Url;
            settings["Feeds:TwitchApiUrl"] = site.Url;
        }
        return new IskraServer { Settings = settings };
    }

    private static FeedService Feeds(IskraServer server) => server.Services.GetRequiredService<FeedService>();

    private static async Task<string> TurnOn(User admin, bool on = true)
    {
        var reply = await admin.RequestAsync("builtin.bots.set", new { bot = "feeds", enabled = on });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("bots").EnumerateArray().Single(b => b.GetProperty("id").GetString() == "feeds").GetProperty("accountKey").GetString()!;
    }

    private static string? ErrorKey(JsonElement reply) =>
        reply.GetProperty("body").TryGetProperty("key", out var key) ? key.GetString() : null;

    private static async Task<JsonElement> Add(User admin, object body)
    {
        var reply = await admin.RequestAsync("feeds.add", body);
        Assert.True(reply.Type() == "result", reply.GetRawText());
        return reply.Body().GetProperty("subscription");
    }

    private static List<Message> Posts(IskraServer server, long channelId, string bot) =>
        server.World.Store.History(channelId, null, null, 100).Where(m => m.AuthorKey == bot).OrderBy(m => m.Id).ToList();

    private static JsonElement Builtin(IskraServer server, Message m) => JsonDocument.Parse(server.World.Store.GetBuiltinReply(m.Id)!).RootElement.Clone();

    /// <summary>Makes a subscription due now (as if its interval had passed).</summary>
    private static void Due(IskraServer server, long id)
    {
        var f = server.World.Store.GetFeedSubscription(id)!;
        server.World.Store.FeedChecked(id, f.LastCheckAt ?? 0, 0, f.LastError is null, f.LastError, f.Failures, null, null);
    }

    // ── Permissions and opt-in ───────────────────────────────────────────────

    [Fact]
    public async Task Only_admins_manage_feeds_and_nothing_is_fetched_while_the_bot_is_off()
    {
        using var site = new Site();
        var items = new List<(string, string)> { ("a", "First") };
        site.Handle = c => Reply(c, 200, "application/rss+xml", Rss("Blog", [.. items]));
        using var server = Server(site);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        Assert.Equal("feeds_admin", ErrorKey(await alice.RequestAsync("feeds.get")));
        Assert.Equal("feeds_off", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/feed", channelId = server.General })));
        Assert.Empty(site.Hits); // off: not even the check when adding

        var bot = await TurnOn(admin);
        Assert.Equal("feeds_admin", ErrorKey(await alice.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/feed", channelId = server.General })));
        var sub = await Add(admin, new { kind = "rss", source = site.Url + "/feed", channelId = server.General });
        Assert.Equal("Blog", sub.GetProperty("name").GetString());
        Assert.Equal(15, sub.GetProperty("intervalMinutes").GetInt32());
        var id = sub.GetProperty("id").GetInt64();
        Assert.Equal("feeds_admin", ErrorKey(await alice.RequestAsync("feeds.remove", new { id })));
        Assert.Equal("feeds_admin", ErrorKey(await alice.RequestAsync("feeds.check", new { id })));
        Assert.Equal("feeds_admin", ErrorKey(await alice.RequestAsync("feeds.update", new { id, paused = true })));
        var list = (await admin.RequestAsync("feeds.get")).Body();
        Assert.Single(list.GetProperty("subscriptions").EnumerateArray());
        Assert.False(list.GetProperty("twitch").GetProperty("configured").GetBoolean());
        Assert.Equal(25, list.GetProperty("max").GetInt32());

        // Off: due or not, nothing is fetched; the subscription stays.
        await TurnOn(admin, false);
        Due(server, id);
        var before = site.Hits.Count;
        await Feeds(server).TickAsync();
        Assert.Equal(before, site.Hits.Count);
        Assert.Equal("feeds_off", ErrorKey(await admin.RequestAsync("feeds.check", new { id })));
        Assert.Single((await admin.RequestAsync("feeds.get")).Body().GetProperty("subscriptions").EnumerateArray());

        // On again: due ones are checked; a new item is posted by the same bot member.
        Assert.Equal(bot, await TurnOn(admin));
        items.Insert(0, ("b", "Second"));
        await Feeds(server).TickAsync();
        Assert.Equal(before + 1, site.Hits.Count);
        var post = Assert.Single(Posts(server, server.General, bot));
        Assert.Equal("feed.item", Builtin(server, post).GetProperty("kind").GetString());

        var audit = (await admin.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray()
            .Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("feed.add", audit);
    }

    // ── RSS, Atom, YouTube ───────────────────────────────────────────────────

    [Fact]
    public async Task Old_items_are_never_posted_and_new_ones_once_oldest_first()
    {
        using var site = new Site();
        var items = new List<(string, string)> { ("2", "Old two"), ("1", "Old one") };
        site.Handle = c => Reply(c, 200, "application/rss+xml; charset=utf-8", Rss("My blog", [.. items]));
        using var server = Server(site);
        using var admin = await server.JoinAsync("Admin", "admin");
        var bot = await TurnOn(admin);
        var id = (await Add(admin, new { kind = "rss", source = site.Url + "/feed.xml", channelId = server.General })).GetProperty("id").GetInt64();
        Assert.Equal(2, server.World.Store.CountFeedSeen(id));

        await Feeds(server).CheckAsync(id, manual: false);
        Assert.Empty(Posts(server, server.General, bot)); // first add: what was there is seen

        // A title that tries markdown, a mention and @everyone: shown as text, pings nobody.
        items.Insert(0, ("3", "New *star* <@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA> @everyone"));
        await Feeds(server).CheckAsync(id, manual: false);
        var post = Assert.Single(Posts(server, server.General, bot));
        Assert.Contains(@"\*star\*", post.Text);
        Assert.Contains(@"\<@AAAA", post.Text); // escaped: no mention token
        Assert.Contains("@‍everyone", post.Text);
        Assert.Contains("https://blog.example/3", post.Text);
        var builtin = Builtin(server, post);
        Assert.Equal("feeds", builtin.GetProperty("bot").GetString());
        Assert.Equal("rss", builtin.GetProperty("source").GetString());
        Assert.Equal("My blog", builtin.GetProperty("name").GetString());
        Assert.StartsWith("New *star*", builtin.GetProperty("title").GetString());
        Assert.Equal("https://blog.example/3", builtin.GetProperty("url").GetString());
        Assert.Equal(JsonValueKind.Null, builtin.GetProperty("text").ValueKind);

        await Feeds(server).CheckAsync(id, manual: false);
        Assert.Single(Posts(server, server.General, bot)); // never twice

        // Seven at once: the newest five, oldest first.
        for (var i = 4; i <= 10; i++) items.Insert(0, (i.ToString(), $"Post {i}"));
        await Feeds(server).CheckAsync(id, manual: false);
        var titles = Posts(server, server.General, bot).Skip(1).Select(m => Builtin(server, m).GetProperty("title").GetString()).ToList();
        Assert.Equal(["Post 6", "Post 7", "Post 8", "Post 9", "Post 10"], titles);
        await Feeds(server).CheckAsync(id, manual: false);
        Assert.Equal(6, Posts(server, server.General, bot).Count);

        // A template, and a paused feed posts nothing (what came meanwhile is seen).
        await admin.RequestAsync("feeds.update", new { id, template = "New on {name}: {title} → {url}" });
        items.Insert(0, ("11", "Templated"));
        await Feeds(server).CheckAsync(id, manual: false);
        var templated = Posts(server, server.General, bot).Last();
        Assert.Equal("New on My blog: Templated → https://blog.example/11", templated.Text);
        Assert.Equal(templated.Text, Builtin(server, templated).GetProperty("text").GetString());
        await admin.RequestAsync("feeds.update", new { id, paused = true });
        items.Insert(0, ("12", "While paused"));
        await Feeds(server).CheckAsync(id, manual: false);
        Assert.Equal(7, Posts(server, server.General, bot).Count);
    }

    [Fact]
    public async Task YouTube_channels_are_found_by_handle_and_new_videos_posted()
    {
        const string channel = "UCabcdefghijklmnopqrstuv";
        using var site = new Site();
        var videos = new List<(string, string)> { ("vid00000001", "Older video") };
        site.Handle = c => c.Request.Url!.AbsolutePath switch
        {
            "/@cooking" => Reply(c, 200, "text/html", $"""<html><head><link rel="canonical" href="https://www.youtube.com/channel/{channel}"></head></html>"""),
            "/@nobody" => Reply(c, 200, "text/html", "<html><head><title>Not here</title></head></html>"),
            "/feeds/videos.xml" when c.Request.QueryString["channel_id"] == channel => Reply(c, 200, "application/atom+xml", YouTube(channel, "Cooking Time", [.. videos])),
            _ => Reply(c, 404, "text/html", "no"),
        };
        using var server = Server(site);
        using var admin = await server.JoinAsync("Admin", "admin");
        var bot = await TurnOn(admin);

        Assert.Equal("feeds_youtube_channel", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "youtube", source = "@nobody", channelId = server.General })));
        Assert.Equal("feeds_youtube_channel", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "youtube", source = "UCzzzzzzzzzzzzzzzzzzzzzz", channelId = server.General })));
        Assert.Equal("feeds_youtube_channel", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "youtube", source = "https://example.com/@cooking", channelId = server.General })));
        Assert.Equal("bad_request", (await admin.RequestAsync("feeds.add", new { kind = "youtube", source = "x", channelId = server.General, intervalMinutes = 4 })).ErrorCode());

        var sub = await Add(admin, new { kind = "youtube", source = "@cooking", channelId = server.General });
        Assert.Equal(channel, sub.GetProperty("source").GetString());
        Assert.Equal("Cooking Time", sub.GetProperty("name").GetString());
        Assert.Equal($"https://www.youtube.com/channel/{channel}", sub.GetProperty("url").GetString());
        // The same channel by id (or its address) in the same channel is a duplicate.
        Assert.Equal("feeds_duplicate", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "youtube", source = $"https://www.youtube.com/channel/{channel}", channelId = server.General })));

        videos.Insert(0, ("vid00000002", "Pancakes"));
        await Feeds(server).CheckAsync(sub.GetProperty("id").GetInt64(), manual: false);
        var post = Assert.Single(Posts(server, server.General, bot));
        Assert.Equal("▶️ Cooking Time posted a new video: **Pancakes**\nhttps://www.youtube.com/watch?v=vid00000002", post.Text);
        Assert.Equal("youtube", Builtin(server, post).GetProperty("source").GetString());
        // Only the feed: never a thumbnail.
        Assert.DoesNotContain(site.Hits, h => h.Path.Contains("ytimg") || h.Path.Contains(".jpg"));
    }

    [Fact]
    public async Task A_web_page_that_names_its_feed_and_Atom_feeds_work()
    {
        using var site = new Site();
        site.Handle = c => c.Request.Url!.AbsolutePath switch
        {
            "/blog" => Reply(c, 200, "text/html; charset=utf-8", """<html><head><link rel="alternate" type="application/atom+xml" title="Atom" href="/atom.xml"></head></html>"""),
            "/atom.xml" => Reply(c, 200, "application/atom+xml", """
                <?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom site</title>
                <entry><id>tag:x,1</id><title>Hello</title><link href="https://atom.example/1"/><updated>2026-01-01T00:00:00Z</updated></entry></feed>
                """),
            "/page" => Reply(c, 200, "text/html", "<html><body>just a page</body></html>"),
            _ => Reply(c, 404, "text/plain", ""),
        };
        using var server = Server(site);
        using var admin = await server.JoinAsync("Admin", "admin");
        await TurnOn(admin);
        var sub = await Add(admin, new { kind = "rss", source = site.Url + "/blog", channelId = server.General });
        Assert.Equal(site.Url + "/atom.xml", sub.GetProperty("source").GetString());
        Assert.Equal("Atom site", sub.GetProperty("name").GetString());
        Assert.Equal("feeds_not_feed", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/page", channelId = server.General })));
        Assert.Equal("feeds_unreachable", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/gone", channelId = server.General })));
        Assert.Equal("feeds_url", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = "file:///etc/passwd", channelId = server.General })));
        Assert.Equal("feeds_url", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = "ftp://example.com/feed", channelId = server.General })));
        Assert.Equal("feeds_url", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = "https://user:pw@example.com/feed", channelId = server.General })));
    }

    // ── Conditional requests and backoff ─────────────────────────────────────

    [Fact]
    public async Task Unchanged_feeds_answer_304_and_failures_back_off()
    {
        using var site = new Site();
        var status = 200;
        string? retryAfter = null;
        site.Handle = c =>
        {
            if (status != 200) return retryAfter is null ? Reply(c, status, "text/plain", "busy") : Reply(c, status, "text/plain", "busy", ("Retry-After", retryAfter));
            if (c.Request.Headers["If-None-Match"] == "\"v1\"") return Reply(c, 304, "application/rss+xml", "");
            return Reply(c, 200, "application/rss+xml", Rss("Blog", ("a", "A")), ("ETag", "\"v1\""), ("Last-Modified", "Thu, 01 Oct 2026 10:00:00 GMT"));
        };
        using var server = Server(site);
        using var admin = await server.JoinAsync("Admin", "admin");
        await TurnOn(admin);
        var id = (await Add(admin, new { kind = "rss", source = site.Url + "/feed", channelId = server.General })).GetProperty("id").GetInt64();
        var store = server.World.Store;
        Assert.Equal("\"v1\"", store.GetFeedSubscription(id)!.ETag);

        await Feeds(server).CheckAsync(id, manual: false);
        var hit = site.Hits.Last();
        Assert.Equal("\"v1\"", hit.IfNoneMatch);
        Assert.Equal("Thu, 01 Oct 2026 10:00:00 GMT", hit.IfModifiedSince);
        var f = store.GetFeedSubscription(id)!;
        Assert.Null(f.LastError);
        Assert.InRange(f.NextAt - f.LastCheckAt!.Value, 15 * 60_000, 15 * 60_000 + 90_000); // the interval plus up to 10%

        // Failures double the wait: 30 minutes, then 60.
        status = 500;
        await Feeds(server).CheckAsync(id, manual: false);
        f = store.GetFeedSubscription(id)!;
        Assert.Equal(("http", 1), (f.LastError, f.Failures));
        Assert.Equal(30 * 60_000, f.NextAt - f.LastCheckAt!.Value);
        await Feeds(server).CheckAsync(id, manual: false);
        f = store.GetFeedSubscription(id)!;
        Assert.Equal(60 * 60_000, f.NextAt - f.LastCheckAt!.Value);
        // Retry-After is respected (up to 6 hours).
        status = 429;
        retryAfter = "10000";
        await Feeds(server).CheckAsync(id, manual: false);
        f = store.GetFeedSubscription(id)!;
        Assert.Equal(("rate_limited", 3), (f.LastError, f.Failures));
        Assert.Equal(10_000_000, f.NextAt - f.LastCheckAt!.Value);
        retryAfter = "999999";
        await Feeds(server).CheckAsync(id, manual: false);
        f = store.GetFeedSubscription(id)!;
        Assert.Equal(FeedService.MaxBackoffMs, f.NextAt - f.LastCheckAt!.Value);
        // Not due yet: the tick leaves it alone.
        var hits = site.Hits.Count;
        await Feeds(server).TickAsync();
        Assert.Equal(hits, site.Hits.Count);

        // Working again: back to the interval, and the error is gone.
        status = 200;
        retryAfter = null;
        await Feeds(server).CheckAsync(id, manual: false);
        f = store.GetFeedSubscription(id)!;
        Assert.Equal((null, 0), (f.LastError, f.Failures));
        var view = (await admin.RequestAsync("feeds.get")).Body().GetProperty("subscriptions")[0];
        Assert.Equal(JsonValueKind.Null, view.GetProperty("lastError").ValueKind);
        Assert.Equal(0, view.GetProperty("failures").GetInt32());
    }

    // ── What the server may reach ────────────────────────────────────────────

    [Fact]
    public async Task Private_and_loopback_addresses_and_redirects_to_them_are_refused()
    {
        using var site = new Site();
        site.Handle = c => c.Request.Url!.AbsolutePath switch
        {
            "/go" => Reply(c, 302, "text/plain", "", ("Location", "http://192.168.0.10/feed.xml")),
            "/meta" => Reply(c, 302, "text/plain", "", ("Location", "http://169.254.169.254/latest/meta-data/")),
            _ => Reply(c, 200, "application/rss+xml", Rss("Local", ("a", "A"))),
        };
        // A server that may not reach loopback (any real server that isn't LocalOnly).
        using (var server = Server(loopback: false))
        using (var admin = await server.JoinAsync("Admin", "admin"))
        {
            await TurnOn(admin);
            foreach (var url in new[] { site.Url + "/feed", "http://10.1.2.3/feed", "http://169.254.169.254/latest/meta-data/", "http://[::1]/feed", "http://[fd00::1]/feed", "http://0.0.0.0/feed" })
                Assert.Equal("feeds_address", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = url, channelId = server.General })));
            Assert.Empty(site.Hits);
        }
        // Loopback allowed (tests): a redirect to a private or metadata address is still refused, on the new connection.
        using (var server = Server())
        using (var admin = await server.JoinAsync("Admin", "admin"))
        {
            await TurnOn(admin);
            Assert.Equal("feeds_address", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/go", channelId = server.General })));
            Assert.Equal("feeds_address", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/meta", channelId = server.General })));
        }
    }

    [Fact]
    public void Only_public_addresses_or_on_a_LocalOnly_server_only_loopback()
    {
        static bool May(string ip, bool localOnly, bool loopback = false) => FeedFetcher.MayConnect(IPAddress.Parse(ip), localOnly, loopback);
        Assert.True(May("8.8.8.8", localOnly: false));
        Assert.True(May("2606:4700:4700::1111", localOnly: false));
        foreach (var ip in new[] { "127.0.0.1", "::1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::ffff:10.0.0.1", "64:ff9b::a00:1", "fd00::1", "fe80::1" })
            Assert.False(May(ip, localOnly: false), ip);
        Assert.True(May("127.0.0.1", localOnly: false, loopback: true));
        Assert.False(May("10.0.0.1", localOnly: false, loopback: true));
        // A LocalOnly server: loopback only, never the internet.
        Assert.True(May("127.0.0.1", localOnly: true));
        Assert.True(May("::1", localOnly: true));
        Assert.False(May("8.8.8.8", localOnly: true));
        Assert.False(May("192.168.1.1", localOnly: true));
    }

    [Fact]
    public async Task The_address_checked_is_the_one_connected_to_so_DNS_rebinding_cannot_reach_a_private_one()
    {
        // A raw local HTTP server (any Host header is fine).
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        _ = Task.Run(async () =>
        {
            while (true)
            {
                TcpClient client;
                try { client = await listener.AcceptTcpClientAsync(); } catch (Exception) { return; }
                using (client)
                {
                    var stream = client.GetStream();
                    var buffer = new byte[4096];
                    _ = await stream.ReadAsync(buffer);
                    var body = Rss("Rebound", ("a", "A"));
                    var bytes = Encoding.UTF8.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\nConnection: close\r\n\r\n{body}");
                    await stream.WriteAsync(bytes);
                }
            }
        });
        var lookups = new ConcurrentQueue<string>();
        var answers = 0;
        Task<IPAddress[]> Resolve(string host, CancellationToken _)
        {
            lookups.Enqueue(host);
            return Task.FromResult(host switch
            {
                // Public the first time, private after: the first answer is what's checked and used, every time.
                "rebind.test" => Interlocked.Increment(ref answers) == 1 ? [IPAddress.Parse("10.0.0.7")] : [IPAddress.Parse("10.0.0.8")],
                "mixed.test" => [IPAddress.Parse("10.0.0.7"), IPAddress.Loopback],
                _ => Array.Empty<IPAddress>(),
            });
        }
        using var fetcher = new FeedFetcher(localOnly: false, allowLoopback: true, Resolve, TimeProvider.System);
        var blocked = await Assert.ThrowsAsync<FeedException>(() => fetcher.GetAsync(new Uri($"http://rebind.test:{port}/feed"), null, null, CancellationToken.None));
        Assert.Equal("blocked", blocked.Code);
        // Only allowed addresses are tried: the private one is skipped.
        var ok = await fetcher.GetAsync(new Uri($"http://mixed.test:{port}/feed"), null, null, CancellationToken.None);
        Assert.Equal("Rebound", FeedFetcher.Parse(ok.Body)!.Title);
        Assert.Equal(["rebind.test", "mixed.test"], lookups);
        listener.Stop();
    }

    // ── Safe XML ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task External_entities_and_DTDs_are_never_read()
    {
        var secret = Path.Combine(Path.GetTempPath(), "iskra-feed-secret-" + Guid.NewGuid().ToString("N") + ".txt");
        File.WriteAllText(secret, "TOPSECRET");
        try
        {
            var xxe = $"""
                <?xml version="1.0"?>
                <!DOCTYPE rss [ <!ENTITY xxe SYSTEM "{new Uri(secret).AbsoluteUri}"> ]>
                <rss version="2.0"><channel><title>Evil</title><item><title>&xxe;</title><guid>1</guid></item></channel></rss>
                """;
            var parsed = FeedFetcher.Parse(Encoding.UTF8.GetBytes(xxe));
            Assert.True(parsed is null || parsed.Items.All(i => !i.Title.Contains("TOPSECRET")));

            var laughs = """
                <?xml version="1.0"?>
                <!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
                <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">]>
                <rss version="2.0"><channel><title>&lol4;</title></channel></rss>
                """;
            Assert.Null(FeedFetcher.Parse(Encoding.UTF8.GetBytes(laughs)));

            // An old feed with a harmless DOCTYPE still works (the DTD is just skipped).
            var old = """
                <?xml version="1.0"?>
                <!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd">
                <rss version="0.91"><channel><title>Classic</title><item><title>Item</title><link>https://old.example/1</link></item></channel></rss>
                """;
            Assert.Equal("Item", Assert.Single(FeedFetcher.Parse(Encoding.UTF8.GetBytes(old))!.Items).Title);

            // Through the server: refused as not a feed, and nothing leaks.
            using var site = new Site();
            site.Handle = c => Reply(c, 200, "application/rss+xml", xxe);
            using var server = Server(site);
            using var admin = await server.JoinAsync("Admin", "admin");
            await TurnOn(admin);
            var reply = await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/feed", channelId = server.General });
            Assert.Equal("feeds_not_feed", ErrorKey(reply));
            Assert.DoesNotContain("TOPSECRET", reply.GetRawText());
        }
        finally
        {
            File.Delete(secret);
        }
    }

    [Fact]
    public async Task Feeds_over_2_MB_are_refused()
    {
        using var site = new Site();
        var big = Rss("Big", ("a", new string('x', 100))).Replace("</channel>", "<!--" + new string('y', FeedFetcher.MaxBytes) + "--></channel>");
        site.Handle = c => Reply(c, 200, "application/rss+xml", big);
        using var server = Server(site);
        using var admin = await server.JoinAsync("Admin", "admin");
        await TurnOn(admin);
        Assert.Equal("feeds_too_large", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/feed", channelId = server.General })));
    }

    // ── Mentions ─────────────────────────────────────────────────────────────

    private static string[] Names(JsonElement e, string name) => e.GetProperty(name).EnumerateArray().Select(x => x.GetString()!).ToArray();

    [Fact]
    public async Task Mentions_need_the_admin_to_be_allowed_and_ping_at_most_every_ten_minutes()
    {
        using var site = new Site();
        var items = new List<(string, string)> { ("a", "A") };
        site.Handle = c => Reply(c, 200, "application/rss+xml", Rss("News", [.. items]));
        using var server = Server(site);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        var bot = await TurnOn(admin);
        var role = (await owner.RequestAsync("role.create", new { name = "News" })).Body().GetProperty("role").GetProperty("id").GetInt64();

        // Admins here may not mention everyone.
        var adminRole = (await owner.RequestAsync("role.list")).Body().GetProperty("baseRoles")[1];
        Assert.Equal("result", (await owner.RequestAsync("role.base.update", new
        {
            role = "admin",
            abilities = Names(adminRole, "abilities").Where(a => a != "mentionEveryone").ToArray(),
            permissions = Names(adminRole, "permissions").Where(p => p != "mentionEveryone").ToArray(),
        })).Type());
        var source = site.Url + "/feed";
        foreach (var mention in new object[] { new { mention = "everyone" }, new { mention = "here" } })
        {
            var body = JsonSerializer.SerializeToNode(mention)!.AsObject();
            body["kind"] = "rss";
            body["source"] = source;
            body["channelId"] = server.General;
            Assert.Equal("feeds_mention_denied", ErrorKey(await admin.RequestAsync("feeds.add", body)));
        }
        Assert.Equal("feeds_mention_denied", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source, channelId = server.General, mention = "role", mentionRoleId = role })));
        Assert.Equal("not_found", (await admin.RequestAsync("feeds.add", new { kind = "rss", source, channelId = server.General, mention = "role", mentionRoleId = 99999 })).ErrorCode());
        // A mentionable role is fine for anyone, and pings (the role lets anyone mention it).
        Assert.Equal("result", (await owner.RequestAsync("role.update", new { id = role, mentionable = true })).Type());
        var sub = await Add(admin, new { kind = "rss", source, channelId = server.General, mention = "role", mentionRoleId = role });
        Assert.True(sub.GetProperty("canPing").GetBoolean());
        await admin.RequestAsync("feeds.remove", new { id = sub.GetProperty("id").GetInt64() });

        // The owner may pick @everyone; the Feeds bot (a member) can't ping everyone until it gets a role that may.
        sub = await Add(owner, new { kind = "rss", source, channelId = server.General, mention = "everyone" });
        Assert.False(sub.GetProperty("canPing").GetBoolean());
        var id = sub.GetProperty("id").GetInt64();
        // The admin can still change other things without touching the mention.
        Assert.Equal("result", (await admin.RequestAsync("feeds.update", new { id, intervalMinutes = 30 })).Type());
        Assert.Equal("feeds_mention_denied", ErrorKey(await admin.RequestAsync("feeds.update", new { id, mention = "here" })));

        items.Insert(0, ("b", "B"));
        await Feeds(server).CheckAsync(id, manual: false);
        items.Insert(0, ("c", "C"));
        await Feeds(server).CheckAsync(id, manual: false);
        var posts = Posts(server, server.General, bot);
        Assert.Equal(2, posts.Count);
        Assert.StartsWith("@everyone 📰 News: **B**", posts[0].Text);
        Assert.Equal("everyone", Builtin(server, posts[0]).GetProperty("mention").GetString());
        Assert.StartsWith("📰 News: **C**", posts[1].Text); // within ten minutes: no second ping
        Assert.Equal(JsonValueKind.Null, Builtin(server, posts[1]).GetProperty("mention").ValueKind);
    }

    // ── Twitch ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task Twitch_needs_the_owners_app_and_posts_when_a_new_stream_starts()
    {
        using var site = new Site();
        string? live = "1001";
        var tokens = 0;
        var rejectNext = false;
        site.Handle = c =>
        {
            var path = c.Request.Url!.AbsolutePath;
            if (path == "/oauth2/token")
            {
                var form = new StreamReader(c.Request.InputStream).ReadToEnd();
                if (!form.Contains("client_secret=goodsecret123")) return Reply(c, 400, "application/json", """{"status":400,"message":"invalid client secret"}""");
                var n = Interlocked.Increment(ref tokens);
                return Reply(c, 200, "application/json", $$"""{"access_token":"token{{n}}","expires_in":5000000,"token_type":"bearer"}""");
            }
            if (c.Request.Headers["Client-Id"] != "clientid123") return Reply(c, 401, "application/json", "{}");
            if (rejectNext)
            {
                rejectNext = false;
                return Reply(c, 401, "application/json", """{"error":"Unauthorized"}""");
            }
            var login = c.Request.QueryString["login"] ?? c.Request.QueryString["user_login"];
            if (path == "/helix/users")
                return Reply(c, 200, "application/json", login == "streamer"
                    ? """{"data":[{"id":"42","login":"streamer","display_name":"Streamer"}]}""" : """{"data":[]}""");
            if (path == "/helix/streams")
                return Reply(c, 200, "application/json", live is null || login != "streamer" ? """{"data":[]}"""
                    : $$"""{"data":[{"id":"{{live}}","user_login":"streamer","user_name":"Streamer","game_name":"Chess","type":"live","title":"Blitz <@&1> @here","started_at":"2026-10-17T10:00:00Z","thumbnail_url":"https://x/{width}x{height}.jpg"}]}""");
            return Reply(c, 404, "application/json", "{}");
        };
        using var server = Server(site);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        var bot = await TurnOn(admin);

        Assert.Equal("feeds_twitch_setup", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "twitch", source = "streamer", channelId = server.General })));
        Assert.Equal("feeds_twitch_owner", ErrorKey(await admin.RequestAsync("feeds.twitch.set", new { clientId = "clientid123", clientSecret = "goodsecret123" })));
        Assert.Equal("feeds_twitch_credentials", ErrorKey(await owner.RequestAsync("feeds.twitch.set", new { clientId = "clientid123", clientSecret = "badsecret123" })));
        var set = await owner.RequestAsync("feeds.twitch.set", new { clientId = "clientid123", clientSecret = "goodsecret123" });
        Assert.True(set.Body().GetProperty("twitch").GetProperty("configured").GetBoolean());
        Assert.DoesNotContain("goodsecret123", set.GetRawText());
        var get = await admin.RequestAsync("feeds.get");
        Assert.Equal("clientid123", get.Body().GetProperty("twitch").GetProperty("clientId").GetString());
        Assert.DoesNotContain("goodsecret123", get.GetRawText());

        Assert.Equal("feeds_twitch_login", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "twitch", source = "not a login!", channelId = server.General })));
        Assert.Equal("feeds_twitch_unknown", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "twitch", source = "nobody", channelId = server.General })));
        Assert.Equal("feeds_interval", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "twitch", source = "streamer", channelId = server.General, intervalMinutes = 1 })));
        // Live right now when added: that stream isn't announced.
        var sub = await Add(admin, new { kind = "twitch", source = "https://www.twitch.tv/Streamer", channelId = server.General, intervalMinutes = 2 });
        Assert.Equal(("streamer", "Streamer", "https://www.twitch.tv/streamer"),
            (sub.GetProperty("source").GetString(), sub.GetProperty("name").GetString(), sub.GetProperty("url").GetString()));
        var id = sub.GetProperty("id").GetInt64();
        await Feeds(server).CheckAsync(id, manual: false);
        Assert.Empty(Posts(server, server.General, bot));

        live = null; // offline
        await Feeds(server).CheckAsync(id, manual: false);
        live = "1002"; // a new stream (and an expired token on the way: one retry with a new one)
        rejectNext = true;
        await Feeds(server).CheckAsync(id, manual: false);
        var post = Assert.Single(Posts(server, server.General, bot));
        Assert.StartsWith("🔴 Streamer is live: **Blitz \\<@&1\\> @‍here**", post.Text);
        Assert.EndsWith("https://www.twitch.tv/streamer", post.Text);
        Assert.Equal("twitch", Builtin(server, post).GetProperty("source").GetString());
        await Feeds(server).CheckAsync(id, manual: false);
        Assert.Single(Posts(server, server.General, bot)); // the same stream once
        Assert.Contains(site.Hits, h => h.Authorization == "Bearer token2");
        Assert.DoesNotContain(site.Hits, h => h.Path.EndsWith(".jpg"));

        // Without credentials the subscription says what's missing.
        await owner.RequestAsync("feeds.twitch.set", new { clientId = "", clientSecret = "" });
        await Feeds(server).CheckAsync(id, manual: false);
        Assert.Equal("twitch_setup", server.World.Store.GetFeedSubscription(id)!.LastError);
    }

    // ── Limits, changes and cleanup ──────────────────────────────────────────

    [Fact]
    public async Task Limits_changes_audit_and_cleanup()
    {
        using var site = new Site();
        site.Handle = c => Reply(c, 200, "application/rss+xml", Rss("Feed " + c.Request.Url!.AbsolutePath, ("a", "A")));
        using var server = Server(site);
        using var admin = await server.JoinAsync("Admin", "admin");
        await TurnOn(admin);
        var news = (await admin.RequestAsync("channel.create", new { name = "news" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var lounge = (await admin.RequestAsync("channel.create", new { name = "lounge", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();

        Assert.Equal("feeds_kind", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "mastodon", source = "x", channelId = news })));
        Assert.Equal("builtin_bot_channel", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/x", channelId = lounge })));
        Assert.Equal("not_found", (await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/x", channelId = 999999 })).ErrorCode());
        Assert.Equal("feeds_interval", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/x", channelId = news, intervalMinutes = 4 })));
        Assert.Equal("feeds_interval", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/x", channelId = news, intervalMinutes = 1441 })));
        Assert.Equal("feeds_template", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/x", channelId = news, template = new string('a', 501) })));

        var first = await Add(admin, new { kind = "rss", source = site.Url + "/0", channelId = news, intervalMinutes = 5 });
        var id = first.GetProperty("id").GetInt64();
        Assert.Equal("feeds_duplicate", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/0", channelId = news })));
        await Add(admin, new { kind = "rss", source = site.Url + "/1", channelId = news });
        var template = server.World.Store.GetFeedSubscription(id)!;
        for (var i = 2; i < FeedService.MaxSubscriptions; i++)
            server.World.Store.AddFeedSubscription(template with { Source = $"{site.Url}/{i}" }, [], 0);
        Assert.Equal("feeds_max", ErrorKey(await admin.RequestAsync("feeds.add", new { kind = "rss", source = site.Url + "/26", channelId = news })));

        var updated = (await admin.RequestAsync("feeds.update", new { id, channelId = server.General, template = "{title}", intervalMinutes = 60, paused = true })).Body().GetProperty("subscription");
        Assert.Equal((server.General, "{title}", 60, true), (updated.GetProperty("channelId").GetInt64(), updated.GetProperty("template").GetString(),
            updated.GetProperty("intervalMinutes").GetInt32(), updated.GetProperty("paused").GetBoolean()));
        Assert.Equal("not_found", (await admin.RequestAsync("feeds.update", new { id = 99999, paused = false })).ErrorCode());

        // Checking by hand: once a minute.
        Assert.Equal("result", (await admin.RequestAsync("feeds.check", new { id })).Type());
        Assert.Equal("feeds_check_wait", ErrorKey(await admin.RequestAsync("feeds.check", new { id })));

        Assert.Equal("result", (await admin.RequestAsync("feeds.remove", new { id })).Type());
        Assert.Null(server.World.Store.GetFeedSubscription(id));
        var audit = (await admin.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray()
            .Select(e => (e.GetProperty("action").GetString(), e.GetRawText())).ToList();
        Assert.Contains(audit, a => a.Item1 == "feed.update" && a.Item2.Contains("intervalMinutes"));
        Assert.Contains(audit, a => a.Item1 == "feed.remove");

        // Deleting the channel takes its feeds (and what they saw) with it.
        Assert.Equal(FeedService.MaxSubscriptions - 1, server.World.Store.CountFeedSubscriptions());
        Assert.Equal("result", (await admin.RequestAsync("channel.delete", new { id = news })).Type());
        Assert.Equal(0, server.World.Store.CountFeedSubscriptions());
    }

    [Fact]
    public void Feed_text_is_cleaned_and_escaped()
    {
        Assert.Equal("Hello world", FeedFetcher.Clean("  Hello\n\t world ‮", 100));
        Assert.Equal("A & B", FeedFetcher.Clean("A &amp; B", 100));
        Assert.Equal("abcd…", FeedFetcher.Clean("abcdefgh", 5));
        Assert.Null(FeedFetcher.Clean("  ", 10));
        Assert.Equal(@"\*bold\* \_x\_ \[link\](y) \<@abc\> @‍everyone", FeedService.Escape("*bold* _x_ [link](y) <@abc> @everyone"));
        Assert.Null(FeedFetcher.LinkOf("javascript:alert(1)"));
        Assert.Null(FeedFetcher.LinkOf("/relative"));
        Assert.Equal("https://ok.example/a?b=c", FeedFetcher.LinkOf("https://ok.example/a?b=c"));
        Assert.Equal("streamer", FeedFetcher.ParseTwitch("twitch.tv/Streamer"));
        Assert.Null(FeedFetcher.ParseTwitch("https://evil.example/streamer"));
    }
}
