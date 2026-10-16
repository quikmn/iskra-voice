using System.Buffers;
using System.Diagnostics;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Iskra.Server.Hosting;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>
/// Https.ProxyProtocol: several servers on one machine behind a TLS-passthrough proxy (nginx stream). The real server
/// process, with a PROXY protocol header written by the test where nginx would: only a trusted address may send one,
/// it's required when the option is on, and the client it names is the connection's address everywhere, never this machine.
/// </summary>
public class ProxyProtocolTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "iskra-proxy-" + Guid.NewGuid().ToString("N"));
    private readonly List<Process> _processes = [];
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _log = new();

    // --- the header itself ---

    private static ProxyProtocol.Header Parse(string text, out IPEndPoint? peer, out long consumed) =>
        ProxyProtocol.TryParse(new ReadOnlySequence<byte>(Encoding.ASCII.GetBytes(text)), out consumed, out peer);

    private static ProxyProtocol.Header Parse(byte[] bytes, out IPEndPoint? peer, out long consumed) =>
        ProxyProtocol.TryParse(new ReadOnlySequence<byte>(bytes), out consumed, out peer);

    [Fact]
    public void Reads_version_1_headers_and_refuses_anything_else()
    {
        Assert.Equal(ProxyProtocol.Header.Ok, Parse("PROXY TCP4 203.0.113.9 127.0.0.1 4321 443\r\nGET /", out var peer, out var consumed));
        Assert.Equal(new IPEndPoint(IPAddress.Parse("203.0.113.9"), 4321), peer);
        Assert.Equal("PROXY TCP4 203.0.113.9 127.0.0.1 4321 443\r\n".Length, consumed);
        Assert.Equal(ProxyProtocol.Header.Ok, Parse("PROXY TCP6 2001:db8::9 ::1 5000 443\r\n", out peer, out _));
        Assert.Equal(new IPEndPoint(IPAddress.Parse("2001:db8::9"), 5000), peer);
        Assert.Equal(ProxyProtocol.Header.Ok, Parse("PROXY TCP6 ::ffff:198.51.100.4 ::1 5000 443\r\n", out peer, out _));
        Assert.Equal(IPAddress.Parse("198.51.100.4"), peer!.Address); // IPv4-mapped counts as IPv4

        // Not all there yet.
        Assert.Equal(ProxyProtocol.Header.Incomplete, Parse("PRO", out _, out _));
        Assert.Equal(ProxyProtocol.Header.Incomplete, Parse("PROXY TCP4 203.0.113.9 127.0.0.1 4321 443", out _, out _));
        Assert.Equal(ProxyProtocol.Header.Incomplete, Parse([], out _, out _));

        foreach (var bad in new[]
        {
            "GET / HTTP/1.1\r\nHost: x\r\n\r\n",
            "PROXY UNKNOWN\r\n",                                          // no client to name
            "PROXY UNKNOWN 203.0.113.9 127.0.0.1 4321 443\r\n",
            "PROXY TCP4 203.0.113.9 127.0.0.1 4321\r\n",                   // a field missing
            "PROXY TCP4 203.0.113.9 127.0.0.1 4321 443 extra\r\n",
            "PROXY TCP4  203.0.113.9 127.0.0.1 4321 443\r\n",              // two spaces
            "PROXY TCP4 2001:db8::9 127.0.0.1 4321 443\r\n",               // wrong family
            "PROXY TCP6 203.0.113.9 ::1 4321 443\r\n",
            "PROXY TCP4 1 127.0.0.1 4321 443\r\n",                         // not a dotted quad
            "PROXY TCP4 203.0.113.9 127.0.0.1 65536 443\r\n",
            "PROXY TCP4 203.0.113.9 127.0.0.1 04321 443\r\n",
            "PROXY TCP4 203.0.113.9 127.0.0.1 -1 443\r\n",
            "proxy TCP4 203.0.113.9 127.0.0.1 4321 443\r\n",
            "PROXY TCP4 203.0.113.9 127.0.0.1 4321 443\n",
            "PROXY TCP4 " + new string('1', 120) + "\r\n",                 // longer than the 107 bytes v1 allows
        })
        {
            Assert.Equal(ProxyProtocol.Header.Invalid, Parse(bad, out _, out _));
        }
        Assert.Equal(ProxyProtocol.Header.Invalid, Parse("PROXY TCP4 " + new string('1', 120), out _, out _)); // no CRLF in time
    }

    private static byte[] V2(IPAddress source, int sourcePort, byte[]? tlvs = null)
    {
        var v4 = source.AddressFamily == AddressFamily.InterNetwork;
        var destination = v4 ? IPAddress.Loopback : IPAddress.IPv6Loopback;
        var length = (v4 ? 12 : 36) + (tlvs?.Length ?? 0);
        var header = new List<byte> { 0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A, 0x21, (byte)(v4 ? 0x11 : 0x21), (byte)(length >> 8), (byte)length };
        header.AddRange(source.GetAddressBytes());
        header.AddRange(destination.GetAddressBytes());
        header.AddRange([(byte)(sourcePort >> 8), (byte)sourcePort, 0x01, 0xBB]);
        header.AddRange(tlvs ?? []);
        return [.. header];
    }

    [Fact]
    public void Reads_version_2_headers_with_tlvs()
    {
        byte[] tlv = [0x02, 0x00, 0x0F, .. "chat.iskra.foo."u8.ToArray()]; // PP2_TYPE_AUTHORITY, skipped
        var header = V2(IPAddress.Parse("203.0.113.9"), 4321, tlv);
        Assert.Equal(ProxyProtocol.Header.Ok, Parse([.. header, .. "\x16"u8.ToArray()], out var peer, out var consumed));
        Assert.Equal(new IPEndPoint(IPAddress.Parse("203.0.113.9"), 4321), peer);
        Assert.Equal(header.Length, consumed);
        Assert.Equal(ProxyProtocol.Header.Incomplete, Parse(header[..^3], out _, out _));
        Assert.Equal(ProxyProtocol.Header.Incomplete, Parse(header[..5], out _, out _));
        Assert.Equal(ProxyProtocol.Header.Invalid, Parse([0x0D, 0x0A, 0x0D, 0x0B], out _, out _));
        var huge = V2(IPAddress.Parse("203.0.113.9"), 4321, new byte[4000]);
        Assert.Equal(ProxyProtocol.Header.Invalid, Parse(huge, out _, out _));
    }

    [Fact]
    public void Trusted_addresses_must_be_ip_addresses()
    {
        Assert.Equal([IPAddress.Loopback, IPAddress.IPv6Loopback], ProxyProtocol.Trusted(new Storage.HttpsSettings().ProxyTrustedFrom));
        Assert.Equal([IPAddress.Parse("10.0.0.2")], ProxyProtocol.Trusted(["::ffff:10.0.0.2"]));
        Assert.Throws<InvalidDataException>(() => ProxyProtocol.Trusted(["localhost"]));
        Assert.Throws<InvalidDataException>(() => ProxyProtocol.Trusted([]));
    }

    [Fact]
    public void A_proxied_client_is_never_this_machine()
    {
        static Microsoft.AspNetCore.Http.DefaultHttpContext Request(string ip, object? feature = null)
        {
            var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
            context.Request.Path = "/hooks/abc/secret";
            context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
            if (feature is ProxiedPeer proxied) context.Features.Set(proxied);
            if (feature is TunnelPeer tunnelled) context.Features.Set(tunnelled);
            return context;
        }
        var local = new IPEndPoint(IPAddress.Loopback, 5000);
        Assert.False(Networks.IsElsewhere(Request("127.0.0.1")));
        Assert.False(Networks.IsElsewhere(Request("::1")));
        Assert.False(Networks.IsElsewhere(Request("::ffff:127.0.0.1")));
        Assert.True(Networks.IsElsewhere(Request("203.0.113.9")));
        // A header naming 127.0.0.1 (a lying or local client of the proxy) still isn't this machine.
        Assert.True(Networks.IsElsewhere(Request("127.0.0.1", new ProxiedPeer(local, local))));
        Assert.True(Networks.IsElsewhere(Request("127.0.0.1", new TunnelPeer(local))));
        Assert.True(Features.WebhookIngress.RefuseOverPlainHttp(Request("127.0.0.1", new ProxiedPeer(local, local))));
        Assert.False(Features.WebhookIngress.RefuseOverPlainHttp(Request("127.0.0.1")));
    }

    // --- the real server ---

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private Process Start(string file, string arguments, Dictionary<string, string>? env = null)
    {
        var info = new ProcessStartInfo(file, arguments) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var (k, v) in env ?? []) info.Environment[k] = v;
        var process = Process.Start(info)!;
        var tag = Path.GetFileNameWithoutExtension(file);
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) _log.Enqueue($"[{tag}] {e.Data}"); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) _log.Enqueue($"[{tag}!] {e.Data}"); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _processes.Add(process);
        return process;
    }

    private Process StartServer(string world, string extra = "") =>
        Start("dotnet", $"\"{Path.Combine(AppContext.BaseDirectory, "iskra-server.dll")}\" \"{world}\" {extra}");

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

    /// <summary>A self-signed certificate for localhost, as Https.Mode "files" takes it (PEM).</summary>
    private (string Cert, string Key) Certificate()
    {
        Directory.CreateDirectory(_dir);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        request.CertificateExtensions.Add(san.Build());
        using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
        var (certFile, keyFile) = (Path.Combine(_dir, "cert.pem"), Path.Combine(_dir, "key.pem"));
        File.WriteAllText(certFile, cert.ExportCertificatePem());
        File.WriteAllText(keyFile, key.ExportPkcs8PrivateKeyPem());
        return (certFile, keyFile);
    }

    private static byte[] V1(IPAddress client, int port = 4321) =>
        Encoding.ASCII.GetBytes($"PROXY {(client.AddressFamily == AddressFamily.InterNetwork ? "TCP4" : "TCP6")} {client} {(client.AddressFamily == AddressFamily.InterNetwork ? "127.0.0.1" : "::1")} {port} 443\r\n");

    /// <summary>A connection to <paramref name="port"/> as a proxy would make it: the header, then (optionally) TLS. Null if it was dropped.</summary>
    private static async Task<Stream?> ConnectAsync(int port, byte[]? header, bool tls)
    {
        var tcp = new TcpClient();
        await tcp.ConnectAsync(IPAddress.Loopback, port);
        Stream stream = tcp.GetStream();
        if (header is not null)
        {
            // A listener that refuses the connection may close it before the header is even sent: that's a drop too.
            try { await stream.WriteAsync(header); }
            catch (IOException) { tcp.Dispose(); return null; }
        }
        if (!tls) return stream;
        var ssl = new SslStream(stream, false, (_, _, _, _) => true);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = "localhost" }, timeout.Token);
            return ssl;
        }
        catch (Exception e) when (e is IOException or System.Security.Authentication.AuthenticationException or OperationCanceledException)
        {
            ssl.Dispose();
            return null;
        }
    }

    /// <summary>One HTTP/1.1 request; returns the status (0 if dropped without an answer), the headers and the body.</summary>
    private static async Task<(int Status, string Head, string Body)> HttpAsync(Stream? stream, string method, string path, string? body = null)
    {
        if (stream is null) return (0, "", "");
        await using var _ = stream;
        var request = $"{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n" +
                      (body is null ? "\r\n" : $"Content-Type: application/json\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\n\r\n{body}");
        using var memory = new MemoryStream();
        try
        {
            await stream.WriteAsync(Encoding.UTF8.GetBytes(request));
            var buffer = new byte[16 * 1024];
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            int read;
            while ((read = await stream.ReadAsync(buffer, timeout.Token)) > 0) memory.Write(buffer, 0, read);
        }
        catch (IOException) { /* dropped (a reset) */ }
        var text = Encoding.UTF8.GetString(memory.ToArray());
        if (text.Length == 0) return (0, "", "");
        var split = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        return (int.Parse(text.Split(' ')[1]), text[..split], text[(split + 4)..]);
    }

    /// <summary>A WebSocket session over TLS through the "proxy" (the upgrade by hand: ClientWebSocket can't send the header first).</summary>
    private static async Task<TestClient> SocketAsync(int port, byte[] header)
    {
        var stream = await ConnectAsync(port, header, tls: true) ?? throw new Xunit.Sdk.XunitException("The proxied TLS connection was dropped.");
        var key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        await stream.WriteAsync(Encoding.ASCII.GetBytes(
            $"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"));
        var response = new StringBuilder();
        var one = new byte[1];
        while (!response.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
        {
            if (await stream.ReadAsync(one) == 0) throw new Xunit.Sdk.XunitException("Closed during the WebSocket upgrade.");
            response.Append((char)one[0]);
        }
        Assert.StartsWith("HTTP/1.1 101", response.ToString());
        return new TestClient(WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = false }));
    }

    private string World(object https, object? extra = null)
    {
        var world = Path.Combine(_dir, "world-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(world);
        var settings = JsonSerializer.SerializeToNode(new
        {
            Name = "Proxied",
            LocalOnly = true,
            PublicUrl = "https://localhost",
            Voice = new { Enabled = false },
            Retention = new { SecurityLogIps = true },
        })!.AsObject();
        settings["Https"] = JsonSerializer.SerializeToNode(https);
        if (extra is not null)
            foreach (var (k, v) in JsonSerializer.SerializeToNode(extra)!.AsObject().ToList())
                settings[k] = v?.DeepClone();
        File.WriteAllText(Path.Combine(world, "server.json"), settings.ToJsonString());
        return world;
    }

    [Fact]
    public async Task Behind_the_proxy_the_header_names_the_client_everywhere()
    {
        var (cert, key) = Certificate();
        int port = FreePort(), httpsPort = FreePort(), httpPort = FreePort();
        var world = World(new
        {
            Mode = "files", Domain = "localhost", CertFile = cert, KeyFile = key, Port = httpsPort, HttpPort = httpPort,
            ProxyProtocol = true, HttpProxyProtocol = true,
        }, new { Port = port });
        var process = StartServer(world);
        await WaitForServerAsync(process, port);

        // v1 (nginx) and v2 (HAProxy send-proxy-v2), over IPv4 and IPv6: HTTPS works behind the header.
        var (status, _, body) = await HttpAsync(await ConnectAsync(httpsPort, V1(IPAddress.Parse("203.0.113.9")), tls: true), "GET", "/");
        Assert.Equal(200, status);
        Assert.Contains("\"Proxied\"", body);
        (status, _, _) = await HttpAsync(await ConnectAsync(httpsPort, V1(IPAddress.Parse("2001:db8::9")), tls: true), "GET", "/");
        Assert.Equal(200, status);
        (status, _, _) = await HttpAsync(await ConnectAsync(httpsPort, V2(IPAddress.Parse("203.0.113.9"), 4321), tls: true), "GET", "/");
        Assert.Equal(200, status);
        (status, _, _) = await HttpAsync(await ConnectAsync(httpsPort, V2(IPAddress.Parse("2001:db8::9"), 4321), tls: true), "GET", "/");
        Assert.Equal(200, status);

        // Without a header (or with junk instead) the connection is dropped, even from the trusted address.
        Assert.Null(await ConnectAsync(httpsPort, null, tls: true));
        Assert.Null(await ConnectAsync(httpsPort, "PROXY UNKNOWN\r\n"u8.ToArray(), tls: true));
        (status, _, _) = await HttpAsync(await ConnectAsync(httpPort, null, tls: false), "GET", "/");
        Assert.Equal(0, status);

        // Plain HTTP behind the header: redirects to PublicUrl (not Https.Port); webhooks are refused, not redirected.
        (status, var head, _) = await HttpAsync(await ConnectAsync(httpPort, V1(IPAddress.Parse("203.0.113.9")), tls: false), "GET", "/some/page?x=1");
        Assert.Equal(302, status);
        Assert.Contains("Location: https://localhost/some/page?x=1", head);
        (status, _, _) = await HttpAsync(await ConnectAsync(httpPort, V1(IPAddress.Parse("203.0.113.9")), tls: false), "POST", "/hooks/abc/secret", "{}");
        Assert.Equal(403, status);

        // A proxied client is never this machine, even when the header says 127.0.0.1...
        (status, _, _) = await HttpAsync(await ConnectAsync(httpsPort, V1(IPAddress.Loopback), tls: true), "POST", "/internal/livekit-webhook", "{}");
        Assert.Equal(404, status);
        // ...while the internal port on localhost is (LiveKit's webhooks get as far as the signature check).
        using (var http = new HttpClient())
        using (var direct = await http.PostAsync($"http://127.0.0.1:{port}/internal/livekit-webhook", new StringContent("{}", Encoding.UTF8, "application/json")))
            Assert.Equal(HttpStatusCode.Unauthorized, direct.StatusCode);

        // Per-address limits count the client, not the proxy: one address runs out, the next still has its allowance.
        const string claim = "/.well-known/iskra-claim?nonce=abcdefghijklmnop";
        for (var i = 0; i < Features.OwnerSetup.ClaimBurst; i++)
            Assert.Equal(404, (await HttpAsync(await ConnectAsync(httpsPort, V2(IPAddress.Parse("198.51.100.7"), 1000 + i), tls: true), "GET", claim)).Status);
        Assert.Equal(429, (await HttpAsync(await ConnectAsync(httpsPort, V2(IPAddress.Parse("198.51.100.7"), 999), tls: true), "GET", claim)).Status);
        Assert.Equal(404, (await HttpAsync(await ConnectAsync(httpsPort, V1(IPAddress.Parse("198.51.100.8")), tls: true), "GET", claim)).Status);

        // The security log records the address in the header.
        var ownerLink = File.ReadAllText(Path.Combine(world, "owner-invite.txt")).Trim();
        using var ownerIdentity = new TestIdentity();
        using var owner = await SocketAsync(httpsPort, V1(IPAddress.Parse("198.51.100.4")));
        Assert.Equal("welcome", (await owner.LoginAsync(ownerIdentity, "Owner", ownerLink[(ownerLink.LastIndexOf('.') + 1)..])).GetProperty("type").GetString());
        using var strangerIdentity = new TestIdentity();
        using var stranger = await SocketAsync(httpsPort, V2(IPAddress.Parse("203.0.113.9"), 4321));
        Assert.Equal("error", (await stranger.LoginAsync(strangerIdentity, "Stranger", "not-an-invite-code")).GetProperty("type").GetString());
        var log = (await owner.RequestAsync("security.log.list", new { })).GetProperty("body").GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal("203.0.113.9", log.Single(e => e.GetProperty("event").GetString() == "auth.failed").GetProperty("ip").GetString());
        Assert.Equal("198.51.100.4", log.Single(e => e.GetProperty("event").GetString() == "member.joined").GetProperty("ip").GetString());
    }

    [Fact]
    public async Task A_header_from_an_address_that_isnt_trusted_is_refused()
    {
        var (cert, key) = Certificate();
        int port = FreePort(), httpsPort = FreePort(), httpPort = FreePort();
        var world = World(new
        {
            Mode = "files", Domain = "localhost", CertFile = cert, KeyFile = key, Port = httpsPort, HttpPort = httpPort,
            ProxyProtocol = true, ProxyTrustedFrom = new[] { "192.0.2.1" }, // the proxy is elsewhere; we're not it
        }, new { Port = port });
        var process = StartServer(world);
        await WaitForServerAsync(process, port);

        Assert.Null(await ConnectAsync(httpsPort, V1(IPAddress.Parse("203.0.113.9")), tls: true));
        Assert.Null(await ConnectAsync(httpsPort, V2(IPAddress.Parse("203.0.113.9"), 4321), tls: true));
        Assert.Null(await ConnectAsync(httpsPort, null, tls: true));
        // HttpProxyProtocol is off: plain HTTP is as before.
        Assert.Equal(302, (await HttpAsync(await ConnectAsync(httpPort, null, tls: false), "GET", "/")).Status);
        Assert.Contains(_log, l => l.Contains("Dropped a connection on a PROXY protocol listener", StringComparison.Ordinal));
    }

    [Fact]
    public async Task With_the_option_off_nothing_changes()
    {
        var (cert, key) = Certificate();
        int port = FreePort(), httpsPort = FreePort(), httpPort = FreePort();
        var world = World(new { Mode = "files", Domain = "localhost", CertFile = cert, KeyFile = key, Port = httpsPort, HttpPort = httpPort }, new { Port = port });
        var process = StartServer(world);
        await WaitForServerAsync(process, port);

        // Plain TLS works, and a localhost client is still this machine.
        Assert.Equal(200, (await HttpAsync(await ConnectAsync(httpsPort, null, tls: true), "GET", "/")).Status);
        Assert.Equal(401, (await HttpAsync(await ConnectAsync(httpsPort, null, tls: true), "POST", "/internal/livekit-webhook", "{}")).Status);
        // A header isn't understood: it's just bytes before the TLS handshake, which then fails.
        Assert.Null(await ConnectAsync(httpsPort, V1(IPAddress.Parse("203.0.113.9")), tls: true));
        Assert.Equal(302, (await HttpAsync(await ConnectAsync(httpPort, null, tls: false), "GET", "/")).Status);
    }

    private static string? Pebble()
    {
        var name = OperatingSystem.IsWindows() ? "pebble.exe" : "pebble";
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, ".tools", name);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    /// <summary>
    /// ACME behind the proxy, as docs/hosting.md lays it out: both listeners on 127.0.0.1 only (Https.BindAddress, not
    /// LocalOnly), Let's Encrypt's HTTP-01 check through a plain HTTP forward (nginx http on port 80, no header), and
    /// the certificate served behind the PROXY header on the HTTPS port. Skipped unless .tools/pebble(.exe) exists.
    /// </summary>
    [Fact]
    public async Task Gets_a_certificate_behind_the_proxy()
    {
        var pebble = Pebble();
        Assert.SkipWhen(pebble is null, "Pebble isn't installed in .tools");
        Directory.CreateDirectory(_dir);
        int port = FreePort(), httpsPort = FreePort(), httpPort = FreePort();
        using (var rsa = RSA.Create(2048))
        {
            var request = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var san = new SubjectAlternativeNameBuilder();
            san.AddDnsName("localhost");
            san.AddIpAddress(IPAddress.Loopback);
            request.CertificateExtensions.Add(san.Build());
            using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
            File.WriteAllText(Path.Combine(_dir, "pebble-cert.pem"), cert.ExportCertificatePem());
            File.WriteAllText(Path.Combine(_dir, "pebble-key.pem"), rsa.ExportPkcs8PrivateKeyPem());
        }
        int acmePort = FreePort(), managementPort = FreePort(), tlsAlpn = FreePort();
        File.WriteAllText(Path.Combine(_dir, "pebble.json"), JsonSerializer.Serialize(new
        {
            pebble = new
            {
                listenAddress = $"127.0.0.1:{acmePort}",
                managementListenAddress = $"127.0.0.1:{managementPort}",
                certificate = Path.Combine(_dir, "pebble-cert.pem"),
                privateKey = Path.Combine(_dir, "pebble-key.pem"),
                httpPort, // "port 80": the plain forward lands on the server's HttpPort
                tlsPort = tlsAlpn,
                ocspResponderURL = "",
                externalAccountBindingRequired = false,
            },
        }));
        Start(pebble!, $"-config \"{Path.Combine(_dir, "pebble.json")}\"", new() { ["PEBBLE_VA_NOSLEEP"] = "1", ["PEBBLE_WFE_NONCEREJECT"] = "0" });

        var world = World(new
        {
            Mode = "acme", Domain = "localhost", Port = httpsPort, HttpPort = httpPort, AcmeDirectory = $"https://127.0.0.1:{acmePort}/dir",
            BindAddress = "127.0.0.1", ProxyProtocol = true,
        }, new { Port = port, LocalOnly = false });
        var process = StartServer(world, "--Https:AcceptAnyAcmeCertificate=true");
        await WaitForServerAsync(process, port);

        X509Certificate2? served = null;
        var until = DateTime.UtcNow.AddSeconds(30);
        while (served is null && DateTime.UtcNow < until)
        {
            if (await ConnectAsync(httpsPort, V1(IPAddress.Parse("203.0.113.9")), tls: true) is SslStream ssl)
            {
                using (ssl)
                {
                    var cert = new X509Certificate2(ssl.RemoteCertificate!);
                    if (cert.Issuer.Contains("Pebble", StringComparison.OrdinalIgnoreCase)) served = cert;
                }
            }
            if (served is null) await Task.Delay(200);
        }
        Assert.True(served is not null, $"No Pebble certificate was served:\n{string.Join("\n", _log.TakeLast(40))}");
        Assert.True(File.Exists(Path.Combine(world, "certs", "fullchain.pem")));
        // Bound to 127.0.0.1 only: nothing answers on this machine's other addresses.
        Assert.DoesNotContain(System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners(),
            l => (l.Port == httpsPort || l.Port == httpPort) && !IPAddress.IsLoopback(l.Address));
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
