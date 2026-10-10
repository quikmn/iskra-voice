using System.Text.Json;

namespace Iskra.Server.Storage;

public sealed record Poll(long MessageId, string Question, string[] Options, bool Multi, long? ExpiresAt, long? ClosedAt)
{
    public bool IsClosed(long now) => ClosedAt is not null || (ExpiresAt is { } e && now >= e);
}

public sealed partial class Store
{
    private const string PollColumns = "message_id, question, options, multi, expires_at, closed_at";

    private static Poll ReadPoll(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), JsonSerializer.Deserialize<string[]>(r.GetString(2)) ?? [], r.GetInt64(3) != 0,
            NullableLong(r, 4), NullableLong(r, 5));

    /// <summary>The poll message and its poll, written together.</summary>
    public (Message Message, Poll Poll) AddPoll(long channelId, string authorKey, string question, string[] options, bool multi,
        long? expiresAt, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            long id;
            using (var insert = Command("""
                       INSERT INTO messages (channel_id, author_key, text, created_at) VALUES ($ch, $author, $text, $now) RETURNING id;
                       """, [("$ch", channelId), ("$author", authorKey), ("$text", question), ("$now", now)]))
            {
                insert.Transaction = tx;
                id = Convert.ToInt64(insert.ExecuteScalar());
            }
            var message = new Message(id, channelId, authorKey, question, now, null, [], null);
            using (var cmd = Command("INSERT INTO polls (message_id, question, options, multi, expires_at) VALUES ($m, $q, $o, $multi, $exp);",
                       [("$m", message.Id), ("$q", question), ("$o", JsonSerializer.Serialize(options)), ("$multi", multi ? 1 : 0), ("$exp", expiresAt)]))
            {
                cmd.Transaction = tx;
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            return (message, new Poll(message.Id, question, options, multi, expiresAt, null));
        }
    }

    public Poll? GetPoll(long messageId) =>
        Query($"SELECT {PollColumns} FROM polls WHERE message_id = $m;", ReadPoll, ("$m", messageId)).FirstOrDefault();

    /// <summary>Replaces this account's vote (an empty list removes it).</summary>
    public void SetVote(long messageId, string accountKey, IReadOnlyCollection<int> options, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            using (var del = Command("DELETE FROM poll_votes WHERE message_id = $m AND account_key = $a;", [("$m", messageId), ("$a", accountKey)]))
            {
                del.Transaction = tx;
                del.ExecuteNonQuery();
            }
            foreach (var option in options)
            {
                using var ins = Command("INSERT INTO poll_votes (message_id, account_key, option, created_at) VALUES ($m, $a, $o, $now);",
                    [("$m", messageId), ("$a", accountKey), ("$o", option), ("$now", now)]);
                ins.Transaction = tx;
                ins.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    /// <summary>Who voted for each option, in the order they voted.</summary>
    public List<string>[] PollVotes(long messageId, int optionCount)
    {
        var votes = Enumerable.Range(0, optionCount).Select(_ => new List<string>()).ToArray();
        foreach (var (option, account) in Query("SELECT option, account_key FROM poll_votes WHERE message_id = $m ORDER BY created_at, rowid;",
                     r => (r.GetInt32(0), r.GetString(1)), ("$m", messageId)))
        {
            if (option >= 0 && option < optionCount) votes[option].Add(account);
        }
        return votes;
    }

    /// <summary>Marks a poll closed. Returns false if it already was.</summary>
    public bool ClosePoll(long messageId, long at)
    {
        lock (_gate)
        {
            using var cmd = Command("UPDATE polls SET closed_at = $at WHERE message_id = $m AND closed_at IS NULL;", [("$m", messageId), ("$at", at)]);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    /// <summary>Open polls whose time is up.</summary>
    public List<Poll> ExpiredPolls(long now) =>
        Query($"SELECT {PollColumns} FROM polls WHERE closed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $now LIMIT 100;",
            ReadPoll, ("$now", now));
}
