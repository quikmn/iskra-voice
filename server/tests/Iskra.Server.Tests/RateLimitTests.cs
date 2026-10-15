using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class RateLimitTests
{
    [Fact]
    public async Task An_app_connecting_and_then_acting_is_never_refused()
    {
        // An app asks for many settings and lists right after connecting (one per feature). The overall burst must leave
        // room for what the person does next: at 40 it didn't, and creating an invite right after joining was refused.
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        for (var i = 0; i < 100; i++)
            Assert.Equal("result", (await owner.RequestAsync("invite.list", new { })).Type());
        Assert.Equal("result", (await owner.RequestAsync("invite.create", new { neverExpires = true })).Type());
    }
}
