using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ForumTests
{
    private static long Forum(IskraServer server, string name = "help", string read = "member", string write = "member") =>
        server.World.Store.CreateChannel(name, "forum", read, write, 0).Id;

    private static async Task<JsonElement> Post(User user, long forum, string title, string text = "first message", long[]? tags = null)
    {
        var reply = await user.RequestAsync("forum.post.create", new { channelId = forum, title, text, tags = tags ?? [] });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("post");
    }

    private static async Task<long[]> Tags(User admin, long forum, params string[] names)
    {
        var reply = await admin.RequestAsync("forum.tags.set", new { channelId = forum, tags = names.Select(n => new { name = n }) });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("tags").EnumerateArray().Select(t => t.GetProperty("id").GetInt64()).ToArray();
    }

    private static List<JsonElement> Posts(JsonElement reply) => reply.Body().GetProperty("posts").EnumerateArray().ToList();

    [Fact]
    public async Task Admins_create_forums_and_members_post_and_reply_in_threads()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var channel = (await admin.RequestAsync("channel.create", new { name = "help", kind = "forum" })).Body().GetProperty("channel");
        Assert.Equal("forum", channel.GetProperty("kind").GetString());
        var forum = channel.GetProperty("id").GetInt64();
        Assert.Contains((await bob.EventAsync("channels")).Body().GetProperty("channels").EnumerateArray(), c => c.GetProperty("kind").GetString() == "forum");

        var post = await Post(bob, forum, "  How do I mute?  ", "It keeps beeping");
        var id = post.GetProperty("id").GetInt64();
        Assert.Equal("How do I mute?", post.GetProperty("title").GetString());
        Assert.Equal(bob.Key, post.GetProperty("author").GetString());
        Assert.Equal("It keeps beeping", post.GetProperty("excerpt").GetString());
        Assert.Equal(0, post.GetProperty("replyCount").GetInt32());
        Assert.Equal(forum, (await admin.EventAsync("forum.post.updated")).Body().GetProperty("post").GetProperty("channelId").GetInt64());
        Assert.Equal(forum, (await admin.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("channelId").GetInt64());

        // Plain messages and threads from messages don't go into a forum.
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = forum, text = "hi" })).ErrorCode());
        var rootId = post.GetProperty("rootId").GetInt64();
        Assert.Equal("bad_request", (await bob.RequestAsync("thread.create", new { messageId = rootId, name = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.posts", new { channelId = server.General })).ErrorCode());

        // Replies are thread messages.
        Assert.Equal("result", (await admin.RequestAsync("chat.send", new { channelId = id, text = "Settings, Voice" })).Type());
        var listed = Posts(await bob.RequestAsync("forum.posts", new { channelId = forum }));
        Assert.Equal(1, listed.Single().GetProperty("replyCount").GetInt32());
        Assert.Equal(admin.Key, listed.Single().GetProperty("lastAuthor").GetString());
        var got = (await bob.RequestAsync("forum.post.get", new { id })).Body();
        Assert.Equal("It keeps beeping", got.GetProperty("root").GetProperty("text").GetString());
        Assert.Equal(id, (await bob.RequestAsync("thread.get", new { id })).Body().GetProperty("thread").GetProperty("id").GetInt64());

        // Validation.
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.post.create", new { channelId = forum, title = "", text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.post.create", new { channelId = forum, title = new string('x', 101), text = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.post.create", new { channelId = forum, title = "t", text = "" })).ErrorCode());
    }

    [Fact]
    public async Task Forums_follow_their_roles()
    {
        using var server = new IskraServer();
        var staff = Forum(server, "staff", "trusted", "trusted");
        var news = Forum(server, "news", "member", "admin");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var secret = (await Post(admin, staff, "secret")).GetProperty("id").GetInt64();
        await member.NoEventAsync("forum.post.updated");

        Assert.Equal("not_found", (await member.RequestAsync("forum.posts", new { channelId = staff })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("forum.post.get", new { id = secret })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.send", new { channelId = secret, text = "hi" })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("forum.post.create", new { channelId = staff, title = "t", text = "x" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("forum.post.create", new { channelId = news, title = "t", text = "x" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("forum.tags.set", new { channelId = news, tags = new[] { new { name = "x" } } })).ErrorCode());
    }

    [Fact]
    public async Task Tags_are_set_by_admins_and_filter_the_list()
    {
        using var server = new IskraServer();
        var forum = Forum(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var tags = await Tags(admin, forum, "Bug", "Idea");
        Assert.Equal(2, (await bob.EventAsync("forum.tags")).Body().GetProperty("tags").GetArrayLength());

        var bug = (await Post(bob, forum, "Crash", tags: [tags[0]])).GetProperty("id").GetInt64();
        await Post(bob, forum, "Dark mode", tags: [tags[1]]);
        var both = await Post(bob, forum, "Both", tags: [tags[0], tags[1], tags[0]]);
        Assert.Equal(2, both.GetProperty("tags").GetArrayLength());

        var filtered = Posts(await bob.RequestAsync("forum.posts", new { channelId = forum, tag = tags[0] }));
        Assert.Equal(["Both", "Crash"], filtered.Select(p => p.GetProperty("title").GetString()));

        // Tags from elsewhere, too many, duplicates.
        var other = Forum(server, "other");
        var foreign = (await Tags(admin, other, "Other"))[0];
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.post.create", new { channelId = forum, title = "t", text = "x", tags = new[] { foreign } })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("forum.tags.set", new { channelId = forum, tags = Enumerable.Range(0, 21).Select(i => new { name = $"t{i}" }) })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("forum.tags.set", new { channelId = forum, tags = new[] { new { name = "a" }, new { name = "A" } } })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("forum.tags.set", new { channelId = forum, tags = new[] { new { name = new string('x', 21) } } })).ErrorCode());

        // Renaming keeps ids; removing a tag takes it off posts.
        var renamed = (await admin.RequestAsync("forum.tags.set", new { channelId = forum, tags = new object[] { new { id = tags[0], name = "Bugs", emoji = "🐛" } } })).Body().GetProperty("tags");
        Assert.Equal(tags[0], renamed[0].GetProperty("id").GetInt64());
        Assert.Equal("🐛", renamed[0].GetProperty("emoji").GetString());
        var after = (await bob.RequestAsync("forum.post.get", new { id = both.GetProperty("id").GetInt64() })).Body().GetProperty("post").GetProperty("tags");
        Assert.Equal([tags[0]], after.EnumerateArray().Select(t => t.GetInt64()));

        // The author retags their post; someone else can't.
        using var carol = await server.JoinAsync("Carol");
        Assert.Equal("forbidden", (await carol.RequestAsync("forum.post.update", new { id = bug, tags = Array.Empty<long>() })).ErrorCode());
        Assert.Equal(0, (await bob.RequestAsync("forum.post.update", new { id = bug, tags = Array.Empty<long>() })).Body().GetProperty("post").GetProperty("tags").GetArrayLength());
    }

    [Fact]
    public async Task List_sorts_by_activity_or_newest_with_pinned_first_and_pages()
    {
        using var server = new IskraServer();
        var forum = Forum(server);
        using var mod = await server.JoinAsync("Mod", "trusted");
        using var bob = await server.JoinAsync("Bob");
        var first = (await Post(bob, forum, "first")).GetProperty("id").GetInt64();
        await Task.Delay(5);
        var second = (await Post(bob, forum, "second")).GetProperty("id").GetInt64();
        await Task.Delay(5);
        var third = (await Post(bob, forum, "third")).GetProperty("id").GetInt64();
        await Task.Delay(5);
        await bob.RequestAsync("chat.send", new { channelId = first, text = "bump" });

        static IEnumerable<long> Ids(List<JsonElement> posts) => posts.Select(p => p.GetProperty("id").GetInt64());
        Assert.Equal([first, third, second], Ids(Posts(await bob.RequestAsync("forum.posts", new { channelId = forum }))));
        Assert.Equal([third, second, first], Ids(Posts(await bob.RequestAsync("forum.posts", new { channelId = forum, sort = "newest" }))));

        Assert.Equal("forbidden", (await bob.RequestAsync("forum.post.set", new { id = second, pinned = true })).ErrorCode());
        Assert.True((await mod.RequestAsync("forum.post.set", new { id = second, pinned = true })).Body().GetProperty("post").GetProperty("pinned").GetBoolean());

        var page1 = await bob.RequestAsync("forum.posts", new { channelId = forum, limit = 2 });
        Assert.Equal([second, first], Ids(Posts(page1)));
        Assert.True(page1.Body().GetProperty("hasMore").GetBoolean());
        var cursor = page1.Body().GetProperty("cursor").GetString();
        var page2 = await bob.RequestAsync("forum.posts", new { channelId = forum, limit = 2, cursor });
        Assert.Equal([third], Ids(Posts(page2)));
        Assert.False(page2.Body().GetProperty("hasMore").GetBoolean());
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.posts", new { channelId = forum, cursor = "nope" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.posts", new { channelId = forum, sort = "random" })).ErrorCode());
    }

    [Fact]
    public async Task Search_finds_titles_first_messages_and_replies()
    {
        using var server = new IskraServer();
        var forum = Forum(server);
        using var bob = await server.JoinAsync("Bob");
        var title = (await Post(bob, forum, "Café night", "plans")).GetProperty("id").GetInt64();
        var body = (await Post(bob, forum, "Question", "where is the microphone setting")).GetProperty("id").GetInt64();
        var reply = (await Post(bob, forum, "Other", "nothing here")).GetProperty("id").GetInt64();
        await bob.RequestAsync("chat.send", new { channelId = reply, text = "try the microwave" });
        await Post(bob, forum, "Unrelated", "zzz");

        async Task<long[]> Find(string query) =>
            Posts(await bob.RequestAsync("forum.posts", new { channelId = forum, query })).Select(p => p.GetProperty("id").GetInt64()).Order().ToArray();
        Assert.Equal([title], await Find("cafe"));
        Assert.Equal([body, reply], await Find("micro"));
        Assert.Empty(await Find("nothingmatches"));
    }

    [Fact]
    public async Task Closed_and_locked_posts_take_replies_only_from_moderators()
    {
        using var server = new IskraServer();
        var forum = Forum(server);
        using var mod = await server.JoinAsync("Mod", "trusted");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var id = (await Post(bob, forum, "solved?")).GetProperty("id").GetInt64();

        // The author can close their own post; others can't.
        Assert.Equal("forbidden", (await carol.RequestAsync("forum.post.set", new { id, closed = true })).ErrorCode());
        Assert.True((await bob.RequestAsync("forum.post.set", new { id, closed = true })).Body().GetProperty("post").GetProperty("closed").GetBoolean());
        Assert.Equal("forbidden", (await carol.RequestAsync("chat.send", new { channelId = id, text = "me too" })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("chat.send", new { channelId = id, text = "mod note" })).Type());
        Assert.Equal("result", (await bob.RequestAsync("forum.post.set", new { id, closed = false })).Type());
        Assert.Equal("result", (await carol.RequestAsync("chat.send", new { channelId = id, text = "me too" })).Type());

        // Locking is for moderators, and then the author can't reopen.
        Assert.Equal("forbidden", (await bob.RequestAsync("forum.post.set", new { id, locked = true })).ErrorCode());
        Assert.True((await mod.RequestAsync("forum.post.set", new { id, locked = true, closed = true })).Body().GetProperty("post").GetProperty("locked").GetBoolean());
        Assert.Equal("forbidden", (await bob.RequestAsync("chat.send", new { channelId = id, text = "pls" })).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("forum.post.set", new { id, closed = false })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("chat.send", new { channelId = id, text = "locked, sorry" })).Type());
        Assert.Equal("bad_request", (await mod.RequestAsync("forum.post.set", new { id })).ErrorCode());
    }

    [Fact]
    public async Task Pinned_posts_are_capped()
    {
        using var server = new IskraServer();
        var forum = Forum(server);
        using var mod = await server.JoinAsync("Mod", "trusted");
        var ids = new List<long>();
        for (var i = 0; i < 11; i++)
        {
            ids.Add(server.World.Store.CreateForumPost(server.World.Store.GetChannel(forum)!, mod.Key, $"p{i}", "x", [], [], i + 1).Id);
        }
        foreach (var id in ids.Take(10)) Assert.Equal("result", (await mod.RequestAsync("forum.post.set", new { id, pinned = true })).Type());
        Assert.Equal("bad_request", (await mod.RequestAsync("forum.post.set", new { id = ids[10], pinned = true })).ErrorCode());
    }

    [Fact]
    public async Task Renaming_editing_and_deleting_posts()
    {
        using var server = new IskraServer();
        var forum = Forum(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var post = await Post(bob, forum, "typo titel", "body");
        var id = post.GetProperty("id").GetInt64();
        var rootId = post.GetProperty("rootId").GetInt64();

        Assert.Equal("forbidden", (await carol.RequestAsync("forum.post.update", new { id, title = "mine" })).ErrorCode());
        Assert.Equal("typo title", (await bob.RequestAsync("forum.post.update", new { id, title = "typo title" })).Body().GetProperty("post").GetProperty("title").GetString());
        await carol.EventAsync("thread.updated"); // created
        Assert.Equal("typo title", (await carol.EventAsync("thread.updated")).Body().GetProperty("thread").GetProperty("name").GetString());

        // Editing the first message updates the excerpt.
        await bob.RequestAsync("chat.edit", new { id = rootId, text = "better body" });
        JsonElement updated;
        do updated = (await carol.EventAsync("forum.post.updated")).Body().GetProperty("post");
        while (updated.GetProperty("excerpt").GetString() != "better body");

        // Deleting the post (as a thread) removes its first message too; deleting the first message removes the post.
        Assert.Equal("forbidden", (await carol.RequestAsync("thread.delete", new { id })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("thread.delete", new { id })).Type());
        Assert.Equal(rootId, (await carol.EventAsync("chat.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Equal(id, (await carol.EventAsync("thread.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Null(server.World.Store.GetMessage(rootId));
        Assert.Empty(Posts(await carol.RequestAsync("forum.posts", new { channelId = forum })));

        var other = await Post(bob, forum, "again", "body");
        Assert.Equal("result", (await bob.RequestAsync("chat.delete", new { id = other.GetProperty("rootId").GetInt64() })).Type());
        Assert.Equal(other.GetProperty("id").GetInt64(), (await carol.EventAsync("thread.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Null(server.World.Store.GetForumPost(other.GetProperty("id").GetInt64()));

        // Deleting the forum deletes everything in it.
        var last = (await Post(bob, forum, "last")).GetProperty("id").GetInt64();
        await admin.RequestAsync("channel.delete", new { id = forum });
        Assert.Null(server.World.Store.GetForumPost(last));
    }

    [Fact]
    public async Task Posts_are_rate_limited_like_threads()
    {
        using var server = new IskraServer();
        var forum = Forum(server);
        using var bob = await server.JoinAsync("Bob");
        for (var i = 0; i < 5; i++) await Post(bob, forum, $"p{i}");
        Assert.Equal("rate_limited", (await bob.RequestAsync("forum.post.create", new { channelId = forum, title = "one more", text = "x" })).ErrorCode());
    }
}
