namespace Iskra.Server.Storage;

/// <summary>A saved snippet of the Tags bot.</summary>
public sealed record Tag(string Name, string Text, string? UpdatedBy, long UpdatedAt);

/// <summary>A suggestion card (the bot's message) and what's known about it. The author is kept for staff also when the card hides it.</summary>
public sealed record Suggestion(long MessageId, long ChannelId, string? AuthorKey, bool Anonymous, string Text, string Status, string? Reason,
    string? DecidedBy, long? DecidedAt, long CreatedAt);

/// <summary>A giveaway card (the bot's message). <see cref="Drawn"/>: everyone ever drawn (a reroll never picks them again).</summary>
public sealed record Giveaway(long MessageId, long ChannelId, string? HostKey, string Prize, int Winners, long? RoleId, long EndsAt, long? EndedAt,
    bool Cancelled, string[] WinnerKeys, string[] Drawn, long CreatedAt);

/// <summary>The count in a counting channel: the last number, who said it (in which message) and the best streak.</summary>
public sealed record CountingState(long ChannelId, long Current, string? LastKey, long? LastMessageId, long Best, long? BestAt, long? CardId);

public sealed partial class Store
{
    // Tags, Suggestions, Giveaways and Counting. Cards go with their message (and votes and entries with the card);
    // votes and giveaway entries go with the member (left, removed, deleted); authors and hosts are forgotten then.
    private const string BuiltinBots3Migration = """
        CREATE TABLE tags (
            name        TEXT PRIMARY KEY,
            text        TEXT NOT NULL,
            updated_by  TEXT REFERENCES members(account_key) ON DELETE SET NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE suggestions (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            channel_id  INTEGER NOT NULL,
            author_key  TEXT REFERENCES members(account_key) ON DELETE SET NULL,
            anonymous   INTEGER NOT NULL,
            text        TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'open',
            reason      TEXT,
            decided_by  TEXT REFERENCES members(account_key) ON DELETE SET NULL,
            decided_at  INTEGER,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX suggestions_author ON suggestions(author_key, created_at);
        CREATE TABLE suggestion_votes (
            message_id  INTEGER NOT NULL REFERENCES suggestions(message_id) ON DELETE CASCADE,
            account_key TEXT NOT NULL REFERENCES members(account_key) ON DELETE CASCADE,
            vote        INTEGER NOT NULL,
            at          INTEGER NOT NULL,
            PRIMARY KEY (message_id, account_key)
        );
        CREATE TABLE giveaways (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            channel_id  INTEGER NOT NULL,
            host_key    TEXT REFERENCES members(account_key) ON DELETE SET NULL,
            prize       TEXT NOT NULL,
            winners     INTEGER NOT NULL,
            role_id     INTEGER,
            ends_at     INTEGER NOT NULL,
            ended_at    INTEGER,
            cancelled   INTEGER NOT NULL DEFAULT 0,
            winner_keys TEXT NOT NULL DEFAULT '',
            drawn_keys  TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX giveaways_open ON giveaways(ended_at, ends_at);
        CREATE TABLE giveaway_entries (
            message_id  INTEGER NOT NULL REFERENCES giveaways(message_id) ON DELETE CASCADE,
            account_key TEXT NOT NULL REFERENCES members(account_key) ON DELETE CASCADE,
            at          INTEGER NOT NULL,
            PRIMARY KEY (message_id, account_key)
        );
        CREATE TABLE counting (
            channel_id      INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            current         INTEGER NOT NULL DEFAULT 0,
            last_key        TEXT REFERENCES members(account_key) ON DELETE SET NULL,
            last_message_id INTEGER,
            best            INTEGER NOT NULL DEFAULT 0,
            best_at         INTEGER,
            card_id         INTEGER REFERENCES messages(id) ON DELETE SET NULL
        );
        """;

    // ── Tags ─────────────────────────────────────────────────────────────────

    private static Tag ReadSnippetTag(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetInt64(3));

    public List<Tag> Tags() => Query("SELECT name, text, updated_by, updated_at FROM tags ORDER BY name;", ReadSnippetTag);

    public Tag? GetTag(string name) =>
        Query("SELECT name, text, updated_by, updated_at FROM tags WHERE name = $n;", ReadSnippetTag, ("$n", name)).FirstOrDefault();

    public int CountTags() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM tags;"));

    /// <summary>Adds or replaces a tag, unless that would make more than <paramref name="max"/>. True if it's new.</summary>
    public bool? SetTag(string name, string text, string by, long now, int max)
    {
        lock (_gate)
        {
            var exists = Scalar("SELECT 1 FROM tags WHERE name = $n;", ("$n", name)) is not null;
            if (!exists && CountTags() >= max) return null;
            Exec("""
                INSERT INTO tags (name, text, updated_by, updated_at) VALUES ($n, $t, $by, $now)
                ON CONFLICT(name) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
                """, ("$n", name), ("$t", text), ("$by", GetMember(by) is null ? null : by), ("$now", now));
            return !exists;
        }
    }

    public bool RemoveTag(string name)
    {
        lock (_gate)
        {
            var had = Scalar("SELECT 1 FROM tags WHERE name = $n;", ("$n", name)) is not null;
            Exec("DELETE FROM tags WHERE name = $n;", ("$n", name));
            return had;
        }
    }

    // ── Suggestions ──────────────────────────────────────────────────────────

    private const string SuggestionColumns = "message_id, channel_id, author_key, anonymous, text, status, reason, decided_by, decided_at, created_at";

    private static Suggestion ReadSuggestion(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetInt64(3) != 0, r.GetString(4), r.GetString(5),
            r.IsDBNull(6) ? null : r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7), r.IsDBNull(8) ? null : r.GetInt64(8), r.GetInt64(9));

    public Suggestion? GetSuggestion(long messageId) =>
        Query($"SELECT {SuggestionColumns} FROM suggestions WHERE message_id = $m;", ReadSuggestion, ("$m", messageId)).FirstOrDefault();

    public void AddSuggestion(Suggestion s) =>
        Exec($"""
            INSERT INTO suggestions ({SuggestionColumns}) VALUES ($m, $c, $a, $anon, $t, $s, NULL, NULL, NULL, $now);
            """, ("$m", s.MessageId), ("$c", s.ChannelId), ("$a", s.AuthorKey), ("$anon", s.Anonymous ? 1 : 0), ("$t", s.Text), ("$s", s.Status),
            ("$now", s.CreatedAt));

    /// <summary>How many suggestions this person made since <paramref name="since"/> (for the per-person limit).</summary>
    public int CountSuggestionsSince(string authorKey, long since) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM suggestions WHERE author_key = $a AND created_at >= $since;", ("$a", authorKey), ("$since", since)));

    public void DecideSuggestion(long messageId, string status, string? reason, string by, long now) =>
        Exec("UPDATE suggestions SET status = $s, reason = $r, decided_by = $by, decided_at = $now WHERE message_id = $m;",
            ("$m", messageId), ("$s", status), ("$r", reason), ("$by", by), ("$now", now));

    /// <summary>Sets (1 or -1) or takes back (0) a vote.</summary>
    public void SetSuggestionVote(long messageId, string accountKey, int vote, long now)
    {
        if (vote == 0) Exec("DELETE FROM suggestion_votes WHERE message_id = $m AND account_key = $k;", ("$m", messageId), ("$k", accountKey));
        else
            Exec("""
                INSERT INTO suggestion_votes (message_id, account_key, vote, at) VALUES ($m, $k, $v, $now)
                ON CONFLICT(message_id, account_key) DO UPDATE SET vote = excluded.vote, at = excluded.at;
                """, ("$m", messageId), ("$k", accountKey), ("$v", vote), ("$now", now));
    }

    public (int Up, int Down) SuggestionVotes(long messageId)
    {
        var rows = Query("SELECT vote, COUNT(*) FROM suggestion_votes WHERE message_id = $m GROUP BY vote;", r => (r.GetInt32(0), r.GetInt32(1)), ("$m", messageId));
        return (rows.Where(r => r.Item1 > 0).Sum(r => r.Item2), rows.Where(r => r.Item1 < 0).Sum(r => r.Item2));
    }

    /// <summary>This person's votes on these cards.</summary>
    public Dictionary<long, int> MySuggestionVotes(string accountKey, IReadOnlyCollection<long> messageIds)
    {
        if (messageIds.Count == 0) return [];
        var ids = string.Join(',', messageIds.Select(id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        return Query($"SELECT message_id, vote FROM suggestion_votes WHERE account_key = $k AND message_id IN ({ids});",
            r => (r.GetInt64(0), r.GetInt32(1)), ("$k", accountKey)).ToDictionary(x => x.Item1, x => x.Item2);
    }

    // ── Giveaways ────────────────────────────────────────────────────────────

    private const string GiveawayColumns = "message_id, channel_id, host_key, prize, winners, role_id, ends_at, ended_at, cancelled, winner_keys, drawn_keys, created_at";

    private static string[] Keys(string raw) => raw.Length == 0 ? [] : raw.Split(' ');

    private static Giveaway ReadGiveaway(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.GetInt32(4), r.IsDBNull(5) ? null : r.GetInt64(5),
            r.GetInt64(6), r.IsDBNull(7) ? null : r.GetInt64(7), r.GetInt64(8) != 0, Keys(r.GetString(9)), Keys(r.GetString(10)), r.GetInt64(11));

    public Giveaway? GetGiveaway(long messageId) =>
        Query($"SELECT {GiveawayColumns} FROM giveaways WHERE message_id = $m;", ReadGiveaway, ("$m", messageId)).FirstOrDefault();

    public void AddGiveaway(Giveaway g) =>
        Exec($"INSERT INTO giveaways ({GiveawayColumns}) VALUES ($m, $c, $h, $p, $w, $r, $ends, NULL, 0, '', '', $now);",
            ("$m", g.MessageId), ("$c", g.ChannelId), ("$h", g.HostKey), ("$p", g.Prize), ("$w", g.Winners), ("$r", g.RoleId), ("$ends", g.EndsAt),
            ("$now", g.CreatedAt));

    public int CountOpenGiveaways() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM giveaways WHERE ended_at IS NULL;"));

    /// <summary>Open giveaways whose time is up (checked by the runtime every second; they're in the database, so a restart doesn't lose them).</summary>
    public List<Giveaway> DueGiveaways(long now) =>
        Query($"SELECT {GiveawayColumns} FROM giveaways WHERE ended_at IS NULL AND ends_at <= $now ORDER BY ends_at LIMIT 20;", ReadGiveaway, ("$now", now));

    /// <summary>The newest giveaway in a channel, optionally only open (or only ended and not cancelled) ones.</summary>
    public Giveaway? LatestGiveaway(long channelId, bool? open) =>
        Query($"""
            SELECT {GiveawayColumns} FROM giveaways WHERE channel_id = $c
            {(open switch { true => "AND ended_at IS NULL", false => "AND ended_at IS NOT NULL AND cancelled = 0", _ => "" })}
            ORDER BY message_id DESC LIMIT 1;
            """, ReadGiveaway, ("$c", channelId)).FirstOrDefault();

    /// <summary>Ends it (once: false if it had ended already), with its winners (or cancelled).</summary>
    public bool EndGiveaway(long messageId, IReadOnlyList<string> winners, bool cancelled, long now)
    {
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM giveaways WHERE message_id = $m AND ended_at IS NULL;", ("$m", messageId)) is null) return false;
            Exec("UPDATE giveaways SET ended_at = $now, cancelled = $c, winner_keys = $w, drawn_keys = $w WHERE message_id = $m;",
                ("$m", messageId), ("$now", now), ("$c", cancelled ? 1 : 0), ("$w", string.Join(' ', winners)));
            return true;
        }
    }

    public void RerollGiveaway(long messageId, IReadOnlyList<string> winners, IReadOnlyList<string> drawn) =>
        Exec("UPDATE giveaways SET winner_keys = $w, drawn_keys = $d WHERE message_id = $m;",
            ("$m", messageId), ("$w", string.Join(' ', winners)), ("$d", string.Join(' ', drawn)));

    /// <summary>Enters (or leaves); false if nothing changed.</summary>
    public bool SetGiveawayEntry(long messageId, string accountKey, bool entered, long now)
    {
        lock (_gate)
        {
            var had = Scalar("SELECT 1 FROM giveaway_entries WHERE message_id = $m AND account_key = $k;", ("$m", messageId), ("$k", accountKey)) is not null;
            if (had == entered) return false;
            if (entered) Exec("INSERT INTO giveaway_entries (message_id, account_key, at) VALUES ($m, $k, $now);", ("$m", messageId), ("$k", accountKey), ("$now", now));
            else Exec("DELETE FROM giveaway_entries WHERE message_id = $m AND account_key = $k;", ("$m", messageId), ("$k", accountKey));
            return true;
        }
    }

    /// <summary>Who entered, sorted by account key (so a draw's order doesn't depend on when people entered).</summary>
    public List<string> GiveawayEntrants(long messageId) =>
        Query("SELECT account_key FROM giveaway_entries WHERE message_id = $m ORDER BY account_key;", r => r.GetString(0), ("$m", messageId));

    public int CountGiveawayEntrants(long messageId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM giveaway_entries WHERE message_id = $m;", ("$m", messageId)));

    public HashSet<long> MyGiveawayEntries(string accountKey, IReadOnlyCollection<long> messageIds)
    {
        if (messageIds.Count == 0) return [];
        var ids = string.Join(',', messageIds.Select(id => id.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        return [.. Query($"SELECT message_id FROM giveaway_entries WHERE account_key = $k AND message_id IN ({ids});", r => r.GetInt64(0), ("$k", accountKey))];
    }

    /// <summary>Entries of giveaways that ended before <paramref name="cutoff"/> aren't needed any more (no reroll after that).</summary>
    public int ForgetGiveawayEntries(long cutoff)
    {
        lock (_gate)
        {
            var n = Convert.ToInt32(Scalar("""
                SELECT COUNT(*) FROM giveaway_entries WHERE message_id IN (SELECT message_id FROM giveaways WHERE ended_at IS NOT NULL AND ended_at < $cut);
                """, ("$cut", cutoff)));
            if (n > 0)
                Exec("DELETE FROM giveaway_entries WHERE message_id IN (SELECT message_id FROM giveaways WHERE ended_at IS NOT NULL AND ended_at < $cut);",
                    ("$cut", cutoff));
            return n;
        }
    }

    // ── Counting ─────────────────────────────────────────────────────────────

    public CountingState GetCounting(long channelId) =>
        Query("SELECT channel_id, current, last_key, last_message_id, best, best_at, card_id FROM counting WHERE channel_id = $c;",
            r => new CountingState(r.GetInt64(0), r.GetInt64(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetInt64(3),
                r.GetInt64(4), r.IsDBNull(5) ? null : r.GetInt64(5), r.IsDBNull(6) ? null : r.GetInt64(6)), ("$c", channelId)).FirstOrDefault()
        ?? new CountingState(channelId, 0, null, null, 0, null, null);

    public void SaveCounting(CountingState c) =>
        Exec("""
            INSERT INTO counting (channel_id, current, last_key, last_message_id, best, best_at, card_id) VALUES ($c, $n, $k, $m, $b, $bat, $card)
            ON CONFLICT(channel_id) DO UPDATE SET current = excluded.current, last_key = excluded.last_key, last_message_id = excluded.last_message_id,
                best = excluded.best, best_at = excluded.best_at, card_id = excluded.card_id;
            """, ("$c", c.ChannelId), ("$n", c.Current), ("$k", c.LastKey), ("$m", c.LastMessageId), ("$b", c.Best), ("$bat", c.BestAt), ("$card", c.CardId));
}
