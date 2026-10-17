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
            return BackupArchive.Restore(temp, target, () => code, log);
        }
        finally
        {
            try { Directory.Delete(folder, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task<(string Url, byte[] HolderKey, string Code)> PrepareAsync(BuddyHttp http, string url, string recoveryCode, CancellationToken cancel)
    {
        var code = BuddyCrypto.NormalizeRecoveryCode(recoveryCode)
            ?? throw new InvalidDataException("That isn't a recovery code: it's 25 letters and digits, like ABCDE-FGHJK-MNPQR-STVWX-YZ012.");
        if (!url.Contains("://", StringComparison.Ordinal)) url = "https://" + url.Trim();
        string clean;
        try { clean = await BuddyHttp.CheckUrlAsync(url, http.LocalOnly, cancel); }
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
