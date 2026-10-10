using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Private channels must not leak, and role changes must apply immediately.</summary>
public class PermissionTests
{
    private static long CreateChannel(IskraServer server, string name, string readRole, string writeRole) =>
        server.World.Store.CreateChannel(name, "text", readRole, writeRole, 0).Id;

    private static IEnumerable<string?> ChannelNames(JsonElement channels) =>
        channels.EnumerateArray().Select(c => c.GetProperty("name").GetString());

    [Fact]
    public async Task Private_channels_are_invisible_to_lower_roles()
    {
        using var server = new IskraServer();
        var secret = CreateChannel(server, "staff", "trusted", "trusted");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var member = await server.JoinAsync("Member");

        Assert.Contains("staff", ChannelNames(trusted.Welcome.Body().GetProperty("channels")));
        Assert.DoesNotContain("staff", ChannelNames(member.Welcome.Body().GetProperty("channels")));

        await trusted.RequestAsync("chat.send", new { channelId = secret, text = "secret plans" });
        await member.NoEventAsync("chat.message");

        Assert.Equal("not_found", (await member.RequestAsync("chat.history", new { channelId = secret })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.send", new { channelId = secret, text = "hi" })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.typing", new { channelId = secret })).ErrorCode());
    }

    [Fact]
    public async Task Read_only_channels_reject_writes()
    {
        using var server = new IskraServer();
        var news = CreateChannel(server, "announcements", "member", "admin");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        await admin.RequestAsync("chat.send", new { channelId = news, text = "server update" });
        await member.EventAsync("chat.message");
        Assert.Equal("forbidden", (await member.RequestAsync("chat.send", new { channelId = news, text = "me too" })).ErrorCode());
    }

    [Fact]
    public async Task Promotions_and_demotions_apply_immediately()
    {
        using var server = new IskraServer();
        var secret = CreateChannel(server, "staff", "trusted", "trusted");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");

        await owner.RequestAsync("member.setRole", new { accountKey = bob.Key, role = "trusted" });
        Assert.Contains("staff", ChannelNames((await bob.EventAsync("channels")).Body().GetProperty("channels")));
        await owner.RequestAsync("chat.send", new { channelId = secret, text = "welcome to staff" });
        await bob.EventAsync("chat.message");

        await owner.RequestAsync("member.setRole", new { accountKey = bob.Key, role = "member" });
        Assert.DoesNotContain("staff", ChannelNames((await bob.EventAsync("channels")).Body().GetProperty("channels")));
        await owner.RequestAsync("chat.send", new { channelId = secret, text = "bob is gone" });
        await bob.NoEventAsync("chat.message");
        Assert.Equal("not_found", (await bob.RequestAsync("chat.send", new { channelId = secret, text = "still here?" })).ErrorCode());
    }

    [Fact]
    public async Task Only_admins_manage_channels()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await member.RequestAsync("channel.create", new { name = "mine" })).ErrorCode());

        var created = await admin.RequestAsync("channel.create", new { name = "Game Night" });
        var channel = created.Body().GetProperty("channel");
        Assert.Equal("game-night", channel.GetProperty("name").GetString());
        Assert.Contains("game-night", ChannelNames((await member.EventAsync("channels")).Body().GetProperty("channels")));

        var id = channel.GetProperty("id").GetInt64();
        Assert.Equal("forbidden", (await member.RequestAsync("channel.delete", new { id })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id, readRole = "admin", writeRole = "member" })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("channel.delete", new { id })).Type());
    }
}

public class ModerationTests
{
    [Fact]
    public async Task Admins_cannot_touch_equals_or_superiors()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var admin2 = await server.JoinAsync("Admin 2", "admin");

        Assert.Equal("forbidden", (await admin.RequestAsync("member.kick", new { accountKey = owner.Key })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("member.ban", new { accountKey = admin2.Key })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("member.setRole", new { accountKey = owner.Key, role = "member" })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("member.kick", new { accountKey = admin.Key })).ErrorCode());
    }

    [Fact]
    public async Task Roles_can_only_be_granted_below_your_own()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await member.RequestAsync("member.setRole", new { accountKey = admin.Key, role = "guest" })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("member.setRole", new { accountKey = member.Key, role = "admin" })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("member.setRole", new { accountKey = member.Key, role = "trusted" })).Type());
        Assert.Equal("result", (await owner.RequestAsync("member.setRole", new { accountKey = member.Key, role = "admin" })).Type());
        Assert.Equal("bad_request", (await owner.RequestAsync("member.setRole", new { accountKey = member.Key, role = "god" })).ErrorCode());
    }

    [Fact]
    public async Task Kicked_members_are_disconnected_and_need_a_new_invite()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        await admin.RequestAsync("member.kick", new { accountKey = bob.Key });
        Assert.Equal(CloseCodes.Forbidden, await bob.Client.ReceiveCloseAsync());
        Assert.Equal(bob.Key, (await admin.EventAsync("member.removed")).Body().GetProperty("accountKey").GetString());

        using (var again = await server.ConnectAsync())
            Assert.Equal("invite_required", (await again.LoginAsync(bob.Identity, "Bob")).ErrorCode());
        using (var again = await server.ConnectAsync())
            Assert.Equal("welcome", (await again.LoginAsync(bob.Identity, "Bob", server.Invite())).Type());
    }

    [Fact]
    public async Task Banned_members_stay_out_until_unbanned()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        await admin.RequestAsync("member.ban", new { accountKey = bob.Key, reason = "spam" });
        Assert.Equal(CloseCodes.Forbidden, await bob.Client.ReceiveCloseAsync());

        using (var again = await server.ConnectAsync())
        {
            Assert.Equal("banned", (await again.LoginAsync(bob.Identity, "Bob", server.Invite())).ErrorCode());
            Assert.Equal(CloseCodes.Forbidden, await again.ReceiveCloseAsync());
        }

        var bans = (await admin.RequestAsync("member.bans")).Body().GetProperty("bans");
        Assert.Equal("spam", bans[0].GetProperty("reason").GetString());

        await admin.RequestAsync("member.unban", new { accountKey = bob.Key });
        using (var again = await server.ConnectAsync())
            Assert.Equal("welcome", (await again.LoginAsync(bob.Identity, "Bob", server.Invite())).Type());
    }

    [Fact]
    public async Task Renaming_is_validated_and_broadcast()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        Assert.Equal("bad_request", (await alice.RequestAsync("profile.update", new { name = "" })).ErrorCode());
        await alice.RequestAsync("profile.update", new { name = "Alice ✨" });
        JsonElement update;
        do update = (await bob.EventAsync("member.updated")).Body().GetProperty("member");
        while (update.GetProperty("accountKey").GetString() != alice.Key);
        Assert.Equal("Alice ✨", update.GetProperty("name").GetString());
    }
}
