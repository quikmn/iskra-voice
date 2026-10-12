using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Hi-fi voice channels: admins allow them per voice channel; everyone who can see the channel sees the flag.</summary>
public class HifiTests
{
    private static long Channel(IskraServer server, string name, string kind) =>
        server.World.Store.CreateChannel(name, kind, "member", "member", 0).Id;

    [Fact]
    public async Task Admins_allow_hifi_on_voice_channels_only()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge", "voice");
        var stage = Channel(server, "talks", "stage");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        // Off by default, for everyone.
        var welcome = alice.Welcome.Body().GetProperty("channels").EnumerateArray().ToList();
        Assert.False(welcome.Single(c => c.GetProperty("id").GetInt64() == lounge).GetProperty("hifi").GetBoolean());

        Assert.Equal("forbidden", (await alice.RequestAsync("channel.update", new { id = lounge, hifi = true })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = lounge, hifi = "yes" })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = stage, hifi = true })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = server.General, hifi = true })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.create", new { name = "notes", kind = "text", hifi = true })).ErrorCode());
        Assert.False(server.World.Store.IsHifi(lounge));

        var updated = (await admin.RequestAsync("channel.update", new { id = lounge, hifi = true })).Body().GetProperty("channel");
        Assert.True(updated.GetProperty("hifi").GetBoolean());
        var channels = (await alice.EventAsync("channels")).Body().GetProperty("channels");
        Assert.True(channels.EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == lounge).GetProperty("hifi").GetBoolean());

        // An update that doesn't mention it keeps it; new channels can start with it; newcomers see it.
        await admin.RequestAsync("channel.update", new { id = lounge, name = "music" });
        Assert.True(server.World.Store.IsHifi(lounge));
        var created = (await admin.RequestAsync("channel.create", new { name = "jam", kind = "voice", hifi = true })).Body().GetProperty("channel");
        Assert.True(created.GetProperty("hifi").GetBoolean());
        using var bob = await server.JoinAsync("Bob");
        Assert.True(bob.Welcome.Body().GetProperty("channels").EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == lounge).GetProperty("hifi").GetBoolean());

        // Off again, and the audit log keeps both changes.
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = lounge, hifi = false })).Type());
        Assert.False(server.World.Store.IsHifi(lounge));
        var audit = (await admin.RequestAsync("audit.list", new { action = "channel.update" })).Body().GetProperty("entries");
        Assert.Equal(2, audit.EnumerateArray().Count(e => e.GetProperty("details").GetProperty("changes").TryGetProperty("hifi", out _)));
    }

    [Fact]
    public async Task Deleting_a_channel_drops_its_hifi_setting()
    {
        using var server = new IskraServer();
        var lounge = Channel(server, "lounge", "voice");
        using var admin = await server.JoinAsync("Admin", "admin");
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = lounge, hifi = true })).Type());
        Assert.Equal("result", (await admin.RequestAsync("channel.delete", new { id = lounge })).Type());
        Assert.Empty(server.World.Store.AllHifi());
    }
}
