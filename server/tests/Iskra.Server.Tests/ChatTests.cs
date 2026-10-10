using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ChatTests
{
    private static JsonElement Message(JsonElement frame) => frame.Body().GetProperty("message");

    [Fact]
    public async Task Messages_reach_everyone_and_are_stored()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var sent = await alice.RequestAsync("chat.send", new { channelId = server.General, text = "  hello **world**  " });
        Assert.Equal("result", sent.Type());
        Assert.Equal("hello **world**", Message(sent).GetProperty("text").GetString());
        Assert.Equal(alice.Key, Message(sent).GetProperty("author").GetString());

        var received = await bob.EventAsync("chat.message");
        Assert.Equal(Message(sent).GetProperty("id").GetInt64(), Message(received).GetProperty("id").GetInt64());

        var history = await bob.RequestAsync("chat.history", new { channelId = server.General });
        Assert.Equal("hello **world**", history.Body().GetProperty("messages")[0].GetProperty("text").GetString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("bell\u0007")]
    [InlineData("hidden‮text")]
    public async Task Invalid_text_is_rejected_without_dropping_the_session(string text)
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text })).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("ping")).Type());
    }

    [Fact]
    public async Task Long_messages_and_newlines()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var multiline = await alice.RequestAsync("chat.send", new { channelId = server.General, text = "line 1\r\nline 2" });
        Assert.Equal("line 1\nline 2", Message(multiline).GetProperty("text").GetString());
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = new string('a', 4000) })).Type());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = new string('a', 4001) })).ErrorCode());
    }

    [Fact]
    public async Task Bad_field_types_are_errors_not_crashes()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = "general", text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = 5 })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("chat.send", new { channelId = 9999, text = "x" })).ErrorCode());
    }

    [Fact]
    public async Task Only_the_author_can_edit()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = Message(await alice.RequestAsync("chat.send", new { channelId = server.General, text = "tpyo" })).GetProperty("id").GetInt64();

        Assert.Equal("forbidden", (await bob.RequestAsync("chat.edit", new { id, text = "hacked" })).ErrorCode());
        var edited = await alice.RequestAsync("chat.edit", new { id, text = "typo" });
        Assert.Equal("typo", Message(edited).GetProperty("text").GetString());
        Assert.True(Message(edited).GetProperty("editedAt").GetInt64() > 0);

        var evt = await bob.EventAsync("chat.edited");
        Assert.Equal("typo", Message(evt).GetProperty("text").GetString());
    }

    [Fact]
    public async Task Who_can_delete_what()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        async Task<long> Post(User u) =>
            Message(await u.RequestAsync("chat.send", new { channelId = server.General, text = "msg" })).GetProperty("id").GetInt64();

        var alicesMessage = await Post(alice);
        Assert.Equal("forbidden", (await bob.RequestAsync("chat.delete", new { id = alicesMessage })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("chat.delete", new { id = alicesMessage })).Type());
        Assert.Equal(alicesMessage, (await bob.EventAsync("chat.deleted")).Body().GetProperty("id").GetInt64());

        var ownersMessage = await Post(owner);
        Assert.Equal("forbidden", (await admin.RequestAsync("chat.delete", new { id = ownersMessage })).ErrorCode());

        var bobsMessage = await Post(bob);
        Assert.Equal("result", (await bob.RequestAsync("chat.delete", new { id = bobsMessage })).Type());
        Assert.Equal("not_found", (await bob.RequestAsync("chat.delete", new { id = bobsMessage })).ErrorCode());
    }

    [Fact]
    public async Task History_pages_backwards_and_catches_up_forwards()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var ids = new List<long>();
        for (var i = 0; i < 7; i++)
        {
            // Stay under the chat.send rate limit.
            if (i == 6) await Task.Delay(600);
            ids.Add(Message(await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"m{i}" })).GetProperty("id").GetInt64());
        }

        var latest = (await alice.RequestAsync("chat.history", new { channelId = server.General, limit = 3 })).Body();
        Assert.Equal(["m4", "m5", "m6"], latest.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("text").GetString()));
        Assert.True(latest.GetProperty("hasMore").GetBoolean());

        var older = (await alice.RequestAsync("chat.history", new { channelId = server.General, limit = 3, before = ids[4] })).Body();
        Assert.Equal(["m1", "m2", "m3"], older.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("text").GetString()));

        var newer = (await alice.RequestAsync("chat.history", new { channelId = server.General, after = ids[4] })).Body();
        Assert.Equal(["m5", "m6"], newer.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("text").GetString()));

        Assert.Equal("bad_request", (await alice.RequestAsync("chat.history", new { channelId = server.General, limit = 500 })).ErrorCode());
    }

    [Fact]
    public async Task Typing_reaches_others_but_not_yourself()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await alice.RequestAsync("chat.typing", new { channelId = server.General });
        Assert.Equal(alice.Key, (await bob.EventAsync("chat.typing")).Body().GetProperty("accountKey").GetString());
        await alice.NoEventAsync("chat.typing");
    }

    [Fact]
    public async Task Spamming_is_rate_limited()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var codes = new List<string?>();
        for (var i = 0; i < 15; i++)
            codes.Add((await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"spam {i}" })).ErrorCode());
        Assert.Contains("rate_limited", codes);
        Assert.True(codes.Count(c => c is null) >= 10);
    }

    [Fact]
    public async Task Presence_follows_connections()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var bob = await server.JoinAsync("Bob");

        var online = (await alice.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.Equal(bob.Key, online.GetProperty("accountKey").GetString());
        Assert.True(online.GetProperty("online").GetBoolean());

        bob.Dispose();
        var offline = (await alice.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.False(offline.GetProperty("online").GetBoolean());
    }
}
