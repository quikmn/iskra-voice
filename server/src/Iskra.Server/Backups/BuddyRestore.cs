using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Backups;

/// <summary>
/// Restoring from a backup buddy (iskra-server restore-buddy): the recovery code gives the restore key, which lists and
/// downloads the copies the friend's server keeps; the newest (or a chosen) one restores like any backup.
/// </summary>
public static class BuddyRestore
{
    /// <summary>The copies the holder keeps for whoever has this recovery code, newest first.</summary>
    public static async Task<List<BuddyVersion>> ListAsync(BuddyHttp http, string url, string recoveryCode, CancellationToken cancel)
    {
        var (clean, holderKey, code) = await PrepareAsync(http, url, recoveryCode, cancel);
        using var key = BuddyCrypto.RestoreKey(code);
        return (await Call(() => http.SpotAsync(clean, holderKey, key, Now, cancel))).Versions;
    }

    public static async Task<RestoreResult> RestoreAsync(BuddyHttp http, string url, string recoveryCode, string target, string? versionId,
        Action<string>? log, CancellationToken cancel)
    {
        var (clean, holderKey, code) = await PrepareAsync(http, url, recoveryCode, cancel);
        using var key = BuddyCrypto.RestoreKey(code);
        var spot = await Call(() => http.SpotAsync(clean, holderKey, key, Now, cancel));
        var version = (versionId is null ? spot.Versions.FirstOrDefault() : spot.Versions.FirstOrDefault(v => v.Id == versionId))
            ?? throw new InvalidDataException(versionId is null ? "Your friend's server has no copies of this server yet." : "Your friend's server has no copy with that id.");
        CheckRoom(version.Size, FreeBytes(Path.GetTempPath()), FreeBytes(target));
        var folder = Path.Combine(Path.GetTempPath(), $"iskra-buddy-{Guid.NewGuid():N}");
        AtomicFile.CreatePrivateDirectory(folder);
        var temp = Path.Combine(folder, $"copy{BackupFile.Extension}");
        try
        {
            log?.Invoke($"Downloading the copy from {DateTimeOffset.FromUnixTimeMilliseconds(version.At).ToLocalTime():yyyy-MM-dd HH:mm} ({version.Size:N0} bytes)…");
            await using (var file = BackupArchive.PrivateCreate(temp))
                await Call(async () =>
                {
                    await http.DownloadAsync(clean, holderKey, key, version.Id, file, version.Size, Now, null, cancel);
                    return true;
                });
            if (new FileInfo(temp).Length != version.Size) throw new InvalidDataException("The download was cut off. Try again.");
            var result = BackupArchive.Restore(temp, target, () => code, log);
            var warning = RollbackWarning(result.CreatedAt, spot.Versions.Max(v => v.At));
            if (result.CreatedAt is { } made) log?.Invoke($"This copy was made on {DateTimeOffset.FromUnixTimeMilliseconds(made).ToLocalTime():yyyy-MM-dd HH:mm}.");
            if (warning is not null) log?.Invoke(warning);
            return result with { Warning = warning };
        }
        finally
        {
            try { Directory.Delete(folder, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>How much older a copy may be than the newest date the holder lists (a big copy takes a while to send).</summary>
    public static readonly TimeSpan RollbackSlack = TimeSpan.FromDays(1);

    /// <summary>
    /// The dates the holder lists are its own word; the date inside the copy is sealed by the source. A copy made well
    /// before the newest date listed may be an old one passed off as new (a holder can't change a copy, but it can pick one).
    /// </summary>
    internal static string? RollbackWarning(long? createdAt, long newestListed) =>
        createdAt is { } made && newestListed - made > (long)RollbackSlack.TotalMilliseconds
            ? $"Warning: this copy was made on {DateTimeOffset.FromUnixTimeMilliseconds(made).ToLocalTime():yyyy-MM-dd HH:mm}, but your friend's server lists a copy from {DateTimeOffset.FromUnixTimeMilliseconds(newestListed).ToLocalTime():yyyy-MM-dd HH:mm}. It may be giving you an older copy than the newest: check with your friend before you use it."
            : null;

    /// <summary>The biggest copy a restore downloads: the biggest spot a holder can give (1 TB).</summary>
    public const long MaxCopyBytes = Features.BuddyBackupFeature.MaxQuotaMb * 1024 * 1024;

    /// <summary>
    /// The holder says how big the copy is: refuse absurd sizes, and sizes this computer has no room for (the download,
    /// then the restored server, which is about as big again).
    /// </summary>
    internal static void CheckRoom(long size, long? freeTemp, long? freeTarget)
    {
        if (size is <= 0 or > MaxCopyBytes) throw new InvalidDataException("Your friend's server reports a copy of an impossible size.");
        if (freeTemp < size || freeTarget < size || (freeTemp is { } t && freeTarget is { } g && t == g && t < 2 * size))
            throw new InvalidDataException($"There isn't enough free disk space here for this copy ({size:N0} bytes, and as much again for the restored server).");
    }

    private static long? FreeBytes(string path)
    {
        try { return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace; }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException) { return null; }
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task<(string Url, byte[] HolderKey, string Code)> PrepareAsync(BuddyHttp http, string url, string recoveryCode, CancellationToken cancel)
    {
        var code = BuddyCrypto.NormalizeRecoveryCode(recoveryCode)
            ?? throw new InvalidDataException("That isn't a recovery code: it's 25 letters and digits, like ABCDE-FGHJK-MNPQR-STVWX-YZ012.");
        if (!url.Contains("://", StringComparison.Ordinal)) url = "https://" + url.Trim();
        string clean;
        try { clean = await BuddyHttp.CheckUrlAsync(url, http.LocalOnly, cancel, http.AllowLoopback); }
        catch (Protocol.RequestException) { throw new InvalidDataException("That address can't be used for a backup buddy."); }
        var holderKey = await Call(() => http.HelloAsync(clean, cancel));
        return (clean, holderKey, code);
    }

    /// <summary>Turns what went wrong into one sentence for the person restoring.</summary>
    private static async Task<T> Call<T>(Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (BuddyHttpException ex)
        {
            throw new InvalidDataException(ex.Status switch
            {
                401 or 403 => "That recovery code isn't known there. Check the code and the address of your friend's server.",
                404 => "That server doesn't keep backups (or not that copy). Check the address.",
                429 => "Your friend's server asked to wait a moment. Try again in a minute.",
                _ => $"Your friend's server answered {ex.Status}.",
            });
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or BuddyAddressException)
        {
            throw new InvalidDataException($"Your friend's server couldn't be reached: {(ex is HttpRequestException { InnerException: { } inner } ? inner.Message : ex.Message)}");
        }
    }
}
