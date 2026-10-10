using Iskra.Server.Features;
using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class InviteTests
{
    private static async Task AssertJoinRejected(IskraServer server, string? invite, string code = "invite_required")
    {
        using var identity = new TestIdentity();
        using var client = await server.ConnectAsync();
        var reply = await client.LoginAsync(identity, "Someone", invite);
        Assert.Equal(code, reply.ErrorCode());
        await client.ReceiveCloseAsync();
    }

    [Fact]
    public async Task Strangers_without_an_invite_cannot_join()
    {
        using var server = new IskraServer();
        await AssertJoinRejected(server, invite: null);
        await AssertJoinRejected(server, invite: "made-up-code");
    }

    [Fact]
    public async Task A_new_world_writes_a_single_use_owner_invite()
    {
        using var server = new IskraServer();
        using (await server.ConnectAsync()) { } // starts the server

        var file = Path.Combine(server.WorldPath, OwnerSetup.FileName);
        Assert.True(File.Exists(file));
        var link = File.ReadAllText(file).Trim();
        Assert.StartsWith("https://app.iskra.foo/#/join/", link);
        var code = link.Split('.').Last();

        using var owner = new TestIdentity();
        using (var client = await server.ConnectAsync())
        {
            var welcome = await client.LoginAsync(owner, "Host", code);
            Assert.Equal("owner", welcome.Body().GetProperty("you").GetProperty("role").GetString());
        }
        Assert.False(File.Exists(file));
        await AssertJoinRejected(server, code); // used up
    }

    [Fact]
    public async Task Single_use_expired_and_revoked_invites_stop_working()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var single = store.CreateInvite("single", "test", "member", now, null, maxUses: 1).Code;
        using (var first = new TestIdentity())
        using (var client = await server.ConnectAsync())
            Assert.Equal("welcome", (await client.LoginAsync(first, "First", single)).Type());
        await AssertJoinRejected(server, single);

        var expired = store.CreateInvite("expired", "test", "member", now - 10_000, expiresAt: now - 1, null).Code;
        await AssertJoinRejected(server, expired);

        var revoked = server.Invite();
        store.RevokeInvite(revoked);
        await AssertJoinRejected(server, revoked);
    }

    [Fact]
    public async Task Who_can_invite_into_which_role()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        using var guest = await server.JoinAsync("Guest", "guest");

        Assert.Equal("result", (await member.RequestAsync("invite.create", new { })).Type());
        Assert.Equal("forbidden", (await member.RequestAsync("invite.create", new { role = "trusted" })).ErrorCode());
        Assert.Equal("forbidden", (await guest.RequestAsync("invite.create", new { })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("invite.create", new { role = "trusted" })).Type());
        Assert.Equal("forbidden", (await admin.RequestAsync("invite.create", new { role = "admin" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("invite.create", new { role = "admin" })).Type());
        Assert.Equal("forbidden", (await owner.RequestAsync("invite.create", new { role = "owner" })).ErrorCode());
    }

    [Fact]
    public async Task Created_invites_work_and_members_only_list_their_own()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        var code = (await member.RequestAsync("invite.create", new { maxUses = 5 })).Body().GetProperty("invite").GetProperty("code").GetString();
        await admin.RequestAsync("invite.create", new { });

        Assert.Single((await member.RequestAsync("invite.list")).Body().GetProperty("invites").EnumerateArray());
        Assert.True((await admin.RequestAsync("invite.list")).Body().GetProperty("invites").GetArrayLength() >= 2);

        using var friend = new TestIdentity();
        using var client = await server.ConnectAsync();
        Assert.Equal("welcome", (await client.LoginAsync(friend, "Friend", code)).Type());
    }

    [Fact]
    public async Task Invite_lifetimes_are_bounded()
    {
        using var server = new IskraServer();
        using var member = await server.JoinAsync("Member");
        Assert.Equal("bad_request", (await member.RequestAsync("invite.create", new { expiresInMs = 1000 })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("invite.create", new { expiresInMs = 999L * 24 * 3600 * 1000 })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("invite.create", new { maxUses = 0 })).ErrorCode());
    }
}
