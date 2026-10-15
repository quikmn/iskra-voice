namespace Iskra.Server.Storage;

/// <summary>
/// A channel's whiteboard. <see cref="Seq"/> is the newest batch; the snapshot holds the board after batch
/// <see cref="SnapSeq"/> (0: none), and <see cref="BatchCount"/>/<see cref="BatchBytes"/> count the batches after it.
/// </summary>
public sealed record WbBoard(long ChannelId, string Id, long Seq, string? OpenedBy, long OpenedAt,
    long SnapSeq, string? SnapBy, long? SnapAt, long? SnapVersion, int SnapBytes, int BatchCount, int BatchBytes);

/// <summary>One batch of ops: JSON ops on a plain board, an envelope (and its epoch version) on an encrypted one.</summary>
public sealed record WbBatch(long ChannelId, long Seq, string Author, string Data, long? Version, long CreatedAt);

/// <summary>
/// Whiteboards: one board per channel (whiteboard channels, and voice channels while one is open), its batches in
/// <c>seq</c> order, and a snapshot older batches are folded into. Appends and compactions run in one transaction each.
/// </summary>
public sealed partial class Store
{
    private const string WhiteboardMigration = """
        CREATE TABLE wb_boards (
            channel_id    INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            id            TEXT NOT NULL,
            seq           INTEGER NOT NULL DEFAULT 0,
            opened_by     TEXT,
            opened_at     INTEGER NOT NULL,
            snap_seq      INTEGER NOT NULL DEFAULT 0,
            snap_data     TEXT,
            snap_by       TEXT,
            snap_at       INTEGER,
            snap_version  INTEGER,
            batch_count   INTEGER NOT NULL DEFAULT 0,
            batch_bytes   INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE wb_batches (
            channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            seq           INTEGER NOT NULL,
            author        TEXT NOT NULL,
            data          TEXT NOT NULL,
            version       INTEGER,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (channel_id, seq)
        );
        CREATE INDEX wb_batches_by_author ON wb_batches(author);
        CREATE TABLE wb_files (
            channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            file_id       TEXT NOT NULL,
            PRIMARY KEY (channel_id, file_id)
        );
        """;

    private const string BoardColumns =
        "b.channel_id, b.id, b.seq, b.opened_by, b.opened_at, b.snap_seq, b.snap_by, b.snap_at, b.snap_version, COALESCE(length(CAST(b.snap_data AS BLOB)), 0), b.batch_count, b.batch_bytes";

    private static WbBoard ReadBoard(Microsoft.Data.Sqlite.SqliteDataReader r) => new(
        r.GetInt64(0), r.GetString(1), r.GetInt64(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt64(4),
        r.GetInt64(5), r.IsDBNull(6) ? null : r.GetString(6), NullableLong(r, 7), NullableLong(r, 8), r.GetInt32(9), r.GetInt32(10), r.GetInt32(11));

    private static WbBatch ReadBatch(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), NullableLong(r, 4), r.GetInt64(5));

    public WbBoard? GetBoard(long channelId) =>
        Query($"SELECT {BoardColumns} FROM wb_boards b WHERE b.channel_id = $ch;", ReadBoard, ("$ch", channelId)).FirstOrDefault();

    /// <summary>The channel's board, made (empty, with this id) if it has none. Returns it and whether it was made now.</summary>
    public (WbBoard Board, bool Created) EnsureBoard(long channelId, string id, string? openedBy, long now)
    {
        lock (_gate)
        {
            var created = Scalar("INSERT OR IGNORE INTO wb_boards (channel_id, id, opened_by, opened_at) VALUES ($ch, $id, $by, $now) RETURNING channel_id;",
                ("$ch", channelId), ("$id", id), ("$by", openedBy), ("$now", now)) is not null;
            return (GetBoard(channelId)!, created);
        }
    }

    /// <summary>The snapshot's data (plain: the objects as JSON; encrypted: the envelope), or null.</summary>
    public string? BoardSnapshot(long channelId) =>
        Scalar("SELECT snap_data FROM wb_boards WHERE channel_id = $ch;", ("$ch", channelId)) as string;

    /// <summary>Open boards of voice channels (whiteboard channels always have one).</summary>
    public List<WbBoard> VoiceBoards() =>
        Query($"SELECT {BoardColumns} FROM wb_boards b JOIN channels c ON c.id = b.channel_id WHERE c.kind = 'voice';", ReadBoard);

    /// <summary>
    /// Adds a batch to board <paramref name="boardId"/> as the next seq. Null if the channel's board isn't that one (cleared).
    /// </summary>
    public long? AppendBatch(long channelId, string boardId, string author, string data, long? version, long now, string[] fileIds)
    {
        return InDocTransaction(run =>
        {
            var seq = run("""
                UPDATE wb_boards SET seq = seq + 1, batch_count = batch_count + 1, batch_bytes = batch_bytes + length(CAST($data AS BLOB))
                WHERE channel_id = $ch AND id = $id RETURNING seq;
                """, [("$ch", channelId), ("$id", boardId), ("$data", data)]);
            if (seq is null) return (long?)null;
            var next = Convert.ToInt64(seq);
            run("INSERT INTO wb_batches (channel_id, seq, author, data, version, created_at) VALUES ($ch, $seq, $by, $data, $v, $now);",
                [("$ch", channelId), ("$seq", next), ("$by", author), ("$data", data), ("$v", version), ("$now", now)]);
            foreach (var file in fileIds) run("INSERT OR IGNORE INTO wb_files (channel_id, file_id) VALUES ($ch, $file);", [("$ch", channelId), ("$file", file)]);
            return next;
        });
    }

    /// <summary>Batches after <paramref name="afterSeq"/>, oldest first, until about <paramref name="maxChars"/> of data (at least one).</summary>
    public (List<WbBatch> Batches, bool HasMore) Batches(long channelId, long afterSeq, int maxChars)
    {
        lock (_gate)
        {
            var list = new List<WbBatch>();
            var total = 0;
            using var cmd = Command("SELECT channel_id, seq, author, data, version, created_at FROM wb_batches WHERE channel_id = $ch AND seq > $after ORDER BY seq;",
                [("$ch", channelId), ("$after", afterSeq)]);
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var batch = ReadBatch(reader);
                if (list.Count > 0 && total + batch.Data.Length > maxChars) return (list, true);
                total += batch.Data.Length;
                list.Add(batch);
            }
            return (list, false);
        }
    }

    /// <summary>The oldest epoch version among the batches after the snapshot (encrypted boards), or null.</summary>
    public long? OldestBatchVersion(long channelId) =>
        Scalar("SELECT MIN(version) FROM wb_batches WHERE channel_id = $ch;", ("$ch", channelId)) is long v ? v : null;

    /// <summary>
    /// Replaces the snapshot with the board after <paramref name="seq"/> and deletes the batches it covers. Plain boards
    /// pass the files their objects refer to (the board keeps only those). False if the board changed meanwhile.
    /// </summary>
    public bool SaveBoardSnapshot(long channelId, string boardId, long seq, string data, string? by, long at, long? version, string[]? fileIds)
    {
        return InDocTransaction(run =>
        {
            // An equal seq re-seals the same board under a newer key (encrypted boards; the caller checks).
            if (run("SELECT snap_seq FROM wb_boards WHERE channel_id = $ch AND id = $id AND seq >= $seq;", [("$ch", channelId), ("$id", boardId), ("$seq", seq)]) is not long current
                || current > seq) return false;
            run("DELETE FROM wb_batches WHERE channel_id = $ch AND seq <= $seq;", [("$ch", channelId), ("$seq", seq)]);
            run("""
                UPDATE wb_boards SET snap_seq = $seq, snap_data = $data, snap_by = $by, snap_at = $at, snap_version = $v,
                    batch_count = (SELECT COUNT(*) FROM wb_batches WHERE channel_id = $ch),
                    batch_bytes = (SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) FROM wb_batches WHERE channel_id = $ch)
                WHERE channel_id = $ch;
                """, [("$ch", channelId), ("$seq", seq), ("$data", data), ("$by", by), ("$at", at), ("$v", version)]);
            if (fileIds is not null)
            {
                run("DELETE FROM wb_files WHERE channel_id = $ch;", [("$ch", channelId)]);
                foreach (var file in fileIds) run("INSERT OR IGNORE INTO wb_files (channel_id, file_id) VALUES ($ch, $file);", [("$ch", channelId), ("$file", file)]);
            }
            return true;
        });
    }

    /// <summary>Clears a board: its batches, snapshot and files go. With <paramref name="newId"/> it starts again empty, else it closes.</summary>
    public bool ClearBoard(long channelId, string boardId, string? newId, long now)
    {
        return InDocTransaction(run =>
        {
            if (run("SELECT 1 FROM wb_boards WHERE channel_id = $ch AND id = $id;", [("$ch", channelId), ("$id", boardId)]) is null) return false;
            run("DELETE FROM wb_batches WHERE channel_id = $ch;", [("$ch", channelId)]);
            run("DELETE FROM wb_files WHERE channel_id = $ch;", [("$ch", channelId)]);
            if (newId is null) run("DELETE FROM wb_boards WHERE channel_id = $ch;", [("$ch", channelId)]);
            else
            {
                run("""
                    UPDATE wb_boards SET id = $new, seq = 0, opened_by = NULL, opened_at = $now, snap_seq = 0, snap_data = NULL, snap_by = NULL,
                        snap_at = NULL, snap_version = NULL, batch_count = 0, batch_bytes = 0
                    WHERE channel_id = $ch;
                    """, [("$ch", channelId), ("$new", newId), ("$now", now)]);
            }
            return true;
        });
    }

    /// <summary>Uploads any board refers to (the unused-upload sweep keeps them).</summary>
    public HashSet<string> BoardFileIds() => Query("SELECT DISTINCT file_id FROM wb_files;", r => r.GetString(0)).ToHashSet();

    /// <summary>
    /// A deleted account that asked for its messages to go: its unfolded batches lose their author ("" = someone who left);
    /// the drawing stays on the board, like a docs page's text. Runs inside DeleteAccount.
    /// </summary>
    private const string BoardsForgetAuthor = """
        UPDATE wb_batches SET author = '' WHERE author = $k;
        UPDATE wb_boards SET opened_by = NULL WHERE opened_by = $k;
        UPDATE wb_boards SET snap_by = '' WHERE snap_by = $k;
        """;
}
