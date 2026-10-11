using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class LeaveTests
{
    [Fact]
    public async Task Members_can_leave_and_drop_off_the_member_list()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        // Bob's answer arrives before his sessions close.
        Assert.Equal("result", (await bob.RequestAsync("member.leave")).Type());
        Assert.Equal(CloseCodes.Forbidden, await bob.Client.ReceiveCloseAsync());
        Assert.Equal(bob.Key, (await admin.EventAsync("member.removed")).Body().GetProperty("accountKey").GetString());
        Assert.Null(server.World.Store.GetMember(bob.Key));

        // Coming back takes a new invite, like after a kick.
        using (var again = await server.ConnectAsync())
            Assert.Equal("invite_required", (await again.LoginAsync(bob.Identity, "Bob")).ErrorCode());
    }

    [Fact]
    public async Task The_owner_cannot_leave()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        Assert.Equal("forbidden", (await owner.RequestAsync("member.leave")).ErrorCode());
        Assert.NotNull(server.World.Store.GetMember(owner.Key));
    }
}
