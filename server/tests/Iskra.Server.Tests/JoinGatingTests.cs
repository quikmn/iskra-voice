using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Approval invites, paused invites, newcomer slowmode and the join-flood rule.</summary>
public class JoinGatingTests
{
    private static async Task<string> ApprovalInvite(User by)
    {
        var reply = await by.RequestAsync("invite.create", new { approve = true });
        Assert.Equal("result", reply.Type());
        var invite = reply.Body().GetProperty("invite");
        Assert.True(invite.GetProperty("approve").GetBoolean());
        return invite.GetProperty("code").GetString()!;
    }

    /// <summary>One handshake attempt: the reply frame and, when refused, the close code.</summary>
    private static async Task<(JsonElement Reply, int? Close)> Attempt(IskraServer server, TestIdentity identity, string name, string? invite)
    {
        using var client = await server.ConnectAsync();
        var reply = await client.LoginAsync(identity, name, invite);
        if (reply.Type() == "welcome") return (reply, null);
        return (reply, await client.ReceiveCloseAsync());
    }

    [Fact]
    public async Task Approval_invites_queue_the_joiner_until_a_moderator_lets_them_in()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var code = await ApprovalInvite(owner);
        using var sam = new TestIdentity();

        // The use is spent, but Sam waits outside; asking again spends nothing more.
        var (reply, close) = await Attempt(server, sam, "Sam", code);
        Assert.Equal("join_pending", reply.ErrorCode());
        Assert.Equal(4401, close);
        Assert.Equal(1, server.World.Store.GetInvite(code)!.Uses);
        Assert.Null(server.World.Store.GetMember(sam.AccountKey));
        (reply, _) = await Attempt(server, sam, "Sam", code);
        Assert.Equal("join_pending", reply.ErrorCode());
        Assert.Equal(1, server.World.Store.GetInvite(code)!.Uses);

        // Moderators see the queue (name, which invite, when); members don't.
        Assert.Equal(1, (await owner.EventAsync("join.count")).Body().GetProperty("pending").GetInt32());
        Assert.Equal(1, (await owner.RequestAsync("join.count")).Body().GetProperty("pending").GetInt32());
        Assert.Equal(0, (await member.RequestAsync("join.count")).Body().GetProperty("pending").GetInt32());
        Assert.Equal("forbidden", (await member.RequestAsync("join.list")).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("join.approve", new { accountKey = sam.AccountKey })).ErrorCode());
        var request = Assert.Single((await owner.RequestAsync("join.list")).Body().GetProperty("requests").EnumerateArray());
        Assert.Equal("Sam", request.GetProperty("name").GetString());
        Assert.Equal(sam.AccountKey, request.GetProperty("accountKey").GetString());
        Assert.Equal("member", request.GetProperty("role").GetString());
        Assert.Equal(code[^6..], request.GetProperty("invite").GetProperty("tail").GetString());
        Assert.Equal(owner.Key, request.GetProperty("invite").GetProperty("createdBy").GetString());
        Assert.False(request.TryGetProperty("ip", out _));

        // Approved: a member like any other, announced to everyone; Sam's next try gets the welcome.
        var approved = await owner.RequestAsync("join.approve", new { accountKey = sam.AccountKey });
        Assert.Equal("result", approved.Type());
        Assert.Equal("Sam", (await member.EventAsync("member.joined")).Body().GetProperty("member").GetProperty("name").GetString());
        Assert.Equal(0, (await owner.EventAsync("join.count")).Body().GetProperty("pending").GetInt32());
        (reply, _) = await Attempt(server, sam, "Sam", code);
        Assert.Equal("welcome", reply.Type());
        Assert.Equal("member", reply.Body().GetProperty("you").GetProperty("role").GetString());
        Assert.Equal(1, server.World.Store.GetInvite(code)!.Uses);
        Assert.Equal("not_found", (await owner.RequestAsync("join.approve", new { accountKey = sam.AccountKey })).ErrorCode());

        var actions = (await owner.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("join.approve", actions);
    }

    [Fact]
    public async Task A_pending_joiners_data_export_has_their_join_request_without_the_invite_code()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var code = await ApprovalInvite(owner);
        using var sam = new TestIdentity();
        Assert.Equal("join_pending", (await Attempt(server, sam, "Sam", code)).Reply.ErrorCode());

        // Not a member yet, but the server holds something about them: the owner can answer a data request.
        var made = await owner.RequestAsync("data.export", new { accountKey = sam.AccountKey });
        Assert.Equal("result", made.Type());
        var data = await ComplianceTests.Download(server, made.Body());
        var request = Assert.Single(data.GetProperty("joinRequest").EnumerateArray());
        Assert.Equal("Sam", request.GetProperty("name").GetString());
        Assert.Equal(code[^6..], request.GetProperty("invite_tail").GetString());
        Assert.Equal("member", request.GetProperty("role").GetString());
        Assert.True(request.GetProperty("requested_at").GetInt64() > 0);
        Assert.Equal(JsonValueKind.Null, request.GetProperty("declined_at").ValueKind);
        Assert.Empty(data.GetProperty("membership").EnumerateArray());
        Assert.DoesNotContain(code, data.GetRawText()); // never the whole invite
    }

    [Fact]
    public async Task Declined_joiners_are_turned_away_and_the_use_stays_spent()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var code = await ApprovalInvite(owner);
        using var sam = new TestIdentity();
        Assert.Equal("join_pending", (await Attempt(server, sam, "Sam", code)).Reply.ErrorCode());

        Assert.Equal("result", (await owner.RequestAsync("join.decline", new { accountKey = sam.AccountKey })).Type());
        var (reply, close) = await Attempt(server, sam, "Sam", code);
        Assert.Equal("join_declined", reply.ErrorCode());
        Assert.Equal(4403, close); // their app stops retrying
        Assert.Equal(1, server.World.Store.GetInvite(code)!.Uses);
        Assert.Equal("not_found", (await owner.RequestAsync("join.decline", new { accountKey = sam.AccountKey })).ErrorCode());
        Assert.Empty((await owner.RequestAsync("join.list")).Body().GetProperty("requests").EnumerateArray());

        // A day later the refusal is forgotten: a fresh invite is needed, and this one still works for others.
        server.World.Store.PruneJoinRequests(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2 * 24 * 3600_000L);
        Assert.Equal("join_pending", (await Attempt(server, sam, "Sam", code)).Reply.ErrorCode()); // asked again with the same link
        Assert.Equal(2, server.World.Store.GetInvite(code)!.Uses);
        var actions = (await owner.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("join.decline", actions);
    }

    [Fact]
    public async Task Paused_invites_turn_joiners_away_without_spending_a_use()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var code = server.Invite();

        Assert.Equal("forbidden", (await member.RequestAsync("join.settings.update", new { invitesPaused = true })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("join.settings.get")).ErrorCode());
        var paused = await owner.RequestAsync("join.settings.update", new { invitesPaused = true });
        Assert.True(paused.Body().GetProperty("settings").GetProperty("invitesPaused").GetBoolean());
        Assert.Equal(owner.Key, paused.Body().GetProperty("settings").GetProperty("pausedBy").GetString());
        Assert.True((await member.EventAsync("invites.paused")).Body().GetProperty("paused").GetBoolean());

        using var late = new TestIdentity();
        var (reply, close) = await Attempt(server, late, "Late", code);
        Assert.Equal("invites_paused", reply.ErrorCode());
        Assert.Equal(4401, close);
        Assert.Equal(0, server.World.Store.GetInvite(code)!.Uses);

        var resumed = await owner.RequestAsync("join.settings.update", new { invitesPaused = false });
        Assert.False(resumed.Body().GetProperty("settings").GetProperty("invitesPaused").GetBoolean());
        Assert.False((await member.EventAsync("invites.paused")).Body().GetProperty("paused").GetBoolean());
        (reply, _) = await Attempt(server, late, "Late", code);
        Assert.Equal("welcome", reply.Type());
        Assert.False(reply.Body().GetProperty("server").GetProperty("invitesPaused").GetBoolean());

        var actions = (await owner.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("invites.pause", actions);
        Assert.Contains("invites.resume", actions);
    }

    [Fact]
    public async Task Newcomers_get_a_slowmode_everywhere_while_they_are_new()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        Assert.Equal("bad_request", (await owner.RequestAsync("join.settings.update", new { newcomerSlowmode = 7 })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("join.settings.update", new { newcomerHours = 100_000 })).ErrorCode());
        var settings = (await owner.RequestAsync("join.settings.update", new { newcomerHours = 24, newcomerSlowmode = 30 })).Body().GetProperty("settings");
        Assert.Equal(24, settings.GetProperty("newcomerHours").GetInt32());
        Assert.Equal(30, settings.GetProperty("newcomerSlowmode").GetInt32());

        using var fresh = await server.JoinAsync("Fresh");
        Assert.Equal("result", (await fresh.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Type());
        var second = await fresh.RequestAsync("chat.send", new { channelId = server.General, text = "again" });
        Assert.Equal("rate_limited", second.ErrorCode());
        Assert.Equal("slowmode", second.Body().GetProperty("key").GetString());
        // Admins are never slowed, and turning it off frees newcomers at once.
        Assert.Equal("result", (await owner.RequestAsync("chat.send", new { channelId = server.General, text = "one" })).Type());
        Assert.Equal("result", (await owner.RequestAsync("chat.send", new { channelId = server.General, text = "two" })).Type());
        await owner.RequestAsync("join.settings.update", new { newcomerHours = 0 });
        Assert.Equal("result", (await fresh.RequestAsync("chat.send", new { channelId = server.General, text = "free" })).Type());
    }

    [Fact]
    public async Task A_join_flood_pauses_invites_and_alerts()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var set = await owner.RequestAsync("automod.update", new
        {
            automod = new { enabled = true, joins = new { enabled = true, count = 2, minutes = 10 }, alertChannelId = server.General },
        });
        Assert.Equal("result", set.Type());
        Assert.True(set.Body().GetProperty("automod").GetProperty("joins").GetProperty("enabled").GetBoolean());
        var code = server.Invite();

        // Two joins are fine; the third is one too many: it gets in, but invites pause right after it.
        for (var i = 0; i < 3; i++)
        {
            using var identity = new TestIdentity();
            Assert.Equal("welcome", (await Attempt(server, identity, $"Raider {i}", code)).Reply.Type());
        }
        Assert.True((await owner.EventAsync("invites.paused")).Body().GetProperty("paused").GetBoolean());
        using var fourth = new TestIdentity();
        Assert.Equal("invites_paused", (await Attempt(server, fourth, "Raider 4", code)).Reply.ErrorCode());

        var settings = (await owner.RequestAsync("join.settings.get")).Body().GetProperty("settings");
        Assert.True(settings.GetProperty("invitesPaused").GetBoolean());
        Assert.Equal("automod:", settings.GetProperty("pausedBy").GetString());
        // The alert names the rule and the numbers, never a person.
        JsonElement alert = default;
        for (var i = 0; i < 10 && alert.ValueKind == JsonValueKind.Undefined; i++)
        {
            var message = (await owner.EventAsync("chat.message")).Body().GetProperty("message");
            if (message.TryGetProperty("automod", out var a) && a.ValueKind == JsonValueKind.Object) alert = a;
        }
        Assert.Equal("joins", alert.GetProperty("rule").GetString());
        Assert.Equal(3, alert.GetProperty("joins").GetInt32());
        Assert.Equal(10, alert.GetProperty("minutes").GetInt32());
        var entry = (await owner.RequestAsync("audit.list", new { action = "invites.pause" })).Body().GetProperty("entries")[0];
        Assert.Equal("AutoMod", entry.GetProperty("actorName").GetString());

        // Admins resume by hand; the next join works, and the window has to fill up again.
        await owner.RequestAsync("join.settings.update", new { invitesPaused = false });
        Assert.Equal("welcome", (await Attempt(server, fourth, "Raider 4", code)).Reply.Type());
    }
}
