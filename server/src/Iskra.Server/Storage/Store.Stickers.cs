namespace Iskra.Server.Storage;

/// <summary>A server sticker; <see cref="External"/> ones were brought over from another server by a member (sticker.import) and aren't in the picker.</summary>
public sealed record Sticker(string Id, string Name, string FileId, string CreatedBy, long CreatedAt, bool External = false);

public sealed partial class Store
{
    private const string StickersMigration = """
        CREATE TABLE stickers (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            file_id     TEXT NOT NULL,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE message_stickers (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            sticker_id  TEXT NOT NULL,
            name        TEXT NOT NULL
        );
        """;

    private const string StickerColumns = "id, name, file_id, created_by, created_at";

    private static Sticker ReadSticker(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4));

    public List<Sticker> AllStickers() => Query($"SELECT {StickerColumns} FROM stickers ORDER BY created_at, id;", ReadSticker);

    /// <summary>The server's own sticker with this id, else an external one.</summary>
    public Sticker? GetSticker(string id) =>
        Query($"SELECT {StickerColumns} FROM stickers WHERE id = $id;", ReadSticker, ("$id", id)).FirstOrDefault() ?? GetExternalSticker(id);

    // ── External stickers ────────────────────────────────────────────────────

    private static Sticker ReadExternalSticker(Microsoft.Data.Sqlite.SqliteDataReader r) => ReadSticker(r) with { External = true };

    public Sticker? GetExternalSticker(string id) =>
        Query($"SELECT {StickerColumns} FROM external_stickers WHERE id = $id;", ReadExternalSticker, ("$id", id)).FirstOrDefault();

    /// <summary>A sticker here (the server's own first, else an external one) whose picture has these exact bytes.</summary>
    public Sticker? StickerWithBytes(string sha256) =>
        Query("SELECT s.id, s.name, s.file_id, s.created_by, s.created_at FROM stickers s JOIN files f ON f.id = s.file_id WHERE f.sha256 = $h ORDER BY s.created_at LIMIT 1;", ReadSticker, ("$h", sha256)).FirstOrDefault()
        ?? Query($"SELECT {StickerColumns} FROM external_stickers WHERE sha256 = $h ORDER BY created_at LIMIT 1;", ReadExternalSticker, ("$h", sha256)).FirstOrDefault();

    public void AddExternalSticker(Sticker s, string sha256) =>
        Exec($"INSERT INTO external_stickers ({StickerColumns}, sha256) VALUES ($id, $n, $f, $by, $at, $h);",
            ("$id", s.Id), ("$n", s.Name), ("$f", s.FileId), ("$by", s.CreatedBy), ("$at", s.CreatedAt), ("$h", sha256));

    public void DeleteExternalSticker(string id) => Exec("DELETE FROM external_stickers WHERE id = $id;", ("$id", id));

    /// <summary>Forgets the oldest external stickers beyond <paramref name="keep"/> (their messages then show the name).</summary>
    public void TrimExternalStickers(int keep) =>
        Exec("DELETE FROM external_stickers WHERE id NOT IN (SELECT id FROM external_stickers ORDER BY created_at DESC, id DESC LIMIT $keep);", ("$keep", keep));

    public int StickerCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM stickers;"));

    public void AddSticker(Sticker s) =>
        Exec($"INSERT INTO stickers ({StickerColumns}) VALUES ($id, $n, $f, $by, $at);",
            ("$id", s.Id), ("$n", s.Name), ("$f", s.FileId), ("$by", s.CreatedBy), ("$at", s.CreatedAt));

    public void RenameSticker(string id, string name) => Exec("UPDATE stickers SET name = $n WHERE id = $id;", ("$id", id), ("$n", name));

    public void DeleteSticker(string id) => Exec("DELETE FROM stickers WHERE id = $id;", ("$id", id));

    /// <summary>The sticker a message carries, with its name when sent (the sticker may be gone since).</summary>
    public void SetMessageSticker(long messageId, Sticker sticker) =>
        Exec("INSERT OR REPLACE INTO message_stickers (message_id, sticker_id, name) VALUES ($m, $s, $n);",
            ("$m", messageId), ("$s", sticker.Id), ("$n", sticker.Name));

    public (string StickerId, string Name)? GetMessageSticker(long messageId) =>
        Query("SELECT sticker_id, name FROM message_stickers WHERE message_id = $m;",
            r => ((string, string)?)(r.GetString(0), r.GetString(1)), ("$m", messageId)).FirstOrDefault();
}
