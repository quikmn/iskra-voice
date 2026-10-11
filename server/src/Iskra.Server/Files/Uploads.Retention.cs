namespace Iskra.Server.Files;

public sealed partial class Uploads
{
    /// <summary>
    /// Retention for files in messages and DMs: deletes those uploaded before <paramref name="cutoff"/> (ms) unless an avatar,
    /// emoji, sticker, sound, webhook, event cover, profile page, running watch party or open report uses them. Returns how many went.
    /// </summary>
    public int DeleteOldMessageFiles(long cutoff)
    {
        var keep = world.Store.AllPageHtml().SelectMany(html => FileLink().Matches(html).Select(m => m.Groups[1].Value)).ToHashSet();
        if (voice is not null) keep.UnionWith(voice.Watch.FileIds());
        keep.UnionWith(world.Store.ReportFileIds());
        var removed = world.Store.DeleteOldMessageFiles(cutoff, keep);
        if (removed.Count > 0) world.Store.ForgetDeletedDmFiles();
        DeleteContent(removed);
        return removed.Count;
    }

    /// <summary>Deletes stored content by hash, unless another file record still uses the same content.</summary>
    private void DeleteContent(IEnumerable<string> hashes)
    {
        foreach (var sha in hashes.Distinct())
        {
            lock (_diskLock)
            {
                if (world.Store.ContentInUse(sha)) continue;
                try { File.Delete(PathFor(sha)); }
                catch (IOException ex) { log.LogWarning("Couldn't delete upload {Sha}: {Message}", sha, ex.Message); }
            }
        }
    }
}
