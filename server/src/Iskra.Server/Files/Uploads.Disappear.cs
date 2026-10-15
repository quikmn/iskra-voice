namespace Iskra.Server.Files;

public sealed partial class Uploads
{
    /// <summary>
    /// Deletes the files of expired messages (records and stored content), unless something else still uses them: another
    /// message, an avatar or emoji, a profile page, a running watch party, a docs page, a bot card or an open report.
    /// Returns how many file records went.
    /// </summary>
    public int DeleteExpiredFiles(IReadOnlyCollection<string> ids)
    {
        if (ids.Count == 0) return 0;
        var keep = world.Store.AllPageHtml().SelectMany(html => FileLink().Matches(html).Select(m => m.Groups[1].Value)).ToHashSet();
        if (voice is not null) keep.UnionWith(voice.Watch.FileIds());
        keep.UnionWith(world.Store.ReportFileIds());
        keep.UnionWith(world.Store.DocFileIds());
        keep.UnionWith(world.Store.CardFileIds());
        var removed = world.Store.DeleteFilesIfUnused(ids, keep);
        DeleteContent(removed);
        return removed.Count;
    }
}
