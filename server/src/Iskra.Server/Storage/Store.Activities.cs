namespace Iskra.Server.Storage;

/// <summary>A server-added activity (ActivitiesFeature): its manifest, and whether it's on.</summary>
public sealed record StoredActivity(
    string Id, string Name, string Description, string? Icon, int MinPlayers, int MaxPlayers, string Version,
    long Size, int Files, bool Enabled, string AddedBy, long AddedAt);

/// <summary>One file of an activity's bundle.</summary>
public sealed record ActivityFile(string Path, string Type, byte[] Data);

/// <summary>Activities: bundles admins added (stored here, so backups carry them) and where activities are allowed.</summary>
public sealed partial class Store
{
    private const string ActivitiesMigration = """
        CREATE TABLE activities (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL,
            icon         TEXT,
            min_players  INTEGER NOT NULL,
            max_players  INTEGER NOT NULL,
            version      TEXT NOT NULL,
            size         INTEGER NOT NULL,
            files        INTEGER NOT NULL,
            enabled      INTEGER NOT NULL DEFAULT 1,
            added_by     TEXT NOT NULL,
            added_at     INTEGER NOT NULL
        );
        CREATE TABLE activity_files (
            activity_id  TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
            path         TEXT NOT NULL,
            type         TEXT NOT NULL,
            data         BLOB NOT NULL,
            PRIMARY KEY (activity_id, path)
        );
        CREATE TABLE activity_builtins_off (
            id  TEXT PRIMARY KEY
        );
        CREATE TABLE activity_off (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE
        );
        CREATE TABLE activity_settings (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            start_role  TEXT NOT NULL
        );
        """;

    private const string ActivityColumns = "id, name, description, icon, min_players, max_players, version, size, files, enabled, added_by, added_at";

    private static StoredActivity ReadActivity(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt32(4), r.GetInt32(5),
            r.GetString(6), r.GetInt64(7), r.GetInt32(8), r.GetInt64(9) != 0, r.GetString(10), r.GetInt64(11));

    public List<StoredActivity> Activities() =>
        Query($"SELECT {ActivityColumns} FROM activities ORDER BY added_at, id;", ReadActivity);

    public StoredActivity? GetActivity(string id) =>
        Query($"SELECT {ActivityColumns} FROM activities WHERE id = $id;", ReadActivity, ("$id", id)).FirstOrDefault();

    public int ActivityCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM activities;"));

    /// <summary>Adds an activity and all of its files in one transaction.</summary>
    public void AddActivity(StoredActivity activity, IReadOnlyList<ActivityFile> files)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            using (var insert = Command($"""
                INSERT INTO activities ({ActivityColumns}) VALUES ($id, $name, $desc, $icon, $min, $max, $ver, $size, $files, $on, $by, $at);
                """, [("$id", activity.Id), ("$name", activity.Name), ("$desc", activity.Description), ("$icon", activity.Icon),
                    ("$min", activity.MinPlayers), ("$max", activity.MaxPlayers), ("$ver", activity.Version), ("$size", activity.Size),
                    ("$files", activity.Files), ("$on", activity.Enabled ? 1 : 0), ("$by", activity.AddedBy), ("$at", activity.AddedAt)]))
            {
                insert.Transaction = tx;
                insert.ExecuteNonQuery();
            }
            foreach (var file in files)
            {
                using var add = Command("INSERT INTO activity_files (activity_id, path, type, data) VALUES ($id, $path, $type, $data);",
                    [("$id", activity.Id), ("$path", file.Path), ("$type", file.Type), ("$data", file.Data)]);
                add.Transaction = tx;
                add.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    public ActivityFile? GetActivityFile(string activityId, string path) =>
        Query("SELECT path, type, data FROM activity_files WHERE activity_id = $id AND path = $path;",
            r => new ActivityFile(r.GetString(0), r.GetString(1), (byte[])r[2]), ("$id", activityId), ("$path", path)).FirstOrDefault();

    public void SetActivityEnabled(string id, bool enabled) =>
        Exec("UPDATE activities SET enabled = $on WHERE id = $id;", ("$id", id), ("$on", enabled ? 1 : 0));

    public void RemoveActivity(string id) => Exec("DELETE FROM activities WHERE id = $id;", ("$id", id));

    public HashSet<string> BuiltinActivitiesOff() => Query("SELECT id FROM activity_builtins_off;", r => r.GetString(0)).ToHashSet();

    public void SetBuiltinActivityEnabled(string id, bool enabled)
    {
        if (enabled) Exec("DELETE FROM activity_builtins_off WHERE id = $id;", ("$id", id));
        else Exec("INSERT INTO activity_builtins_off (id) VALUES ($id) ON CONFLICT(id) DO NOTHING;", ("$id", id));
    }

    public List<long> ActivityOffChannels() => Query("SELECT channel_id FROM activity_off ORDER BY channel_id;", r => r.GetInt64(0));

    public bool ActivitiesOff(long channelId) => Scalar("SELECT 1 FROM activity_off WHERE channel_id = $c;", ("$c", channelId)) is not null;

    public void SetActivitiesOff(long channelId, bool off)
    {
        if (off) Exec("INSERT INTO activity_off (channel_id) VALUES ($c) ON CONFLICT(channel_id) DO NOTHING;", ("$c", channelId));
        else Exec("DELETE FROM activity_off WHERE channel_id = $c;", ("$c", channelId));
    }

    /// <summary>The lowest level that may start an activity (guest unless an admin raised it).</summary>
    public string ActivityStartRole() => Scalar("SELECT start_role FROM activity_settings WHERE id = 1;") as string ?? "guest";

    public void SetActivityStartRole(string role) =>
        Exec("INSERT INTO activity_settings (id, start_role) VALUES (1, $r) ON CONFLICT(id) DO UPDATE SET start_role = excluded.start_role;", ("$r", role));
}
