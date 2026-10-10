using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

public sealed record Member(string AccountKey, string Name, string Role, long JoinedAt);

/// <summary>
/// SQLite storage for a world (iskra.db). All writes go through one lock so there is a single writer;
/// WAL mode keeps reads from blocking.
/// </summary>
public sealed class Store : IDisposable
{
    private const int SchemaVersion = 1;

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
                PRAGMA user_version = 1;
                """);
        }
    }

    /// <summary>Adds the member on first sight; afterwards keeps their role and updates their display name.</summary>
    public Member UpsertMember(string accountKey, string name, string defaultRole, long now)
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = """
                INSERT INTO members (account_key, name, role, joined_at) VALUES ($key, $name, $role, $now)
                ON CONFLICT(account_key) DO UPDATE SET name = excluded.name
                RETURNING account_key, name, role, joined_at;
                """;
            cmd.Parameters.AddWithValue("$key", accountKey);
            cmd.Parameters.AddWithValue("$name", name);
            cmd.Parameters.AddWithValue("$role", defaultRole);
            cmd.Parameters.AddWithValue("$now", now);
            using var reader = cmd.ExecuteReader();
            reader.Read();
            return new Member(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetInt64(3));
        }
    }

    public int CountMembers() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM members;"));

    public Member? GetMember(string accountKey)
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "SELECT account_key, name, role, joined_at FROM members WHERE account_key = $key;";
            cmd.Parameters.AddWithValue("$key", accountKey);
            using var reader = cmd.ExecuteReader();
            return reader.Read()
                ? new Member(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetInt64(3))
                : null;
        }
    }

    private void Exec(string sql)
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }
    }

    private object? Scalar(string sql)
    {
        lock (_gate)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = sql;
            return cmd.ExecuteScalar();
        }
    }

    public void Dispose() => _db.Dispose();
}
