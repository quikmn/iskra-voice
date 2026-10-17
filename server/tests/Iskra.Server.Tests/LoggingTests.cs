using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Logging;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Iskra.Server.Tests;

/// <summary>The server's log: one format, nothing personal in it, codes that match protocol/log-codes.json, retention.</summary>
public class LoggingTests
{
    private static readonly DateTimeOffset T = new(2026, 10, 17, 13, 41, 30, 112, TimeSpan.Zero);

    private static string Line(LogLevel level, string area, string evt, string? code, params (string, object?)[] fields) =>
        LogLine.Format(T, level, new LogEntry("srv", area, evt, code, fields));

    // ── format ──────────────────────────────────────────────────────────────

    [Fact]
    public void Lines_have_fixed_columns_in_utc()
    {
        Assert.Equal("2026-10-17T13:41:30.112Z INFO  srv   sess   closed      -       conn=k3f acct=4be1d9 via=tunnel close=1000 why=client dur=6.9s",
            Line(LogLevel.Information, "sess", "closed", null, ("conn", "k3f"), ("acct", "4be1d9"), ("via", "tunnel"), ("close", 1000), ("why", "client"), ("dur", TimeSpan.FromMilliseconds(6930))));
        Assert.Equal("2026-10-17T13:41:30.112Z WARN  srv   voice  stopped     LK-110  what=livekit exit=2 retry=4.0s n=2",
            Line(LogLevel.Warning, "voice", "stopped", "LK-110", ("what", "livekit"), ("exit", 2), ("retry", TimeSpan.FromSeconds(4)), ("n", 2)));
        // Another offset is shown in UTC; no fields means no trailing spaces.
        Assert.Equal("2026-10-17T13:41:30.112Z INFO  srv   life   stop        -",
            LogLine.Format(T.ToOffset(TimeSpan.FromHours(2)), LogLevel.Information, new LogEntry("srv", "life", "stop", null, [])));
        Assert.Equal("2026-10-17T13:41:30.112Z ERROR lk    voice  error       LK-160  msg=\"could not handle ICE\"",
            LogLine.Format(T, LogLevel.Error, new LogEntry("lk", "voice", "error", "LK-160", [("msg", "could not handle ICE")])));
        Assert.Equal("2026-10-17T13:41:30.112Z DEBUG bot:dice sched  failed      BOT-110",
            LogLine.Format(T, LogLevel.Debug, new LogEntry("bot:dice", "sched", "failed", "BOT-110", [])));
        Assert.Equal("2026-10-17T13:41:30.112Z INFO  hook  http   summary     -       count=3 kinds=out-ok:2,in:1",
            LogLine.Format(T, LogLevel.Information, new LogEntry("hook", "http", "summary", null, [("count", 3), ("kinds", "out-ok:2,in:1")])));
    }

    [Fact]
    public void Only_known_words_and_keys_pass()
    {
        // Unknown keys are dropped, unknown areas and events become misc/note, a warning without a code gets SRV-900.
        Assert.Equal("2026-10-17T13:41:30.112Z WARN  srv   misc   note        SRV-900 n=1",
            Line(LogLevel.Warning, "chat", "Something Odd", null, ("name2", "Alice"), ("n", 1), ("text", "hello")));
        // Unknown sources and bots that aren't built in are srv.
        Assert.StartsWith("2026-10-17T13:41:30.112Z INFO  srv   life", LogLine.Format(T, LogLevel.Information, new LogEntry("bot:Alice's bot", "life", "start", null, [])));
        Assert.StartsWith("2026-10-17T13:41:30.112Z INFO  srv   life", LogLine.Format(T, LogLevel.Information, new LogEntry("me", "life", "start", null, [])));
        // A malformed code isn't printed.
        Assert.EndsWith(" start       -", Line(LogLevel.Information, "life", "start", "nope"));
    }

    [Fact]
    public void Values_are_one_line_quoted_and_scrubbed()
    {
        var line = Line(LogLevel.Information, "misc", "note", null, ("msg", "line one\nline \"two\"\r\tend"), ("ok", true), ("loss", 0.125), ("took", TimeSpan.FromMilliseconds(497)));
        Assert.Equal("2026-10-17T13:41:30.112Z INFO  srv   misc   note        -       msg=\"line one line 'two'  end\" ok=yes loss=0.13 took=497ms", line);
        Assert.Single(line.Split('\n'));

        var scrubbed = LogLine.Scrub("from 192.168.1.20:5000 and [2001:db8::1]:443 and fe80::1%eth0 via https://203.0.113.9:8443/hooks/abc/secret?token=x " +
            "mail ada@example.com at C:\\Users\\ada\\iskra\\world and /home/ada/world/server.key key AbCdEfGhIjKlMnOpQrStUv0123456789_-xyzXYZ");
        Assert.DoesNotContain("192.168", scrubbed);
        Assert.DoesNotContain("2001:db8", scrubbed);
        Assert.DoesNotContain("fe80", scrubbed);
        Assert.DoesNotContain("203.0.113", scrubbed);
        Assert.DoesNotContain("secret", scrubbed);
        Assert.DoesNotContain("token=", scrubbed);
        Assert.DoesNotContain("ada", scrubbed);
        Assert.DoesNotContain("AbCdEf", scrubbed);
        Assert.Contains("<ip>", scrubbed);
        Assert.Contains("<path>", scrubbed);
        Assert.Contains("<email>", scrubbed);
        Assert.Contains("<token>", scrubbed);
        // Ordinary words, versions and type names stay.
        Assert.Equal("InvalidOperationException in 2.0.0-alpha.31", LogLine.Scrub("InvalidOperationException in 2.0.0-alpha.31"));
    }

    [Fact]
    public void Exceptions_show_their_type_and_method_never_their_message()
    {
        Exception caught;
        try { Throw(); } catch (Exception e) { caught = e; }
        var line = LogLine.Format(T, LogLevel.Error, new LogEntry("srv", "sess", "failed", "SRV-910", [("op", "chat.send")]), caught);
        Assert.Equal("2026-10-17T13:41:30.112Z ERROR srv   sess   failed      SRV-910 op=chat.send name=InvalidOperationException frame=LoggingTests.Throw inner=IOException", line);

        static void Throw() => throw new InvalidOperationException("Alice's secret C:\\Users\\alice", new IOException("disk at /home/alice"));
    }

    [Fact]
    public void Plain_ILogger_messages_become_one_scrubbed_line()
    {
        var lines = new List<string>();
        var sink = new LogSink(null, console: false);
        sink.Tap += lines.Add;
        using var provider = new IskraLoggerProvider(sink);
        var log = provider.CreateLogger("Microsoft.AspNetCore.Server.Kestrel");
        log.LogWarning("Connection from {Ip} failed:\n{Path}", "10.0.0.7", "/var/lib/iskra");
        var line = Assert.Single(lines);
        Assert.Matches(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z WARN  srv   http   note        SRV-900 msg=""Connection from <ip> failed: <path>""$", line);
    }

    // ── LiveKit ─────────────────────────────────────────────────────────────

    [Fact]
    public void LiveKit_lines_keep_their_level_and_message_only()
    {
        var parsed = LiveKitLines.Parse("2026-10-17T15:41:30.112+0200\tWARN\tlivekit\trtc/participant.go:812\tcould not add ICE candidate\t" +
            "{\"room\": \"voice-12\", \"participant\": \"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd\", \"remote\": \"198.51.100.4:61000\", \"candidate\": \"candidate:1 1 udp 2122260223 192.168.1.20 61000 typ host\"}");
        Assert.NotNull(parsed);
        Assert.Equal(LogLevel.Warning, parsed.Level);
        Assert.Equal("could not add ICE candidate", parsed.Message);
        Assert.Equal(12, parsed.Channel);

        Assert.Equal(LogLevel.Error, LiveKitLines.Parse("2026-10-17T13:41:30.112Z\tERROR\tlivekit\tservice/server.go:1\tfailed for 203.0.113.5")!.Level);
        Assert.Equal("failed for <ip>", LiveKitLines.Parse("2026-10-17T13:41:30.112Z\tERROR\tlivekit\tservice/server.go:1\tfailed for 203.0.113.5")!.Message);
        Assert.Null(LiveKitLines.Parse("goroutine 1 [running]:"));

        var lines = new List<string>();
        var sink = new LogSink(null, console: false);
        sink.Tap += lines.Add;
        using var provider = new IskraLoggerProvider(sink);
        var log = provider.CreateLogger("Iskra.Server.Voice.LiveKitHost");
        var unique = $"a warning nobody else sends {Guid.NewGuid():N}"[..40];
        LiveKitLines.Relay(log, $"2026-10-17T13:41:30.112Z\tWARN\tlivekit\trtc/x.go:1\t{unique}\t{{\"room\": \"voice-3\", \"participant\": \"Alice\"}}");
        LiveKitLines.Relay(log, $"2026-10-17T13:41:30.112Z\tWARN\tlivekit\trtc/x.go:1\t{unique}\t{{\"room\": \"voice-3\"}}"); // the same again: quiet
        var line = Assert.Single(lines, l => l.Contains(" lk "));
        Assert.Contains($" WARN  lk    voice  warn        LK-120  msg=\"{unique}\" chan=3", line);
        Assert.DoesNotContain("Alice", line);
    }

    // ── ids ─────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Welcome_carries_the_connection_log_id_used_in_the_server_log()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var a = alice.Welcome.Body().GetProperty("logId").GetString()!;
        var b = bob.Welcome.Body().GetProperty("logId").GetString()!;
        Assert.Matches("^[0-9a-z]{1,8}$", a);
        Assert.NotEqual(a, b);

        var acct = LogIds.Account(server.World, alice.Key);
        Assert.Matches("^[0-9a-f]{6}$", acct);
        Assert.Equal(acct, LogIds.Account(server.World, alice.Key)); // stable within a server
        Assert.NotEqual(acct, LogIds.Account(server.World, bob.Key));
        await Eventually(() => server.LogLines.Any(l => l.Contains($" sess   opened      -       conn={a} acct={acct} via=direct")));

        // A second server reads the same account differently.
        using var other = new IskraServer();
        _ = other.World;
        Assert.NotEqual(acct, LogIds.Account(other.World, alice.Key));
        Assert.Matches("^[0-9a-f]{4}$", LogIds.Server(server.World.ServerPublicKey));

        alice.Client.Dispose();
        await Eventually(() => server.LogLines.Any(l => l.Contains($"conn={a} acct={acct}") && l.Contains(" closed ") && l.Contains("dur=")));
    }

    // ── privacy ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task A_busy_session_logs_nothing_personal()
    {
        using var server = new IskraServer { AcceptBugReports = true };
        using var owner = await server.JoinAsync("CANARYOWNER", "owner");
        using var alice = await server.JoinAsync("CANARYNAME");
        var http = server.CreateClient();

        // an outgoing webhook that gets every new message (to 127.0.0.1, which must not show up either)
        using var receiver = new OutgoingWebhookTests.Receiver();
        var (_, outSecret) = await OutgoingWebhookTests.Create(owner, receiver.Url, ["message.created"], [server.General]);

        // chat, a channel, an upload, a /tts message
        var channel = (await owner.RequestAsync("channel.create", new { name = "canarychan" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var sent = await alice.RequestAsync("chat.send", new { channelId = server.General, text = "CANARYTEXT hello" });
        Assert.Equal("result", sent.Type());
        Assert.Contains("CANARYTEXT", (await receiver.NextAsync()).Body);
        Assert.Equal("result", (await owner.RequestAsync("chat.send", new { channelId = server.General, text = "CANARYTEXT read aloud", tts = true })).Type());

        // Starboard: one star puts alice's message on the board
        Assert.Equal("result", (await owner.RequestAsync("builtin.bots.set", new { bot = "starboard", enabled = true })).Type());
        Assert.Equal("result", (await owner.RequestAsync("builtin.bots.config.set", new { bot = "starboard", emoji = "⭐", threshold = 1 })).Type());
        Assert.Equal("result", (await owner.RequestAsync("chat.react", new { id = sent.Body().GetProperty("message").GetProperty("id").GetInt64(), emoji = "⭐", on = true })).Type());
        var board = server.World.Store.AllChannels().Single(c => c.Name == "starboard").Id;
        await Eventually(() => server.World.Store.History(board, null, null, 10).Count > 0);
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
        var ticket = (await alice.RequestAsync("upload.begin", new { name = "CANARYFILE.png", size = png.Length })).Body();
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(png))).StatusCode);
        var sha = Convert.ToHexStringLower(SHA256.HashData(png));

        // voice: LiveKit says someone joined and left, and a stranger who gets removed
        var voice = server.World.Store.CreateChannel("canaryvoice", "voice", "member", "member", 0).Id;
        Assert.Equal(HttpStatusCode.OK, await LiveKitWebhook(server, new { @event = "participant_joined", room = new { name = $"voice-{voice}" }, participant = new { identity = alice.Key } }));
        Assert.Equal("result", (await alice.RequestAsync("voice.status.set", new { channelId = voice, text = "CANARYSTATUS ranked" })).Type());
        Assert.Equal(HttpStatusCode.OK, await LiveKitWebhook(server, new { @event = "participant_left", room = new { name = $"voice-{voice}" }, participant = new { identity = alice.Key } }));
        Assert.Equal(HttpStatusCode.OK, await LiveKitWebhook(server, new { @event = "participant_joined", room = new { name = $"voice-{voice}" }, participant = new { identity = "CANARYSTRANGER" } }));
        LiveKitLines.Relay(server.Services.GetRequiredService<ILogger<LiveKitHost>>(),
            $"2026-10-17T13:41:30.112Z\tWARN\tlivekit\trtc/x.go:1\tparticipant CANARYNAME at 198.51.100.4 failed {Guid.NewGuid():N}\t{{\"participant\": \"{alice.Key}\", \"remote\": \"198.51.100.4:6100\"}}");

        // an incoming webhook
        var hook = (await owner.RequestAsync("webhook.create", new { channelId = channel, name = "CANARYHOOK" })).Body();
        var hookPath = hook.GetProperty("path").GetString()!;
        var hookSecret = hook.GetProperty("secret").GetString()!;
        Assert.True((await http.PostAsJsonAsync(hookPath, new { content = "CANARYTEXT from a hook" })).IsSuccessStatusCode);
        // a /github post with a bad signature
        var hookId = hook.GetProperty("webhook").GetProperty("id").GetString()!;
        var signing = string.Concat(Enumerable.Repeat("cd", 8));
        Assert.Equal("result", (await owner.RequestAsync("webhook.signing.set", new { id = hookId, secret = signing })).Type());
        using (var github = new HttpRequestMessage(HttpMethod.Post, hookPath + "/github") { Content = new StringContent("{\"zen\":\"CANARYTEXT\"}", Encoding.UTF8, "application/json") })
        {
            github.Headers.Add("X-GitHub-Event", "ping");
            github.Headers.Add("X-Hub-Signature-256", "sha256=" + new string('0', 64));
            Assert.Equal(HttpStatusCode.Unauthorized, (await http.SendAsync(github)).StatusCode);
        }

        // a bug report
        var bugs = (await owner.RequestAsync("channel.create", new { name = "canarybugs", readRole = "admin" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("buginbox.set", new { enabled = true, channelId = bugs })).Type());
        var report = new { v = 1, what = "CANARYTEXT bug", steps = "", expected = "", email = "canary@example.com", env = new { version = "2.0.0", commit = "abc1234", os = "Windows", browser = "Chrome", device = "desktop", language = "en" } };
        Assert.Equal(HttpStatusCode.Created, (await http.PostAsJsonAsync("/bug-reports", report)).StatusCode);

        // p2p on: members' welcome carries its secret
        Assert.Equal("result", (await owner.RequestAsync("p2p.set", new { enabled = true })).Type());
        using var carol = await server.JoinAsync("CANARYCAROL");
        var p2pSecret = carol.Welcome.Body().GetProperty("server").GetProperty("p2p").GetString();

        // a refused handshake, a rate limit, an unknown request
        var invite = server.Invite();
        using (var stranger = await server.ConnectAsync())
            await stranger.LoginAsync(new TestIdentity(), "CANARYREFUSED", "not-an-invite");
        for (var i = 0; i < 10; i++) await alice.Client.SendAsync(new JsonObject { ["type"] = "chat.typing", ["id"] = $"t{i}", ["body"] = new JsonObject { ["channelId"] = server.General } });
        await alice.RequestAsync("no.such.CANARYTYPE");
        server.Services.GetServices<IHostedService>().OfType<LogMaintenance>().Single().Summarize();

        // the end of a session
        alice.Client.Dispose();
        await Eventually(() => server.LogLines.Any(l => l.Contains(" sess   closed ")));
        await Eventually(() => server.LogLines.Any(l => l.Contains(" voice  left ")) && server.LogLines.Any(l => l.Contains(" rate   summary ")));

        var lines = server.LogLines.ToList();
        var files = Directory.GetFiles(Path.Combine(server.WorldPath, "logs"), "*.log").Select(File.ReadAllText).ToList();
        var all = string.Join('\n', lines.Concat(files));
        Assert.Contains(" sess   opened ", all);
        Assert.Contains(" voice  joined ", all);
        Assert.Contains(" VOI-150 ", all);
        Assert.Contains(" sess   refused     SES-110 ", all);
        Assert.Contains("kinds=chat.typing:", all);
        Assert.Contains(" bug   http   received ", all);
        Assert.Contains(" lk    voice  warn ", all);
        Assert.Contains(" life   start ", all);
        Assert.Contains("in-bad-signature:1", all);
        Assert.Contains("out-ok:", all);

        string?[] canaries =
        [
            "CANARY", "canary", "Canary", outSecret, signing, receiver.Url, alice.Key, alice.Key[..8], owner.Key[..8], carol.Key[..8], sha, sha[..12], invite, hookSecret,
            hookPath, p2pSecret, ticket.GetProperty("url").GetString(), "198.51.100", "127.0.0.1", "::1", server.WorldPath, "example.com",
        ];
        foreach (var canary in canaries.Where(c => !string.IsNullOrEmpty(c)))
            Assert.False(all.Contains(canary!, StringComparison.Ordinal), $"the log contains \"{canary}\":\n{all}");
        // Every line is one line in the format.
        foreach (var line in all.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            Assert.Matches(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (DEBUG|INFO |WARN |ERROR) \S+ +[a-z]+ +[a-z][a-z0-9-]* +(-|[A-Z][A-Z0-9]{1,2}-\d{3})( |$)", line);
    }

    private static async Task<HttpStatusCode> LiveKitWebhook(IskraServer server, object evt)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(evt);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var token = LiveKitTokens.Sign(new JsonObject { ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = Convert.ToBase64String(SHA256.HashData(body)) },
            server.Voice.ApiSecret);
        request.Headers.TryAddWithoutValidation("Authorization", token);
        using var response = await server.CreateClient().SendAsync(request);
        return response.StatusCode;
    }

    private static async Task Eventually(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(50);
        Assert.True(condition());
    }

    // ── codes ───────────────────────────────────────────────────────────────

    private static readonly string[] ServerSources = ["srv", "lk", "p2p", "hook", "bug", "bot"];

    private sealed record Code(string code, string level, string[] sources, string area, string meaning, string action, bool retired = false);

    private static List<Code> Codes() =>
        JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Repo.ProtocolFile("log-codes.json"))).GetProperty("codes").Deserialize<List<Code>>()!;

    private static string ServerSourceDir() => Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Repo.ProtocolFile("PROTOCOL.md")))!, "server", "src", "Iskra.Server");

    [Fact]
    public void Every_code_in_the_server_is_listed_and_every_listed_server_code_is_used()
    {
        var codes = Codes();
        Assert.Equal(codes.Count, codes.Select(c => c.code).Distinct().Count());
        foreach (var c in codes)
        {
            Assert.Matches(LogLine.CodePattern(), c.code);
            Assert.Contains(c.level, new[] { "INFO", "WARN", "ERROR" });
            Assert.Contains(c.area, LogLine.Areas);
            Assert.NotEmpty(c.sources);
            Assert.False(string.IsNullOrWhiteSpace(c.meaning) || string.IsNullOrWhiteSpace(c.action), c.code);
        }

        var used = Directory.EnumerateFiles(ServerSourceDir(), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .SelectMany(f => Regex.Matches(File.ReadAllText(f), "\"([A-Z][A-Z0-9]{1,2}-[0-9]{3})\"").Select(m => m.Groups[1].Value))
            .ToHashSet();
        var listed = codes.Select(c => c.code).ToHashSet();
        Assert.Empty(used.Except(listed));
        var serverListed = codes.Where(c => !c.retired && c.sources.Any(s => ServerSources.Contains(s))).Select(c => c.code);
        Assert.Empty(serverListed.Except(used));
    }

    [Fact]
    public void The_docs_table_is_generated_from_the_codes()
    {
        var sb = new StringBuilder();
        sb.Append("# Log codes\n\n");
        sb.Append("Generated from [protocol/log-codes.json](../protocol/log-codes.json) by the server test `LoggingTests` (run it with\n");
        sb.Append("`ISKRA_WRITE_DOCS=1` to rewrite this file). A code never changes meaning. How to read a log line:\n");
        sb.Append("[development.md, Logs](development.md#logs).\n\n");
        sb.Append("| Code | Level | From | Area | Meaning | What to do |\n|---|---|---|---|---|---|\n");
        foreach (var c in Codes().OrderBy(c => c.code, StringComparer.Ordinal))
            sb.Append($"| {c.code}{(c.retired ? " (retired)" : "")} | {c.level} | {string.Join(", ", c.sources)} | {c.area} | {c.meaning.Replace("|", "\\|")} | {c.action.Replace("|", "\\|")} |\n");
        var expected = sb.ToString();
        var file = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Repo.ProtocolFile("PROTOCOL.md")))!, "docs", "log-codes.md");
        if (Environment.GetEnvironmentVariable("ISKRA_WRITE_DOCS") == "1") File.WriteAllText(file, expected);
        Assert.True(File.Exists(file) && File.ReadAllText(file).ReplaceLineEndings("\n") == expected,
            "docs/log-codes.md is out of date: run this test with ISKRA_WRITE_DOCS=1");
    }

    // ── retention ───────────────────────────────────────────────────────────

    private sealed class LogDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "iskra-logs-" + Guid.NewGuid().ToString("N"));
        public LogDir() => Directory.CreateDirectory(Path);
        public string Day(DateTimeOffset now, int daysAgo, string text = "line\n", bool gz = false)
        {
            var name = System.IO.Path.Combine(Path, LogSink.FileName(now.AddDays(-daysAgo)) + (gz ? ".gz" : ""));
            if (gz)
            {
                using var file = File.Create(name);
                using var zip = new GZipStream(file, CompressionLevel.Fastest);
                zip.Write(Encoding.UTF8.GetBytes(text));
            }
            else File.WriteAllText(name, text);
            return name;
        }
        public string[] Names() => [.. Directory.GetFiles(Path).Select(System.IO.Path.GetFileName).Order(StringComparer.Ordinal)!];
        public void Dispose() { try { Directory.Delete(Path, true); } catch (IOException) { } }
    }

    private static readonly DateTimeOffset Now = new(2026, 10, 17, 3, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Files_stay_plain_then_gzipped_then_go()
    {
        using var dir = new LogDir();
        var today = dir.Day(Now, 0);
        dir.Day(Now, 59, "fifty-nine\n");
        var sixtyOne = dir.Day(Now, 61, "sixty-one\n");
        dir.Day(Now, 179, "kept\n", gz: true);
        dir.Day(Now, 181, "gone\n", gz: true);
        dir.Day(Now, 181, "gone too\n");
        File.WriteAllText(System.IO.Path.Combine(dir.Path, "notes.txt"), "not ours");

        var result = LogRetention.Run(dir.Path, Now, new LogsSettings());
        Assert.Equal(1, result.Compressed);
        Assert.Equal(2, result.Deleted);
        Assert.Equal(
            [LogSink.FileName(Now.AddDays(-179)) + ".gz", LogSink.FileName(Now.AddDays(-61)) + ".gz",
             LogSink.FileName(Now.AddDays(-59)), LogSink.FileName(Now), "notes.txt"],
            dir.Names());
        using (var zip = new GZipStream(File.OpenRead(sixtyOne + ".gz"), CompressionMode.Decompress))
        using (var reader = new StreamReader(zip))
            Assert.Equal("sixty-one\n", reader.ReadToEnd());
        Assert.True(File.Exists(today));

        // Shorter settings, within bounds: 1 day plain, 2 kept. Out-of-bounds values are clamped.
        var again = LogRetention.Run(dir.Path, Now, new LogsSettings { PlainDays = 0, KeepDays = 2, MaxMb = 1 });
        Assert.Equal([LogSink.FileName(Now), "notes.txt"], dir.Names());
        Assert.Equal(new LogsSettings { PlainDays = 1, KeepDays = 2, MaxMb = 10 }, new LogsSettings { PlainDays = 0, KeepDays = 2, MaxMb = 1 }.Bounded());
        Assert.Equal(365, new LogsSettings { PlainDays = 9999, KeepDays = 9999, MaxMb = 99999 }.Bounded().KeepDays);
        Assert.Equal(3, again.Deleted);
    }

    [Fact]
    public void Over_the_size_cap_the_oldest_go_first_but_never_today()
    {
        using var dir = new LogDir();
        var big = new string('x', 4 * 1024 * 1024);
        foreach (var days in new[] { 0, 1, 2, 3 }) dir.Day(Now, days, big); // 16 MB
        dir.Day(Now, 3, "small", gz: true);
        var result = LogRetention.Run(dir.Path, Now, new LogsSettings { MaxMb = 10 });
        Assert.Equal([LogSink.FileName(Now.AddDays(-1)), LogSink.FileName(Now)], dir.Names());
        Assert.Equal(3, result.Deleted);
        Assert.True(result.Bytes <= 10 * 1024 * 1024);

        // Today alone over the cap: kept (never a timebomb that deletes the live file).
        using var only = new LogDir();
        only.Day(Now, 0, new string('x', 11 * 1024 * 1024));
        LogRetention.Run(only.Path, Now, new LogsSettings { MaxMb = 10 });
        Assert.Single(only.Names());
    }

    [Fact]
    public void An_interrupted_compression_is_finished_next_time()
    {
        using var dir = new LogDir();
        var plain = dir.Day(Now, 70, "seventy\n");
        File.WriteAllText(plain + ".gz.tmp", "half a gzip"); // crashed while compressing
        var result = LogRetention.Run(dir.Path, Now, new LogsSettings());
        Assert.Equal(1, result.Compressed);
        Assert.Equal([LogSink.FileName(Now.AddDays(-70)) + ".gz"], dir.Names());

        // Crashed after the rename, before deleting the plain file: the plain copy goes, the gzip stays.
        var again = dir.Day(Now, 70, "seventy\n");
        LogRetention.Run(dir.Path, Now, new LogsSettings());
        Assert.False(File.Exists(again));
        using var zip = new GZipStream(File.OpenRead(again + ".gz"), CompressionMode.Decompress);
        Assert.Equal("seventy\n", new StreamReader(zip).ReadToEnd());
    }

    [Fact]
    public void A_file_that_cant_be_read_is_skipped()
    {
        if (!OperatingSystem.IsWindows()) return; // an exclusive lock is how a file becomes unreadable here
        using var dir = new LogDir();
        var locked = dir.Day(Now, 90, "locked\n");
        var other = dir.Day(Now, 91, "other\n");
        using (new FileStream(locked, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var result = LogRetention.Run(dir.Path, Now, new LogsSettings());
            Assert.Equal(1, result.Compressed);
            Assert.Equal(1, result.Skipped);
        }
        Assert.True(File.Exists(locked));
        Assert.True(File.Exists(other + ".gz"));
        Assert.False(File.Exists(locked + ".gz.tmp"));
    }

    [Fact]
    public void The_server_writes_its_lines_to_the_days_file()
    {
        using var server = new IskraServer();
        _ = server.World;
        var file = Path.Combine(server.WorldPath, "logs", LogSink.FileName(DateTimeOffset.UtcNow));
        for (var i = 0; i < 100 && !(File.Exists(file) && File.ReadAllText(file).Contains(" life   config ")); i++) Thread.Sleep(50);
        var text = File.ReadAllText(file);
        Assert.Contains(" life   start       -       ver=", text);
        Assert.Contains($"srv={LogIds.Server(server.World.ServerPublicKey)}", text);
        Assert.Contains(" plain=60 keep=180 maxmb=200", text);
        Assert.DoesNotContain("DEBUG", text);
    }

    [Fact]
    public void A_world_that_cant_open_leaves_a_coded_line()
    {
        var world = Path.Combine(Path.GetTempPath(), "iskra-bad-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(world);
        try
        {
            LogProblem.Write(world, new JsonException("bad json at C:\\Users\\ada"));
            var text = File.ReadAllText(Path.Combine(world, "logs", LogSink.FileName(DateTimeOffset.UtcNow)));
            Assert.Contains(" ERROR srv   store  failed      STO-110 why=settings-json name=JsonException", text);
            Assert.DoesNotContain("ada", text);
        }
        finally { Directory.Delete(world, true); }
    }
}
