using System.Text.Json;
using Iskra.Server.Storage;
using Iskra.Server.Templates;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>
/// Channel topics, and a template's starting content (format 3): topics, messages posted once as the server, docs pages
/// with a Start here page, disappearing timers and translation. Added only where there's none yet; never executable.
/// </summary>
public class TemplateContentTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "iskra-template-content-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_path, recursive: true); } catch (IOException) { }
    }

    private const string Club = """
        {
          "version": 3,
          "name": "Club",
          "channels": [
            { "name": "welcome", "writeRole": "admin", "topic": "  Start here  ",
              "messages": [ { "text": "# Hi!\nWelcome <@abc> @everyone <script>alert(1)</script>", "pin": true }, { "text": "Second" } ] },
            { "name": "guide", "kind": "docs", "topic": "Read me",
              "pages": [ { "title": "Start", "text": "Hello **there**\r\n- one", "startHere": true }, { "title": "More", "text": "More" } ] },
            { "name": "fleeting", "disappear": 3600 },
            { "name": "Talk", "kind": "voice", "topic": "Talk here", "disappear": 300 }
          ],
          "settings": { "translation": true }
        }
        """;

    private static Channel Named(Store store, string name) => store.AllChannels().Single(c => c.Name == name);

    [Fact]
    public void A_new_server_gets_topics_messages_pages_timers_and_translation()
    {
        using var world = World.OpenOrCreate(_path);
        Assert.Equal(ServerTemplates.Outcome.Applied, ServerTemplates.Apply(world, ServerTemplates.Parse(Club, "club.json"), "club.json", 1000));
        var store = world.Store;

        var welcome = Named(store, "welcome"); // the starting #general, renamed
        Assert.Equal("Start here", store.Topic(welcome.Id));
        var messages = store.History(welcome.Id, null, null, 10);
        Assert.Equal(2, messages.Count);
        Assert.All(messages, m => Assert.Equal(ServerTemplates.ContentAuthor, m.AuthorKey));
        Assert.StartsWith("# Hi!\nWelcome", messages[0].Text);
        Assert.DoesNotContain("@everyone", messages[0].Text, StringComparison.Ordinal); // mentions never ping
        Assert.Contains("<script>", messages[0].Text); // stored as text; the apps render Markdown, never HTML
        Assert.True(store.IsPinned(messages[0].Id));
        Assert.False(store.IsPinned(messages[1].Id));

        var guide = Named(store, "guide");
        Assert.Equal("Read me", store.Topic(guide.Id));
        var pages = store.DocPages(guide.Id);
        Assert.Equal(["Start", "More"], pages.Select(p => p.Title));
        Assert.Equal(pages[0].Id, store.DocHome());
        var start = store.GetDocPage(pages[0].Id, withText: true)!;
        Assert.Equal("Hello **there**\n- one", start.Text);
        Assert.Equal(ServerTemplates.ContentAuthor, start.CreatedBy);

        Assert.Equal(3600, store.ChannelTimer(Named(store, "fleeting").Id)!.Seconds);
        Assert.Equal(300, store.ChannelTimer(Named(store, "Talk").Id)!.Seconds);
        Assert.Equal("Talk here", store.Topic(Named(store, "Talk").Id));
        Assert.Null(store.ChannelTimer(welcome.Id));
        Assert.True(world.Settings.Translate.Offer);
    }

    [Fact]
    public async Task Members_see_the_topics_and_the_welcome_messages_under_the_servers_name()
    {
        Directory.CreateDirectory(_path);
        var file = Path.Combine(_path, "club.json");
        File.WriteAllText(file, Club);
        using var server = new IskraServer { Settings = { ["Template"] = file } };
        using var member = await server.JoinAsync("Member");
        var channels = member.Welcome.Body().GetProperty("channels").EnumerateArray().ToList();
        var welcome = channels.Single(c => c.GetProperty("name").GetString() == "welcome");
        Assert.Equal("Start here", welcome.GetProperty("topic").GetString());
        Assert.Equal("", channels.Single(c => c.GetProperty("name").GetString() == "fleeting").GetProperty("topic").GetString());

        var history = await member.RequestAsync("chat.history", new { channelId = welcome.GetProperty("id").GetInt64() });
        var first = history.Body().GetProperty("messages").EnumerateArray().First();
        Assert.Equal(server.World.Settings.Name, first.GetProperty("webhook").GetProperty("name").GetString());
        var pins = await member.RequestAsync("pin.list", new { channelId = welcome.GetProperty("id").GetInt64() });
        Assert.Single(pins.Body().GetProperty("pins").EnumerateArray());
    }

    [Fact]
    public async Task Admins_set_topics_members_see_them_and_bad_ones_are_refused()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");

        var updated = await owner.RequestAsync("channel.update", new { id = server.General, topic = "  Talk about anything.  " });
        Assert.Equal("Talk about anything.", updated.Body().GetProperty("channel").GetProperty("topic").GetString());
        var seen = (await member.EventAsync("channels")).Body().GetProperty("channels").EnumerateArray()
            .Single(c => c.GetProperty("id").GetInt64() == server.General);
        Assert.Equal("Talk about anything.", seen.GetProperty("topic").GetString());

        Assert.Equal("forbidden", (await member.RequestAsync("channel.update", new { id = server.General, topic = "mine now" })).ErrorCode());
        foreach (var bad in new[] { new string('x', 301), "two\nlines", "bidi‮override" })
            Assert.Equal("channel_topic", (await owner.RequestAsync("channel.update", new { id = server.General, topic = bad })).Body().GetProperty("key").GetString());
        Assert.Equal("Talk about anything.", server.World.Store.Topic(server.General));

        // Leaving it out keeps it; blank removes it.
        await owner.RequestAsync("channel.update", new { id = server.General, slowmode = 5 });
        Assert.Equal("Talk about anything.", server.World.Store.Topic(server.General));
        var cleared = await owner.RequestAsync("channel.update", new { id = server.General, topic = " " });
        Assert.Equal("", cleared.Body().GetProperty("channel").GetProperty("topic").GetString());

        var created = await owner.RequestAsync("channel.create", new { name = "news", kind = "voice", topic = "Talk about the news" });
        Assert.Equal("Talk about the news", created.Body().GetProperty("channel").GetProperty("topic").GetString());
        var id = created.Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("channel.delete", new { id })).Type());
        Assert.Empty(server.World.Store.AllTopics()); // gone with the channel
    }

    [Fact]
    public void Applying_to_a_server_in_use_adds_content_only_where_there_is_none_and_twice_adds_nothing()
    {
        using var world = World.OpenOrCreate(_path);
        var store = world.Store;
        store.AddMember("owner-key", "Owner", "owner", 1000);
        var general = store.AllChannels().Single();
        store.UpdateChannel(general with { Name = "welcome" });
        var hello = store.AddMessage(general.Id, "owner-key", "hello", 1100);
        var docs = store.CreateChannel("guide", "docs", "member", "trusted", 1000);
        store.CreateDocPage(docs.Id, null, "Start", "the owner's own start page", [], "owner-key", 1000);
        var talk = store.CreateChannel("Talk", "voice", "member", "member", 1000);
        store.SetTopic(talk.Id, "Our own topic");
        store.SetChannelTimer(talk.Id, 0, "owner-key", 1000); // someone turned it off: a choice, kept
        var template = ServerTemplates.Parse(Club, "club.json");

        var plan = ServerTemplates.Merge(world, template, apply: false, 2000);
        Assert.Equal([
            "topic for #welcome", "2 messages in #welcome",
            "topic for guide", "page \"More\" in guide",
            "text channel fleeting", "disappearing messages in #fleeting (1 h)",
            "translation offered to members",
        ], plan);
        Assert.Equal(plan, ServerTemplates.Merge(world, template, apply: true, 3000));

        Assert.Equal("hello", store.GetMessage(hello.Id)!.Text);
        Assert.Equal(3, store.History(general.Id, null, null, 10).Count);
        Assert.Equal("Our own topic", store.Topic(talk.Id));
        Assert.Equal(0, store.ChannelTimer(talk.Id)!.Seconds);
        Assert.Equal("the owner's own start page", store.GetDocPage(store.DocPages(docs.Id).Single(p => p.Title == "Start").Id, withText: true)!.Text);
        Assert.Null(store.DocHome()); // "More" isn't the start page, and the owner's "Start" stays theirs
        Assert.Equal(3600, store.ChannelTimer(Named(store, "fleeting").Id)!.Seconds);

        Assert.Empty(ServerTemplates.Merge(world, template, apply: true, 4000));
        Assert.Equal(3, store.History(general.Id, null, null, 10).Count);
    }

    [Fact]
    public void Messages_never_go_into_a_channel_with_disappearing_messages()
    {
        using var world = World.OpenOrCreate(_path);
        var general = world.Store.AllChannels().Single();
        world.Store.UpdateChannel(general with { Name = "welcome" });
        world.Store.SetChannelTimer(general.Id, 300, "owner-key", 1000);
        var plan = ServerTemplates.Merge(world, ServerTemplates.Parse(Club, "club.json"), apply: true, 2000);
        Assert.Contains("(skipped) messages in #welcome: it has disappearing messages", plan);
        Assert.Empty(world.Store.History(general.Id, null, null, 10));
    }

    [Theory]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "topic": "two\nlines" } ] }""", "'topic' can be up to 300 characters, on one line")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "kind": "voice", "messages": [ { "text": "hi" } ] } ] }""", "only text channels can have 'messages'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "messages": [ { "text": "  " } ] } ] }""", "message 1 must be 1–4000 characters")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "messages": [ { "text": "hi", "html": "<b>" } ] } ] }""", "unknown field")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "pages": [ { "title": "t", "text": "x" } ] } ] }""", "only docs channels can have 'pages'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "d", "kind": "docs", "pages": [ { "title": "", "text": "x" } ] } ] }""", "page 1 needs a 'title'")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "d", "kind": "docs", "pages": [ { "title": "A", "text": "x" }, { "title": "a", "text": "y" } ] } ] }""", "two pages have the same title")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "d", "kind": "docs", "pages": [ { "title": "A", "startHere": true } ] }, { "name": "e", "kind": "docs", "pages": [ { "title": "B", "startHere": true } ] } ] }""", "only one page can be the 'startHere' page")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "disappear": 7 } ] }""", "'disappear' must be 0 (off) or one of")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "d", "kind": "docs", "disappear": 300 } ] }""", "only text and voice channels can have disappearing messages")]
    [InlineData("""{ "name": "x", "channels": [ { "name": "a", "disappear": 300, "messages": [ { "text": "hi" } ] } ] }""", "can't have 'messages'")]
    [InlineData("""{ "version": 4, "name": "x" }""", "made by a newer version of Iskra (format 4)")]
    public void Bad_content_is_rejected_with_a_clear_error(string json, string expected)
    {
        var error = Assert.Throws<TemplateException>(() => ServerTemplates.Parse(json, "bad.json"));
        Assert.Contains(expected, error.Message);
    }

    [Fact]
    public void Too_many_messages_or_too_big_a_page_is_refused()
    {
        var eleven = string.Join(", ", Enumerable.Range(1, 11).Select(i => $$"""{ "text": "m{{i}}" }"""));
        Assert.Contains("at most 10 messages per channel",
            Assert.Throws<TemplateException>(() => ServerTemplates.Parse($$"""{ "name": "x", "channels": [ { "name": "a", "messages": [ {{eleven}} ] } ] }""", "t")).Message);
        var big = new string('x', 101 * 1024);
        Assert.Contains("can be up to 100 KB",
            Assert.Throws<TemplateException>(() => ServerTemplates.Parse($$"""{ "name": "x", "channels": [ { "name": "d", "kind": "docs", "pages": [ { "title": "Big", "text": "{{big}}" } ] } ] }""", "t")).Message);
    }

    [Fact]
    public async Task Save_as_template_keeps_topics_and_timers_but_never_messages_or_pages()
    {
        Directory.CreateDirectory(_path);
        var file = Path.Combine(_path, "club.json");
        File.WriteAllText(file, Club);
        using var server = new IskraServer { Settings = { ["Template"] = file } };
        using var owner = await server.JoinAsync("Owner", "owner");
        var json = (await owner.RequestAsync("server.template.export")).Body().GetProperty("template").GetRawText();
        Assert.DoesNotContain("Welcome", json);
        Assert.DoesNotContain("Hello", json);
        var template = ServerTemplates.Parse(json, "export.json");
        Assert.Equal(3, template.Version);
        Assert.Equal("Start here", template.AllChannels.Single(c => c.Name == "welcome").Topic);
        Assert.Equal(3600, template.AllChannels.Single(c => c.Name == "fleeting").Disappear);
        Assert.All(template.AllChannels, c => Assert.Empty(c.Messages));
        Assert.All(template.AllChannels, c => Assert.Empty(c.Pages));
        Assert.True(template.Settings!.Translation);
    }

    private static string Repo(params string[] parts)
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "server", "templates", "review.json"))) dir = Path.GetDirectoryName(dir);
        return Path.Combine([dir ?? throw new DirectoryNotFoundException("repo"), .. parts]);
    }

    [Fact]
    public void The_review_template_has_a_guide_topics_everywhere_and_twice_adds_nothing()
    {
        var review = ServerTemplates.Load(Repo("server", "templates", "review.json"));
        Assert.All(review.AllChannels, c => Assert.False(string.IsNullOrEmpty(c.Topic), $"{c.Name} has no topic"));
        Assert.Contains(review.AllChannels, c => c.Kind == "forum" && c.Name == "feedback");
        Assert.NotNull(review.Rules);

        using var world = World.OpenOrCreate(_path);
        var first = ServerTemplates.Merge(world, review, apply: true, 1000);
        Assert.DoesNotContain(first, p => p.StartsWith("(skipped)"));
        var store = world.Store;
        var welcome = Named(store, "welcome");
        Assert.Equal(2, store.Pins(welcome.Id).Count);
        var guide = Named(store, "testing-guide");
        Assert.Equal("How to test", store.GetDocPage(store.DocHome()!.Value)!.Title);
        Assert.Equal(3, store.DocPages(guide.Id).Count);
        Assert.Equal("admin", guide.WriteRole);
        Assert.All(store.AllChannels(), c => Assert.NotEqual("", store.Topic(c.Id)));
        Assert.Empty(ServerTemplates.Merge(world, review, apply: true, 2000));
        Assert.Equal(2, store.History(welcome.Id, null, null, 10).Count);
    }

    [Fact]
    public void The_bug_inbox_template_turns_on_the_inbox_in_a_private_channel_and_twice_adds_nothing()
    {
        var template = ServerTemplates.Load(Repo("server", "templates", "bug-inbox.json"));
        using var world = World.OpenOrCreate(_path);
        Assert.Contains("bug inbox in bug-reports", ServerTemplates.Merge(world, template, apply: true, 1000));
        var inbox = Named(world.Store, "bug-reports");
        Assert.Equal("admin", inbox.ReadRole);
        Assert.Equal(new BugInboxSettings(true, inbox.Id), world.Store.GetBugInbox());
        Assert.Equal(Named(world.Store, "AFK").Id, world.Store.Afk().ChannelId);
        Assert.Empty(ServerTemplates.Merge(world, template, apply: true, 2000));
    }

    [Fact]
    public void The_bug_inbox_is_never_turned_on_in_a_channel_members_can_read()
    {
        var template = ServerTemplates.Load(Repo("server", "templates", "bug-inbox.json"));
        using var world = World.OpenOrCreate(_path);
        world.Store.CreateChannel("bug-reports", "text", "member", "member", 1000); // made by hand, public
        var plan = ServerTemplates.Merge(world, template, apply: true, 2000);
        Assert.Contains("(skipped) bug inbox in bug-reports: members can read #bug-reports, the template says admin", plan);
        Assert.False(world.Store.GetBugInbox().Enabled);
    }
}
