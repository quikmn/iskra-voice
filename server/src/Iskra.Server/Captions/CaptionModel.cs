using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;

namespace Iskra.Server.Captions;

/// <summary>
/// The live-captions model (Whisper base) as the apps download it: parts of at most 20 MiB, each with its SHA-256.
/// The pins live in client/src/state/captions/model.json, compiled into both the app and this server.
/// </summary>
public sealed record ModelManifest(string Name, string Dir, string Source, ModelFile[] Files)
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

    public static ModelManifest Pinned { get; } = Load();

    private static ModelManifest Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("captions-model.json")
            ?? throw new InvalidOperationException("captions-model.json isn't compiled in");
        return JsonSerializer.Deserialize<ModelManifest>(stream, Options) ?? throw new InvalidOperationException("captions-model.json is empty");
    }

    /// <summary>The file a part name belongs to ("decoder.q8.onnx.part1.bin"), or null if there's no such part.</summary>
    public (ModelFile File, int Index)? Part(string name)
    {
        foreach (var f in Files)
            for (var i = 0; i < f.Parts.Length; i++)
                if (name == PartName(f, i)) return (f, i);
        return null;
    }

    public static string PartName(ModelFile file, int index) => $"{file.Name}.part{index}.bin";

    public long TotalBytes => Files.Sum(f => f.Bytes);
}

public sealed record ModelFile(string Name, string From, string Sha256, long Bytes, ModelPart[] Parts);

public sealed record ModelPart(string Sha256, long Bytes);

/// <summary>Where the server gets the model from, once. Swapped for a fake in tests.</summary>
public interface IModelUpstream
{
    /// <summary>The whole file (checked by the caller).</summary>
    Task<byte[]> GetFileAsync(ModelManifest manifest, ModelFile file, CancellationToken cancel);
}

/// <summary>Hugging Face, at the pinned commit (HTTPS only, redirects to its file storage allowed, size-capped).</summary>
public sealed class HttpModelUpstream : IModelUpstream, IDisposable
{
    private readonly HttpClient _http = new(new SocketsHttpHandler { AllowAutoRedirect = true, MaxAutomaticRedirections = 5, UseCookies = false })
    {
        Timeout = TimeSpan.FromMinutes(15),
    };

    public async Task<byte[]> GetFileAsync(ModelManifest manifest, ModelFile file, CancellationToken cancel)
    {
        var uri = new Uri($"{manifest.Source}/{file.From}");
        if (uri.Scheme != Uri.UriSchemeHttps) throw new ModelDownloadException("the model source isn't HTTPS");
        using var response = await _http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancel);
        if (!response.IsSuccessStatusCode) throw new ModelDownloadException($"{file.Name}: HTTP {(int)response.StatusCode}");
        if (response.RequestMessage?.RequestUri?.Scheme != Uri.UriSchemeHttps) throw new ModelDownloadException("redirected off HTTPS");
        await using var body = await response.Content.ReadAsStreamAsync(cancel);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await body.ReadAsync(chunk, cancel)) > 0)
        {
            if (buffer.Length + read > file.Bytes) throw new ModelDownloadException($"{file.Name}: bigger than expected");
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    public void Dispose() => _http.Dispose();
}

/// <summary>A folder of parts laid out as the apps ask for them (scripts/get-models.mjs output: development and tests).</summary>
public sealed class FolderModelUpstream(string folder) : IModelUpstream
{
    public async Task<byte[]> GetFileAsync(ModelManifest manifest, ModelFile file, CancellationToken cancel)
    {
        using var buffer = new MemoryStream();
        for (var i = 0; i < file.Parts.Length; i++)
        {
            var path = Path.Combine(folder, manifest.Dir, ModelManifest.PartName(file, i));
            if (!File.Exists(path)) throw new ModelDownloadException($"{ModelManifest.PartName(file, i)} isn't in {folder}");
            var part = await File.ReadAllBytesAsync(path, cancel);
            buffer.Write(part);
        }
        return buffer.ToArray();
    }
}

public sealed class ModelDownloadException(string message) : Exception(message);

/// <summary>
/// Keeps one pinned model in a folder of the world (models/...), fetching it once from upstream the first time someone
/// asks (every byte checked against the pinned SHA-256s) and serving it from disk after that. Concurrent requests share
/// one download. The security log gets "&lt;logPrefix&gt;.download" and "&lt;logPrefix&gt;.rejected".
/// </summary>
public class PinnedModel(World world, IModelUpstream upstream, ModelManifest manifest, string folder, string logPrefix, TimeProvider time, ILogger log)
{
    private readonly Lock _lock = new();
    private Task? _download;

    public ModelManifest Manifest { get; } = manifest;

    public string Folder { get; } = folder;

    protected World World => world;

    /// <summary>The file on disk for a part the apps may ask for; null for anything else (other versions, paths, names).</summary>
    public string? PathOf(string dir, string part) =>
        dir == Manifest.Dir && Manifest.Part(part) is not null ? Path.Combine(Folder, part) : null;

    public bool Complete => Manifest.Files.All(f => f.Parts.Select((_, i) => ModelManifest.PartName(f, i)).All(p => File.Exists(Path.Combine(Folder, p))));

    /// <summary>Downloads whatever isn't on disk yet. One download at a time; a failed one can be tried again.</summary>
    public Task EnsureAsync()
    {
        lock (_lock)
        {
            if (_download is null || _download.IsFaulted || _download.IsCanceled) _download = Task.Run(DownloadAsync);
            return _download;
        }
    }

    private async Task DownloadAsync()
    {
        Directory.CreateDirectory(Folder);
        long fetched = 0;
        foreach (var file in Manifest.Files)
        {
            var names = file.Parts.Select((_, i) => ModelManifest.PartName(file, i)).ToArray();
            if (names.All(n => File.Exists(Path.Combine(Folder, n)))) continue;
            byte[] data;
            try
            {
                data = await upstream.GetFileAsync(Manifest, file, CancellationToken.None);
            }
            catch (Exception e) when (e is not ModelDownloadException)
            {
                throw new ModelDownloadException($"{file.Name}: {e.Message}");
            }
            if (data.LongLength != file.Bytes || Hex(SHA256.HashData(data)) != file.Sha256)
            {
                Failed(file.Name, "hash");
                throw new ModelDownloadException($"{file.Name} isn't the pinned file");
            }
            long offset = 0;
            for (var i = 0; i < file.Parts.Length; i++)
            {
                var part = data.AsSpan((int)offset, (int)file.Parts[i].Bytes);
                if (Hex(SHA256.HashData(part)) != file.Parts[i].Sha256)
                {
                    Failed(file.Name, "hash");
                    throw new ModelDownloadException($"{names[i]} isn't the pinned part");
                }
                WriteAtomic(Path.Combine(Folder, names[i]), part);
                offset += file.Parts[i].Bytes;
            }
            fetched += data.LongLength;
        }
        if (fetched > 0)
        {
            log.LogInformation("Downloaded a model ({Model}, {Bytes} bytes)", Manifest.Dir, fetched);
            SecurityLog.Record(world.Store, time.GetUtcNow().ToUnixTimeMilliseconds(), $"{logPrefix}.download",
                details: new { model = Manifest.Dir, bytes = fetched });
        }
    }

    private void Failed(string file, string reason)
    {
        log.LogWarning("A model from upstream failed its check ({Model}, {File})", Manifest.Dir, file);
        SecurityLog.Record(world.Store, time.GetUtcNow().ToUnixTimeMilliseconds(), $"{logPrefix}.rejected",
            details: new { model = Manifest.Dir, file, reason });
    }

    private static void WriteAtomic(string path, ReadOnlySpan<byte> data)
    {
        var temp = path + ".tmp";
        File.Delete(temp);
        using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write)) stream.Write(data);
        File.Move(temp, path, overwrite: true);
    }

    private static string Hex(byte[] hash) => Convert.ToHexStringLower(hash);
}

/// <summary>The captions model in models/&lt;dir&gt;/.</summary>
public sealed class CaptionModelService(World world, IModelUpstream upstream, ModelManifest manifest, TimeProvider time, ILogger<CaptionModelService> log)
    : PinnedModel(world, upstream, manifest, Path.Combine(world.Path, "models", manifest.Dir), "captions.model", time, log)
{
    /// <summary>The owner offers captions on this server (server.json Captions.ModelDownload).</summary>
    public bool Enabled => World.Settings.Captions.ModelDownload;
}
