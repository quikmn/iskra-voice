namespace Iskra.Server.Storage;

/// <summary>
/// Idempotent sends: a client nonce per message, remembered per account for a day, so a send retried after a dropped
/// connection returns the message that was already stored instead of posting it twice.
/// </summary>
public sealed partial class Store
{
    private const string SendsMigration = """
        CREATE TABLE send_nonces (
            account_key TEXT NOT NULL,
            nonce       TEXT NOT NULL,
            message_id  INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (account_key, nonce)
        );
        CREATE INDEX send_nonces_by_time ON send_nonces(created_at);
        """;

    /// <summary>The message an earlier send with this nonce stored (null if none, or if it's gone).</summary>
    public Message? MessageForNonce(string accountKey, string nonce) =>
        Scalar("SELECT message_id FROM send_nonces WHERE account_key = $a AND nonce = $n;", ("$a", accountKey), ("$n", nonce)) is long id
            ? GetMessage(id) : null;

    public bool NonceUsed(string accountKey, string nonce) =>
        Scalar("SELECT 1 FROM send_nonces WHERE account_key = $a AND nonce = $n;", ("$a", accountKey), ("$n", nonce)) is not null;

    /// <summary>Stores the message unless this nonce already stored one (checked and written under one lock). Created = false: the earlier one.</summary>
    public (Message? Message, bool Created) AddMessageOnce(string nonce, long channelId, string authorKey, string text, long now,
        string[]? attachments = null, long? replyTo = null)
    {
        lock (_gate)
        {
            if (NonceUsed(authorKey, nonce)) return (MessageForNonce(authorKey, nonce), false);
            var message = AddMessage(channelId, authorKey, text, now, attachments, replyTo);
            Exec("INSERT INTO send_nonces (account_key, nonce, message_id, created_at) VALUES ($a, $n, $m, $t);",
                ("$a", authorKey), ("$n", nonce), ("$m", message.Id), ("$t", now));
            return (message, true);
        }
    }

    public void PruneNonces(long olderThan)
    {
        Exec("DELETE FROM send_nonces WHERE created_at < $t;", ("$t", olderThan));
        Exec("DELETE FROM envelope_send_nonces WHERE created_at < $t;", ("$t", olderThan));
    }

    // ── DMs and group messages: the same, for encrypted envelopes ───────────

    private const string EnvelopeSendsMigration = """
        CREATE TABLE envelope_send_nonces (
            account_key TEXT NOT NULL,
            kind        TEXT NOT NULL,
            nonce       TEXT NOT NULL,
            message_id  INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (account_key, kind, nonce)
        );
        CREATE INDEX envelope_send_nonces_by_time ON envelope_send_nonces(created_at);
        """;

    private long? EnvelopeNonce(string accountKey, string kind, string nonce) =>
        Scalar("SELECT message_id FROM envelope_send_nonces WHERE account_key = $a AND kind = $k AND nonce = $n;",
            ("$a", accountKey), ("$k", kind), ("$n", nonce)) as long?;

    public DirectMessage? GetDm(long id) => Query($"SELECT {DmColumns} FROM dms WHERE id = $id;", ReadDm, ("$id", id)).FirstOrDefault();

    public GroupMessage? GetGroupMessage(long id) =>
        Query($"SELECT {GroupMessageColumns} FROM group_messages WHERE id = $id;", ReadGroupMessage, ("$id", id)).FirstOrDefault();

    /// <summary>Whether an earlier DM (<paramref name="kind"/> "dm") or group send used this nonce; the message, if it's still there.</summary>
    public (bool Used, object? Message) EnvelopeForNonce(string accountKey, string kind, string nonce) =>
        EnvelopeNonce(accountKey, kind, nonce) is { } id ? (true, kind == "dm" ? GetDm(id) : GetGroupMessage(id)) : (false, null);

    /// <summary>Stores the DM and its nonce in one transaction, unless the nonce already stored one (then Created = false).</summary>
    public (DirectMessage? Message, bool Created) AddDmOnce(string nonce, string from, string to, string envelope, long now)
    {
        lock (_gate)
        {
            if (EnvelopeNonce(from, "dm", nonce) is { } earlier) return (GetDm(earlier), false);
            var id = InsertWithNonce(from, "dm", nonce, now,
                "INSERT INTO dms (from_key, to_key, envelope, created_at) VALUES ($from, $to, $env, $now) RETURNING id;",
                ("$from", from), ("$to", to), ("$env", envelope), ("$now", now));
            return (new DirectMessage(id, from, to, envelope, now), true);
        }
    }

    /// <summary>Stores the group message and its nonce in one transaction, unless the nonce already stored one.</summary>
    public (GroupMessage? Message, bool Created) AddGroupMessageOnce(string nonce, string groupId, string from, long version, string envelope, long now)
    {
        lock (_gate)
        {
            if (EnvelopeNonce(from, "group", nonce) is { } earlier) return (GetGroupMessage(earlier), false);
            var id = InsertWithNonce(from, "group", nonce, now,
                "INSERT INTO group_messages (group_id, from_key, version, envelope, created_at) VALUES ($g, $from, $v, $env, $now) RETURNING id;",
                ("$g", groupId), ("$from", from), ("$v", version), ("$env", envelope), ("$now", now));
            return (new GroupMessage(id, groupId, from, version, envelope, now), true);
        }
    }

    private long InsertWithNonce(string accountKey, string kind, string nonce, long now, string insert, params (string Name, object? Value)[] args)
    {
        using var tx = _db.BeginTransaction();
        long id;
        using (var cmd = Command(insert, args))
        {
            cmd.Transaction = tx;
            id = Convert.ToInt64(cmd.ExecuteScalar());
        }
        Run(tx, "INSERT INTO envelope_send_nonces (account_key, kind, nonce, message_id, created_at) VALUES ($a, $k, $n, $m, $t);",
            ("$a", accountKey), ("$k", kind), ("$n", nonce), ("$m", id), ("$t", now));
        tx.Commit();
        return id;
    }
}
