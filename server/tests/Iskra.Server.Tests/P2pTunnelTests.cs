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

    /// <summary>The pinned livekit-server in .tools (scripts/get-livekit), or null.</summary>
    private static string? LiveKit()
    {
        var name = OperatingSystem.IsWindows() ? "livekit-server.exe" : "livekit-server";
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, ".tools", name);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private Process StartServer(string world)
    {
        var dll = Path.Combine(AppContext.BaseDirectory, "iskra-server.dll");
        var info = new ProcessStartInfo("dotnet", $"\"{dll}\" \"{world}\"") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        var process = Process.Start(info)!;
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) _log.Enqueue(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) _log.Enqueue(e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _processes.Add(process);
        return process;
    }

    private async Task WaitForServerAsync(Process process, int port)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        for (var i = 0; ; i++)
        {
            try
            {
                if ((await http.GetAsync($"http://127.0.0.1:{port}/")).IsSuccessStatusCode) return;
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { }
            Assert.False(process.HasExited, $"The server stopped: {string.Join("\n", _log)}");
            if (i > 300) throw new Xunit.Sdk.XunitException("The server didn't start.");
            await Task.Delay(100);
        }
    }

    /// <summary>How many log lines so far contain <paramref name="text"/>.</summary>
    private int LinesWith(string text) => _log.Count(l => l.Contains(text, StringComparison.Ordinal));

    private async Task<bool> WaitForLineAsync(string text, int atLeast, int ms)
    {
        for (var waited = 0; waited < ms; waited += 100)
        {
            if (LinesWith(text) >= atLeast) return true;
            await Task.Delay(100);
        }
        return LinesWith(text) >= atLeast;
    }

    /// <summary>Whether a STUN/TURN server answers a Binding request on <paramref name="port"/> (LiveKit's TURN does).</summary>
    private static async Task<bool> StunAnswersAsync(int port)
    {
        using var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        var request = new byte[20];
        request[1] = 0x01; // Binding Request, length 0
        request[4] = 0x21; request[5] = 0x12; request[6] = 0xA4; request[7] = 0x42; // magic cookie
        RandomNumberGenerator.Fill(request.AsSpan(8, 12));
        for (var attempt = 0; attempt < 3; attempt++)
        {
            await udp.SendAsync(request, request.Length, new IPEndPoint(IPAddress.Loopback, port));
            using var timeout = new CancellationTokenSource(1000);
            try
            {
                var answer = await udp.ReceiveAsync(timeout.Token);
                if (answer.Buffer.Length >= 20 && answer.Buffer[0] == 0x01 && answer.Buffer[1] == 0x01) return true; // Binding Success
            }
            catch (OperationCanceledException) { }
            catch (SocketException) { } // nothing listens (ICMP port unreachable)
        }
        return false;
    }

    /// <summary>The owner's session through the front door, from the owner invite the server wrote.</summary>
    private static async Task<(TestClient Client, TestIdentity Identity)> OwnerAsync(string world, int port)
    {
        var ownerLink = File.ReadAllText(Path.Combine(world, "owner-invite.txt")).Trim();
        var ownerCode = ownerLink[(ownerLink.LastIndexOf('.') + 1)..];
        var socket = new ClientWebSocket();
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws"), CancellationToken.None);
        var identity = new TestIdentity();
        var client = new TestClient(socket);
        Assert.Equal("welcome", (await client.LoginAsync(identity, "Owner", ownerCode)).GetProperty("type").GetString());
        return (client, identity);
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
        var process = StartServer(world);
        await WaitForServerAsync(process, port);
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
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
        var (owner, ownerIdentity) = await OwnerAsync(world, port);
        using var _owner = owner;
        using var _ownerIdentity = ownerIdentity;

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

    /// <summary>
    /// Voice through the tunnel needs LiveKit's embedded TURN server, which only runs while the feature is on: turning
    /// it on (and off) restarts LiveKit with (and without) it. Skipped without the pinned livekit-server in .tools.
    /// </summary>
    [Fact]
    public async Task Turning_p2p_on_restarts_voice_with_its_turn_server()
    {
        var livekit = LiveKit();
        Assert.SkipWhen(livekit is null, "livekit-server isn't in .tools");
        int port = FreePort(), voicePort = FreePort(), rtcTcp = FreePort();
        var rtcUdp = 40000 + Random.Shared.Next(20000);
        var world = Path.Combine(_dir, "voice");
        Directory.CreateDirectory(world);
        File.WriteAllText(Path.Combine(world, "server.json"), JsonSerializer.Serialize(new
        {
            Name = "Voice",
            Port = port,
            LocalOnly = true,
            Voice = new { Enabled = true, LiveKitPath = livekit, Port = voicePort, RtcTcpPort = rtcTcp, RtcUdpPort = rtcUdp },
        }));
        var process = StartServer(world);
        await WaitForServerAsync(process, port);
        Assert.True(await WaitForLineAsync("Voice ready", 1, 30_000), $"LiveKit didn't come up:\n{string.Join("\n", _log)}");
        var turnPort = rtcUdp + 1;
        Assert.False(await StunAnswersAsync(turnPort)); // off: no TURN

        var (owner, identity) = await OwnerAsync(world, port);
        using var _owner = owner;
        using var _identity = identity;
        var on = await owner.RequestAsync("p2p.set", new { enabled = true });
        Assert.Equal("result", on.GetProperty("type").GetString());
        // LiveKit restarts with TURN on RtcUdpPort + 1.
        Assert.True(await WaitForLineAsync("Restarting voice", 1, 10_000));
        Assert.True(await WaitForLineAsync("Voice ready", 2, 30_000), $"LiveKit didn't come back:\n{string.Join("\n", _log.TakeLast(60))}");
        Assert.True(await StunAnswersAsync(turnPort), $"No TURN after turning p2p on:\n{string.Join("\n", _log.TakeLast(60))}");

        // Off again: LiveKit restarts without it.
        var off = await owner.RequestAsync("p2p.set", new { enabled = false });
        Assert.Equal("result", off.GetProperty("type").GetString());
        Assert.True(await WaitForLineAsync("Voice ready", 3, 30_000));
        Assert.False(await StunAnswersAsync(turnPort));
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
