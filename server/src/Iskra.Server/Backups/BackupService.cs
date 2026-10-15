using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server.Backups;

public sealed record LocalBackup(string Name, long Size, long CreatedAt);

/// <summary>How a copy to Backups.CopyTo went: when, whether it worked, which backup, and the problem if not.</summary>
public sealed record BackupCopyResult(long At, bool Ok, string Name, RequestException? Error);

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
            CopyNewest();
            return made;
        }
        finally
        {
            _busy.Release();
        }
    }

    // ── Copies somewhere else (Backups.CopyTo) ───────────────────────────────

    /// <summary>How the last copy to <c>Backups.CopyTo</c> went, or null when there's no copy folder or no try yet.</summary>
    public BackupCopyResult? LastCopy { get; private set; }

    private static readonly System.Text.RegularExpressions.Regex AutoName = new(@"^auto-\d{4}-\d{2}-\d{2}\.zip$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// Checks a copy folder: a full path outside the world folder. Returns the problem (as the request error the owner
    /// sees) or null, with the normalized path.
    /// </summary>
    public static RequestException? CheckCopyFolder(string worldPath, string folder, out string full)
    {
        full = "";
        if (string.IsNullOrWhiteSpace(folder) || folder.Any(char.IsControl) || !Path.IsPathFullyQualified(folder))
            return RequestException.BadRequest("Use a full path for the backup copy folder, like /mnt/usb/iskra.", "backup_copy_relative");
        try
        {
            full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return RequestException.BadRequest("Use a full path for the backup copy folder, like /mnt/usb/iskra.", "backup_copy_relative");
        }
        var target = full;
        // A link to somewhere inside the world counts as inside.
        try
        {
            if (Directory.Exists(full) && new DirectoryInfo(full).ResolveLinkTarget(returnFinalTarget: true) is { } link)
                target = Path.TrimEndingDirectorySeparator(link.FullName);
        }
        catch (IOException) { /* checked again when copying */ }
        var world = Path.TrimEndingDirectorySeparator(Path.GetFullPath(worldPath));
        var comparison = OperatingSystem.IsLinux() ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        foreach (var path in new[] { full, target })
        {
            if (path.Equals(world, comparison) || path.StartsWith(world + Path.DirectorySeparatorChar, comparison) ||
                path.StartsWith(world + Path.AltDirectorySeparatorChar, comparison))
                return RequestException.BadRequest("Pick a backup copy folder outside the server's own folder, ideally on another disk.", "backup_copy_inside_world");
        }
        return null;
    }

    /// <summary>
    /// Copies the newest daily backup into <c>Backups.CopyTo</c> unless it's there already (written to a temp file,
    /// then renamed), and keeps the newest <c>Keep</c> there. Never throws: problems end up in <see cref="LastCopy"/>
    /// and the log. Call with <c>_busy</c> held.
    /// </summary>
    private void CopyNewest()
    {
        var settings = world.Settings.Backups;
        if (string.IsNullOrWhiteSpace(settings.CopyTo))
        {
            LastCopy = null;
            return;
        }
        var newest = LocalBackups().FirstOrDefault();
        if (newest is null) return;
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        try
        {
            if (CheckCopyFolder(world.Path, settings.CopyTo, out var folder) is { } invalid)
            {
                Failed(invalid);
                return;
            }
            if (!Directory.Exists(folder))
            {
                Failed(new RequestException("not_found", "The backup copy folder doesn't exist (is the disk or share connected?).", "backup_copy_missing"));
                return;
            }
            var target = Path.Combine(folder, newest.Name);
            if (!File.Exists(target) || new FileInfo(target).Length != newest.Size)
            {
                var temp = Path.Combine(folder, $".{newest.Name}.{Guid.NewGuid():N}.tmp");
                try
                {
                    var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
                    if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                    using (var source = File.OpenRead(Path.Combine(Folder, newest.Name)))
                    using (var output = new FileStream(temp, options))
                    {
                        source.CopyTo(output);
                        output.Flush(flushToDisk: true); // a USB stick may be pulled out
                    }
                    File.Move(temp, target, overwrite: true);
                    log.LogInformation("Daily backup copied to {Path}", target);
                }
                finally
                {
                    try { File.Delete(temp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
            }
            var keep = Math.Clamp(settings.Keep, 1, 30);
            var copies = Directory.EnumerateFiles(folder, "auto-*.zip")
                .Select(Path.GetFileName)
                .Where(name => name is not null && AutoName.IsMatch(name))
                .OrderByDescending(name => name, StringComparer.Ordinal);
            foreach (var old in copies.Skip(keep)) File.Delete(Path.Combine(folder, old!));
            // Temp files from a copy that was cut off (the server stopped, the stick was pulled out).
            foreach (var stale in Directory.EnumerateFiles(folder, ".auto-*.tmp"))
            {
                if (File.GetLastWriteTimeUtc(stale) < time.GetUtcNow().UtcDateTime.AddDays(-1)) TryDelete(stale);
            }
            LastCopy = new BackupCopyResult(now, true, newest.Name, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Failed(new RequestException("internal", $"Copying the daily backup failed: {ex.Message}", "backup_copy_failed", new { reason = ex.Message }));
        }

        void Failed(RequestException problem)
        {
            // Once per new problem, not every hour.
            if (LastCopy?.Error?.Message != problem.Message) log.LogWarning("Daily backup not copied to {Folder}: {Problem}", settings.CopyTo, problem.Message);
            LastCopy = new BackupCopyResult(now, false, newest.Name, problem);
        }
    }

    /// <summary>Copies the newest daily backup now (after the owner picks a folder), on a worker thread.</summary>
    public Task CopyNowAsync() => LastCopyTask = Task.Run(() =>
    {
        _busy.Wait();
        try { CopyNewest(); }
        finally { _busy.Release(); }
    });

    /// <summary>The copy <see cref="CopyNowAsync"/> started last (tests wait for it).</summary>
    internal Task LastCopyTask { get; private set; } = Task.CompletedTask;

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
