namespace Iskra.Server.Storage;

public sealed record Sticker(string Id, string Name, string FileId, string CreatedBy, long CreatedAt);

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

    public Sticker? GetSticker(string id) =>
        Query($"SELECT {StickerColumns} FROM stickers WHERE id = $id;", ReadSticker, ("$id", id)).FirstOrDefault();

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
