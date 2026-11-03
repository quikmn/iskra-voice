namespace Iskra.Server.Files;

public sealed partial class Uploads
{
    /// <summary>
    /// Deletes the files of expired messages (records and stored content), unless something else still uses them: another
    /// message, an avatar or emoji, a profile page, a running watch party, a docs page, a whiteboard, a bot card or an open
    /// report (the same keep list as the unused-upload sweep). Returns how many file records went.
    /// </summary>
    public int DeleteExpiredFiles(IReadOnlyCollection<string> ids)
    {
        if (ids.Count == 0) return 0;
        var keep = InUseOutsideTables();
        var removed = world.Store.DeleteFilesIfUnused(ids, keep);
        DeleteContent(removed);
        return removed.Count;
    }
}
