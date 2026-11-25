using System.Globalization;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Task boards: a channel of kind "tasks" with tasks in three columns (to do, doing, done). A task has a title, a
/// description, people it is assigned to, a due day and labels; its comments are a thread (its id is the thread's id).
/// Reading follows the channel's read access; creating, editing, moving, assigning and archiving its write access.
/// Deleting a task is for whoever made it, the people it is assigned to, and moderators.
/// </summary>
public static class TaskFeature
{
    public const string Kind = "tasks";
    /// <summary>Tasks per board, archived ones included.</summary>
    public const int MaxTasksPerBoard = 500;
    public const int MaxDescriptionLength = ChatFeature.MaxMessageLength;
    public const int MaxAssignees = 10;
    public const int MaxLabelsPerTask = 5;
    public static readonly string[] Statuses = ["todo", "doing", "done"];

    public static void Register(Router router)
    {
        router.Add("task.list", List);
        router.Add("task.get", Get);
        router.Add("task.mine", Mine);
        router.Add("task.create", Create);
        router.Add("task.update", Update);
        router.Add("task.move", Move);
        router.Add("task.delete", Delete);
        router.Add("task.archiveDone", ArchiveDone);
        router.Add("task.labels.set", SetLabels);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// <summary>A task as apps see it. Lists leave the description out (<c>hasDescription</c> says whether there is one).</summary>
    public static object View(BoardTask t) => new
    {
        id = t.Id,
        channelId = t.BoardId,
        title = t.Title,
        description = t.Description,
        hasDescription = t.HasDescription,
        status = t.Status,
        rank = t.Rank,
        assignees = t.Assignees,
        labels = t.Labels,
        due = t.Due,
        createdBy = t.CreatedBy,
        createdAt = t.CreatedAt,
        updatedAt = t.UpdatedAt,
        archived = t.ArchivedAt is not null,
        comments = t.Comments,
    };

    private static void Updated(Session s, Channel board, BoardTask task) =>
        s.Hub.BroadcastToReaders(board, Frames.Event("task.updated", new { task = View(task) }));

    // ── Hooks from threads ───────────────────────────────────────────────────

    /// <summary>A task's thread is renamed and deleted with the task, not on its own.</summary>
    public static void CheckThreadChange(Session s, ThreadInfo thread)
    {
        if (s.World.Store.GetChannel(thread.ParentId) is { Kind: Kind })
            throw RequestException.BadRequest("Change the task instead of its thread.");
    }

    // ── Lookups and checks ───────────────────────────────────────────────────

    private static Channel ReadableBoard(Session s, Member me, long id)
    {
        var channel = ChatFeature.ReadableChannel(s, me, id);
        return channel.Kind == Kind ? channel : throw RequestException.BadRequest("That isn't a task board.");
    }

    /// <summary>A task the member can read (with its board); anything else is not found.</summary>
    private static (BoardTask Task, Channel Board) ReadableTask(Session s, Member me, long id)
    {
        var task = s.World.Store.GetTask(id) ?? throw RequestException.NotFound("Task");
        if (s.World.Store.GetChannel(task.BoardId) is not { Kind: Kind } board || !Permissions.CanRead(me, board)) throw RequestException.NotFound("Task");
        return (task, board);
    }

    private static void RequireWriter(Member me, Channel board)
    {
        if (!Permissions.CanWrite(me, board)) throw RequestException.Forbidden("You can't change tasks on this board.", "tasks_edit");
    }

    private static string Title(string raw) =>
        Text.Normalize(raw, ThreadFeature.MaxNameLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Task titles must be 1–{ThreadFeature.MaxNameLength} characters.", "task_title_length", new { max = ThreadFeature.MaxNameLength });

    /// <summary>The description as stored: the message rules, and it may be empty.</summary>
    private static string Description(string raw)
    {
        if (raw.Trim().Length == 0) return "";
        return Text.Normalize(raw, MaxDescriptionLength, allowNewlines: true)
            ?? throw RequestException.BadRequest($"Task descriptions can be up to {MaxDescriptionLength} characters.", "task_description_length", new { max = MaxDescriptionLength });
    }

    private static string Status(string raw) =>
        Statuses.Contains(raw) ? raw : throw RequestException.BadRequest("'status' must be todo, doing or done.");

    /// <summary>A calendar day, "YYYY-MM-DD".</summary>
    private static string Due(string raw) =>
        raw.Length == 10 && DateOnly.TryParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) && day.Year is >= 2000 and <= 2200
            ? raw : throw RequestException.BadRequest("'due' must be a day like 2026-12-31.");

    /// <summary>People a task can be assigned to: members who can see the board.</summary>
    private static List<string> Assignees(Session s, Channel board, Body body)
    {
        var keys = body.OptionalStringArray("assignees", MaxAssignees * 4, 64).Distinct(StringComparer.Ordinal).ToList();
        if (keys.Count > MaxAssignees)
            throw RequestException.BadRequest($"A task can be assigned to up to {MaxAssignees} people.", "task_assignees_max", new { max = MaxAssignees });
        foreach (var key in keys)
            if (s.World.Store.GetMember(key) is not { } member || !Permissions.CanRead(member, board))
                throw RequestException.BadRequest("Tasks can only be assigned to people who can see this board.", "task_assignee_access");
        return keys;
    }

    private static List<long> Labels(Session s, Channel board, Body body)
    {
        var element = body.OptionalElement("labels");
        if (element is null) return [];
        if (element.Value.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest("'labels' must be a list.");
        var known = s.World.Store.ForumTags(board.Id).Select(t => t.Id).ToHashSet();
        var labels = new List<long>();
        foreach (var item in element.Value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var id) || !known.Contains(id))
                throw RequestException.BadRequest("That label doesn't exist on this board.");
            if (!labels.Contains(id)) labels.Add(id);
        }
        if (labels.Count > MaxLabelsPerTask)
            throw RequestException.BadRequest($"A task can have up to {MaxLabelsPerTask} labels.", "task_labels_max", new { max = MaxLabelsPerTask });
        return labels;
    }

    /// <summary>Tells the people just assigned (never the one who did it, nor across a block): an event on their sessions and a push.</summary>
    private static void NotifyAssigned(Session s, Member me, Channel board, BoardTask task, IEnumerable<string> added)
    {
        var store = s.World.Store;
        foreach (var key in added)
        {
            if (key == me.AccountKey || store.EitherBlocked(key, me.AccountKey)) continue;
            s.Hub.SendToAccount(key, Frames.Event("task.assigned", new { task = View(task), by = me.AccountKey, at = s.Now }));
            if (store.IsBot(key)) continue;
            s.Push.Notify(key, new PushNote("task", $"task:{task.Id}", $"{me.Name} assigned you a task", task.Title, me.Name,
                ChannelId: board.Id, Coalesce: false, Task: task.Id, Text: new PushText("taskAssigned", null, new { name = me.Name })));
        }
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object List(Session s, Member me, Body body)
    {
        var board = ReadableBoard(s, me, body.Long("channelId"));
        var store = s.World.Store;
        return new
        {
            tasks = store.BoardTasks(board.Id, body.OptionalBool("archived") ?? false).Select(View),
            labels = store.ForumTags(board.Id).Select(ForumFeature.TagView),
        };
    }

    private static object Get(Session s, Member me, Body body)
    {
        var (task, _) = ReadableTask(s, me, body.Long("id"));
        return new { task = View(task) };
    }

    /// <summary>What is assigned to you and still to do, on boards you can see.</summary>
    private static object Mine(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var readable = new Dictionary<long, bool>();
        bool CanSee(long boardId)
        {
            if (!readable.TryGetValue(boardId, out var yes))
                readable[boardId] = yes = store.GetChannel(boardId) is { Kind: Kind } board && Permissions.CanRead(me, board);
            return yes;
        }
        return new
        {
            tasks = store.TasksAssignedTo(me.AccountKey).Where(a => CanSee(a.Task.BoardId))
                .Select(a => new { task = View(a.Task), by = a.AssignedBy, at = a.AssignedAt }),
        };
    }

    private static object Create(Session s, Member me, Body body)
    {
        var board = ReadableBoard(s, me, body.Long("channelId"));
        RequireWriter(me, board);
        var store = s.World.Store;
        var title = Title(body.String("title", ThreadFeature.MaxNameLength * 2));
        var description = body.OptionalString("description", MaxDescriptionLength * 2) is { } raw ? Description(raw) : "";
        var status = body.OptionalString("status", 16) is { } st ? Status(st) : Statuses[0];
        var due = body.OptionalString("due", 16) is { } d ? Due(d) : null;
        var assignees = Assignees(s, board, body);
        var labels = Labels(s, board, body);
        if (store.TaskCount(board.Id) >= MaxTasksPerBoard)
            throw RequestException.BadRequest($"A board can have up to {MaxTasksPerBoard} tasks. Delete some archived ones first.", "tasks_max", new { max = MaxTasksPerBoard });
        AutoModFeature.Check(s, me, board, title + "\n" + description, "task");

        var id = store.CreateTask(board, me.AccountKey, title, description, status, due, assignees, labels, s.Now);
        var task = store.GetTask(id)!;
        Updated(s, board, task);
        NotifyAssigned(s, me, board, task, assignees);
        return new { task = View(task) };
    }

    private static object Update(Session s, Member me, Body body)
    {
        var (task, board) = ReadableTask(s, me, body.Long("id"));
        RequireWriter(me, board);
        var store = s.World.Store;
        var title = body.OptionalString("title", ThreadFeature.MaxNameLength * 2) is { } rawTitle ? Title(rawTitle) : null;
        var description = body.OptionalString("description", MaxDescriptionLength * 2) is { } rawText ? Description(rawText) : null;
        var due = body.OptionalString("due", 16) is { } d ? Due(d) : null;
        var clearDue = body.IsNull("due");
        var archived = body.OptionalBool("archived");
        var assignees = body.Has("assignees") ? Assignees(s, board, body) : null;
        var labels = body.Has("labels") ? Labels(s, board, body) : null;
        if (title is null && description is null && due is null && !clearDue && archived is null && assignees is null && labels is null)
            throw RequestException.BadRequest("Nothing to change.", "nothing_to_change");
        if ((title is not null && title != task.Title) || (description is not null && description != task.Description))
            AutoModFeature.Check(s, me, board, (title ?? task.Title) + "\n" + (description ?? task.Description), "edit");

        store.UpdateTask(task.Id, title, description, due, clearDue, archived, s.Now);
        var added = assignees is null ? [] : store.SetTaskAssignees(task.Id, assignees, me.AccountKey, s.Now);
        if (labels is not null) store.SetTaskLabels(task.Id, labels, s.Now);
        var updated = store.GetTask(task.Id)!;
        Updated(s, board, updated);
        // The thread carries the title: lists of threads, notifications and search results show it.
        if (title is not null && title != task.Title && store.GetChannel(task.Id) is { } thread) ThreadFeature.Touched(s, thread);
        NotifyAssigned(s, me, board, updated, added);
        return new { task = View(updated) };
    }

    private static object Move(Session s, Member me, Body body)
    {
        var (task, board) = ReadableTask(s, me, body.Long("id"));
        RequireWriter(me, board);
        var store = s.World.Store;
        var status = Status(body.String("status", 16));
        if (task.ArchivedAt is not null) throw RequestException.BadRequest("Bring the task back to the board first.", "task_archived");
        var before = body.OptionalLong("before", min: 1);
        if (before is { } b && (b == task.Id || store.GetTask(b, withText: false) is not { ArchivedAt: null } other || other.BoardId != board.Id || other.Status != status))
            throw RequestException.BadRequest("'before' must be another task in that column.");

        var changed = store.MoveTask(task, status, before, s.Now);
        foreach (var id in changed.Where(id => id != task.Id))
            if (store.GetTask(id) is { } shifted) Updated(s, board, shifted);
        var moved = store.GetTask(task.Id)!;
        Updated(s, board, moved);
        return new { task = View(moved) };
    }

    /// <summary>Whoever made the task, the people it is assigned to, and moderators (who can pin there) delete it; all must be able to write.</summary>
    private static object? Delete(Session s, Member me, Body body)
    {
        var (task, board) = ReadableTask(s, me, body.Long("id"));
        RequireWriter(me, board);
        if (task.CreatedBy != me.AccountKey && !task.Assignees.Contains(me.AccountKey) && !Permissions.CanPin(me, board))
            throw RequestException.Forbidden("Only whoever made this task, the people it is assigned to, or a moderator can delete it.", "task_delete_owner");
        if (task.CreatedBy != me.AccountKey)
            Audit.Record(s, "task.delete", task.CreatedBy, details: new { channelId = board.Id, channelName = board.Name, taskId = task.Id, title = task.Title });
        s.World.Store.DeleteChannel(task.Id);
        s.Hub.BroadcastToReaders(board, Frames.Event("task.deleted", new { channelId = board.Id, id = task.Id }));
        // Apps drop the thread's messages and read state as for any deleted thread.
        s.Hub.BroadcastToReaders(board, Frames.Event("thread.deleted", new { id = task.Id, channelId = board.Id, rootId = -task.Id }));
        return null;
    }

    private static object ArchiveDone(Session s, Member me, Body body)
    {
        var board = ReadableBoard(s, me, body.Long("channelId"));
        RequireWriter(me, board);
        var ids = s.World.Store.ArchiveDoneTasks(board.Id, s.Now);
        if (ids.Count > 0) s.Hub.BroadcastToReaders(board, Frames.Event("task.archived", new { channelId = board.Id, ids }));
        return new { ids };
    }

    /// <summary>A board's labels are kept like a forum's tags, with the same rules and the same people allowed to change them.</summary>
    private static object SetLabels(Session s, Member me, Body body)
    {
        var board = ReadableBoard(s, me, body.Long("channelId"));
        if (!BaseRoles.Allows(me, BaseAbility.ForumTags)) throw RequestException.Forbidden("Only admins can change a board's labels.", "admins_task_labels");
        var labels = s.World.Store.SetForumTags(board.Id, ForumFeature.ParseTags(s, board, body.Element("labels"))).Select(ForumFeature.TagView).ToList();
        s.Hub.BroadcastToReaders(board, Frames.Event("task.labels", new { channelId = board.Id, labels }));
        return new { labels };
    }
}
