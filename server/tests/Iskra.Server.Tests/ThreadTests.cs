using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ThreadTests
{
    private static long Post(IskraServer server, string author, string text, long? channel = null) =>
        server.World.Store.AddMessage(channel ?? server.General, author, text, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Id;

    private static async Task<JsonElement> Start(User user, long messageId, string name = "side chat")
    {
        var reply = await user.RequestAsync("thread.create", new { messageId, name });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("thread");
    }

    [Fact]
    public async Task Start_a_thread_and_talk_in_it()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var root = Post(server, alice.Key, "who's up for a game?");

        var thread = await Start(bob, root, "  Game night  ");
        var id = thread.GetProperty("id").GetInt64();
        Assert.Equal("Game night", thread.GetProperty("name").GetString());
        Assert.Equal(server.General, thread.GetProperty("channelId").GetInt64());
        Assert.Equal(root, thread.GetProperty("rootId").GetInt64());
        Assert.Equal(0, (await alice.EventAsync("thread.updated")).Body().GetProperty("thread").GetProperty("messageCount").GetInt32());
        await bob.EventAsync("thread.updated");

        // Messages in a thread use the thread's id as their channel, with mentions like anywhere else.
        var sent = await alice.RequestAsync("chat.send", new { channelId = id, text = $"me! <@{bob.Key}>" });
        Assert.Equal(id, sent.Body().GetProperty("message").GetProperty("channelId").GetInt64());
        Assert.Contains(bob.Key, (await bob.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("text").GetString());
        var updated = (await bob.EventAsync("thread.updated")).Body().GetProperty("thread");
        Assert.Equal(1, updated.GetProperty("messageCount").GetInt32());
        Assert.True(updated.GetProperty("lastMessageAt").GetInt64() > 0);

        // The root message carries the summary; the thread doesn't show up as a channel.
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(1, history[0].GetProperty("thread").GetProperty("messageCount").GetInt32());
        Assert.Single((await bob.RequestAsync("chat.history", new { channelId = id })).Body().GetProperty("messages").EnumerateArray());
        Assert.Equal(id, (await bob.RequestAsync("thread.list", new { channelId = server.General })).Body().GetProperty("threads")[0].GetProperty("id").GetInt64());
        var got = (await bob.RequestAsync("thread.get", new { id })).Body();
        Assert.Equal("who's up for a game?", got.GetProperty("root").GetProperty("text").GetString());
        Assert.DoesNotContain(server.World.Store.AllChannels(), c => c.Id == id);
        using var carol = await server.JoinAsync("Carol");
        Assert.DoesNotContain(carol.Welcome.Body().GetProperty("channels").EnumerateArray(), c => c.GetProperty("id").GetInt64() == id);
    }

    [Fact]
    public async Task One_thread_per_message_and_no_threads_in_threads()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var root = Post(server, alice.Key, "root");
        var id = (await Start(alice, root)).GetProperty("id").GetInt64();

        Assert.Equal("bad_request", (await alice.RequestAsync("thread.create", new { messageId = root, name = "again" })).ErrorCode());
        var inner = Post(server, alice.Key, "inside", id);
        Assert.Equal("bad_request", (await alice.RequestAsync("thread.create", new { messageId = inner, name = "nested" })).ErrorCode());
        var other = Post(server, alice.Key, "another");
        Assert.Equal("bad_request", (await alice.RequestAsync("thread.create", new { messageId = other, name = "" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("thread.create", new { messageId = other, name = new string('x', 101) })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("thread.get", new { id = server.General })).ErrorCode());
    }

    [Fact]
    public async Task Threads_follow_the_parent_channels_roles()
    {
        using var server = new IskraServer();
        var staff = server.World.Store.CreateChannel("staff", "text", "trusted", "trusted", 0).Id;
        var news = server.World.Store.CreateChannel("news", "text", "member", "admin", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        var secretThread = (await Start(admin, Post(server, admin.Key, "staff only", staff))).GetProperty("id").GetInt64();
        await admin.RequestAsync("chat.send", new { channelId = secretThread, text = "psst" });
        await member.NoEventAsync("chat.message");
        await member.NoEventAsync("thread.updated");
        Assert.Equal("not_found", (await member.RequestAsync("thread.get", new { id = secretThread })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.history", new { channelId = secretThread })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.send", new { channelId = secretThread, text = "hi" })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("thread.list", new { channelId = staff })).ErrorCode());

        // Read-only channel: members can read its threads but not start or write in them.
        var newsPost = Post(server, admin.Key, "update");
        Assert.Equal("forbidden", (await member.RequestAsync("thread.create", new { messageId = Post(server, admin.Key, "release", news), name = "x" })).ErrorCode());
        var newsThread = (await Start(admin, server.World.Store.AddMessage(news, admin.Key, "discuss", 1).Id)).GetProperty("id").GetInt64();
        Assert.Equal("result", (await member.RequestAsync("chat.history", new { channelId = newsThread })).Type());
        Assert.Equal("forbidden", (await member.RequestAsync("chat.send", new { channelId = newsThread, text = "hi" })).ErrorCode());

        // Changing the parent's roles applies to its threads immediately.
        var open = (await Start(member, newsPost)).GetProperty("id").GetInt64();
        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = open, text = "ok" })).Type());
        await admin.RequestAsync("channel.update", new { id = server.General, writeRole = "admin" });
        Assert.Equal("forbidden", (await member.RequestAsync("chat.send", new { channelId = open, text = "still?" })).ErrorCode());
    }

    [Fact]
    public async Task Rename_and_delete_by_the_starter_or_an_admin()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = (await Start(alice, Post(server, bob.Key, "root"))).GetProperty("id").GetInt64();

        Assert.Equal("forbidden", (await bob.RequestAsync("thread.update", new { id, name = "mine now" })).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("thread.delete", new { id })).ErrorCode());
        Assert.Equal("renamed", (await alice.RequestAsync("thread.update", new { id, name = "renamed" })).Body().GetProperty("thread").GetProperty("name").GetString());
        Assert.Equal("by admin", (await admin.RequestAsync("thread.update", new { id, name = "by admin" })).Body().GetProperty("thread").GetProperty("name").GetString());

        // Threads aren't channels for channel management.
        Assert.Equal("not_found", (await admin.RequestAsync("channel.update", new { id, name = "x" })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("channel.delete", new { id })).ErrorCode());

        Post(server, alice.Key, "unique thread words", id);
        Assert.Equal("result", (await admin.RequestAsync("thread.delete", new { id })).Type());
        var deleted = (await bob.EventAsync("thread.deleted")).Body();
        Assert.Equal(id, deleted.GetProperty("id").GetInt64());
        Assert.Equal("not_found", (await bob.RequestAsync("chat.history", new { channelId = id })).ErrorCode());
        Assert.Equal(0, (await bob.RequestAsync("search", new { query = "unique" })).Body().GetProperty("total").GetInt32());
        var root = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages")[0];
        Assert.Equal(JsonValueKind.Null, root.GetProperty("thread").ValueKind);
    }

    [Fact]
    public async Task Deleting_the_channel_deletes_its_threads()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var channel = (await admin.RequestAsync("channel.create", new { name = "temp" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var id = (await Start(admin, Post(server, admin.Key, "root", channel))).GetProperty("id").GetInt64();
        Post(server, admin.Key, "reply", id);

        await admin.RequestAsync("channel.delete", new { id = channel });
        Assert.Null(server.World.Store.GetChannel(id));
        Assert.Null(server.World.Store.GetThread(id));
    }

    [Fact]
    public async Task Starting_threads_is_rate_limited_per_account()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var codes = new List<string?>();
        for (var i = 0; i < 6; i++)
            codes.Add((await alice.RequestAsync("thread.create", new { messageId = Post(server, alice.Key, $"root {i}"), name = $"t{i}" })).ErrorCode());
        Assert.Equal([null, null, null, null, null], codes.Take(5));
        Assert.Equal("rate_limited", codes[5]);
    }
}
