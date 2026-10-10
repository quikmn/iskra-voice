using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Tests.Support;

/// <summary>A real Iskra server on a throwaway world folder.</summary>
public sealed class IskraServer : WebApplicationFactory<Program>
{
    public string WorldPath { get; } = Path.Combine(Path.GetTempPath(), "iskra-test-" + Guid.NewGuid().ToString("N"));
    public int AuthTimeoutMs { get; init; } = 5_000;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("World", WorldPath);
        builder.UseSetting("Session:AuthTimeoutMs", AuthTimeoutMs.ToString());
        builder.UseSetting("Session:CloseGraceMs", "200");
    }

    public async Task<TestClient> ConnectAsync()
    {
        var ws = await Server.CreateWebSocketClient().ConnectAsync(new Uri(Server.BaseAddress, "ws"), CancellationToken.None);
        return new TestClient(ws);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { Directory.Delete(WorldPath, recursive: true); } catch (IOException) { }
    }
}

/// <summary>A client identity built with the C# crypto, independent of the TS client.</summary>
public sealed class TestIdentity : IDisposable
{
    public Key Account { get; } = Ed25519.KeyFromSeed(Ed25519.NewSeed());
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

    public JsonObject AuthFrame(JsonElement hello, string name = "Tester", Func<byte[], byte[], string>? sig = null, JsonObject? cert = null)
    {
        Ed25519.TryFromB64u(hello.GetProperty("body").GetProperty("serverKey").GetString(), out var serverKey);
        Ed25519.TryFromB64u(hello.GetProperty("body").GetProperty("nonce").GetString(), out var nonce);
        return new JsonObject
        {
            ["type"] = "auth",
            ["id"] = "a1",
            ["body"] = new JsonObject
            {
                ["cert"] = cert ?? Cert(),
                ["sig"] = sig is null ? AuthSig(serverKey, nonce) : sig(serverKey, nonce),
                ["profile"] = new JsonObject { ["name"] = name },
            },
        };
    }

    public void Dispose()
    {
        Account.Dispose();
        Device.Dispose();
    }
}

public sealed class TestClient(WebSocket ws) : IDisposable
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public WebSocket Socket => ws;

    public Task SendAsync(JsonNode frame) => SendRawAsync(frame.ToJsonString());

    public Task SendRawAsync(string text) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    /// <summary>Next text frame as JSON. Fails the test if the socket closes or nothing arrives in time.</summary>
    public async Task<JsonElement> ReceiveAsync()
    {
        var (type, text) = await ReceiveFrameAsync();
        Assert.Equal(WebSocketMessageType.Text, type);
        return JsonDocument.Parse(text!).RootElement.Clone();
    }

    /// <summary>Reads until the server closes; returns the close code.</summary>
    public async Task<int> ReceiveCloseAsync()
    {
        while (true)
        {
            var (type, _) = await ReceiveFrameAsync();
            if (type == WebSocketMessageType.Close) return (int)ws.CloseStatus!.Value;
        }
    }

    /// <summary>Connects through the handshake and returns the welcome frame.</summary>
    public async Task<JsonElement> LoginAsync(TestIdentity identity, string name = "Tester")
    {
        var hello = await ReceiveAsync();
        await SendAsync(identity.AuthFrame(hello, name));
        return await ReceiveAsync();
    }

    private async Task<(WebSocketMessageType, string?)> ReceiveFrameAsync()
    {
        using var cts = new CancellationTokenSource(Timeout);
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await ws.ReceiveAsync(buffer, cts.Token);
            if (result.MessageType == WebSocketMessageType.Close) return (WebSocketMessageType.Close, null);
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) return (result.MessageType, Encoding.UTF8.GetString(message.ToArray()));
        }
    }

    public void Dispose() => ws.Dispose();
}

public static class Repo
{
    /// <summary>Finds v2/protocol by walking up from the test binaries.</summary>
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
