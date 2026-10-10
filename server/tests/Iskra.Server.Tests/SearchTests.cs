using System.Text.Json;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Tests;

public class SearchTests
{
    private static long Post(IskraServer server, string author, string text, long? channel = null, long? at = null, string[]? files = null) =>
        server.World.Store.AddMessage(channel ?? server.General, author, text, at ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), files).Id;

    private static async Task<JsonElement> Search(User user, object body)
    {
        var reply = await user.RequestAsync("search", body);
        // Searches are rate limited (burst 10, then 2/s); wait it out rather than spreading tests over users.
        for (var i = 0; i < 5 && reply.ErrorCode() == "rate_limited"; i++)
        {
            await Task.Delay(600);
            reply = await user.RequestAsync("search", body);
        }
        Assert.True(reply.Type() == "result", reply.ToString());
        return reply.Body();
    }

    private static List<string?> Texts(JsonElement result) =>
        result.GetProperty("results").EnumerateArray().Select(r => r.GetProperty("message").GetProperty("text").GetString()).ToList();

    [Fact]
    public async Task Finds_words_by_prefix_and_reports_where_they_matched()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Post(server, alice.Key, "Anyone up for Minecraft tonight?");
        Post(server, alice.Key, "Café at noon, then minecraft");
        Post(server, alice.Key, "unrelated");

        var result = await Search(alice, new { query = "minec" });
        Assert.Equal(2, result.GetProperty("total").GetInt32());
        Assert.Equal(["Café at noon, then minecraft", "Anyone up for Minecraft tonight?"], Texts(result)); // newest first
        var match = result.GetProperty("results")[1].GetProperty("matches")[0];
        Assert.Equal(14, match[0].GetInt32());
        Assert.Equal(9, match[1].GetInt32());

        // Accents don't matter; every word must match.
        Assert.Equal(["Café at noon, then minecraft"], Texts(await Search(alice, new { query = "cafe minecraft" })));
        Assert.Empty(Texts(await Search(alice, new { query = "cafe tonight" })));
    }

    [Theory]
    [InlineData("\"")]
    [InlineData("NEAR(a b)")]
    [InlineData("a OR b AND NOT c")]
    [InlineData("* - ^ :")]
    [InlineData("col:value")]
    public async Task Search_syntax_in_user_text_is_just_text(string query)
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Post(server, alice.Key, "hello world");
        var reply = await alice.RequestAsync("search", new { query });
        Assert.True(reply.Type() == "result" || reply.ErrorCode() == "bad_request");
        Assert.Equal("result", (await alice.RequestAsync("ping")).Type());
    }

    [Fact]
    public async Task Never_returns_messages_from_channels_you_cannot_read()
    {
        using var server = new IskraServer();
        var staff = server.World.Store.CreateChannel("staff", "text", "trusted", "trusted", 0).Id;
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob", "trusted");
        Post(server, owner.Key, "the secret plan", staff);
        Post(server, owner.Key, "the public plan");
        var root = Post(server, owner.Key, "staff thread root", staff);
        var thread = (await owner.RequestAsync("thread.create", new { messageId = root, name = "plans" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        Post(server, owner.Key, "secret plan inside a thread", thread);

        Assert.Equal(3, (await Search(bob, new { query = "plan" })).GetProperty("total").GetInt32());

        // Demoted: the private channel and its thread drop out of results at once.
        await owner.RequestAsync("member.setRole", new { accountKey = bob.Key, role = "member" });
        var after = await Search(bob, new { query = "plan" });
        Assert.Equal(["the public plan"], Texts(after));
        Assert.Equal(1, after.GetProperty("total").GetInt32());
        Assert.Empty(Texts(await Search(bob, new { query = "secret" })));
        Assert.Equal("not_found", (await bob.RequestAsync("search", new { query = "plan", channelId = staff })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("search", new { query = "plan", channelId = thread })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("chat.history", new { channelId = staff, around = root })).ErrorCode());
    }

    [Fact]
    public async Task Index_stays_in_sync_with_edits_and_deletes()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "I like apples" }))
            .Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Single(Texts(await Search(admin, new { query = "apples" })));

        await admin.RequestAsync("chat.edit", new { id, text = "I like bananas" });
        Assert.Empty(Texts(await Search(admin, new { query = "apples" })));
        Assert.Equal(["I like bananas"], Texts(await Search(admin, new { query = "bananas" })));

        await admin.RequestAsync("chat.delete", new { id });
        Assert.Empty(Texts(await Search(admin, new { query = "bananas" })));

        // Deleting a channel takes its messages out of the index too.
        var channel = (await admin.RequestAsync("channel.create", new { name = "temp" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Post(server, admin.Key, "ephemeral words", channel);
        Assert.Single(Texts(await Search(admin, new { query = "ephemeral" })));
        await admin.RequestAsync("channel.delete", new { id = channel });
        Assert.Empty(Texts(await Search(admin, new { query = "ephemeral" })));
        var count = server.World.Store.Search(new SearchQuery(["ephemeral"], [channel], null, false, false, null, null, null, 10)).Total;
        Assert.Equal(0, count);
    }

    [Fact]
    public async Task Filters_and_paging()
    {
        using var server = new IskraServer();
        var games = server.World.Store.CreateChannel("games", "text", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var day = 86_400_000L;
        Post(server, alice.Key, "plan one", at: 10 * day);
        Post(server, bob.Key, "plan two https://example.com", at: 11 * day);
        Post(server, bob.Key, "plan three", channel: games, at: 12 * day);
        server.World.Store.AddFile(new StoredFile("f1", "sha", "a.png", 1, "image/png", 1, 1, bob.Key, 0));
        Post(server, bob.Key, "plan four with a file", at: 13 * day, files: ["f1"]);

        Assert.Equal(3, (await Search(alice, new { query = "plan", author = bob.Key })).GetProperty("total").GetInt32());
        Assert.Equal(["plan three"], Texts(await Search(alice, new { query = "plan", channelId = games })));
        Assert.Equal(["plan two https://example.com"], Texts(await Search(alice, new { query = "plan", has = new[] { "link" } })));
        Assert.Equal(["plan four with a file"], Texts(await Search(alice, new { has = new[] { "file" } })));
        Assert.Equal(["plan two https://example.com", "plan one"], Texts(await Search(alice, new { query = "plan", before = 12 * day })));
        Assert.Equal(["plan four with a file", "plan three"], Texts(await Search(alice, new { query = "plan", after = 12 * day })));
        Assert.Equal("bad_request", (await alice.RequestAsync("search", new { has = new[] { "pdf" } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("search", new { query = "   " })).ErrorCode());

        var first = await Search(alice, new { query = "plan", limit = 3 });
        Assert.True(first.GetProperty("hasMore").GetBoolean());
        var last = first.GetProperty("results")[2].GetProperty("message").GetProperty("id").GetInt64();
        var second = await Search(alice, new { query = "plan", limit = 3, cursor = last });
        Assert.Equal(["plan one"], Texts(second));
        Assert.False(second.GetProperty("hasMore").GetBoolean());
    }

    [Fact]
    public async Task History_around_a_message()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var ids = Enumerable.Range(0, 30).Select(i => Post(server, alice.Key, $"m{i}")).ToList();

        var window = (await alice.RequestAsync("chat.history", new { channelId = server.General, around = ids[10], limit = 10 })).Body();
        var got = window.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("id").GetInt64()).ToList();
        Assert.Equal(ids[6..16], got);
        Assert.True(window.GetProperty("hasMore").GetBoolean());
        Assert.True(window.GetProperty("hasNewer").GetBoolean());

        var end = (await alice.RequestAsync("chat.history", new { channelId = server.General, around = ids[28], limit = 10 })).Body();
        Assert.False(end.GetProperty("hasNewer").GetBoolean());
        Assert.Equal(ids[^1], end.GetProperty("messages").EnumerateArray().Last().GetProperty("id").GetInt64());

        var other = server.World.Store.CreateChannel("other", "text", "member", "member", 0).Id;
        Assert.Equal("not_found", (await alice.RequestAsync("chat.history", new { channelId = other, around = ids[3] })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.history", new { channelId = server.General, around = ids[3], before = ids[5] })).ErrorCode());
    }

    [Fact]
    public void Migration_indexes_existing_messages()
    {
        var path = Path.Combine(Path.GetTempPath(), $"iskra-fts-{Guid.NewGuid():N}.db");
        try
        {
            using (var store = Store.Open(path))
            {
                store.AddMessage(1, "a", "older message about dragons", 1);
            }
            // Pretend the index never existed (a database from before search).
            using (var db = new SqliteConnection($"Data Source={path};Pooling=False"))
            {
                db.Open();
                using var cmd = db.CreateCommand();
                cmd.CommandText = """
                    DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete; DROP TRIGGER messages_fts_update;
                    DROP TABLE messages_fts; DELETE FROM migrations WHERE name = 'search-1';
                    """;
                cmd.ExecuteNonQuery();
            }
            using (var store = Store.Open(path))
            {
                var (hits, _) = store.Search(new SearchQuery(["dragons"], [1], null, false, false, null, null, null, 10));
                Assert.Single(hits);
            }
        }
        finally
        {
            foreach (var f in new[] { path, path + "-wal", path + "-shm" }) File.Delete(f);
        }
    }

    [Fact]
    public void Match_ranges_come_from_highlight_markers()
    {
        Assert.Equal([(0, 5), (10, 3)], Store.MatchRanges("\u0001hello\u0002 big \u0001cat\u0002"));
        Assert.Empty(Store.MatchRanges("no markers"));
    }

    [Fact]
    public async Task Totals_stop_counting_at_a_thousand()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        for (var i = 0; i < Store.MaxCountedTotal + 5; i++) Post(server, alice.Key, $"plan number {i}");
        var result = await Search(alice, new { query = "plan", limit = 5 });
        Assert.Equal(Store.MaxCountedTotal, result.GetProperty("total").GetInt32());
        Assert.True(result.GetProperty("totalCapped").GetBoolean());
        Assert.Equal(5, Texts(result).Count);

        var few = await Search(alice, new { query = "number 7" });
        Assert.False(few.GetProperty("totalCapped").GetBoolean());
    }

    [Fact]
    public async Task Many_readable_channels_are_searched_in_one_go()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        // More channels than SQLite would take as separate parameters in older builds (999).
        for (var i = 0; i < 1200; i++) server.World.Store.CreateChannel($"c{i}", "text", "member", "member", i + 10);
        var last = server.World.Store.AllChannels().Last().Id;
        Post(server, alice.Key, "needle in the last channel", last);
        Assert.Equal(["needle in the last channel"], Texts(await Search(alice, new { query = "needle" })));
    }
}
