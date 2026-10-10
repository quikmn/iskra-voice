using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class PinTests
{
    private static long Post(IskraServer server, string author, string text, long? channel = null) =>
        server.World.Store.AddMessage(channel ?? server.General, author, text, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Id;

    [Fact]
    public async Task Trusted_writers_pin_and_everyone_sees_it()
    {
        using var server = new IskraServer();
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var member = await server.JoinAsync("Member");
        var id = Post(server, member.Key, "remember this");

        Assert.Equal("forbidden", (await member.RequestAsync("chat.pin", new { id })).ErrorCode());
        Assert.Equal("result", (await trusted.RequestAsync("chat.pin", new { id })).Type());

        var evt = (await member.EventAsync("chat.pinned")).Body();
        Assert.Equal(id, evt.GetProperty("id").GetInt64());
        Assert.True(evt.GetProperty("on").GetBoolean());
        Assert.Equal(trusted.Key, evt.GetProperty("by").GetString());

        var pins = (await member.RequestAsync("pin.list", new { channelId = server.General })).Body().GetProperty("pins");
        Assert.Equal("remember this", pins[0].GetProperty("message").GetProperty("text").GetString());
        Assert.Equal(trusted.Key, pins[0].GetProperty("pinnedBy").GetString());
        var history = (await member.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.True(history[0].GetProperty("pinned").GetBoolean());

        // Pinning twice is a no-op; unpinning sends the event once.
        Assert.Equal("result", (await trusted.RequestAsync("chat.pin", new { id })).Type());
        await member.NoEventAsync("chat.pinned");
        Assert.Equal("result", (await trusted.RequestAsync("chat.pin", new { id, on = false })).Type());
        Assert.False((await member.EventAsync("chat.pinned")).Body().GetProperty("on").GetBoolean());
        Assert.Equal(0, (await member.RequestAsync("pin.list", new { channelId = server.General })).Body().GetProperty("pins").GetArrayLength());
    }

    [Fact]
    public async Task Pins_follow_channel_roles()
    {
        using var server = new IskraServer();
        var news = server.World.Store.CreateChannel("news", "text", "member", "admin", 0).Id;
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        var announcement = Post(server, admin.Key, "server update", news);
        var secret = Post(server, admin.Key, "secret", staff);

        // Trusted, but can't write in #news.
        Assert.Equal("forbidden", (await trusted.RequestAsync("chat.pin", new { id = announcement })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("chat.pin", new { id = announcement })).Type());
        // Can't read #staff at all: it doesn't exist for them.
        Assert.Equal("not_found", (await trusted.RequestAsync("chat.pin", new { id = secret })).ErrorCode());
        Assert.Equal("not_found", (await trusted.RequestAsync("pin.list", new { channelId = staff })).ErrorCode());

        Assert.Equal(announcement, (await trusted.EventAsync("chat.pinned")).Body().GetProperty("id").GetInt64());
        await admin.RequestAsync("chat.pin", new { id = secret });
        await trusted.NoEventAsync("chat.pinned");
    }

    [Fact]
    public async Task At_most_fifty_pins_per_channel()
    {
        using var server = new IskraServer();
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        var ids = Enumerable.Range(0, 51).Select(i => Post(server, trusted.Key, $"m{i}")).ToList();
        foreach (var id in ids.Take(50)) server.World.Store.AddPin(id, server.General, trusted.Key, 1);

        Assert.Equal("bad_request", (await trusted.RequestAsync("chat.pin", new { id = ids[50] })).ErrorCode());
        Assert.Equal("result", (await trusted.RequestAsync("chat.pin", new { id = ids[0] })).Type()); // already pinned
        await trusted.RequestAsync("chat.pin", new { id = ids[0], on = false });
        Assert.Equal("result", (await trusted.RequestAsync("chat.pin", new { id = ids[50] })).Type());
    }

    [Fact]
    public async Task Deleted_messages_leave_the_pin_list()
    {
        using var server = new IskraServer();
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        var id = (await trusted.RequestAsync("chat.send", new { channelId = server.General, text = "pin me" }))
            .Body().GetProperty("message").GetProperty("id").GetInt64();
        await trusted.RequestAsync("chat.pin", new { id });
        await trusted.RequestAsync("chat.delete", new { id });
        Assert.Equal(0, (await trusted.RequestAsync("pin.list", new { channelId = server.General })).Body().GetProperty("pins").GetArrayLength());
        Assert.Equal("not_found", (await trusted.RequestAsync("chat.pin", new { id })).ErrorCode());
    }
}
