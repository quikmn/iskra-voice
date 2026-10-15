using System.Text.Json;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Tests;

/// <summary>
/// Ids are never handed out twice, and nothing of a deleted channel reaches a later one. Regression: deleting the
/// newest channel and creating one gave the new channel the old id, and devices showed the old channel's messages in it.
/// </summary>
public class IdReuseTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static long Id(JsonElement reply, string field) => reply.Body().GetProperty(field).GetProperty("id").GetInt64();

    [Fact]
    public async Task A_deleted_channels_id_is_never_given_to_a_new_channel()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");

        var ci = Id(await owner.RequestAsync("channel.create", new { name = "ci" }), "channel");
        Assert.Equal("result", (await owner.RequestAsync("channel.delete", new { id = ci })).Type());
        var created = await owner.RequestAsync("channel.create", new { name = "renewals" });
        Assert.True(Id(created, "channel") > ci);
        // The channel says when it was made, so a device can tell its cache of an older channel apart.
        Assert.True(created.Body().GetProperty("channel").GetProperty("createdAt").GetInt64() > 0);

        // Threads are channels too.
        var root = (await owner.RequestAsync("chat.send", new { channelId = server.General, text = "root" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        var thread = server.World.Store.CreateThread(server.World.Store.GetChannel(server.General)!, root, "t", owner.Key, Now).Id;
        server.World.Store.DeleteChannel(thread);
        Assert.True(server.World.Store.CreateChannel("after-thread", "text", "member", "member", Now).Id > thread);
    }

    [Fact]
    public async Task A_deleted_categorys_id_is_never_given_to_a_new_category()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");

        var games = Id(await owner.RequestAsync("category.create", new { name = "Games" }), "category");
        Assert.Equal("result", (await owner.RequestAsync("category.delete", new { id = games })).Type());
        Assert.True(Id(await owner.RequestAsync("category.create", new { name = "Work" }), "category") > games);
    }

    [Fact]
    public void Ids_stay_unused_across_a_restart()
    {
        var path = Path.Combine(Path.GetTempPath(), $"iskra-ids-{Guid.NewGuid():N}.db");
        try
        {
            long channel, category, page;
            using (var store = Store.Open(path))
            {
                channel = store.CreateChannel("ci", "text", "member", "member", 1).Id;
                category = store.CreateCategory("Old").Id;
                var docs = store.CreateChannel("docs", "docs", "member", "member", 1).Id;
                page = store.CreateDocPage(docs, null, "p", "", [], "a", 1).Id;
                store.DeleteDocPage(page);
                store.DeleteCategory(category);
                store.DeleteChannel(channel);
            }
            using (var store = Store.Open(path))
            {
                Assert.True(store.CreateChannel("renewals", "text", "member", "member", 2).Id > channel + 1); // above the docs channel too
                Assert.True(store.CreateCategory("New").Id > category);
                var docs = store.AllChannels().Single(c => c.Name == "docs").Id;
                Assert.True(store.CreateDocPage(docs, null, "q", "", [], "a", 2).Id > page);
            }
        }
        finally
        {
            foreach (var f in new[] { path, path + "-wal", path + "-shm" }) File.Delete(f);
        }
    }

    [Fact]
    public void Every_table_with_its_own_integer_ids_never_reuses_them()
    {
        var path = Path.Combine(Path.GetTempPath(), $"iskra-ids-{Guid.NewGuid():N}.db");
        try
        {
            using (Store.Open(path)) { }
            using var db = new SqliteConnection($"Data Source={path};Pooling=False");
            db.Open();
            var floored = new HashSet<string>();
            using (var cmd = db.CreateCommand())
            {
                cmd.CommandText = "SELECT name FROM id_floors;";
                using var r = cmd.ExecuteReader();
                while (r.Read()) floored.Add(r.GetString(0));
            }
            var tables = new List<(string Name, string Sql)>();
            using (var cmd = db.CreateCommand())
            {
                // Full-text search keeps its own internal tables (named *_fts_*): not ids anyone sees.
                cmd.CommandText = "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT GLOB '*_fts_*';";
                using var r = cmd.ExecuteReader();
                while (r.Read()) tables.Add((r.GetString(0), r.GetString(1)));
            }
            // A table whose primary key is its own "id INTEGER PRIMARY KEY" (not a CHECK (id = 1) singleton) must not
            // let SQLite reuse ids: AUTOINCREMENT, or a floor in id_floors.
            var plain = tables.Where(t => System.Text.RegularExpressions.Regex.IsMatch(t.Sql, @"\bid\s+INTEGER\s+PRIMARY\s+KEY(?!\s+(AUTOINCREMENT|CHECK))"))
                .Select(t => t.Name).ToList();
            Assert.NotEmpty(plain);
            Assert.All(plain, name => Assert.True(floored.Contains(name), $"{name} reuses ids"));
        }
        finally
        {
            foreach (var f in new[] { path, path + "-wal", path + "-shm" }) File.Delete(f);
        }
    }

    [Fact]
    public async Task Nothing_of_a_deleted_channel_reaches_a_channel_that_gets_its_id()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var store = server.World.Store;

        var ci = Id(await owner.RequestAsync("channel.create", new { name = "ci", slowmode = 30, topic = "builds" }), "channel");
        var sent = await owner.RequestAsync("chat.send", new { channelId = ci, text = "secretbuildtoken leaked here" });
        var message = sent.Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("chat.pin", new { id = message })).Type());
        Assert.Equal("result", (await bob.RequestAsync("notify.set", new { channelId = ci, level = "all" })).Type());
        Assert.Equal("result", (await owner.RequestAsync("scheduled.create", new { channelId = ci, text = "for ci only", sendAt = Now + 3_600_000 })).Type());
        store.AddReminder(owner.Key, Now + 3_600_000, "{}", ci, message, Now);
        var hook = await owner.RequestAsync("outhook.create", new
        {
            name = "Bridge", url = "https://example.com/hook", events = new[] { "message.created" }, channelIds = new[] { server.General, ci },
        });
        Assert.Equal("result", hook.Type());
        Assert.Equal("result", (await owner.RequestAsync("automod.update", new
        {
            automod = new
            {
                enabled = true, words = new { enabled = false }, mentions = new { enabled = false }, flood = new { enabled = false },
                duplicates = new { enabled = false }, links = new { enabled = false }, exemptRoles = Array.Empty<long>(),
                exemptChannels = new[] { ci }, alertChannelId = ci,
            },
        })).Type());

        Assert.Equal("result", (await owner.RequestAsync("channel.delete", new { id = ci })).Type());

        // Prove the cleanup on its own: put a channel back under the old id behind the server's back.
        ComplianceTests.Sql(server, "INSERT INTO channels (id, name, kind, position, read_role, write_role, created_at) VALUES ($id, 'reused', 'text', 50, 'member', 'member', $now);",
            ("$id", ci), ("$now", Now));
        Assert.NotNull(store.GetChannel(ci));

        Assert.Equal(0, (await owner.RequestAsync("chat.history", new { channelId = ci })).Body().GetProperty("messages").GetArrayLength());
        Assert.Equal(0, (await owner.RequestAsync("pin.list", new { channelId = ci })).Body().GetProperty("pins").GetArrayLength());
        var search = await owner.RequestAsync("search", new { query = "secretbuildtoken" });
        Assert.Equal(0, search.Body().GetProperty("results").GetArrayLength());
        Assert.Equal(0, store.Slowmode(ci));
        Assert.Equal("", store.Topic(ci));
        Assert.DoesNotContain(store.NotifySettings(bob.Key), n => n.ChannelId == ci);
        Assert.DoesNotContain(store.ScheduledOf(owner.Key), m => m.ChannelId == ci);
        Assert.All(store.Reminders(owner.Key), r => Assert.Null(r.ChannelId));
        Assert.Equal([server.General], store.OutgoingWebhooks().Single().ChannelIds);
        using (var config = JsonDocument.Parse(store.AutoModConfig()!))
        {
            Assert.Equal(0, config.RootElement.GetProperty("exemptChannels").GetArrayLength());
            Assert.Equal(JsonValueKind.Null, config.RootElement.GetProperty("alertChannelId").ValueKind);
        }
    }

    [Fact]
    public void Existing_worlds_get_a_floor_above_every_id_still_named_and_lose_leftovers()
    {
        var path = Path.Combine(Path.GetTempPath(), $"iskra-ids-{Guid.NewGuid():N}.db");
        try
        {
            long keep;
            using (var store = Store.Open(path))
            {
                keep = store.CreateChannel("keep", "text", "member", "member", 1).Id;
                store.AddMessage(keep, "a", "stays", 1);
            }
            // A world from before this version, where channel 9 was deleted but rows still name it.
            using (var db = new SqliteConnection($"Data Source={path};Pooling=False"))
            {
                db.Open();
                using var cmd = db.CreateCommand();
                cmd.CommandText = $"""
                    PRAGMA foreign_keys = OFF;
                    DROP TRIGGER id_floor_channels; DROP TRIGGER id_floor_categories; DROP TRIGGER id_floor_doc_pages;
                    DROP TRIGGER id_floor_events; DROP TRIGGER id_floor_forum_tags; DROP TRIGGER id_floor_team_splits;
                    DROP TRIGGER channel_gone_cleanup; DROP TABLE id_floors; DELETE FROM migrations WHERE name = 'id-floors-1';
                    INSERT INTO messages (channel_id, author_key, text, created_at) VALUES (9, 'a', 'orphaneddragon', 1);
                    INSERT INTO notify_settings (account_key, channel_id, level) VALUES ('a', 9, 'all');
                    INSERT INTO notify_settings (account_key, channel_id, level) VALUES ('a', 0, 'all');
                    INSERT INTO channel_topics (channel_id, topic) VALUES (9, 'old');
                    INSERT INTO scheduled_messages (account_key, kind, channel_id, text, send_at, created_at, status) VALUES ('a', 'channel', 9, 'x', 1, 1, 'pending');
                    INSERT INTO outgoing_webhooks (id, name, url, events, channels, secret, created_by, created_at)
                        VALUES ('h', 'n', 'https://example.com/', '["message.created"]', '[{keep},9]', 's', 'a', 1);
                    INSERT INTO automod (id, config, updated_at) VALUES (1, '{"{"}"enabled":true,"exemptChannels":[9,{keep}],"alertChannelId":9{"}"}', 1);
                    """;
                cmd.ExecuteNonQuery();
            }
            using (var store = Store.Open(path))
            {
                Assert.True(store.CreateChannel("new", "text", "member", "member", 2).Id > 9);
                Assert.Equal(["stays"], store.History(keep, null, null, 10).Select(m => m.Text));
                Assert.Equal([keep], store.OutgoingWebhooks().Single().ChannelIds);
                Assert.Empty(store.ScheduledOf("a"));
                Assert.Single(store.NotifySettings("a")); // the server-wide one stays
                Assert.Equal("", store.Topic(9));
                using var config = JsonDocument.Parse(store.AutoModConfig()!);
                Assert.Equal([keep], config.RootElement.GetProperty("exemptChannels").EnumerateArray().Select(e => e.GetInt64()));
                Assert.Equal(JsonValueKind.Null, config.RootElement.GetProperty("alertChannelId").ValueKind);
                var (hits, _) = store.Search(new SearchQuery(["orphaneddragon"], [9, keep], null, false, false, null, null, null, 10));
                Assert.Empty(hits);
            }
        }
        finally
        {
            foreach (var f in new[] { path, path + "-wal", path + "-shm" }) File.Delete(f);
        }
    }

    [Fact]
    public void A_team_split_goes_once_its_origin_and_its_team_channels_are_gone()
    {
        var path = Path.Combine(Path.GetTempPath(), $"iskra-ids-{Guid.NewGuid():N}.db");
        try
        {
            using var store = Store.Open(path);
            var origin = store.CreateChannel("lobby", "voice", "member", "member", 1).Id;
            var team = store.CreateChannel("Team 1", "voice", "member", "member", 1).Id;
            var split = store.AddTeamSplit(origin, null, "a", [team], 1).Id;
            store.DeleteChannel(origin);
            Assert.NotNull(store.GetTeamSplit(split)); // still tidies up its team channel
            store.DeleteChannel(team);
            Assert.Null(store.GetTeamSplit(split));

            var other = store.CreateChannel("other", "voice", "member", "member", 1).Id;
            var empty = store.AddTeamSplit(other, null, "a", [], 1).Id;
            store.DeleteChannel(other);
            Assert.Null(store.GetTeamSplit(empty));
        }
        finally
        {
            foreach (var f in new[] { path, path + "-wal", path + "-shm" }) File.Delete(f);
        }
    }
}
