using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

public class PollTests
{
    private static JsonElement Poll(JsonElement frame) => frame.Body().GetProperty("message").GetProperty("poll");

    private static Task<JsonElement> Create(User user, long channelId, string[]? options = null, bool multi = false, long? durationMs = null) =>
        user.RequestAsync("poll.create", new { channelId, question = "Pizza or tacos?", options = options ?? ["Pizza", "Tacos", "Both"], multi, durationMs });

    private static int[] Counts(JsonElement poll) =>
        poll.GetProperty("options").EnumerateArray().Select(o => o.GetProperty("votes").GetArrayLength()).ToArray();

    [Fact]
    public async Task Polls_are_messages_with_live_results()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var created = await Create(alice, server.General);
        var id = created.Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("Pizza or tacos?", created.Body().GetProperty("message").GetProperty("text").GetString());
        Assert.Equal(3, Poll(created).GetProperty("options").GetArrayLength());
        Assert.False(Poll(created).GetProperty("multi").GetBoolean());
        Assert.Equal(JsonValueKind.Null, Poll(created).GetProperty("expiresAt").ValueKind);
        Assert.Equal("Pizza or tacos?", Poll(await bob.EventAsync("chat.message")).GetProperty("question").GetString());

        Assert.Equal("result", (await bob.RequestAsync("poll.vote", new { id, options = new[] { 1 } })).Type());
        var update = (await alice.EventAsync("poll.updated")).Body();
        Assert.Equal(id, update.GetProperty("id").GetInt64());
        Assert.Equal(new[] { 0, 1, 0 }, Counts(update.GetProperty("poll")));
        Assert.Equal(bob.Key, update.GetProperty("poll").GetProperty("options")[1].GetProperty("votes")[0].GetString());

        // Changing the vote replaces it; an empty list removes it.
        await bob.RequestAsync("poll.vote", new { id, options = new[] { 0 } });
        Assert.Equal(new[] { 1, 0, 0 }, Counts((await alice.EventAsync("poll.updated")).Body().GetProperty("poll")));
        await bob.RequestAsync("poll.vote", new { id, options = Array.Empty<int>() });
        Assert.Equal(new[] { 0, 0, 0 }, Counts((await alice.EventAsync("poll.updated")).Body().GetProperty("poll")));

        // History carries the poll too.
        var history = await bob.RequestAsync("chat.history", new { channelId = server.General });
        Assert.Equal("Pizza or tacos?", history.Body().GetProperty("messages")[0].GetProperty("poll").GetProperty("question").GetString());
    }

    [Fact]
    public async Task Vote_rules_are_enforced()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var single = (await Create(alice, server.General)).Body().GetProperty("message").GetProperty("id").GetInt64();
        var multi = (await Create(alice, server.General, multi: true)).Body().GetProperty("message").GetProperty("id").GetInt64();

        Assert.Equal("bad_request", (await alice.RequestAsync("poll.vote", new { id = single, options = new[] { 0, 1 } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("poll.vote", new { id = single, options = new[] { 3 } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("poll.vote", new { id = single, options = new[] { -1 } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("poll.vote", new { id = single, options = "0" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("poll.vote", new { id = multi, options = new[] { 1, 1 } })).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("poll.vote", new { id = multi, options = new[] { 0, 2 } })).Type());
        Assert.Equal(new[] { 1, 0, 1 }, Counts((await alice.EventAsync("poll.updated")).Body().GetProperty("poll")));

        // Votes are per account: another device of the same account replaces, not adds.
        using var device2 = new TestIdentity(alice.Identity.Account);
        using var client2 = await server.ConnectAsync();
        await client2.LoginAsync(device2, "Alice");
        await client2.RequestAsync("poll.vote", new { id = multi, options = new[] { 1 } });
        Assert.Equal(new[] { 0, 1, 0 }, Counts((await alice.EventAsync("poll.updated")).Body().GetProperty("poll")));

        // Normal messages aren't polls.
        var plain = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await alice.RequestAsync("poll.vote", new { id = plain, options = new[] { 0 } })).ErrorCode());
        // And polls can't be edited into something else.
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.edit", new { id = single, text = "changed" })).ErrorCode());
    }

    [Theory]
    [InlineData("Only one")]
    [InlineData("Same|same")]
    [InlineData("a|b|c|d|e|f|g|h|i|j|k")]
    [InlineData("ok|")]
    [InlineData("ok|   ")]
    public async Task Bad_options_are_rejected(string joined)
    {
        var options = joined.Split('|');
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await Create(alice, server.General, options)).ErrorCode());
    }

    [Fact]
    public async Task Limits_on_question_answers_and_duration()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("poll.create", new { channelId = server.General, question = new string('q', 301), options = new[] { "a", "b" } })).ErrorCode());
        Assert.Equal("bad_request", (await Create(alice, server.General, ["a", new string('b', 56)])).ErrorCode());
        Assert.Equal("bad_request", (await Create(alice, server.General, durationMs: 1000)).ErrorCode());
        Assert.Equal("bad_request", (await Create(alice, server.General, durationMs: 15L * 24 * 3600 * 1000)).ErrorCode());
        Assert.Equal("result", (await Create(alice, server.General, ["a", new string('b', 55), "c", "d", "e", "f", "g", "h", "i", "j"], durationMs: 3_600_000)).Type());
    }

    [Fact]
    public async Task Only_writers_create_polls_and_readers_vote()
    {
        using var server = new IskraServer();
        var news = server.World.Store.CreateChannel("news", "text", "member", "admin", 0).Id;
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await Create(member, news)).ErrorCode());
        Assert.Equal("not_found", (await Create(member, staff)).ErrorCode());

        var id = (await Create(admin, news)).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("result", (await member.RequestAsync("poll.vote", new { id, options = new[] { 0 } })).Type());

        var hidden = (await Create(admin, staff)).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await member.RequestAsync("poll.vote", new { id = hidden, options = new[] { 0 } })).ErrorCode());
    }

    [Fact]
    public async Task Author_or_admin_ends_a_poll_and_then_votes_stop()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");

        var id = (await Create(alice, server.General)).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("forbidden", (await bob.RequestAsync("poll.end", new { id })).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("poll.end", new { id })).Type());
        var closed = (await bob.EventAsync("poll.updated")).Body().GetProperty("poll");
        Assert.NotEqual(JsonValueKind.Null, closed.GetProperty("closedAt").ValueKind);
        Assert.Equal("bad_request", (await bob.RequestAsync("poll.vote", new { id, options = new[] { 0 } })).ErrorCode());

        var other = (await Create(alice, server.General)).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("result", (await admin.RequestAsync("poll.end", new { id = other })).Type());
    }

    [Fact]
    public async Task Expired_polls_refuse_votes_and_are_closed_for_everyone()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // A poll whose time ran out a moment ago (as if it had been created with a duration).
        var (message, _) = server.World.Store.AddPoll(server.General, alice.Key, "Over?", ["Yes", "No"], false, now - 1, now - 120_000);

        Assert.Equal("bad_request", (await alice.RequestAsync("poll.vote", new { id = message.Id, options = new[] { 0 } })).ErrorCode());

        server.Services.GetServices<IHostedService>().OfType<PollCloser>().Single().CloseExpired();
        var update = (await alice.EventAsync("poll.updated")).Body();
        Assert.Equal(message.Id, update.GetProperty("id").GetInt64());
        Assert.Equal(now - 1, update.GetProperty("poll").GetProperty("closedAt").GetInt64());
    }

    [Fact]
    public async Task Deleting_the_message_deletes_the_poll()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var id = (await Create(alice, server.General)).Body().GetProperty("message").GetProperty("id").GetInt64();
        await alice.RequestAsync("poll.vote", new { id, options = new[] { 0 } });
        await alice.RequestAsync("chat.delete", new { id });
        Assert.Null(server.World.Store.GetPoll(id));
        Assert.Equal("not_found", (await alice.RequestAsync("poll.vote", new { id, options = new[] { 0 } })).ErrorCode());
    }
}
