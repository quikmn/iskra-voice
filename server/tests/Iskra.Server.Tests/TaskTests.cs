using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class TaskTests
{
    private static long Board(IskraServer server, string name = "todo", string read = "member", string write = "member") =>
        server.World.Store.CreateChannel(name, "tasks", read, write, 0).Id;

    private static async Task<JsonElement> Create(User user, long channelId, string title, object? more = null)
    {
        var body = JsonSerializer.SerializeToNode(more ?? new { })!.AsObject();
        body["channelId"] = channelId;
        body["title"] = title;
        var reply = await user.RequestAsync("task.create", body);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("task");
    }

    private static long Id(JsonElement task) => task.GetProperty("id").GetInt64();

    private static string? Key(JsonElement error) => error.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    private static async Task<List<JsonElement>> Listed(User user, long channelId, bool archived = false) =>
        (await user.RequestAsync("task.list", new { channelId, archived })).Body().GetProperty("tasks").EnumerateArray().ToList();

    private static List<string> Titles(IEnumerable<JsonElement> tasks, string status) =>
        tasks.Where(t => t.GetProperty("status").GetString() == status).Select(t => t.GetProperty("title").GetString()!).ToList();

    private static List<string> Keys(JsonElement task) => task.GetProperty("assignees").EnumerateArray().Select(k => k.GetString()!).ToList();

    [Fact]
    public async Task A_board_holds_tasks_that_members_create_edit_and_see_live()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var channel = (await admin.RequestAsync("channel.create", new { name = "Raid prep", kind = "tasks" })).Body().GetProperty("channel");
        Assert.Equal("tasks", channel.GetProperty("kind").GetString());
        Assert.Equal("member", channel.GetProperty("writeRole").GetString());
        var board = channel.GetProperty("id").GetInt64();

        var task = await Create(alice, board, "  Book the venue ", new { description = "Ask **Mia** first.\r\n", due = "2026-12-24" });
        Assert.Equal("Book the venue", task.GetProperty("title").GetString());
        Assert.Equal("Ask **Mia** first.", task.GetProperty("description").GetString());
        Assert.Equal("todo", task.GetProperty("status").GetString());
        Assert.Equal("2026-12-24", task.GetProperty("due").GetString());
        Assert.Equal(alice.Key, task.GetProperty("createdBy").GetString());
        Assert.False(task.GetProperty("archived").GetBoolean());
        var seen = (await bob.EventAsync("task.updated")).Body().GetProperty("task");
        Assert.Equal(Id(task), Id(seen));
        Assert.Equal("Ask **Mia** first.", seen.GetProperty("description").GetString());
        await alice.EventAsync("task.updated"); // her own

        // Lists leave the description out; task.get has it.
        var listed = Assert.Single(await Listed(bob, board));
        Assert.Equal(JsonValueKind.Null, listed.GetProperty("description").ValueKind);
        Assert.True(listed.GetProperty("hasDescription").GetBoolean());
        Assert.Equal("Ask **Mia** first.", (await bob.RequestAsync("task.get", new { id = Id(task) })).Body().GetProperty("task").GetProperty("description").GetString());

        // Anyone who can write edits any task; each field on its own.
        var edited = (await bob.RequestAsync("task.update", new { id = Id(task), title = "Book a venue", description = "" })).Body().GetProperty("task");
        Assert.Equal("Book a venue", edited.GetProperty("title").GetString());
        Assert.Equal("", edited.GetProperty("description").GetString());
        Assert.Equal("2026-12-24", edited.GetProperty("due").GetString());
        Assert.Equal("Book a venue", (await alice.EventAsync("task.updated")).Body().GetProperty("task").GetProperty("title").GetString());
        var noDue = await bob.RequestAsync("task.update", JsonSerializer.Deserialize<JsonElement>($$"""{ "id": {{Id(task)}}, "due": null }"""));
        Assert.Equal(JsonValueKind.Null, noDue.Body().GetProperty("task").GetProperty("due").ValueKind);
        Assert.Equal("bad_request", (await bob.RequestAsync("task.update", new { id = Id(task) })).ErrorCode());

        // The board takes no messages itself, and other channels aren't boards.
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = board, text = "hi" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("task.list", new { channelId = server.General })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("task.create", new { channelId = server.General, title = "x" })).ErrorCode());
    }

    [Fact]
    public async Task Comments_are_the_tasks_thread()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var board = Board(server);
        var task = await Create(alice, board, "Order pizza");
        var id = Id(task);

        var thread = (await bob.RequestAsync("thread.get", new { id })).Body();
        Assert.Equal("Order pizza", thread.GetProperty("thread").GetProperty("name").GetString());
        Assert.Equal(board, thread.GetProperty("thread").GetProperty("channelId").GetInt64());
        Assert.Equal(JsonValueKind.Null, thread.GetProperty("root").ValueKind);

        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = id, text = "With pineapple?" })).Type());
        Assert.Equal("With pineapple?", (await alice.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        Assert.Equal(1, (await alice.EventAsync("thread.updated")).Body().GetProperty("thread").GetProperty("messageCount").GetInt32());
        await bob.EventAsync("thread.updated"); // his own
        Assert.Equal(1, Assert.Single(await Listed(alice, board)).GetProperty("comments").GetInt32());

        // A rename reaches the thread too; the thread itself can't be renamed or deleted.
        await alice.RequestAsync("task.update", new { id, title = "Order pizzas" });
        Assert.Equal("Order pizzas", (await bob.EventAsync("thread.updated")).Body().GetProperty("thread").GetProperty("name").GetString());
        Assert.Equal("bad_request", (await alice.RequestAsync("thread.update", new { id, name = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("thread.delete", new { id })).ErrorCode());
        Assert.NotNull(server.World.Store.GetTask(id));

        // Deleting the task deletes its comments.
        Assert.Equal("result", (await alice.RequestAsync("task.delete", new { id })).Type());
        Assert.Equal(id, (await bob.EventAsync("task.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Equal(id, (await bob.EventAsync("thread.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Equal("not_found", (await bob.RequestAsync("chat.history", new { channelId = id })).ErrorCode());
        Assert.Empty(await Listed(bob, board));
    }

    [Fact]
    public async Task People_who_cant_see_a_board_get_nothing_and_readers_cant_change_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var tess = await server.JoinAsync("Tess", "trusted");
        using var bob = await server.JoinAsync("Bob");
        using var guest = await server.JoinAsync("Gus", "guest");
        var staff = Board(server, "staff", "trusted", "trusted");
        var readOnly = Board(server, "roadmap", "member", "trusted");

        var secret = await Create(tess, staff, "Secret plan");
        await bob.NoEventAsync("task.updated");
        Assert.Equal("not_found", (await bob.RequestAsync("task.list", new { channelId = staff })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("task.get", new { id = Id(secret) })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("task.update", new { id = Id(secret), title = "x" })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("task.delete", new { id = Id(secret) })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("task.create", new { channelId = staff, title = "x" })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("chat.send", new { channelId = Id(secret), text = "x" })).ErrorCode());
        Assert.Equal("not_found", (await guest.RequestAsync("task.list", new { channelId = readOnly })).ErrorCode());

        // A read-only member sees the board and can't change anything on it.
        var plan = await Create(tess, readOnly, "Ship it");
        Assert.Equal(Id(plan), Id((await bob.EventAsync("task.updated")).Body().GetProperty("task")));
        Assert.Single(await Listed(bob, readOnly));
        foreach (var (type, body) in new (string, object)[]
        {
            ("task.create", new { channelId = readOnly, title = "Mine" }),
            ("task.update", new { id = Id(plan), title = "Mine" }),
            ("task.update", new { id = Id(plan), assignees = new[] { bob.Key } }),
            ("task.move", new { id = Id(plan), status = "done" }),
            ("task.delete", new { id = Id(plan) }),
            ("task.archiveDone", new { channelId = readOnly }),
        })
        {
            var refused = await bob.RequestAsync(type, body);
            Assert.Equal("forbidden", refused.ErrorCode());
            Assert.Equal("tasks_edit", Key(refused));
        }
        Assert.Equal("forbidden", (await bob.RequestAsync("chat.send", new { channelId = Id(plan), text = "x" })).ErrorCode());

        // Losing access hides it again.
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = readOnly, readRole = "trusted" })).Type());
        Assert.Equal("not_found", (await bob.RequestAsync("task.get", new { id = Id(plan) })).ErrorCode());
    }

    [Fact]
    public async Task Whoever_made_a_task_its_assignees_and_moderators_delete_it()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var tess = await server.JoinAsync("Tess", "trusted");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var board = Board(server);

        var mine = await Create(alice, board, "Mine");
        var assigned = await Create(alice, board, "For Bob", new { assignees = new[] { bob.Key } });
        var moderated = await Create(alice, board, "Spam");

        var refused = await carol.RequestAsync("task.delete", new { id = Id(mine) });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("task_delete_owner", Key(refused));
        Assert.Equal("forbidden", (await bob.RequestAsync("task.delete", new { id = Id(mine) })).ErrorCode());

        Assert.Equal("result", (await alice.RequestAsync("task.delete", new { id = Id(mine) })).Type());
        Assert.Equal("result", (await bob.RequestAsync("task.delete", new { id = Id(assigned) })).Type());
        Assert.Equal("result", (await tess.RequestAsync("task.delete", new { id = Id(moderated) })).Type());
        Assert.Empty(await Listed(carol, board));
        Assert.Equal("not_found", (await alice.RequestAsync("task.delete", new { id = Id(mine) })).ErrorCode());

        // Deleting someone else's task is in the audit log, with its title.
        var entries = (await owner.RequestAsync("audit.list", new { action = "task.delete" })).Body().GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal(2, entries.Count);
        Assert.Contains(entries, e => e.GetProperty("details").GetProperty("title").GetString() == "Spam" && e.GetProperty("actor").GetString() == tess.Key);
    }

    [Fact]
    public async Task Tasks_move_between_and_within_columns()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var board = Board(server);
        var a = Id(await Create(alice, board, "A"));
        var b = Id(await Create(alice, board, "B"));
        var c = Id(await Create(alice, board, "C"));
        var d = Id(await Create(alice, board, "D", new { status = "doing" }));
        Assert.Equal(["A", "B", "C"], Titles(await Listed(bob, board), "todo"));

        // To the top of its own column, then into another column before a task there, then to the end of a third.
        Assert.Equal("result", (await alice.RequestAsync("task.move", new { id = c, status = "todo", before = a })).Type());
        Assert.Equal(["C", "A", "B"], Titles(await Listed(bob, board), "todo"));
        var moved = (await bob.RequestAsync("task.move", new { id = a, status = "doing", before = d })).Body().GetProperty("task");
        Assert.Equal("doing", moved.GetProperty("status").GetString());
        await bob.RequestAsync("task.move", new { id = b, status = "done" });
        var all = await Listed(alice, board);
        Assert.Equal(["C"], Titles(all, "todo"));
        Assert.Equal(["A", "D"], Titles(all, "doing"));
        Assert.Equal(["B"], Titles(all, "done"));

        Assert.Equal("bad_request", (await alice.RequestAsync("task.move", new { id = a, status = "later" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("task.move", new { id = a, status = "doing", before = a })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("task.move", new { id = a, status = "doing", before = b })).ErrorCode()); // B is in another column

        // Putting tasks between the same two neighbours over and over never runs out of room: the order stays right.
        var store = server.World.Store;
        var renumbered = false;
        for (var i = 0; i < 70; i++)
            renumbered |= store.MoveTask(store.GetTask(i % 2 == 0 ? c : b)!, "doing", d, 1).Count > 1;
        Assert.True(renumbered);
        Assert.Equal(["A", "C", "B", "D"], Titles(await Listed(bob, board), "doing"));
    }

    [Fact]
    public async Task Being_assigned_tells_you_once_and_only_people_who_see_the_board_can_be()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var board = Board(server);
        var staff = Board(server, "staff", "trusted", "trusted");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        var endpoint = $"https://fcm.googleapis.com/fcm/send/bob-{Guid.NewGuid():N}";
        Assert.Equal("result", (await bob.RequestAsync("push.subscribe", new
        {
            endpoint, keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
        })).Type());

        // Assigning yourself tells nobody.
        var task = await Create(alice, board, "Bring snacks", new { assignees = new[] { alice.Key } });
        Assert.Equal([alice.Key], Keys(task));
        await alice.NoEventAsync("task.assigned");

        var updated = (await alice.RequestAsync("task.update", new { id = Id(task), assignees = new[] { alice.Key, bob.Key } })).Body().GetProperty("task");
        Assert.Equal([alice.Key, bob.Key], Keys(updated));
        var told = (await bob.EventAsync("task.assigned")).Body();
        Assert.Equal(Id(task), Id(told.GetProperty("task")));
        Assert.Equal(alice.Key, told.GetProperty("by").GetString());
        await carol.NoEventAsync("task.assigned");
        var push = (await server.Push.WaitForAsync(endpoint))[0];
        Assert.Equal("task", push.GetProperty("kind").GetString());
        Assert.Equal("Alice assigned you a task", push.GetProperty("title").GetString());
        Assert.Equal("Bring snacks", push.GetProperty("body").GetString());
        Assert.Equal(board, push.GetProperty("channelId").GetInt64());
        Assert.Equal(Id(task), push.GetProperty("task").GetInt64());
        Assert.Equal("taskAssigned", push.GetProperty("text").GetProperty("title").GetString());

        // Saving the same people again tells nobody again.
        await alice.RequestAsync("task.update", new { id = Id(task), assignees = new[] { bob.Key, alice.Key } });
        await bob.NoEventAsync("task.assigned");

        // What's assigned to me, until it is done.
        var mine = (await bob.RequestAsync("task.mine")).Body().GetProperty("tasks");
        var entry = Assert.Single(mine.EnumerateArray());
        Assert.Equal(Id(task), Id(entry.GetProperty("task")));
        Assert.Equal(alice.Key, entry.GetProperty("by").GetString());
        Assert.Empty((await carol.RequestAsync("task.mine")).Body().GetProperty("tasks").EnumerateArray());

        // Only members who can see the board, and not too many.
        var hidden = await Create(alice, staff, "Staff only");
        var refused = await alice.RequestAsync("task.update", new { id = Id(hidden), assignees = new[] { bob.Key } });
        Assert.Equal("bad_request", refused.ErrorCode());
        Assert.Equal("task_assignee_access", Key(refused));
        using var stranger = new TestIdentity();
        Assert.Equal("bad_request", (await alice.RequestAsync("task.update", new { id = Id(task), assignees = new[] { stranger.AccountKey } })).ErrorCode());

        // Unassigning yourself in one step; a done task is no longer on your list.
        var left = (await bob.RequestAsync("task.update", new { id = Id(task), assignees = new[] { alice.Key } })).Body().GetProperty("task");
        Assert.Equal([alice.Key], Keys(left));
        await bob.RequestAsync("task.update", new { id = Id(task), assignees = new[] { alice.Key, bob.Key } });
        await bob.RequestAsync("task.move", new { id = Id(task), status = "done" });
        Assert.Empty((await bob.RequestAsync("task.mine")).Body().GetProperty("tasks").EnumerateArray());
    }

    [Fact]
    public async Task Someone_who_leaves_is_no_longer_assigned()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var board = Board(server);
        var task = await Create(owner, board, "Water the plants", new { assignees = new[] { bob.Key, owner.Key } });
        Assert.Equal(2, Keys(task).Count);

        Assert.Equal("result", (await owner.RequestAsync("member.kick", new { accountKey = bob.Key })).Type());
        Assert.Equal([owner.Key], Keys(Assert.Single(await Listed(owner, board))));
    }

    [Fact]
    public async Task Limits_on_titles_descriptions_days_people_and_the_number_of_tasks()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var board = Board(server);

        var longTitle = await alice.RequestAsync("task.create", new { channelId = board, title = new string('x', 101) });
        Assert.Equal("bad_request", longTitle.ErrorCode());
        Assert.Equal("task_title_length", Key(longTitle));
        Assert.Equal("bad_request", (await alice.RequestAsync("task.create", new { channelId = board, title = "   " })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("task.create", new { channelId = board, title = "two\nlines" })).ErrorCode());
        var longText = await alice.RequestAsync("task.create", new { channelId = board, title = "x", description = new string('x', TaskFeature.MaxDescriptionLength + 1) });
        Assert.Equal("task_description_length", Key(longText));
        Assert.Equal("result", (await alice.RequestAsync("task.create", new { channelId = board, title = "x", description = new string('x', TaskFeature.MaxDescriptionLength) })).Type());
        foreach (var due in new[] { "tomorrow", "2026-13-01", "2026-02-30", "26-01-01", "1999-01-01" })
            Assert.Equal("bad_request", (await alice.RequestAsync("task.create", new { channelId = board, title = "x", due })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("task.create", new { channelId = board, title = "x", status = "later" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("task.create", new { channelId = board, title = "x", labels = new[] { 99 } })).ErrorCode());

        var crowd = Enumerable.Range(0, TaskFeature.MaxAssignees + 1).Select(_ => { using var id = new TestIdentity(); return id.AccountKey; }).ToArray();
        Assert.Equal("task_assignees_max", Key(await alice.RequestAsync("task.create", new { channelId = board, title = "x", assignees = crowd })));

        // A full board takes no more, archived tasks included.
        var store = server.World.Store;
        var channel = store.GetChannel(board)!;
        while (store.TaskCount(board) < TaskFeature.MaxTasksPerBoard) store.CreateTask(channel, alice.Key, "filler", "", "done", null, [], [], 0);
        store.ArchiveDoneTasks(board, 1);
        var full = await alice.RequestAsync("task.create", new { channelId = board, title = "One more" });
        Assert.Equal("bad_request", full.ErrorCode());
        Assert.Equal("tasks_max", Key(full));
        Assert.Equal(TaskFeature.MaxTasksPerBoard, full.Body().GetProperty("args").GetProperty("max").GetInt32());
        // The whole board still fits in one answer.
        Assert.Equal(TaskFeature.MaxTasksPerBoard - 1, (await Listed(alice, board, archived: true)).Count);
    }

    [Fact]
    public async Task Labels_are_set_by_admins_and_put_on_tasks_by_anyone_who_can_write()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var board = Board(server);

        Assert.Equal("admins_task_labels", Key(await alice.RequestAsync("task.labels.set", new { channelId = board, labels = new[] { new { name = "Bug" } } })));
        var set = await admin.RequestAsync("task.labels.set", new { channelId = board, labels = new object[] { new { name = "Bug", emoji = "🐛" }, new { name = "Idea" }, new { name = "L3" }, new { name = "L4" }, new { name = "L5" }, new { name = "L6" } } });
        Assert.Equal("result", set.Type());
        var labels = set.Body().GetProperty("labels").EnumerateArray().ToList();
        var (bug, idea) = (labels[0].GetProperty("id").GetInt64(), labels[1].GetProperty("id").GetInt64());
        Assert.Equal(6, (await alice.EventAsync("task.labels")).Body().GetProperty("labels").GetArrayLength());
        Assert.Equal(6, (await alice.RequestAsync("task.list", new { channelId = board })).Body().GetProperty("labels").GetArrayLength());

        var task = await Create(alice, board, "Crash on start", new { labels = new[] { bug, idea } });
        Assert.Equal([bug, idea], task.GetProperty("labels").EnumerateArray().Select(l => l.GetInt64()).Order());
        var one = (await alice.RequestAsync("task.update", new { id = Id(task), labels = new[] { idea } })).Body().GetProperty("task");
        Assert.Equal([idea], one.GetProperty("labels").EnumerateArray().Select(l => l.GetInt64()));
        Assert.Equal("task_labels_max", Key(await alice.RequestAsync("task.update", new { id = Id(task), labels = labels.Select(l => l.GetProperty("id").GetInt64()).ToArray() })));

        // A label taken off the board comes off its tasks. Another channel's labels aren't this board's.
        await admin.RequestAsync("task.labels.set", new { channelId = board, labels = new object[] { new { id = bug, name = "Bug" } } });
        Assert.Empty(Assert.Single(await Listed(alice, board)).GetProperty("labels").EnumerateArray());
        var other = Board(server, "other");
        Assert.Equal("bad_request", (await alice.RequestAsync("task.create", new { channelId = other, title = "x", labels = new[] { bug } })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("task.labels.set", new { channelId = server.General, labels = Array.Empty<object>() })).ErrorCode());
    }

    [Fact]
    public async Task Done_tasks_are_archived_and_can_come_back()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var board = Board(server);
        var open = Id(await Create(alice, board, "Open"));
        var done1 = Id(await Create(alice, board, "Done 1", new { status = "done" }));
        var done2 = Id(await Create(alice, board, "Done 2", new { status = "done" }));

        var ids = (await alice.RequestAsync("task.archiveDone", new { channelId = board })).Body().GetProperty("ids").EnumerateArray().Select(i => i.GetInt64()).Order().ToList();
        Assert.Equal([done1, done2], ids);
        Assert.Equal(2, (await bob.EventAsync("task.archived")).Body().GetProperty("ids").GetArrayLength());
        Assert.Equal(["Open"], (await Listed(bob, board)).Select(t => t.GetProperty("title").GetString()));
        Assert.Equal(2, (await Listed(bob, board, archived: true)).Count);
        Assert.Empty((await alice.RequestAsync("task.archiveDone", new { channelId = board })).Body().GetProperty("ids").EnumerateArray());

        // One task on its own, either way; an archived task stays where it is until it's back.
        Assert.True((await bob.RequestAsync("task.update", new { id = open, archived = true })).Body().GetProperty("task").GetProperty("archived").GetBoolean());
        Assert.Equal("task_archived", Key(await bob.RequestAsync("task.move", new { id = open, status = "doing" })));
        var back = (await bob.RequestAsync("task.update", new { id = done1, archived = false })).Body().GetProperty("task");
        Assert.False(back.GetProperty("archived").GetBoolean());
        Assert.Equal(["Done 1"], (await Listed(alice, board)).Select(t => t.GetProperty("title").GetString()));
    }

    [Fact]
    public async Task A_timed_out_member_reads_the_board_and_changes_nothing()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var board = Board(server);
        var task = await Create(bob, board, "Mine");
        await owner.RequestAsync("member.timeout", new { accountKey = bob.Key, durationMs = 60_000 });

        Assert.Single(await Listed(bob, board));
        Assert.Equal("result", (await bob.RequestAsync("task.get", new { id = Id(task) })).Type());
        Assert.Equal("result", (await bob.RequestAsync("task.mine")).Type());
        foreach (var (type, body) in new (string, object)[]
        {
            ("task.create", new { channelId = board, title = "x" }), ("task.update", new { id = Id(task), title = "x" }),
            ("task.move", new { id = Id(task), status = "done" }), ("task.delete", new { id = Id(task) }), ("task.archiveDone", new { channelId = board }),
        })
            Assert.Equal("timed_out", Key(await bob.RequestAsync(type, body)));
    }

    [Fact]
    public async Task Tasks_are_in_the_channel_export_and_in_my_data_and_go_with_their_board()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var board = Board(server, "Chores");
        var label = (await owner.RequestAsync("task.labels.set", new { channelId = board, labels = new[] { new { name = "Home" } } }))
            .Body().GetProperty("labels")[0].GetProperty("id").GetInt64();
        var task = await Create(bob, board, "Take out <the> bins", new { description = "Every **Monday**.", due = "2026-12-07", assignees = new[] { bob.Key }, labels = new[] { label } });
        await owner.RequestAsync("chat.send", new { channelId = Id(task), text = "Glass too." });

        var started = await owner.RequestAsync("channel.export", new { channelIds = new[] { board } });
        Assert.Equal("result", started.Type());
        var jobId = started.Body().GetProperty("job").GetProperty("id").GetString();
        JsonElement job = default;
        for (var until = DateTime.UtcNow.AddSeconds(15); DateTime.UtcNow < until; await Task.Delay(50))
        {
            job = (await owner.RequestAsync("channel.export.status")).Body().GetProperty("jobs").EnumerateArray().Single(j => j.GetProperty("id").GetString() == jobId);
            if (job.GetProperty("state").GetString() != "running") break;
        }
        Assert.Equal("done", job.GetProperty("state").GetString());
        using var response = await server.CreateClient().GetAsync(job.GetProperty("url").GetString());
        using var zip = new System.IO.Compression.ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()));
        string Read(string suffix)
        {
            using var reader = new StreamReader(zip.Entries.Single(e => e.FullName.EndsWith(suffix)).Open(), Encoding.UTF8);
            return reader.ReadToEnd();
        }
        var exported = JsonDocument.Parse(Read(".json")).RootElement;
        var item = Assert.Single(exported.GetProperty("tasks").EnumerateArray());
        Assert.Equal("Take out <the> bins", item.GetProperty("title").GetString());
        Assert.Equal("Every **Monday**.", item.GetProperty("description").GetString());
        Assert.Equal("todo", item.GetProperty("status").GetString());
        Assert.Equal("2026-12-07", item.GetProperty("due").GetString());
        Assert.Equal("Home", item.GetProperty("labels")[0].GetString());
        Assert.Single(item.GetProperty("assignees").EnumerateArray());
        Assert.Equal("Glass too.", Assert.Single(item.GetProperty("comments").EnumerateArray()).GetProperty("text").GetString());
        Assert.Empty(exported.GetProperty("threads").EnumerateArray());
        var html = Read(".html");
        Assert.Contains("Take out &lt;the&gt; bins", html);
        Assert.Contains("<strong>Monday</strong>", html);
        Assert.Contains("Assigned to Bob", html);
        Assert.Contains("Glass too.", html);

        var data = await ComplianceTests.Download(server, (await bob.RequestAsync("data.export")).Body());
        Assert.Equal("Every **Monday**.", Assert.Single(data.GetProperty("tasks").EnumerateArray()).GetProperty("description").GetString());
        Assert.Equal(bob.Key, Assert.Single(data.GetProperty("taskAssignments").EnumerateArray()).GetProperty("account_key").GetString());

        // Deleting the board deletes its tasks and their comments.
        Assert.Equal("result", (await owner.RequestAsync("channel.delete", new { id = board })).Type());
        Assert.Null(server.World.Store.GetTask(Id(task)));
        Assert.Null(server.World.Store.GetChannel(Id(task)));
        Assert.Empty((await bob.RequestAsync("task.mine")).Body().GetProperty("tasks").EnumerateArray());
    }
}
