using System.Collections.Concurrent;
using Iskra.Server.Updates;

namespace Iskra.Server.Tests.Support;

/// <summary>
/// Stands in for GitHub's releases: a list, file contents by name, and attestations by SHA-256. A package in
/// <see cref="Attested"/> gets a stand-in bundle that <see cref="Verify"/> accepts (real Sigstore checks are in
/// AttestationTests); <see cref="Bundles"/> hands out real bundles, checked for real.
/// </summary>
public sealed class FakeReleaseFeed : IReleaseFeed
{
    public List<Release> Releases { get; } = [];
    public ConcurrentDictionary<string, byte[]> Files { get; } = new();
    public HashSet<string> Attested { get; } = [];
    public ConcurrentDictionary<string, IReadOnlyList<string>> Bundles { get; } = new();
    /// <summary>Attestations can't be asked for (GitHub down).</summary>
    public bool AttestationsUnreachable { get; set; }
    private const string Marker = "test-attested:";
    public int Lists;
    /// <summary>Make the next list fail like GitHub's rate limit.</summary>
    public DateTimeOffset? RateLimitedUntil { get; set; }

    public Task<IReadOnlyList<Release>> ListAsync(CancellationToken cancel)
    {
        Interlocked.Increment(ref Lists);
        if (RateLimitedUntil is { } until) throw new FeedRateLimitedException(until);
        return Task.FromResult<IReadOnlyList<Release>>([.. Releases]);
    }

    public async Task DownloadAsync(ReleaseAsset asset, string path, long maxBytes, Action<long>? progress, CancellationToken cancel)
    {
        if (!Files.TryGetValue(asset.Name, out var bytes)) throw new HttpRequestException("404");
        if (bytes.Length > maxBytes) throw new InvalidDataException("too large");
        await File.WriteAllBytesAsync(path, bytes, cancel);
        progress?.Invoke(bytes.Length);
    }

    public Task<IReadOnlyList<string>?> AttestationsAsync(string sha256, CancellationToken cancel) =>
        Task.FromResult<IReadOnlyList<string>?>(AttestationsUnreachable ? null
            : Bundles.TryGetValue(sha256, out var real) ? real
            : Attested.Contains(sha256) ? [Marker + sha256] : []);

    /// <summary>For UpdateService.VerifyAttestations: the stand-in counts as verified, everything else is checked for real.</summary>
    public static Task<AttestationResult> Verify(IReadOnlyList<string>? bundles, string name, string sha256, string version, CancellationToken cancel) =>
        bundles is not null && bundles.Contains(Marker + sha256)
            ? Task.FromResult(AttestationResult.Verified)
            : Attestations.VerifyAsync(bundles, name, sha256, version, Attestations.PinnedRoot, cancel);

    /// <summary>A release with a server package for <paramref name="rid"/> (contents <paramref name="package"/>), a SHA256SUMS.txt and (unless not <paramref name="attested"/>) an attestation for it.</summary>
    public Release Publish(string version, byte[] package, string rid = "linux-x64", bool prerelease = false, string? sums = null, string? digest = null,
        bool attested = true)
    {
        var name = UpdatePicker.PackageName(version, rid);
        var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(package));
        Files[name] = package;
        if (attested) Attested.Add(sha);
        Files[UpdatePicker.SumsFile] = System.Text.Encoding.UTF8.GetBytes(sums ?? $"{sha}  {name}\n");
        var release = new Release(version, prerelease, $"https://github.com/quikmn/iskra-voice/releases/tag/v{version}", 0,
        [
            new ReleaseAsset(name, $"https://github.com/quikmn/iskra-voice/releases/download/v{version}/{name}", package.Length, digest ?? sha),
            new ReleaseAsset(UpdatePicker.SumsFile, $"https://github.com/quikmn/iskra-voice/releases/download/v{version}/{UpdatePicker.SumsFile}", 0, null),
        ]);
        Releases.Insert(0, release);
        return release;
    }
}
