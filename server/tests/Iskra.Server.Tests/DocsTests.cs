using System.Net;
using System.Text;
using System.Text.Json;
using System.IO.Compression;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

public class DocsTests
{
    private static long Docs(IskraServer server, string name = "wiki", string read = "member", string write = "trusted") =>
        server.World.Store.CreateChannel(name, "docs", read, write, 0).Id;

    private static async Task<JsonElement> Create(User user, long channelId, string title, string text = "", long? parentId = null)
    {
        var reply = await user.RequestAsync("docs.page.create", new { channelId, title, text, parentId });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("page");
    }

    private static long Id(JsonElement page) => page.GetProperty("id").GetInt64();
    private static long Version(JsonElement page) => page.GetProperty("version").GetInt64();

    private static async Task<string> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
    }

    [Fact]
    public async Task Docs_channels_let_everyone_read_and_trusted_members_write()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var trusted = await server.JoinAsync("Tess", "trusted");
        using var member = await server.JoinAsync("Bob");

        var channel = (await admin.RequestAsync("channel.create", new { name = "Handbook", kind = "docs" })).Body().GetProperty("channel");
        Assert.Equal("docs", channel.GetProperty("kind").GetString());
        Assert.Equal("member", channel.GetProperty("readRole").GetString());
        Assert.Equal("trusted", channel.GetProperty("writeRole").GetString());
        var wiki = channel.GetProperty("id").GetInt64();

        var page = await Create(trusted, wiki, "  Getting started ", "# Welcome\n\nRead **this** first.\r\n");
        Assert.Equal("Getting started", page.GetProperty("title").GetString());
        Assert.Equal("# Welcome\n\nRead **this** first.", page.GetProperty("text").GetString());
        Assert.Equal(1, Version(page));
        Assert.Equal(trusted.Key, page.GetProperty("createdBy").GetString());
        var seen = (await member.EventAsync("docs.page.updated")).Body().GetProperty("page");
        Assert.Equal(Id(page), Id(seen));
        Assert.False(seen.TryGetProperty("text", out _)); // events carry the summary only

        var listed = (await member.RequestAsync("docs.pages", new { channelId = wiki })).Body().GetProperty("pages");
        Assert.Equal("Getting started", listed.EnumerateArray().Single().GetProperty("title").GetString());
        var got = (await member.RequestAsync("docs.page.get", new { id = Id(page) })).Body().GetProperty("page");
        Assert.Equal("# Welcome\n\nRead **this** first.", got.GetProperty("text").GetString());

        // Members read but don't write; nobody sends chat messages to a docs channel.
        Assert.Equal("forbidden", (await member.RequestAsync("docs.page.create", new { channelId = wiki, title = "Mine" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("docs.page.save", new { id = Id(page), baseVersion = 1, text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await trusted.RequestAsync("chat.send", new { channelId = wiki, text = "hi" })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("docs.pages", new { channelId = server.General })).ErrorCode());

        // The roles are the channel's: an admin can open editing to members.
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = wiki, writeRole = "member" })).Type());
        Assert.Equal("result", (await member.RequestAsync("docs.page.create", new { channelId = wiki, title = "Mine" })).Type());
    }

    [Fact]
    public async Task Hidden_docs_channels_and_their_pages_are_not_found()
    {
        using var server = new IskraServer();
        var staff = Docs(server, "staff", "trusted", "trusted");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Bob");
        var secret = await Create(admin, staff, "Secret plans", "launch codes");
        await member.NoEventAsync("docs.page.updated");

        Assert.Equal("not_found", (await member.RequestAsync("docs.pages", new { channelId = staff })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("docs.page.get", new { id = Id(secret) })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("docs.page.history", new { id = Id(secret) })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("docs.page.get", new { id = Id(secret), version = 1 })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("docs.page.save", new { id = Id(secret), baseVersion = 1, text = "x" })).ErrorCode());
        Assert.Empty((await member.RequestAsync("docs.search", new { query = "launch" })).Body().GetProperty("results").EnumerateArray());
        Assert.Single((await admin.RequestAsync("docs.search", new { query = "launch" })).Body().GetProperty("results").EnumerateArray());

        // "Start here" on a hidden page shows to nobody who can't read it.
        Assert.Equal("forbidden", (await member.RequestAsync("docs.home.set", new { pageId = Id(secret) })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("docs.home.set", new { pageId = Id(secret) })).Type());
        Assert.Equal(JsonValueKind.Null, (await member.EventAsync("docs.home")).Body().GetProperty("home").ValueKind);
        Assert.Equal(Id(secret), (await admin.RequestAsync("docs.home.get")).Body().GetProperty("home").GetProperty("pageId").GetInt64());
    }

    [Fact]
    public async Task Saves_name_their_base_version_and_stale_ones_conflict()
    {
        using var server = new IskraServer();
        var wiki = Docs(server);
        using var anna = await server.JoinAsync("Anna", "trusted");
        using var bo = await server.JoinAsync("Bo", "trusted");
        var page = await Create(anna, wiki, "Rules of the game", "one\ntwo");

        var saved = (await anna.RequestAsync("docs.page.save", new { id = Id(page), baseVersion = 1, text = "one\ntwo\nthree" })).Body().GetProperty("page");
        Assert.Equal(2, Version(saved));
        Assert.Equal(anna.Key, saved.GetProperty("updatedBy").GetString());

        // Bo started from version 1: his save conflicts and changes nothing.
        var stale = await bo.RequestAsync("docs.page.save", new { id = Id(page), baseVersion = 1, text = "zero\none\ntwo" });
        Assert.Equal("conflict", stale.ErrorCode());
        Assert.Equal("one\ntwo\nthree", (await bo.RequestAsync("docs.page.get", new { id = Id(page) })).Body().GetProperty("page").GetProperty("text").GetString());

        // Saving again from the current version works; saving the same content doesn't make a version.
        var merged = (await bo.RequestAsync("docs.page.save", new { id = Id(page), baseVersion = 2, title = "Rules", text = "zero\none\ntwo\nthree" })).Body().GetProperty("page");
        Assert.Equal(3, Version(merged));
        Assert.Equal("Rules", merged.GetProperty("title").GetString());
        Assert.Equal(3, Version((await bo.RequestAsync("docs.page.save", new { id = Id(page), baseVersion = 3, text = "zero\none\ntwo\nthree" })).Body().GetProperty("page")));

        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.save", new { id = Id(page), text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.save", new { id = Id(page), baseVersion = 3 })).ErrorCode());
        Assert.Equal("not_found", (await bo.RequestAsync("docs.page.save", new { id = 9999, baseVersion = 1, text = "x" })).ErrorCode());
    }

    [Fact]
    public async Task History_keeps_revisions_and_restore_makes_a_new_version()
    {
        using var server = new IskraServer();
        var wiki = Docs(server);
        using var anna = await server.JoinAsync("Anna", "trusted");
        using var bo = await server.JoinAsync("Bo", "trusted");
        var id = Id(await Create(anna, wiki, "Notes", "first"));
        await anna.RequestAsync("docs.page.save", new { id, baseVersion = 1, text = "second" });
        await anna.RequestAsync("docs.page.save", new { id, baseVersion = 2, text = "third" }); // same person, moments later: replaces v2
        await bo.RequestAsync("docs.page.save", new { id, baseVersion = 3, text = "fourth" });

        var history = (await bo.RequestAsync("docs.page.history", new { id })).Body().GetProperty("revisions").EnumerateArray().ToList();
        Assert.Equal([4L, 3L, 1L], history.Select(r => r.GetProperty("version").GetInt64()));
        Assert.Equal([bo.Key, anna.Key, anna.Key], history.Select(r => r.GetProperty("author").GetString()));
        var old = (await bo.RequestAsync("docs.page.get", new { id, version = 1 })).Body().GetProperty("revision");
        Assert.Equal("first", old.GetProperty("text").GetString());

        // Restoring needs the current version too, and is a save like any other.
        Assert.Equal("conflict", (await bo.RequestAsync("docs.page.restore", new { id, version = 1, baseVersion = 3 })).ErrorCode());
        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.restore", new { id, version = 4, baseVersion = 4 })).ErrorCode());
        Assert.Equal("not_found", (await bo.RequestAsync("docs.page.restore", new { id, version = 2, baseVersion = 4 })).ErrorCode());
        var restored = (await bo.RequestAsync("docs.page.restore", new { id, version = 1, baseVersion = 4 })).Body().GetProperty("page");
        Assert.Equal(5, Version(restored));
        Assert.Equal("first", restored.GetProperty("text").GetString());
        var latest = (await bo.RequestAsync("docs.page.history", new { id })).Body().GetProperty("revisions")[0];
        Assert.Equal(1, latest.GetProperty("restoredFrom").GetInt64());

        // Revisions are capped.
        for (var v = 5; v < 5 + Iskra.Server.Storage.Store.MaxDocRevisions + 3; v++)
            server.World.Store.SaveDocPage(id, v, "Notes", $"v{v + 1}", [], v % 2 == 0 ? anna.Key : bo.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Assert.Equal(Iskra.Server.Storage.Store.MaxDocRevisions,
            (await bo.RequestAsync("docs.page.history", new { id })).Body().GetProperty("revisions").GetArrayLength());

        var audit = (await server.JoinAsync("Admin", "admin")).RequestAsync("audit.list", new { action = "docs.page.restore" });
        var entry = (await audit).Body().GetProperty("entries")[0];
        Assert.Equal(bo.Key, entry.GetProperty("actor").GetString());
        Assert.Equal(id, entry.GetProperty("details").GetProperty("pageId").GetInt64());
    }

    [Fact]
    public async Task Pages_nest_one_level_and_can_be_moved_and_deleted()
    {
        using var server = new IskraServer();
        var wiki = Docs(server);
        var other = Docs(server, "other");
        using var anna = await server.JoinAsync("Anna", "trusted");
        using var bo = await server.JoinAsync("Bo", "trusted");
        using var admin = await server.JoinAsync("Admin", "admin");
        var guide = Id(await Create(anna, wiki, "Guide"));
        var faq = Id(await Create(anna, wiki, "FAQ"));
        var setup = Id(await Create(anna, wiki, "Setup", parentId: guide));
        var elsewhere = Id(await Create(anna, other, "Elsewhere"));

        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.create", new { channelId = wiki, title = "Deep", parentId = setup })).ErrorCode());
        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.create", new { channelId = wiki, title = "Far", parentId = elsewhere })).ErrorCode());
        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.move", new { id = guide, parentId = faq })).ErrorCode()); // has a sub-page
        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.move", new { id = faq, parentId = faq })).ErrorCode());

        // FAQ before Guide at the top; then Setup to the top level, last.
        Assert.Equal("result", (await bo.RequestAsync("docs.page.move", new { id = faq, before = guide })).Type());
        Assert.Equal("result", (await bo.RequestAsync("docs.page.move", new { id = setup })).Type());
        var pages = (await bo.RequestAsync("docs.pages", new { channelId = wiki })).Body().GetProperty("pages").EnumerateArray()
            .OrderBy(p => p.GetProperty("position").GetInt32()).Select(p => p.GetProperty("title").GetString()).ToList();
        Assert.Equal(["FAQ", "Guide", "Setup"], pages);

        // Sub-pages go with their page. Bo isn't the author but trusted writers moderate.
        Assert.Equal("result", (await bo.RequestAsync("docs.page.move", new { id = setup, parentId = guide })).Type());
        Assert.Equal("result", (await admin.RequestAsync("docs.home.set", new { pageId = setup })).Type());
        Assert.Equal("result", (await bo.RequestAsync("docs.page.delete", new { id = guide })).Type());
        var deleted = (await anna.EventAsync("docs.page.deleted")).Body();
        Assert.Equal([guide, setup], deleted.GetProperty("ids").EnumerateArray().Select(i => i.GetInt64()).Order());
        Assert.Equal("not_found", (await anna.RequestAsync("docs.page.get", new { id = setup })).ErrorCode());
        Assert.Equal(JsonValueKind.Null, (await anna.RequestAsync("docs.home.get")).Body().GetProperty("home").ValueKind);
        Assert.Equal(guide, (await admin.RequestAsync("audit.list", new { action = "docs.page.delete" })).Body().GetProperty("entries")[0]
            .GetProperty("details").GetProperty("pageId").GetInt64());
    }

    [Fact]
    public async Task Members_who_can_write_only_delete_their_own_pages()
    {
        using var server = new IskraServer();
        var wiki = Docs(server, write: "member");
        using var anna = await server.JoinAsync("Anna");
        using var bo = await server.JoinAsync("Bo");
        var page = Id(await Create(anna, wiki, "Anna's page"));
        Assert.Equal("forbidden", (await bo.RequestAsync("docs.page.delete", new { id = page })).ErrorCode());
        Assert.Equal("result", (await anna.RequestAsync("docs.page.delete", new { id = page })).Type());
    }

    [Fact]
    public async Task Pages_have_size_and_count_limits_and_long_ones_come_as_a_file()
    {
        using var server = new IskraServer();
        var wiki = Docs(server);
        using var anna = await server.JoinAsync("Anna", "trusted");
        using var bo = await server.JoinAsync("Bo", "trusted");

        Assert.Equal("bad_request", (await anna.RequestAsync("docs.page.create", new { channelId = wiki, title = "" })).ErrorCode());
        Assert.Equal("bad_request", (await anna.RequestAsync("docs.page.create", new { channelId = wiki, title = new string('t', 101) })).ErrorCode());

        // Exactly 100 KB fits (as a file: it's bigger than a socket frame); one byte more doesn't.
        var exactly = "# Big\n" + new string('a', 100 * 1024 - 6);
        Assert.Equal(100 * 1024, Encoding.UTF8.GetByteCount(exactly));
        var file = await Upload(server, anna, Encoding.UTF8.GetBytes(exactly), "page.md");
        var big = (await anna.RequestAsync("docs.page.create", new { channelId = wiki, title = "Big", file })).Body().GetProperty("page");
        Assert.Equal(100 * 1024, big.GetProperty("size").GetInt32());
        var tooBig = await Upload(server, anna, Encoding.UTF8.GetBytes(exactly + "b"), "page.md");
        Assert.Equal("bad_request", (await anna.RequestAsync("docs.page.save", new { id = Id(big), baseVersion = 1, file = tooBig })).ErrorCode());
        var notText = await Upload(server, anna, [0x23, 0x20, 0xFF, 0xFE], "page.md");
        Assert.Equal("bad_request", (await anna.RequestAsync("docs.page.save", new { id = Id(big), baseVersion = 1, file = notText })).ErrorCode());
        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.save", new { id = Id(big), baseVersion = 1, file })).ErrorCode()); // not Bo's upload

        // Invisible characters (a bidi override) are dropped, not refused.
        var cleaned = (await anna.RequestAsync("docs.page.save", new { id = Id(big), baseVersion = 1, text = "safe‮txt.exe\u0007" })).Body().GetProperty("page");
        Assert.Equal("safetxt.exe", cleaned.GetProperty("text").GetString());

        // 500 pages per channel.
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        for (var i = server.World.Store.DocPageCount(wiki); i < 500; i++) server.World.Store.CreateDocPage(wiki, null, $"p{i}", "", [], anna.Key, now);
        Assert.Equal("bad_request", (await bo.RequestAsync("docs.page.create", new { channelId = wiki, title = "One more" })).ErrorCode());
    }

    [Fact]
    public async Task Search_finds_pages_by_title_and_text()
    {
        using var server = new IskraServer();
        var wiki = Docs(server);
        var faq = Docs(server, "faq");
        using var anna = await server.JoinAsync("Anna", "trusted");
        await Create(anna, wiki, "Minecraft server", "The address is mc.example.com and the whitelist is open.");
        await Create(anna, wiki, "Movie night", "Fridays at eight. Bring snacks.");
        await Create(anna, faq, "Snacks policy", "Crisps only.");

        var hits = (await anna.RequestAsync("docs.search", new { query = "whitelist" })).Body().GetProperty("results").EnumerateArray().ToList();
        Assert.Equal("Minecraft server", hits.Single().GetProperty("page").GetProperty("title").GetString());
        var snippet = hits[0].GetProperty("snippet").GetString()!;
        var match = hits[0].GetProperty("matches")[0];
        Assert.Equal("whitelist", snippet.Substring(match[0].GetInt32(), match[1].GetInt32()));

        var snacks = (await anna.RequestAsync("docs.search", new { query = "snack" })).Body().GetProperty("results").EnumerateArray().ToList();
        Assert.Equal(2, snacks.Count);
        Assert.Equal("Snacks policy", snacks[0].GetProperty("page").GetProperty("title").GetString()); // titles count more
        var inOne = (await anna.RequestAsync("docs.search", new { query = "snack", channelId = wiki })).Body().GetProperty("results");
        Assert.Equal("Movie night", inOne.EnumerateArray().Single().GetProperty("page").GetProperty("title").GetString());

        // Edits are indexed; deleted pages go.
        var movie = (await anna.RequestAsync("docs.search", new { query = "fridays" })).Body().GetProperty("results")[0].GetProperty("page");
        await anna.RequestAsync("docs.page.save", new { id = Id(movie), baseVersion = 1, text = "Saturdays now." });
        Assert.Empty((await anna.RequestAsync("docs.search", new { query = "fridays" })).Body().GetProperty("results").EnumerateArray());
        await anna.RequestAsync("docs.page.delete", new { id = Id(movie) });
        Assert.Empty((await anna.RequestAsync("docs.search", new { query = "saturdays" })).Body().GetProperty("results").EnumerateArray());
        Assert.Equal("bad_request", (await anna.RequestAsync("docs.search", new { query = "  " })).ErrorCode());
    }

    [Fact]
    public async Task AutoMod_timeouts_and_rules_apply_to_pages()
    {
        using var server = new IskraServer();
        var wiki = Docs(server, write: "member");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var page = Id(await Create(bob, wiki, "Hello", "hi"));

        Assert.Equal("result", (await admin.RequestAsync("automod.update", new
        {
            automod = new { enabled = true, words = new { enabled = true, blocked = new[] { "badword" } } },
        })).Type());
        Assert.Equal("automod", (await bob.RequestAsync("docs.page.save", new { id = page, baseVersion = 1, text = "a badword here" })).ErrorCode());
        Assert.Equal("automod", (await bob.RequestAsync("docs.page.create", new { channelId = wiki, title = "badword" })).ErrorCode());
        var block = (await admin.RequestAsync("audit.list", new { action = "automod.block" })).Body().GetProperty("entries")[0];
        Assert.Equal("page", block.GetProperty("details").GetProperty("what").GetString());

        Assert.Equal("result", (await admin.RequestAsync("member.timeout", new { accountKey = bob.Key, durationMs = 60_000 })).Type());
        Assert.Equal("forbidden", (await bob.RequestAsync("docs.page.save", new { id = page, baseVersion = 1, text = "fine" })).ErrorCode());
    }

    [Fact]
    public async Task Pictures_in_pages_survive_the_upload_sweep()
    {
        using var server = new IskraServer();
        var wiki = Docs(server);
        using var anna = await server.JoinAsync("Anna", "trusted");
        var shown = await Upload(server, anna, [1, 2, 3, 4], "map.bin");
        var unused = await Upload(server, anna, [5, 6, 7, 8], "other.bin");
        await Create(anna, wiki, "Map", $"![map](/files/{shown}/map.bin)");

        var uploads = server.Services.GetRequiredService<Uploads>();
        uploads.Sweep(DateTimeOffset.UtcNow.AddHours(25));
        var http = server.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync($"/files/{shown}/x")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/files/{unused}/x")).StatusCode);
    }

    [Fact]
    public async Task Pages_are_in_the_data_export_follow_retention_and_lose_a_deleted_authors_name()
    {
        using var server = new IskraServer();
        var wiki = Docs(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var anna = await server.JoinAsync("Anna", "trusted");
        using var bo = await server.JoinAsync("Bo", "trusted");
        var id = Id(await Create(anna, wiki, "Raid plan", "anna's first draft"));
        await bo.RequestAsync("docs.page.save", new { id, baseVersion = 1, text = "bo's edit" });
        await anna.RequestAsync("docs.page.save", new { id, baseVersion = 2, text = "anna again" });

        // "Download my data" has the pages Anna made and every version she wrote.
        var made = (await anna.RequestAsync("data.export")).Body();
        using (var response = await server.CreateClient().GetAsync(made.GetProperty("url").GetString()))
        using (var zip = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync())))
        using (var json = zip.GetEntry("data.json")!.Open())
        {
            var data = JsonDocument.Parse(json).RootElement;
            Assert.Equal("Raid plan", data.GetProperty("docsPages")[0].GetProperty("title").GetString());
            Assert.Equal(["anna's first draft", "anna again"],
                data.GetProperty("docsRevisions").EnumerateArray().Select(r => r.GetProperty("text").GetString()));
        }

        // Retention: old revisions go with old messages, but never a page's current version.
        var old = DateTimeOffset.UtcNow.AddDays(-40).ToUnixTimeMilliseconds();
        using (var db = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={Path.Combine(server.WorldPath, "iskra.db")};Pooling=False"))
        {
            db.Open();
            using var cmd = db.CreateCommand();
            cmd.CommandText = $"UPDATE doc_revisions SET created_at = {old};";
            cmd.ExecuteNonQuery();
        }
        await owner.RequestAsync("retention.update", new { messagesDays = 30 });
        server.Services.GetServices<IHostedService>().OfType<RetentionSweeper>().Single().Sweep();
        var left = (await bo.RequestAsync("docs.page.history", new { id })).Body().GetProperty("revisions");
        Assert.Equal(3, left.EnumerateArray().Single().GetProperty("version").GetInt64());

        // Anna deletes her account with her messages: the page stays, without her name on it.
        await bo.RequestAsync("docs.page.save", new { id, baseVersion = 3, text = "bo's version" });
        var at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var sig = Ed25519.Sign(anna.Identity.Account, Ed25519.Payload(AccountFeature.DeleteContext, Ed25519.PublicKeyOf(anna.Identity.Account),
            Ed25519.U64BigEndian(at), [1]));
        Assert.Equal("result", (await anna.RequestAsync("account.delete", new
        {
            deletion = new { accountKey = anna.Key, deletedAt = at, messages = true, sig = Ed25519.ToB64u(sig) },
        })).Type());
        var page = (await bo.RequestAsync("docs.page.get", new { id })).Body().GetProperty("page");
        Assert.Equal("bo's version", page.GetProperty("text").GetString());
        Assert.Equal("", page.GetProperty("createdBy").GetString());
        var history = (await bo.RequestAsync("docs.page.history", new { id })).Body().GetProperty("revisions").EnumerateArray().ToList();
        Assert.Equal([4L], history.Select(r => r.GetProperty("version").GetInt64())); // Anna's older version went
    }
}
