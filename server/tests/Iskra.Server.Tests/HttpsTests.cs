using System.Diagnostics;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>
/// Automatic HTTPS against Pebble, Let's Encrypt's ACME test server: a real HTTP-01 challenge, a real
/// certificate, served by the real server process. Skipped unless .tools/pebble(.exe) exists.
/// </summary>
public class HttpsTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "iskra-https-" + Guid.NewGuid().ToString("N"));
    private readonly List<Process> _processes = [];
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _log = new();

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

    [Fact]
    public async Task Gets_a_certificate_and_serves_https_with_a_redirect()
    {
        var pebble = Pebble();
        Assert.SkipWhen(pebble is null, "Pebble isn't installed in .tools");
        Directory.CreateDirectory(_dir);

        // Pebble's own listener needs a TLS certificate.
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

        int acmePort = FreePort(), managementPort = FreePort(), httpPort = FreePort(), httpsPort = FreePort(), port = FreePort(), tlsAlpn = FreePort();
        File.WriteAllText(Path.Combine(_dir, "pebble.json"), JsonSerializer.Serialize(new
        {
            pebble = new
            {
                listenAddress = $"127.0.0.1:{acmePort}",
                managementListenAddress = $"127.0.0.1:{managementPort}",
                certificate = Path.Combine(_dir, "pebble-cert.pem"),
                privateKey = Path.Combine(_dir, "pebble-key.pem"),
                httpPort,
                tlsPort = tlsAlpn,
                ocspResponderURL = "",
                externalAccountBindingRequired = false,
            },
        }));
        Start(pebble!, $"-config \"{Path.Combine(_dir, "pebble.json")}\"",
            new() { ["PEBBLE_VA_NOSLEEP"] = "1", ["PEBBLE_WFE_NONCEREJECT"] = "0" });

        var world = Path.Combine(_dir, "world");
        Directory.CreateDirectory(world);
        File.WriteAllText(Path.Combine(world, "server.json"), JsonSerializer.Serialize(new
        {
            Name = "Secure",
            Port = port,
            Voice = new { Enabled = false },
            Https = new { Mode = "acme", Domain = "localhost", HttpPort = httpPort, Port = httpsPort, AcmeDirectory = $"https://127.0.0.1:{acmePort}/dir" },
        }));
        var dll = Path.Combine(AppContext.BaseDirectory, "iskra-server.dll");
        Start("dotnet", $"\"{dll}\" \"{world}\" --Https:AcceptAnyAcmeCertificate=true");

        // Wait for the certificate Pebble issued (not just any certificate).
        X509Certificate2? served = null;
        for (var i = 0; i < 300 && served is null; i++)
        {
            try
            {
                using var tcp = new TcpClient();
                await tcp.ConnectAsync(IPAddress.Loopback, httpsPort);
                using var ssl = new SslStream(tcp.GetStream(), false, (_, _, _, _) => true);
                await ssl.AuthenticateAsClientAsync("localhost");
                var cert = new X509Certificate2(ssl.RemoteCertificate!);
                if (cert.Issuer.Contains("Pebble", StringComparison.OrdinalIgnoreCase)) served = cert;
            }
            catch (Exception e) when (e is SocketException or IOException or System.Security.Authentication.AuthenticationException) { }
            if (served is null) await Task.Delay(100);
        }
        if (served is null) File.WriteAllLines(Path.Combine(Path.GetTempPath(), "iskra-https-last.log"), _log);
        Assert.True(served is not null, "No Pebble certificate was served; see iskra-https-last.log in the temp folder.");
        Assert.Contains("localhost", served!.GetNameInfo(X509NameType.DnsName, false));
        Assert.True(File.Exists(Path.Combine(world, "certs", "fullchain.pem")));
        Assert.True(File.Exists(Path.Combine(world, "certs", "key.pem")));

        // HTTPS works end to end, with HSTS.
        using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, _, _, _) => true, AllowAutoRedirect = false };
        using var client = new HttpClient(handler);
        using var info = await client.GetAsync($"https://localhost:{httpsPort}/");
        Assert.Equal(HttpStatusCode.OK, info.StatusCode);
        Assert.True(info.Headers.Contains("Strict-Transport-Security"));

        // Plain HTTP redirects to HTTPS.
        using var redirect = await client.GetAsync($"http://localhost:{httpPort}/some/page?x=1");
        Assert.Equal(HttpStatusCode.Redirect, redirect.StatusCode);
        Assert.Equal($"https://localhost:{httpsPort}/some/page?x=1", redirect.Headers.Location!.ToString());
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
