using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Error bodies name their message with a key (and its values), so apps can show it in their language.</summary>
public class ErrorKeyTests
{
    [Fact]
    public async Task Errors_carry_a_key_and_args_next_to_the_English_message()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        var forbidden = (await member.RequestAsync("channel.create", new { name = "mine" })).Body();
        Assert.Equal("forbidden", forbidden.GetProperty("code").GetString());
        Assert.Equal("manage_channels", forbidden.GetProperty("key").GetString());
        Assert.Equal("You can't manage channels on this server.", forbidden.GetProperty("message").GetString());
        Assert.False(forbidden.TryGetProperty("args", out _));

        var tooLong = (await admin.RequestAsync("channel.create", new { name = new string('x', 200) })).Body();
        Assert.Equal("bad_request", tooLong.GetProperty("code").GetString());
        Assert.Equal("channel_name", tooLong.GetProperty("key").GetString());
        var max = tooLong.GetProperty("args").GetProperty("max").GetInt32();
        Assert.Equal($"Channel names must be 1–{max} characters.", tooLong.GetProperty("message").GetString());

        // Messages about the request's shape stay English only: no key.
        var malformed = (await admin.RequestAsync("channel.create", new { name = 42 })).Body();
        Assert.Equal("bad_request", malformed.GetProperty("code").GetString());
        Assert.False(malformed.TryGetProperty("key", out _));
    }

    [Fact]
    public async Task A_timed_out_member_gets_the_timed_out_key()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        var channelId = owner.Welcome.Body().GetProperty("channels").EnumerateArray()
            .First(c => c.GetProperty("kind").GetString() == "text").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.timeout", new { accountKey = bob.Key, durationMs = 60_000 });

        var refused = (await bob.RequestAsync("chat.send", new { channelId, text = "hi" })).Body();
        Assert.Equal("forbidden", refused.GetProperty("code").GetString());
        Assert.Equal("timed_out", refused.GetProperty("key").GetString());
    }
}
