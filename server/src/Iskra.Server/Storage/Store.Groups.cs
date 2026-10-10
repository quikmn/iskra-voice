using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>A group DM: its current member list (in join order) and the head of its signed change chain.</summary>
public sealed record GroupRecord(string Id, string CreatedBy, long CreatedAt, long Version, string Head, string[] Members);

/// <summary>One signed membership change, exactly as the member who made it sent it.</summary>
public sealed record GroupChangeRecord(long Version, string Payload, string Sig, long CreatedAt);

public sealed record GroupMessage(long Id, string GroupId, string From, long Version, string Envelope, long CreatedAt);

public sealed partial class Store
{
    internal const string GroupsMigration = """
        CREATE TABLE groups (
            id          TEXT PRIMARY KEY,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            version     INTEGER NOT NULL,
            head        TEXT NOT NULL,
            members     TEXT NOT NULL
        );
        CREATE TABLE group_members (
            group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            account_key TEXT NOT NULL,
            PRIMARY KEY (group_id, account_key)
        );
        CREATE INDEX group_members_by_account ON group_members(account_key);
        CREATE TABLE group_changes (
            group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            version     INTEGER NOT NULL,
            payload     TEXT NOT NULL,
            sig         TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (group_id, version)
        );
        CREATE TABLE group_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            from_key    TEXT NOT NULL,
            version     INTEGER NOT NULL,
            envelope    TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX group_messages_by_group ON group_messages(group_id, id);
        """;

    private const string GroupColumns = "id, created_by, created_at, version, head, members";

    private static GroupRecord ReadGroup(SqliteDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3), r.GetString(4), JsonSerializer.Deserialize<string[]>(r.GetString(5)) ?? []);

    public GroupRecord? GetGroup(string id) =>
        Query($"SELECT {GroupColumns} FROM groups WHERE id = $id;", ReadGroup, ("$id", id)).FirstOrDefault();

    /// <summary>Writes a new group, or the next change of an existing one, in one transaction. A group nobody is left in is deleted.</summary>
    public void SaveGroupChange(GroupRecord group, GroupChangeRecord change)
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
            if (group.Members.Length == 0)
            {
                Run("DELETE FROM groups WHERE id = $id;", ("$id", group.Id));
            }
            else
            {
                Run("""
                    INSERT INTO groups (id, created_by, created_at, version, head, members) VALUES ($id, $by, $at, $v, $head, $members)
                    ON CONFLICT(id) DO UPDATE SET version = excluded.version, head = excluded.head, members = excluded.members;
                    """, ("$id", group.Id), ("$by", group.CreatedBy), ("$at", group.CreatedAt), ("$v", group.Version), ("$head", group.Head),
                    ("$members", JsonSerializer.Serialize(group.Members)));
                Run("DELETE FROM group_members WHERE group_id = $id;", ("$id", group.Id));
                foreach (var member in group.Members)
                    Run("INSERT INTO group_members (group_id, account_key) VALUES ($id, $acc);", ("$id", group.Id), ("$acc", member));
                Run("INSERT INTO group_changes (group_id, version, payload, sig, created_at) VALUES ($id, $v, $p, $s, $at);",
                    ("$id", group.Id), ("$v", change.Version), ("$p", change.Payload), ("$s", change.Sig), ("$at", change.CreatedAt));
            }
            tx.Commit();
        }
    }

    /// <summary>Groups this account is in, with their newest message (if any), most recently active first.</summary>
    public List<(GroupRecord Group, long? LastId, long? LastAt)> GroupsOf(string accountKey) =>
        Query($"""
            SELECT g.id, g.created_by, g.created_at, g.version, g.head, g.members, MAX(m.id), MAX(m.created_at)
            FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.account_key = $acc
            LEFT JOIN group_messages m ON m.group_id = g.id
            GROUP BY g.id ORDER BY COALESCE(MAX(m.id), 0) DESC, g.created_at DESC LIMIT 200;
            """, r => (ReadGroup(r), NullableLong(r, 6), NullableLong(r, 7)), ("$acc", accountKey));

    public int GroupCount(string accountKey) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM group_members WHERE account_key = $acc;", ("$acc", accountKey)));

    /// <summary>The chain from <paramref name="afterVersion"/> on, oldest first.</summary>
    public List<GroupChangeRecord> GroupChanges(string groupId, long afterVersion) =>
        Query("SELECT version, payload, sig, created_at FROM group_changes WHERE group_id = $id AND version > $after ORDER BY version;",
            r => new GroupChangeRecord(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt64(3)), ("$id", groupId), ("$after", afterVersion));

    private const string GroupMessageColumns = "id, group_id, from_key, version, envelope, created_at";

    private static GroupMessage ReadGroupMessage(SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt64(3), r.GetString(4), r.GetInt64(5));

    public GroupMessage AddGroupMessage(string groupId, string from, long version, string envelope, long now)
    {
        var id = Convert.ToInt64(Scalar("""
            INSERT INTO group_messages (group_id, from_key, version, envelope, created_at) VALUES ($g, $from, $v, $env, $now) RETURNING id;
            """, ("$g", groupId), ("$from", from), ("$v", version), ("$env", envelope), ("$now", now)));
        return new GroupMessage(id, groupId, from, version, envelope, now);
    }

    /// <summary>A group's messages, oldest first (the newest page unless <paramref name="before"/> is given).</summary>
    public List<GroupMessage> GroupHistory(string groupId, long? before, int limit)
    {
        var rows = Query($"""
            SELECT {GroupMessageColumns} FROM group_messages WHERE group_id = $g AND id < $before ORDER BY id DESC LIMIT $limit;
            """, ReadGroupMessage, ("$g", groupId), ("$before", before ?? long.MaxValue), ("$limit", limit));
        rows.Reverse();
        return rows;
    }
}
