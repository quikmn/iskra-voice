using System.Text;

namespace Iskra.Server.Storage;

/// <summary>What to search for. <see cref="ChannelIds"/> is the set the requester may read; nothing outside it is ever returned.</summary>
public sealed record SearchQuery(
    IReadOnlyList<string> Terms, IReadOnlyCollection<long> ChannelIds, string? Author, bool HasFile, bool HasLink,
    long? Before, long? After, long? Cursor, int Limit);

/// <summary>A hit and where the terms matched in its text: (start, length) in UTF-16 code units.</summary>
public sealed record SearchHit(Message Message, List<(int Start, int Length)> Matches);

public sealed partial class Store
{
    // Full-text index over message text, kept in sync by triggers so every write path (edits, deletes,
    // channel deletes that cascade) updates it. The 'rebuild' backfills existing messages.
    private const string SearchMigration = """
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER messages_fts_update AFTER UPDATE OF text ON messages BEGIN
            INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
            INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
        END;
        INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');
        """;

    private const string PrefixedMessageColumns = "m.id, m.channel_id, m.author_key, m.text, m.created_at, m.edited_at, m.attachments, m.reply_to";

    // Message text can't contain control characters (Text.Normalize), so these mark matches unambiguously.
    private const char MatchStart = '\u0001';
    private const char MatchEnd = '\u0002';

    /// <summary>Newest first. Also returns how many messages match in total.</summary>
    public (List<SearchHit> Hits, int Total) Search(SearchQuery q)
    {
        if (q.ChannelIds.Count == 0) return ([], 0);

        var args = new List<(string, object?)>();
        var where = new StringBuilder();
        var channels = string.Join(", ", q.ChannelIds.Select((id, i) =>
        {
            args.Add(($"$c{i}", id));
            return $"$c{i}";
        }));
        where.Append($"m.channel_id IN ({channels})");
        if (q.Author is not null)
        {
            where.Append(" AND m.author_key = $author");
            args.Add(("$author", q.Author));
        }
        if (q.HasFile) where.Append(" AND m.attachments IS NOT NULL");
        if (q.HasLink) where.Append(" AND (m.text LIKE '%http://%' OR m.text LIKE '%https://%')");
        if (q.Before is { } before)
        {
            where.Append(" AND m.created_at < $before");
            args.Add(("$before", before));
        }
        if (q.After is { } after)
        {
            where.Append(" AND m.created_at >= $after");
            args.Add(("$after", after));
        }

        string from;
        string highlight;
        if (q.Terms.Count > 0)
        {
            // Every term is quoted (so FTS syntax in user text is just text) and prefix-matched.
            var match = string.Join(' ', q.Terms.Select(t => "\"" + t.Replace("\"", "\"\"") + "\"*"));
            from = "messages_fts f JOIN messages m ON m.id = f.rowid";
            where.Insert(0, "messages_fts MATCH $match AND ");
            args.Add(("$match", match));
            highlight = "highlight(messages_fts, 0, char(1), char(2))";
        }
        else
        {
            from = "messages m";
            highlight = "NULL";
        }

        var countArgs = args.ToArray();
        var cursorClause = "";
        if (q.Cursor is { } cursor)
        {
            cursorClause = " AND m.id < $cursor";
            args.Add(("$cursor", cursor));
        }
        args.Add(("$limit", q.Limit));

        lock (_gate)
        {
            var total = Convert.ToInt32(Scalar($"SELECT COUNT(*) FROM {from} WHERE {where};", countArgs));
            var hits = Query($"SELECT {PrefixedMessageColumns}, {highlight} FROM {from} WHERE {where}{cursorClause} ORDER BY m.id DESC LIMIT $limit;",
                r => new SearchHit(ReadMessage(r), r.IsDBNull(8) ? [] : MatchRanges(r.GetString(8))), args.ToArray());
            return (hits, total);
        }
    }

    /// <summary>Turns FTS highlight markers into (start, length) ranges in the unmarked text.</summary>
    internal static List<(int Start, int Length)> MatchRanges(string marked)
    {
        var ranges = new List<(int, int)>();
        var position = 0;
        var start = -1;
        foreach (var c in marked)
        {
            if (c == MatchStart) start = position;
            else if (c == MatchEnd)
            {
                if (start >= 0 && position > start) ranges.Add((start, position - start));
                start = -1;
            }
            else position++;
        }
        return ranges;
    }

    /// <summary>
    /// The messages around <paramref name="messageId"/> (included), oldest first, for jumping to an older message.
    /// Null if it isn't in that channel.
    /// </summary>
    public (List<Message> Messages, bool HasOlder, bool HasNewer)? HistoryAround(long channelId, long messageId, int limit)
    {
        var olderCount = Math.Max(1, limit / 2);
        var newerCount = Math.Max(1, limit - olderCount);
        lock (_gate)
        {
            if (Scalar("SELECT 1 FROM messages WHERE id = $id AND channel_id = $ch;", ("$id", messageId), ("$ch", channelId)) is null) return null;
            var older = Query($"SELECT {MessageColumns} FROM messages WHERE channel_id = $ch AND id <= $id ORDER BY id DESC LIMIT $n;",
                ReadMessage, ("$ch", channelId), ("$id", messageId), ("$n", olderCount + 1));
            var newer = Query($"SELECT {MessageColumns} FROM messages WHERE channel_id = $ch AND id > $id ORDER BY id LIMIT $n;",
                ReadMessage, ("$ch", channelId), ("$id", messageId), ("$n", newerCount + 1));
            var hasOlder = older.Count > olderCount;
            var hasNewer = newer.Count > newerCount;
            older = older.Take(olderCount).Reverse().ToList();
            return ([.. older, .. newer.Take(newerCount)], hasOlder, hasNewer);
        }
    }
}
