using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Backups;

public sealed record LocalBackup(string Name, long Size, long CreatedAt);

/// <summary>
/// Backups while the server runs: encrypted downloads for the owner (built into backups/, handed out once by an
/// unguessable link for 30 minutes) and the automatic daily copies in backups/auto-YYYY-MM-DD.zip.
/// </summary>
public sealed class BackupService(World world, TimeProvider time, ILogger<BackupService> log) : BackgroundService
{
    private sealed record Download(string Path, string FileName, DateTimeOffset Expires);

    public static readonly TimeSpan DownloadLifetime = TimeSpan.FromMinutes(30);
    private const string AutoPrefix = "auto-";

    private readonly ConcurrentDictionary<string, Download> _downloads = new();
    private readonly SemaphoreSlim _busy = new(1, 1);

    /// <summary>Argon2id cost for new backups. Tests turn it down.</summary>
    internal (long Ops, long Mem) KdfCost { get; set; } = (Sodium.OpsModerate, Sodium.MemModerate);

    public string Folder => Path.Combine(world.Path, "backups");

    /// <summary>
    /// Builds an encrypted backup and returns its download token, or null when another backup is being made.
    /// Runs on a worker thread; <paramref name="progress"/> gets (bytes done, bytes total).
    /// </summary>
    public async Task<(string Token, string FileName, long Size)?> CreateDownloadAsync(string passphrase, Action<long, long>? progress, CancellationToken cancel)
    {
        if (!await _busy.WaitAsync(0, cancel)) return null;
        try
        {
            Expire();
            AtomicFile.CreatePrivateDirectory(Folder);
            var token = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(24));
            var path = Path.Combine(Folder, $"download-{Guid.NewGuid():N}{BackupFile.Extension}");
            var now = time.GetUtcNow();
            var fileName = $"{SafeFileName(world.Settings.Name)}-{now.ToLocalTime():yyyy-MM-dd}{BackupFile.Extension}";
            try
            {
                await Task.Run(() =>
                {
                    using var file = BackupArchive.PrivateCreate(path);
                    using (var encrypted = BackupFile.Encrypt(file, passphrase, Ed25519.ToB64u(world.ServerPublicKey), world.Settings.Name,
                               now.ToUnixTimeMilliseconds(), KdfCost.Ops, KdfCost.Mem))
                        BackupArchive.Write(world, encrypted, includeUploads: true, now.ToUnixTimeMilliseconds(), progress, cancel);
                }, cancel);
            }
            catch
            {
                File.Delete(path);
                throw;
            }
            _downloads[token] = new Download(path, fileName, now + DownloadLifetime);
            return (token, fileName, new FileInfo(path).Length);
        }
        finally
        {
            _busy.Release();
        }
    }

    /// <summary>GET /backup/{token}: the file as a download, or 404.</summary>
    public IResult Serve(HttpContext context, string token)
    {
        Files.Uploads.AllowCors(context);
        Expire();
        if (!_downloads.TryGetValue(token, out var download) || !File.Exists(download.Path)) return Results.NotFound();
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return Results.File(download.Path, "application/octet-stream", download.FileName, enableRangeProcessing: true);
    }

    private void Expire()
    {
        var now = time.GetUtcNow();
        foreach (var (token, download) in _downloads)
        {
            if (download.Expires > now || !_downloads.TryRemove(token, out _)) continue;
            TryDelete(download.Path);
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { /* still being downloaded: next time */ }
    }

    private static string SafeFileName(string name)
    {
        var clean = new string(name.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '-').ToArray()).Trim('-');
        return clean.Length == 0 ? "iskra" : clean.Length > 40 ? clean[..40] : clean;
    }

    // ── Automatic daily backups ──────────────────────────────────────────────

    public List<LocalBackup> LocalBackups()
    {
        if (!Directory.Exists(Folder)) return [];
        return Directory.EnumerateFiles(Folder, $"{AutoPrefix}*.zip")
            .Select(p => new FileInfo(p))
            .OrderByDescending(f => f.Name, StringComparer.Ordinal)
            .Select(f => new LocalBackup(f.Name, f.Length, new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()))
            .ToList();
    }

    /// <summary>Makes today's automatic backup if there isn't one yet, then keeps only the newest <c>Keep</c>.</summary>
    public bool RunDaily()
    {
        var settings = world.Settings.Backups;
        if (!settings.Enabled) return false;
        if (!_busy.Wait(0)) return false;
        try
        {
            AtomicFile.CreatePrivateDirectory(Folder);
            var now = time.GetUtcNow();
            var name = $"{AutoPrefix}{now.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}.zip";
            var path = Path.Combine(Folder, name);
            var made = false;
            if (!File.Exists(path))
            {
                var temp = path + ".tmp";
                File.Delete(temp);
                try
                {
                    using (var file = BackupArchive.PrivateCreate(temp))
                        BackupArchive.Write(world, file, settings.IncludeUploads, now.ToUnixTimeMilliseconds());
                    File.Move(temp, path);
                    made = true;
                    log.LogInformation("Daily backup written to {Path}", path);
                }
                finally
                {
                    File.Delete(temp);
                }
            }
            var keep = Math.Clamp(settings.Keep, 1, 30);
            foreach (var old in LocalBackups().Skip(keep)) TryDelete(Path.Combine(Folder, old.Name));
            return made;
        }
        finally
        {
            _busy.Release();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Downloads that never finished (the server stopped) aren't wanted any more.
        if (Directory.Exists(Folder))
        {
            foreach (var stale in Directory.EnumerateFiles(Folder, "download-*")) TryDelete(stale);
            foreach (var stale in Directory.EnumerateFiles(Folder, ".snapshot-*")) TryDelete(stale);
        }
        try
        {
            // Not right at startup (let everything come up first), then checked hourly.
            await Task.Delay(TimeSpan.FromMinutes(2), time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                try { RunDaily(); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException)
                {
                    log.LogWarning(ex, "Daily backup failed");
                }
                Expire();
                await Task.Delay(TimeSpan.FromHours(1), time, stoppingToken);
            }
        }
        catch (OperationCanceledException) { /* stopping */ }
    }
}
