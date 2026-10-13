using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>
/// The tunnel listener on the real server process (the in-memory test host binds no sockets): connections that start
/// with a PROXY v2 header count as the friend they name, never as this machine; anything else is dropped.
/// </summary>
public class P2pTunnelTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "iskra-p2p-" + Guid.NewGuid().ToString("N"));
    private readonly List<Process> _processes = [];
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _log = new();

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static byte[] ProxyHeader(IPAddress source, int sourcePort)
    {
        var header = new List<byte> { 0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A, 0x21, 0x11, 0x00, 12 };
        header.AddRange(source.GetAddressBytes());
        header.AddRange(IPAddress.Loopback.GetAddressBytes());
        header.AddRange([(byte)(sourcePort >> 8), (byte)sourcePort, 0xB7, 0xE6]);
        return [.. header];
    }

    /// <summary>A TCP connection to the tunnel listener, introduced as <paramref name="friend"/>.</summary>
    private static async Task<NetworkStream> TunnelAsync(int tunnelPort, IPAddress? friend)
    {
        var tcp = new TcpClient();
        await tcp.ConnectAsync(IPAddress.Loopback, tunnelPort);
        var stream = tcp.GetStream();
        if (friend is not null) await stream.WriteAsync(ProxyHeader(friend, 4321));
        return stream;
    }

    /// <summary>One HTTP/1.1 request over a raw stream; returns the status line and body.</summary>
    private static async Task<(int Status, string Body)> HttpAsync(Stream stream, string method, string path, string? body = null)
    {
        var request = $"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n" +
                      (body is null ? "\r\n" : $"Content-Type: application/json\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\n\r\n{body}");
        await stream.WriteAsync(Encoding.UTF8.GetBytes(request));
        using var memory = new MemoryStream();
        var buffer = new byte[16 * 1024];
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            int read;
            while ((read = await stream.ReadAsync(buffer, timeout.Token)) > 0) memory.Write(buffer, 0, read);
        }
        catch (IOException) { /* dropped without a word (a reset) */ }
        var text = Encoding.UTF8.GetString(memory.ToArray());
        if (text.Length == 0) return (0, "");
        var status = int.Parse(text.Split(' ')[1]);
        return (status, text[(text.IndexOf("\r\n\r\n", StringComparison.Ordinal) + 4)..]);
    }

    /// <summary>A WebSocket session through the tunnel (the upgrade by hand, since ClientWebSocket can't send our header first).</summary>
    private static async Task<TestClient> TunnelSocketAsync(int tunnelPort, IPAddress friend)
    {
        var stream = await TunnelAsync(tunnelPort, friend);
        var key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        await stream.WriteAsync(Encoding.ASCII.GetBytes(
            $"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{tunnelPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"));
        var response = new StringBuilder();
        var one = new byte[1];
        while (!response.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
        {
            if (await stream.ReadAsync(one) == 0) throw new Xunit.Sdk.XunitException("The tunnel closed during the WebSocket upgrade.");
            response.Append((char)one[0]);
        }
        Assert.StartsWith("HTTP/1.1 101", response.ToString());
        return new TestClient(WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = false }));
    }

    [Fact]
    public async Task Tunnelled_connections_are_remote_friends_with_the_address_the_tunnel_names()
    {
        var port = FreePort();
        var world = Path.Combine(_dir, "world");
        Directory.CreateDirectory(world);
        File.WriteAllText(Path.Combine(world, "server.json"), JsonSerializer.Serialize(new
        {
            Name = "Tunnelled",
            Port = port,
            LocalOnly = true,
            Voice = new { Enabled = false },
            P2p = new { Enabled = true },
            Retention = new { SecurityLogIps = true },
        }));
        var dll = Path.Combine(AppContext.BaseDirectory, "iskra-server.dll");
        var info = new ProcessStartInfo("dotnet", $"\"{dll}\" \"{world}\"") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        var process = Process.Start(info)!;
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) _log.Enqueue(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) _log.Enqueue(e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _processes.Add(process);

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        for (var i = 0; ; i++)
        {
            try
            {
                if ((await http.GetAsync($"http://127.0.0.1:{port}/")).IsSuccessStatusCode) break;
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { }
            Assert.False(process.HasExited, $"The server stopped: {string.Join("\n", _log)}");
            if (i > 300) throw new Xunit.Sdk.XunitException("The server didn't start.");
            await Task.Delay(100);
        }
        // Started with P2p on: the secret and the tunnel's port are in the folder for the desktop app.
        var portFile = Path.Combine(world, "p2p.port");
        for (var i = 0; i < 100 && !File.Exists(portFile); i++) await Task.Delay(50);
        var tunnelPort = int.Parse(File.ReadAllText(portFile).Trim());
        Assert.NotEqual(port, tunnelPort);
        Assert.Equal(43, File.ReadAllText(Path.Combine(world, "p2p.key")).Trim().Length);

        var friend = IPAddress.Parse("203.0.113.9");
        // Plain HTTP through the tunnel works like through the front door.
        var (status, body) = await HttpAsync(await TunnelAsync(tunnelPort, friend), "GET", "/");
        Assert.Equal(200, status);
        Assert.Contains("\"Tunnelled\"", body);
        // Loopback-only endpoints don't trust the tunnel (the friend isn't this machine)...
        (status, _) = await HttpAsync(await TunnelAsync(tunnelPort, friend), "POST", "/internal/livekit-webhook", "{}");
        Assert.Equal(404, status);
        // ...while the real loopback gets as far as the signature check.
        using var direct = await http.PostAsync($"http://127.0.0.1:{port}/internal/livekit-webhook", new StringContent("{}", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Unauthorized, direct.StatusCode);
        // Without the header the connection is dropped, with no answer at all.
        (status, body) = await HttpAsync(await TunnelAsync(tunnelPort, null), "GET", "/");
        Assert.Equal(0, status);
        Assert.Equal("", body);

        // The owner comes in the front door; a stranger knocks through the tunnel and fails the handshake.
        var ownerLink = File.ReadAllText(Path.Combine(world, "owner-invite.txt")).Trim();
        var ownerCode = ownerLink[(ownerLink.LastIndexOf('.') + 1)..];
        var ownerSocket = new ClientWebSocket();
        await ownerSocket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws"), CancellationToken.None);
        using var ownerIdentity = new TestIdentity();
        using var owner = new TestClient(ownerSocket);
        Assert.Equal("welcome", (await owner.LoginAsync(ownerIdentity, "Owner", ownerCode)).GetProperty("type").GetString());

        using var strangerIdentity = new TestIdentity();
        using var stranger = await TunnelSocketAsync(tunnelPort, friend);
        var refused = await stranger.LoginAsync(strangerIdentity, "Stranger", "not-an-invite-code");
        Assert.Equal("error", refused.GetProperty("type").GetString());
        Assert.Equal("invite_required", refused.GetProperty("body").GetProperty("code").GetString());

        // A friend with a real invite joins through the tunnel and counts as connected through it.
        var invite = await owner.RequestAsync("invite.create", new { });
        var code = invite.GetProperty("body").GetProperty("invite").GetProperty("code").GetString();
        using var friendIdentity = new TestIdentity();
        using var friendClient = await TunnelSocketAsync(tunnelPort, IPAddress.Parse("198.51.100.4"));
        Assert.Equal("welcome", (await friendClient.LoginAsync(friendIdentity, "Friend", code)).GetProperty("type").GetString());
        var p2p = (await owner.RequestAsync("p2p.status")).GetProperty("body").GetProperty("status");
        Assert.Equal(tunnelPort, p2p.GetProperty("tunnelPort").GetInt32());
        Assert.Equal(1, p2p.GetProperty("connected").GetInt32());

        // The security log saw each of them under the address the tunnel named, not 127.0.0.1.
        var log = (await owner.RequestAsync("security.log.list", new { })).GetProperty("body").GetProperty("entries").EnumerateArray().ToList();
        var failed = log.Single(e => e.GetProperty("event").GetString() == "auth.failed");
        Assert.Equal("203.0.113.9", failed.GetProperty("ip").GetString());
        var joined = log.Single(e => e.GetProperty("event").GetString() == "member.joined" && e.GetProperty("account").GetString() == friendIdentity.AccountKey);
        Assert.Equal("198.51.100.4", joined.GetProperty("ip").GetString());
    }

    public void Dispose()
    {
        foreach (var p in _processes)
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); p.WaitForExit(5000); } catch (InvalidOperationException) { }
            p.Dispose();
        }
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
