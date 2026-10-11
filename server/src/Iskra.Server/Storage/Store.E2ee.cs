using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>An end-to-end encrypted channel: the head of its signed membership chain and the members it lists.</summary>
public sealed record E2eeChannel(long ChannelId, string ChainId, long Version, string Head, string[] Members, long CreatedAt);

/// <summary>One signed membership change of an encrypted channel, exactly as sent.</summary>
public sealed record E2eeChange(long Version, string Payload, string Sig, string By, long CreatedAt);

/// <summary>A channel key envelope for one version (epoch), with the device keys it has a slot for.</summary>
public sealed record E2eeKey(long Id, long Version, string From, string[] Devices, string Envelope, long CreatedAt);

/// <summary>The ciphertext of a message in an encrypted channel and the chain version it was encrypted for.</summary>
public sealed record E2eeMessage(long MessageId, long Version, string Envelope);

public sealed partial class Store
{
    internal const string E2eeMigration = """
        CREATE TABLE e2ee_channels (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            chain_id    TEXT NOT NULL UNIQUE,
            version     INTEGER NOT NULL,
            head        TEXT NOT NULL,
            members     TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE e2ee_changes (
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            version     INTEGER NOT NULL,
            payload     TEXT NOT NULL,
            sig         TEXT NOT NULL,
            by_key      TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (channel_id, version)
        );
        CREATE TABLE e2ee_keys (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            version     INTEGER NOT NULL,
            from_key    TEXT NOT NULL,
            devices     TEXT NOT NULL,
            envelope    TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX e2ee_keys_by_channel ON e2ee_keys(channel_id, version);
        CREATE TABLE e2ee_messages (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            version     INTEGER NOT NULL,
            envelope    TEXT NOT NULL
        );
        """;

    private const string E2eeColumns = "channel_id, chain_id, version, head, members, created_at";

    private static E2eeChannel ReadE2ee(SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetInt64(2), r.GetString(3), JsonSerializer.Deserialize<string[]>(r.GetString(4)) ?? [], r.GetInt64(5));

    /// <summary>The encrypted channel behind a channel or thread (threads use their parent's chain), or null.</summary>
    public E2eeChannel? GetE2ee(long channelId) =>
        Query($"""
            SELECT {E2eeColumns} FROM e2ee_channels
            WHERE channel_id = COALESCE((SELECT parent_id FROM channels WHERE id = $id), $id);
            """, ReadE2ee, ("$id", channelId)).FirstOrDefault();

    public Dictionary<long, E2eeChannel> AllE2ee() =>
        Query($"SELECT {E2eeColumns} FROM e2ee_channels;", ReadE2ee).ToDictionary(e => e.ChannelId);

    /// <summary>
    /// Writes the next change (or the first, or a fresh chain replacing one nobody can read any more) and its first key
    /// envelopes, in one transaction.
    /// </summary>
    public void SaveE2eeChange(E2eeChannel channel, E2eeChange change, IEnumerable<(string[] Devices, string Envelope)> keys, bool fresh)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            void Run(string sql, params (string, object?)[] args)
            {
                using var cmd = Command(sql, args);
                cmd.Transaction = tx;
                cmd.ExecuteNonQuery();
            }
            if (fresh)
            {
                Run("DELETE FROM e2ee_changes WHERE channel_id = $c;", ("$c", channel.ChannelId));
                Run("DELETE FROM e2ee_keys WHERE channel_id = $c;", ("$c", channel.ChannelId));
            }
            Run($"""
                INSERT INTO e2ee_channels ({E2eeColumns}) VALUES ($c, $chain, $v, $head, $members, $at)
                ON CONFLICT(channel_id) DO UPDATE SET chain_id = excluded.chain_id, version = excluded.version, head = excluded.head,
                    members = excluded.members;
                """, ("$c", channel.ChannelId), ("$chain", channel.ChainId), ("$v", channel.Version), ("$head", channel.Head),
                ("$members", JsonSerializer.Serialize(channel.Members)), ("$at", channel.CreatedAt));
            Run("INSERT INTO e2ee_changes (channel_id, version, payload, sig, by_key, created_at) VALUES ($c, $v, $p, $s, $by, $at);",
                ("$c", channel.ChannelId), ("$v", change.Version), ("$p", change.Payload), ("$s", change.Sig), ("$by", change.By), ("$at", change.CreatedAt));
            foreach (var (devices, envelope) in keys)
                Run("INSERT INTO e2ee_keys (channel_id, version, from_key, devices, envelope, created_at) VALUES ($c, $v, $by, $d, $e, $at);",
                    ("$c", channel.ChannelId), ("$v", change.Version), ("$by", change.By), ("$d", string.Join(' ', devices)), ("$e", envelope),
                    ("$at", change.CreatedAt));
            tx.Commit();
        }
    }

    public List<E2eeChange> E2eeChanges(long channelId, long since) =>
        Query("SELECT version, payload, sig, by_key, created_at FROM e2ee_changes WHERE channel_id = $c AND version > $since ORDER BY version;",
            r => new E2eeChange(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4)), ("$c", channelId), ("$since", since));

    public E2eeChange? E2eeChangeAt(long channelId, long version) =>
        Query("SELECT version, payload, sig, by_key, created_at FROM e2ee_changes WHERE channel_id = $c AND version = $v;",
            r => new E2eeChange(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4)), ("$c", channelId), ("$v", version))
            .FirstOrDefault();

    public void AddE2eeKey(long channelId, long version, string from, string[] devices, string envelope, long now) =>
        Exec("INSERT INTO e2ee_keys (channel_id, version, from_key, devices, envelope, created_at) VALUES ($c, $v, $by, $d, $e, $at);",
            ("$c", channelId), ("$v", version), ("$by", from), ("$d", string.Join(' ', devices)), ("$e", envelope), ("$at", now));

    public int E2eeKeyCount(long channelId, long version) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM e2ee_keys WHERE channel_id = $c AND version = $v;", ("$c", channelId), ("$v", version)));

    /// <summary>Key envelopes from version <paramref name="since"/> on that have a slot for <paramref name="deviceKey"/>.</summary>
    public List<E2eeKey> E2eeKeysFor(long channelId, string deviceKey, long since, int limit) =>
        Query("""
            SELECT id, version, from_key, devices, envelope, created_at FROM e2ee_keys
            WHERE channel_id = $c AND version >= $since AND (' ' || devices || ' ') LIKE $d ESCAPE '\'
            ORDER BY version, id LIMIT $limit;
            """, r => new E2eeKey(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3).Split(' ', StringSplitOptions.RemoveEmptyEntries),
                r.GetString(4), r.GetInt64(5)),
            ("$c", channelId), ("$since", since), ("$d", "% " + deviceKey.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + " %"),
            ("$limit", limit));

    public void SaveE2eeMessage(long messageId, long version, string envelope) =>
        Exec("""
            INSERT INTO e2ee_messages (message_id, version, envelope) VALUES ($m, $v, $e)
            ON CONFLICT(message_id) DO UPDATE SET version = excluded.version, envelope = excluded.envelope;
            """, ("$m", messageId), ("$v", version), ("$e", envelope));

    public E2eeMessage? GetE2eeMessage(long messageId) =>
        Query("SELECT message_id, version, envelope FROM e2ee_messages WHERE message_id = $m;",
            r => new E2eeMessage(r.GetInt64(0), r.GetInt64(1), r.GetString(2)), ("$m", messageId)).FirstOrDefault();
}
