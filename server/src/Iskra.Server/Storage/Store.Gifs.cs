namespace Iskra.Server.Storage;

/// <summary>A GIF sent in a message: the provider's media addresses (shown through this server's proxy) and its size.</summary>
public sealed record SentGif(string Provider, string Id, string Title, string Url, string Preview, int Width, int Height);

public sealed partial class Store
{
    private const string GifsMigration = """
        CREATE TABLE gif_settings (
            name        TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        );
        CREATE TABLE message_gifs (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            provider    TEXT NOT NULL,
            gif_id      TEXT NOT NULL,
            title       TEXT NOT NULL,
            url         TEXT NOT NULL,
            preview     TEXT NOT NULL,
            width       INTEGER NOT NULL,
            height      INTEGER NOT NULL
        );
        """;

    /// <summary>Server-side only: the provider key never leaves the server.</summary>
    public string? GetGifSetting(string name) =>
        Scalar("SELECT value FROM gif_settings WHERE name = $n;", ("$n", name)) as string;

    public void SetGifSetting(string name, string? value)
    {
        if (value is null) Exec("DELETE FROM gif_settings WHERE name = $n;", ("$n", name));
        else Exec("INSERT INTO gif_settings (name, value) VALUES ($n, $v) ON CONFLICT(name) DO UPDATE SET value = excluded.value;", ("$n", name), ("$v", value));
    }

    public void SetMessageGif(long messageId, SentGif gif) =>
        Exec("""
            INSERT OR REPLACE INTO message_gifs (message_id, provider, gif_id, title, url, preview, width, height)
            VALUES ($m, $p, $id, $t, $u, $pv, $w, $h);
            """, ("$m", messageId), ("$p", gif.Provider), ("$id", gif.Id), ("$t", gif.Title), ("$u", gif.Url), ("$pv", gif.Preview),
            ("$w", gif.Width), ("$h", gif.Height));

    public SentGif? GetMessageGif(long messageId) =>
        Query("SELECT provider, gif_id, title, url, preview, width, height FROM message_gifs WHERE message_id = $m;",
            r => new SentGif(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt32(5), r.GetInt32(6)),
            ("$m", messageId)).FirstOrDefault();
}
