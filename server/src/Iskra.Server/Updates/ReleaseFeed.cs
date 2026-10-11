using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Iskra.Server.Updates;

public sealed record ReleaseAsset(string Name, string Url, long Size, string? Sha256);

/// <summary>A published release. <see cref="Prerelease"/> is GitHub's flag (alphas are published as normal releases).</summary>
public sealed record Release(string Version, bool Prerelease, string PageUrl, long PublishedAt, IReadOnlyList<ReleaseAsset> Assets)
{
    public ReleaseAsset? Asset(string name) => Assets.FirstOrDefault(a => a.Name == name);
}

/// <summary>The feed said to wait (GitHub's rate limit); try again after <see cref="RetryAt"/>.</summary>
public sealed class FeedRateLimitedException(DateTimeOffset retryAt) : Exception("GitHub asked us to wait before checking again.")
{
    public DateTimeOffset RetryAt { get; } = retryAt;
}

/// <summary>Where releases come from: GitHub, or a stand-in in tests.</summary>
public interface IReleaseFeed
{
    /// <summary>Published releases, newest first (drafts never show up).</summary>
    Task<IReadOnlyList<Release>> ListAsync(CancellationToken cancel);

    /// <summary>Downloads a release file to <paramref name="path"/>, refusing anything larger than <paramref name="maxBytes"/>.</summary>
    Task DownloadAsync(ReleaseAsset asset, string path, long maxBytes, Action<long>? progress, CancellationToken cancel);

    /// <summary>Whether GitHub has a build-provenance attestation for this SHA-256 in the repo; null if it couldn't be asked.</summary>
    Task<bool?> HasAttestationAsync(string sha256, CancellationToken cancel);
}

/// <summary>
/// GitHub's releases API, unauthenticated (60 requests an hour per IP). The list is asked with If-None-Match, so an
/// unchanged list costs nothing against the limit; a rate-limit answer turns into <see cref="FeedRateLimitedException"/>.
/// </summary>
public sealed class GitHubReleaseFeed : IReleaseFeed, IDisposable
{
    public const string Repo = "quikmn/iskra-voice";
    private const string DownloadPrefix = $"https://github.com/{Repo}/releases/download/";

    private readonly HttpClient _http;
    private readonly TimeProvider _time;
    private string? _etag;
    private IReadOnlyList<Release> _cached = [];

    public GitHubReleaseFeed(TimeProvider time)
    {
        _time = time;
        // Redirects only to HTTPS (HttpClient never follows HTTPS → HTTP); release files redirect to GitHub's storage.
        _http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = true, MaxAutomaticRedirections = 5, AutomaticDecompression = DecompressionMethods.All })
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("iskra-server", Versions.Current));
    }

    public async Task<IReadOnlyList<Release>> ListAsync(CancellationToken cancel)
    {
        using var request = Api($"https://api.github.com/repos/{Repo}/releases?per_page=30");
        if (_etag is not null) request.Headers.TryAddWithoutValidation("If-None-Match", _etag);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.StatusCode == HttpStatusCode.NotModified) return _cached;
        ThrowIfLimited(response);
        response.EnsureSuccessStatusCode();
        await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
        var releases = Parse(await JsonDocument.ParseAsync(body, cancellationToken: timeout.Token));
        _cached = releases;
        _etag = response.Headers.ETag?.ToString();
        return releases;
    }

    public async Task DownloadAsync(ReleaseAsset asset, string path, long maxBytes, Action<long>? progress, CancellationToken cancel)
    {
        // Only files of this repo's releases, whatever the feed said.
        if (!asset.Url.StartsWith(DownloadPrefix, StringComparison.Ordinal)) throw new InvalidDataException($"Unexpected download address for {asset.Name}.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromMinutes(30));
        using var response = await _http.GetAsync(asset.Url, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.RequestMessage?.RequestUri?.Scheme != Uri.UriSchemeHttps) throw new InvalidDataException("The download left HTTPS.");
        ThrowIfLimited(response);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > maxBytes) throw new InvalidDataException($"{asset.Name} is larger than expected.");
        await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
        await using var output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await input.ReadAsync(buffer, timeout.Token)) > 0)
        {
            total += read;
            if (total > maxBytes) throw new InvalidDataException($"{asset.Name} is larger than expected.");
            await output.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
            progress?.Invoke(total);
        }
    }

    public async Task<bool?> HasAttestationAsync(string sha256, CancellationToken cancel)
    {
        try
        {
            using var request = Api($"https://api.github.com/repos/{Repo}/attestations/sha256:{sha256}");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            using var response = await _http.SendAsync(request, timeout.Token);
            if (response.StatusCode == HttpStatusCode.NotFound) return false;
            if (!response.IsSuccessStatusCode) return null;
            using var doc = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(timeout.Token), cancellationToken: timeout.Token);
            return doc.RootElement.TryGetProperty("attestations", out var list) && list.ValueKind == JsonValueKind.Array && list.GetArrayLength() > 0;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            if (cancel.IsCancellationRequested) throw;
            return null;
        }
    }

    private static HttpRequestMessage Api(string url)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        return request;
    }

    private void ThrowIfLimited(HttpResponseMessage response)
    {
        if (response.StatusCode is not (HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)) return;
        var now = _time.GetUtcNow();
        if (response.Headers.RetryAfter?.Delta is { } delta) throw new FeedRateLimitedException(now + delta);
        if (response.Headers.TryGetValues("X-RateLimit-Remaining", out var remaining) && remaining.FirstOrDefault() == "0"
            && response.Headers.TryGetValues("X-RateLimit-Reset", out var reset) && long.TryParse(reset.FirstOrDefault(), out var seconds))
            throw new FeedRateLimitedException(DateTimeOffset.FromUnixTimeSeconds(seconds));
        if (response.StatusCode == HttpStatusCode.TooManyRequests) throw new FeedRateLimitedException(now.AddMinutes(15));
    }

    /// <summary>Reads GitHub's release list; anything that doesn't look like one of our releases is skipped.</summary>
    public static IReadOnlyList<Release> Parse(JsonDocument doc)
    {
        if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new JsonException("Expected a list of releases.");
        var releases = new List<Release>();
        foreach (var r in doc.RootElement.EnumerateArray())
        {
            if (r.ValueKind != JsonValueKind.Object) continue;
            if (r.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True) continue;
            var version = Versions.FromTag(Str(r, "tag_name"));
            if (version is null) continue;
            var assets = new List<ReleaseAsset>();
            if (r.TryGetProperty("assets", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in list.EnumerateArray())
                {
                    if (Str(a, "name") is not { } name || Str(a, "browser_download_url") is not { } url) continue;
                    var size = a.TryGetProperty("size", out var s) && s.TryGetInt64(out var n) ? n : 0;
                    var digest = Str(a, "digest") is { } d && d.StartsWith("sha256:", StringComparison.Ordinal) ? d[7..].ToLowerInvariant() : null;
                    assets.Add(new ReleaseAsset(name, url, size, digest));
                }
            }
            var published = DateTimeOffset.TryParse(Str(r, "published_at"), out var at) ? at.ToUnixTimeMilliseconds() : 0;
            releases.Add(new Release(version, r.TryGetProperty("prerelease", out var pre) && pre.ValueKind == JsonValueKind.True,
                $"https://github.com/{Repo}/releases/tag/v{version}", published, assets));
        }
        return releases;
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public void Dispose() => _http.Dispose();
}

/// <summary>Releases from a local file in GitHub's format (Updates:FeedFile; for tests and trying things out). Lists only.</summary>
public sealed class FileReleaseFeed(string path) : IReleaseFeed
{
    public Task<IReadOnlyList<Release>> ListAsync(CancellationToken cancel)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return Task.FromResult(GitHubReleaseFeed.Parse(doc));
    }

    public Task DownloadAsync(ReleaseAsset asset, string path, long maxBytes, Action<long>? progress, CancellationToken cancel) =>
        throw new IOException("This feed can't download.");

    public Task<bool?> HasAttestationAsync(string sha256, CancellationToken cancel) => Task.FromResult<bool?>(null);
}
