namespace Iskra.Server.Storage;

/// <summary>A server emoji; <see cref="External"/> ones were brought over from another server by a member (emoji.import) and aren't in the picker.</summary>
public sealed record CustomEmoji(string Id, string Name, string FileId, string CreatedBy, long CreatedAt, bool External = false);
public sealed record Sound(string Id, string Name, string? Emoji, string FileId, int DurationMs, string CreatedBy, long CreatedAt);

/// <summary>Server emoji (the server's own and external ones) and soundboard sounds. All point at an uploaded file.</summary>
public sealed partial class Store
{
    /// <summary>Emoji and stickers members bring over from other servers, kept with the bytes' hash so the same picture is stored once.</summary>
    private const string ExternalExpressionsMigration = """
        CREATE TABLE external_emojis (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            file_id     TEXT NOT NULL,
            sha256      TEXT NOT NULL,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX external_emojis_by_hash ON external_emojis(sha256);
        CREATE TABLE external_stickers (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            file_id     TEXT NOT NULL,
            sha256      TEXT NOT NULL,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX external_stickers_by_hash ON external_stickers(sha256);
        """;

    private const string EmojiColumns = "id, name, file_id, created_by, created_at";
    private const string SoundColumns = "id, name, emoji, file_id, duration_ms, created_by, created_at";

    private static CustomEmoji ReadEmoji(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4));

    private static CustomEmoji ReadExternalEmoji(Microsoft.Data.Sqlite.SqliteDataReader r) => ReadEmoji(r) with { External = true };

    // ── External emoji ───────────────────────────────────────────────────────

    public List<CustomEmoji> AllExternalEmojis() =>
        Query($"SELECT {EmojiColumns} FROM external_emojis ORDER BY created_at, id;", ReadExternalEmoji);

    public CustomEmoji? GetExternalEmoji(string id) =>
        Query($"SELECT {EmojiColumns} FROM external_emojis WHERE id = $id;", ReadExternalEmoji, ("$id", id)).FirstOrDefault();

    /// <summary>An emoji here (the server's own first, else an external one) whose picture has these exact bytes.</summary>
    public CustomEmoji? EmojiWithBytes(string sha256) =>
        Query($"SELECT e.id, e.name, e.file_id, e.created_by, e.created_at FROM emojis e JOIN files f ON f.id = e.file_id WHERE f.sha256 = $h ORDER BY e.created_at LIMIT 1;", ReadEmoji, ("$h", sha256)).FirstOrDefault()
        ?? Query($"SELECT {EmojiColumns} FROM external_emojis WHERE sha256 = $h ORDER BY created_at LIMIT 1;", ReadExternalEmoji, ("$h", sha256)).FirstOrDefault();

    public int ExternalEmojiCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM external_emojis;"));

    public void AddExternalEmoji(CustomEmoji e, string sha256) =>
        Exec($"INSERT INTO external_emojis ({EmojiColumns}, sha256) VALUES ($id, $n, $f, $by, $at, $h);",
            ("$id", e.Id), ("$n", e.Name), ("$f", e.FileId), ("$by", e.CreatedBy), ("$at", e.CreatedAt), ("$h", sha256));

    public void DeleteExternalEmoji(string id) => Exec("DELETE FROM external_emojis WHERE id = $id;", ("$id", id));

    /// <summary>Forgets the oldest external emoji beyond <paramref name="keep"/> (their messages then show :name:).</summary>
    public void TrimExternalEmojis(int keep) =>
        Exec("DELETE FROM external_emojis WHERE id NOT IN (SELECT id FROM external_emojis ORDER BY created_at DESC, id DESC LIMIT $keep);", ("$keep", keep));

    private static Sound ReadSound(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.GetInt32(4), r.GetString(5), r.GetInt64(6));

    public List<CustomEmoji> AllEmojis() => Query($"SELECT {EmojiColumns} FROM emojis ORDER BY name;", ReadEmoji);

    /// <summary>The server's own emoji with this id, else an external one.</summary>
    public CustomEmoji? GetEmoji(string id) =>
        Query($"SELECT {EmojiColumns} FROM emojis WHERE id = $id;", ReadEmoji, ("$id", id)).FirstOrDefault() ?? GetExternalEmoji(id);

    public bool EmojiNameTaken(string name, string? exceptId = null) =>
        Scalar("SELECT 1 FROM emojis WHERE name = $n AND id IS NOT $id;", ("$n", name), ("$id", exceptId)) is not null;

    public int EmojiCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM emojis;"));

    public void AddEmoji(CustomEmoji e) =>
        Exec($"INSERT INTO emojis ({EmojiColumns}) VALUES ($id, $n, $f, $by, $at);",
            ("$id", e.Id), ("$n", e.Name), ("$f", e.FileId), ("$by", e.CreatedBy), ("$at", e.CreatedAt));

    public void RenameEmoji(string id, string name) => Exec("UPDATE emojis SET name = $n WHERE id = $id;", ("$id", id), ("$n", name));

    public void DeleteEmoji(string id) => Exec("DELETE FROM emojis WHERE id = $id;", ("$id", id));

    // ── Sounds ───────────────────────────────────────────────────────────────

    public List<Sound> AllSounds() => Query($"SELECT {SoundColumns} FROM sounds ORDER BY created_at, id;", ReadSound);

    public Sound? GetSound(string id) =>
        Query($"SELECT {SoundColumns} FROM sounds WHERE id = $id;", ReadSound, ("$id", id)).FirstOrDefault();

    public int SoundCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM sounds;"));

    public void AddSound(Sound s) =>
        Exec($"INSERT INTO sounds ({SoundColumns}) VALUES ($id, $n, $e, $f, $d, $by, $at);",
            ("$id", s.Id), ("$n", s.Name), ("$e", s.Emoji), ("$f", s.FileId), ("$d", s.DurationMs), ("$by", s.CreatedBy), ("$at", s.CreatedAt));

    public void UpdateSound(string id, string name, string? emoji) =>
        Exec("UPDATE sounds SET name = $n, emoji = $e WHERE id = $id;", ("$id", id), ("$n", name), ("$e", emoji));

    public void DeleteSound(string id) => Exec("DELETE FROM sounds WHERE id = $id;", ("$id", id));
}
