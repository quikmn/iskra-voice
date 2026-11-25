using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>
/// A photo or video in a photos channel. In an encrypted channel the server keeps only the ciphertext files, their
/// sizes, who added them and when; everything else (name, type, dimensions, date taken, caption, file keys) is inside
/// <see cref="Envelope"/>, sealed under the channel key of <see cref="Version"/>.
/// </summary>
public sealed record Photo(long Id, long ChannelId, long? AlbumId, string FileId, string? ThumbId, string Uploader, long CreatedAt,
    long? TakenAt, string Kind, int Width, int Height, long? Duration, long Size, string Caption, string? Envelope, long? Version, long? ThreadId)
{
    /// <summary>What sorting by date uses: the date taken, else when it was added.</summary>
    public long SortAt => TakenAt ?? CreatedAt;
}

/// <summary>An album in a photos channel. <see cref="Name"/> is empty in an encrypted channel (it is in <see cref="Envelope"/>).</summary>
public sealed record PhotoAlbum(long Id, long ChannelId, string Name, long? CoverId, string CreatedBy, long CreatedAt, int Count, string? Envelope, long? Version);

/// <summary>What a photos channel holds and how much it may hold (<see cref="CapBytes"/> null: no cap).</summary>
public sealed record PhotoUsage(long Bytes, int Count, long? CapBytes);

/// <summary>What <see cref="Store.AddPhoto"/> takes.</summary>
public sealed record NewPhoto(string FileId, string? ThumbId, long? TakenAt, string Kind, int Width, int Height, long? Duration, long Size,
    string Caption, string? Envelope, long? Version);

/// <summary>Photos channels: photos, albums, reactions and the storage cap. Comments are a thread per photo, made on first use.</summary>
public sealed partial class Store
{
    private const string PhotosMigration = """
        CREATE TABLE photo_albums (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            cover_id    INTEGER,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            envelope    TEXT,
            version     INTEGER
        );
        CREATE INDEX photo_albums_by_channel ON photo_albums(channel_id);
        CREATE TABLE photos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            album_id    INTEGER REFERENCES photo_albums(id) ON DELETE SET NULL,
            file_id     TEXT NOT NULL,
            thumb_id    TEXT,
            uploader    TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            taken_at    INTEGER,
            kind        TEXT NOT NULL,
            width       INTEGER NOT NULL DEFAULT 0,
            height      INTEGER NOT NULL DEFAULT 0,
            duration    INTEGER,
            size        INTEGER NOT NULL,
            caption     TEXT NOT NULL DEFAULT '',
            envelope    TEXT,
            version     INTEGER,
            thread_id   INTEGER REFERENCES channels(id) ON DELETE SET NULL
        );
        CREATE INDEX photos_by_channel ON photos(channel_id, id);
        CREATE INDEX photos_by_album ON photos(album_id);
        CREATE INDEX photos_by_file ON photos(file_id);
        CREATE INDEX photos_by_uploader ON photos(uploader);
        CREATE TABLE photo_reactions (
            photo_id    INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            account_key TEXT NOT NULL,
            emoji       TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (photo_id, account_key, emoji)
        );
        CREATE TABLE photo_caps (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            max_bytes   INTEGER NOT NULL
        );
        """;

    private const string PhotoColumns =
        "id, channel_id, album_id, file_id, thumb_id, uploader, created_at, taken_at, kind, width, height, duration, size, caption, envelope, version, thread_id";

    private static Photo ReadPhoto(SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), NullableLong(r, 2), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4), r.GetString(5), r.GetInt64(6),
            NullableLong(r, 7), r.GetString(8), r.GetInt32(9), r.GetInt32(10), NullableLong(r, 11), r.GetInt64(12), r.GetString(13),
            r.IsDBNull(14) ? null : r.GetString(14), NullableLong(r, 15), NullableLong(r, 16));

    private const string AlbumSelect = """
        SELECT a.id, a.channel_id, a.name, a.cover_id, a.created_by, a.created_at,
            (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id), a.envelope, a.version
        FROM photo_albums a
        """;

    private static PhotoAlbum ReadAlbum(SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), NullableLong(r, 3), r.GetString(4), r.GetInt64(5), r.GetInt32(6),
            r.IsDBNull(7) ? null : r.GetString(7), NullableLong(r, 8));

    // ── Photos ───────────────────────────────────────────────────────────────

    public Photo? GetPhoto(long id) => Query($"SELECT {PhotoColumns} FROM photos WHERE id = $id;", ReadPhoto, ("$id", id)).FirstOrDefault();

    public List<Photo> GetPhotos(IReadOnlyCollection<long> ids) =>
        ids.Count == 0 ? [] : Query($"SELECT {PhotoColumns} FROM photos WHERE id IN (SELECT value FROM json_each($ids)) ORDER BY id;",
            ReadPhoto, ("$ids", JsonSerializer.Serialize(ids)));

    /// <summary>A channel's photos in the order they were added, after <paramref name="after"/>.</summary>
    public List<Photo> Photos(long channelId, long after, int limit) =>
        Query($"SELECT {PhotoColumns} FROM photos WHERE channel_id = $c AND id > $after ORDER BY id LIMIT $limit;",
            ReadPhoto, ("$c", channelId), ("$after", after), ("$limit", limit));

    /// <summary>Every photo of an album (null: the ones in no album; <paramref name="all"/>: the whole channel), oldest first by date.</summary>
    public List<Photo> PhotosForZip(long channelId, long? albumId, bool all) =>
        Query($"""
            SELECT {PhotoColumns} FROM photos WHERE channel_id = $c AND ($all = 1 OR album_id IS $a)
            ORDER BY COALESCE(taken_at, created_at), id;
            """, ReadPhoto, ("$c", channelId), ("$a", albumId), ("$all", all ? 1 : 0));

    /// <summary>The photo that uses this file (as the picture or its thumbnail), if any.</summary>
    public bool PhotoUsesFile(string fileId) =>
        Scalar("SELECT 1 FROM photos WHERE file_id = $f OR thumb_id = $f LIMIT 1;", ("$f", fileId)) is not null;

    public PhotoUsage PhotoUsage(long channelId)
    {
        var (bytes, count) = Query("SELECT COALESCE(SUM(size), 0), COUNT(*) FROM photos WHERE channel_id = $c;",
            r => (r.GetInt64(0), r.GetInt32(1)), ("$c", channelId)).Single();
        var cap = Scalar("SELECT max_bytes FROM photo_caps WHERE channel_id = $c;", ("$c", channelId));
        return new PhotoUsage(bytes, count, cap is null or DBNull ? null : Convert.ToInt64(cap));
    }

    public void SetPhotoCap(long channelId, long? maxBytes)
    {
        if (maxBytes is null) Exec("DELETE FROM photo_caps WHERE channel_id = $c;", ("$c", channelId));
        else
            Exec("""
                INSERT INTO photo_caps (channel_id, max_bytes) VALUES ($c, $m)
                ON CONFLICT(channel_id) DO UPDATE SET max_bytes = excluded.max_bytes;
                """, ("$c", channelId), ("$m", maxBytes));
    }

    /// <summary>
    /// Adds photos in one transaction if they fit under the channel's cap and <paramref name="maxCount"/>. Returns their
    /// ids, or null when they don't fit (nothing is added).
    /// </summary>
    public List<long>? AddPhotos(long channelId, long? albumId, string uploader, IReadOnlyList<NewPhoto> items, long now, int maxCount)
    {
        lock (_gate)
        {
            var usage = PhotoUsage(channelId);
            if (usage.Count + items.Count > maxCount) return null;
            if (usage.CapBytes is { } cap && usage.Bytes + items.Sum(i => i.Size) > cap) return null;
            using var tx = _db.BeginTransaction();
            var ids = new List<long>();
            foreach (var p in items)
            {
                using var cmd = Command("""
                    INSERT INTO photos (channel_id, album_id, file_id, thumb_id, uploader, created_at, taken_at, kind, width, height, duration, size, caption, envelope, version)
                    VALUES ($c, $a, $f, $t, $u, $now, $taken, $kind, $w, $h, $d, $size, $caption, $env, $v) RETURNING id;
                    """, [("$c", channelId), ("$a", albumId), ("$f", p.FileId), ("$t", p.ThumbId), ("$u", uploader), ("$now", now), ("$taken", p.TakenAt),
                    ("$kind", p.Kind), ("$w", p.Width), ("$h", p.Height), ("$d", p.Duration), ("$size", p.Size), ("$caption", p.Caption),
                    ("$env", p.Envelope), ("$v", p.Version)]);
                cmd.Transaction = tx;
                ids.Add(Convert.ToInt64(cmd.ExecuteScalar()));
            }
            tx.Commit();
            return ids;
        }
    }

    public void UpdatePhoto(long id, string? caption, long? takenAt, bool clearTaken, string? envelope, long? version)
    {
        lock (_gate)
        {
            if (caption is not null) Exec("UPDATE photos SET caption = $t WHERE id = $id;", ("$id", id), ("$t", caption));
            if (takenAt is not null || clearTaken) Exec("UPDATE photos SET taken_at = $t WHERE id = $id;", ("$id", id), ("$t", clearTaken ? null : takenAt));
            if (envelope is not null) Exec("UPDATE photos SET envelope = $e, version = $v WHERE id = $id;", ("$id", id), ("$e", envelope), ("$v", version));
        }
    }

    public void MovePhotos(IReadOnlyCollection<long> ids, long? albumId) =>
        Exec("UPDATE photos SET album_id = $a WHERE id IN (SELECT value FROM json_each($ids));", ("$a", albumId), ("$ids", JsonSerializer.Serialize(ids)));

    /// <summary>Deletes photos (their reactions go with them; albums that showed one as their cover fall back to their first photo).</summary>
    public void DeletePhotos(IReadOnlyCollection<long> ids)
    {
        if (ids.Count == 0) return;
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            var list = ("$ids", (object?)JsonSerializer.Serialize(ids));
            Run(tx, "UPDATE photo_albums SET cover_id = NULL WHERE cover_id IN (SELECT value FROM json_each($ids));", list);
            Run(tx, "DELETE FROM photos WHERE id IN (SELECT value FROM json_each($ids));", list);
            tx.Commit();
        }
    }

    public void SetPhotoThread(long id, long threadId) => Exec("UPDATE photos SET thread_id = $t WHERE id = $id;", ("$id", id), ("$t", threadId));

    /// <summary>The photo's comment thread: a thread with no first message (its root is minus its own id), linked to the photo.</summary>
    public ThreadInfo CreatePhotoThread(Channel parent, long photoId, string name, string by, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            long id;
            using (var cmd = Command($"""
                INSERT INTO channels (id, name, kind, position, read_role, write_role, created_at, parent_id)
                VALUES ({NextId("channels")}, $name, 'thread', 0, $read, $write, $now, $parent) RETURNING id;
                """, [("$name", name), ("$read", parent.ReadRole), ("$write", parent.WriteRole), ("$now", now), ("$parent", parent.Id)]))
            {
                cmd.Transaction = tx;
                id = Convert.ToInt64(cmd.ExecuteScalar());
            }
            Run(tx, "INSERT INTO threads (channel_id, root_id, created_by, created_at) VALUES ($id, $root, $by, $now);",
                ("$id", id), ("$root", -id), ("$by", by), ("$now", now));
            Run(tx, "UPDATE photos SET thread_id = $t WHERE id = $id;", ("$id", photoId), ("$t", id));
            tx.Commit();
            return new ThreadInfo(id, parent.Id, -id, name, by, now, 0, null);
        }
    }

    public Photo? PhotoForThread(long threadId) =>
        Query($"SELECT {PhotoColumns} FROM photos WHERE thread_id = $t;", ReadPhoto, ("$t", threadId)).FirstOrDefault();

    /// <summary>photo id → how many comments its thread has (photos without a thread are left out).</summary>
    public Dictionary<long, int> PhotoCommentCounts(IReadOnlyCollection<long> photoIds) =>
        photoIds.Count == 0 ? [] : Query("""
            SELECT p.id, (SELECT COUNT(*) FROM messages m WHERE m.channel_id = p.thread_id) FROM photos p
            WHERE p.thread_id IS NOT NULL AND p.id IN (SELECT value FROM json_each($ids));
            """, r => (Id: r.GetInt64(0), Count: r.GetInt32(1)), ("$ids", JsonSerializer.Serialize(photoIds))).ToDictionary(x => x.Id, x => x.Count);

    // ── Reactions ────────────────────────────────────────────────────────────

    public void SetPhotoReaction(long photoId, string accountKey, string emoji, bool on, long now)
    {
        if (on)
            Exec("INSERT OR IGNORE INTO photo_reactions (photo_id, account_key, emoji, created_at) VALUES ($p, $a, $e, $now);",
                ("$p", photoId), ("$a", accountKey), ("$e", emoji), ("$now", now));
        else
            Exec("DELETE FROM photo_reactions WHERE photo_id = $p AND account_key = $a AND emoji = $e;", ("$p", photoId), ("$a", accountKey), ("$e", emoji));
    }

    public int DistinctPhotoReactions(long photoId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(DISTINCT emoji) FROM photo_reactions WHERE photo_id = $p;", ("$p", photoId)));

    public bool HasPhotoReaction(long photoId, string emoji) =>
        Scalar("SELECT 1 FROM photo_reactions WHERE photo_id = $p AND emoji = $e LIMIT 1;", ("$p", photoId), ("$e", emoji)) is not null;

    /// <summary>photo id → emoji → who reacted, in the order the emoji were first used.</summary>
    public Dictionary<long, List<(string Emoji, List<string> Accounts)>> PhotoReactions(IReadOnlyCollection<long> photoIds) =>
        photoIds.Count == 0 ? [] : Query("""
            SELECT photo_id, emoji, account_key FROM photo_reactions WHERE photo_id IN (SELECT value FROM json_each($ids)) ORDER BY created_at, rowid;
            """, r => (Photo: r.GetInt64(0), Emoji: r.GetString(1), Account: r.GetString(2)), ("$ids", JsonSerializer.Serialize(photoIds)))
            .GroupBy(x => x.Photo)
            .ToDictionary(g => g.Key, g => g.GroupBy(x => x.Emoji).Select(e => (e.Key, e.Select(x => x.Account).ToList())).ToList());

    // ── Albums ───────────────────────────────────────────────────────────────

    public PhotoAlbum? GetPhotoAlbum(long id) => Query($"{AlbumSelect} WHERE a.id = $id;", ReadAlbum, ("$id", id)).FirstOrDefault();

    public List<PhotoAlbum> PhotoAlbums(long channelId) => Query($"{AlbumSelect} WHERE a.channel_id = $c ORDER BY a.id;", ReadAlbum, ("$c", channelId));

    public int PhotoAlbumCount(long channelId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM photo_albums WHERE channel_id = $c;", ("$c", channelId)));

    public long CreatePhotoAlbum(long channelId, string name, string by, long now, string? envelope, long? version) =>
        Convert.ToInt64(Scalar("""
            INSERT INTO photo_albums (channel_id, name, created_by, created_at, envelope, version) VALUES ($c, $n, $by, $now, $e, $v) RETURNING id;
            """, ("$c", channelId), ("$n", name), ("$by", by), ("$now", now), ("$e", envelope), ("$v", version)));

    public void UpdatePhotoAlbum(long id, string? name, string? envelope, long? version, long? coverId, bool clearCover)
    {
        lock (_gate)
        {
            if (name is not null) Exec("UPDATE photo_albums SET name = $n WHERE id = $id;", ("$id", id), ("$n", name));
            if (envelope is not null) Exec("UPDATE photo_albums SET envelope = $e, version = $v WHERE id = $id;", ("$id", id), ("$e", envelope), ("$v", version));
            if (coverId is not null || clearCover) Exec("UPDATE photo_albums SET cover_id = $c WHERE id = $id;", ("$id", id), ("$c", clearCover ? null : coverId));
        }
    }

    /// <summary>Deletes an album; its photos stay in the channel without an album.</summary>
    public void DeletePhotoAlbum(long id) => Exec("DELETE FROM photo_albums WHERE id = $id;", ("$id", id));

    // ── Accounts and files ───────────────────────────────────────────────────

    /// <summary>
    /// A deleted account: its reactions go. With its messages, its photos go too (the files are swept as unused);
    /// otherwise they stay without a name, like its messages. Albums stay (they are shared) without who made them.
    /// Runs inside DeleteAccount.
    /// </summary>
    private const string PhotosForgetAccount = """
        DELETE FROM photo_reactions WHERE account_key = $k;
        UPDATE photo_albums SET created_by = '' WHERE created_by = $k;
        """;

    private const string PhotosDeleteOfAccount = """
        UPDATE photo_albums SET cover_id = NULL WHERE cover_id IN (SELECT id FROM photos WHERE uploader = $k);
        DELETE FROM photos WHERE uploader = $k;
        """;
}
