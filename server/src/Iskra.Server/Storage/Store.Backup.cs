using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

public sealed partial class Store
{
    /// <summary>
    /// A consistent copy of the whole database at <paramref name="destination"/>, made with SQLite's online backup API
    /// on a separate read connection: it reads one committed snapshot (WAL), so writers carry on meanwhile.
    /// </summary>
    public void Snapshot(string destination)
    {
        File.Delete(destination);
        using var source = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = _db.DataSource, Mode = SqliteOpenMode.ReadOnly, Pooling = false,
        }.ToString());
        source.Open();
        using var target = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destination, Pooling = false }.ToString());
        target.Open();
        source.BackupDatabase(target);
        // One self-contained file: no -wal next to it.
        using var cmd = target.CreateCommand();
        cmd.CommandText = "PRAGMA journal_mode = DELETE;";
        cmd.ExecuteNonQuery();
    }

    /// <summary>Counts for a backup or import summary.</summary>
    public (long Messages, long Channels, long Members) Counts() =>
        (Convert.ToInt64(Scalar("SELECT COUNT(*) FROM messages;")),
         Convert.ToInt64(Scalar("SELECT COUNT(*) FROM channels WHERE parent_id IS NULL;")),
         Convert.ToInt64(Scalar("SELECT COUNT(*) FROM members;")));
}
