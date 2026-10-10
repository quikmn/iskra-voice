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
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Tests.Support;

/// <summary>A real Iskra server on a throwaway world folder.</summary>
public sealed class IskraServer : WebApplicationFactory<Program>
{
    public string WorldPath { get; } = Path.Combine(Path.GetTempPath(), "iskra-test-" + Guid.NewGuid().ToString("N"));
    public int AuthTimeoutMs { get; init; } = 5_000;
    public bool AllowLoopbackPreviews { get; init; }

    public World World => Services.GetRequiredService<World>();

    /// <summary>Stands in for LiveKit: always available, records removals.</summary>
    public FakeVoiceBackend Voice { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("World", WorldPath);
        builder.UseSetting("Session:AuthTimeoutMs", AuthTimeoutMs.ToString());
        builder.UseSetting("Session:CloseGraceMs", "200");
        builder.UseSetting("Previews:AllowLoopbackForTests", AllowLoopbackPreviews.ToString());
        builder.ConfigureTestServices(services => services.AddSingleton<IVoiceBackend>(Voice));
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
        Assert.Equal("welcome", welcome.GetProperty("type").GetString());
        return new User(identity, client, welcome);
    }

    /// <summary>The id of the default #general channel.</summary>
    public long General => World.Store.AllChannels().Single(c => c.Name == "general").Id;

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { Directory.Delete(WorldPath, recursive: true); } catch (IOException) { }
    }
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
