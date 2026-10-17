using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>A friend's server that keeps this server's encrypted daily backups (we're the source).</summary>
public sealed record BuddyRow(
    string Id, string Url, string HolderKey, string Name, string SpotId, long QuotaBytes, int Keep, long AddedAt,
    long? OkAt, string? OkName, long? OkSize, string? Error, int Failures, long? NextTryAt,
    string? UploadId, string? UploadName, bool Removed);

/// <summary>A spot this server keeps for a friend's server (we're the holder).</summary>
public sealed record BuddySpotRow(
    string Id, string Label, long QuotaBytes, int Keep, int GraceDays, string? TokenHash, long? CodeExpiresAt,
    string? SourceKey, string? SourceName, string? RestoreKey, long CreatedAt, long? PairedAt, long? LastUploadAt,
    long? DeleteAt, string RecentUploads);

public sealed record BuddyVersionRow(string Id, string SpotId, long Size, long At, string Sha256);

public sealed record BuddyUploadRow(string Id, string SpotId, long Size, long CreatedAt);

/// <summary>Backup buddies (see "Backup buddies" in PROTOCOL.md): both the source's and the holder's side.</summary>
public sealed partial class Store
{
    private const string BuddyBackupMigration = """
        CREATE TABLE buddy_config (
            id            INTEGER PRIMARY KEY CHECK (id = 1),
            recovery_code TEXT NOT NULL,
            created_at    INTEGER NOT NULL
        );
        CREATE TABLE buddies (
            id          TEXT PRIMARY KEY,
            url         TEXT NOT NULL,
            holder_key  TEXT NOT NULL UNIQUE,
            name        TEXT NOT NULL,
            spot_id     TEXT NOT NULL,
            quota_bytes INTEGER NOT NULL,
            keep        INTEGER NOT NULL,
            added_at    INTEGER NOT NULL,
            ok_at       INTEGER,
            ok_name     TEXT,
            ok_size     INTEGER,
            error       TEXT,
            failures    INTEGER NOT NULL DEFAULT 0,
            next_try_at INTEGER,
            upload_id   TEXT,
            upload_name TEXT,
            removed     INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE buddy_spots (
            id              TEXT PRIMARY KEY,
            label           TEXT NOT NULL,
            quota_bytes     INTEGER NOT NULL,
            keep            INTEGER NOT NULL,
            grace_days      INTEGER NOT NULL,
            token_hash      TEXT UNIQUE,
            code_expires_at INTEGER,
            source_key      TEXT UNIQUE,
            source_name     TEXT,
            restore_key     TEXT UNIQUE,
            created_at      INTEGER NOT NULL,
            paired_at       INTEGER,
            last_upload_at  INTEGER,
            delete_at       INTEGER,
            recent_uploads  TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE buddy_versions (
            id      TEXT PRIMARY KEY,
            spot_id TEXT NOT NULL REFERENCES buddy_spots(id) ON DELETE CASCADE,
            size    INTEGER NOT NULL,
            at      INTEGER NOT NULL,
            sha256  TEXT NOT NULL
        );
        CREATE INDEX buddy_versions_by_spot ON buddy_versions(spot_id, at);
        CREATE TABLE buddy_uploads (
            id         TEXT PRIMARY KEY,
            spot_id    TEXT NOT NULL REFERENCES buddy_spots(id) ON DELETE CASCADE,
            size       INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        """;

    // ── Source: the recovery code and our buddies ────────────────────────────

    public string? BuddyRecoveryCode() => Scalar("SELECT recovery_code FROM buddy_config WHERE id = 1;") as string;

    /// <summary>Stores the code unless there is one already; returns the one in effect.</summary>
    public string EnsureBuddyRecoveryCode(string fresh, long now)
    {
        Exec("INSERT INTO buddy_config (id, recovery_code, created_at) VALUES (1, $c, $now) ON CONFLICT(id) DO NOTHING;", ("$c", fresh), ("$now", now));
        return BuddyRecoveryCode()!;
    }

    private const string BuddyColumns = "id, url, holder_key, name, spot_id, quota_bytes, keep, added_at, ok_at, ok_name, ok_size, error, failures, next_try_at, upload_id, upload_name, removed";

    private static BuddyRow ReadBuddy(SqliteDataReader r) => new(
        r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt64(5), r.GetInt32(6), r.GetInt64(7),
        NullableLong(r, 8), r.IsDBNull(9) ? null : r.GetString(9), NullableLong(r, 10), r.IsDBNull(11) ? null : r.GetString(11),
        r.GetInt32(12), NullableLong(r, 13), r.IsDBNull(14) ? null : r.GetString(14), r.IsDBNull(15) ? null : r.GetString(15), r.GetInt64(16) != 0);

    public List<BuddyRow> Buddies() => Query($"SELECT {BuddyColumns} FROM buddies ORDER BY added_at, id;", ReadBuddy);

    public BuddyRow? GetBuddy(string id) => Query($"SELECT {BuddyColumns} FROM buddies WHERE id = $id;", ReadBuddy, ("$id", id)).FirstOrDefault();

    public void AddBuddy(BuddyRow b) =>
        Exec("""
            INSERT INTO buddies (id, url, holder_key, name, spot_id, quota_bytes, keep, added_at, next_try_at)
            VALUES ($id, $url, $key, $name, $spot, $quota, $keep, $at, $at);
            """, ("$id", b.Id), ("$url", b.Url), ("$key", b.HolderKey), ("$name", b.Name), ("$spot", b.SpotId),
            ("$quota", b.QuotaBytes), ("$keep", b.Keep), ("$at", b.AddedAt));

    public void DeleteBuddy(string id) => Exec("DELETE FROM buddies WHERE id = $id;", ("$id", id));

    public void BuddyUploading(string id, string? uploadId, string? uploadName) =>
        Exec("UPDATE buddies SET upload_id = $u, upload_name = $n WHERE id = $id;", ("$id", id), ("$u", uploadId), ("$n", uploadName));

    public void BuddySucceeded(string id, long at, string name, long size, long quota, int keep) =>
        Exec("""
            UPDATE buddies SET ok_at = $at, ok_name = $name, ok_size = $size, error = NULL, failures = 0, next_try_at = NULL,
                upload_id = NULL, upload_name = NULL, removed = 0, quota_bytes = $quota, keep = $keep WHERE id = $id;
            """, ("$id", id), ("$at", at), ("$name", name), ("$size", size), ("$quota", quota), ("$keep", keep));

    public void BuddyFailed(string id, string errorJson, int failures, long? nextTryAt, bool removed) =>
        Exec("UPDATE buddies SET error = $e, failures = $f, next_try_at = $next, removed = $removed WHERE id = $id;",
            ("$id", id), ("$e", errorJson), ("$f", failures), ("$next", nextTryAt), ("$removed", removed ? 1 : 0));

    /// <summary>Nothing to send right now (up to date, or daily backups are off): clears the retry time, keeps the rest.</summary>
    public void BuddyIdle(string id, string? errorJson) =>
        Exec("UPDATE buddies SET error = $e, next_try_at = NULL, failures = 0 WHERE id = $id;", ("$id", id), ("$e", errorJson));

    /// <summary>"Back up now": every buddy tries at once.</summary>
    public void BuddiesTryNow(long now) => Exec("UPDATE buddies SET next_try_at = $now, failures = 0 WHERE removed = 0;", ("$now", now));

    // ── Holder: spots, versions and uploads ──────────────────────────────────

    private const string SpotColumns = "id, label, quota_bytes, keep, grace_days, token_hash, code_expires_at, source_key, source_name, restore_key, created_at, paired_at, last_upload_at, delete_at, recent_uploads";

    private static BuddySpotRow ReadSpot(SqliteDataReader r) => new(
        r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt32(3), r.GetInt32(4), r.IsDBNull(5) ? null : r.GetString(5),
        NullableLong(r, 6), r.IsDBNull(7) ? null : r.GetString(7), r.IsDBNull(8) ? null : r.GetString(8),
        r.IsDBNull(9) ? null : r.GetString(9), r.GetInt64(10), NullableLong(r, 11), NullableLong(r, 12), NullableLong(r, 13), r.GetString(14));

    public List<BuddySpotRow> BuddySpots() => Query($"SELECT {SpotColumns} FROM buddy_spots ORDER BY created_at, id;", ReadSpot);

    public BuddySpotRow? GetBuddySpot(string id) => Query($"SELECT {SpotColumns} FROM buddy_spots WHERE id = $id;", ReadSpot, ("$id", id)).FirstOrDefault();

    /// <summary>The paired spot whose source key or restore key this is (never a waiting spot).</summary>
    public BuddySpotRow? BuddySpotForKey(string key) =>
        Query($"SELECT {SpotColumns} FROM buddy_spots WHERE paired_at IS NOT NULL AND (source_key = $k OR restore_key = $k);", ReadSpot, ("$k", key)).FirstOrDefault();

    public BuddySpotRow? BuddySpotForToken(string tokenHash) =>
        Query($"SELECT {SpotColumns} FROM buddy_spots WHERE token_hash = $t AND paired_at IS NULL;", ReadSpot, ("$t", tokenHash)).FirstOrDefault();

    public int CountBuddySpots() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM buddy_spots;"));

    public void AddBuddySpot(BuddySpotRow s) =>
        Exec("""
            INSERT INTO buddy_spots (id, label, quota_bytes, keep, grace_days, token_hash, code_expires_at, created_at)
            VALUES ($id, $label, $quota, $keep, $grace, $token, $expires, $at);
            """, ("$id", s.Id), ("$label", s.Label), ("$quota", s.QuotaBytes), ("$keep", s.Keep), ("$grace", s.GraceDays),
            ("$token", s.TokenHash), ("$expires", s.CodeExpiresAt), ("$at", s.CreatedAt));

    public void UpdateBuddySpot(string id, string label, long quotaBytes, int keep, int graceDays) =>
        Exec("UPDATE buddy_spots SET label = $label, quota_bytes = $quota, keep = $keep, grace_days = $grace WHERE id = $id;",
            ("$id", id), ("$label", label), ("$quota", quotaBytes), ("$keep", keep), ("$grace", graceDays));

    /// <summary>Binds a waiting spot to its source, once: false when the token was used meanwhile or the source has a spot.</summary>
    public bool PairBuddySpot(string id, string tokenHash, string sourceKey, string sourceName, string restoreKey, long now)
    {
        try
        {
            return Convert.ToInt32(Scalar("""
                UPDATE buddy_spots SET source_key = $s, source_name = $n, restore_key = $r, paired_at = $now, token_hash = NULL, code_expires_at = NULL
                WHERE id = $id AND token_hash = $t AND paired_at IS NULL RETURNING 1;
                """, ("$id", id), ("$t", tokenHash), ("$s", sourceKey), ("$n", sourceName), ("$r", restoreKey), ("$now", now)) ?? 0) == 1;
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 19) // UNIQUE: that source (or restore key) has a spot already
        {
            return false;
        }
    }

    public void RemoveBuddySpotLater(string id, long deleteAt) =>
        Exec("UPDATE buddy_spots SET delete_at = $at WHERE id = $id AND (delete_at IS NULL OR delete_at > $at);", ("$id", id), ("$at", deleteAt));

    public void DeleteBuddySpot(string id)
    {
        Exec("DELETE FROM buddy_uploads WHERE spot_id = $id;", ("$id", id));
        Exec("DELETE FROM buddy_versions WHERE spot_id = $id;", ("$id", id));
        Exec("DELETE FROM buddy_spots WHERE id = $id;", ("$id", id));
    }

    public void BuddySpotUploaded(string id, long now, string recentUploads) =>
        Exec("UPDATE buddy_spots SET last_upload_at = $now, recent_uploads = $r WHERE id = $id;", ("$id", id), ("$now", now), ("$r", recentUploads));

    /// <summary>Newest first.</summary>
    public List<BuddyVersionRow> BuddyVersions(string spotId) =>
        Query("SELECT id, spot_id, size, at, sha256 FROM buddy_versions WHERE spot_id = $s ORDER BY at DESC, id DESC;",
            r => new BuddyVersionRow(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3), r.GetString(4)), ("$s", spotId));

    public void AddBuddyVersion(BuddyVersionRow v) =>
        Exec("INSERT INTO buddy_versions (id, spot_id, size, at, sha256) VALUES ($id, $s, $size, $at, $sha);",
            ("$id", v.Id), ("$s", v.SpotId), ("$size", v.Size), ("$at", v.At), ("$sha", v.Sha256));

    public void DeleteBuddyVersion(string id) => Exec("DELETE FROM buddy_versions WHERE id = $id;", ("$id", id));

    public BuddyUploadRow? GetBuddyUpload(string id) =>
        Query("SELECT id, spot_id, size, created_at FROM buddy_uploads WHERE id = $id;",
            r => new BuddyUploadRow(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3)), ("$id", id)).FirstOrDefault();

    public List<BuddyUploadRow> BuddyUploads() =>
        Query("SELECT id, spot_id, size, created_at FROM buddy_uploads;",
            r => new BuddyUploadRow(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3)));

    /// <summary>A new upload for the spot; any unfinished one is dropped (returned, so its file goes too).</summary>
    public List<string> StartBuddyUpload(BuddyUploadRow u)
    {
        var old = Query("DELETE FROM buddy_uploads WHERE spot_id = $s RETURNING id;", r => r.GetString(0), ("$s", u.SpotId));
        Exec("INSERT INTO buddy_uploads (id, spot_id, size, created_at) VALUES ($id, $s, $size, $at);",
            ("$id", u.Id), ("$s", u.SpotId), ("$size", u.Size), ("$at", u.CreatedAt));
        return old;
    }

    public void DeleteBuddyUpload(string id) => Exec("DELETE FROM buddy_uploads WHERE id = $id;", ("$id", id));
}
