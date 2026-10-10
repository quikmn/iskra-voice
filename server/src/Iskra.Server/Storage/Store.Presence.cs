namespace Iskra.Server.Storage;

/// <summary>
/// The status an account chose (online, idle, dnd or invisible) and its custom status. Kept while the account is
/// offline, so "do not disturb" keeps holding back pushes. <see cref="UpdatedAt"/> is the client's clock, so the
/// newest choice wins when several devices (or servers) disagree.
/// </summary>
public sealed record PresenceRecord(string Status, string? Emoji, string? Text, long? ExpiresAt, long UpdatedAt);

public sealed partial class Store
{
    private const string PresenceMigration = """
        CREATE TABLE presence (
            account_key TEXT PRIMARY KEY,
            status      TEXT NOT NULL,
            emoji       TEXT,
            text        TEXT,
            expires_at  INTEGER,
            updated_at  INTEGER NOT NULL
        );
        """;

    public PresenceRecord? GetPresence(string accountKey) =>
        Query("SELECT status, emoji, text, expires_at, updated_at FROM presence WHERE account_key = $key;",
            r => new PresenceRecord(r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2),
                NullableLong(r, 3), r.GetInt64(4)),
            ("$key", accountKey)).FirstOrDefault();

    /// <summary>Stores the presence unless a newer one is already there. Returns what is stored afterwards.</summary>
    public PresenceRecord SetPresence(string accountKey, PresenceRecord presence)
    {
        Exec("""
            INSERT INTO presence (account_key, status, emoji, text, expires_at, updated_at) VALUES ($key, $s, $e, $t, $x, $u)
            ON CONFLICT(account_key) DO UPDATE SET status = excluded.status, emoji = excluded.emoji, text = excluded.text,
                expires_at = excluded.expires_at, updated_at = excluded.updated_at
            WHERE excluded.updated_at >= presence.updated_at;
            """, ("$key", accountKey), ("$s", presence.Status), ("$e", presence.Emoji), ("$t", presence.Text),
            ("$x", presence.ExpiresAt), ("$u", presence.UpdatedAt));
        return GetPresence(accountKey)!;
    }
}
