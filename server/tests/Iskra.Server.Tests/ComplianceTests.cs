using System.IO.Compression;
using System.Net;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

/// <summary>The security log, retention and "Download my data".</summary>
public class ComplianceTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    internal static long DaysAgo(int days) => Now - (long)TimeSpan.FromDays(days).TotalMilliseconds;

    /// <summary>Changes rows behind the server's back (to make data old), through a second connection.</summary>
    internal static void Sql(IskraServer server, string sql, params (string, object)[] args)
    {
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(server.WorldPath, "iskra.db"), Pooling = false }.ToString());
        db.Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value);
        cmd.ExecuteNonQuery();
    }

    private static async Task<List<JsonElement>> Log(User owner, object? query = null) =>
        (await owner.RequestAsync("security.log.list", query ?? new { })).Body().GetProperty("entries").EnumerateArray().ToList();

    internal static RetentionSweeper Sweeper(IskraServer server) =>
        server.Services.GetServices<IHostedService>().OfType<RetentionSweeper>().Single();

    // ── Security log ─────────────────────────────────────────────────────────

    [Fact]
    public async Task Sign_in_failures_and_joins_go_in_the_owners_security_log()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");

        // A valid key without an invite, and a bad signature.
        using var stranger = new TestIdentity();
        using (var client = await server.ConnectAsync())
            Assert.Equal("invite_required", (await client.LoginAsync(stranger, "Stranger")).ErrorCode());
        using (var client = await server.ConnectAsync())
        {
            var hello = await client.ReceiveAsync();
            await client.SendAsync(stranger.AuthFrame(hello, sig: (_, _) => Crypto.Ed25519.ToB64u(new byte[64])));
            Assert.Equal("auth_failed", (await client.ReceiveAsync()).ErrorCode());
        }

        var log = await Log(owner);
        var failures = log.Where(e => e.GetProperty("event").GetString() == "auth.failed").ToList();
        Assert.Contains(failures, e => e.GetProperty("details").GetProperty("reason").GetString() == "invite_required"
            && e.GetProperty("account").GetString() == stranger.AccountKey);
        // A bad signature proves nothing, so no account is named.
        Assert.Contains(failures, e => e.GetProperty("details").GetProperty("reason").GetString() == "auth_failed"
            && e.GetProperty("account").ValueKind == JsonValueKind.Null);
        var joined = log.Where(e => e.GetProperty("event").GetString() == "member.joined").ToList();
        Assert.Contains(joined, e => e.GetProperty("account").GetString() == admin.Key && e.GetProperty("details").GetProperty("role").GetString() == "admin");
        Assert.Contains(joined, e => e.GetProperty("accountName").GetString() == "Owner");

        // Filters and paging.
        Assert.All(await Log(owner, new { @event = "member.joined" }), e => Assert.Equal("member.joined", e.GetProperty("event").GetString()));
        var page = (await owner.RequestAsync("security.log.list", new { limit = 1 })).Body();
        Assert.True(page.GetProperty("hasMore").GetBoolean());
        var next = await Log(owner, new { before = page.GetProperty("entries")[0].GetProperty("id").GetInt64() });
        Assert.Equal(log.Count - 1, next.Count);

        // Only the owner reads it.
        Assert.Equal("forbidden", (await admin.RequestAsync("security.log.list")).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("security.log.list", new { limit = 501 })).ErrorCode());

        // An export is itself recorded.
        await owner.RequestAsync("security.log.list", new { export = true });
        Assert.Single(await Log(owner, new { @event = "security.log.export" }));
    }

    [Fact]
    public async Task Rate_limit_hits_are_logged_at_most_once_a_minute_per_connection()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var spammer = await server.JoinAsync("Spammer");

        var limited = 0;
        for (var i = 0; i < 8; i++)
            if ((await spammer.RequestAsync("chat.typing", new { channelId = server.General })).ErrorCode() == "rate_limited") limited++;
        Assert.True(limited >= 2);

        var entries = await Log(owner, new { @event = "rate_limited" });
        var entry = Assert.Single(entries);
        Assert.Equal(spammer.Key, entry.GetProperty("account").GetString());
        Assert.Equal("chat.typing", entry.GetProperty("details").GetProperty("type").GetString());
    }

    [Fact]
    public void Bursts_of_the_same_event_are_capped_and_counted()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        var start = Now;
        for (var i = 0; i < SecurityLog.MaxPerMinute + 5; i++) SecurityLog.Record(store, start + i, "auth.failed", ip: "203.0.113.9");
        SecurityLog.Record(store, start, "auth.failed", ip: "198.51.100.1"); // another address isn't affected
        Assert.Equal(SecurityLog.MaxPerMinute, store.SecurityEvents("auth.failed", null, null, 100).Count(e => e.Ip == "203.0.113.9"));

        SecurityLog.Record(store, start + 61_000, "auth.failed", ip: "203.0.113.9");
        var latest = store.SecurityEvents("auth.failed", null, null, 1).Single();
        Assert.Equal(5, JsonDocument.Parse(latest.Details!).RootElement.GetProperty("suppressedBefore").GetInt32());
    }

    // ── Retention ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Only_the_owner_reads_and_changes_retention_and_it_is_saved()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");

        var defaults = (await owner.RequestAsync("retention.get")).Body();
        Assert.Equal(0, defaults.GetProperty("messagesDays").GetInt32());
        Assert.Equal(0, defaults.GetProperty("uploadsDays").GetInt32());
        Assert.Equal(90, defaults.GetProperty("auditDays").GetInt32());
        Assert.Equal(365, defaults.GetProperty("securityLogDays").GetInt32());
        Assert.False(defaults.GetProperty("securityLogIps").GetBoolean()); // the privacy policy's promise: no IP addresses kept

        Assert.Equal("forbidden", (await admin.RequestAsync("retention.get")).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("retention.update", new { messagesDays = 1 })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("retention.update", new { messagesDays = -1 })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("retention.update", new { auditDays = ComplianceFeature.MaxRetentionDays + 1 })).ErrorCode());

        var updated = (await owner.RequestAsync("retention.update", new { messagesDays = 30, securityLogDays = 180 })).Body();
        Assert.Equal(30, updated.GetProperty("messagesDays").GetInt32());
        Assert.Equal(90, updated.GetProperty("auditDays").GetInt32());
        var saved = JsonDocument.Parse(File.ReadAllText(Path.Combine(server.WorldPath, "server.json"))).RootElement.GetProperty("Retention");
        Assert.Equal(30, saved.GetProperty("MessagesDays").GetInt32());
        Assert.Equal(180, saved.GetProperty("SecurityLogDays").GetInt32());
        Assert.True((await owner.RequestAsync("retention.update", new { securityLogIps = true })).Body().GetProperty("securityLogIps").GetBoolean());

        var change = (await Log(owner, new { @event = "retention.update" })).Last();
        Assert.Equal(0, change.GetProperty("details").GetProperty("from").GetProperty("messagesDays").GetInt32());
        Assert.Equal(30, change.GetProperty("details").GetProperty("to").GetProperty("messagesDays").GetInt32());
    }

    [Fact]
    public async Task The_sweeper_deletes_messages_envelopes_and_log_entries_past_retention()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");

        var old = (await owner.RequestAsync("chat.send", new { channelId = server.General, text = "old news" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        await owner.RequestAsync("chat.send", new { channelId = server.General, text = "fresh" });
        await owner.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1, ct = "AAAA", keys = Array.Empty<object>() } });
        Sql(server, "UPDATE messages SET created_at = $t WHERE id = $id;", ("$t", DaysAgo(40)), ("$id", old));
        Sql(server, "UPDATE dms SET created_at = $t;", ("$t", DaysAgo(40)));
        server.World.Store.AddSecurityEvent(DaysAgo(400), "auth.failed", null, "192.0.2.1", null);

        // Nothing goes while everything is kept (the default), apart from the year-old security entry.
        Assert.Equal((0, 0, 0, 1), Sweeper(server).Sweep());

        await owner.RequestAsync("retention.update", new { messagesDays = 30 });
        var swept = Sweeper(server).Sweep();
        Assert.Equal(1, swept.Messages);
        Assert.Equal(1, swept.Envelopes);

        var deleted = (await bob.EventAsync("chat.deleted")).Body();
        Assert.Equal(old, deleted.GetProperty("id").GetInt64());
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(["fresh"], history.EnumerateArray().Select(m => m.GetProperty("text").GetString()));
        Assert.Empty((await bob.RequestAsync("dm.history", new { accountKey = owner.Key })).Body().GetProperty("messages").EnumerateArray());
        Assert.DoesNotContain(server.World.Store.SecurityEvents(null, null, null, 100), e => e.Ip == "192.0.2.1");
    }

    [Fact]
    public async Task Upload_retention_deletes_old_message_files_and_keeps_avatars()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var png = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3 };
        async Task<string> Upload(string name, byte[] bytes)
        {
            var ticket = (await owner.RequestAsync("upload.begin", new { name, size = bytes.Length })).Body().GetProperty("url").GetString();
            using var put = await server.CreateClient().PutAsync(ticket, new ByteArrayContent(bytes));
            return JsonDocument.Parse(await put.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
        }
        var attached = await Upload("a.png", png);
        var avatar = await Upload("me.png", Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII="));
        await owner.RequestAsync("chat.send", new { channelId = server.General, text = "look", attachments = new[] { attached } });
        Assert.Equal("result", (await owner.RequestAsync("profile.update", new { avatar })).Type());
        Sql(server, "UPDATE files SET created_at = $t;", ("$t", DaysAgo(40)));

        await owner.RequestAsync("retention.update", new { uploadsDays = 30 });
        Assert.Equal(1, Sweeper(server).Sweep().Files);
        Assert.Null(server.World.Store.GetFile(attached));
        Assert.NotNull(server.World.Store.GetFile(avatar));
        var message = (await owner.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages")[0];
        Assert.Equal("look", message.GetProperty("text").GetString());
        Assert.Empty(message.GetProperty("attachments").EnumerateArray());
    }

    // ── Download my data ─────────────────────────────────────────────────────

    internal static async Task<JsonElement> Download(IskraServer server, JsonElement result)
    {
        using var response = await server.CreateClient().GetAsync(result.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        Assert.Equal("application/zip", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
        using var zip = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()));
        Assert.NotNull(zip.GetEntry("README.txt"));
        using var data = zip.GetEntry("data.json")!.Open();
        return JsonDocument.Parse(data).RootElement.Clone();
    }

    [Fact]
    public async Task Members_download_their_own_data_and_nobody_elses()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var mine = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "alice was here" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        await bob.RequestAsync("chat.send", new { channelId = server.General, text = "bob's secret plans" });
        await alice.RequestAsync("chat.react", new { id = mine, emoji = "👍" });
        await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = new { v = 1, ct = "c2VjcmV0", keys = Array.Empty<object>() } });

        var made = await alice.RequestAsync("data.export");
        Assert.Equal("result", made.Type());
        Assert.StartsWith("iskra-data-", made.Body().GetProperty("name").GetString());
        var data = await Download(server, made.Body());

        Assert.Equal(alice.Key, data.GetProperty("accountKey").GetString());
        Assert.False(data.TryGetProperty("exportedBy", out _));
        Assert.Equal("Alice", data.GetProperty("membership")[0].GetProperty("name").GetString());
        var texts = data.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("text").GetString()).ToList();
        Assert.Equal(["alice was here"], texts);
        Assert.Equal("general", data.GetProperty("messages")[0].GetProperty("channel_name").GetString());
        Assert.Single(data.GetProperty("reactions").EnumerateArray());
        Assert.Single(data.GetProperty("devices").EnumerateArray());
        // DMs: who and when only (the content is end-to-end encrypted, and stays out).
        var dm = Assert.Single(data.GetProperty("directMessages").EnumerateArray());
        Assert.Equal(bob.Key, dm.GetProperty("to_key").GetString());
        Assert.False(dm.TryGetProperty("envelope", out _));
        Assert.Contains(data.GetProperty("securityLog").EnumerateArray(), e => e.GetProperty("event").GetString() == "member.joined");
        Assert.DoesNotContain("bob's secret plans", data.GetRawText());

        // Only the owner may export someone else (to answer a request made to them directly).
        Assert.Equal("forbidden", (await bob.RequestAsync("data.export", new { accountKey = alice.Key })).ErrorCode());
        var forOwner = await Download(server, (await owner.RequestAsync("data.export", new { accountKey = alice.Key })).Body());
        Assert.Equal(alice.Key, forOwner.GetProperty("accountKey").GetString());
        Assert.Equal(owner.Key, forOwner.GetProperty("exportedBy").GetString());
        using var nobody = new TestIdentity();
        Assert.Equal("not_found", (await owner.RequestAsync("data.export", new { accountKey = nobody.AccountKey })).ErrorCode());

        var exports = await Log(owner, new { @event = "data.export" });
        Assert.Equal(2, exports.Count);
        Assert.Equal(owner.Key, exports[0].GetProperty("details").GetProperty("by").GetString());

        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync("/export/not-a-token")).StatusCode);
    }

    [Fact]
    public async Task Exports_are_rate_limited_and_expire()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var first = (await alice.RequestAsync("data.export")).Body();
        Assert.Equal("result", (await alice.RequestAsync("data.export")).Type());
        Assert.Equal("rate_limited", (await alice.RequestAsync("data.export")).ErrorCode());

        var expiresAt = first.GetProperty("expiresAt").GetInt64();
        Assert.InRange(expiresAt - Now, 9 * 60_000, 10 * 60_000 + 1000);
        // Exports live outside anything a backup copies, and leftovers are cleared on start.
        var folder = Path.Combine(server.WorldPath, DataExports.FolderName);
        Assert.Equal(2, Directory.GetFiles(folder).Length);
        DataExports.CleanUp(server.World);
        Assert.Empty(Directory.GetFiles(folder));
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync(first.GetProperty("url").GetString())).StatusCode);
    }

    [Fact]
    public async Task Account_deletion_keeps_security_entries_without_the_address()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var sam = await server.JoinAsync("Sam");
        server.World.Store.AddSecurityEvent(Now, "device.new", sam.Key, "192.0.2.7", null);

        var deletedAt = Now;
        var sig = Crypto.Ed25519.Sign(sam.Identity.Account, Crypto.Ed25519.Payload(AccountFeature.DeleteContext,
            Crypto.Ed25519.PublicKeyOf(sam.Identity.Account), Crypto.Ed25519.U64BigEndian(deletedAt), [0]));
        var deletion = new { accountKey = sam.Key, deletedAt, messages = false, sig = Crypto.Ed25519.ToB64u(sig) };
        Assert.Equal("result", (await sam.RequestAsync("account.delete", new { deletion })).Type());

        var entries = server.World.Store.SecurityEvents(null, sam.Key, null, 100);
        Assert.Contains(entries, e => e.Event == "account.delete");
        Assert.All(entries, e => Assert.Null(e.Ip));
    }
}
