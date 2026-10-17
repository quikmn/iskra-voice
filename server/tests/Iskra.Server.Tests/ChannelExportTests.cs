using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ChannelExportTests
{
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=");

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task<string> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
    }

    /// <summary>Starts an export and waits for it to end; returns the finished job.</summary>
    private static async Task<JsonElement> Export(User user, object body)
    {
        var started = await user.RequestAsync("channel.export", body);
        Assert.Equal("result", started.Type());
        var id = started.Body().GetProperty("job").GetProperty("id").GetString();
        var until = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < until)
        {
            var jobs = (await user.RequestAsync("channel.export.status")).Body().GetProperty("jobs");
            var job = jobs.EnumerateArray().Single(j => j.GetProperty("id").GetString() == id);
            if (job.GetProperty("state").GetString() != "running") return job;
            await Task.Delay(50);
        }
        throw new TimeoutException("The export didn't finish.");
    }

    private static async Task<Dictionary<string, byte[]>> Download(IskraServer server, JsonElement job)
    {
        Assert.Equal("done", job.GetProperty("state").GetString());
        using var response = await server.CreateClient().GetAsync(job.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
        using var zip = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()));
        return zip.Entries.ToDictionary(e => e.FullName, e =>
        {
            using var s = e.Open();
            using var m = new MemoryStream();
            s.CopyTo(m);
            return m.ToArray();
        });
    }

    private static string Text(Dictionary<string, byte[]> files, string suffix) => Encoding.UTF8.GetString(files.Single(f => f.Key.EndsWith(suffix)).Value);

    [Fact]
    public async Task Only_people_with_the_permission_export_and_only_channels_they_can_read()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var mia = await server.JoinAsync("Mia");
        var general = server.General;

        var refused = await mia.RequestAsync("channel.export", new { channelIds = new[] { general } });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("export_forbidden", refused.Body().GetProperty("key").GetString());

        // A custom role can give it.
        var role = (await owner.RequestAsync("role.create", new { name = "Archivist", permissions = new[] { "exportChannels" } })).Body().GetProperty("role");
        await owner.RequestAsync("member.roles.set", new { accountKey = mia.Key, roles = new[] { role.GetProperty("id").GetInt64() } });
        Assert.Equal("done", (await Export(mia, new { channelIds = new[] { general } })).GetProperty("state").GetString());

        // A channel the admin can't read doesn't exist for them; threads and whiteboards aren't channels to export.
        var secret = (await owner.RequestAsync("channel.create", new { name = "owners", readRole = "owner", writeRole = "owner" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await admin.RequestAsync("channel.export", new { channelIds = new[] { general, secret } })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("channel.export", new { channelIds = new[] { 9999 } })).ErrorCode());
        var board = (await owner.RequestAsync("channel.create", new { name = "board", kind = "whiteboard" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("export_kind", (await admin.RequestAsync("channel.export", new { channelIds = new[] { board } })).Body().GetProperty("key").GetString());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.export", new { channelIds = Array.Empty<long>() })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.export", new { channelIds = new[] { general, general } })).ErrorCode());
        Assert.Equal("export_range", (await admin.RequestAsync("channel.export", new { channelIds = new[] { general }, from = 10, to = 5 })).Body().GetProperty("key").GetString());
        Assert.Equal("not_found", (await admin.RequestAsync("channel.export.cancel", new { id = "nope" })).ErrorCode());
    }

    [Fact]
    public async Task Encrypted_channels_are_refused()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var channel = (await owner.RequestAsync("channel.create", new { name = "private" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        server.World.Store.SaveE2eeChange(new E2eeChannel(channel, "chain-1", 1, "head", [owner.Key], Now),
            new E2eeChange(1, "{}", "sig", owner.Key, Now), [], fresh: true);

        var refused = (await owner.RequestAsync("channel.export", new { channelIds = new[] { server.General, channel } })).Body();
        Assert.Equal("bad_request", refused.GetProperty("code").GetString());
        Assert.Equal("export_encrypted", refused.GetProperty("key").GetString());
        Assert.Equal("Encrypted channels can only be exported from a member's device.", refused.GetProperty("message").GetString());
    }

    [Fact]
    public async Task The_range_filters_messages_and_leaves_out_deleted_and_disappearing_ones()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var store = server.World.Store;
        var general = server.General;
        store.AddMessage(general, owner.Key, "too early", 1_000);
        store.AddMessage(general, owner.Key, "first in range", 2_000);
        var gone = store.AddMessage(general, owner.Key, "deleted later", 2_500);
        store.DeleteMessage(gone.Id);
        store.SetChannelTimer(general, int.MaxValue, owner.Key, 2_550);
        store.AddMessage(general, owner.Key, "disappearing", 2_600);
        store.SetChannelTimer(general, 0, owner.Key, 2_700);
        store.AddMessage(general, owner.Key, "last in range", 3_000);
        store.AddMessage(general, owner.Key, "too late", 4_000);

        var files = await Download(server, await Export(owner, new { channelIds = new[] { general }, from = 2_000, to = 3_000 }));
        using var json = JsonDocument.Parse(Text(files, "channel.json"));
        var texts = json.RootElement.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("text").GetString()).ToList();
        Assert.Equal(["first in range", "last in range"], texts);
        Assert.Equal(2_000, json.RootElement.GetProperty("range").GetProperty("from").GetInt64());
        var html = Text(files, "channel.html");
        Assert.Contains("first in range", html);
        Assert.DoesNotContain("too early", html);
        Assert.DoesNotContain("disappearing", html);
        Assert.DoesNotContain("deleted later", html);
    }

    [Fact]
    public async Task The_json_follows_the_documented_schema()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var sam = await server.JoinAsync("Sam");
        var general = server.General;
        var image = await Upload(server, owner, Png, "cat.png");
        var first = (await owner.RequestAsync("chat.send", new { channelId = general, text = $"hello <@{sam.Key}>", attachments = new[] { image } }))
            .Body().GetProperty("message").GetProperty("id").GetInt64();
        await sam.RequestAsync("chat.send", new { channelId = general, text = "hi back", replyTo = first });
        await sam.RequestAsync("chat.react", new { id = first, emoji = "👍" });
        await owner.RequestAsync("chat.pin", new { id = first });
        await owner.RequestAsync("chat.edit", new { id = first, text = $"hello <@{sam.Key}>!" });
        var thread = (await owner.RequestAsync("thread.create", new { messageId = first, name = "side chat" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        await sam.RequestAsync("chat.send", new { channelId = thread, text = "in the thread" });
        await owner.RequestAsync("poll.create", new { channelId = general, question = "Pizza?", options = new[] { "Yes", "No" } });

        var files = await Download(server, await Export(owner, new { channelIds = new[] { general } }));
        var folder = $"{general}-general/";
        Assert.Contains(folder + "channel.json", files.Keys);
        Assert.Contains(folder + "channel.html", files.Keys);
        Assert.Contains("README.txt", files.Keys);
        Assert.Equal(Png, files[folder + "attachments/1-cat.png"]);

        var raw = Text(files, "channel.json");
        Assert.DoesNotContain(owner.Key, raw);
        Assert.DoesNotContain(sam.Key, raw);
        using var json = JsonDocument.Parse(raw);
        var root = json.RootElement;
        // The schema, golden: every property path (arrays as []) of a full export.
        Assert.Equal(GoldenPaths, Paths(root).Distinct().Order(StringComparer.Ordinal).ToList());

        Assert.Equal("iskra-channel-export", root.GetProperty("format").GetString());
        Assert.Equal(1, root.GetProperty("version").GetInt32());
        Assert.Equal("Owner", root.GetProperty("exportedBy").GetString());
        var messages = root.GetProperty("messages").EnumerateArray().ToList();
        var hello = messages[0];
        Assert.Equal("hello @Sam!", hello.GetProperty("text").GetString());
        Assert.NotEqual(JsonValueKind.Null, hello.GetProperty("editedAt").ValueKind);
        Assert.True(hello.GetProperty("pinned").GetBoolean());
        Assert.Equal(thread, hello.GetProperty("thread").GetInt64());
        Assert.Equal("attachments/1-cat.png", hello.GetProperty("attachments")[0].GetProperty("file").GetString());
        Assert.Equal(1, hello.GetProperty("reactions")[0].GetProperty("count").GetInt32());
        var authors = root.GetProperty("authors");
        Assert.Equal("Owner", authors.GetProperty(hello.GetProperty("author").GetString()!).GetProperty("name").GetString());
        var reply = messages.Single(m => m.GetProperty("text").GetString() == "hi back");
        Assert.Equal(first, reply.GetProperty("replyTo").GetProperty("id").GetInt64());
        Assert.Equal("Sam", authors.GetProperty(reply.GetProperty("author").GetString()!).GetProperty("name").GetString());
        Assert.Equal("Pizza?", messages.Single(m => m.GetProperty("poll").ValueKind != JsonValueKind.Null).GetProperty("poll").GetProperty("question").GetString());
        var exportedThread = root.GetProperty("threads").EnumerateArray().Single();
        Assert.Equal("side chat", exportedThread.GetProperty("name").GetString());
        Assert.Equal("in the thread", exportedThread.GetProperty("messages")[0].GetProperty("text").GetString());

        // Without threads and attachments.
        files = await Download(server, await Export(owner, new { channelIds = new[] { general }, threads = false, attachments = false }));
        Assert.DoesNotContain(files.Keys, k => k.Contains("/attachments/"));
        using var lean = JsonDocument.Parse(Text(files, "channel.json"));
        Assert.Empty(lean.RootElement.GetProperty("threads").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, lean.RootElement.GetProperty("messages")[0].GetProperty("attachments")[0].GetProperty("file").ValueKind);
        Assert.DoesNotContain("in the thread", Text(files, "channel.html"));
    }

    private static readonly List<string> GoldenPaths = new List<string>
    {
        "authors", "authors.*", "authors.*.name", "authors.*.type",
        "channel", "channel.id", "channel.kind", "channel.name", "channel.topic",
        "exportedAt", "exportedBy", "format",
        "includes", "includes.attachments", "includes.threads",
        "messages", "messages[]",
        "messages[].attachments", "messages[].attachments[]", "messages[].attachments[].file", "messages[].attachments[].height",
        "messages[].attachments[].name", "messages[].attachments[].size", "messages[].attachments[].type", "messages[].attachments[].width",
        "messages[].author", "messages[].createdAt", "messages[].editedAt", "messages[].embeds", "messages[].forwarded", "messages[].gif", "messages[].id",
        "messages[].pinned", "messages[].poll", "messages[].poll.closed", "messages[].poll.multi", "messages[].poll.options", "messages[].poll.options[]",
        "messages[].poll.options[].text", "messages[].poll.options[].votes", "messages[].poll.question",
        "messages[].reactions", "messages[].reactions[]", "messages[].reactions[].count", "messages[].reactions[].emoji",
        "messages[].replyTo", "messages[].replyTo.author", "messages[].replyTo.excerpt", "messages[].replyTo.id",
        "messages[].sticker", "messages[].text", "messages[].thread", "messages[].voiceMessage",
        "pages", "posts", "range", "range.from", "range.to", "server", "server.name",
        "threads", "threads[]", "threads[].author", "threads[].createdAt", "threads[].id", "threads[].messages", "threads[].messages[]",
        "threads[].messages[].attachments", "threads[].messages[].author", "threads[].messages[].createdAt", "threads[].messages[].editedAt",
        "threads[].messages[].embeds", "threads[].messages[].forwarded", "threads[].messages[].gif", "threads[].messages[].id",
        "threads[].messages[].pinned", "threads[].messages[].poll", "threads[].messages[].reactions", "threads[].messages[].replyTo",
        "threads[].messages[].sticker", "threads[].messages[].text", "threads[].messages[].thread", "threads[].messages[].voiceMessage",
        "threads[].name", "threads[].rootId", "version",
    }.Order(StringComparer.Ordinal).ToList();

    private static IEnumerable<string> Paths(JsonElement e, string at = "")
    {
        if (e.ValueKind == JsonValueKind.Object)
            foreach (var p in e.EnumerateObject())
            {
                var path = at.Length == 0 ? p.Name : at == "authors" ? "authors.*" : $"{at}.{p.Name}";
                yield return path;
                foreach (var inner in Paths(p.Value, path)) yield return inner;
            }
        else if (e.ValueKind == JsonValueKind.Array)
            foreach (var item in e.EnumerateArray())
            {
                yield return at + "[]";
                foreach (var inner in Paths(item, at + "[]")) yield return inner;
            }
    }

    [Fact]
    public async Task Hostile_content_is_escaped_and_the_page_loads_nothing()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var evil = await server.JoinAsync("<b>Evil</b>\"'");
        var general = server.General;
        string[] hostile =
        [
            "<script>alert(1)</script>",
            "\"><img src=x onerror=alert(2)>",
            "[click me](javascript:alert(3))",
            "[ok](https://example.com/\"onmouseover=alert(4))",
            "https://example.com/?a=1&b=<i>2</i>",
            "**bold <svg onload=alert(5)>** `<code>` ||<iframe src=x>|| > quote <style>",
            "```\n</code></pre><script>alert(6)</script>\n```",
        ];
        foreach (var text in hostile) await evil.RequestAsync("chat.send", new { channelId = general, text });
        var file = await Upload(server, evil, Encoding.UTF8.GetBytes("<html><script>alert(7)</script></html>"), "\"><svg onload=alert(8)>.html");
        await evil.RequestAsync("chat.send", new { channelId = general, text = "file", attachments = new[] { file } });

        var files = await Download(server, await Export(owner, new { channelIds = new[] { general } }));
        var html = Text(files, "channel.html");
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<img src=x", html);
        Assert.DoesNotContain("<svg", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<iframe", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<b>Evil", html);
        Assert.Contains("[click me](javascript:alert(3))", html); // as text, not a link
        Assert.DoesNotContain("href=\"javascript", html);
        Assert.DoesNotContain("\"onmouseover", html);
        Assert.Contains("&lt;script&gt;alert(1)&lt;/script&gt;", html);
        Assert.Contains("&lt;b&gt;Evil&lt;/b&gt;", html);
        Assert.Contains("<a href=\"https://example.com/?a=1&amp;b=\" rel=\"noopener noreferrer nofollow\" target=\"_blank\">", html);
        Assert.Contains("<strong>bold &lt;svg onload=alert(5)&gt;</strong>", html);
        Assert.Contains("<span class=\"spoiler\" tabindex=\"0\">&lt;iframe src=x&gt;</span>", html);
        // No scripts, a strict CSP, nothing from the network.
        Assert.Contains($"<meta http-equiv=\"Content-Security-Policy\" content=\"{ExportPage.Csp}\">", html);
        Assert.Contains("default-src 'none'", ExportPage.Csp);
        Assert.DoesNotContain("http-equiv=\"refresh\"", html);
        Assert.DoesNotMatch("(src|href)=\"(https?:)?//", html.Replace("<a href=\"https://example.com", "<a x=\""));
        // An attached page never lands next to channel.html as something a browser would run.
        Assert.Contains(files.Keys, k => k.EndsWith(".html.txt"));
        Assert.DoesNotContain(files.Keys, k => k.Contains('"') || k.Contains('<'));
    }

    [Fact]
    public void Markdown_renders_only_its_own_tags()
    {
        var ctx = new FakeContext();
        Assert.Equal("<p>&lt;b&gt;hi&lt;/b&gt;</p>", ExportMarkdown.ToHtml("<b>hi</b>", ctx));
        Assert.Equal("<p><em>a</em> <s>b</s> <code>&lt;c&gt;</code></p>", ExportMarkdown.ToHtml("*a* ~~b~~ `<c>`", ctx));
        Assert.Equal("<p>[x](javascript:alert(1))</p>", ExportMarkdown.ToHtml("[x](javascript:alert(1))", ctx));
        Assert.Equal("<p><a href=\"https://a.example/\" rel=\"noopener noreferrer nofollow\" target=\"_blank\">x &amp; y</a></p>",
            ExportMarkdown.ToHtml("[x & y](https://a.example/)", ctx));
        Assert.Equal("<p><span class=\"mention\">@&lt;Sam&gt;</span> :party:</p>", ExportMarkdown.ToHtml($"<@{new string('A', 43)}> <:party:123>", ctx));
        Assert.Equal("<blockquote>one<br>two</blockquote><ul><li>a</li><li>b</li></ul>", ExportMarkdown.ToHtml("> one\n> two\n- a\n- b", ctx));
        Assert.Equal("hi @<Sam>", ExportMarkdown.PlainMentions($"hi <@{new string('A', 43)}>", ctx));
    }

    private sealed class FakeContext : ExportMarkdown.IContext
    {
        public string? NameOf(string accountKey) => "<Sam>";
        public string? RoleName(long roleId) => "Mods";
        public string FormatTime(long ms) => ms.ToString();
    }

    [Fact]
    public async Task Forums_docs_and_voice_chat_export()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var store = server.World.Store;
        var forum = (await owner.RequestAsync("channel.create", new { name = "ideas", kind = "forum" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var post = (await owner.RequestAsync("forum.post.create", new { channelId = forum, title = "Game night", text = "Friday?" })).Body();
        var postId = post.GetProperty("post").GetProperty("id").GetInt64();
        await owner.RequestAsync("chat.send", new { channelId = postId, text = "count me in" });
        var docs = (await owner.RequestAsync("channel.create", new { name = "wiki", kind = "docs" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        store.CreateDocPage(docs, null, "Rules", "# Be nice\n- always", [], owner.Key, Now);
        var voice = (await owner.RequestAsync("channel.create", new { name = "Lounge", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        await owner.RequestAsync("chat.send", new { channelId = voice, text = "voice chat words" });

        var files = await Download(server, await Export(owner, new { channelIds = new[] { forum, docs, voice } }));
        using var forumJson = JsonDocument.Parse(Text(files, $"{forum}-ideas/channel.json"));
        var exported = forumJson.RootElement.GetProperty("posts").EnumerateArray().Single();
        Assert.Equal("Game night", exported.GetProperty("title").GetString());
        Assert.Equal("Friday?", exported.GetProperty("message").GetProperty("text").GetString());
        Assert.Equal("count me in", exported.GetProperty("comments")[0].GetProperty("text").GetString());
        Assert.Empty(forumJson.RootElement.GetProperty("messages").EnumerateArray());
        using var docsJson = JsonDocument.Parse(Text(files, $"{docs}-wiki/channel.json"));
        Assert.Equal("Rules", docsJson.RootElement.GetProperty("pages")[0].GetProperty("title").GetString());
        Assert.Contains("<h3 class=\"md-h\">Be nice</h3>", Text(files, $"{docs}-wiki/channel.html"));
        Assert.Contains("voice chat words", Text(files, $"{voice}-lounge/channel.json"));
    }

    [Fact]
    public async Task Exports_are_recorded_capped_rate_limited_and_expire()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var general = server.General;
        await owner.RequestAsync("chat.send", new { channelId = general, text = "secret words" });
        var exports = ChannelExports.For(server.World);

        // Recorded without content.
        var done = await Export(owner, new { channelIds = new[] { general }, from = 0 });
        var audit = (await owner.RequestAsync("audit.list", new { action = "channel.export" })).Body().GetProperty("entries")[0];
        Assert.Equal(general, audit.GetProperty("details").GetProperty("channelIds")[0].GetInt64());
        var security = server.World.Store.SecurityEvents("channel.export", null, null, 10);
        Assert.Single(security);
        Assert.DoesNotContain("secret words", security[0].Details);
        Assert.DoesNotContain("secret words", audit.GetRawText());

        // Too big: a clear message, nothing left behind.
        exports.MaxBytes = 100;
        var image = await Upload(server, owner, new byte[500], "big.bin");
        await owner.RequestAsync("chat.send", new { channelId = general, text = "file", attachments = new[] { image } });
        var failed = await Export(owner, new { channelIds = new[] { general } });
        Assert.Equal("failed", failed.GetProperty("state").GetString());
        Assert.Equal("export_too_big", failed.GetProperty("error").GetProperty("key").GetString());
        Assert.Equal(JsonValueKind.Null, failed.GetProperty("url").ValueKind);

        // Three, then one every ten minutes.
        Assert.Equal("failed", (await Export(owner, new { channelIds = new[] { general } })).GetProperty("state").GetString());
        var slow = await owner.RequestAsync("channel.export", new { channelIds = new[] { general } });
        Assert.Equal("rate_limited", slow.ErrorCode());
        Assert.Equal("channel_export_slow", slow.Body().GetProperty("key").GetString());

        // The link goes, and the file with it.
        var url = done.GetProperty("url").GetString();
        Assert.Equal(HttpStatusCode.OK, (await server.CreateClient().GetAsync(url)).StatusCode);
        Assert.Single(Directory.GetFiles(Path.Combine(server.WorldPath, DataExports.FolderName), "channels-*.zip"));
        exports.Time = new ShiftedTime(TimeSpan.FromHours(2));
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync(url)).StatusCode);
        Assert.Empty(Directory.GetFiles(Path.Combine(server.WorldPath, DataExports.FolderName), "channels-*.zip"));
        Assert.Empty((await owner.RequestAsync("channel.export.status")).Body().GetProperty("jobs").EnumerateArray());
    }

    private sealed class ShiftedTime(TimeSpan by) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => System.GetUtcNow() + by;
    }
}
