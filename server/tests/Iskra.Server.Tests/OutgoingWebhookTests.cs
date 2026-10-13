using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class OutgoingWebhookTests
{
    /// <summary>A webhook receiver on 127.0.0.1 for one test: records every request and answers with <see cref="Status"/>.</summary>
    private sealed class Receiver : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public ConcurrentQueue<(Dictionary<string, string> Headers, string Body)> Requests { get; } = new();
        public Func<int, int> Status { get; set; } = _ => 200;
        public string? Location { get; set; }
        private readonly System.Threading.Channels.Channel<(Dictionary<string, string> Headers, string Body)> _arrived =
            System.Threading.Channels.Channel.CreateUnbounded<(Dictionary<string, string> Headers, string Body)>();

        public Receiver()
        {
            var port = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            port.Start();
            var number = ((IPEndPoint)port.LocalEndpoint).Port;
            port.Stop();
            Url = $"http://127.0.0.1:{number}/hook";
            _listener.Prefixes.Add($"http://127.0.0.1:{number}/");
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (_listener.IsListening)
                {
                    try
                    {
                        var c = await _listener.GetContextAsync();
                        using var reader = new StreamReader(c.Request.InputStream, Encoding.UTF8);
                        var body = await reader.ReadToEndAsync();
                        var headers = c.Request.Headers.AllKeys.Where(k => k is not null).ToDictionary(k => k!, k => c.Request.Headers[k]!, StringComparer.OrdinalIgnoreCase);
                        Requests.Enqueue((headers, body));
                        c.Response.StatusCode = Status(Requests.Count);
                        if (Location is not null) c.Response.RedirectLocation = Location;
                        c.Response.Close();
                        _arrived.Writer.TryWrite((headers, body));
                    }
                    catch (Exception) { }
                }
            });
        }

        public async Task<(Dictionary<string, string> Headers, string Body)> NextAsync(int timeoutMs = 5000)
        {
            using var timeout = new CancellationTokenSource(timeoutMs);
            return await _arrived.Reader.ReadAsync(timeout.Token);
        }

        public async Task NothingAsync(int waitMs = 400)
        {
            await Task.Delay(waitMs);
            Assert.False(_arrived.Reader.TryRead(out var extra), $"A webhook arrived: {extra.Body}");
        }

        /// <summary>Forgets what arrived so far (it stays in <see cref="Requests"/>).</summary>
        public void Clear()
        {
            while (_arrived.Reader.TryRead(out _)) { }
        }

        public void Dispose() => _listener.Close();
    }

    private static IskraServer Server(string retries = "40,40,40", int disableAfter = 10) => new()
    {
        Settings = { ["OutgoingWebhooks:RetryDelaysMs"] = retries, ["OutgoingWebhooks:DisableAfter"] = disableAfter.ToString(), ["OutgoingWebhooks:TimeoutMs"] = "3000" },
    };

    private static async Task<(string Id, string Secret)> Create(User owner, string url, string[] events, long[]? channelIds = null, bool allowLocal = true)
    {
        var created = await owner.RequestAsync("outhook.create", new { name = "Bridge", url, events, channelIds = channelIds ?? [], allowLocal });
        Assert.Equal("result", created.Type());
        return (created.Body().GetProperty("hook").GetProperty("id").GetString()!, created.Body().GetProperty("secret").GetString()!);
    }

    private static JsonElement[] Log(JsonElement result) => [.. result.Body().GetProperty("deliveries").EnumerateArray()];

    private static async Task<JsonElement[]> WaitForLog(User admin, string id, Func<JsonElement[], bool> done)
    {
        for (var i = 0; i < 100; i++)
        {
            var log = Log(await admin.RequestAsync("outhook.log", new { id }));
            if (done(log)) return log;
            await Task.Delay(50);
        }
        throw new TimeoutException("The delivery log never got there.");
    }

    private static void AssertSigned((Dictionary<string, string> Headers, string Body) request, string secret)
    {
        var timestamp = request.Headers["Iskra-Webhook-Timestamp"];
        var id = request.Headers["Iskra-Webhook-Id"];
        // Computed here independently, exactly as docs/bots.md tells receivers to.
        var expected = "v1=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret),
            Encoding.UTF8.GetBytes($"iskra-webhook-v1\n{timestamp}\n{id}\n{request.Body}")));
        Assert.Equal(expected, request.Headers["Iskra-Webhook-Signature"]);
        Assert.InRange(long.Parse(timestamp), DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 60, DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 5);
        Assert.Equal(id, JsonDocument.Parse(request.Body).RootElement.GetProperty("id").GetString());
        Assert.StartsWith("application/json", request.Headers["Content-Type"]);
    }

    [Fact]
    public async Task Only_admins_manage_them_and_only_the_owner_allows_the_local_network()
    {
        using var server = Server();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        string[] joins = ["member.joined"];

        Assert.Equal("forbidden", (await alice.RequestAsync("outhook.list")).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("outhook.create", new { name = "x", url = "https://example.com/", events = joins })).ErrorCode());

        // Private addresses need the owner's say-so; an admin can't give it.
        var refused = (await admin.RequestAsync("outhook.create", new { name = "x", url = "https://127.0.0.1/", events = joins })).Body();
        Assert.Equal("outhook_address_private", refused.GetProperty("key").GetString());
        Assert.Equal("outhook_local_owner", (await admin.RequestAsync("outhook.create", new { name = "x", url = "http://127.0.0.1/", events = joins, allowLocal = true })).Body().GetProperty("key").GetString());
        Assert.Equal("outhook_address_private", (await admin.RequestAsync("outhook.create", new { name = "x", url = "https://192.168.1.10/", events = joins })).Body().GetProperty("key").GetString());
        Assert.Equal("outhook_address_private", (await admin.RequestAsync("outhook.create", new { name = "x", url = "https://localhost:8443/", events = joins })).Body().GetProperty("key").GetString());
        // Plain http only on the local network.
        Assert.Equal("outhook_url_http", (await admin.RequestAsync("outhook.create", new { name = "x", url = "http://example.com/", events = joins })).Body().GetProperty("key").GetString());
        Assert.Equal("outhook_url_userinfo", (await admin.RequestAsync("outhook.create", new { name = "x", url = "https://me:pw@example.com/", events = joins })).Body().GetProperty("key").GetString());
        Assert.Equal("outhook_url", (await admin.RequestAsync("outhook.create", new { name = "x", url = "ftp://example.com/", events = joins })).Body().GetProperty("key").GetString());
        // Metadata and link-local stay out even for the owner.
        Assert.Equal("outhook_address_reserved", (await owner.RequestAsync("outhook.create", new { name = "x", url = "http://169.254.169.254/latest", events = joins, allowLocal = true })).Body().GetProperty("key").GetString());
        Assert.Equal("outhook_address_reserved", (await owner.RequestAsync("outhook.create", new { name = "x", url = "https://[fe80::1]/", events = joins, allowLocal = true })).Body().GetProperty("key").GetString());
        // Events and channels.
        Assert.Equal("outhook_events", (await admin.RequestAsync("outhook.create", new { name = "x", url = "https://example.com/", events = new[] { "chat.dm" } })).Body().GetProperty("key").GetString());
        Assert.Equal("outhook_channels", (await admin.RequestAsync("outhook.create", new { name = "x", url = "https://example.com/", events = new[] { "message.created" } })).Body().GetProperty("key").GetString());

        var (id, secret) = await Create(owner, "http://127.0.0.1:9/hook", joins);
        Assert.StartsWith("whs_", secret);
        var list = (await admin.RequestAsync("outhook.list")).Body().GetProperty("hooks");
        Assert.Equal(1, list.GetArrayLength());
        Assert.DoesNotContain(secret, list.GetRawText());
        Assert.True(list[0].GetProperty("allowLocal").GetBoolean());
        Assert.Equal("127.0.0.1", list[0].GetProperty("host").GetString());

        // An admin may rename it, but changing the address drops the owner's permission (and so fails for 127.0.0.1).
        Assert.Equal("result", (await admin.RequestAsync("outhook.update", new { id, name = "Renamed" })).Type());
        Assert.Equal("outhook_url_http", (await admin.RequestAsync("outhook.update", new { id, url = "http://127.0.0.1:10/" })).Body().GetProperty("key").GetString());
        Assert.Equal("outhook_url_http", (await admin.RequestAsync("outhook.update", new { id, allowLocal = false })).Body().GetProperty("key").GetString());
        var (publicId, _) = await Create(owner, "https://203.0.113.10/", joins, allowLocal: false);
        Assert.Equal("outhook_local_owner", (await admin.RequestAsync("outhook.update", new { id = publicId, allowLocal = true })).Body().GetProperty("key").GetString());
        Assert.Equal("result", (await owner.RequestAsync("outhook.delete", new { id = publicId })).Type());
        Assert.True(server.World.Store.GetOutgoingWebhook(id)!.AllowLocal);

        // A new secret replaces the old.
        var regenerated = (await admin.RequestAsync("outhook.regenerate", new { id })).Body().GetProperty("secret").GetString()!;
        Assert.NotEqual(secret, regenerated);
        Assert.Equal(regenerated, server.World.Store.GetOutgoingWebhook(id)!.Secret);

        // Members see where things go: the host and the events, not the address.
        var hosts = (await alice.RequestAsync("outhook.hosts")).Body().GetProperty("hooks");
        Assert.Equal("127.0.0.1", hosts[0].GetProperty("host").GetString());
        Assert.False(hosts[0].TryGetProperty("url", out _));
        Assert.Equal("member.joined", hosts[0].GetProperty("events")[0].GetString());

        Assert.Equal("forbidden", (await alice.RequestAsync("outhook.delete", new { id })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("outhook.delete", new { id })).Type());
        Assert.Equal(0, (await alice.RequestAsync("outhook.hosts")).Body().GetProperty("hooks").GetArrayLength());
    }

    [Fact]
    public async Task Messages_in_chosen_channels_are_posted_signed_and_logged_without_payloads()
    {
        using var server = Server();
        using var receiver = new Receiver();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        var other = (await owner.RequestAsync("channel.create", new { name = "other" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var (id, secret) = await Create(owner, receiver.Url, ["message.created", "reaction.added"], [server.General]);

        await alice.RequestAsync("chat.send", new { channelId = other, text = "not this one" });
        var sent = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hello bridge" })).Body().GetProperty("message");
        var request = await receiver.NextAsync();
        AssertSigned(request, secret);
        Assert.Equal("message.created", request.Headers["Iskra-Webhook-Event"]);
        var payload = JsonDocument.Parse(request.Body).RootElement;
        Assert.Equal("message.created", payload.GetProperty("type").GetString());
        var message = payload.GetProperty("data").GetProperty("message");
        Assert.Equal("hello bridge", message.GetProperty("text").GetString());
        Assert.Equal(sent.GetProperty("id").GetInt64(), message.GetProperty("id").GetInt64());
        Assert.Equal("general", message.GetProperty("channel").GetProperty("name").GetString());
        Assert.Equal(alice.Key, message.GetProperty("author").GetProperty("accountKey").GetString());
        Assert.Equal("Alice", message.GetProperty("author").GetProperty("name").GetString());

        // Reactions too (adding, not removing).
        await owner.RequestAsync("chat.react", new { id = sent.GetProperty("id").GetInt64(), emoji = "👍" });
        var reaction = JsonDocument.Parse((await receiver.NextAsync()).Body).RootElement;
        Assert.Equal("reaction.added", reaction.GetProperty("type").GetString());
        Assert.Equal("👍", reaction.GetProperty("data").GetProperty("emoji").GetString());
        await owner.RequestAsync("chat.react", new { id = sent.GetProperty("id").GetInt64(), emoji = "👍", on = false });
        await receiver.NothingAsync();
        Assert.Equal(2, receiver.Requests.Count);

        var log = await WaitForLog(owner, id, l => l.Length == 2);
        Assert.All(log, d => Assert.Equal("ok", d.GetProperty("outcome").GetString()));
        Assert.All(log, d => Assert.Equal(200, d.GetProperty("status").GetInt32()));
        var raw = (await owner.RequestAsync("outhook.log", new { id })).GetRawText();
        Assert.DoesNotContain("hello bridge", raw);

        // Never anything from an end-to-end encrypted channel, even if the channel became one after the webhook was made.
        server.World.Store.SaveE2eeChange(new E2eeChannel(server.General, "chain", 1, "head", [owner.Key], 1),
            new E2eeChange(1, "{}", "sig", owner.Key, 1), [], fresh: true);
        var hooks = server.Services.GetRequiredService<OutgoingWebhooks>();
        hooks.MessageCreated(server.World.Store.GetChannel(server.General)!, server.World.Store.GetMessage(sent.GetProperty("id").GetInt64())!);
        await receiver.NothingAsync();
    }

    [Fact]
    public async Task Members_joining_and_leaving_and_the_test_ping_are_sent()
    {
        using var server = Server();
        using var receiver = new Receiver();
        using var owner = await server.JoinAsync("Owner", "owner");
        var (id, secret) = await Create(owner, receiver.Url, ["member.joined", "member.left"]);

        var ping = (await owner.RequestAsync("outhook.test", new { id })).Body().GetProperty("delivery");
        Assert.Equal("ok", ping.GetProperty("outcome").GetString());
        var pinged = await receiver.NextAsync();
        AssertSigned(pinged, secret);
        Assert.Equal("ping", JsonDocument.Parse(pinged.Body).RootElement.GetProperty("type").GetString());

        using var bob = await server.JoinAsync("Bob");
        var joined = JsonDocument.Parse((await receiver.NextAsync()).Body).RootElement;
        Assert.Equal("member.joined", joined.GetProperty("type").GetString());
        Assert.Equal("Bob", joined.GetProperty("data").GetProperty("member").GetProperty("name").GetString());

        await bob.RequestAsync("member.leave");
        var left = JsonDocument.Parse((await receiver.NextAsync()).Body).RootElement;
        Assert.Equal("member.left", left.GetProperty("type").GetString());
        Assert.Equal("left", left.GetProperty("data").GetProperty("reason").GetString());
        Assert.Equal(bob.Key, left.GetProperty("data").GetProperty("member").GetProperty("accountKey").GetString());
    }

    [Fact]
    public async Task Failures_are_retried_with_backoff()
    {
        using var server = Server();
        using var receiver = new Receiver { Status = n => n <= 2 ? 503 : 200 };
        using var owner = await server.JoinAsync("Owner", "owner");
        var (id, _) = await Create(owner, receiver.Url, ["member.joined"]);

        using var bob = await server.JoinAsync("Bob");
        var log = await WaitForLog(owner, id, l => l.Any(d => d.GetProperty("outcome").GetString() == "ok"));
        Assert.Equal(3, receiver.Requests.Count);
        // Newest first: the same delivery three times.
        Assert.Equal([3, 2, 1], log.Select(d => d.GetProperty("attempt").GetInt32()));
        Assert.Single(log.Select(d => d.GetProperty("delivery").GetString()).Distinct());
        Assert.Equal(503, log[2].GetProperty("status").GetInt32());
        // Every attempt is signed afresh with the same delivery id.
        Assert.Single(receiver.Requests.Select(r => r.Headers["Iskra-Webhook-Id"]).Distinct());
        Assert.Equal(0, server.World.Store.GetOutgoingWebhook(id)!.Failures);

        // Client errors (other than 408/429) aren't retried.
        receiver.Status = _ => 404;
        using var carol = await server.JoinAsync("Carol");
        await WaitForLog(owner, id, l => l[0].GetProperty("status").ValueKind == JsonValueKind.Number && l[0].GetProperty("status").GetInt32() == 404);
        await Task.Delay(300);
        Assert.Equal(4, receiver.Requests.Count);
    }

    [Fact]
    public async Task A_webhook_that_keeps_failing_turns_off_and_tells_the_admins()
    {
        using var server = Server(retries: "20", disableAfter: 2);
        using var receiver = new Receiver { Status = _ => 500 };
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var (id, _) = await Create(owner, receiver.Url, ["message.created"], [server.General]);

        await alice.RequestAsync("chat.send", new { channelId = server.General, text = "one" });
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = "two" });
        var disabled = (await admin.EventAsync("outhook.disabled")).Body().GetProperty("hook");
        Assert.Equal(id, disabled.GetProperty("id").GetString());
        Assert.False(disabled.GetProperty("enabled").GetBoolean());
        Assert.Equal("failures", disabled.GetProperty("disabledReason").GetString());
        await alice.NoEventAsync("outhook.disabled");
        Assert.Equal(4, receiver.Requests.Count); // two deliveries, two attempts each

        // Off means off; and it no longer shows in "Who Iskra talks to".
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = "three" });
        await Task.Delay(300);
        Assert.Equal(4, receiver.Requests.Count);
        Assert.Equal(0, (await alice.RequestAsync("outhook.hosts")).Body().GetProperty("hooks").GetArrayLength());

        // Turning it back on starts counting again.
        receiver.Status = _ => 204;
        receiver.Clear();
        var on = (await admin.RequestAsync("outhook.update", new { id, enabled = true })).Body().GetProperty("hook");
        Assert.True(on.GetProperty("enabled").GetBoolean());
        Assert.Equal(0, on.GetProperty("failures").GetInt32());
        await alice.RequestAsync("chat.send", new { channelId = server.General, text = "four" });
        Assert.Contains("four", (await receiver.NextAsync()).Body);
    }

    [Fact]
    public async Task Private_addresses_are_blocked_at_delivery_and_redirects_are_not_followed()
    {
        using var server = Server();
        using var receiver = new Receiver();
        using var owner = await server.JoinAsync("Owner", "owner");

        // As if the name had pointed somewhere public when the webhook was made (DNS rebinding): checked again on connect.
        var sneaky = new OutgoingWebhook("sneaky", "Sneaky", receiver.Url.Replace("http://", "https://"), ["member.joined"], [], "whs_x",
            false, true, 0, null, owner.Key, 1, null, null);
        server.World.Store.AddOutgoingWebhook(sneaky);
        var test = (await owner.RequestAsync("outhook.test", new { id = "sneaky" })).Body().GetProperty("delivery");
        Assert.Equal("blocked", test.GetProperty("outcome").GetString());
        Assert.Empty(receiver.Requests);

        // Plain http to the local network without the owner's permission is blocked too.
        server.World.Store.AddOutgoingWebhook(sneaky with { Id = "plain", Url = receiver.Url });
        Assert.Equal("blocked", (await owner.RequestAsync("outhook.test", new { id = "plain" })).Body().GetProperty("delivery").GetProperty("outcome").GetString());
        Assert.Empty(receiver.Requests);

        // A redirect is a failure, never followed.
        using var target = new Receiver();
        receiver.Status = _ => 302;
        receiver.Location = target.Url;
        var (id, _) = await Create(owner, receiver.Url, ["member.joined"]);
        var redirect = (await owner.RequestAsync("outhook.test", new { id })).Body().GetProperty("delivery");
        Assert.Equal("redirect", redirect.GetProperty("outcome").GetString());
        Assert.Equal(302, redirect.GetProperty("status").GetInt32());
        await target.NothingAsync();
    }

    [Fact]
    public async Task Webhook_managers_only_see_webhooks_for_channels_they_can_read()
    {
        using var server = Server();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mia = await server.JoinAsync("Mia");
        var role = (await owner.RequestAsync("role.create", new { name = "Integrations", permissions = new[] { "manageWebhooks" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("member.roles.set", new { accountKey = mia.Key, roles = new[] { role } })).Type());
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        var (id, _) = await Create(owner, "https://203.0.113.10/", ["message.created"], [staff], allowLocal: false);

        // Mia can't read #staff: she can't list, repoint, log or delete the webhook that sends it, nor make one for it.
        Assert.Equal(0, (await mia.RequestAsync("outhook.list")).Body().GetProperty("hooks").GetArrayLength());
        Assert.Equal("not_found", (await mia.RequestAsync("outhook.update", new { id, url = "https://203.0.113.20/" })).ErrorCode());
        Assert.Equal("not_found", (await mia.RequestAsync("outhook.regenerate", new { id })).ErrorCode());
        Assert.Equal("not_found", (await mia.RequestAsync("outhook.log", new { id })).ErrorCode());
        Assert.Equal("not_found", (await mia.RequestAsync("outhook.delete", new { id })).ErrorCode());
        Assert.Equal("not_found", (await mia.RequestAsync("outhook.create",
            new { name = "x", url = "https://203.0.113.20/", events = new[] { "message.created" }, channelIds = new[] { staff } })).ErrorCode());
        Assert.Equal("https://203.0.113.10/", server.World.Store.GetOutgoingWebhook(id)!.Url);

        // One for #general is hers to manage.
        var (mine, _) = await Create(mia, "https://203.0.113.30/", ["message.created"], [server.General], allowLocal: false);
        Assert.Equal(mine, (await mia.RequestAsync("outhook.list")).Body().GetProperty("hooks")[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task Encrypted_channels_and_limits_are_refused()
    {
        using var server = Server();
        using var owner = await server.JoinAsync("Owner", "owner");
        var secret = (await owner.RequestAsync("channel.create", new { name = "secret" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        server.World.Store.SaveE2eeChange(new E2eeChannel(secret, "chain", 1, "head", [owner.Key], 1), new E2eeChange(1, "{}", "sig", owner.Key, 1), [], fresh: true);
        Assert.Equal("bad_request", (await owner.RequestAsync("outhook.create",
            new { name = "x", url = "https://example.com/", events = new[] { "message.created" }, channelIds = new[] { secret } })).ErrorCode());

        for (var i = 0; i < OutgoingWebhookFeature.MaxHooks; i++)
            server.World.Store.AddOutgoingWebhook(new OutgoingWebhook($"h{i}", "x", "https://example.com/", ["member.joined"], [], "whs_x", false, true, 0, null, owner.Key, i, null, null));
        Assert.Equal("outhooks_max", (await owner.RequestAsync("outhook.create",
            new { name = "x", url = "https://203.0.113.10/", events = new[] { "member.joined" } })).Body().GetProperty("key").GetString());
    }

    [Theory]
    [InlineData("127.0.0.1", true, false, true)]
    [InlineData("192.168.1.20", true, false, true)]
    [InlineData("10.0.0.5", true, false, true)]
    [InlineData("100.100.1.1", true, false, true)]   // Tailscale
    [InlineData("fd00::1", true, false, true)]
    [InlineData("169.254.169.254", true, false, false)] // metadata: never
    [InlineData("fe80::1", true, false, false)]
    [InlineData("0.0.0.0", true, false, false)]
    [InlineData("224.0.0.1", true, false, false)]
    [InlineData("192.168.1.20", false, false, false)]
    [InlineData("127.0.0.1", false, false, false)]
    [InlineData("8.8.8.8", false, false, true)]
    [InlineData("8.8.8.8", true, true, false)]      // plain http never leaves the local network
    [InlineData("192.168.1.20", true, true, true)]
    [InlineData("192.168.1.20", false, true, false)]
    public void Addresses_are_checked(string ip, bool allowLocal, bool plainHttp, bool allowed) =>
        Assert.Equal(allowed, OutgoingWebhooks.MayConnect(IPAddress.Parse(ip), allowLocal, plainHttp));

    [Fact]
    public void The_signature_matches_the_documented_vector()
    {
        // The same values as the example in docs/bots.md.
        Assert.Equal(
            Convert.ToHexStringLower(HMACSHA256.HashData("whs_test"u8, "iskra-webhook-v1\n1760000000\nabc\n{\"type\":\"ping\"}"u8)),
            OutgoingWebhooks.Sign("whs_test", 1760000000, "abc", "{\"type\":\"ping\"}"));
        Assert.Equal("61117e1080d5aed00a4e39e279580b31eabbedd00eda8331228b580fb2308c28",
            OutgoingWebhooks.Sign("whs_test", 1760000000, "abc", "{\"type\":\"ping\"}"));
    }
}
