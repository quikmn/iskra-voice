namespace Iskra.Server.Storage;

/// <summary>An account's signed request to be deleted (see "Deleting an account" in PROTOCOL.md). Kept so the key can't come back.</summary>
public sealed record AccountDeletion(string AccountKey, long DeletedAt, bool Messages, string Sig);

public sealed partial class Store
{
    private const string AccountsMigration = """
        CREATE TABLE account_deletions (
            account_key TEXT PRIMARY KEY,
            deleted_at  INTEGER NOT NULL,
            messages    INTEGER NOT NULL,
            sig         TEXT NOT NULL,
            applied_at  INTEGER NOT NULL
        );
        """;

    public AccountDeletion? GetDeletion(string accountKey) =>
        Query("SELECT account_key, deleted_at, messages, sig FROM account_deletions WHERE account_key = $k;",
            r => new AccountDeletion(r.GetString(0), r.GetInt64(1), r.GetInt64(2) != 0, r.GetString(3)), ("$k", accountKey)).FirstOrDefault();

    /// <summary>Messages the account wrote (id and channel), for telling threads and forums about a deletion.</summary>
    public List<(long Id, long ChannelId)> MessagesBy(string accountKey) =>
        Query("SELECT id, channel_id FROM messages WHERE author_key = $k;", r => (r.GetInt64(0), r.GetInt64(1)), ("$k", accountKey));

    /// <summary>
    /// Deletes everything this server keeps about the account, in one transaction: membership, roles, nickname, profile and
    /// profile page, presence, settings, block list, devices, prekeys, push subscriptions, its end-to-end encrypted DMs and group
    /// messages (ciphertext), DM file access, and its invites stop working. Names in the audit log and the key log, IP addresses in
    /// the security log and the account as reporter are removed; bans and reports about it stay. With <see cref="AccountDeletion.Messages"/>, its messages, reactions and votes go too,
    /// and its docs revisions go or lose its name.
    /// Group membership is a signed chain: the app leaves its groups (signed) before deleting.
    /// </summary>
    public void DeleteAccount(AccountDeletion deletion, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            var k = ("$k", (object?)deletion.AccountKey);
            Run(tx, """
                DELETE FROM members WHERE account_key = $k;
                DELETE FROM member_roles WHERE account_key = $k;
                DELETE FROM nicknames WHERE account_key = $k;
                DELETE FROM profiles WHERE account_key = $k;
                DELETE FROM profile_pages WHERE account_key = $k;
                DELETE FROM presence WHERE account_key = $k;
                DELETE FROM account_prefs WHERE account_key = $k;
                DELETE FROM notify_settings WHERE account_key = $k;
                DELETE FROM alert_settings WHERE account_key = $k;
                DELETE FROM timeouts WHERE account_key = $k;
                DELETE FROM rules_accepted WHERE account_key = $k;
                DELETE FROM send_nonces WHERE account_key = $k;
                DELETE FROM envelope_send_nonces WHERE account_key = $k;
                DELETE FROM blocks WHERE account_key = $k;
                DELETE FROM bot_dm_prefs WHERE account_key = $k;
                DELETE FROM bot_dm_peers WHERE account_key = $k OR bot_key = $k;
                DELETE FROM event_interest WHERE account_key = $k;
                DELETE FROM lfg_members WHERE account_key = $k;
                DELETE FROM lfg_notify WHERE account_key = $k;
                DELETE FROM stage_moderators WHERE account_key = $k;
                DELETE FROM push_subscriptions WHERE account_key = $k;
                DELETE FROM prekeys WHERE device_key IN (SELECT device_key FROM devices WHERE account_key = $k);
                DELETE FROM devices WHERE account_key = $k;
                DELETE FROM device_revocations WHERE account_key = $k;
                DELETE FROM rotation_handovers WHERE new_key = $k;
                DELETE FROM dms WHERE from_key = $k OR to_key = $k;
                DELETE FROM dm_file_access WHERE account_key = $k;
                DELETE FROM dm_files WHERE uploader = $k;
                DELETE FROM group_messages WHERE from_key = $k;
                DELETE FROM reminders WHERE account_key = $k;
                DELETE FROM scheduled_messages WHERE account_key = $k OR peer_key = $k;
                DELETE FROM inbox_items WHERE account_key = $k;
                DELETE FROM message_edits WHERE message_id IN (SELECT id FROM messages WHERE author_key = $k);
                UPDATE invites SET revoked = 1 WHERE created_by = $k;
                UPDATE audit_log SET actor_name = '' WHERE actor = $k;
                UPDATE audit_log SET target_name = NULL WHERE target = $k;
                UPDATE security_log SET ip = NULL WHERE account_key = $k;
                UPDATE reports SET reporter_key = NULL, reporter_name = '' WHERE reporter_key = $k;
                UPDATE reports SET target_name = '' WHERE target_key = $k;
                """, k);
            if (deletion.Messages)
                Run(tx, """
                    DELETE FROM messages WHERE author_key = $k;
                    DELETE FROM reactions WHERE account_key = $k;
                    DELETE FROM poll_votes WHERE account_key = $k;
                    """, k);
            if (deletion.Messages) Run(tx, DocsForgetAuthor, k); // docs pages stay (they're shared); see Store.Docs.cs
            Run(tx, KeyLogForgetNames, k); // the key log keeps its entries (the chain), not the names; see Store.KeyLog.cs
            Run(tx, """
                INSERT INTO account_deletions (account_key, deleted_at, messages, sig, applied_at) VALUES ($k, $at, $m, $sig, $now)
                ON CONFLICT(account_key) DO NOTHING;
                """, k, ("$at", deletion.DeletedAt), ("$m", deletion.Messages ? 1 : 0), ("$sig", deletion.Sig), ("$now", now));
            tx.Commit();
        }
        _bots = null;
    }

    /// <summary>The owner hands the server to another member and becomes an admin.</summary>
    public void TransferOwnership(string from, string to)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            Run(tx, "UPDATE members SET role = 'owner' WHERE account_key = $to; UPDATE members SET role = 'admin' WHERE account_key = $from;",
                ("$to", to), ("$from", from));
            tx.Commit();
        }
    }
}
