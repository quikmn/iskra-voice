namespace Iskra.Server.Storage;

/// <summary>
/// A scheduled event. Times are UTC milliseconds; <see cref="TimeZone"/> is the creator's IANA zone, for showing the time
/// as they meant it. The location is a voice channel (<see cref="LocationKind"/> "voice") or free text ("place").
/// </summary>
public sealed record ServerEvent(long Id, string Title, string? Description, long StartAt, long EndAt, string TimeZone,
    string LocationKind, long? ChannelId, string? Location, string? ImageFile, string CreatedBy, long CreatedAt,
    string Status, long? RemindedAt)
{
    public bool IsOpen => Status is "scheduled" or "live";
}

public sealed partial class Store
{
    private const string EventsMigration = """
        CREATE TABLE events (
            id            INTEGER PRIMARY KEY,
            title         TEXT NOT NULL,
            description   TEXT,
            start_at      INTEGER NOT NULL,
            end_at        INTEGER NOT NULL,
            time_zone     TEXT NOT NULL,
            location_kind TEXT NOT NULL,
            channel_id    INTEGER REFERENCES channels(id) ON DELETE SET NULL,
            location      TEXT,
            image_file    TEXT,
            created_by    TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            status        TEXT NOT NULL DEFAULT 'scheduled',
            reminded_at   INTEGER
        );
        CREATE INDEX events_by_status ON events(status, start_at);
        CREATE TABLE event_interest (
            event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            account_key TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (event_id, account_key)
        );
        """;

    private const string EventColumns =
        "id, title, description, start_at, end_at, time_zone, location_kind, channel_id, location, image_file, created_by, created_at, status, reminded_at";

    private static ServerEvent ReadEvent(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetInt64(3), r.GetInt64(4), r.GetString(5),
            r.GetString(6), NullableLong(r, 7), r.IsDBNull(8) ? null : r.GetString(8), r.IsDBNull(9) ? null : r.GetString(9),
            r.GetString(10), r.GetInt64(11), r.GetString(12), NullableLong(r, 13));

    public ServerEvent AddEvent(ServerEvent e)
    {
        var id = Convert.ToInt64(Scalar($"""
            INSERT INTO events (title, description, start_at, end_at, time_zone, location_kind, channel_id, location, image_file, created_by, created_at, status)
            VALUES ($title, $desc, $start, $end, $tz, $kind, $ch, $loc, $img, $by, $now, 'scheduled') RETURNING id;
            """, ("$title", e.Title), ("$desc", e.Description), ("$start", e.StartAt), ("$end", e.EndAt), ("$tz", e.TimeZone),
            ("$kind", e.LocationKind), ("$ch", e.ChannelId), ("$loc", e.Location), ("$img", e.ImageFile), ("$by", e.CreatedBy), ("$now", e.CreatedAt)));
        return e with { Id = id, Status = "scheduled", RemindedAt = null };
    }

    public ServerEvent? GetEvent(long id) =>
        Query($"SELECT {EventColumns} FROM events WHERE id = $id;", ReadEvent, ("$id", id)).FirstOrDefault();

    /// <summary>Everything the creator can change, plus the reminder mark (cleared when the start moves).</summary>
    public void UpdateEvent(ServerEvent e) =>
        Exec("""
            UPDATE events SET title = $title, description = $desc, start_at = $start, end_at = $end, time_zone = $tz,
                location_kind = $kind, channel_id = $ch, location = $loc, image_file = $img, reminded_at = $rem
            WHERE id = $id;
            """, ("$id", e.Id), ("$title", e.Title), ("$desc", e.Description), ("$start", e.StartAt), ("$end", e.EndAt), ("$tz", e.TimeZone),
            ("$kind", e.LocationKind), ("$ch", e.ChannelId), ("$loc", e.Location), ("$img", e.ImageFile), ("$rem", e.RemindedAt));

    /// <summary>Moves an event from one status to another. False if it wasn't in <paramref name="from"/> any more.</summary>
    public bool SetEventStatus(long id, string[] from, string to)
    {
        lock (_gate)
        {
            using var cmd = Command("UPDATE events SET status = $to WHERE id = $id AND status IN (SELECT value FROM json_each($from));",
                [("$id", id), ("$to", to), ("$from", System.Text.Json.JsonSerializer.Serialize(from))]);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    /// <summary>Marks the reminder as sent. False if it already was.</summary>
    public bool MarkReminded(long id, long at)
    {
        lock (_gate)
        {
            using var cmd = Command("UPDATE events SET reminded_at = $at WHERE id = $id AND reminded_at IS NULL;", [("$id", id), ("$at", at)]);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    /// <summary>Scheduled and live events, soonest first.</summary>
    public List<ServerEvent> OpenEvents() =>
        Query($"SELECT {EventColumns} FROM events WHERE status IN ('scheduled', 'live') ORDER BY start_at, id;", ReadEvent);

    public int OpenEventCount() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM events WHERE status IN ('scheduled', 'live');"));

    /// <summary>Ended or cancelled events older than <paramref name="before"/> are forgotten.</summary>
    public void DeleteOldEvents(long before) =>
        Exec("DELETE FROM events WHERE status IN ('ended', 'cancelled') AND end_at < $before;", ("$before", before));

    public void SetInterest(long eventId, string accountKey, bool on, long now)
    {
        if (on)
            Exec("INSERT OR IGNORE INTO event_interest (event_id, account_key, created_at) VALUES ($e, $a, $now);",
                ("$e", eventId), ("$a", accountKey), ("$now", now));
        else
            Exec("DELETE FROM event_interest WHERE event_id = $e AND account_key = $a;", ("$e", eventId), ("$a", accountKey));
    }

    /// <summary>Who is interested, in the order they said so (members only: people who left drop out).</summary>
    public List<string> Interested(long eventId) =>
        Query("""
            SELECT i.account_key FROM event_interest i JOIN members m ON m.account_key = i.account_key
            WHERE i.event_id = $e ORDER BY i.created_at, i.rowid;
            """, r => r.GetString(0), ("$e", eventId));
}
