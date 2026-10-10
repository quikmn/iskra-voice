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
/// With HTTPS off, internet hosting asks for one through <see cref="Want"/> (the automatic address).
/// Kestrel asks <see cref="Context"/> on every handshake, so renewals apply without a restart.
/// </summary>
public sealed class Certificates(World world, IConfiguration config, ILogger<Certificates> log, TimeProvider time) : BackgroundService
{
    private static readonly TimeSpan RenewBefore = TimeSpan.FromDays(30);
    private readonly ConcurrentDictionary<string, string> _challenges = new();
    private volatile SslStreamCertificateContext? _context;
    private volatile string? _wanted;
    private TaskCompletionSource _wake = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private volatile CertificateStatus _status = new("off", null, null, null, null);
    private long? _verifiedAt;

    /// <summary>Raised whenever <see cref="Status"/> changes.</summary>
    public event Action? Changed;

    public CertificateStatus Status => _status;

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
        else if (Settings.Mode is "acme" or "off" && File.Exists(ChainPath) && File.Exists(KeyPath))
        {
            try
            {
                _context = Load(ChainPath, KeyPath);
            }
            catch (Exception ex) when (Settings.Mode == "off" && ex is IOException or System.Security.Cryptography.CryptographicException)
            {
                log.LogWarning(ex, "Ignoring the unreadable certificate in {Dir}", CertDir);
            }
        }
    }

    /// <summary>
    /// Automatic HTTPS for internet hosting (only while Https.Mode is "off"): get and keep a certificate
    /// for <paramref name="domain"/>, or stop asking when it's null.
    /// </summary>
    public void Want(string? domain)
    {
        if (_wanted == domain) return;
        _wanted = domain;
        Wake();
    }

    /// <summary>Try again now instead of waiting out the back-off (the owner fixed something).</summary>
    public void RetryNow() => Wake();

    private void Wake() => Interlocked.Exchange(ref _wake, new(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();

    private async Task SleepAsync(Task wake, TimeSpan delay, CancellationToken stopping)
    {
        await Task.WhenAny(wake, Task.Delay(delay, time, stopping));
        stopping.ThrowIfCancellationRequested();
    }

    private string? TargetDomain => Settings.Mode switch
    {
        "acme" => Settings.Domain,
        "off" => _wanted,
        _ => null,
    };

    /// <summary>A certificate fits when it names the domain and won't expire within <paramref name="margin"/>.</summary>
    private bool Fits(X509Certificate2? cert, string domain, TimeSpan margin) =>
        cert is not null && cert.MatchesHostname(domain) && cert.NotAfter.ToUniversalTime() - time.GetUtcNow().UtcDateTime > margin;

    private void SetStatus(string state, string? domain, string? error = null)
    {
        var cert = Current;
        var expires = cert is not null && domain is not null && cert.MatchesHostname(domain)
            ? new DateTimeOffset(cert.NotAfter.ToUniversalTime()).ToUnixTimeMilliseconds()
            : (long?)null;
        var next = new CertificateStatus(state, domain, expires, error, _verifiedAt);
        if (next == _status) return;
        _status = next;
        Changed?.Invoke();
    }

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (Settings.Mode == "files")
        {
            SetStatus("valid", Current?.GetNameInfo(X509NameType.DnsName, false));
            return;
        }
        if (Settings.Mode == "acme" && string.IsNullOrWhiteSpace(Settings.Domain)) throw new InvalidDataException("Https.Mode \"acme\" needs Https.Domain.");

        var failures = 0;
        string? lastDomain = null;
        while (!stopping.IsCancellationRequested)
        {
            var wake = _wake.Task;
            var domain = TargetDomain;
            if (domain != lastDomain) failures = 0;
            lastDomain = domain;
            if (domain is null)
            {
                SetStatus("off", null);
                await SleepAsync(wake, Timeout.InfiniteTimeSpan, stopping);
                continue;
            }
            if (Fits(Current, domain, RenewBefore))
            {
                SetStatus("valid", domain);
                await SleepAsync(wake, TimeSpan.FromHours(12), stopping);
                continue;
            }
            try
            {
                if (!Fits(Current, domain, TimeSpan.Zero)) SetStatus("requesting", domain);
                await IssueAsync(domain, stopping);
                failures = 0;
                _verifiedAt = time.GetUtcNow().ToUnixTimeMilliseconds();
                SetStatus("valid", domain);
            }
            catch (Exception ex) when (!stopping.IsCancellationRequested)
            {
                failures++;
                log.LogError(ex, "Getting a certificate for {Domain} failed. Is port 80 reachable from the internet and does the domain point here?", domain);
                SetStatus(Fits(Current, domain, TimeSpan.Zero) ? "valid" : "failed", domain, Friendly(ex));
                // Let's Encrypt allows 5 failed validations per name per hour: back off 5, 10, 20, 40, then 60 minutes.
                await SleepAsync(wake, TimeSpan.FromMinutes(Math.Min(60, 5 * Math.Pow(2, failures - 1))), stopping);
            }
        }
    }

    private static string Friendly(Exception ex)
    {
        var text = ex switch
        {
            AcmeRequestException acme when acme.Error?.Detail is { Length: > 0 } detail => detail,
            HttpRequestException => "Couldn't reach Let's Encrypt. Is this computer online?",
            _ => ex.Message,
        };
        return text.Length > 300 ? text[..300] : text;
    }

    private async Task IssueAsync(string domain, CancellationToken stopping)
    {
        AtomicFile.CreatePrivateDirectory(CertDir);
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

        log.LogInformation("Requesting a certificate for {Domain}", domain);
        var order = await acme.NewOrder([domain]);
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
                    if (status == AuthorizationStatus.Invalid)
                    {
                        var detail = (await challenge.Resource()).Error?.Detail;
                        throw new InvalidOperationException($"Let's Encrypt couldn't verify {domain}{(detail is null ? "." : $": {detail}")}");
                    }
                    await Task.Delay(TimeSpan.FromSeconds(1), time, stopping);
                }
            }
            finally
            {
                _challenges.TryRemove(challenge.Token, out _);
            }
        }

        var key = KeyFactory.NewKey(KeyAlgorithm.ES256);
        var chain = await order.Generate(new CsrInfo { CommonName = domain }, key);
        // Same layout as certbot: easy to inspect, back up, or reuse elsewhere.
        AtomicFile.WriteAllText(KeyPath, key.ToPem());
        // Leaf then the intermediates the CA sent (chain.ToPem() insists on knowing the root, which test CAs aren't).
        var pems = new[] { chain.Certificate }.Concat(chain.Issuers)
            .Select(c => new string(System.Security.Cryptography.PemEncoding.Write("CERTIFICATE", c.ToDer())));
        AtomicFile.WriteAllText(ChainPath, string.Join('\n', pems) + '\n');
        _context = Load(ChainPath, KeyPath);
        log.LogInformation("Certificate for {Domain} is valid until {Expiry:u}", domain, Current!.NotAfter);
    }
}

/// <summary>Certificate state shown to the owner: off, requesting, valid or failed (with a readable error).</summary>
public sealed record CertificateStatus(string State, string? Domain, long? ExpiresAt, string? Error, long? VerifiedAt);
