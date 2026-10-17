using System.Text.Json;
using Iskra.Server.Templates;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Media channels: forums whose posts are pictures and videos, with an optional title, a caption, tags and comments.</summary>
public class MediaChannelTests
{
    private static byte[] Png(int side = 32) => ServerImageTests.Png(side, side);
    private static byte[] Webm() => [0x1A, 0x45, 0xDF, 0xA3, .. new byte[2000]];

    private static async Task<long> MediaChannel(User admin, string name = "art", string? readRole = null, string? writeRole = null)
    {
        var reply = await admin.RequestAsync("channel.create", new { name, kind = "media", readRole = readRole ?? "member", writeRole = writeRole ?? readRole ?? "member" });
        Assert.Equal("result", reply.Type());
        Assert.Equal("media", reply.Body().GetProperty("channel").GetProperty("kind").GetString());
        return reply.Body().GetProperty("channel").GetProperty("id").GetInt64();
    }

    private static async Task<JsonElement> Post(User user, long channel, string[] files, string? title = null, string text = "", long[]? tags = null)
    {
        var reply = await user.RequestAsync("forum.post.create", new { channelId = channel, title, text, attachments = files, tags = tags ?? [] });
        Assert.True(reply.Type() == "result", reply.ToString());
        return reply.Body().GetProperty("post");
    }

    private static async Task<long[]> Tags(User admin, long channel, params string[] names)
    {
        var reply = await admin.RequestAsync("forum.tags.set", new { channelId = channel, tags = names.Select(n => new { name = n }) });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("tags").EnumerateArray().Select(t => t.GetProperty("id").GetInt64()).ToArray();
    }

    private static async Task<long[]> List(User user, long channel, object? extra = null)
    {
        var body = JsonSerializer.SerializeToNode(extra ?? new { })!.AsObject();
        body["channelId"] = channel;
        var reply = await user.RequestAsync("forum.posts", body);
        Assert.True(reply.Type() == "result", reply.ToString());
        return reply.Body().GetProperty("posts").EnumerateArray().Select(p => p.GetProperty("id").GetInt64()).ToArray();
    }

    private static string? Key(JsonElement reply) => reply.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    [Fact]
    public async Task A_media_post_needs_pictures_or_videos_and_the_title_is_optional()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var art = await MediaChannel(admin);

        // No media, or a file that isn't a picture or a video: refused.
        var none = await bob.RequestAsync("forum.post.create", new { channelId = art, title = "Sketch", text = "look" });
        Assert.Equal("bad_request", none.ErrorCode());
        Assert.Equal("media_post_needs_media", Key(none));
        var text = await EmojiTests.Upload(server, bob, "just some notes"u8.ToArray(), "notes.txt");
        var png = await EmojiTests.Upload(server, bob, Png(), "SPOILER_sunset.png");
        var mixed = await bob.RequestAsync("forum.post.create", new { channelId = art, text = "", attachments = new[] { png, text } });
        Assert.Equal("media_post_only_media", Key(mixed));

        // Pictures and videos, no title: the caption stands in for the thread's name.
        var video = await EmojiTests.Upload(server, bob, Webm(), "clip.webm");
        var post = await Post(bob, art, [png, video], text: "Evening walk <@" + admin.Key + ">\nsecond line");
        Assert.True(post.GetProperty("untitled").GetBoolean());
        Assert.Equal("Evening walk", post.GetProperty("title").GetString());
        Assert.Equal(["image/png", "video/webm"], post.GetProperty("media").EnumerateArray().Select(f => f.GetProperty("type").GetString()));
        Assert.Equal(0, post.GetProperty("reactionCount").GetInt32());

        // No caption either: the first file's name (without SPOILER_) stands in.
        var bare = await Post(bob, art, [await EmojiTests.Upload(server, bob, Png(), "SPOILER_sunset.png")]);
        Assert.Equal("sunset", bare.GetProperty("title").GetString());

        // A title makes it titled; renaming an untitled post does too.
        var titled = await Post(bob, art, [await EmojiTests.Upload(server, bob, Png(), "a.png")], title: "  Dragon  ");
        Assert.False(titled.GetProperty("untitled").GetBoolean());
        Assert.Equal("Dragon", titled.GetProperty("title").GetString());
        var renamed = (await bob.RequestAsync("forum.post.update", new { id = bare.GetProperty("id").GetInt64(), title = "Sunset" })).Body().GetProperty("post");
        Assert.False(renamed.GetProperty("untitled").GetBoolean());
        Assert.Equal("Sunset", renamed.GetProperty("title").GetString());

        // Plain messages don't go into a media channel; it can't be end-to-end encrypted.
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = art, text = "hi" })).ErrorCode());
        var sealedOne = await admin.RequestAsync("channel.create", new { name = "secret-art", kind = "media", e2ee = new { } });
        Assert.Equal("e2ee_kinds", Key(sealedOne));

        // Forums keep their rules: a title is required, attachments may be anything.
        var forum = (await admin.RequestAsync("channel.create", new { name = "help", kind = "forum" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await bob.RequestAsync("forum.post.create", new { channelId = forum, text = "x" })).ErrorCode());
        var withText = await bob.RequestAsync("forum.post.create", new { channelId = forum, title = "Notes", text = "", attachments = new[] { await EmojiTests.Upload(server, bob, "more notes"u8.ToArray(), "n.txt") } });
        Assert.Equal("result", withText.Type());
        Assert.False(withText.Body().GetProperty("post").GetProperty("untitled").GetBoolean());
    }

    [Fact]
    public async Task Media_channels_follow_their_roles_and_comments_are_the_posts_thread()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var gallery = await MediaChannel(admin, "gallery", "member", "admin");
        var staff = await MediaChannel(admin, "staff-art", "trusted");

        var refused = await member.RequestAsync("forum.post.create", new { channelId = gallery, attachments = new[] { await EmojiTests.Upload(server, member, Png(), "m.png") } });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("forum.posts", new { channelId = staff })).ErrorCode());
        var hidden = await Post(admin, staff, [await EmojiTests.Upload(server, admin, Png(), "s.png")]);
        Assert.Equal("not_found", (await member.RequestAsync("forum.post.get", new { id = hidden.GetProperty("id").GetInt64() })).ErrorCode());

        // As in forums, who can comment follows who can post.
        var banner = await Post(admin, gallery, [await EmojiTests.Upload(server, admin, Png(), "g.png")], title: "Banner");
        Assert.Equal("forbidden", (await member.RequestAsync("chat.send", new { channelId = banner.GetProperty("id").GetInt64(), text = "Love it" })).ErrorCode());
        var open = await MediaChannel(admin, "open-art");
        var post = await Post(admin, open, [await EmojiTests.Upload(server, admin, Png(), "o.png")], title: "Sketch");
        var id = post.GetProperty("id").GetInt64();
        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = id, text = "Love it" })).Type());
        Assert.Equal(1, (await member.RequestAsync("forum.post.get", new { id })).Body().GetProperty("post").GetProperty("replyCount").GetInt32());

        // A locked post takes comments only from moderators.
        Assert.Equal("result", (await admin.RequestAsync("forum.post.set", new { id, locked = true })).Type());
        Assert.Equal("forbidden", (await member.RequestAsync("chat.send", new { channelId = id, text = "more" })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("chat.send", new { channelId = id, text = "Closing this one" })).Type());
    }

    [Fact]
    public async Task Tags_filter_and_search_finds_titles_captions_and_tag_names()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var memes = await MediaChannel(admin, "memes");
        var tags = await Tags(admin, memes, "Cats", "Games");
        Task<string> Pic(string name) => EmojiTests.Upload(server, admin, Png(), name);

        var cat = (await Post(admin, memes, [await Pic("1.png")], text: "Monday mood", tags: [tags[0]])).GetProperty("id").GetInt64();
        var game = (await Post(admin, memes, [await Pic("2.png")], title: "Boss fight", tags: [tags[1]])).GetProperty("id").GetInt64();
        var plain = (await Post(admin, memes, [await Pic("3.png")], text: "a sunset")).GetProperty("id").GetInt64();

        Assert.Equal([cat], await List(admin, memes, new { tag = tags[0] }));
        Assert.Equal([game], await List(admin, memes, new { query = "boss" }));
        Assert.Equal([cat], await List(admin, memes, new { query = "mood" }));
        Assert.Equal([cat], await List(admin, memes, new { query = "cats" }));
        Assert.Equal([game], await List(admin, memes, new { query = "games fight" }));
        Assert.Equal([plain], await List(admin, memes, new { query = "sunset" }));
    }

    [Fact]
    public async Task Top_sorts_by_reactions_on_the_post_then_newest()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var art = await MediaChannel(admin);
        var posts = new List<JsonElement>();
        for (var i = 0; i < 3; i++) posts.Add(await Post(admin, art, [await EmojiTests.Upload(server, admin, Png(), $"{i}.png")], title: $"Piece {i}"));
        long Id(int i) => posts[i].GetProperty("id").GetInt64();
        long Root(int i) => posts[i].GetProperty("rootId").GetInt64();

        await admin.RequestAsync("chat.react", new { id = Root(0), emoji = "🔥" });
        await bob.RequestAsync("chat.react", new { id = Root(0), emoji = "🔥" });
        await bob.RequestAsync("chat.react", new { id = Root(1), emoji = "👍" });

        Assert.Equal([Id(0), Id(1), Id(2)], await List(admin, art, new { sort = "top" }));
        Assert.Equal([Id(2), Id(1), Id(0)], await List(admin, art, new { sort = "newest" }));
        var listed = (await admin.RequestAsync("forum.posts", new { channelId = art, sort = "top", limit = 1 })).Body();
        Assert.Equal(2, listed.GetProperty("posts")[0].GetProperty("reactionCount").GetInt32());

        // Paging keeps the order.
        var next = await List(admin, art, new { sort = "top", limit = 2, cursor = (await admin.RequestAsync("forum.posts", new { channelId = art, sort = "top", limit = 2 })).Body().GetProperty("cursor").GetString() });
        Assert.Equal([Id(2)], next);
        Assert.Equal("bad_request", (await admin.RequestAsync("forum.posts", new { channelId = art, sort = "best" })).ErrorCode());
    }

    [Fact]
    public void Templates_can_have_media_channels_with_tags()
    {
        var template = ServerTemplates.Parse("""
            { "version": 2, "name": "Art club", "channels": [ { "name": "art", "kind": "media", "tags": [{ "name": "Sketch" }] } ] }
            """, "test");
        Assert.Equal("media", template.Channels.Single().Kind);
        Assert.Contains("only forums and media channels have tags",
            Assert.Throws<TemplateException>(() => ServerTemplates.Parse("""
                { "version": 2, "name": "x", "channels": [ { "name": "chat", "tags": [{ "name": "Sketch" }] } ] }
                """, "test")).Message);
    }

    [Fact]
    public async Task Deleting_a_media_posts_first_message_deletes_the_post()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var art = await MediaChannel(admin);
        var post = await Post(admin, art, [await EmojiTests.Upload(server, admin, Png(), "x.png")]);
        Assert.Equal("result", (await admin.RequestAsync("chat.delete", new { id = post.GetProperty("rootId").GetInt64() })).Type());
        Assert.Empty(await List(admin, art));
        Assert.Equal("not_found", (await admin.RequestAsync("forum.post.get", new { id = post.GetProperty("id").GetInt64() })).ErrorCode());
    }
}
