namespace Iskra.Server.Storage;

public sealed record Category(long Id, string Name, int Position);

/// <summary>A member's notification choice for the whole server (ChannelId 0) or one channel. MutedUntil: ms, -1 = until turned off.</summary>
public sealed record NotifySetting(long ChannelId, string? Level, long? MutedUntil);

/// <summary>Organizing a server: channel categories and order, nicknames, and per-member notification settings.</summary>
public sealed partial class Store
{
    private const string OrganizeMigration = """
        CREATE TABLE categories (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            position    INTEGER NOT NULL
        );
        ALTER TABLE channels ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
        CREATE TABLE nicknames (
            account_key TEXT PRIMARY KEY,
            nick        TEXT NOT NULL
        );
        CREATE TABLE notify_settings (
            account_key TEXT NOT NULL,
            channel_id  INTEGER NOT NULL,
            level       TEXT,
            muted_until INTEGER,
            PRIMARY KEY (account_key, channel_id)
        );
        CREATE INDEX notify_by_level ON notify_settings(level) WHERE level IS NOT NULL;
        CREATE TRIGGER organize_member_gone AFTER DELETE ON members BEGIN
            DELETE FROM nicknames WHERE account_key = old.account_key;
            DELETE FROM notify_settings WHERE account_key = old.account_key;
        END;
        CREATE TRIGGER organize_channel_gone AFTER DELETE ON channels BEGIN
            DELETE FROM notify_settings WHERE channel_id = old.id;
        END;
        """;

    // ── Categories ───────────────────────────────────────────────────────────

    public List<Category> AllCategories() =>
        Query("SELECT id, name, position FROM categories ORDER BY position, id;", r => new Category(r.GetInt64(0), r.GetString(1), r.GetInt32(2)));

    public Category? GetCategory(long id) => AllCategories().FirstOrDefault(c => c.Id == id);

    public int CountCategories() => Convert.ToInt32(Scalar("SELECT COUNT(*) FROM categories;"));

    public Category CreateCategory(string name)
    {
        lock (_gate)
        {
            var position = Convert.ToInt32(Scalar("SELECT COALESCE(MAX(position), -1) + 1 FROM categories;"));
            var id = Convert.ToInt64(Scalar($"INSERT INTO categories (id, name, position) VALUES ({NextId("categories")}, $name, $pos) RETURNING id;", ("$name", name), ("$pos", position)));
            return new Category(id, name, position);
        }
    }

    public void RenameCategory(long id, string name) =>
        Exec("UPDATE categories SET name = $name WHERE id = $id;", ("$id", id), ("$name", name));

    /// <summary>Deletes a category; its channels become uncategorized (ON DELETE SET NULL).</summary>
    public void DeleteCategory(long id) => Exec("DELETE FROM categories WHERE id = $id;", ("$id", id));

    /// <summary>Moves a category before another one (or to the end) and renumbers them all.</summary>
    public void MoveCategory(long id, long? beforeId)
    {
        lock (_gate)
        {
            var ids = AllCategories().Select(c => c.Id).Where(c => c != id).ToList();
            var at = beforeId is { } b ? ids.IndexOf(b) : -1;
            ids.Insert(at < 0 ? ids.Count : at, id);
            Renumber("categories", ids);
        }
    }

    /// <summary>
    /// Puts a channel into a category (null: uncategorized), before <paramref name="beforeId"/> or after the
    /// category's last channel, and renumbers every channel so positions stay unique.
    /// </summary>
    public void MoveChannel(long id, long? categoryId, long? beforeId)
    {
        lock (_gate)
        {
            var all = AllChannels().Where(c => c.Id != id).ToList();
            int at;
            if (beforeId is { } b) at = all.FindIndex(c => c.Id == b);
            else
            {
                var last = all.FindLastIndex(c => c.CategoryId == categoryId);
                at = last < 0 ? all.Count : last + 1;
            }
            var ids = all.Select(c => c.Id).ToList();
            ids.Insert(at < 0 ? ids.Count : at, id);
            Exec("UPDATE channels SET category_id = $cat WHERE id = $id;", ("$id", id), ("$cat", categoryId));
            Renumber("channels", ids);
        }
    }

    public void SetChannelCategory(long id, long? categoryId) =>
        Exec("UPDATE channels SET category_id = $cat WHERE id = $id;", ("$id", id), ("$cat", categoryId));

    private void Renumber(string table, List<long> ids)
    {
        using var tx = _db.BeginTransaction();
        for (var i = 0; i < ids.Count; i++)
        {
            using var cmd = Command($"UPDATE {table} SET position = $pos WHERE id = $id;", [("$pos", i), ("$id", ids[i])]);
            cmd.Transaction = tx;
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    // ── Nicknames ────────────────────────────────────────────────────────────

    public string? GetNickname(string accountKey) =>
        Scalar("SELECT nick FROM nicknames WHERE account_key = $key;", ("$key", accountKey)) as string;

    /// <summary>Sets a nickname, or removes it with null.</summary>
    public void SetNickname(string accountKey, string? nick)
    {
        if (nick is null) Exec("DELETE FROM nicknames WHERE account_key = $key;", ("$key", accountKey));
        else Exec("INSERT INTO nicknames (account_key, nick) VALUES ($key, $nick) ON CONFLICT(account_key) DO UPDATE SET nick = excluded.nick;",
            ("$key", accountKey), ("$nick", nick));
    }

    /// <summary>The name shown for a member on this server: their nickname, else their profile name.</summary>
    public string DisplayName(Member member) => GetNickname(member.AccountKey) ?? member.Name;

    // ── Notification settings ────────────────────────────────────────────────

    private static NotifySetting ReadNotify(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.IsDBNull(1) ? null : r.GetString(1), NullableLong(r, 2));

    public List<NotifySetting> NotifySettings(string accountKey) =>
        Query("SELECT channel_id, level, muted_until FROM notify_settings WHERE account_key = $key ORDER BY channel_id;",
            ReadNotify, ("$key", accountKey));

    /// <summary>Stores a setting; a row with nothing left in it is removed.</summary>
    public void SaveNotifySetting(string accountKey, NotifySetting setting)
    {
        if (setting.Level is null && setting.MutedUntil is null)
            Exec("DELETE FROM notify_settings WHERE account_key = $key AND channel_id = $ch;", ("$key", accountKey), ("$ch", setting.ChannelId));
        else Exec("""
            INSERT INTO notify_settings (account_key, channel_id, level, muted_until) VALUES ($key, $ch, $level, $until)
            ON CONFLICT(account_key, channel_id) DO UPDATE SET level = excluded.level, muted_until = excluded.muted_until;
            """, ("$key", accountKey), ("$ch", setting.ChannelId), ("$level", setting.Level), ("$until", setting.MutedUntil));
    }

    /// <summary>Accounts that chose "all messages" somewhere (the only ones a plain message can push to).</summary>
    public List<string> AccountsWithLevel(string level) =>
        Query("SELECT DISTINCT account_key FROM notify_settings WHERE level = $level;", r => r.GetString(0), ("$level", level));

    /// <summary>The channel whose settings apply: a thread's parent, else the channel itself.</summary>
    public long SettingsChannelOf(long channelId) =>
        Convert.ToInt64(Scalar("SELECT COALESCE(parent_id, id) FROM channels WHERE id = $id;", ("$id", channelId)) ?? channelId);
}

public sealed record ForwardInfo(long SourceChannelId, long SourceMessageId, long SourceCreatedAt);

/// <summary>Forwarded messages and per-account preferences (opaque, client-encrypted blobs).</summary>
public sealed partial class Store
{
    private const string Organize2Migration = """
        CREATE TABLE message_forwards (
            message_id      INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            source_channel  INTEGER NOT NULL,
            source_message  INTEGER NOT NULL,
            source_created  INTEGER NOT NULL
        );
        CREATE TABLE account_prefs (
            account_key TEXT NOT NULL,
            name        TEXT NOT NULL,
            data        TEXT NOT NULL,
            updated_at  INTEGER NOT NULL,
            PRIMARY KEY (account_key, name)
        );
        CREATE TRIGGER organize_prefs_gone AFTER DELETE ON members BEGIN
            DELETE FROM account_prefs WHERE account_key = old.account_key;
        END;
        """;

    public void AddForward(long messageId, ForwardInfo info) =>
        Exec("INSERT INTO message_forwards (message_id, source_channel, source_message, source_created) VALUES ($id, $ch, $msg, $at);",
            ("$id", messageId), ("$ch", info.SourceChannelId), ("$msg", info.SourceMessageId), ("$at", info.SourceCreatedAt));

    public ForwardInfo? GetForward(long messageId) =>
        Query("SELECT source_channel, source_message, source_created FROM message_forwards WHERE message_id = $id;",
            r => new ForwardInfo(r.GetInt64(0), r.GetInt64(1), r.GetInt64(2)), ("$id", messageId)).FirstOrDefault();

    public (string Data, long UpdatedAt)? GetPref(string accountKey, string name) =>
        Query("SELECT data, updated_at FROM account_prefs WHERE account_key = $key AND name = $name;",
            r => ((string Data, long UpdatedAt)?)(r.GetString(0), r.GetInt64(1)), ("$key", accountKey), ("$name", name)).FirstOrDefault();

    public int CountPrefs(string accountKey) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM account_prefs WHERE account_key = $key;", ("$key", accountKey)));

    public void SetPref(string accountKey, string name, string data, long updatedAt) =>
        Exec("""
            INSERT INTO account_prefs (account_key, name, data, updated_at) VALUES ($key, $name, $data, $at)
            ON CONFLICT(account_key, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at;
            """, ("$key", accountKey), ("$name", name), ("$data", data), ("$at", updatedAt));
}
