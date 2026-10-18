using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Channel = System.Threading.Channels.Channel;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Voice;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Tests.Support;

/// <summary>A real Iskra server on a throwaway world folder.</summary>
public sealed class IskraServer : WebApplicationFactory<Program>
{
    public string WorldPath { get; init; } = Path.Combine(Path.GetTempPath(), "iskra-test-" + Guid.NewGuid().ToString("N"));
    /// <summary>Leaves the world folder when disposed, so a second server can open it (a restart).</summary>
    public bool KeepWorld { get; init; }
    public int AuthTimeoutMs { get; init; } = 5_000;
    public bool AllowLoopbackPreviews { get; init; }
    public int RingTimeoutMs { get; init; } = 45_000;
    /// <summary>Extra configuration, e.g. ["Link:TtlMs"] = "300".</summary>
    public Dictionary<string, string> Settings { get; init; } = [];

    /// <summary>server.json BugInbox.Accept: this server is the one that receives Iskra's bug reports.</summary>
    public bool AcceptBugReports { get; init; }

    public World World => Services.GetRequiredService<World>();

    /// <summary>Every log line this server wrote (console and file get the same lines).</summary>
    public System.Collections.Concurrent.ConcurrentQueue<string> LogLines { get; } = new();

    /// <summary>Stands in for the router (internet hosting); null keeps the real one, which only runs when hosting is on.</summary>
    public Iskra.Server.Hosting.IPortMapper? PortMapper { get; init; }

    /// <summary>Stands in for LiveKit: always available, records removals.</summary>
    public FakeVoiceBackend Voice { get; } = new();

    /// <summary>Stands in for the browser push services: records every push.</summary>
    public FakePushSender Push { get; } = new();

    /// <summary>Stands in for the GIF provider (KLIPY).</summary>
    public FakeGifUpstream Gifs { get; } = new();

    /// <summary>Stands in for Hugging Face (the captions model), with a tiny model of its own.</summary>
    public FakeModelUpstream Models { get; } = new();

    /// <summary>Stands in for Mozilla's storage (translation models), with two tiny models of its own.</summary>
    public FakeTranslationUpstream Translations { get; } = new();

    /// <summary>Stands in for GitHub's releases (server updates).</summary>
    public FakeReleaseFeed Releases { get; } = new();

    /// <summary>The server's clock (its TimeProvider): real time, which a test can move forward instead of waiting.</summary>
    public TestClock Clock { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        if (AcceptBugReports)
        {
            Directory.CreateDirectory(WorldPath);
            File.WriteAllText(Path.Combine(WorldPath, "server.json"), """{ "BugInbox": { "Accept": true } }""");
        }
        builder.UseSetting("World", WorldPath);
        builder.UseSetting("Session:AuthTimeoutMs", AuthTimeoutMs.ToString());
        builder.UseSetting("Session:CloseGraceMs", "200");
        builder.UseSetting("Previews:AllowLoopbackForTests", AllowLoopbackPreviews.ToString());
        builder.UseSetting("Push:CoalesceMs", "600");
        builder.UseSetting("Calls:RingTimeoutMs", RingTimeoutMs.ToString());
        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<TimeProvider>(Clock);
            services.AddSingleton<IVoiceBackend>(Voice);
            services.AddSingleton<Iskra.Server.Push.IPushSender>(Push);
            services.AddSingleton<Iskra.Server.Gifs.IGifUpstream>(Gifs);
            services.AddSingleton<Iskra.Server.Updates.IReleaseFeed>(Releases);
            services.AddSingleton<Iskra.Server.Captions.IModelUpstream>(Models);
            services.AddSingleton(Models.Manifest);
            services.AddSingleton(new Iskra.Server.Translate.TranslationUpstream(Translations));
            services.AddSingleton(Translations.Pins);
            if (PortMapper is not null) services.AddSingleton(PortMapper);
        });
        foreach (var (key, value) in Settings) builder.UseSetting(key, value);
        // Logging is the server's own (Program.cs: one line per entry, console and logs/), never the Windows Event Log:
        // a test host writes there late in shutdown, after its EventLog handle is gone. Tests can tap every line.
        builder.ConfigureLogging(logging => Iskra.Server.Logging.IskraLoggingBuilder.AddIskraLog(logging, Path.Combine(WorldPath, "logs"), tap: LogLines.Enqueue));
    }

    public async Task<TestClient> ConnectAsync()
    {
        var ws = await Server.CreateWebSocketClient().ConnectAsync(new Uri(Server.BaseAddress, "ws"), CancellationToken.None);
        return new TestClient(ws);
    }

    /// <summary>An invite created directly in the store (as if an admin made it).</summary>
    public string Invite(string role = "member") =>
        World.Store.CreateInvite(InviteFeature.NewCode(), "test", role, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null, null).Code;

    /// <summary>A brand-new identity that joins with an invite for <paramref name="role"/>.</summary>
    public async Task<User> JoinAsync(string name, string role = "member")
    {
        var identity = new TestIdentity();
        var client = await ConnectAsync();
        var welcome = await client.LoginAsync(identity, name, Invite(role));
        // The error frame itself when it isn't a welcome: which error it was is the clue.
        Assert.True(welcome.GetProperty("type").GetString() == "welcome", $"{name} didn't get in: {welcome}");
        return new User(identity, client, welcome);
    }

    /// <summary>The id of the default #general channel.</summary>
    public long General => World.Store.AllChannels().Single(c => c.Name == "general").Id;

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!KeepWorld) try { Directory.Delete(WorldPath, recursive: true); } catch (IOException) { }
    }
}

/// <summary>The system clock plus an offset a test moves forward ("time passes") instead of sleeping. Timers and timestamps stay real.</summary>
public sealed class TestClock : TimeProvider
{
    private long _offsetTicks;

    public void Advance(TimeSpan by) => Interlocked.Add(ref _offsetTicks, by.Ticks);

    public override DateTimeOffset GetUtcNow() => System.GetUtcNow() + TimeSpan.FromTicks(Interlocked.Read(ref _offsetTicks));
}

public sealed class FakeVoiceBackend : IVoiceBackend
{
    private bool _available = true;

    public bool Available
    {
        get => _available;
        set
        {
            _available = value;
            AvailabilityChanged?.Invoke(value);
        }
    }

    public event Action<bool>? AvailabilityChanged;
    public string ClientUrl => "ws://voice.test:7880";
    public string ApiKey => "testkey";
    public string ApiSecret => "test-secret-that-is-long-enough-for-hs256";
    public List<(string Room, string Identity)> Removed { get; } = [];

    public Task RemoveParticipantAsync(string room, string identity)
    {
        lock (Removed) Removed.Add((room, identity));
        return Task.CompletedTask;
    }

    /// <summary>Every publish permission change, in order.</summary>
    public List<(string Room, string Identity, bool CanPublish)> Permissions { get; } = [];
    /// <summary>The same list, under the name the moderation tests use.</summary>
    public List<(string Room, string Identity, bool CanPublish)> Updated => Permissions;
    public List<(string Room, string Identity)> Muted { get; } = [];
    /// <summary>Makes permission changes fail, as if LiveKit were unreachable.</summary>
    public bool FailUpdates { get; set; }

    public Task<bool> SetCanPublishAsync(string room, string identity, bool canPublish)
    {
        if (FailUpdates) return Task.FromResult(false);
        lock (Permissions) Permissions.Add((room, identity, canPublish));
        return Task.FromResult(true);
    }

    /// <summary>Publish permission changes for bots (which keep their audio-only grants).</summary>
    public List<(string Room, string Identity, bool CanPublish)> BotPermissions { get; } = [];

    public Task<bool> SetBotCanPublishAsync(string room, string identity, bool canPublish)
    {
        lock (BotPermissions) BotPermissions.Add((room, identity, canPublish));
        return Task.FromResult(true);
    }

    public Task MuteMicrophoneAsync(string room, string identity)
    {
        lock (Muted) Muted.Add((room, identity));
        return Task.CompletedTask;
    }

    /// <summary>Publish and subscribe changes together (the AFK channel), in order.</summary>
    public List<(string Room, string Identity, bool CanPublish, bool CanSubscribe)> FullPermissions { get; } = [];

    public Task<bool> SetPermissionsAsync(string room, string identity, bool canPublish, bool canSubscribe)
    {
        lock (FullPermissions) FullPermissions.Add((room, identity, canPublish, canSubscribe));
        return Task.FromResult(true);
    }

    /// <summary>Rooms the server closed (ended whispers), in order.</summary>
    public List<string> Deleted { get; } = [];

    public Task DeleteRoomAsync(string room)
    {
        lock (Deleted) Deleted.Add(room);
        return Task.CompletedTask;
    }
}

public sealed record User(TestIdentity Identity, TestClient Client, JsonElement Welcome) : IDisposable
{
    public string Key => Identity.AccountKey;
    public Task<JsonElement> RequestAsync(string type, object? body = null) => Client.RequestAsync(type, body);
    public Task<JsonElement> EventAsync(string type) => Client.EventAsync(type);
    public Task NoEventAsync(string type) => Client.NoEventAsync(type);

    public void Dispose()
    {
        Client.Dispose();
        Identity.Dispose();
    }
}

/// <summary>A client identity built with the C# crypto, independent of the TS client.</summary>
public sealed class TestIdentity : IDisposable
{
    private readonly bool _ownsAccount = true;

    public TestIdentity() => Account = Ed25519.KeyFromSeed(Ed25519.NewSeed());

    /// <summary>Another device of an existing account.</summary>
    public TestIdentity(Key account)
    {
        Account = account;
        _ownsAccount = false;
    }

    public Key Account { get; }
    public Key Device { get; } = Ed25519.KeyFromSeed(Ed25519.NewSeed());
    public long Created { get; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public string AccountKey => Ed25519.ToB64u(Ed25519.PublicKeyOf(Account));

    public JsonObject Cert(Key? signWith = null)
    {
        var devicePub = Ed25519.PublicKeyOf(Device);
        var sig = Ed25519.Sign(signWith ?? Account, Ed25519.Payload(Identity.DeviceCertContext, devicePub, Ed25519.U64BigEndian(Created)));
        return new JsonObject
        {
            ["accountKey"] = AccountKey,
            ["deviceKey"] = Ed25519.ToB64u(devicePub),
            ["created"] = Created,
            ["sig"] = Ed25519.ToB64u(sig),
        };
    }

    public string AuthSig(byte[] serverKey, byte[] nonce, Key? signWith = null) =>
        Ed25519.ToB64u(Ed25519.Sign(signWith ?? Device, Ed25519.Payload(Identity.AuthContext, serverKey, nonce)));

    public JsonObject AuthFrame(JsonElement hello, string name = "Tester", Func<byte[], byte[], string>? sig = null,
        JsonObject? cert = null, string? invite = null)
    {
        Ed25519.TryFromB64u(hello.GetProperty("body").GetProperty("serverKey").GetString(), out var serverKey);
        Ed25519.TryFromB64u(hello.GetProperty("body").GetProperty("nonce").GetString(), out var nonce);
        var body = new JsonObject
        {
            ["cert"] = cert ?? Cert(),
            ["sig"] = sig is null ? AuthSig(serverKey, nonce) : sig(serverKey, nonce),
            ["profile"] = new JsonObject { ["name"] = name },
        };
        if (invite is not null) body["invite"] = invite;
        return new JsonObject { ["type"] = "auth", ["id"] = "a1", ["body"] = body };
    }

    public void Dispose()
    {
        if (_ownsAccount) Account.Dispose();
        Device.Dispose();
    }
}

/// <summary>
/// Test side of a connection. A background pump reads every frame into a queue, so tests can wait with
/// timeouts without cancelling socket reads (which would abort the socket).
/// </summary>
public sealed class TestClient : IDisposable
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    private readonly WebSocket _ws;
    private readonly Channel<JsonElement> _frames = System.Threading.Channels.Channel.CreateUnbounded<JsonElement>();
    private readonly List<JsonElement> _stash = [];
    private int _nextId;

    public TestClient(WebSocket ws)
    {
        _ws = ws;
        _ = PumpAsync();
    }

    public int? CloseStatus { get; private set; }
    public string? CloseReason { get; private set; }

    private async Task PumpAsync()
    {
        var buffer = new byte[128 * 1024];
        try
        {
            while (true)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(buffer, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        CloseStatus = (int?)_ws.CloseStatus;
                        CloseReason = _ws.CloseStatusDescription;
                        return;
                    }
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                _frames.Writer.TryWrite(JsonDocument.Parse(message.ToArray()).RootElement.Clone());
            }
        }
        catch (Exception) { /* socket gone */ }
        finally
        {
            _frames.Writer.TryComplete();
        }
    }

    public Task SendAsync(JsonNode frame) => SendRawAsync(frame.ToJsonString());

    public Task SendRawAsync(string text) =>
        _ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    /// <summary>The next frame, whatever it is.</summary>
    public async Task<JsonElement> ReceiveAsync()
    {
        if (_stash.Count > 0)
        {
            var first = _stash[0];
            _stash.RemoveAt(0);
            return first;
        }
        using var cts = new CancellationTokenSource(Timeout);
        try
        {
            return await _frames.Reader.ReadAsync(cts.Token);
        }
        catch (ChannelClosedException)
        {
            throw new Xunit.Sdk.XunitException($"Socket closed (status {CloseStatus}) while waiting for a frame.");
        }
    }

    /// <summary>Reads until the server closes; returns the close code.</summary>
    public async Task<int> ReceiveCloseAsync()
    {
        using var cts = new CancellationTokenSource(Timeout);
        await foreach (var _ in _frames.Reader.ReadAllAsync(cts.Token)) { }
        return CloseStatus ?? throw new Xunit.Sdk.XunitException("Socket ended without a close status.");
    }

    /// <summary>Sends a request and returns its result or error frame. Events that arrive meanwhile are kept for <see cref="EventAsync"/>.</summary>
    public async Task<JsonElement> RequestAsync(string type, object? body = null)
    {
        var id = $"r{++_nextId}";
        var frame = new JsonObject { ["type"] = type, ["id"] = id };
        if (body is not null) frame["body"] = JsonSerializer.SerializeToNode(body);
        await SendAsync(frame);

        var skipped = new List<JsonElement>();
        try
        {
            while (true)
            {
                var next = await ReceiveAsync();
                if (next.TryGetProperty("id", out var replyId) && replyId.GetString() == id) return next;
                skipped.Add(next);
            }
        }
        finally
        {
            _stash.InsertRange(0, skipped);
        }
    }

    /// <summary>The next event of <paramref name="type"/>; other frames are kept.</summary>
    public async Task<JsonElement> EventAsync(string type)
    {
        var index = _stash.FindIndex(f => f.GetProperty("type").GetString() == type);
        if (index >= 0)
        {
            var found = _stash[index];
            _stash.RemoveAt(index);
            return found;
        }
        using var cts = new CancellationTokenSource(Timeout);
        while (true)
        {
            JsonElement next;
            try
            {
                next = await _frames.Reader.ReadAsync(cts.Token);
            }
            catch (ChannelClosedException)
            {
                throw new Xunit.Sdk.XunitException($"Socket closed (status {CloseStatus}) while waiting for '{type}'.");
            }
            if (next.GetProperty("type").GetString() == type) return next;
            _stash.Add(next);
        }
    }

    /// <summary>Asserts that no event of <paramref name="type"/> arrives within a short window.</summary>
    public async Task NoEventAsync(string type, int waitMs = 300)
    {
        Assert.DoesNotContain(_stash, f => f.GetProperty("type").GetString() == type);
        using var cts = new CancellationTokenSource(waitMs);
        try
        {
            while (true)
            {
                var next = await _frames.Reader.ReadAsync(cts.Token);
                Assert.NotEqual(type, next.GetProperty("type").GetString());
                _stash.Add(next);
            }
        }
        catch (OperationCanceledException) { }
        catch (ChannelClosedException) { }
    }

    /// <summary>Connects through the handshake and returns the welcome frame.</summary>
    public async Task<JsonElement> LoginAsync(TestIdentity identity, string name = "Tester", string? invite = null)
    {
        var hello = await ReceiveAsync();
        await SendAsync(identity.AuthFrame(hello, name, invite: invite));
        return await ReceiveAsync();
    }

    public void Dispose() => _ws.Dispose();
}

public static class Repo
{
    /// <summary>Finds protocol/ by walking up from the test binaries.</summary>
    public static string ProtocolFile(string name)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "protocol", name);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException($"protocol/{name} not found above {AppContext.BaseDirectory}");
    }
}

public static class JsonExtensions
{
    public static JsonElement Body(this JsonElement frame) => frame.GetProperty("body");
    public static string Type(this JsonElement frame) => frame.GetProperty("type").GetString()!;
    public static string? ErrorCode(this JsonElement frame) =>
        frame.Type() == "error" ? frame.Body().GetProperty("code").GetString() : null;
}
