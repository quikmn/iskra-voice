using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

public sealed record Member(string AccountKey, string Name, string Role, long JoinedAt)
{
    /// <summary>Custom roles, highest first (see Store.Roles.cs).</summary>
    public long[] RoleIds { get; init; } = [];
    /// <summary>Everything the member's custom roles grant together.</summary>
    public Perm Perms { get; init; }
    /// <summary>Position of the member's highest custom role (0 = none).</summary>
    public int TopPosition { get; init; }
}
public sealed record Channel(long Id, string Name, string Kind, int Position, string ReadRole, string WriteRole)
{
    /// <summary>Per-role overrides (a thread carries its parent channel's).</summary>
    public ChannelOverride[] Overrides { get; init; } = [];
}
public sealed record Message(long Id, long ChannelId, string AuthorKey, string Text, long CreatedAt, long? EditedAt,
    string[] Attachments, long? ReplyTo);
public sealed record StoredFile(string Id, string Sha256, string Name, long Size, string Type, int? Width, int? Height, string Uploader, long CreatedAt);
public sealed record Invite(string Code, string CreatedBy, long CreatedAt, long? ExpiresAt, int? MaxUses, int Uses, string Role, bool Revoked);
public sealed record Ban(string AccountKey, string Reason, string BannedBy, long BannedAt);
public sealed record DirectMessage(long Id, string From, string To, string Envelope, long CreatedAt);

/// <summary>
/// SQLite storage for a world (iskra.db). One connection, and every statement runs under one lock,
/// so there is exactly one writer. WAL mode keeps the file consistent if the process dies mid-write.
/// </summary>
public sealed partial class Store : IDisposable
{
    private const int SchemaVersion = 3;

    private readonly SqliteConnection _db;
    private readonly Lock _gate = new();

    private Store(SqliteConnection db) => _db = db;

    public static Store Open(string path)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open();
        var store = new Store(db);
        store.Migrate();
        return store;
    }

    private void Migrate()
    {
        Exec("PRAGMA journal_mode = WAL;");
        Exec("PRAGMA foreign_keys = ON;");
        var version = Convert.ToInt32(Scalar("PRAGMA user_version;"));
        if (version > SchemaVersion)
            throw new InvalidDataException($"iskra.db schema v{version} is newer than this server (v{SchemaVersion}). Update iskra-server.");

        if (version < 1)
        {
            Exec("""
                CREATE TABLE members (
                    account_key TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    role        TEXT NOT NULL,
                    joined_at   INTEGER NOT NULL
                );
                CREATE TABLE channels (
                    id          INTEGER PRIMARY KEY,
                    name        TEXT NOT NULL,
                    kind        TEXT NOT NULL,
                    position    INTEGER NOT NULL,
                    read_role   TEXT NOT NULL,
                    write_role  TEXT NOT NULL,
                    created_at  INTEGER NOT NULL
                );
                CREATE TABLE messages (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                    author_key  TEXT NOT NULL,
                    text        TEXT NOT NULL,
                    created_at  INTEGER NOT NULL,
                    edited_at   INTEGER
                );
                CREATE INDEX messages_by_channel ON messages(channel_id, id);
                CREATE TABLE invites (
                    code        TEXT PRIMARY KEY,
                    created_by  TEXT NOT NULL,
                    created_at  INTEGER NOT NULL,
                    expires_at  INTEGER,
                    max_uses    INTEGER,
                    uses        INTEGER NOT NULL DEFAULT 0,
                    role        TEXT NOT NULL,
                    revoked     INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE bans (
                    account_key TEXT PRIMARY KEY,
                    reason      TEXT NOT NULL,
                    banned_by   TEXT NOT NULL,
                    banned_at   INTEGER NOT NULL
                );
                INSERT INTO channels (name, kind, position, read_role, write_role, created_at)
                VALUES ('general', 'text', 0, 'member', 'member', 0);
                PRAGMA user_version = 1;
                """);
        }

        if (version < 2)
        {
            Exec("""
                CREATE TABLE devices (
                    device_key  TEXT PRIMARY KEY,
                    account_key TEXT NOT NULL,
                    created     INTEGER NOT NULL,
                    sig         TEXT NOT NULL,
                    last_seen   INTEGER NOT NULL
                );
                CREATE INDEX devices_by_account ON devices(account_key);
                CREATE TABLE dms (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_key    TEXT NOT NULL,
                    to_key      TEXT NOT NULL,
                    envelope    TEXT NOT NULL,
                    created_at  INTEGER NOT NULL
                );
                CREATE INDEX dms_by_pair ON dms(from_key, to_key, id);
                CREATE INDEX dms_by_recipient ON dms(to_key, id);
                PRAGMA user_version = 2;
                """);
        }

        if (version < 3)
        {
            Exec("""
                CREATE TABLE files (
                    id          TEXT PRIMARY KEY,
                    sha256      TEXT NOT NULL,
                    name        TEXT NOT NULL,
                    size        INTEGER NOT NULL,
                    type        TEXT NOT NULL,
                    width       INTEGER,
                    height      INTEGER,
                    uploader    TEXT NOT NULL,
                    created_at  INTEGER NOT NULL
                );
                CREATE TABLE reactions (
                    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                    account_key TEXT NOT NULL,
                    emoji       TEXT NOT NULL,
                    created_at  INTEGER NOT NULL,
                    PRIMARY KEY (message_id, account_key, emoji)
                );
                ALTER TABLE messages ADD COLUMN attachments TEXT;
                ALTER TABLE messages ADD COLUMN reply_to INTEGER;
                PRAGMA user_version = 3;
                """);
        }

        // After v3, each feature adds a named migration to FeatureMigrations (append only, never edit a shipped one).
        // Named steps let features land independently without fighting over version numbers.
        Exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);");
        foreach (var (name, sql) in FeatureMigrations)
        {
            if (Scalar("SELECT 1 FROM migrations WHERE name = $n;", ("$n", name)) is not null) continue;
            lock (_gate)
            {
                using var tx = _db.BeginTransaction();
                using (var cmd = Command(sql, [])) { cmd.Transaction = tx; cmd.ExecuteNonQuery(); }
                using (var mark = Command("INSERT INTO migrations (name, applied_at) VALUES ($n, $t);",
                           [("$n", name), ("$t", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())]))
                {
                    mark.Transaction = tx;
                    mark.ExecuteNonQuery();
                }
                tx.Commit();
            }
        }
    }

    /// <summary>Named schema steps, applied once each, in order. Add new ones at the end.</summary>
    private static readonly (string Name, string Sql)[] FeatureMigrations =
    [
        ("bots-1", BotsMigration),
        ("polls-1", """
            CREATE TABLE polls (
                message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                question    TEXT NOT NULL,
                options     TEXT NOT NULL,
                multi       INTEGER NOT NULL,
                expires_at  INTEGER,
                closed_at   INTEGER
            );
            CREATE INDEX polls_open ON polls(expires_at) WHERE closed_at IS NULL AND expires_at IS NOT NULL;
            CREATE TABLE poll_votes (
                message_id  INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
                account_key TEXT NOT NULL,
                option      INTEGER NOT NULL,
                created_at  INTEGER NOT NULL,
                PRIMARY KEY (message_id, account_key, option)
            );
            """),
        ("emoji-1", """
            CREATE TABLE emojis (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                file_id     TEXT NOT NULL,
                created_by  TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            """),
        ("sounds-1", """
            CREATE TABLE sounds (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                emoji       TEXT,
                file_id     TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                created_by  TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            """),
        ("push-1", """
            CREATE TABLE push_subscriptions (
                device_key  TEXT PRIMARY KEY,
                account_key TEXT NOT NULL,
                endpoint    TEXT NOT NULL UNIQUE,
                p256dh      TEXT NOT NULL,
                auth        TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE INDEX push_by_account ON push_subscriptions(account_key);
            """),
        ("pins-1", PinsMigration),
        ("search-1", SearchMigration),
        ("threads-1", ThreadsMigration),
        ("identity-1", """
            ALTER TABLE devices ADD COLUMN name TEXT;
            ALTER TABLE devices ADD COLUMN platform TEXT;
            CREATE TABLE device_revocations (
                account_key TEXT NOT NULL,
                device_key  TEXT NOT NULL,
                revoked_at  INTEGER NOT NULL,
                sig         TEXT NOT NULL,
                PRIMARY KEY (account_key, device_key)
            );
            CREATE TABLE prekeys (
                device_key  TEXT PRIMARY KEY,
                prekey      TEXT NOT NULL,
                created     INTEGER NOT NULL,
                sig         TEXT NOT NULL
            );
            """),
        ("profiles-1", """
            CREATE TABLE profiles (
                account_key TEXT PRIMARY KEY,
                bio         TEXT,
                pronouns    TEXT,
                accent      TEXT,
                avatar_file TEXT
            );
            CREATE TABLE profile_pages (
                account_key TEXT PRIMARY KEY,
                page_id     TEXT NOT NULL UNIQUE,
                html        TEXT NOT NULL,
                sha256      TEXT NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE TABLE profile_options (
                name        TEXT PRIMARY KEY,
                value       TEXT NOT NULL
            );
            """),
        ("security-1", SecurityMigration),
        ("moderation-1", ModerationMigration),
        ("roles-1", RolesMigration),
    ];

    // ── Plumbing ─────────────────────────────────────────────────────────────

    private void Exec(string sql, params (string Name, object? Value)[] args)
    {
        lock (_gate)
        {
            using var cmd = Command(sql, args);
            cmd.ExecuteNonQuery();
        }
    }

    private object? Scalar(string sql, params (string Name, object? Value)[] args)
    {
        lock (_gate)
        {
            using var cmd = Command(sql, args);
            return cmd.ExecuteScalar();
        }
    }

    private List<T> Query<T>(string sql, Func<SqliteDataReader, T> map, params (string Name, object? Value)[] args)
    {
        lock (_gate)
        {
            using var cmd = Command(sql, args);
            using var reader = cmd.ExecuteReader();
            var rows = new List<T>();
            while (reader.Read()) rows.Add(map(reader));
            return rows;
        }
    }

    private SqliteCommand Command(string sql, (string Name, object? Value)[] args)
    {
        var cmd = _db.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd;
    }

    private static long? NullableLong(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetInt64(i);
    private static int? NullableInt(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetInt32(i);

    public void Dispose()
    {
        lock (_readerGate) _reader?.Dispose();
        _db.Dispose();
    }
}
