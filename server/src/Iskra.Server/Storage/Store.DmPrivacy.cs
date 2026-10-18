namespace Iskra.Server.Storage;

/// <summary>How one person treats DMs from another on this server (see DmPrivacyFeature).</summary>
public enum DmContactState { Request = 0, Accepted = 1, Ignored = 2 }

public sealed partial class Store
{
    // dm_privacy: who may start a new DM with this account (no row: anyone). Last writer wins by the client's time.
    // dm_contacts: how account_key treats DMs from peer_key: a request waiting for an answer, accepted (they talked, or
    // the request was accepted) or ignored. Kept apart from the envelopes, which retention may delete. Conversations
    // that existed before this feature count as accepted on both sides.
    private const string DmPrivacyMigration = """
        CREATE TABLE dm_privacy (
            account_key TEXT PRIMARY KEY,
            who TEXT NOT NULL,
            at INTEGER NOT NULL
        );
        CREATE TABLE dm_contacts (
            account_key TEXT NOT NULL,
            peer_key TEXT NOT NULL,
            state INTEGER NOT NULL,
            at INTEGER NOT NULL,
            PRIMARY KEY (account_key, peer_key)
        );
        INSERT OR IGNORE INTO dm_contacts (account_key, peer_key, state, at)
            SELECT from_key, to_key, 1, MIN(created_at) FROM dms WHERE from_key <> to_key GROUP BY from_key, to_key;
        INSERT OR IGNORE INTO dm_contacts (account_key, peer_key, state, at)
            SELECT to_key, from_key, 1, MIN(created_at) FROM dms WHERE from_key <> to_key GROUP BY to_key, from_key;
        """;

    /// <summary>The person's choice and when it was made; ("anyone", 0) when they never chose.</summary>
    public (string Who, long At) DmPrivacy(string accountKey) =>
        Query("SELECT who, at FROM dm_privacy WHERE account_key = $k;", r => (r.GetString(0), r.GetInt64(1)), ("$k", accountKey))
            .DefaultIfEmpty(("anyone", 0L)).First();

    /// <summary>Stores the choice if it's newer than the stored one. Returns what is stored afterwards.</summary>
    public (string Who, long At) SetDmPrivacy(string accountKey, string who, long at)
    {
        lock (_gate)
        {
            Exec("""
                INSERT INTO dm_privacy (account_key, who, at) VALUES ($k, $who, $at)
                ON CONFLICT(account_key) DO UPDATE SET who = excluded.who, at = excluded.at WHERE excluded.at > dm_privacy.at;
                """, ("$k", accountKey), ("$who", who), ("$at", at));
            return DmPrivacy(accountKey);
        }
    }

    /// <summary>How <paramref name="owner"/> treats DMs from <paramref name="peer"/>: null if nothing is recorded.</summary>
    public DmContactState? DmContact(string owner, string peer) =>
        Query("SELECT state FROM dm_contacts WHERE account_key = $o AND peer_key = $p;",
            r => (DmContactState?)(DmContactState)r.GetInt64(0), ("$o", owner), ("$p", peer)).FirstOrDefault();

    /// <summary>Records a first contact; an existing row stays as it is. Returns true if this call added it.</summary>
    public bool AddDmContact(string owner, string peer, DmContactState state, long now) =>
        Convert.ToInt64(Scalar("""
            INSERT INTO dm_contacts (account_key, peer_key, state, at) VALUES ($o, $p, $s, $now)
            ON CONFLICT(account_key, peer_key) DO NOTHING RETURNING 1;
            """, ("$o", owner), ("$p", peer), ("$s", (int)state), ("$now", now)) ?? 0L) == 1;

    /// <summary>Sets the state (accept, ignore, or "they wrote back"). Returns true if it changed.</summary>
    public bool SetDmContact(string owner, string peer, DmContactState state, long now) =>
        Convert.ToInt64(Scalar("""
            INSERT INTO dm_contacts (account_key, peer_key, state, at) VALUES ($o, $p, $s, $now)
            ON CONFLICT(account_key, peer_key) DO UPDATE SET state = excluded.state, at = excluded.at
            WHERE dm_contacts.state <> excluded.state RETURNING 1;
            """, ("$o", owner), ("$p", peer), ("$s", (int)state), ("$now", now)) ?? 0L) == 1;

    /// <summary>
    /// The requests (and ignored ones) waiting with <paramref name="owner"/>, newest message first, with the newest
    /// message id and time (0 when the messages are gone).
    /// </summary>
    public List<(string Peer, DmContactState State, long At, long LastId, long LastAt)> DmRequests(string owner, int limit) =>
        Query("""
            SELECT c.peer_key, c.state, c.at,
                   COALESCE((SELECT MAX(id) FROM dms WHERE from_key = c.peer_key AND to_key = c.account_key), 0) AS last_id,
                   COALESCE((SELECT MAX(created_at) FROM dms WHERE from_key = c.peer_key AND to_key = c.account_key), 0)
            FROM dm_contacts c WHERE c.account_key = $o AND c.state <> 1
            ORDER BY last_id DESC, c.at DESC LIMIT $limit;
            """, r => (r.GetString(0), (DmContactState)r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4)),
            ("$o", owner), ("$limit", limit));

    /// <summary>The people whose DMs <paramref name="owner"/> hasn't accepted (requests and ignored).</summary>
    public HashSet<string> DmUnaccepted(string owner) =>
        Query("SELECT peer_key FROM dm_contacts WHERE account_key = $o AND state <> 1;", r => r.GetString(0), ("$o", owner)).ToHashSet();
}
