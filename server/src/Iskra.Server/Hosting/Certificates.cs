using System.Collections.Concurrent;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Certes;
using Certes.Acme;
using Certes.Acme.Resource;
using Iskra.Server.Storage;

namespace Iskra.Server.Hosting;

/// <summary>
/// The server's TLS certificate. In "acme" mode it gets one from Let's Encrypt (HTTP-01 challenge on the
/// plain HTTP port), keeps it in the world folder (certs/), and renews it 30 days before it expires.
/// Kestrel asks <see cref="Current"/> on every handshake, so renewals apply without a restart.
/// </summary>
public sealed class Certificates(World world, IConfiguration config, ILogger<Certificates> log, TimeProvider time) : BackgroundService
{
    private static readonly TimeSpan RenewBefore = TimeSpan.FromDays(30);
    private readonly ConcurrentDictionary<string, string> _challenges = new();
    private volatile SslStreamCertificateContext? _context;

    private HttpsSettings Settings => world.Settings.Https;
    private string CertDir => Path.Combine(world.Path, "certs");
    private string ChainPath => Path.Combine(CertDir, "fullchain.pem");
    private string KeyPath => Path.Combine(CertDir, "key.pem");

    private readonly Lazy<SslStreamCertificateContext> _placeholder = new(() =>
    {
        // Until the real certificate arrives: a short-lived self-signed one, so handshakes fail politely.
        using var key = System.Security.Cryptography.ECDsa.Create();
        var request = new CertificateRequest($"CN={world.Settings.Https.Domain ?? "iskra"}", key, System.Security.Cryptography.HashAlgorithmName.SHA256);
        using var self = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(7));
        return SslStreamCertificateContext.Create(X509CertificateLoader.LoadPkcs12(self.Export(X509ContentType.Pkcs12), null), null);
    });

    /// <summary>The certificate plus its intermediates, as served on each TLS handshake.</summary>
    public SslStreamCertificateContext Context => _context ?? _placeholder.Value;

    public X509Certificate2? Current => _context?.TargetCertificate;

    /// <summary>Loads a PEM chain (leaf first, then intermediates) and its key into a servable context.</summary>
    private static SslStreamCertificateContext Load(string chainFile, string keyFile)
    {
        using var pem = X509Certificate2.CreateFromPemFile(chainFile, keyFile);
        // Windows' TLS stack wants a persisted key; a PKCS#12 round trip gives it one.
        var leaf = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null);
        var all = new X509Certificate2Collection();
        all.ImportFromPemFile(chainFile);
        var intermediates = new X509Certificate2Collection(all.Skip(1).ToArray());
        return SslStreamCertificateContext.Create(leaf, intermediates, offline: true);
    }

    /// <summary>The key authorization for an HTTP-01 challenge token, if we're waiting on one.</summary>
    public string? Challenge(string token) => _challenges.TryGetValue(token, out var value) ? value : null;

    /// <summary>Loads whatever certificate is available right away (before Kestrel starts).</summary>
    public void LoadExisting()
    {
        if (Settings.Mode == "files")
        {
            if (string.IsNullOrEmpty(Settings.CertFile) || string.IsNullOrEmpty(Settings.KeyFile))
                throw new InvalidDataException("Https.Mode \"files\" needs Https.CertFile and Https.KeyFile (PEM).");
            _context = Load(Settings.CertFile, Settings.KeyFile);
        }
        else if (Settings.Mode == "acme" && File.Exists(ChainPath) && File.Exists(KeyPath))
        {
            _context = Load(ChainPath, KeyPath);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (Settings.Mode != "acme") return;
        if (string.IsNullOrWhiteSpace(Settings.Domain)) throw new InvalidDataException("Https.Mode \"acme\" needs Https.Domain.");

        while (!stopping.IsCancellationRequested)
        {
            var current = Current;
            if (current is null || current.NotAfter.ToUniversalTime() - time.GetUtcNow().UtcDateTime < RenewBefore)
            {
                try
                {
                    await IssueAsync(stopping);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Getting a certificate for {Domain} failed. Is port {Port} reachable from the internet and does the domain point here?",
                        Settings.Domain, Settings.HttpPort);
                    await Task.Delay(TimeSpan.FromMinutes(5), time, stopping);
                    continue;
                }
            }
            await Task.Delay(TimeSpan.FromHours(12), time, stopping);
        }
    }

    private async Task IssueAsync(CancellationToken stopping)
    {
        System.IO.Directory.CreateDirectory(CertDir);
        var directory = new Uri(Settings.AcmeDirectory);
        var http = new HttpClient(new HttpClientHandler
        {
            // Only for tests against a local ACME test server (Pebble).
            ServerCertificateCustomValidationCallback = config.GetValue<bool>("Https:AcceptAnyAcmeCertificate")
                ? HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
                : null,
        });

        var accountPath = Path.Combine(CertDir, "acme-account.pem");
        var accountKey = File.Exists(accountPath) ? KeyFactory.FromPem(await File.ReadAllTextAsync(accountPath, stopping)) : null;
        var acme = new AcmeContext(directory, accountKey, new AcmeHttpClient(directory, http));
        if (accountKey is null)
        {
            await acme.NewAccount(Settings.Email is { Length: > 0 } email ? [$"mailto:{email}"] : [], termsOfServiceAgreed: true);
            AtomicFile.WriteAllText(accountPath, acme.AccountKey.ToPem());
        }

        log.LogInformation("Requesting a certificate for {Domain}", Settings.Domain);
        var order = await acme.NewOrder([Settings.Domain!]);
        foreach (var authorization in await order.Authorizations())
        {
            var challenge = await authorization.Http();
            _challenges[challenge.Token] = challenge.KeyAuthz;
            try
            {
                await challenge.Validate();
                for (var i = 0; i < 60; i++)
                {
                    var status = (await authorization.Resource()).Status;
                    if (status == AuthorizationStatus.Valid) break;
                    if (status == AuthorizationStatus.Invalid) throw new InvalidOperationException("The domain couldn't be verified.");
                    await Task.Delay(TimeSpan.FromSeconds(1), time, stopping);
                }
            }
            finally
            {
                _challenges.TryRemove(challenge.Token, out _);
            }
        }

        var key = KeyFactory.NewKey(KeyAlgorithm.ES256);
        var chain = await order.Generate(new CsrInfo { CommonName = Settings.Domain }, key);
        // Same layout as certbot: easy to inspect, back up, or reuse elsewhere.
        AtomicFile.WriteAllText(KeyPath, key.ToPem());
        // Leaf then the intermediates the CA sent (chain.ToPem() insists on knowing the root, which test CAs aren't).
        var pems = new[] { chain.Certificate }.Concat(chain.Issuers)
            .Select(c => new string(System.Security.Cryptography.PemEncoding.Write("CERTIFICATE", c.ToDer())));
        AtomicFile.WriteAllText(ChainPath, string.Join('\n', pems) + '\n');
        _context = Load(ChainPath, KeyPath);
        log.LogInformation("Certificate for {Domain} is valid until {Expiry:u}", Settings.Domain, Current!.NotAfter);
    }
}
