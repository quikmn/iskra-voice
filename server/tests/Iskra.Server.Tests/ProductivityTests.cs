using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

/// <summary>Edit history, reminders, scheduled messages and the mention inbox.</summary>
public class ProductivityTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Stands in for data sealed by the app (the server only checks it looks like ciphertext).</summary>
    private static string Sealed() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(64));

    private static async Task<long> SayAsync(User user, long channelId, string text, long? replyTo = null)
    {
        var reply = await user.RequestAsync("chat.send", new { channelId, text, replyTo });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("message").GetProperty("id").GetInt64();
    }

    private static object Subscription(string endpoint)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        return new { endpoint, keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) } };
    }

    // ── Edit history ─────────────────────────────────────────────────────────

    [Fact]
    public async Task Edits_keep_earlier_versions_for_the_author_and_moderators_only()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = await SayAsync(alice, server.General, "first");
        Assert.Equal("result", (await alice.RequestAsync("chat.edit", new { id, text = "second" })).Type());
        Assert.Equal("result", (await alice.RequestAsync("chat.edit", new { id, text = "third" })).Type());
        // Saving the same text again isn't a new version.
        Assert.Equal("result", (await alice.RequestAsync("chat.edit", new { id, text = "third" })).Type());

        var versions = (await alice.RequestAsync("chat.edits", new { id })).Body().GetProperty("versions");
        Assert.Equal(["first", "second"], versions.EnumerateArray().Select(v => v.GetProperty("text").GetString()));
        Assert.True(versions[0].GetProperty("at").GetInt64() <= versions[1].GetProperty("at").GetInt64());
        Assert.Equal(2, (await admin.RequestAsync("chat.edits", new { id })).Body().GetProperty("versions").GetArrayLength());
        Assert.Equal("forbidden", (await bob.RequestAsync("chat.edits", new { id })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("chat.edits", new { id = 999_999 })).ErrorCode());

        // Deleting the message deletes its history.
        Assert.Equal("result", (await alice.RequestAsync("chat.delete", new { id })).Type());
        Assert.Empty(server.World.Store.MessageVersions(id));
    }

    [Fact]
    public async Task Edit_history_is_capped_and_hidden_from_people_who_cant_read_the_channel()
    {
        using var server = new IskraServer();
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var id = await SayAsync(admin, staff, "v0");
        for (var i = 1; i <= EditHistoryFeature.MaxVersions + 3; i++) await admin.RequestAsync("chat.edit", new { id, text = $"v{i}" });
        var versions = (await admin.RequestAsync("chat.edits", new { id })).Body().GetProperty("versions");
        Assert.Equal(EditHistoryFeature.MaxVersions, versions.GetArrayLength());
        Assert.Equal($"v{EditHistoryFeature.MaxVersions + 2}", versions[EditHistoryFeature.MaxVersions - 1].GetProperty("text").GetString());
        Assert.Equal("not_found", (await member.RequestAsync("chat.edits", new { id })).ErrorCode());
    }

    // ── Reminders ────────────────────────────────────────────────────────────

    [Fact]
    public async Task A_reminder_fires_in_the_app_and_by_push_at_its_time()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = $"https://fcm.googleapis.com/fcm/send/alice-{Guid.NewGuid():N}";
        Assert.Equal("result", (await alice.RequestAsync("push.subscribe", Subscription(endpoint))).Type());
        var id = await SayAsync(bob, server.General, "don't forget the pizza");

        var created = await alice.RequestAsync("reminder.create", new { dueAt = Now + 1200, data = Sealed(), messageId = id });
        var reminder = created.Body().GetProperty("reminder");
        Assert.Equal(server.General, reminder.GetProperty("channelId").GetInt64());
        Assert.Equal(JsonValueKind.Null, reminder.GetProperty("firedAt").ValueKind);
        var reminderId = reminder.GetProperty("id").GetInt64();

        var due = (await alice.EventAsync("reminder.due")).Body().GetProperty("reminder");
        Assert.Equal(reminderId, due.GetProperty("id").GetInt64());
        Assert.NotEqual(JsonValueKind.Null, due.GetProperty("firedAt").ValueKind);
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("reminder", push.GetProperty("kind").GetString());
        Assert.Equal(reminderId, push.GetProperty("reminder").GetInt64());
        Assert.Contains("pizza", push.GetProperty("body").GetString());
        await bob.NoEventAsync("reminder.due");

        // Still listed (fired) until it's done; a snooze makes it pending again.
        var listed = (await alice.RequestAsync("reminder.list")).Body().GetProperty("reminders");
        Assert.NotEqual(JsonValueKind.Null, listed[0].GetProperty("firedAt").ValueKind);
        var snoozed = (await alice.RequestAsync("reminder.update", new { id = reminderId, dueAt = Now + 3_600_000 })).Body().GetProperty("reminder");
        Assert.Equal(JsonValueKind.Null, snoozed.GetProperty("firedAt").ValueKind);
        Assert.Equal("result", (await alice.RequestAsync("reminder.delete", new { id = reminderId })).Type());
        Assert.Empty(server.World.Store.Reminders(alice.Key));
    }

    [Fact]
    public async Task Reminders_are_private_checked_and_capped()
    {
        using var server = new IskraServer();
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");
        var secret = await SayAsync(admin, staff, "secret");

        Assert.Equal("bad_request", (await alice.RequestAsync("reminder.create", new { dueAt = Now + 60_000, data = "not sealed" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("reminder.create", new { dueAt = Now - 3_600_000, data = Sealed() })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("reminder.create", new { dueAt = Now + 400L * 86_400_000, data = Sealed() })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("reminder.create", new { dueAt = Now + 60_000, data = Sealed(), messageId = secret })).ErrorCode());

        // A DM reminder: only a time and sealed data.
        var mine = (await alice.RequestAsync("reminder.create", new { dueAt = Now + 60_000, data = Sealed() })).Body().GetProperty("reminder");
        Assert.Equal(JsonValueKind.Null, mine.GetProperty("messageId").ValueKind);
        var id = mine.GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await bob.RequestAsync("reminder.delete", new { id })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("reminder.update", new { id, dueAt = Now + 1000 })).ErrorCode());
        Assert.Equal(0, (await bob.RequestAsync("reminder.list")).Body().GetProperty("reminders").GetArrayLength());

        for (var i = 1; i < ReminderFeature.MaxPerAccount; i++) server.World.Store.AddReminder(alice.Key, Now + 60_000, Sealed(), null, null, Now);
        Assert.Equal("bad_request", (await alice.RequestAsync("reminder.create", new { dueAt = Now + 60_000, data = Sealed() })).ErrorCode());
    }

    [Fact]
    public async Task A_reminder_for_someone_who_left_is_dropped()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        server.World.Store.AddReminder("x" + alice.Key[1..], Now - 1, Sealed(), null, null, Now);
        await Task.Delay(1500);
        Assert.Empty(server.World.Store.Reminders("x" + alice.Key[1..]));
    }

    // ── Scheduled messages ───────────────────────────────────────────────────

    [Fact]
    public async Task A_scheduled_channel_message_is_sent_as_its_author_at_its_time()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var reply = await alice.RequestAsync("scheduled.create", new { channelId = server.General, text = "good morning!", sendAt = Now + 1200 });
        var scheduled = reply.Body().GetProperty("scheduled");
        Assert.Equal("pending", scheduled.GetProperty("status").GetString());
        Assert.Equal("channel", scheduled.GetProperty("kind").GetString());
        await bob.NoEventAsync("chat.message");

        var message = (await bob.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("good morning!", message.GetProperty("text").GetString());
        Assert.Equal(alice.Key, message.GetProperty("author").GetString());
        var gone = (await alice.EventAsync("scheduled.deleted")).Body();
        Assert.True(gone.GetProperty("sent").GetBoolean());
        Assert.Equal(0, (await alice.RequestAsync("scheduled.list")).Body().GetProperty("scheduled").GetArrayLength());
    }

    [Fact]
    public async Task Scheduled_messages_follow_the_rules_when_they_are_sent()
    {
        using var server = new IskraServer();
        var news = server.World.Store.CreateChannel("news", "text", "member", "admin", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var admin = await server.JoinAsync("Admin", "admin");
        var endpoint = $"https://fcm.googleapis.com/fcm/send/alice-{Guid.NewGuid():N}";
        Assert.Equal("result", (await alice.RequestAsync("push.subscribe", Subscription(endpoint))).Type());

        // Not allowed to write there now: refused right away.
        Assert.Equal("forbidden", (await alice.RequestAsync("scheduled.create", new { channelId = news, text = "hi", sendAt = Now + 60_000 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("scheduled.create", new { channelId = server.General, text = "hi", sendAt = Now + 100L * 86_400_000 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("scheduled.create", new { text = "hi", sendAt = Now + 60_000 })).ErrorCode());

        // Allowed when scheduled, timed out when it's due: it fails, and Alice is told in the app and by push.
        var id = (await alice.RequestAsync("scheduled.create", new { channelId = server.General, text = "later", sendAt = Now + 1500 }))
            .Body().GetProperty("scheduled").GetProperty("id").GetInt64();
        Assert.Equal("result", (await admin.RequestAsync("member.timeout", new { accountKey = alice.Key, durationMs = 60_000 })).Type());
        JsonElement failed;
        do failed = (await alice.EventAsync("scheduled.updated")).Body().GetProperty("scheduled");
        while (failed.GetProperty("status").GetString() != "failed");
        Assert.Equal(id, failed.GetProperty("id").GetInt64());
        Assert.Contains("timed out", failed.GetProperty("error").GetString());
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("scheduled", push.GetProperty("kind").GetString());
        await admin.NoEventAsync("chat.message");

        // Once the timeout is over, "send now" sends it.
        Assert.Equal("result", (await admin.RequestAsync("member.timeout.remove", new { accountKey = alice.Key })).Type());
        var sent = await alice.RequestAsync("scheduled.send", new { id });
        Assert.Equal("later", sent.Body().GetProperty("message").GetProperty("text").GetString());
        Assert.Equal(0, (await alice.RequestAsync("scheduled.list")).Body().GetProperty("scheduled").GetArrayLength());
    }

    [Fact]
    public async Task Scheduled_messages_due_at_once_go_out_at_chat_sends_pace()
    {
        // Security review L10: 50 with the same time used to post in one tick, around chat.send's burst of 10.
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var at = Now + 1500;
        for (var i = 0; i < 16; i++)
            server.World.Store.AddScheduled(new(0, alice.Key, "channel", server.General, null, null, null, $"burst {i}", null, null, at, Now, "pending", null));
        int Sent() => server.World.Store.MessagesBy(alice.Key).Count;

        await alice.EventAsync("scheduled.deleted");
        await Task.Delay(400); // the rest of that tick
        Assert.InRange(Sent(), 1, 12); // the burst (plus at most a tick's refill), not all 16
        // None are lost: the rest follow on the next ticks.
        for (var waited = 0; Sent() < 16 && waited < 10_000; waited += 100) await Task.Delay(100);
        Assert.Equal(16, Sent());
        Assert.Equal(0, server.World.Store.CountScheduled(alice.Key));

        // "Send now" shares the allowance.
        for (var i = 0; i < 12; i++)
            server.World.Store.AddScheduled(new(0, alice.Key, "channel", server.General, null, null, null, $"later {i}", null, null, Now + 3_600_000, Now, "pending", null));
        var codes = new List<string>();
        foreach (var m in server.World.Store.ScheduledOf(alice.Key))
        {
            var reply = await alice.RequestAsync("scheduled.send", new { id = m.Id });
            codes.Add(reply.Type() == "result" ? "result" : reply.ErrorCode()!);
        }
        Assert.Contains("rate_limited", codes);
    }

    [Fact]
    public async Task Scheduled_messages_can_be_edited_rescheduled_and_deleted_by_their_author_only()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = (await alice.RequestAsync("scheduled.create", new { channelId = server.General, text = "draft", sendAt = Now + 3_600_000 }))
            .Body().GetProperty("scheduled").GetProperty("id").GetInt64();
        var updated = (await alice.RequestAsync("scheduled.update", new { id, text = "final", sendAt = Now + 7_200_000 })).Body().GetProperty("scheduled");
        Assert.Equal("final", updated.GetProperty("text").GetString());
        Assert.Equal("not_found", (await bob.RequestAsync("scheduled.update", new { id, text = "hacked" })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("scheduled.send", new { id })).ErrorCode());
        Assert.Equal("not_found", (await bob.RequestAsync("scheduled.delete", new { id })).ErrorCode());
        Assert.Equal(0, (await bob.RequestAsync("scheduled.list")).Body().GetProperty("scheduled").GetArrayLength());
        Assert.Equal("result", (await alice.RequestAsync("scheduled.delete", new { id })).Type());
        Assert.Equal(0, (await alice.RequestAsync("scheduled.list")).Body().GetProperty("scheduled").GetArrayLength());

        for (var i = 0; i < ScheduledFeature.MaxPerAccount; i++)
            server.World.Store.AddScheduled(new(0, alice.Key, "channel", server.General, null, null, null, "x", null, null, Now + 3_600_000, Now, "pending", null));
        Assert.Equal("bad_request", (await alice.RequestAsync("scheduled.create", new { channelId = server.General, text = "one more", sendAt = Now + 60_000 })).ErrorCode());
    }

    [Fact]
    public async Task A_scheduled_dm_delivers_the_envelope_made_when_it_was_scheduled()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var envelope = new { v = 2, ct = "sealed-for-bob" };
        Assert.Equal("bad_request", (await alice.RequestAsync("scheduled.create", new { accountKey = bob.Key, envelope, sendAt = Now + 40L * 86_400_000 })).ErrorCode());
        var scheduled = (await alice.RequestAsync("scheduled.create", new { accountKey = bob.Key, envelope, sendAt = Now + 1200 })).Body().GetProperty("scheduled");
        Assert.Equal("dm", scheduled.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, scheduled.GetProperty("text").ValueKind);

        var dm = (await bob.EventAsync("dm.message")).Body().GetProperty("message");
        Assert.Equal(alice.Key, dm.GetProperty("from").GetString());
        Assert.Equal("sealed-for-bob", dm.GetProperty("envelope").GetProperty("ct").GetString());
        Assert.True((await alice.EventAsync("scheduled.deleted")).Body().GetProperty("sent").GetBoolean());
    }

    [Fact]
    public async Task A_scheduled_dm_or_group_message_interrupted_by_a_crash_is_not_sent_twice()
    {
        // Security review L11: a crash between the send and removing the row resent it after the restart.
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dave = await server.JoinAsync("Dave");
        var groupId = GroupTests.NewId();
        var group = await GroupTests.CreateAsync(alice, groupId, bob, carol);
        var dm = (await alice.RequestAsync("scheduled.create", new { accountKey = bob.Key, envelope = new { v = 2, ct = "once" }, sendAt = Now + 1200 }))
            .Body().GetProperty("scheduled");
        var inGroup = (await alice.RequestAsync("scheduled.create", new { groupId, version = 1, envelope = new { v = 2, kind = "group", ct = "once" }, sendAt = Now + 1200 }))
            .Body().GetProperty("scheduled");
        await bob.EventAsync("dm.message");
        await carol.EventAsync("group.message");
        for (var i = 0; i < 2; i++) await alice.EventAsync("scheduled.deleted");

        // As if the server stopped right after sending, before the rows were removed (and the group changed meanwhile).
        Assert.Equal("result", (await bob.RequestAsync("group.change",
            GroupTests.Change(bob, groupId, 2, group.GetProperty("head").GetString()!, "add", [dave.Key], [alice.Key, bob.Key, carol.Key, dave.Key]))).Type());
        using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(server.WorldPath, "iskra.db"), Pooling = false }.ToString()))
        {
            db.Open();
            foreach (var row in new[] { dm, inGroup })
            {
                using var cmd = db.CreateCommand();
                cmd.CommandText = """
                    INSERT INTO scheduled_messages (id, account_key, kind, peer_key, group_id, group_version, envelope, send_at, created_at, status)
                    VALUES ($id, $a, $kind, $p, $g, $gv, $e, $at, $at, 'sending');
                    """;
                cmd.Parameters.AddWithValue("$id", row.GetProperty("id").GetInt64());
                cmd.Parameters.AddWithValue("$a", alice.Key);
                cmd.Parameters.AddWithValue("$kind", row.GetProperty("kind").GetString());
                cmd.Parameters.AddWithValue("$p", (object?)(row.GetProperty("accountKey").GetString()) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$g", (object?)(row.GetProperty("groupId").GetString()) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$gv", row.GetProperty("version").ValueKind == JsonValueKind.Number ? row.GetProperty("version").GetInt64() : DBNull.Value);
                cmd.Parameters.AddWithValue("$e", row.GetProperty("envelope").GetRawText());
                cmd.Parameters.AddWithValue("$at", row.GetProperty("sendAt").GetInt64());
                cmd.ExecuteNonQuery();
            }
        }
        server.World.Store.ResetSendingScheduled(); // what the scheduler does when it starts

        for (var i = 0; i < 2; i++) Assert.True((await alice.EventAsync("scheduled.deleted")).Body().GetProperty("sent").GetBoolean());
        await bob.NoEventAsync("dm.message");
        await carol.NoEventAsync("group.message");
        Assert.Single(server.World.Store.DmHistory(alice.Key, bob.Key, null, 10));
        Assert.Single(server.World.Store.GroupHistory(groupId, null, 10));
        Assert.Equal(0, server.World.Store.CountScheduled(alice.Key));
    }

    [Fact]
    public async Task A_scheduled_group_message_fails_if_the_group_changed()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dave = await server.JoinAsync("Dave");
        var id = GroupTests.NewId();
        var group = await GroupTests.CreateAsync(alice, id, bob, carol);
        var envelope = new { v = 2, kind = "group", ct = "x" };
        Assert.Equal("conflict", (await alice.RequestAsync("scheduled.create", new { groupId = id, version = 2, envelope, sendAt = Now + 60_000 })).ErrorCode());
        Assert.Equal("not_found", (await dave.RequestAsync("scheduled.create", new { groupId = id, version = 1, envelope, sendAt = Now + 60_000 })).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("scheduled.create", new { groupId = id, version = 1, envelope, sendAt = Now + 2000 })).Type());

        // Someone joins before it's due: the old envelope wasn't made for them, so it isn't sent.
        Assert.Equal("result", (await bob.RequestAsync("group.change",
            GroupTests.Change(bob, id, 2, group.GetProperty("head").GetString()!, "add", [dave.Key], [alice.Key, bob.Key, carol.Key, dave.Key]))).Type());
        JsonElement failed;
        do failed = (await alice.EventAsync("scheduled.updated")).Body().GetProperty("scheduled");
        while (failed.GetProperty("status").GetString() != "failed");
        Assert.Contains("group changed", failed.GetProperty("error").GetString());
        await carol.NoEventAsync("group.message");
    }

    // ── Inbox ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Mentions_replies_and_everyone_land_in_the_inbox()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        var mine = await SayAsync(alice, server.General, "my question");

        await SayAsync(bob, server.General, $"hey <@{alice.Key}>");
        var item = (await alice.EventAsync("inbox.new")).Body().GetProperty("item");
        Assert.Equal("mention", item.GetProperty("kind").GetString());
        Assert.Equal(server.General, item.GetProperty("channelId").GetInt64());
        await SayAsync(bob, server.General, "an answer", replyTo: mine);
        Assert.Equal("reply", (await alice.EventAsync("inbox.new")).Body().GetProperty("item").GetProperty("kind").GetString());
        // @everyone from a member pings nobody; from trusted it does.
        await SayAsync(bob, server.General, "@everyone look");
        await SayAsync(trusted, server.General, "@everyone dinner");
        Assert.Equal("everyone", (await alice.EventAsync("inbox.new")).Body().GetProperty("item").GetProperty("kind").GetString());
        // Your own message never lands in your inbox.
        await SayAsync(alice, server.General, $"note to self <@{alice.Key}>");

        var items = (await alice.RequestAsync("inbox.list")).Body().GetProperty("items");
        Assert.Equal(["everyone", "reply", "mention"], items.EnumerateArray().Select(i => i.GetProperty("kind").GetString()));
        Assert.Equal("@everyone dinner", items[0].GetProperty("message").GetProperty("text").GetString());
        Assert.Equal(1, (await bob.RequestAsync("inbox.list")).Body().GetProperty("items").GetArrayLength()); // trusted's @everyone
        var page = (await alice.RequestAsync("inbox.list", new { limit = 2 })).Body();
        Assert.True(page.GetProperty("hasMore").GetBoolean());
        var rest = (await alice.RequestAsync("inbox.list", new { before = page.GetProperty("next").GetInt64() })).Body().GetProperty("items");
        Assert.Equal("mention", rest[0].GetProperty("kind").GetString());
    }

    [Fact]
    public async Task The_inbox_only_lists_what_you_can_read_now()
    {
        using var server = new IskraServer();
        var club = server.World.Store.CreateChannel("club", "text", "trusted", "trusted", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = await SayAsync(admin, club, $"psst <@{alice.Key}>");
        Assert.Equal(1, (await alice.RequestAsync("inbox.list")).Body().GetProperty("items").GetArrayLength());
        Assert.Equal("result", (await admin.RequestAsync("member.setRole", new { accountKey = alice.Key, role = "member" })).Type());
        Assert.Equal(0, (await alice.RequestAsync("inbox.list")).Body().GetProperty("items").GetArrayLength());
        // A deleted message leaves the inbox.
        await admin.RequestAsync("chat.delete", new { id });
        Assert.Empty(server.World.Store.InboxItems(alice.Key, null, 10));
    }

    // ── Compliance: data export and retention ────────────────────────────────

    [Fact]
    public async Task The_data_export_includes_reminders_scheduled_messages_inbox_and_edit_history()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = await SayAsync(alice, server.General, "draft one");
        await alice.RequestAsync("chat.edit", new { id, text = "draft two" });
        await SayAsync(bob, server.General, $"hi <@{alice.Key}>");
        var data = Sealed();
        await alice.RequestAsync("reminder.create", new { dueAt = Now + 3_600_000, data, messageId = id });
        await alice.RequestAsync("scheduled.create", new { channelId = server.General, text = "tomorrow's news", sendAt = Now + 3_600_000 });
        await alice.RequestAsync("scheduled.create", new { accountKey = bob.Key, envelope = new { v = 2, ct = "sealed" }, sendAt = Now + 3_600_000 });

        var made = (await alice.RequestAsync("data.export")).Body();
        using var response = await server.CreateClient().GetAsync(made.GetProperty("url").GetString());
        using var zip = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()));
        using var stream = zip.GetEntry("data.json")!.Open();
        var export = JsonDocument.Parse(stream).RootElement;

        Assert.Equal("draft one", Assert.Single(export.GetProperty("editHistory").EnumerateArray()).GetProperty("text").GetString());
        Assert.Equal(data, Assert.Single(export.GetProperty("reminders").EnumerateArray()).GetProperty("data").GetString());
        var scheduled = export.GetProperty("scheduledMessages").EnumerateArray().ToList();
        Assert.Equal(["channel", "dm"], scheduled.Select(x => x.GetProperty("kind").GetString()));
        Assert.Equal("tomorrow's news", scheduled[0].GetProperty("text").GetString());
        Assert.DoesNotContain("sealed", export.GetRawText().Replace(data, "")); // encrypted envelopes stay out
        Assert.Equal("mention", Assert.Single(export.GetProperty("inbox").EnumerateArray()).GetProperty("kind").GetString());
        Assert.Contains("reminders", new StreamReader(zip.GetEntry("README.txt")!.Open()).ReadToEnd());
    }

    [Fact]
    public async Task Message_retention_takes_edit_history_and_inbox_items_with_the_messages()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var old = await SayAsync(bob, server.General, $"old <@{owner.Key}>");
        await bob.RequestAsync("chat.edit", new { id = old, text = $"old, edited <@{owner.Key}>" });
        var fresh = await SayAsync(bob, server.General, "fresh");
        await bob.RequestAsync("chat.edit", new { id = fresh, text = "fresh, edited" });
        using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(server.WorldPath, "iskra.db"), Pooling = false }.ToString()))
        {
            db.Open();
            using var cmd = db.CreateCommand();
            cmd.CommandText = "UPDATE messages SET created_at = $t WHERE id = $id; UPDATE message_edits SET written_at = $t WHERE message_id = $id;";
            cmd.Parameters.AddWithValue("$t", Now - 40L * 86_400_000);
            cmd.Parameters.AddWithValue("$id", old);
            cmd.ExecuteNonQuery();
        }
        await owner.RequestAsync("retention.update", new { messagesDays = 30 });
        server.Services.GetServices<IHostedService>().OfType<RetentionSweeper>().Single().Sweep();

        Assert.Empty(server.World.Store.MessageVersions(old));
        Assert.Single(server.World.Store.MessageVersions(fresh));
        Assert.Empty(server.World.Store.InboxItems(owner.Key, null, 10));
    }
}
