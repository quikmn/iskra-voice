using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Backups;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

/// <summary>Disappearing messages: timers, who may set them, each message's expiry, and the sweep.</summary>
public class DisappearTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private const long Hour = 3_600_000;

    private static DisappearSweeper Sweeper(IskraServer server) =>
        server.Services.GetServices<IHostedService>().OfType<DisappearSweeper>().Single();

    private static long? ExpiresAt(JsonElement message) =>
        message.TryGetProperty("expiresAt", out var e) && e.ValueKind == JsonValueKind.Number ? e.GetInt64() : null;

    private static async Task<JsonElement> Send(User user, long channelId, string text, object? extra = null)
    {
        var body = JsonSerializer.SerializeToNode(extra ?? new { })!.AsObject();
        body["channelId"] = channelId;
        body["text"] = text;
        var reply = await user.RequestAsync("chat.send", body);
        Assert.True(reply.Type() == "result", reply.ToString());
        return reply.Body().GetProperty("message");
    }

    private static async Task<JsonElement> SetTimer(User user, object body)
    {
        var reply = await user.RequestAsync("disappear.set", body);
        Assert.True(reply.Type() == "result", reply.ToString());
        return reply.Body().GetProperty("timer");
    }

    private static async Task<JsonElement> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").Clone();
    }

    private static async Task<string> DmUpload(IskraServer server, User user, object target, byte[] content)
    {
        var body = JsonSerializer.SerializeToNode(target)!.AsObject();
        body["size"] = content.Length;
        var ticket = await user.RequestAsync("dm.upload.begin", body);
        Assert.Equal("result", ticket.Type());
        using var response = await server.CreateClient().PutAsync(ticket.Body().GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
    }

    private static string UploadPath(IskraServer server, string fileId)
    {
        var sha = server.World.Store.GetFile(fileId)!.Sha256;
        return Path.Combine(server.WorldPath, "uploads", sha[..2], sha);
    }

    /// <summary>A DM envelope as the server sees it: a header (maybe with `expires`) and opaque rest.</summary>
    private static object DmEnvelope(User from, User to, int? expires = null, int v = 3) => new
    {
        v,
        header = expires is { } e
            ? (object)new { from = from.Key, to = to.Key, sentAt = Now, id = "x", expires = e }
            : new { from = from.Key, to = to.Key, sentAt = Now, id = "x" },
        ct = "opaque",
    };

    // ── Who sets the timer ───────────────────────────────────────────────────

    [Fact]
    public async Task Channel_timers_need_the_manage_channels_power_and_a_known_value()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await member.RequestAsync("disappear.set", new { channelId = server.General, seconds = 3600 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("disappear.set", new { channelId = server.General, seconds = 42 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("disappear.set", new { channelId = server.General, accountKey = member.Key, seconds = 300 })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("disappear.set", new { channelId = 999_999, seconds = 300 })).ErrorCode());

        // A channel you can't read is not_found (it doesn't leak), and only text, voice and stage channels take a timer.
        var hidden = (await owner.RequestAsync("channel.create", new { name = "owners", readRole = "owner", writeRole = "owner" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await admin.RequestAsync("disappear.set", new { channelId = hidden, seconds = 300 })).ErrorCode());
        var forum = (await owner.RequestAsync("channel.create", new { name = "ideas", kind = "forum" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await admin.RequestAsync("disappear.set", new { channelId = forum, seconds = 300 })).ErrorCode());

        var timer = await SetTimer(admin, new { channelId = server.General, seconds = 3600 });
        Assert.Equal("channel", timer.GetProperty("scope").GetString());
        Assert.Equal(3600, timer.GetProperty("seconds").GetInt32());
        Assert.Equal(admin.Key, timer.GetProperty("setBy").GetString());

        // Everyone who reads the channel hears about it, and sees a line in the chat.
        var changed = (await member.EventAsync("disappear.changed")).Body().GetProperty("timer");
        Assert.Equal(server.General, changed.GetProperty("channelId").GetInt64());
        var line = (await member.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal(3600, line.GetProperty("disappear").GetProperty("seconds").GetInt32());
        Assert.Null(ExpiresAt(line)); // the line itself stays
        Assert.Contains("1 hour", line.GetProperty("text").GetString()); // what apps from before disappearing messages show

        var list = (await member.RequestAsync("disappear.list")).Body().GetProperty("timers");
        Assert.Contains(list.EnumerateArray(), t => t.GetProperty("scope").GetString() == "channel" && t.GetProperty("seconds").GetInt32() == 3600);
        // Readers of another channel don't see its timer.
        await SetTimer(owner, new { channelId = hidden, seconds = 300 });
        list = (await member.RequestAsync("disappear.list")).Body().GetProperty("timers");
        Assert.DoesNotContain(list.EnumerateArray(), t => t.TryGetProperty("channelId", out var c) && c.GetInt64() == hidden);
    }

    [Fact]
    public async Task Either_person_sets_a_dm_timer_and_any_member_a_groups()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var eve = await server.JoinAsync("Eve", "admin");

        var timer = await SetTimer(bob, new { accountKey = alice.Key, seconds = 300 });
        Assert.Equal(alice.Key, timer.GetProperty("accountKey").GetString());
        // Each side sees the other person as the conversation.
        Assert.Equal(bob.Key, (await alice.EventAsync("disappear.changed")).Body().GetProperty("timer").GetProperty("accountKey").GetString());
        await eve.NoEventAsync("disappear.changed");
        var mine = (await alice.RequestAsync("disappear.list")).Body().GetProperty("timers").EnumerateArray().Single();
        Assert.Equal(bob.Key, mine.GetProperty("accountKey").GetString());
        Assert.Equal(300, mine.GetProperty("seconds").GetInt32());
        // Alice turns it off again.
        Assert.Equal(0, (await SetTimer(alice, new { accountKey = bob.Key, seconds = 0 })).GetProperty("seconds").GetInt32());
        using var stranger = new TestIdentity();
        Assert.Equal("not_found", (await alice.RequestAsync("disappear.set", new { accountKey = stranger.AccountKey, seconds = 300 })).ErrorCode());

        // Groups: any member; anyone else (admins too) gets not_found.
        var id = GroupTests.NewId();
        await GroupTests.CreateAsync(alice, id, bob, carol);
        Assert.Equal("not_found", (await eve.RequestAsync("disappear.set", new { groupId = id, seconds = 300 })).ErrorCode());
        Assert.Equal(86400, (await SetTimer(carol, new { groupId = id, seconds = 86400 })).GetProperty("seconds").GetInt32());
        JsonElement groupEvent;
        do groupEvent = (await bob.EventAsync("disappear.changed")).Body().GetProperty("timer");
        while (!groupEvent.TryGetProperty("groupId", out _));
        Assert.Equal(id, groupEvent.GetProperty("groupId").GetString());
        Assert.Contains((await bob.RequestAsync("disappear.list")).Body().GetProperty("timers").EnumerateArray(),
            t => t.TryGetProperty("groupId", out var g) && g.GetString() == id);
    }

    // ── Each message's expiry ────────────────────────────────────────────────

    [Fact]
    public async Task Messages_get_their_expiry_when_sent_and_a_change_only_affects_new_ones()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        var before = await Send(alice, server.General, "before the timer");
        Assert.Null(ExpiresAt(before));
        await SetTimer(admin, new { channelId = server.General, seconds = 3600 });
        var during = await Send(alice, server.General, "under one hour");
        var createdAt = during.GetProperty("createdAt").GetInt64();
        Assert.Equal(createdAt + Hour, ExpiresAt(during));

        // Threads follow their channel's timer.
        var threadId = (await alice.RequestAsync("thread.create", new { messageId = during.GetProperty("id").GetInt64(), name = "side" }))
            .Body().GetProperty("thread").GetProperty("id").GetInt64();
        var reply = await Send(alice, threadId, "in the thread");
        Assert.Equal(reply.GetProperty("createdAt").GetInt64() + Hour, ExpiresAt(reply));

        // A shorter timer later doesn't touch what was already sent.
        await SetTimer(admin, new { channelId = server.General, seconds = 300 });
        var history = (await alice.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal(createdAt + Hour, ExpiresAt(history.Single(m => m.GetProperty("id").GetInt64() == during.GetProperty("id").GetInt64())));
        Assert.Null(ExpiresAt(history.Single(m => m.GetProperty("id").GetInt64() == before.GetProperty("id").GetInt64())));
        var later = await Send(alice, server.General, "five minutes");
        Assert.Equal(later.GetProperty("createdAt").GetInt64() + 300_000, ExpiresAt(later));

        await SetTimer(admin, new { channelId = server.General, seconds = 0 });
        Assert.Null(ExpiresAt(await Send(alice, server.General, "kept")));
    }

    [Fact]
    public async Task Dm_and_group_envelopes_carry_their_own_expiry_and_the_sooner_one_wins()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");

        // No timer, but the sender's app asked for 5 minutes in the signed header.
        var dm = (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = DmEnvelope(alice, bob, 300) })).Body().GetProperty("message");
        Assert.Equal(dm.GetProperty("createdAt").GetInt64() + 300_000, ExpiresAt(dm));
        Assert.Equal(ExpiresAt(dm), ExpiresAt((await bob.EventAsync("dm.message")).Body().GetProperty("message")));
        // A timer of a day and an envelope saying an hour: an hour.
        await SetTimer(bob, new { accountKey = alice.Key, seconds = 86400 });
        dm = (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = DmEnvelope(alice, bob, 3600) })).Body().GetProperty("message");
        Assert.Equal(dm.GetProperty("createdAt").GetInt64() + Hour, ExpiresAt(dm));
        // An app from before disappearing messages sends without one: the timer still applies on the server.
        dm = (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = DmEnvelope(alice, bob, v: 2) })).Body().GetProperty("message");
        Assert.Equal(dm.GetProperty("createdAt").GetInt64() + 24 * Hour, ExpiresAt(dm));
        // History says the same.
        var history = (await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages");
        Assert.All(history.EnumerateArray(), m => Assert.NotNull(ExpiresAt(m)));
        // Anything but one of the timers is refused, and nothing is stored.
        foreach (var bad in new object[] { 42, -300, "300", 1.5 })
        {
            var envelope = new { v = 3, header = new { from = alice.Key, to = bob.Key, sentAt = Now, id = "y", expires = bad }, ct = "x" };
            Assert.Equal("bad_request", (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope })).ErrorCode());
        }
        Assert.Equal(3, (await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages").GetArrayLength());

        var id = GroupTests.NewId();
        var group = await GroupTests.CreateAsync(alice, id, bob, carol);
        await SetTimer(carol, new { groupId = id, seconds = 28800 });
        var sent = (await bob.RequestAsync("group.send", new
        {
            groupId = id, version = 1,
            envelope = new { v = 3, kind = "group", header = new { from = bob.Key, group = id, version = 1, head = group.GetProperty("head").GetString(), sentAt = Now, id = "g", expires = 604800 }, ct = "x" },
        })).Body().GetProperty("message");
        Assert.Equal(sent.GetProperty("createdAt").GetInt64() + 8 * Hour, ExpiresAt(sent));
    }

    [Fact]
    public async Task Encrypted_channels_take_the_sooner_of_the_timer_and_the_signed_header()
    {
        using var t = await E2eeChannelTests.CreateAsync();
        await SetTimer(t.Owner, new { channelId = t.ChannelId, seconds = 86400 });
        // The timer line in an encrypted channel carries no text: the server writes nothing readable there.
        var line = (await t.Bob.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("", line.GetProperty("text").GetString());
        Assert.Equal(86400, line.GetProperty("disappear").GetProperty("seconds").GetInt32());

        var envelope = E2eeChannelTests.BoundEnvelope(t.Bob, t.Chain, 1, "secret", t.ChannelId);
        envelope["v"] = 3;
        ((JsonObject)envelope["header"]!)["expires"] = 300;
        var sent = (await t.Bob.RequestAsync("chat.send", new { channelId = t.ChannelId, version = 1, envelope })).Body().GetProperty("message");
        Assert.Equal(sent.GetProperty("createdAt").GetInt64() + 300_000, ExpiresAt(sent));

        // An older app's envelope (no expiry): the channel's timer.
        var old = (await t.Carol.RequestAsync("chat.send", new { channelId = t.ChannelId, version = 1, envelope = E2eeChannelTests.BoundEnvelope(t.Carol, t.Chain, 1, "old", t.ChannelId) }))
            .Body().GetProperty("message");
        Assert.Equal(old.GetProperty("createdAt").GetInt64() + 24 * Hour, ExpiresAt(old));

        ((JsonObject)envelope["header"]!)["expires"] = 7;
        Assert.Equal("bad_request", (await t.Bob.RequestAsync("chat.send", new { channelId = t.ChannelId, version = 1, envelope })).ErrorCode());
        // An edit never moves the expiry.
        var edit = E2eeChannelTests.BoundEnvelope(t.Bob, t.Chain, 1, "edited", t.ChannelId);
        edit["v"] = 3;
        ((JsonObject)edit["header"]!)["expires"] = 2419200;
        var edited = (await t.Bob.RequestAsync("chat.edit", new { id = sent.GetProperty("id").GetInt64(), version = 1, envelope = edit })).Body().GetProperty("message");
        Assert.Equal(ExpiresAt(sent), ExpiresAt(edited));
    }

    // ── The sweep ────────────────────────────────────────────────────────────

    [Fact]
    public async Task The_sweep_deletes_expired_messages_with_their_reactions_pins_threads_files_and_search_entries()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");

        var keep = await Send(alice, server.General, "zebrafish stays forever");
        await SetTimer(admin, new { channelId = server.General, seconds = 300 });
        var file = await Upload(server, alice, RandomNumberGenerator.GetBytes(300), "notes.bin");
        var gone = await Send(alice, server.General, "zebrafish disappears", new { attachments = new[] { file.GetProperty("id").GetString() } });
        var goneId = gone.GetProperty("id").GetInt64();
        Assert.Equal("result", (await bob.RequestAsync("chat.react", new { id = goneId, emoji = "👍" })).Type());
        Assert.Equal("result", (await alice.RequestAsync("chat.pin", new { id = goneId })).Type());
        var threadId = (await bob.RequestAsync("thread.create", new { messageId = goneId, name = "about it" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        await Send(bob, threadId, "zebrafish in a thread");
        var path = UploadPath(server, file.GetProperty("id").GetString()!);
        Assert.True(File.Exists(path));
        var searched = (await bob.RequestAsync("search", new { query = "zebrafish" })).Body().GetProperty("results").GetArrayLength();
        Assert.Equal(3, searched);

        // Not yet.
        Assert.Equal(0, Sweeper(server).Sweep(Now).Messages);
        var swept = Sweeper(server).Sweep(Now + 6 * 60_000);
        Assert.True(swept.Messages >= 1);
        Assert.Equal(1, swept.Files);

        Assert.Null(server.World.Store.GetMessage(goneId));
        Assert.NotNull(server.World.Store.GetMessage(keep.GetProperty("id").GetInt64()));
        Assert.Equal(goneId, (await bob.EventAsync("chat.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Equal(threadId, (await bob.EventAsync("thread.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Null(server.World.Store.GetChannel(threadId));
        Assert.Empty(server.World.Store.Reactions(goneId));
        Assert.False(server.World.Store.IsPinned(goneId));
        Assert.Equal(0, (await alice.RequestAsync("pin.list", new { channelId = server.General })).Body().GetProperty("pins").GetArrayLength());
        Assert.False(File.Exists(path));
        Assert.Null(server.World.Store.GetFile(file.GetProperty("id").GetString()!));
        var results = (await bob.RequestAsync("search", new { query = "zebrafish" })).Body().GetProperty("results");
        Assert.Equal(keep.GetProperty("id").GetInt64(), results.EnumerateArray().Single().GetProperty("message").GetProperty("id").GetInt64());
        // The timer line itself stays.
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Contains(history.EnumerateArray(), m => m.TryGetProperty("disappear", out var d) && d.ValueKind == JsonValueKind.Object);
    }

    [Fact]
    public async Task Files_still_used_elsewhere_stay_when_a_message_disappears()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var other = (await admin.RequestAsync("channel.create", new { name = "other" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        await SetTimer(admin, new { channelId = server.General, seconds = 300 });
        var file = await Upload(server, alice, RandomNumberGenerator.GetBytes(200), "shared.bin");
        var id = file.GetProperty("id").GetString()!;
        await Send(alice, server.General, "here for 5 minutes", new { attachments = new[] { id } });
        // The same upload in a message that stays.
        server.World.Store.AddMessage(other, alice.Key, "kept", Now, [id]);

        Assert.Equal(0, Sweeper(server).Sweep(Now + 6 * 60_000).Files);
        Assert.True(File.Exists(UploadPath(server, id)));
    }

    [Fact]
    public async Task Expired_dms_group_messages_and_their_encrypted_files_go()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");

        var fileId = await DmUpload(server, alice, new { accountKey = bob.Key }, RandomNumberGenerator.GetBytes(400));
        var path = UploadPath(server, fileId);
        Assert.Equal("result", (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = DmEnvelope(alice, bob, 300), files = new[] { fileId } })).Type());
        Assert.Equal("result", (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = DmEnvelope(alice, bob, v: 2) })).Type());
        Assert.Equal("result", (await bob.RequestAsync("dm.file.url", new { id = fileId })).Type());

        var id = GroupTests.NewId();
        var group = await GroupTests.CreateAsync(alice, id, bob, carol);
        await SetTimer(bob, new { groupId = id, seconds = 300 });
        var groupFile = await DmUpload(server, carol, new { groupId = id }, RandomNumberGenerator.GetBytes(300));
        Assert.Equal("result", (await carol.RequestAsync("group.send", new
        {
            groupId = id, version = 1, files = new[] { groupFile },
            envelope = new { v = 2, kind = "group", header = new { from = carol.Key, group = id, version = 1, head = group.GetProperty("head").GetString(), sentAt = Now, id = "g" }, ct = "x" },
        })).Type());

        var swept = Sweeper(server).Sweep(Now + 6 * 60_000);
        Assert.Equal(2, swept.Envelopes);
        Assert.Equal(2, swept.Files);
        var left = (await bob.RequestAsync("dm.history", new { accountKey = alice.Key })).Body().GetProperty("messages");
        Assert.Null(ExpiresAt(left.EnumerateArray().Single()));
        Assert.Equal(0, (await bob.RequestAsync("group.history", new { groupId = id })).Body().GetProperty("messages").GetArrayLength());
        Assert.False(File.Exists(path));
        Assert.Equal("not_found", (await bob.RequestAsync("dm.file.url", new { id = fileId })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("dm.file.url", new { id = groupFile })).ErrorCode());
    }

    [Fact]
    public async Task Encrypted_channel_messages_and_their_files_go_when_they_expire()
    {
        using var t = await E2eeChannelTests.CreateAsync();
        var fileId = await DmUpload(t.Server, t.Bob, new { channelId = t.ChannelId }, RandomNumberGenerator.GetBytes(256));
        var envelope = E2eeChannelTests.BoundEnvelope(t.Bob, t.Chain, 1, "secret", t.ChannelId);
        envelope["v"] = 3;
        ((JsonObject)envelope["header"]!)["expires"] = 300;
        var sent = (await t.Bob.RequestAsync("chat.send", new { channelId = t.ChannelId, version = 1, envelope, files = new[] { fileId } })).Body().GetProperty("message");

        var swept = Sweeper(t.Server).Sweep(Now + 6 * 60_000);
        Assert.Equal(1, swept.Messages);
        Assert.Equal(1, swept.Files);
        Assert.Null(t.Server.World.Store.GetMessage(sent.GetProperty("id").GetInt64()));
        Assert.Null(t.Server.World.Store.GetE2eeMessage(sent.GetProperty("id").GetInt64()));
        Assert.Equal("not_found", (await t.Carol.RequestAsync("dm.file.url", new { id = fileId })).ErrorCode());
    }

    // ── Pushes, backups, your data ───────────────────────────────────────────

    [Fact]
    public async Task Backups_leave_disappearing_messages_and_their_files_out()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var keptFile = await Upload(server, alice, RandomNumberGenerator.GetBytes(100), "kept.bin");
        await Send(alice, server.General, "kept in the backup", new { attachments = new[] { keptFile.GetProperty("id").GetString() } });
        await SetTimer(admin, new { channelId = server.General, seconds = 604800 });
        var goneFile = await Upload(server, alice, RandomNumberGenerator.GetBytes(100), "gone.bin");
        await Send(alice, server.General, "not in any backup", new { attachments = new[] { goneFile.GetProperty("id").GetString() } });
        Assert.Equal("result", (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = DmEnvelope(alice, bob, 3600) })).Type());

        var zipPath = Path.Combine(Path.GetTempPath(), $"iskra-disappear-{Guid.NewGuid():N}.zip");
        var dbPath = zipPath + ".db";
        try
        {
            using (var file = File.Create(zipPath)) BackupArchive.Write(server.World, file, includeUploads: true, Now);
            using (var zip = ZipFile.OpenRead(zipPath))
            {
                var names = zip.Entries.Select(e => e.FullName).ToList();
                Assert.Contains(names, n => n.EndsWith(server.World.Store.GetFile(keptFile.GetProperty("id").GetString()!)!.Sha256, StringComparison.Ordinal));
                Assert.DoesNotContain(names, n => n.EndsWith(server.World.Store.GetFile(goneFile.GetProperty("id").GetString()!)!.Sha256, StringComparison.Ordinal));
                zip.GetEntry("iskra.db")!.ExtractToFile(dbPath);
            }
            using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dbPath, Pooling = false }.ToString()))
            {
                db.Open();
                long Count(string sql)
                {
                    using var cmd = db.CreateCommand();
                    cmd.CommandText = sql;
                    return Convert.ToInt64(cmd.ExecuteScalar());
                }
                Assert.Equal(1, Count("SELECT COUNT(*) FROM messages WHERE text = 'kept in the backup';"));
                Assert.Equal(0, Count("SELECT COUNT(*) FROM messages WHERE text = 'not in any backup';"));
                Assert.Equal(1, Count("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'backup';"));
                Assert.Equal(0, Count("SELECT COUNT(*) FROM dms;"));
                Assert.Equal(0, Count("SELECT COUNT(*) FROM messages WHERE expires_at IS NOT NULL;"));
            }
            SqliteConnection.ClearAllPools();
            // Nothing of it is left in the file's free pages.
            Assert.DoesNotContain("not in any backup", System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(dbPath)));
            // The live server still has them until they expire.
            Assert.Equal(2, (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages")
                .EnumerateArray().Count(m => m.GetProperty("text").GetString()!.Contains("backup")));
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            File.Delete(zipPath);
            File.Delete(dbPath);
        }
    }

    [Fact]
    public async Task Pushes_leave_the_text_of_disappearing_messages_out()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = $"https://fcm.googleapis.com/fcm/send/bob-{Guid.NewGuid():N}";
        Assert.Equal("result", (await bob.RequestAsync("push.subscribe", PushTests.Subscription(endpoint))).Type());
        Assert.Equal("result", (await bob.RequestAsync("notify.set", new { channelId = server.General, level = "all" })).Type());
        await SetTimer(admin, new { channelId = server.General, seconds = 300 });
        await Send(alice, server.General, "a secret plan");
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.DoesNotContain("secret plan", push.GetRawText());
    }

    [Fact]
    public async Task Your_data_lists_the_timers_you_set()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "admin");
        using var bob = await server.JoinAsync("Bob");
        await SetTimer(alice, new { channelId = server.General, seconds = 300 });
        await SetTimer(bob, new { accountKey = alice.Key, seconds = 3600 });
        var data = await ComplianceTests.Download(server, (await alice.RequestAsync("data.export")).Body());
        var timers = data.GetProperty("disappearingTimers").EnumerateArray().ToList();
        Assert.Equal(2, timers.Count);
        Assert.Contains(timers, t => t.GetProperty("scope").GetString() == "dm" && t.GetProperty("set_by").GetString() == bob.Key);
    }
}
