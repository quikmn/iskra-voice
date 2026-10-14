using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>The server's default notification level: automatic by size unless admins pick one.</summary>
public class NotifyDefaultTests
{
    [Fact]
    public async Task Admins_pick_the_default_and_everyone_hears_about_it()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        Assert.Equal("auto", member.Welcome.Body().GetProperty("notifyDefault").GetString());
        Assert.Equal("all", Iskra.Server.Features.NotifyFeature.DefaultFor(server.World.Store)); // a small server

        Assert.Equal("forbidden", (await member.RequestAsync("notify.default.set", new { level = "all" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("notify.default.set", new { level = "none" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("notify.default.set", new { level = "mentions" })).Type());
        Assert.Equal("mentions", (await member.EventAsync("notify.default")).Body().GetProperty("level").GetString());
        Assert.Equal("mentions", Iskra.Server.Features.NotifyFeature.DefaultFor(server.World.Store));

        await owner.RequestAsync("notify.default.set", new { level = "auto" });
        Assert.Null(server.World.Store.NotifyDefault());
        using var later = await server.JoinAsync("Later");
        Assert.Equal("auto", later.Welcome.Body().GetProperty("notifyDefault").GetString());
    }
}
