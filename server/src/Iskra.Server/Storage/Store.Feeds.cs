using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>
/// A feed the Feeds bot follows (RSS/Atom, a YouTube channel or a Twitch channel) and where it posts. <see cref="Mention"/>
/// is null, "role" (with <see cref="MentionRoleId"/>), "everyone" or "here".
/// </summary>
public sealed record FeedSubscription(
    long Id, string Kind, string Source, string Name, string Url, long ChannelId, string? Mention, long? MentionRoleId,
    string Template, int IntervalMinutes, bool Paused, string CreatedBy, long CreatedAt, string? ETag, string? LastModified,
    long NextAt, int Failures, string? LastError, long? LastCheckAt, long? LastOkAt, long? LastPostAt, long? LastMentionAt,
    long? LastManualAt);

public sealed partial class Store
{
    // The Feeds bot: what it follows (gone with the channel it posts in), the items it has seen (gone with the
    // subscription; the last 500 per subscription) and the owner's Twitch app credentials (never sent to apps).
    private const string FeedsMigration = """
        CREATE TABLE feed_subscriptions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            kind             TEXT NOT NULL,
            source           TEXT NOT NULL,
            name             TEXT NOT NULL,
            url              TEXT NOT NULL,
            channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            mention          TEXT,
            mention_role_id  INTEGER REFERENCES roles(id) ON DELETE SET NULL,
            template         TEXT NOT NULL,
            interval_min     INTEGER NOT NULL,
            paused           INTEGER NOT NULL DEFAULT 0,
            created_by       TEXT NOT NULL,
            created_at       INTEGER NOT NULL,
            etag             TEXT,
            last_modified    TEXT,
            next_at          INTEGER NOT NULL,
            failures         INTEGER NOT NULL DEFAULT 0,
            last_error       TEXT,
            last_check_at    INTEGER,
            last_ok_at       INTEGER,
            last_post_at     INTEGER,
            last_mention_at  INTEGER,
            last_manual_at   INTEGER
        );
        CREATE INDEX feed_subscriptions_channel ON feed_subscriptions(channel_id);
        CREATE TABLE feed_seen (
            sub_id   INTEGER NOT NULL REFERENCES feed_subscriptions(id) ON DELETE CASCADE,
            item     TEXT NOT NULL,
            seen_at  INTEGER NOT NULL,
            PRIMARY KEY (sub_id, item)
        );
        CREATE TABLE feed_settings (
            name   TEXT PRIMARY KEY,
            value  TEXT NOT NULL
        );
        """;

    public const int FeedSeenKeep = 500;

    private const string FeedColumns = """
        id, kind, source, name, url, channel_id, mention, mention_role_id, template, interval_min, paused, created_by, created_at,
        etag, last_modified, next_at, failures, last_error, last_check_at, last_ok_at, last_post_at, last_mention_at, last_manual_at
        """;

    private static FeedSubscription ReadFeed(SqliteDataReader r) => new(
        r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt64(5),
        r.IsDBNull(6) ? null : r.GetString(6), NullableLong(r, 7), r.GetString(8), r.GetInt32(9), r.GetInt64(10) != 0,
        r.GetString(11), r.GetInt64(12), r.IsDBNull(13) ? null : r.GetString(13), r.IsDBNull(14) ? null : r.GetString(14),
        r.GetInt64(15), r.GetInt32(16), r.IsDBNull(17) ? null : r.GetString(17), NullableLong(r, 18), NullableLong(r, 19),
        NullableLong(r, 20), NullableLong(r, 21), NullableLong(r, 22));

    public List<FeedSubscription> FeedSubscriptions() =>
        Query($"SELECT {FeedColumns} FROM feed_subscriptions ORDER BY id;", ReadFeed);

    public FeedSubscription? GetFeedSubscription(long id) =>
        Query($"SELECT {FeedColumns} FROM feed_subscriptions WHERE id = $id;", ReadFeed, ("$id", id)).FirstOrDefault();

    public int CountFeedSubscriptions() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM feed_subscriptions;"));

    /// <summary>Adds a subscription with the items it has now marked as seen (so nothing old is posted).</summary>
    public FeedSubscription AddFeedSubscription(FeedSubscription f, IEnumerable<string> seen, long now)
    {
        lock (_gate)
        {
            Exec("BEGIN IMMEDIATE;");
            try
            {
                var id = (long)Scalar($"""
                    INSERT INTO feed_subscriptions (kind, source, name, url, channel_id, mention, mention_role_id, template, interval_min,
                        paused, created_by, created_at, etag, last_modified, next_at, failures, last_check_at, last_ok_at)
                    VALUES ($kind, $source, $name, $url, $channel, $mention, $role, $template, $interval, 0, $by, $now, $etag, $lm, $next, 0, $now, $now)
                    RETURNING id;
                    """, ("$kind", f.Kind), ("$source", f.Source), ("$name", f.Name), ("$url", f.Url), ("$channel", f.ChannelId),
                    ("$mention", f.Mention), ("$role", f.MentionRoleId), ("$template", f.Template), ("$interval", f.IntervalMinutes),
                    ("$by", f.CreatedBy), ("$now", now), ("$etag", f.ETag), ("$lm", f.LastModified), ("$next", f.NextAt))!;
                foreach (var item in seen.Distinct().Take(FeedSeenKeep))
                    Exec("INSERT OR IGNORE INTO feed_seen (sub_id, item, seen_at) VALUES ($s, $i, $now);", ("$s", id), ("$i", item), ("$now", now));
                Exec("COMMIT;");
                return GetFeedSubscription(id)!;
            }
            catch
            {
                Exec("ROLLBACK;");
                throw;
            }
        }
    }

    /// <summary>What an admin can change.</summary>
    public void UpdateFeedSettings(long id, long channelId, string? mention, long? roleId, string template, int interval, bool paused) =>
        Exec("""
            UPDATE feed_subscriptions SET channel_id = $c, mention = $m, mention_role_id = $r, template = $t, interval_min = $i, paused = $p
            WHERE id = $id;
            """, ("$id", id), ("$c", channelId), ("$m", mention), ("$r", roleId), ("$t", template), ("$i", interval), ("$p", paused ? 1 : 0));

    public bool RemoveFeedSubscription(long id)
    {
        lock (_gate)
        {
            var had = Scalar("SELECT 1 FROM feed_subscriptions WHERE id = $id;", ("$id", id)) is not null;
            Exec("DELETE FROM feed_subscriptions WHERE id = $id;", ("$id", id));
            return had;
        }
    }

    /// <summary>After a check: when the next one is due, and how it went.</summary>
    public void FeedChecked(long id, long now, long nextAt, bool ok, string? error, int failures, string? etag, string? lastModified,
        bool manual = false) =>
        Exec("""
            UPDATE feed_subscriptions SET last_check_at = $now, next_at = $next, failures = $f, last_error = $e,
                last_ok_at = CASE WHEN $ok THEN $now ELSE last_ok_at END,
                etag = CASE WHEN $ok THEN COALESCE($etag, etag) ELSE etag END,
                last_modified = CASE WHEN $ok THEN COALESCE($lm, last_modified) ELSE last_modified END,
                last_manual_at = CASE WHEN $manual THEN $now ELSE last_manual_at END
            WHERE id = $id;
            """, ("$id", id), ("$now", now), ("$next", nextAt), ("$f", failures), ("$e", error), ("$ok", ok ? 1 : 0),
            ("$etag", etag), ("$lm", lastModified), ("$manual", manual ? 1 : 0));

    public void FeedPosted(long id, long now, bool mentioned) =>
        Exec("""
            UPDATE feed_subscriptions SET last_post_at = $now, last_mention_at = CASE WHEN $m THEN $now ELSE last_mention_at END
            WHERE id = $id;
            """, ("$id", id), ("$now", now), ("$m", mentioned ? 1 : 0));

    /// <summary>Of these item ids (hashes), the ones not seen before.</summary>
    public HashSet<string> UnseenFeedItems(long id, IEnumerable<string> items)
    {
        var unseen = new HashSet<string>(StringComparer.Ordinal);
        lock (_gate)
            foreach (var item in items)
                if (Scalar("SELECT 1 FROM feed_seen WHERE sub_id = $s AND item = $i;", ("$s", id), ("$i", item)) is null) unseen.Add(item);
        return unseen;
    }

    /// <summary>Marks items as seen and keeps the newest <see cref="FeedSeenKeep"/>.</summary>
    public void MarkFeedItemsSeen(long id, IEnumerable<string> items, long now)
    {
        lock (_gate)
        {
            Exec("BEGIN IMMEDIATE;");
            try
            {
                foreach (var item in items)
                    Exec("INSERT INTO feed_seen (sub_id, item, seen_at) VALUES ($s, $i, $now) ON CONFLICT(sub_id, item) DO UPDATE SET seen_at = excluded.seen_at;",
                        ("$s", id), ("$i", item), ("$now", now));
                Exec("""
                    DELETE FROM feed_seen WHERE sub_id = $s AND item NOT IN
                        (SELECT item FROM feed_seen WHERE sub_id = $s ORDER BY seen_at DESC, rowid DESC LIMIT $keep);
                    """, ("$s", id), ("$keep", FeedSeenKeep));
                Exec("COMMIT;");
            }
            catch
            {
                Exec("ROLLBACK;");
                throw;
            }
        }
    }

    public int CountFeedSeen(long id) => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM feed_seen WHERE sub_id = $s;", ("$s", id)));

    /// <summary>Server-side only: the Twitch client secret never leaves the server.</summary>
    public string? GetFeedSetting(string name) => Scalar("SELECT value FROM feed_settings WHERE name = $n;", ("$n", name)) as string;

    public void SetFeedSetting(string name, string? value)
    {
        if (value is null) Exec("DELETE FROM feed_settings WHERE name = $n;", ("$n", name));
        else Exec("INSERT INTO feed_settings (name, value) VALUES ($n, $v) ON CONFLICT(name) DO UPDATE SET value = excluded.value;", ("$n", name), ("$v", value));
    }
}
