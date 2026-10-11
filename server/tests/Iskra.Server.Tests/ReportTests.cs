using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ReportTests
{
    private static async Task<long> Send(IskraServer server, User who, string text, long? channelId = null)
    {
        var sent = await who.RequestAsync("chat.send", new { channelId = channelId ?? server.General, text });
        Assert.Equal("result", sent.Type());
        return sent.Body().GetProperty("message").GetProperty("id").GetInt64();
    }

    private static async Task<JsonElement[]> Open(User mod)
    {
        var list = await mod.RequestAsync("report.list");
        Assert.Equal("result", list.Type());
        return [.. list.Body().GetProperty("reports").EnumerateArray()];
    }

    [Fact]
    public async Task A_message_report_reaches_moderators_with_a_copy_of_the_message()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var troll = await server.JoinAsync("Troll");
        using var sam = await server.JoinAsync("Sam");
        var id = await Send(server, troll, "you are all idiots");

        var created = await sam.RequestAsync("report.create", new { messageId = id, reason = "harassment", note = "Keeps doing this" });
        Assert.Equal("result", created.Type());
        Assert.False(created.Body().GetProperty("already").GetBoolean());
        Assert.Equal(1, (await admin.EventAsync("report.count")).Body().GetProperty("open").GetInt32());

        // The copy survives an edit and a deletion.
        Assert.Equal("result", (await troll.RequestAsync("chat.edit", new { id, text = "nice weather" })).Type());
        var report = Assert.Single(await Open(admin));
        Assert.Equal("message", report.GetProperty("kind").GetString());
        Assert.Equal("harassment", report.GetProperty("reason").GetString());
        Assert.Equal("Keeps doing this", report.GetProperty("note").GetString());
        Assert.Equal(troll.Key, report.GetProperty("target").GetString());
        Assert.Equal("Troll", report.GetProperty("targetName").GetString());
        Assert.Equal(sam.Key, report.GetProperty("reporter").GetString());
        Assert.Equal("you are all idiots", report.GetProperty("message").GetProperty("text").GetString());
        Assert.Equal(server.General, report.GetProperty("message").GetProperty("channelId").GetInt64());
        Assert.False(report.GetProperty("message").GetProperty("deleted").GetBoolean());

        // The moderator deletes it with the usual tools, then resolves the report.
        Assert.Equal("result", (await admin.RequestAsync("chat.delete", new { id })).Type());
        Assert.True(Assert.Single(await Open(admin)).GetProperty("message").GetProperty("deleted").GetBoolean());
        var resolved = await admin.RequestAsync("report.resolve", new { id = report.GetProperty("id").GetInt64(), outcome = "deleted" });
        Assert.Equal("resolved", resolved.Body().GetProperty("report").GetProperty("status").GetString());
        Assert.Equal("deleted", resolved.Body().GetProperty("report").GetProperty("resolution").GetProperty("outcome").GetString());
        Assert.Empty(await Open(admin));
        var done = await admin.RequestAsync("report.list", new { status = "resolved" });
        Assert.Single(done.Body().GetProperty("reports").EnumerateArray());

        // A second resolve is a conflict; the audit log has the outcome but not the reporter.
        Assert.Equal("conflict", (await admin.RequestAsync("report.resolve", new { id = report.GetProperty("id").GetInt64(), outcome = "dismissed" })).ErrorCode());
        var audit = await admin.RequestAsync("audit.list", new { action = "report.resolve" });
        var entry = Assert.Single(audit.Body().GetProperty("entries").EnumerateArray());
        Assert.Equal(troll.Key, entry.GetProperty("target").GetString());
        Assert.DoesNotContain(sam.Key, entry.GetRawText());
    }

    [Fact]
    public async Task Only_moderators_see_reports_and_never_the_reported_person()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await server.JoinAsync("Mod", "admin");
        using var helper = await server.JoinAsync("Helper");
        using var sam = await server.JoinAsync("Sam");
        var role = await owner.RequestAsync("role.create", new { name = "Helper", permissions = new[] { "manageMessages" } });
        var roleId = role.Body().GetProperty("role").GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("member.roles.set", new { accountKey = helper.Key, roles = new[] { roleId } })).Type());

        // Sam reports a moderator: the other moderators see it, the reported one doesn't.
        Assert.Equal("result", (await sam.RequestAsync("report.create", new { accountKey = mod.Key, reason = "other" })).Type());
        Assert.Single(await Open(owner));
        Assert.Single(await Open(helper));
        Assert.Empty(await Open(mod));
        Assert.Equal(0, (await mod.RequestAsync("report.count")).Body().GetProperty("open").GetInt32());

        // Members can't read the queue at all.
        Assert.Equal("forbidden", (await sam.RequestAsync("report.list")).ErrorCode());
        var id = (await owner.RequestAsync("report.list")).Body().GetProperty("reports")[0].GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await mod.RequestAsync("report.resolve", new { id, outcome = "dismissed" })).ErrorCode());
        Assert.Equal(0, (await sam.RequestAsync("report.count")).Body().GetProperty("open").GetInt32());
    }

    [Fact]
    public async Task Message_reports_need_the_channel_and_moderators_only_see_channels_they_can_read()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var helper = await server.JoinAsync("Helper");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var other = await server.JoinAsync("Other", "trusted");
        var role = await owner.RequestAsync("role.create", new { name = "Helper", permissions = new[] { "kickMembers" } });
        var roleId = role.Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = helper.Key, roles = new[] { roleId } });
        var secret = (await owner.RequestAsync("channel.create", new { name = "trusted-only", readRole = "trusted", writeRole = "trusted" }))
            .Body().GetProperty("channel").GetProperty("id").GetInt64();
        var id = await Send(server, other, "secret stuff", secret);

        // Someone who can't read the channel can't report in it (and learns nothing).
        Assert.Equal("not_found", (await helper.RequestAsync("report.create", new { messageId = id, reason = "spam" })).ErrorCode());
        Assert.Equal("result", (await trusted.RequestAsync("report.create", new { messageId = id, reason = "spam" })).Type());
        Assert.Single(await Open(owner));
        Assert.Empty(await Open(helper)); // a member-level moderator can't read #trusted-only
    }

    [Fact]
    public async Task Reports_are_checked_deduplicated_and_rate_limited()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var sam = await server.JoinAsync("Sam");
        using var bob = await server.JoinAsync("Bob");
        var mine = await Send(server, sam, "mine");
        var his = await Send(server, bob, "his");

        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { messageId = his, reason = "rude" })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { messageId = mine, reason = "spam" })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { accountKey = sam.Key, reason = "spam" })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { messageId = his, accountKey = bob.Key, reason = "spam" })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { messageId = his, reason = "spam", note = new string('x', 501) })).ErrorCode());
        Assert.Equal("not_found", (await sam.RequestAsync("report.create", new { messageId = 999_999, reason = "spam" })).ErrorCode());

        var first = await sam.RequestAsync("report.create", new { messageId = his, reason = "spam" });
        var again = await sam.RequestAsync("report.create", new { messageId = his, reason = "hate" });
        Assert.True(again.Body().GetProperty("already").GetBoolean());
        Assert.Equal(first.Body().GetProperty("id").GetInt64(), again.Body().GetProperty("id").GetInt64());

        // 5 at once, then one every two minutes.
        for (var i = 0; i < 4; i++) Assert.Equal("result", (await sam.RequestAsync("report.create", new { messageId = await Send(server, bob, $"m{i}"), reason = "spam" })).Type());
        Assert.Equal("rate_limited", (await sam.RequestAsync("report.create", new { messageId = await Send(server, bob, "m5"), reason = "spam" })).ErrorCode());
    }

    [Fact]
    public async Task Shared_messages_from_an_encrypted_conversation_are_kept_as_given()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var sam = await server.JoinAsync("Sam");
        using var bob = await server.JoinAsync("Bob");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var messages = new object[]
        {
            new { author = bob.Key, text = "send me pics or else", at = now - 1000 },
            new { author = sam.Key, text = "no", at = now },
        };
        Assert.Equal("result", (await sam.RequestAsync("report.create", new { accountKey = bob.Key, reason = "harassment", messages })).Type());
        var report = Assert.Single(await Open(admin));
        Assert.Equal("dm", report.GetProperty("kind").GetString());
        Assert.Equal(2, report.GetProperty("messages").GetArrayLength());
        Assert.Equal("send me pics or else", report.GetProperty("messages")[0].GetProperty("text").GetString());
        Assert.Equal(JsonValueKind.Null, report.GetProperty("message").ValueKind);

        // Only the two people's messages, at most 20, with real text.
        var stranger = new { author = admin.Key, text = "x", at = now };
        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { accountKey = bob.Key, reason = "spam", messages = new[] { stranger } })).ErrorCode());
        var many = Enumerable.Range(0, 21).Select(i => new { author = bob.Key, text = $"m{i}", at = now }).ToArray();
        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { accountKey = bob.Key, reason = "spam", messages = many })).ErrorCode());
        var tooLong = new[] { new { author = bob.Key, text = new string('x', 2001), at = now } };
        Assert.Equal("bad_request", (await sam.RequestAsync("report.create", new { accountKey = bob.Key, reason = "spam", messages = tooLong })).ErrorCode());
    }

    [Fact]
    public async Task Reported_attachments_survive_the_upload_sweep_while_the_report_exists()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        using var sam = await server.JoinAsync("Sam");
        var file = new Iskra.Server.Storage.StoredFile("f1abcdefghijklmnop", new string('a', 64), "x.png", 10, "image/png", 1, 1, bob.Key, 0);
        server.World.Store.AddFile(file);
        var sent = await bob.RequestAsync("chat.send", new { channelId = server.General, text = "look", attachments = new[] { file.Id } });
        var id = sent.Body().GetProperty("message").GetProperty("id").GetInt64();
        await sam.RequestAsync("report.create", new { messageId = id, reason = "sexual" });
        await admin.RequestAsync("chat.delete", new { id });

        Assert.Contains(file.Id, server.World.Store.ReportFileIds());
        var report = Assert.Single(await Open(admin));
        Assert.Equal(file.Id, report.GetProperty("message").GetProperty("attachments")[0].GetProperty("id").GetString());
    }
}
