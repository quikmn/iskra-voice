using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class BugInboxTests
{
    // The smallest valid PNG (1×1).
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");

    private static object Report(string what = "The mic button does nothing", object? images = null, string? email = null, string? logs = null) => new
    {
        v = 1,
        what,
        steps = "1. Join voice\n2. Click mute",
        expected = "It mutes",
        email,
        env = new { version = "2.0.0-alpha.15", commit = "abc1234", os = "Windows 11", browser = "Chrome 140", device = "desktop", language = "en" },
        logs,
        images,
    };

    private static Task<HttpResponseMessage> Post(IskraServer server, object payload, string? origin = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/bug-reports") { Content = JsonContent.Create(payload) };
        if (origin is not null) request.Headers.Add("Origin", origin);
        return server.CreateClient().SendAsync(request);
    }

    private static Task<HttpResponseMessage> PostRaw(IskraServer server, string body, string type = "application/json") =>
        server.CreateClient().PostAsync("/bug-reports", new StringContent(body, Encoding.UTF8, type));

    private static async Task<long> PrivateChannel(User owner)
    {
        var created = await owner.RequestAsync("channel.create", new { name = "bug-reports", readRole = "admin" });
        return created.Body().GetProperty("channel").GetProperty("id").GetInt64();
    }

    private static async Task TurnOn(User owner, long channelId)
    {
        var set = await owner.RequestAsync("buginbox.set", new { enabled = true, channelId });
        Assert.Equal("result", set.Type());
        Assert.True(set.Body().GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Off_by_default_the_endpoint_is_a_404_and_the_settings_are_refused()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        Assert.False(owner.Welcome.Body().GetProperty("server").GetProperty("bugInbox").GetBoolean());

        var post = await Post(server, Report(), origin: "https://app.iskra.foo");
        Assert.Equal(HttpStatusCode.NotFound, post.StatusCode);
        Assert.Equal("", await post.Content.ReadAsStringAsync());
        Assert.False(post.Headers.Contains("Access-Control-Allow-Origin"));

        var preflight = new HttpRequestMessage(HttpMethod.Options, "/bug-reports");
        preflight.Headers.Add("Origin", "https://app.iskra.foo");
        var options = await server.CreateClient().SendAsync(preflight);
        Assert.Equal(HttpStatusCode.NotFound, options.StatusCode);
        Assert.False(options.Headers.Contains("Access-Control-Allow-Origin"));

        Assert.Equal("bug_inbox_off", (await owner.RequestAsync("buginbox.get")).Body().GetProperty("key").GetString());
        Assert.Equal("bug_inbox_off", (await owner.RequestAsync("buginbox.set", new { enabled = true, channelId = server.General })).Body().GetProperty("key").GetString());
        Assert.False(server.World.Store.GetBugInbox().Enabled);
    }

    [Fact]
    public async Task Accepting_servers_say_so_in_the_welcome()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        Assert.True(owner.Welcome.Body().GetProperty("server").GetProperty("bugInbox").GetBoolean());
    }

    [Fact]
    public async Task Only_the_owner_turns_it_on_and_it_needs_a_text_channel()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");

        Assert.Equal("owner_bug_inbox", (await admin.RequestAsync("buginbox.get")).Body().GetProperty("key").GetString());
        Assert.Equal("owner_bug_inbox", (await admin.RequestAsync("buginbox.set", new { enabled = true, channelId = server.General })).Body().GetProperty("key").GetString());

        var off = (await owner.RequestAsync("buginbox.get")).Body();
        Assert.False(off.GetProperty("enabled").GetBoolean());
        Assert.Equal(JsonValueKind.Null, off.GetProperty("channelId").ValueKind);

        Assert.Equal("bug_inbox_channel", (await owner.RequestAsync("buginbox.set", new { enabled = true })).Body().GetProperty("key").GetString());
        var voice = (await owner.RequestAsync("channel.create", new { name = "voice", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("bug_inbox_text_only", (await owner.RequestAsync("buginbox.set", new { enabled = true, channelId = voice })).Body().GetProperty("key").GetString());
        Assert.Equal("not_found", (await owner.RequestAsync("buginbox.set", new { enabled = true, channelId = 999_999 })).ErrorCode());

        var channel = await PrivateChannel(owner);
        await TurnOn(owner, channel);
        Assert.Equal(channel, (await owner.RequestAsync("buginbox.get")).Body().GetProperty("channelId").GetInt64());

        // Turning it off keeps the channel for next time; deleting the channel turns it off.
        var turnedOff = (await owner.RequestAsync("buginbox.set", new { enabled = false })).Body();
        Assert.False(turnedOff.GetProperty("enabled").GetBoolean());
        Assert.Equal(channel, turnedOff.GetProperty("channelId").GetInt64());
        await TurnOn(owner, channel);
        Assert.Equal("result", (await owner.RequestAsync("channel.delete", new { id = channel })).Type());
        Assert.False((await owner.RequestAsync("buginbox.get")).Body().GetProperty("enabled").GetBoolean());
        using var gone = await Post(server, Report());
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    [Fact]
    public async Task Off_means_404()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var response = await Post(server, Report());
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task A_report_lands_in_the_chosen_channel_with_its_images_and_logs()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var channel = await PrivateChannel(owner);
        await TurnOn(owner, channel);

        var images = new[] { new { type = "image/png", data = Convert.ToBase64String(Png) } };
        using var response = await Post(server, Report($"Mic broken <@{member.Key}> @everyone\nsecond line", images, "me@example.com", "t+0 connection online\n"), "https://app.iskra.foo");
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal("https://app.iskra.foo", response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        var id = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("id").GetString()!;
        Assert.Matches("^[A-Z0-9]{4}-[A-Z0-9]{4}$", id);

        var message = (await owner.EventAsync("chat.message")).Body().GetProperty("message");
        await member.NoEventAsync("chat.message"); // a private channel: members don't see reports
        Assert.Equal(channel, message.GetProperty("channelId").GetInt64());
        Assert.Equal(BugInbox.AuthorKey, message.GetProperty("author").GetString());
        var text = message.GetProperty("text").GetString()!;
        Assert.Contains("**What happened**\nMic broken @Member @‍everyone", text);
        Assert.Contains("**Steps to reproduce**\n1. Join voice", text);
        Assert.Contains("**Contact:** me@example.com", text);
        Assert.DoesNotContain($"<@{member.Key}>", text);

        var webhook = message.GetProperty("webhook");
        Assert.Equal("Bug reports", webhook.GetProperty("name").GetString());
        var card = webhook.GetProperty("embeds")[0];
        Assert.Equal("Mic broken @Member @‍everyone", card.GetProperty("title").GetString());
        Assert.Equal($"Report {id}", card.GetProperty("footer").GetProperty("text").GetString());
        var fields = card.GetProperty("fields").EnumerateArray().ToDictionary(f => f.GetProperty("name").GetString()!, f => f.GetProperty("value").GetString());
        Assert.Equal("2.0.0-alpha.15", fields["Version"]);
        Assert.Equal("Windows 11", fields["OS"]);
        Assert.Equal("desktop", fields["Device"]);

        var attachments = message.GetProperty("attachments").EnumerateArray().ToList();
        Assert.Equal(2, attachments.Count);
        Assert.Equal("image/png", attachments[0].GetProperty("type").GetString());
        Assert.EndsWith("logs.txt", attachments[1].GetProperty("name").GetString());
        using var file = await server.CreateClient().GetAsync(attachments[0].GetProperty("url").GetString());
        Assert.Equal(Png, await file.Content.ReadAsByteArrayAsync());

        // Admins can delete it like any webhook message.
        Assert.Equal("result", (await owner.RequestAsync("chat.delete", new { id = message.GetProperty("id").GetInt64() })).Type());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[1]")]
    [InlineData("not json")]
    [InlineData("{\"what\":\"   \",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"}}")]
    [InlineData("{\"what\":\"x\"}")]
    [InlineData("{\"what\":\"x\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"toaster\"}}")]
    [InlineData("{\"what\":\"x\",\"env\":{\"version\":\"1\",\"commit\":\"zzz\",\"os\":\"Linux\",\"device\":\"web\"}}")]
    [InlineData("{\"what\":\"x\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"<script>\",\"device\":\"web\"}}")]
    [InlineData("{\"what\":\"x\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\",\"ip\":\"1.2.3.4\"}}")]
    [InlineData("{\"what\":\"x\",\"extra\":1,\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"}}")]
    [InlineData("{\"what\":\"bell\\u0007\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"}}")]
    [InlineData("{\"what\":\"x\",\"email\":\"not an email\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"}}")]
    [InlineData("{\"what\":\"x\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"},\"images\":[{\"type\":\"image/png\",\"data\":\"!!!\"}]}")]
    [InlineData("{\"what\":\"x\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"},\"images\":[{\"type\":\"image/svg+xml\",\"data\":\"PHN2Zz4=\"}]}")]
    [InlineData("{\"what\":\"x\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"},\"images\":[{\"type\":\"image/png\",\"data\":\"PGh0bWw+PC9odG1sPg==\"}]}")]
    public async Task Bad_reports_are_refused(string body)
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        await TurnOn(owner, server.General);
        using var response = await PostRaw(server, body);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        await owner.NoEventAsync("chat.message");
    }

    [Fact]
    public async Task Size_limits()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        await TurnOn(owner, server.General);
        server.Services.GetRequiredService<BugInbox>().PerAddressPerHour = 100;

        using (var r = await Post(server, Report(new string('a', BugInbox.MaxWhat)))) Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        using (var r = await Post(server, Report(new string('a', BugInbox.MaxWhat + 1)))) Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var six = Enumerable.Range(0, 6).Select(_ => new { type = "image/png", data = Convert.ToBase64String(Png) }).ToArray();
        using (var r = await Post(server, Report(images: six))) Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        // An image just over 1.5 MB (a PNG header and padding).
        var big = new byte[BugInbox.MaxImageBytes + 1];
        Png.CopyTo(big, 0);
        using (var r = await Post(server, Report(images: new[] { new { type = "image/png", data = Convert.ToBase64String(big) } })))
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        using (var r = await PostRaw(server, "{\"what\":\"" + new string('a', BugInbox.MaxBodyBytes) + "\"}"))
            Assert.Equal(HttpStatusCode.RequestEntityTooLarge, r.StatusCode);
        using (var r = await PostRaw(server, "what=x", "application/x-www-form-urlencoded"))
            Assert.Equal(HttpStatusCode.UnsupportedMediaType, r.StatusCode);
        using (var r = await Post(server, Report(logs: new string('l', BugInbox.MaxLogs + 1)))) Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Rate_limited_per_address_and_for_everyone()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        await TurnOn(owner, server.General);
        var inbox = server.Services.GetRequiredService<BugInbox>();

        for (var i = 0; i < inbox.PerAddressPerHour; i++)
        {
            using var ok = await Post(server, Report($"bug {i}"));
            Assert.Equal(HttpStatusCode.Created, ok.StatusCode);
        }
        using var limited = await Post(server, Report("one too many"));
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.True(limited.Headers.RetryAfter?.Delta > TimeSpan.Zero);

        // Other addresses have their own budget, until the hourly cap for everyone.
        inbox.GlobalPerHour = 2;
        Assert.Equal(StatusCodes.Status201Created, await Direct(server, IPAddress.Parse("198.51.100.1")));
        Assert.Equal(StatusCodes.Status201Created, await Direct(server, IPAddress.Parse("198.51.100.2")));
        Assert.Equal(StatusCodes.Status429TooManyRequests, await Direct(server, IPAddress.Parse("198.51.100.3")));
    }

    [Fact]
    public void Ipv6_addresses_share_a_budget_per_64()
    {
        Assert.Equal(BugInbox.LimitKey(IPAddress.Parse("2001:db8:1:2::1")), BugInbox.LimitKey(IPAddress.Parse("2001:db8:1:2:ffff::9")));
        Assert.NotEqual(BugInbox.LimitKey(IPAddress.Parse("2001:db8:1:2::1")), BugInbox.LimitKey(IPAddress.Parse("2001:db8:1:3::1")));
        Assert.Equal(IPAddress.Parse("203.0.113.5"), BugInbox.LimitKey(IPAddress.Parse("::ffff:203.0.113.5")));
    }

    [Fact]
    public async Task The_senders_address_is_never_stored()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        await TurnOn(owner, server.General);
        const string ip = "203.0.113.77";
        Assert.Equal(StatusCodes.Status201Created, await Direct(server, IPAddress.Parse(ip), "{\"what\":\"crash\",\"env\":{\"version\":\"1\",\"commit\":\"dev\",\"os\":\"Linux\",\"device\":\"web\"},\"logs\":\"line\"}"));
        await owner.EventAsync("chat.message");

        Assert.DoesNotContain(server.World.Store.SecurityEvents(null, null, null, 100), e => e.Ip is not null);
        // Nothing in the world folder (database, uploads) holds the address.
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        foreach (var file in Directory.EnumerateFiles(server.WorldPath, "*", SearchOption.AllDirectories))
        {
            byte[] bytes;
            try { bytes = await File.ReadAllBytesAsync(file); }
            catch (IOException) { continue; } // the open database: read through a copy below
            Assert.DoesNotContain(ip, Encoding.UTF8.GetString(bytes));
        }
        var copy = Path.Combine(Path.GetTempPath(), $"iskra-db-{Guid.NewGuid():N}.db");
        try
        {
            using (var source = new FileStream(Path.Combine(server.WorldPath, "iskra.db"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var target = File.Create(copy)) await source.CopyToAsync(target);
            Assert.DoesNotContain(ip, Encoding.UTF8.GetString(await File.ReadAllBytesAsync(copy)));
        }
        finally { File.Delete(copy); }
    }

    [Fact]
    public async Task Reports_are_deleted_after_a_year()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        await TurnOn(owner, server.General);
        using (var r = await Post(server, Report("old bug"))) Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var old = (await owner.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("id").GetInt64();
        using (var r = await Post(server, Report("new bug"))) Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var fresh = (await owner.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("id").GetInt64();
        var kept = (await owner.RequestAsync("chat.send", new { channelId = server.General, text = "a normal message" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        ComplianceTests.Sql(server, "UPDATE messages SET created_at = $t WHERE id IN ($a, $b);", ("$t", ComplianceTests.DaysAgo(BugInbox.KeepDays + 1)), ("$a", old), ("$b", kept));

        Assert.Equal(1, ComplianceTests.Sweeper(server).Sweep().Messages);
        Assert.Null(server.World.Store.GetMessage(old));
        Assert.NotNull(server.World.Store.GetMessage(fresh));
        Assert.NotNull(server.World.Store.GetMessage(kept)); // messages are kept for good by default
    }

    [Fact]
    public async Task The_phone_apps_preflight_and_send_from_their_own_origins()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("Owner", "owner");
        await TurnOn(owner, await PrivateChannel(owner));

        // iOS (capacitor://localhost) and Android (http://localhost): the browser's preflight, then the report itself.
        foreach (var origin in new[] { "capacitor://localhost", "http://localhost" })
        {
            var preflight = new HttpRequestMessage(HttpMethod.Options, "/bug-reports");
            preflight.Headers.Add("Origin", origin);
            preflight.Headers.Add("Access-Control-Request-Method", "POST");
            preflight.Headers.Add("Access-Control-Request-Headers", "content-type");
            using var answer = await server.CreateClient().SendAsync(preflight);
            Assert.Equal(HttpStatusCode.NoContent, answer.StatusCode);
            Assert.Equal(origin, answer.Headers.GetValues("Access-Control-Allow-Origin").Single());
            Assert.Contains("POST", answer.Headers.GetValues("Access-Control-Allow-Methods").Single());
            Assert.Contains("Content-Type", answer.Headers.GetValues("Access-Control-Allow-Headers").Single());

            using var sent = await Post(server, Report($"From {origin}"), origin);
            Assert.Equal(HttpStatusCode.Created, sent.StatusCode);
            Assert.Equal(origin, sent.Headers.GetValues("Access-Control-Allow-Origin").Single());
        }

        // Anyone else's page gets no CORS answer, so their browser never shows it the result.
        var other = new HttpRequestMessage(HttpMethod.Options, "/bug-reports");
        other.Headers.Add("Origin", "https://evil.example");
        other.Headers.Add("Access-Control-Request-Method", "POST");
        using var refused = await server.CreateClient().SendAsync(other);
        Assert.False(refused.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Theory]
    [InlineData("https://app.iskra.foo", true)]
    [InlineData("app://iskra", true)]
    [InlineData("capacitor://localhost", true)]
    [InlineData("http://localhost", true)]
    [InlineData("http://localhost:5173", true)]
    [InlineData("http://127.0.0.1:47070", true)]
    [InlineData("https://evil.example", false)]
    [InlineData("http://localhost.evil.example", false)]
    [InlineData("null", false)]
    public void Cors_allows_only_the_apps(string origin, bool allowed) => Assert.Equal(allowed, BugInbox.AllowedOrigin(origin));

    /// <summary>Calls the handler with a chosen client address (the test server has none).</summary>
    private static async Task<int> Direct(IskraServer server, IPAddress address, string? json = null)
    {
        var inbox = server.Services.GetRequiredService<BugInbox>();
        var context = new DefaultHttpContext { RequestServices = server.Services };
        context.Connection.RemoteIpAddress = address;
        context.Request.Method = "POST";
        context.Request.ContentType = "application/json";
        var bytes = Encoding.UTF8.GetBytes(json ?? JsonSerializer.Serialize(Report()));
        context.Request.Body = new MemoryStream(bytes);
        context.Request.ContentLength = bytes.Length;
        context.Response.Body = new MemoryStream();
        var result = await inbox.PostAsync(context);
        await result.ExecuteAsync(context);
        return context.Response.StatusCode;
    }
}
