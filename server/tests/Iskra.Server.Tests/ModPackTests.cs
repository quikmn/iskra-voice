using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

/// <summary>Bulk delete, ban and delete recent messages, warnings, moderator notes, history, and people who left.</summary>
public class ModPackTests
{
    private static async Task<long> Send(User by, long channel, string text)
    {
        var reply = await by.RequestAsync("chat.send", new { channelId = channel, text });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("message").GetProperty("id").GetInt64();
    }

    /// <summary>A member who moderates through a custom role (manageMessages and the people powers), not an admin.</summary>
    private static async Task<User> Moderator(IskraServer server, User owner, string name)
    {
        var role = await owner.RequestAsync("role.create", new { name = "Mod " + name, permissions = new[] { "manageMessages", "timeoutMembers", "kickMembers", "banMembers" } });
        var mod = await server.JoinAsync(name);
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { role.Body().GetProperty("role").GetProperty("id").GetInt64() } });
        await mod.EventAsync("member.updated");
        return mod;
    }

    private static async Task<List<string?>> Actions(User by, string? action = null) =>
        (await by.RequestAsync("audit.list", new { action, limit = 100 })).Body().GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("action").GetString()).ToList();

    [Fact]
    public async Task Bulk_delete_removes_many_messages_with_one_audit_entry()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await Moderator(server, owner, "Mira");
        using var member = await server.JoinAsync("Sam");
        var a = await Send(member, server.General, "one");
        var b = await Send(member, server.General, "two");
        var c = await Send(member, server.General, "three");
        var ownerMessage = await Send(owner, server.General, "owner says");

        // Members can't; moderators can't touch people they don't outrank; and limits are checked.
        Assert.Equal("forbidden", (await member.RequestAsync("chat.delete.bulk", new { channelId = server.General, ids = new[] { a } })).ErrorCode());
        var rank = await mod.RequestAsync("chat.delete.bulk", new { channelId = server.General, ids = new[] { a, ownerMessage } });
        Assert.Equal("forbidden", rank.ErrorCode());
        Assert.Equal("bulk_delete_rank", rank.Body().GetProperty("key").GetString());
        Assert.Equal("bad_request", (await mod.RequestAsync("chat.delete.bulk", new { channelId = server.General, ids = Enumerable.Range(1, 101).Select(i => (long)i).ToArray() })).ErrorCode());
        Assert.Equal("bad_request", (await mod.RequestAsync("chat.delete.bulk", new { channelId = server.General, ids = Array.Empty<long>() })).ErrorCode());
        Assert.NotNull(server.World.Store.GetMessage(a)); // nothing went

        var deleted = await mod.RequestAsync("chat.delete.bulk", new { channelId = server.General, ids = new[] { a, b, 9_999L } });
        Assert.Equal(2, deleted.Body().GetProperty("deleted").GetInt32());
        var gone = new[] { (await member.EventAsync("chat.deleted")).Body().GetProperty("id").GetInt64(), (await member.EventAsync("chat.deleted")).Body().GetProperty("id").GetInt64() };
        Assert.Equal(new[] { a, b }.Order().ToArray(), gone.Order().ToArray());
        Assert.Null(server.World.Store.GetMessage(a));
        Assert.NotNull(server.World.Store.GetMessage(c));

        var entries = (await owner.RequestAsync("audit.list", new { action = "message.delete.bulk" })).Body().GetProperty("entries");
        var entry = Assert.Single(entries.EnumerateArray());
        Assert.Equal(2, entry.GetProperty("details").GetProperty("count").GetInt32());
        Assert.Equal("general", entry.GetProperty("details").GetProperty("channelName").GetString());
        Assert.Equal("Sam", entry.GetProperty("details").GetProperty("authors")[0].GetString());
        Assert.DoesNotContain("message.delete", await Actions(owner, "message.delete")); // not one per message
        // Already gone: nothing to do, no entry.
        Assert.Equal(0, (await mod.RequestAsync("chat.delete.bulk", new { channelId = server.General, ids = new[] { a } })).Body().GetProperty("deleted").GetInt32());
        Assert.Single((await owner.RequestAsync("audit.list", new { action = "message.delete.bulk" })).Body().GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task Ban_can_delete_recent_messages_and_reach_people_who_left()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var watcher = await server.JoinAsync("Watcher");
        using var troll = await server.JoinAsync("Troll");
        var first = await Send(troll, server.General, "spam 1");
        var second = await Send(troll, server.General, "spam 2");
        Assert.Equal("bad_request", (await owner.RequestAsync("member.ban", new { accountKey = troll.Key, deleteMessagesMs = 1234 })).ErrorCode());

        var banned = await owner.RequestAsync("member.ban", new { accountKey = troll.Key, reason = "spam", deleteMessagesMs = 86_400_000L });
        Assert.Equal(2, banned.Body().GetProperty("deletedMessages").GetInt32());
        var gone = new[] { (await watcher.EventAsync("chat.deleted")).Body().GetProperty("id").GetInt64(), (await watcher.EventAsync("chat.deleted")).Body().GetProperty("id").GetInt64() };
        Assert.Equal(new[] { first, second }.Order().ToArray(), gone.Order().ToArray());
        Assert.Equal(troll.Key, (await watcher.EventAsync("member.removed")).Body().GetProperty("accountKey").GetString());
        var entry = (await owner.RequestAsync("audit.list", new { action = "member.ban" })).Body().GetProperty("entries")[0];
        Assert.Equal(2, entry.GetProperty("details").GetProperty("deletedMessages").GetInt32());
        Assert.Equal("Troll", entry.GetProperty("targetName").GetString());

        // Someone who left on their own shows under "people who left", and can be banned from there.
        using var leaver = await server.JoinAsync("Leaver");
        await watcher.EventAsync("member.joined");
        Assert.Equal("result", (await leaver.RequestAsync("member.leave")).Type());
        await watcher.EventAsync("member.removed");
        Assert.Equal("forbidden", (await watcher.RequestAsync("member.departed")).ErrorCode());
        var people = (await owner.RequestAsync("member.departed")).Body().GetProperty("people").EnumerateArray().ToList();
        Assert.Equal(["Leaver", "Troll"], people.Select(p => p.GetProperty("name").GetString()));
        Assert.Equal("left", people[0].GetProperty("reason").GetString());
        Assert.False(people[0].GetProperty("banned").GetBoolean());
        Assert.Equal("banned", people[1].GetProperty("reason").GetString());
        Assert.Equal("Owner", people[1].GetProperty("byName").GetString());
        Assert.True(people[1].GetProperty("banned").GetBoolean());

        Assert.Equal("result", (await owner.RequestAsync("member.ban", new { accountKey = leaver.Key, reason = "after the fact" })).Type());
        Assert.True(server.World.Store.IsBanned(leaver.Key));
        Assert.True((await owner.RequestAsync("member.departed")).Body().GetProperty("people")[0].GetProperty("banned").GetBoolean());
        // A stranger nobody has seen can't be banned into existence.
        Assert.Equal("not_found", (await owner.RequestAsync("member.ban", new { accountKey = new TestIdentity().AccountKey })).ErrorCode());
    }

    [Fact]
    public async Task Warnings_notes_and_history_are_for_moderators_only()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await Moderator(server, owner, "Mira");
        using var other = await Moderator(server, owner, "Max");
        using var member = await server.JoinAsync("Sam");

        // A warning reaches the person, with the reason; the audit log keeps it.
        Assert.Equal("bad_request", (await mod.RequestAsync("member.warn", new { accountKey = member.Key, reason = "" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("member.warn", new { accountKey = mod.Key, reason = "no" })).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("member.warn", new { accountKey = owner.Key, reason = "no" })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("member.warn", new { accountKey = member.Key, reason = "Keep spoilers tagged" })).Type());
        var warned = (await member.EventAsync("member.warned")).Body();
        Assert.Equal("Keep spoilers tagged", warned.GetProperty("reason").GetString());
        Assert.Equal("Mira", warned.GetProperty("byName").GetString());

        // Notes: private to moderators, never the text in the audit log.
        Assert.Equal("forbidden", (await member.RequestAsync("member.notes.list", new { accountKey = member.Key })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("member.notes.add", new { accountKey = mod.Key, text = "hi" })).ErrorCode());
        var added = await mod.RequestAsync("member.notes.add", new { accountKey = member.Key, text = "Second warning about spoilers.\nNext one is a timeout." });
        Assert.Equal("result", added.Type());
        var note = added.Body().GetProperty("note");
        Assert.Equal("Mira", note.GetProperty("authorName").GetString());
        var listed = (await other.RequestAsync("member.notes.list", new { accountKey = member.Key })).Body().GetProperty("notes");
        Assert.Equal("Second warning about spoilers.\nNext one is a timeout.", listed[0].GetProperty("text").GetString());
        var noteEntry = (await owner.RequestAsync("audit.list", new { action = "member.note.add" })).Body().GetProperty("entries")[0];
        Assert.DoesNotContain("spoilers", noteEntry.GetRawText());
        Assert.Equal("Sam", noteEntry.GetProperty("targetName").GetString());
        // Only the author or an admin deletes a note.
        var id = note.GetProperty("id").GetInt64();
        Assert.Equal("forbidden", (await other.RequestAsync("member.notes.delete", new { id })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("member.notes.delete", new { id })).Type());
        Assert.Empty((await mod.RequestAsync("member.notes.list", new { accountKey = member.Key })).Body().GetProperty("notes").EnumerateArray());

        // History: the person's moderation record, without needing the activity log power.
        await mod.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 60_000 });
        Assert.Equal("forbidden", (await member.RequestAsync("member.history", new { accountKey = member.Key })).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("audit.list", new { })).ErrorCode()); // no viewAuditLog
        var history = (await mod.RequestAsync("member.history", new { accountKey = member.Key })).Body().GetProperty("entries").EnumerateArray()
            .Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Equal(["member.timeout", "member.warn", "member.join"], history); // notes aren't history; how they joined is
        // A departed person's notes and history stay readable.
        await owner.RequestAsync("member.kick", new { accountKey = member.Key });
        await mod.RequestAsync("member.notes.add", new { accountKey = member.Key, text = "Kicked for repeat spoilers" });
        Assert.Single((await mod.RequestAsync("member.notes.list", new { accountKey = member.Key })).Body().GetProperty("notes").EnumerateArray());
        Assert.Contains("member.kick", (await mod.RequestAsync("member.history", new { accountKey = member.Key })).Body().GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("action").GetString()));
    }

    [Fact]
    public async Task Notes_and_history_follow_rank_and_channel_access()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var mod = await Moderator(server, owner, "Mira");
        using var sam = await server.JoinAsync("Sam", "trusted");
        using var tia = await server.JoinAsync("Tia", "trusted");

        // Nothing about people who outrank you.
        Assert.Equal("result", (await owner.RequestAsync("member.notes.add", new { accountKey = admin.Key, text = "Ask before deleting channels." })).Type());
        Assert.Equal("rank_members", (await mod.RequestAsync("member.notes.list", new { accountKey = admin.Key })).Body().GetProperty("key").GetString());
        Assert.Equal("rank_members", (await mod.RequestAsync("member.history", new { accountKey = admin.Key })).Body().GetProperty("key").GetString());
        Assert.Equal("rank_members", (await mod.RequestAsync("member.history", new { accountKey = owner.Key })).Body().GetProperty("key").GetString());

        // A channel the moderator can't read: Sam's message there is deleted, and reported and resolved with a note.
        var hidden = (await owner.RequestAsync("channel.create", new { name = "hr-complaints", readRole = "trusted" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await mod.RequestAsync("chat.history", new { channelId = hidden })).ErrorCode());
        var reported = await Send(sam, hidden, "something");
        var report = (await tia.RequestAsync("report.create", new { messageId = reported, reason = "harassment" })).Body().GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("report.resolve", new { id = report, outcome = "deleted", note = "Talked to HR about it" })).Type());
        var deleted = await Send(sam, hidden, "something else");
        Assert.Equal("result", (await owner.RequestAsync("chat.delete", new { id = deleted })).Type());

        var seen = (await mod.RequestAsync("member.history", new { accountKey = sam.Key })).Body().GetProperty("entries").EnumerateArray().ToList();
        var deletion = seen.Single(e => e.GetProperty("action").GetString() == "message.delete");
        Assert.False(deletion.GetProperty("details").TryGetProperty("channelName", out _));
        Assert.False(deletion.GetProperty("details").TryGetProperty("channelId", out _));
        var resolution = seen.Single(e => e.GetProperty("action").GetString() == "report.resolve");
        Assert.Equal(JsonValueKind.Null, resolution.GetProperty("reason").ValueKind);
        Assert.False(resolution.GetProperty("details").TryGetProperty("reason", out _));
        Assert.DoesNotContain("hr-complaints", string.Join("", seen.Select(e => e.GetRawText())));
        Assert.DoesNotContain("HR", string.Join("", seen.Select(e => e.GetRawText())));

        // An admin with the activity log sees it all.
        var full = (await admin.RequestAsync("member.history", new { accountKey = sam.Key })).Body().GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal("hr-complaints", full.Single(e => e.GetProperty("action").GetString() == "message.delete").GetProperty("details").GetProperty("channelName").GetString());
        Assert.Equal("Talked to HR about it", full.Single(e => e.GetProperty("action").GetString() == "report.resolve").GetProperty("reason").GetString());
    }

    [Fact]
    public async Task A_moderator_cant_ban_someone_who_left_and_outranked_them()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await Moderator(server, owner, "Mira");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var sam = await server.JoinAsync("Sam");
        Assert.Equal("result", (await admin.RequestAsync("member.leave")).Type());
        Assert.Equal("result", (await sam.RequestAsync("member.leave")).Type());
        Assert.Equal("admin", server.World.Store.GetDeparture(admin.Key)!.Role);

        Assert.Equal("rank_members", (await mod.RequestAsync("member.ban", new { accountKey = admin.Key })).Body().GetProperty("key").GetString());
        Assert.Equal("rank_members", (await mod.RequestAsync("member.notes.list", new { accountKey = admin.Key })).Body().GetProperty("key").GetString());
        Assert.False(server.World.Store.IsBanned(admin.Key));
        Assert.Equal("result", (await mod.RequestAsync("member.ban", new { accountKey = sam.Key })).Type());
        Assert.Equal("result", (await owner.RequestAsync("member.ban", new { accountKey = admin.Key })).Type());

        // Someone who left before ranks were kept: admins only.
        server.World.Store.RecordDeparture("old-key", "Old", "left", null, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Assert.Equal("rank_members", (await mod.RequestAsync("member.ban", new { accountKey = "old-key" })).Body().GetProperty("key").GetString());
        Assert.Equal("result", (await owner.RequestAsync("member.ban", new { accountKey = "old-key" })).Type());
    }

    [Fact]
    public async Task People_who_left_are_forgotten_with_the_audit_log_after_90_days()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var store = server.World.Store;
        store.RecordDeparture("old-key", "Old", "left", null, now - (long)TimeSpan.FromDays(91).TotalMilliseconds);
        store.RecordDeparture("recent-key", "Recent", "kicked", owner.Key, now - (long)TimeSpan.FromDays(89).TotalMilliseconds);

        server.Services.GetServices<IHostedService>().OfType<ModerationSweeper>().Single().Sweep(pruneAudit: true);

        var people = (await owner.RequestAsync("member.departed")).Body().GetProperty("people").EnumerateArray().Select(p => p.GetProperty("name").GetString()).ToList();
        Assert.Equal(["Recent"], people);
    }
}
