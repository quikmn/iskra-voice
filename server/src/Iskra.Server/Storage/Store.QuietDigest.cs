namespace Iskra.Server.Storage;

/// <summary>A member whose quiet hours this server watches: the stored schedule (if any) and when the current quiet stretch began (if one is running).</summary>
public sealed record QuietWatch(string AccountKey, string? Quiet, long? Since);

/// <summary>The quiet hours digest (Features/QuietDigestFeature.cs): when each member's quiet stretch began, and what came in since.</summary>
public sealed partial class Store
{
    /// <summary>
    /// quietdigest-1: when the member's current quiet stretch began (null outside quiet hours). Kept with the alert
    /// settings, so leaving the server and deleting the account remove it with them.
    /// </summary>
    private const string QuietDigestMigration = "ALTER TABLE alert_settings ADD COLUMN quiet_since INTEGER;";

    /// <summary>Everyone with quiet hours here, or with a quiet stretch still open.</summary>
    public List<QuietWatch> QuietWatches() =>
        Query("SELECT account_key, quiet, quiet_since FROM alert_settings WHERE quiet IS NOT NULL OR quiet_since IS NOT NULL;",
            r => new QuietWatch(r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1), NullableLong(r, 2)));

    public long? QuietSince(string accountKey) =>
        Scalar("SELECT quiet_since FROM alert_settings WHERE account_key = $k;", ("$k", accountKey)) is long since ? since : null;

    public void SetQuietSince(string accountKey, long? since) =>
        Exec("UPDATE alert_settings SET quiet_since = $s WHERE account_key = $k;", ("$k", accountKey), ("$s", since));

    /// <summary>Inbox items (pings) for the account created in [from, to).</summary>
    public List<InboxItem> InboxItemsBetween(string accountKey, long from, long to) =>
        Query("""
            SELECT message_id, channel_id, kind, created_at FROM inbox_items
            WHERE account_key = $a AND created_at >= $from AND created_at < $to ORDER BY message_id DESC LIMIT 1000;
            """, r => new InboxItem(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetInt64(3)), ("$a", accountKey), ("$from", from), ("$to", to));

    /// <summary>Who sent the account direct messages in [from, to), and how many each (never the content: the server can't read it).</summary>
    public List<(string From, int Count)> DmsBetween(string accountKey, long from, long to) =>
        Query("""
            SELECT from_key, COUNT(*) FROM dms
            WHERE to_key = $a AND from_key <> $a AND created_at >= $from AND created_at < $to GROUP BY from_key;
            """, r => (r.GetString(0), r.GetInt32(1)), ("$a", accountKey), ("$from", from), ("$to", to));

    /// <summary>Group messages from others in [from, to), per sender, in groups the account is in now.</summary>
    public List<(string From, int Count)> GroupMessagesBetween(string accountKey, long from, long to) =>
        Query("""
            SELECT m.from_key, COUNT(*) FROM group_messages m
            JOIN group_members gm ON gm.group_id = m.group_id AND gm.account_key = $a
            WHERE m.from_key <> $a AND m.created_at >= $from AND m.created_at < $to GROUP BY m.from_key;
            """, r => (r.GetString(0), r.GetInt32(1)), ("$a", accountKey), ("$from", from), ("$to", to));

    /// <summary>The account's reminders that came due in [from, to).</summary>
    public int RemindersFiredBetween(string accountKey, long from, long to) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM reminders WHERE account_key = $a AND fired_at >= $from AND fired_at < $to;",
            ("$a", accountKey), ("$from", from), ("$to", to)));

    /// <summary>Events the account is interested in that started in [from, to) or start within <paramref name="soon"/> ms after it, not cancelled.</summary>
    public List<ServerEvent> InterestingEventsBetween(string accountKey, long from, long to, long soon) =>
        Query($"""
            SELECT {string.Join(", ", EventColumns.Split(", ").Select(c => "e." + c))} FROM events e
            JOIN event_interest i ON i.event_id = e.id AND i.account_key = $a
            WHERE e.status <> 'cancelled' AND e.start_at >= $from AND e.start_at < $until ORDER BY e.start_at LIMIT 100;
            """, ReadEvent, ("$a", accountKey), ("$from", from), ("$until", to + soon));
}
