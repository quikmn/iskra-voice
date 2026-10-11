using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ActivityTests
{
    private static async Task<JsonElement> NextUpdateFor(User watcher, string accountKey)
    {
        while (true)
        {
            var member = (await watcher.EventAsync("member.updated")).Body().GetProperty("member");
            if (member.GetProperty("accountKey").GetString() == accountKey) return member;
        }
    }

    [Fact]
    public async Task Activity_is_validated_broadcast_and_keeps_its_start_time()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var set = (await alice.RequestAsync("activity.set", new { name = "  Factorio " })).Body().GetProperty("activity");
        Assert.Equal("Factorio", set.GetProperty("name").GetString());
        var since = set.GetProperty("since").GetInt64();
        Assert.True(since > 0);

        var seen = await NextUpdateFor(bob, alice.Key);
        Assert.Equal("Factorio", seen.GetProperty("activity").GetProperty("name").GetString());
        Assert.Equal(since, seen.GetProperty("activity").GetProperty("since").GetInt64());

        // The same game again changes nothing (no broadcast, same start time).
        var again = (await alice.RequestAsync("activity.set", new { name = "Factorio" })).Body().GetProperty("activity");
        Assert.Equal(since, again.GetProperty("since").GetInt64());

        Assert.Equal("bad_request", (await alice.RequestAsync("activity.set", new { name = new string('x', 65) })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("activity.set", new { name = "Doom‮" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("activity.set", new { name = "a\nb" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("activity.set", new { name = 42 })).ErrorCode());

        // Clearing.
        var cleared = (await alice.RequestAsync("activity.set", new { name = "" })).Body();
        Assert.Equal(JsonValueKind.Null, cleared.GetProperty("activity").ValueKind);
        seen = await NextUpdateFor(bob, alice.Key);
        Assert.Equal(JsonValueKind.Null, seen.GetProperty("activity").ValueKind);
    }

    [Fact]
    public async Task Activity_ends_when_you_go_offline_and_new_members_see_it()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        await alice.RequestAsync("activity.set", new { name = "Stardew Valley" });

        // Someone connecting later sees it in welcome.
        using var bob = await server.JoinAsync("Bob");
        var members = bob.Welcome.Body().GetProperty("members").EnumerateArray();
        var aliceSeen = members.First(m => m.GetProperty("accountKey").GetString() == alice.Key);
        Assert.Equal("Stardew Valley", aliceSeen.GetProperty("activity").GetProperty("name").GetString());

        // Alice leaves: her activity goes with her.
        alice.Dispose();
        var gone = await NextUpdateFor(bob, alice.Key);
        Assert.False(gone.GetProperty("online").GetBoolean());
        Assert.Equal(JsonValueKind.Null, gone.GetProperty("activity").ValueKind);
    }

    [Fact]
    public async Task Activity_changes_are_rate_limited()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var limited = false;
        for (var i = 0; i < 10 && !limited; i++)
            limited = (await alice.RequestAsync("activity.set", new { name = $"Game {i}" })).ErrorCode() == "rate_limited";
        Assert.True(limited);
    }
}
