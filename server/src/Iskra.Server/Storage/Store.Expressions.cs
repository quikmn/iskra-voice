namespace Iskra.Server.Storage;

public sealed record CustomEmoji(string Id, string Name, string FileId, string CreatedBy, long CreatedAt);
public sealed record Sound(string Id, string Name, string? Emoji, string FileId, int DurationMs, string CreatedBy, long CreatedAt);

/// <summary>Server emoji and soundboard sounds. Both point at an uploaded file.</summary>
public sealed partial class Store
{
    private const string EmojiColumns = "id, name, file_id, created_by, created_at";
    private const string SoundColumns = "id, name, emoji, file_id, duration_ms, created_by, created_at";

    private static CustomEmoji ReadEmoji(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4));

    private static Sound ReadSound(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.GetInt32(4), r.GetString(5), r.GetInt64(6));

    public List<CustomEmoji> AllEmojis() => Query($"SELECT {EmojiColumns} FROM emojis ORDER BY name;", ReadEmoji);

    public CustomEmoji? GetEmoji(string id) =>
        Query($"SELECT {EmojiColumns} FROM emojis WHERE id = $id;", ReadEmoji, ("$id", id)).FirstOrDefault();

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
