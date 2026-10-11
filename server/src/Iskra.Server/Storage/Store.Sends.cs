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

    public void PruneNonces(long olderThan) => Exec("DELETE FROM send_nonces WHERE created_at < $t;", ("$t", olderThan));
}
