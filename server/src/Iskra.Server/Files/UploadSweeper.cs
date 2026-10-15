using System.Text.RegularExpressions;

namespace Iskra.Server.Files;

public sealed partial class Uploads
{
    /// <summary>How long an upload may wait to be used (sent in a message, set as an avatar…) before it is deleted.</summary>
    public static readonly TimeSpan UnusedGrace = TimeSpan.FromHours(24);

    [GeneratedRegex("/files/([A-Za-z0-9_-]{16,64})")]
    private static partial Regex FileLink();

    /// <summary>Files used by what the database's reference lists don't cover (pages by URL, watch parties, reports, docs, boards, cards).</summary>
    private HashSet<string> InUseOutsideTables()
    {
        var keep = world.Store.AllPageHtml().SelectMany(html => FileLink().Matches(html).Select(m => m.Groups[1].Value)).ToHashSet();
        if (voice is not null) keep.UnionWith(voice.Watch.FileIds()); // none from the command line
        keep.UnionWith(world.Store.ReportFileIds()); // moderators still look at reported files
        keep.UnionWith(world.Store.DocFileIds()); // pictures in docs pages (and their revisions)
        keep.UnionWith(world.Store.BoardFileIds()); // pictures on whiteboards
        keep.UnionWith(world.Store.CardFileIds()); // pictures in bots' cards
        return keep;
    }

    /// <summary>Deletes one file record (and its content, unless another record shares it) at once if nothing uses it.</summary>
    public void DeleteIfUnused(string id) => DeleteContent(world.Store.DeleteFilesIfUnused([id], InUseOutsideTables()));

    /// <summary>
    /// Deletes uploads older than a day that nothing refers to: messages, avatars, emoji, sounds, webhooks,
    /// profile pages (which may show this server's files by URL) and running watch parties. Returns how many records went.
    /// </summary>
    public int Sweep(DateTimeOffset now)
    {
        var keep = InUseOutsideTables();
        var removed = world.Store.DeleteUnreferencedFiles((now - UnusedGrace).ToUnixTimeMilliseconds(), keep);
        if (removed.Count > 0) world.Store.ForgetDeletedDmFiles();
        DeleteContent(removed);

        lock (_quotaLock) DropExpired(now); // uploads in parts nobody finished

        // Leftovers of uploads cut off by a crash.
        foreach (var temp in Directory.EnumerateFiles(Path.Combine(world.Path, "uploads"), ".incoming-*"))
        {
            try { if (File.GetLastWriteTimeUtc(temp) < (now - UnusedGrace).UtcDateTime) File.Delete(temp); }
            catch (IOException) { /* in use: next time */ }
        }
        if (removed.Count > 0) log.LogInformation("Deleted {Count} unused uploads", removed.Count);
        return removed.Count;
    }
}

/// <summary>Runs <see cref="Uploads.Sweep"/> every hour, so files uploaded and never used don't fill the disk.</summary>
public sealed class UploadSweeper(Uploads uploads, TimeProvider time, ILogger<UploadSweeper> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1), time);
        do
        {
            try { uploads.Sweep(time.GetUtcNow()); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Upload sweep failed"); }
        }
        while (await timer.WaitForNextTickAsync(stopping).ConfigureAwait(false));
    }
}
