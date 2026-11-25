using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Iskra.Server.Storage;

/// <summary>
/// A task on a board. Its id is its thread's id (the comments are the thread's messages) and its title the thread's name.
/// <see cref="Description"/> is only loaded when asked for. <see cref="Due"/> is a calendar day, "YYYY-MM-DD".
/// </summary>
public sealed record BoardTask(long Id, long BoardId, string Title, string Status, double Rank, string? Due, long? ArchivedAt,
    string CreatedBy, long CreatedAt, long UpdatedAt, string[] Assignees, long[] Labels, int Comments, bool HasDescription)
{
    public string? Description { get; init; }
}

/// <summary>
/// Task boards: a channel of kind "tasks" whose tasks are threads (see Store.Threads), so comments, mentions, unread
/// counts and search work as in any thread. A task's thread has no first message: its <c>root_id</c> is minus its own id.
/// Labels are the board's forum tags (Store.Forums).
/// </summary>
public sealed partial class Store
{
    private const string TasksMigration = """
        CREATE TABLE tasks (
            task_id     INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            board_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            description TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL,
            rank        REAL NOT NULL,
            due         TEXT,
            archived_at INTEGER,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX tasks_by_board ON tasks(board_id, status, rank);
        CREATE TABLE task_assignees (
            task_id     INTEGER NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
            account_key TEXT NOT NULL,
            assigned_by TEXT NOT NULL,
            assigned_at INTEGER NOT NULL,
            PRIMARY KEY (task_id, account_key)
        );
        CREATE INDEX task_assignees_by_account ON task_assignees(account_key);
        CREATE TABLE task_labels (
            task_id     INTEGER NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
            tag_id      INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, tag_id)
        );
        """;

    /// <summary>Assignees are listed only while they are members; the earliest assigned first.</summary>
    private static string TaskSelect(bool withText) => $"""
        SELECT c.id, k.board_id, c.name, k.status, k.rank, k.due, k.archived_at, t.created_by, t.created_at, k.updated_at,
            (SELECT json_group_array(account_key) FROM (SELECT a.account_key FROM task_assignees a
                WHERE a.task_id = k.task_id AND a.account_key IN (SELECT account_key FROM members) ORDER BY a.assigned_at, a.account_key)),
            (SELECT json_group_array(tag_id) FROM task_labels WHERE task_id = k.task_id),
            (SELECT COUNT(*) FROM messages WHERE channel_id = c.id),
            k.description <> ''{(withText ? ", k.description" : "")}
        FROM tasks k JOIN channels c ON c.id = k.task_id JOIN threads t ON t.channel_id = c.id
        """;

    private static BoardTask ReadTask(SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetDouble(4), r.IsDBNull(5) ? null : r.GetString(5), NullableLong(r, 6),
            r.GetString(7), r.GetInt64(8), r.GetInt64(9),
            JsonSerializer.Deserialize<string[]>(r.GetString(10)) ?? [], JsonSerializer.Deserialize<long[]>(r.GetString(11)) ?? [],
            r.GetInt32(12), r.GetInt64(13) != 0);

    private static BoardTask ReadTaskWithText(SqliteDataReader r) => ReadTask(r) with { Description = r.GetString(14) };

    public BoardTask? GetTask(long id, bool withText = true) =>
        Query($"{TaskSelect(withText)} WHERE k.task_id = $id;", withText ? ReadTaskWithText : (Func<SqliteDataReader, BoardTask>)ReadTask, ("$id", id))
            .FirstOrDefault();

    /// <summary>A board's tasks without their descriptions: the ones on the board, or the archived ones (newest first).</summary>
    public List<BoardTask> BoardTasks(long boardId, bool archived) =>
        Query($"""
            {TaskSelect(false)} WHERE k.board_id = $b AND k.archived_at IS {(archived ? "NOT NULL" : "NULL")}
            ORDER BY {(archived ? "k.archived_at DESC, k.task_id DESC" : "k.rank, k.task_id")};
            """, ReadTask, ("$b", boardId));

    /// <summary>Every task of a board with its description, in board order, archived ones last (for exports).</summary>
    public List<BoardTask> ExportTasks(long boardId) =>
        Query($"{TaskSelect(true)} WHERE k.board_id = $b ORDER BY k.archived_at IS NOT NULL, k.status = 'done', k.status = 'doing', k.rank, k.task_id;",
            ReadTaskWithText, ("$b", boardId));

    /// <summary>Tasks assigned to this account that are still to do (not done, not archived), newest assignment first.</summary>
    public List<(BoardTask Task, string AssignedBy, long AssignedAt)> TasksAssignedTo(string accountKey) =>
        Query("""
            SELECT a.task_id, a.assigned_by, a.assigned_at FROM task_assignees a JOIN tasks k ON k.task_id = a.task_id
            WHERE a.account_key = $k AND k.archived_at IS NULL AND k.status <> 'done' ORDER BY a.assigned_at DESC, a.task_id DESC LIMIT 200;
            """, r => (Id: r.GetInt64(0), By: r.GetString(1), At: r.GetInt64(2)), ("$k", accountKey))
            .Select(a => (Task: GetTask(a.Id, withText: false), a.By, a.At)).Where(a => a.Task is not null)
            .Select(a => (a.Task!, a.By, a.At)).ToList();

    /// <summary>Every task of the board, archived ones included.</summary>
    public int TaskCount(long boardId) =>
        Convert.ToInt32(Scalar("SELECT COUNT(*) FROM tasks WHERE board_id = $b;", ("$b", boardId)));

    /// <summary>The thread and the task, written together, at the end of its column.</summary>
    public long CreateTask(Channel board, string authorKey, string title, string description, string status, string? due,
        IReadOnlyCollection<string> assignees, IReadOnlyCollection<long> labels, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            object? Run(string sql, params (string, object?)[] args)
            {
                using var cmd = Command(sql, args);
                cmd.Transaction = tx;
                return cmd.ExecuteScalar();
            }
            var id = Convert.ToInt64(Run($"""
                INSERT INTO channels (id, name, kind, position, read_role, write_role, created_at, parent_id)
                VALUES ({NextId("channels")}, $name, 'thread', 0, $read, $write, $now, $parent) RETURNING id;
                """, ("$name", title), ("$read", board.ReadRole), ("$write", board.WriteRole), ("$now", now), ("$parent", board.Id)));
            Run("INSERT INTO threads (channel_id, root_id, created_by, created_at) VALUES ($id, $root, $by, $now);",
                ("$id", id), ("$root", -id), ("$by", authorKey), ("$now", now));
            Run("""
                INSERT INTO tasks (task_id, board_id, description, status, rank, due, updated_at)
                VALUES ($id, $board, $text, $status,
                    (SELECT COALESCE(MAX(rank), 0) + 1 FROM tasks WHERE board_id = $board AND status = $status AND archived_at IS NULL), $due, $now);
                """, ("$id", id), ("$board", board.Id), ("$text", description), ("$status", status), ("$due", due), ("$now", now));
            foreach (var key in assignees)
                Run("INSERT INTO task_assignees (task_id, account_key, assigned_by, assigned_at) VALUES ($id, $k, $by, $now);",
                    ("$id", id), ("$k", key), ("$by", authorKey), ("$now", now));
            foreach (var label in labels) Run("INSERT INTO task_labels (task_id, tag_id) VALUES ($id, $tag);", ("$id", id), ("$tag", label));
            tx.Commit();
            return id;
        }
    }

    /// <summary>Changes what is given (null: left as it is; <paramref name="clearDue"/> removes the day).</summary>
    public void UpdateTask(long id, string? title, string? description, string? due, bool clearDue, bool? archived, long now)
    {
        lock (_gate)
        {
            if (title is not null) RenameThread(id, title);
            if (description is not null) Exec("UPDATE tasks SET description = $t WHERE task_id = $id;", ("$id", id), ("$t", description));
            if (due is not null || clearDue) Exec("UPDATE tasks SET due = $d WHERE task_id = $id;", ("$id", id), ("$d", clearDue ? null : due));
            if (archived == true) Exec("UPDATE tasks SET archived_at = COALESCE(archived_at, $now) WHERE task_id = $id;", ("$id", id), ("$now", now));
            // Back on the board: at the end of its column.
            if (archived == false)
                Exec("""
                    UPDATE tasks SET archived_at = NULL, rank = (SELECT COALESCE(MAX(o.rank), 0) + 1 FROM tasks o
                        WHERE o.board_id = tasks.board_id AND o.status = tasks.status AND o.archived_at IS NULL)
                    WHERE task_id = $id AND archived_at IS NOT NULL;
                    """, ("$id", id));
            Exec("UPDATE tasks SET updated_at = $now WHERE task_id = $id;", ("$id", id), ("$now", now));
        }
    }

    /// <summary>Replaces who the task is assigned to. Returns the people who were added.</summary>
    public List<string> SetTaskAssignees(long id, IReadOnlyCollection<string> assignees, string by, long now)
    {
        lock (_gate)
        {
            var current = Query("SELECT account_key FROM task_assignees WHERE task_id = $id;", r => r.GetString(0), ("$id", id)).ToHashSet(StringComparer.Ordinal);
            var added = assignees.Where(k => !current.Contains(k)).ToList();
            using var tx = _db.BeginTransaction();
            Run(tx, "DELETE FROM task_assignees WHERE task_id = $id AND account_key NOT IN (SELECT value FROM json_each($keep));",
                ("$id", id), ("$keep", JsonSerializer.Serialize(assignees)));
            foreach (var key in added)
                Run(tx, "INSERT INTO task_assignees (task_id, account_key, assigned_by, assigned_at) VALUES ($id, $k, $by, $now);",
                    ("$id", id), ("$k", key), ("$by", by), ("$now", now));
            Run(tx, "UPDATE tasks SET updated_at = $now WHERE task_id = $id;", ("$id", id), ("$now", now));
            tx.Commit();
            return added;
        }
    }

    public void SetTaskLabels(long id, IReadOnlyCollection<long> labels, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            Run(tx, "DELETE FROM task_labels WHERE task_id = $id;", ("$id", id));
            foreach (var label in labels) Run(tx, "INSERT INTO task_labels (task_id, tag_id) VALUES ($id, $tag);", ("$id", id), ("$tag", label));
            Run(tx, "UPDATE tasks SET updated_at = $now WHERE task_id = $id;", ("$id", id), ("$now", now));
            tx.Commit();
        }
    }

    /// <summary>
    /// Puts a task in a column, before <paramref name="beforeId"/> (null: last). Its rank becomes a value between its new
    /// neighbours, so only this task changes; when two neighbours have no room left between them the whole column is
    /// renumbered. Returns the ids whose rank changed.
    /// </summary>
    public List<long> MoveTask(BoardTask task, string status, long? beforeId, long now)
    {
        lock (_gate)
        {
            var column = Query("SELECT task_id, rank FROM tasks WHERE board_id = $b AND status = $s AND archived_at IS NULL AND task_id <> $id ORDER BY rank, task_id;",
                r => (Id: r.GetInt64(0), Rank: r.GetDouble(1)), ("$b", task.BoardId), ("$s", status), ("$id", task.Id));
            var at = beforeId is { } before ? column.FindIndex(c => c.Id == before) : -1;
            if (at < 0) at = column.Count;
            var below = at > 0 ? column[at - 1].Rank : (double?)null;
            var above = at < column.Count ? column[at].Rank : (double?)null;
            var rank = (below, above) switch
            {
                (null, null) => 1,
                (null, { } a) => a - 1,
                ({ } b, null) => b + 1,
                ({ } b, { } a) => (a + b) / 2,
            };
            using var tx = _db.BeginTransaction();
            var changed = new List<long> { task.Id };
            if (below is { } lo && above is { } hi && (rank <= lo || rank >= hi || hi - lo < 1e-6))
            {
                var order = column.Select(c => c.Id).ToList();
                order.Insert(at, task.Id);
                for (var i = 0; i < order.Count; i++)
                    Run(tx, "UPDATE tasks SET rank = $r WHERE task_id = $id;", ("$id", order[i]), ("$r", (double)(i + 1)));
                Run(tx, "UPDATE tasks SET status = $s, updated_at = $now WHERE task_id = $id;", ("$id", task.Id), ("$s", status), ("$now", now));
                changed = order;
            }
            else
            {
                Run(tx, "UPDATE tasks SET status = $s, rank = $r, updated_at = $now WHERE task_id = $id;",
                    ("$id", task.Id), ("$s", status), ("$r", rank), ("$now", now));
            }
            tx.Commit();
            return changed;
        }
    }

    /// <summary>Archives every done task on the board. Returns their ids.</summary>
    public List<long> ArchiveDoneTasks(long boardId, long now)
    {
        lock (_gate)
        {
            var ids = Query("SELECT task_id FROM tasks WHERE board_id = $b AND status = 'done' AND archived_at IS NULL;", r => r.GetInt64(0), ("$b", boardId));
            if (ids.Count > 0)
                Exec("UPDATE tasks SET archived_at = $now, updated_at = $now WHERE board_id = $b AND status = 'done' AND archived_at IS NULL;",
                    ("$b", boardId), ("$now", now));
            return ids;
        }
    }

    /// <summary>A deleted account: its assignments go, and tasks it assigned to others forget who did. Runs inside DeleteAccount.</summary>
    private const string TasksForgetAccount = """
        DELETE FROM task_assignees WHERE account_key = $k;
        UPDATE task_assignees SET assigned_by = '' WHERE assigned_by = $k;
        """;
}
