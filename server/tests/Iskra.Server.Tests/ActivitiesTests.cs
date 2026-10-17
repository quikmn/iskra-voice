using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class ActivitiesTests
{
    private const string Manifest = """{ "name": "Snake duel", "description": "Two snakes.", "icon": "icon.png", "minPlayers": 2, "maxPlayers": 4, "version": "1.0" }""";
    private const string Index = "<!doctype html><html><body><script src=\"game.js\"></script></body></html>";

    private static string? Key(JsonElement frame) => frame.Body().TryGetProperty("key", out var k) ? k.GetString() : null;

    private static byte[] Zip(params (string Path, byte[] Data)[] files)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (path, data) in files)
            {
                using var entry = zip.CreateEntry(path, CompressionLevel.Optimal).Open();
                entry.Write(data);
            }
        return memory.ToArray();
    }

    private static (string, byte[]) F(string path, string text) => (path, Encoding.UTF8.GetBytes(text));

    private static byte[] Good(string prefix = "") => Zip(F(prefix + "manifest.json", Manifest), F(prefix + "index.html", Index),
        F(prefix + "game.js", "iskra.ready()"), (prefix + "icon.png", [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    /// <summary>Puts bytes in the server's uploads as <paramref name="user"/>'s upload, and returns its id.</summary>
    private static string Upload(IskraServer server, User user, byte[] data)
    {
        var sha = Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
        var path = server.Services.GetRequiredService<Uploads>().PathFor(sha);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, data);
        var id = "upload" + sha[..16] + user.Key[..8];
        if (server.World.Store.GetFile(id) is null)
            server.World.Store.AddFile(new StoredFile(id, sha, "activity.zip", data.Length, "application/zip", null, null, user.Key, 0));
        return id;
    }

    private static async Task<JsonElement> AddAsync(IskraServer server, User admin, byte[] zip)
    {
        var result = await admin.RequestAsync("act.add", new { file = Upload(server, admin, zip) });
        Assert.Null(result.ErrorCode());
        return result.Body().GetProperty("activity");
    }

    private static long Voice(IskraServer server, string name = "games", string write = "member") =>
        server.World.Store.CreateChannel(name, "voice", "member", write, 0).Id;

    private static async Task<JsonElement> StartAsync(User user, long channel, string activity = "four")
    {
        var result = await user.RequestAsync("act.start", new { channelId = channel, activity });
        Assert.Null(result.ErrorCode());
        return result.Body().GetProperty("session");
    }

    private static async Task<JsonElement> SessionWhere(User user, Func<JsonElement, bool> match)
    {
        for (var i = 0; i < 20; i++)
        {
            var body = (await user.EventAsync("act.session")).Body();
            if (match(body)) return body;
        }
        throw new Xunit.Sdk.XunitException("no matching act.session");
    }

    // ── Bundles ────────────────────────────────────────────────────────────────

    public static TheoryData<string, string> Hostile => new()
    {
        { "../evil.html", "act_path" },
        { "/etc/passwd.txt", "act_path" },
        { "a/../../b.html", "act_path" },
        { "C:/x.html", "act_path" },
        { "dir\\x.html", "act_path" },
        { ".secret.js", "act_path" },
        { "sub/.env.txt", "act_path" },
        { "a b.html", "act_path" },
        { "virus.exe", "act_type" },
        { "page.php", "act_type" },
        { "noext", "act_type" },
    };

    [Theory]
    [MemberData(nameof(Hostile))]
    public void Bundles_with_bad_paths_or_types_are_refused(string path, string key)
    {
        var zip = Zip(F("manifest.json", Manifest), F("index.html", Index), (path, [1, 2, 3]), F("icon.png", "x"));
        var e = Assert.Throws<BundleException>(() => ActivityBundle.Read(new MemoryStream(zip)));
        Assert.Equal(key, e.Key);
    }

    [Fact]
    public void Bundles_are_checked_whole()
    {
        BundleException Refused(byte[] zip) => Assert.Throws<BundleException>(() => ActivityBundle.Read(new MemoryStream(zip)));

        Assert.Equal("act_zip", Refused(Encoding.UTF8.GetBytes("not a zip at all")).Key);
        Assert.Equal("act_index", Refused(Zip(F("manifest.json", Manifest), F("icon.png", "x"))).Key);
        Assert.Equal("act_manifest", Refused(Zip(F("index.html", Index))).Key);
        Assert.Equal("act_manifest", Refused(Zip(F("index.html", Index), F("manifest.json", "{ nope"))).Key);
        Assert.Equal("act_manifest", Refused(Zip(F("index.html", Index), F("manifest.json", """{ "description": "no name" }"""))).Key);
        Assert.Equal("act_manifest", Refused(Zip(F("index.html", Index), F("manifest.json", """{ "name": "x", "minPlayers": 5, "maxPlayers": 2 }"""))).Key);
        Assert.Equal("act_manifest", Refused(Zip(F("index.html", Index), F("manifest.json", """{ "name": "x", "icon": "missing.png" }"""))).Key);
        Assert.Equal("act_manifest", Refused(Zip(F("index.html", Index), F("manifest.json", """{ "name": "x", "icon": "index.html" }"""))).Key);
        Assert.Equal("act_manifest", Refused(Zip(F("index.html", Index), F("manifest.json", "{ \"name\": \"two\\nlines\" }"))).Key);
        Assert.Equal("act_utf8", Refused(Zip(F("index.html", Index), F("manifest.json", """{ "name": "x" }"""), ("a.js", [0xff, 0xfe, 0x00]))).Key);

        // Two files that differ only in case: the whole bundle goes.
        var twice = Refused(Zip(F("index.html", Index), F("manifest.json", """{ "name": "x" }"""), F("A.js", "1"), F("a.js", "2")));
        Assert.Equal("act_path", twice.Key);
        Assert.True(twice.Hostile);

        // Too many files.
        var many = Enumerable.Range(0, ActivityBundle.MaxFiles + 1).Select(i => F($"f{i}.txt", "x")).Append(F("index.html", Index)).ToArray();
        Assert.Equal("act_zip", Refused(Zip(many)).Key);

        // A zip bomb: tiny packed, past the limit unpacked. Counted while unpacking.
        var bomb = Refused(Zip(F("index.html", Index), F("manifest.json", """{ "name": "x" }"""), ("big.txt", new byte[ActivityBundle.MaxFileBytes + 1])));
        Assert.Equal("act_zip", bomb.Key);
    }

    [Fact]
    public void A_folder_zip_is_unwrapped_and_junk_skipped()
    {
        var zip = Zip(F("snake/manifest.json", Manifest), F("snake/index.html", Index), F("snake/game.js", "1"), F("snake/icon.png", "x"),
            F("__MACOSX/snake/._index.html", "junk"), F("snake/.DS_Store", "junk"));
        var (manifest, files) = ActivityBundle.Read(new MemoryStream(zip));
        Assert.Equal("Snake duel", manifest.Name);
        Assert.Equal((2, 4), (manifest.MinPlayers, manifest.MaxPlayers));
        Assert.Equal("icon.png", manifest.Icon);
        Assert.Equal(["game.js", "icon.png", "index.html", "manifest.json"], files.Select(f => f.Path).Order().ToArray());
        Assert.Equal("text/javascript; charset=utf-8", files.Single(f => f.Path == "game.js").Type);
    }

    [Fact]
    public async Task Admins_add_activities_and_the_server_serves_them_walled_off()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        // Only admins, only their own uploads.
        Assert.Equal("forbidden", (await bob.RequestAsync("act.add", new { file = Upload(server, bob, Good()) })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("act.add", new { file = Upload(server, bob, Good()) })).ErrorCode());

        var activity = await AddAsync(server, admin, Good("snake/"));
        var id = activity.GetProperty("id").GetString()!;
        Assert.Equal("Snake duel", activity.GetProperty("name").GetString());
        Assert.Equal($"/activities/{id}/icon.png", activity.GetProperty("icon").GetString());
        Assert.Equal(4, activity.GetProperty("files").GetInt32());
        await bob.EventAsync("act.catalog");
        Assert.Single(server.World.Store.Audit("act.add", null, null, 10));
        Assert.Single(server.World.Store.SecurityEvents("activity.added", null, null, 10));

        var http = server.CreateClient();
        using var page = await http.GetAsync($"/activities/{id}/index.html");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var csp = page.Headers.GetValues("Content-Security-Policy").Single();
        Assert.StartsWith("sandbox allow-scripts; default-src 'none';", csp);
        Assert.Contains("connect-src 'none'", csp);
        Assert.Contains($"/activities/{id}/", csp);
        Assert.Contains("frame-ancestors", csp);
        Assert.False(page.Headers.Contains("X-Frame-Options"));
        Assert.Equal("no-store", page.Headers.CacheControl?.ToString());
        Assert.False(page.Headers.Contains("Set-Cookie"));
        var html = await page.Content.ReadAsStringAsync();
        Assert.StartsWith("<!doctype html><script>", html); // the prelude and SDK go first, after the doctype
        Assert.Contains("RTCPeerConnection", html);
        Assert.Contains("iskra-activity:", html);
        Assert.True(html.IndexOf("iskra-activity:", StringComparison.Ordinal) < html.IndexOf("game.js", StringComparison.Ordinal));

        using var script = await http.GetAsync($"/activities/{id}/game.js");
        Assert.Equal("text/javascript", script.Content.Headers.ContentType?.MediaType);
        Assert.Equal("nosniff", script.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("iskra.ready()", await script.Content.ReadAsStringAsync());
        foreach (var missing in new[] { "nope.js", "../manifest.json", "%2e%2e/index.html", ".hidden" })
            Assert.NotEqual(HttpStatusCode.OK, (await http.GetAsync($"/activities/{id}/{missing}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/activities/AAAAAAAAAAAAAAAAAAAAAA/index.html")).StatusCode);

        // Bob sees enabled ones; turned off, it's gone for him and not served.
        Assert.Equal(1, (await bob.RequestAsync("act.list")).Body().GetProperty("activities").GetArrayLength());
        Assert.Equal("result", (await admin.RequestAsync("act.update", new { id, enabled = false })).Type());
        Assert.Equal(0, (await bob.RequestAsync("act.list")).Body().GetProperty("activities").GetArrayLength());
        Assert.Equal(1, (await admin.RequestAsync("act.list")).Body().GetProperty("activities").GetArrayLength());
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/activities/{id}/index.html")).StatusCode);

        // Removed: gone, files and all.
        Assert.Equal("forbidden", (await bob.RequestAsync("act.remove", new { id })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("act.remove", new { id })).Type());
        Assert.Null(server.World.Store.GetActivityFile(id, "index.html"));
        Assert.Single(server.World.Store.SecurityEvents("activity.removed", null, null, 10));
        Assert.Equal("not_found", (await admin.RequestAsync("act.remove", new { id })).ErrorCode());

        // Deleting the account keeps the server's activities, without who added them.
        var kept = (await AddAsync(server, admin, Good())).GetProperty("id").GetString()!;
        server.World.Store.DeleteAccount(new AccountDeletion(admin.Key, 0, false, "sig"), 0);
        Assert.Equal("", server.World.Store.GetActivity(kept)!.AddedBy);
    }

    [Fact]
    public async Task Hostile_bundles_are_refused_and_logged()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var hostile = Zip(F("manifest.json", Manifest), F("index.html", Index), F("../../uploads/x.js", "evil"));
        var refused = await admin.RequestAsync("act.add", new { file = Upload(server, admin, hostile) });
        Assert.Equal("act_path", Key(refused));
        Assert.Equal("../../uploads/x.js", refused.Body().GetProperty("args").GetProperty("path").GetString());
        var logged = server.World.Store.SecurityEvents("activity.rejected", null, null, 10).Single();
        Assert.Contains("path", logged.Details);
        Assert.Empty(server.World.Store.Activities());

        // An honest mistake (no index.html) is refused but not a security event.
        Assert.Equal("act_index", Key(await admin.RequestAsync("act.add", new { file = Upload(server, admin, Zip(F("manifest.json", Manifest))) })));
        Assert.Single(server.World.Store.SecurityEvents("activity.rejected", null, null, 10));
    }

    // ── Sessions ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task Players_share_messages_in_one_order_and_late_joiners_catch_up()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");

        Assert.Equal("voice_join_first", Key(await alice.RequestAsync("act.start", new { channelId = games, activity = "four" })));
        Assert.Equal("act_voice_only", Key(await alice.RequestAsync("act.start", new { channelId = server.General, activity = "four" })));
        await WatchTestsAccess.Join(server, games, alice);
        Assert.Equal("not_found", (await alice.RequestAsync("act.start", new { channelId = games, activity = "nope" })).ErrorCode());
        var session = await StartAsync(alice, games);
        var sessionId = session.GetProperty("id").GetString()!;
        var alicePid = session.GetProperty("players")[0].GetProperty("id").GetString()!;
        Assert.NotEqual(alice.Key, alicePid);
        Assert.Equal(alice.Key, session.GetProperty("players")[0].GetProperty("accountKey").GetString());
        Assert.Equal("act_running", Key(await alice.RequestAsync("act.start", new { channelId = games, activity = "draw" })));
        await SessionWhere(carol, b => b.GetProperty("session").ValueKind == JsonValueKind.Object);

        // Bob joins the call, then the activity. Messages reach both, sender included, in seq order.
        Assert.Equal("voice_join_first", Key(await bob.RequestAsync("act.join", new { channelId = games, sessionId })));
        await WatchTestsAccess.Join(server, games, bob);
        Assert.Equal("act_join_first", Key(await bob.RequestAsync("act.send", new { channelId = games, sessionId, data = new { t = "sit" } })));
        var joined = (await bob.RequestAsync("act.join", new { channelId = games, sessionId })).Body();
        var bobPid = joined.GetProperty("me").GetString()!;
        Assert.Equal(0, joined.GetProperty("seq").GetInt64());
        Assert.Equal(JsonValueKind.Null, joined.GetProperty("state").ValueKind);

        Assert.Equal(1, (await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = new { t = "sit", seat = 0 } })).Body().GetProperty("seq").GetInt64());
        Assert.Equal(2, (await bob.RequestAsync("act.send", new { channelId = games, sessionId, data = new { t = "sit", seat = 1 } })).Body().GetProperty("seq").GetInt64());
        foreach (var user in new[] { alice, bob })
        {
            var first = (await user.EventAsync("act.msg")).Body();
            var second = (await user.EventAsync("act.msg")).Body();
            Assert.Equal((1, alicePid), (first.GetProperty("seq").GetInt64(), first.GetProperty("from").GetString()));
            Assert.Equal((2, bobPid), (second.GetProperty("seq").GetInt64(), second.GetProperty("from").GetString()));
            Assert.Equal(1, second.GetProperty("data").GetProperty("seat").GetInt32());
        }
        await carol.NoEventAsync("act.msg"); // not playing

        // Too big, and a snapshot from the future, are refused.
        Assert.Equal("act_data_size", Key(await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = new string('x', ActivitiesFeature.MaxDataBytes) })));
        Assert.Equal("act_seq", Key(await alice.RequestAsync("act.snapshot", new { channelId = games, sessionId, seq = 9, state = new { } })));

        // A snapshot after message 1, then message 3: Carol gets the snapshot and messages 2 and 3.
        Assert.Equal("result", (await alice.RequestAsync("act.snapshot", new { channelId = games, sessionId, seq = 1, state = new { board = "x" } })).Type());
        await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = new { t = "move", col = 3 } });
        await WatchTestsAccess.Join(server, games, carol);
        var late = (await carol.RequestAsync("act.join", new { channelId = games, sessionId })).Body();
        Assert.Equal("x", late.GetProperty("state").GetProperty("board").GetString());
        Assert.Equal(1, late.GetProperty("stateSeq").GetInt64());
        Assert.Equal([2L, 3L], late.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("seq").GetInt64()).ToArray());
        Assert.False(late.GetProperty("missed").GetBoolean());
        Assert.Equal(3, late.GetProperty("seq").GetInt64());
        // An older snapshot changes nothing.
        await alice.RequestAsync("act.snapshot", new { channelId = games, sessionId, seq = 0, state = new { board = "old" } });
        Assert.Equal(3, (await carol.RequestAsync("act.join", new { channelId = games, sessionId })).Body().GetProperty("session").GetProperty("players").GetArrayLength());

        // Leaving the call stops playing; the call emptying ends the session.
        await WatchTestsAccess.Leave(server, games, carol);
        await SessionWhere(alice, b => b.GetProperty("session").ValueKind == JsonValueKind.Object && b.GetProperty("session").GetProperty("players").GetArrayLength() == 2);
        await WatchTestsAccess.Leave(server, games, alice);
        await WatchTestsAccess.Leave(server, games, bob);
        await SessionWhere(carol, b => b.GetProperty("session").ValueKind == JsonValueKind.Null);
    }

    [Fact]
    public async Task Late_joiners_hear_when_messages_went_before_a_snapshot()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await WatchTestsAccess.Join(server, games, alice);
        await WatchTestsAccess.Join(server, games, bob);
        var sessionId = (await StartAsync(alice, games, "draw")).GetProperty("id").GetString()!;
        var big = new string('x', 7000);
        for (var i = 0; i < 40; i++) // 280 KB: past the 256 KB kept; paced under the rate limit
        {
            var sent = await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = big });
            if (sent.ErrorCode() == "rate_limited") { i--; await Task.Delay(100); }
        }
        var late = (await bob.RequestAsync("act.join", new { channelId = games, sessionId })).Body();
        Assert.True(late.GetProperty("missed").GetBoolean());
        Assert.True(late.GetProperty("messages").GetArrayLength() < 40);
        await alice.RequestAsync("act.snapshot", new { channelId = games, sessionId, seq = 40, state = new { } });
        Assert.False((await bob.RequestAsync("act.join", new { channelId = games, sessionId })).Body().GetProperty("missed").GetBoolean());
    }

    [Fact]
    public async Task Sending_is_rate_limited()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        await WatchTestsAccess.Join(server, games, alice);
        var sessionId = (await StartAsync(alice, games)).GetProperty("id").GetString()!;
        var codes = new List<string?>();
        for (var i = 0; i < 60; i++) codes.Add((await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = i })).ErrorCode());
        Assert.Contains("rate_limited", codes);
    }

    [Fact]
    public async Task Who_may_start_and_end()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        var stage = Voice(server, "listening", write: "admin"); // members only listen here
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        foreach (var user in new[] { admin, alice, bob }) await WatchTestsAccess.Join(server, games, user);

        // Listeners can't start one (they can join one).
        await WatchTestsAccess.Join(server, stage, bob);
        Assert.Equal("act_listen_only", Key(await bob.RequestAsync("act.start", new { channelId = stage, activity = "four" })));
        await WatchTestsAccess.Join(server, games, bob);

        // The server can ask for a higher level to start.
        Assert.Equal("forbidden", (await bob.RequestAsync("act.configure", new { startRole = "member" })).ErrorCode());
        Assert.Equal("admin", (await admin.RequestAsync("act.configure", new { startRole = "admin" })).Body().GetProperty("startRole").GetString());
        Assert.Equal("act_start_role", Key(await alice.RequestAsync("act.start", new { channelId = games, activity = "four" })));
        await admin.RequestAsync("act.configure", new { startRole = "guest" });
        Assert.Single(server.World.Store.Audit("act.configure", null, null, 10), e => e.Details!.Contains("admin"));

        // Built-ins can be turned off.
        await admin.RequestAsync("act.update", new { id = "trivia", enabled = false });
        Assert.Equal("not_found", (await alice.RequestAsync("act.start", new { channelId = games, activity = "trivia" })).ErrorCode());
        Assert.DoesNotContain((await bob.RequestAsync("act.list")).Body().GetProperty("builtins").EnumerateArray(), b => b.GetProperty("id").GetString() == "trivia");

        // Only the starter or an admin ends it, until the starter leaves the call; then any player may.
        var sessionId = (await StartAsync(alice, games)).GetProperty("id").GetString()!;
        await bob.RequestAsync("act.join", new { channelId = games, sessionId });
        Assert.Equal("act_end_starter", Key(await bob.RequestAsync("act.end", new { channelId = games, sessionId })));
        await WatchTestsAccess.Leave(server, games, alice);
        Assert.Equal("result", (await bob.RequestAsync("act.end", new { channelId = games, sessionId })).Type());
        Assert.Equal("not_found", (await bob.RequestAsync("act.end", new { channelId = games, sessionId })).ErrorCode());

        // Turning activities off in the channel ends the one running and refuses new ones.
        sessionId = (await StartAsync(bob, games)).GetProperty("id").GetString()!;
        var off = (await admin.RequestAsync("act.configure", new { channelId = games, off = true })).Body();
        Assert.Equal(games, off.GetProperty("off")[0].GetInt64());
        await SessionWhere(bob, b => b.GetProperty("session").ValueKind == JsonValueKind.Null);
        Assert.Equal("act_off", Key(await bob.RequestAsync("act.start", new { channelId = games, activity = "four" })));
        Assert.Equal("act_voice_only", Key(await admin.RequestAsync("act.configure", new { channelId = server.General, off = true })));
    }

    [Fact]
    public async Task Removing_an_activity_ends_its_sessions()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        await WatchTestsAccess.Join(server, games, admin);
        var id = (await AddAsync(server, admin, Good())).GetProperty("id").GetString()!;
        var session = await StartAsync(admin, games, id);
        Assert.Equal("Snake duel", session.GetProperty("name").GetString());
        Assert.Equal("result", (await admin.RequestAsync("act.remove", new { id })).Type());
        await SessionWhere(admin, b => b.GetProperty("session").ValueKind == JsonValueKind.Null);
        Assert.Empty(admin.Welcome.Body().GetProperty("activities").EnumerateArray());
    }

    [Fact]
    public async Task Bots_and_encrypted_voice_channels_get_no_activities()
    {
        using var t = await E2eeChannelTests.CreateAsync("voice");
        await WatchTestsAccess.Join(t.Server, t.ChannelId, t.Owner);
        Assert.Equal("act_e2ee", Key(await t.Owner.RequestAsync("act.start", new { channelId = t.ChannelId, activity = "four" })));

        var games = Voice(t.Server);
        var code = (await t.Owner.RequestAsync("bot.invite", new { role = "member" })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        var identity = new TestIdentity();
        var client = await t.Server.ConnectAsync();
        var frame = identity.AuthFrame(await client.ReceiveAsync(), "Dice", invite: code);
        ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        using var bot = new User(identity, client, await client.ReceiveAsync());
        Assert.Equal("act_bots", Key(await bot.RequestAsync("act.start", new { channelId = games, activity = "four" })));
    }

    [Fact]
    public async Task Late_joiners_see_running_sessions_in_the_welcome_and_disconnecting_leaves()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        var bob = await server.JoinAsync("Bob");
        await WatchTestsAccess.Join(server, games, alice);
        await WatchTestsAccess.Join(server, games, bob);
        var sessionId = (await StartAsync(alice, games)).GetProperty("id").GetString()!;
        await bob.RequestAsync("act.join", new { channelId = games, sessionId });
        await SessionWhere(alice, b => b.GetProperty("session").ValueKind == JsonValueKind.Object && b.GetProperty("session").GetProperty("players").GetArrayLength() == 2);

        using var carol = await server.JoinAsync("Carol");
        Assert.Equal(sessionId, carol.Welcome.Body().GetProperty("activities")[0].GetProperty("id").GetString());

        bob.Dispose(); // the connection goes: Bob stops playing
        await SessionWhere(alice, b => b.GetProperty("session").ValueKind == JsonValueKind.Object && b.GetProperty("session").GetProperty("players").GetArrayLength() == 1);
        Assert.Equal("result", (await alice.RequestAsync("act.leave", new { channelId = games, sessionId })).Type());
        await SessionWhere(carol, b => b.GetProperty("session").ValueKind == JsonValueKind.Null);
    }

    // ── Security review ──────────────────────────────────────────────────────

    [Fact]
    public async Task A_busy_activity_never_uses_up_the_rest_of_the_connection()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        await WatchTestsAccess.Join(server, games, alice);
        var sessionId = (await StartAsync(alice, games)).GetProperty("id").GetString()!;
        // Far past the general bucket's burst (150): only act.send's own bucket says no.
        for (var i = 0; i < 170; i++) await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = i });
        for (var i = 0; i < 20; i++) Assert.Null((await alice.RequestAsync("ping")).ErrorCode());
        // Ending has its own bucket too.
        var ends = new List<string?>();
        for (var i = 0; i < 8; i++) ends.Add((await alice.RequestAsync("act.end", new { channelId = games, sessionId = "nope" })).ErrorCode());
        Assert.Contains("rate_limited", ends);
    }

    [Fact]
    public async Task Listeners_watch_but_send_nothing()
    {
        using var server = new IskraServer();
        var games = Voice(server, "stage-ish", write: "trusted");
        using var host = await server.JoinAsync("Host", "trusted");
        using var bob = await server.JoinAsync("Bob");
        await WatchTestsAccess.Join(server, games, host);
        await WatchTestsAccess.Join(server, games, bob);
        var sessionId = (await StartAsync(host, games)).GetProperty("id").GetString()!;
        Assert.Equal("result", (await bob.RequestAsync("act.join", new { channelId = games, sessionId })).Type());
        Assert.Equal("act_listen_only", Key(await bob.RequestAsync("act.send", new { channelId = games, sessionId, data = 1 })));
        Assert.Equal("act_listen_only", Key(await bob.RequestAsync("act.snapshot", new { channelId = games, sessionId, seq = 0, state = 1 })));
        Assert.Equal("result", (await host.RequestAsync("act.send", new { channelId = games, sessionId, data = 1 })).Type());
        Assert.Equal(1, (await bob.EventAsync("act.msg")).Body().GetProperty("data").GetInt32());
    }

    [Fact]
    public async Task A_session_has_one_relay_budget_whoever_sends()
    {
        using var server = new IskraServer();
        server.Services.GetRequiredService<Hub>().ActivityRooms.RelayBurstBytes = 20_000;
        server.Services.GetRequiredService<Hub>().ActivityRooms.RelayBytesPerSecond = 1;
        var games = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await WatchTestsAccess.Join(server, games, alice);
        await WatchTestsAccess.Join(server, games, bob);
        var sessionId = (await StartAsync(alice, games)).GetProperty("id").GetString()!;
        await bob.RequestAsync("act.join", new { channelId = games, sessionId });
        var big = new string('x', 4000); // 4 KB to 2 connections: 8 KB each
        Assert.Null((await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = big })).ErrorCode());
        Assert.Null((await bob.RequestAsync("act.send", new { channelId = games, sessionId, data = big })).ErrorCode());
        Assert.Equal("act_busy", Key(await alice.RequestAsync("act.send", new { channelId = games, sessionId, data = big })));
        Assert.Equal("act_busy", Key(await bob.RequestAsync("act.send", new { channelId = games, sessionId, data = big })));
    }

    [Fact]
    public async Task The_manifest_caps_players_and_files_other_than_pages_run_no_scripts()
    {
        using var server = new IskraServer();
        var games = Voice(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var solo = Zip(F("manifest.json", """{ "name": "Solo", "maxPlayers": 1 }"""), F("index.html", Index), F("art.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"));
        var id = (await AddAsync(server, admin, solo)).GetProperty("id").GetString()!;
        await WatchTestsAccess.Join(server, games, admin);
        await WatchTestsAccess.Join(server, games, bob);
        var sessionId = (await StartAsync(admin, games, id)).GetProperty("id").GetString()!;
        var full = await bob.RequestAsync("act.join", new { channelId = games, sessionId });
        Assert.Equal("act_full", Key(full));
        Assert.Equal(1, full.Body().GetProperty("args").GetProperty("max").GetInt32());

        var http = server.CreateClient();
        var svg = await http.GetAsync($"/activities/{id}/art.svg");
        var csp = svg.Headers.GetValues("Content-Security-Policy").Single();
        Assert.StartsWith("sandbox; default-src 'none'; script-src 'none';", csp);
        Assert.DoesNotContain("allow-scripts", csp);
        Assert.Contains("allow-scripts", (await http.GetAsync($"/activities/{id}/index.html")).Headers.GetValues("Content-Security-Policy").Single());
    }

    [Fact]
    public async Task Bundle_files_are_limited_per_address()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = (await AddAsync(server, admin, Good())).GetProperty("id").GetString()!;
        var http = server.CreateClient();
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 320; i++) codes.Add((await http.GetAsync($"/activities/{id}/game.js")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, codes[0]);
        Assert.Contains(HttpStatusCode.TooManyRequests, codes);
    }
}
