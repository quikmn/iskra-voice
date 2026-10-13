using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Sigstore;

namespace Iskra.Server.Updates;

/// <summary>What checking a package's build-provenance attestations found.</summary>
public enum AttestationResult
{
    /// <summary>A Sigstore bundle signed by one of this repository's release workflows names this exact file.</summary>
    Verified,
    /// <summary>GitHub has none for this file (releases made before attestations, or never attested).</summary>
    Missing,
    /// <summary>There are some, but none verifies for this file.</summary>
    Invalid,
    /// <summary>GitHub couldn't be asked (network, rate limit).</summary>
    Unknown,
}

/// <summary>
/// Verifies GitHub build-provenance attestations (Sigstore bundles) for a release package, offline: the Sigstore
/// public-good trusted root is compiled in (sigstore-trusted-root.json, refreshed with each release), so nothing but
/// GitHub is asked. The bundle must verify (certificate chain to Fulcio, SCT, transparency log entry, DSSE signature;
/// the Sigstore library does that), its certificate must be GitHub Actions' for this repository (by id), on a
/// GitHub-hosted runner, running release.yml for this version's tag or release-finalize.yml on main, and its SLSA
/// provenance statement must name the package with its SHA-256.
/// </summary>
public static class Attestations
{
    public const string Issuer = "https://token.actions.githubusercontent.com";
    /// <summary>GitHub's id for quikmn/iskra-voice: a deleted and re-created repository with the same name doesn't count.</summary>
    public const string RepositoryId = "1227290412";
    private const string StatementType = "https://in-toto.io/Statement/v1";
    private const string ProvenanceType = "https://slsa.dev/provenance/v1";
    private const string PayloadType = "application/vnd.in-toto+json";

    /// <summary>Largest bundle list we read from GitHub (one release's is about 30 KB).</summary>
    public const long MaxResponseBytes = 4 * 1024 * 1024;

    public static TrustedRoot PinnedRoot { get; } = LoadRoot();

    private static TrustedRoot LoadRoot()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("sigstore-trusted-root.json")
            ?? throw new InvalidOperationException("sigstore-trusted-root.json isn't compiled in");
        using var reader = new StreamReader(stream);
        return TrustedRoot.Deserialize(reader.ReadToEnd());
    }

    /// <summary>The workflows that may sign a release's packages (certificate SAN), for <paramref name="version"/>.</summary>
    public static string[] Signers(string version) =>
    [
        $"https://github.com/{GitHubReleaseFeed.Repo}/.github/workflows/release.yml@refs/tags/v{version}",
        $"https://github.com/{GitHubReleaseFeed.Repo}/.github/workflows/release-finalize.yml@refs/heads/main",
    ];

    /// <summary>
    /// Whether any of <paramref name="bundles"/> (Sigstore bundle JSON) proves <paramref name="name"/> with
    /// <paramref name="sha256"/> (lowercase hex) was built by Iskra's release workflow for <paramref name="version"/>.
    /// Null bundles: GitHub couldn't be asked.
    /// </summary>
    public static async Task<AttestationResult> VerifyAsync(IReadOnlyList<string>? bundles, string name, string sha256, string version,
        TrustedRoot root, CancellationToken cancel)
    {
        if (bundles is null) return AttestationResult.Unknown;
        if (bundles.Count == 0) return AttestationResult.Missing;
        var digest = Convert.FromHexString(sha256);
        var verifier = new SigstoreVerifier(new InMemoryTrustRootProvider(root));
        var policy = new VerificationPolicy
        {
            CertificateIdentity = new CertificateIdentity
            {
                SubjectAlternativeNamePattern = "^(" + string.Join("|", Signers(version).Select(Regex.Escape)) + ")$",
                Issuer = Issuer,
                Extensions = new CertificateExtensionPolicy { SourceRepositoryIdentifier = RepositoryId, RunnerEnvironment = "github-hosted" },
            },
        };
        foreach (var json in bundles)
        {
            cancel.ThrowIfCancellationRequested();
            try
            {
                var bundle = SigstoreBundle.Deserialize(json);
                if (bundle.DsseEnvelope is not { } envelope || envelope.PayloadType != PayloadType) continue;
                var (ok, _) = await verifier.TryVerifyDigestAsync(digest, HashAlgorithmType.Sha256, bundle, policy, cancel);
                // The signature covers the payload, so what it says can be trusted now.
                if (ok && Names(envelope.Payload.Span, name, sha256)) return AttestationResult.Verified;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Anything malformed simply doesn't verify.
            }
        }
        return AttestationResult.Invalid;
    }

    /// <summary>The statement is SLSA provenance and lists exactly this file with this SHA-256.</summary>
    private static bool Names(ReadOnlySpan<byte> payload, string name, string sha256)
    {
        var reader = new Utf8JsonReader(payload);
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        if (Str(root, "_type") != StatementType || Str(root, "predicateType") != ProvenanceType) return false;
        if (!root.TryGetProperty("subject", out var subjects) || subjects.ValueKind != JsonValueKind.Array) return false;
        foreach (var s in subjects.EnumerateArray())
        {
            if (s.ValueKind != JsonValueKind.Object || Str(s, "name") != name) continue;
            if (s.TryGetProperty("digest", out var d) && d.ValueKind == JsonValueKind.Object
                && string.Equals(Str(d, "sha256"), sha256, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>The bundles in GitHub's answer to GET /repos/{repo}/attestations/sha256:{digest}.</summary>
    public static IReadOnlyList<string> ParseList(JsonDocument doc)
    {
        if (!doc.RootElement.TryGetProperty("attestations", out var list) || list.ValueKind != JsonValueKind.Array) return [];
        var bundles = new List<string>();
        foreach (var a in list.EnumerateArray())
        {
            if (a.ValueKind == JsonValueKind.Object && a.TryGetProperty("bundle", out var b) && b.ValueKind == JsonValueKind.Object)
                bundles.Add(b.GetRawText());
            if (bundles.Count == 20) break;
        }
        return bundles;
    }
}
