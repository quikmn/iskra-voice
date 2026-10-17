using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Built-in bots Tags, Suggestions, Giveaways and Counting: who may do what, limits, defused mentions, fair draws, counts.</summary>
public class BuiltinBots3Tests
{
    private static IskraServer Server() => new() { Settings = { ["BuiltinBots:TickMs"] = "0" } };

    private static BuiltinBotRuntime Runtime(IskraServer server) => server.Services.GetRequiredService<BuiltinBotRuntime>();

    private static async Task<string> TurnOn(User admin, string bot)
    {
        var reply = await admin.RequestAsync("builtin.bots.set", new { bot, enabled = true });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("bots").EnumerateArray().Single(b => b.GetProperty("id").GetString() == bot).GetProperty("accountKey").GetString()!;
    }

    private static async Task<JsonElement> Configure(User admin, object body)
    {
        var reply = await admin.RequestAsync("builtin.bots.config.set", body);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("config");
    }

    private static async Task<long> Say(User user, long channelId, string text)
    {
        var reply = await user.RequestAsync("chat.send", new { channelId, text });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("message").GetProperty("id").GetInt64();
    }

    private static string? ErrorKey(JsonElement reply) =>
        reply.GetProperty("body").TryGetProperty("key", out var key) ? key.GetString() : null;

    /// <summary>The next private answer from a built-in bot: what it means.</summary>
    private static async Task<JsonElement> Private(User user) => (await user.EventAsync("interaction.response")).Body().GetProperty("builtin");

    /// <summary>The next message from <paramref name="bot"/> that <paramref name="watcher"/> sees.</summary>
    private static async Task<JsonElement> BotMessage(User watcher, string bot, string? kind = null)
    {
        while (true)
        {
            var message = (await watcher.EventAsync("chat.message")).Body().GetProperty("message");
            if (message.GetProperty("author").GetString() != bot) continue;
            if (kind is null || message.GetProperty("builtin").GetProperty("kind").GetString() == kind) return message;
        }
    }

    private static List<Message> Posts(IskraServer server, long channelId, string author) =>
        server.World.Store.History(channelId, null, null, 200).Where(m => m.AuthorKey == author).ToList();

    private static JsonElement Builtin(IskraServer server, long messageId) => JsonDocument.Parse(server.World.Store.GetBuiltinReply(messageId)!).RootElement.Clone();

    private static async Task<long> Role(User admin, string name, bool selfAssign = false)
    {
        var reply = await admin.RequestAsync("role.create", new { name, selfAssign, permissions = Array.Empty<string>() });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("role").GetProperty("id").GetInt64();
    }

    private static async Task Give(User admin, User to, params long[] roles) =>
        Assert.Equal("result", (await admin.RequestAsync("member.roles.set", new { accountKey = to.Key, roles })).Type());

    private static long Channel(IskraServer server, string name) => server.World.Store.AllChannels().Single(c => c.Name == name).Id;

    // ── All four ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task They_are_listed_admins_turn_them_on_and_settings_are_checked_and_audited()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        var listed = alice.Welcome.Body().GetProperty("builtinBots").EnumerateArray().Select(b => b.GetProperty("id").GetString()).ToList();
        Assert.Equal(["tags", "suggestions", "giveaways", "counting"], listed.Skip(7));
        Assert.Equal("forbidden", (await alice.RequestAsync("builtin.bots.set", new { bot = "tags", enabled = true })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("builtin.bots.config.set", new { bot = "counting", math = true })).ErrorCode());

        // Turned on: Suggestions gets #suggestions (admins write), Counting #counting (members write) with its pinned card.
        var tags = await TurnOn(admin, "tags");
        await TurnOn(admin, "suggestions");
        await TurnOn(admin, "giveaways");
        var counting = await TurnOn(admin, "counting");
        var suggestions = server.World.Store.GetChannel(Channel(server, "suggestions"))!;
        Assert.Equal(("member", "admin"), (suggestions.ReadRole, suggestions.WriteRole));
        var countingChannel = server.World.Store.GetChannel(Channel(server, "counting"))!;
        Assert.Equal(("member", "member"), (countingChannel.ReadRole, countingChannel.WriteRole));
        var card = Assert.Single(Posts(server, countingChannel.Id, counting));
        Assert.True(server.World.Store.IsPinned(card.Id));
        Assert.Equal("counting.card", Builtin(server, card.Id).GetProperty("kind").GetString());

        // Off and on: the same member, no second channel or card.
        await admin.RequestAsync("builtin.bots.set", new { bot = "counting", enabled = false });
        Assert.Equal(counting, await TurnOn(admin, "counting"));
        Assert.Single(server.World.Store.AllChannels(), c => c.Name == "counting");
        Assert.Single(Posts(server, countingChannel.Id, counting));
        Assert.Equal(tags, server.World.Store.BuiltinBots().Single(b => b.Id == "tags").AccountKey);

        // Staff roles: existing ones members can't give themselves.
        var picked = await Role(admin, "Gamers", selfAssign: true);
        var staff = await Role(admin, "Staff");
        Assert.Equal("builtin_bot_role", ErrorKey(await admin.RequestAsync("builtin.bots.config.set", new { bot = "tags", managerRoleId = picked })));
        Assert.Equal("not_found", (await admin.RequestAsync("builtin.bots.config.set", new { bot = "giveaways", staffRoleId = 999_999 })).ErrorCode());
        Assert.Equal(staff, (await Configure(admin, new { bot = "tags", managerRoleId = staff })).GetProperty("managerRoleId").GetInt64());
        var config = await Configure(admin, new { bot = "suggestions", staffRoleId = staff, anonymous = true });
        Assert.True(config.GetProperty("anonymous").GetBoolean());
        Assert.Equal(suggestions.Id, config.GetProperty("channelId").GetInt64());
        Assert.Equal(JsonValueKind.Null, (await Configure(admin, new { bot = "giveaways", staffRoleId = (long?)null })).GetProperty("staffRoleId").ValueKind);
        var lounge = (await admin.RequestAsync("channel.create", new { name = "lounge", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("builtin_bot_channel", ErrorKey(await admin.RequestAsync("builtin.bots.config.set", new { bot = "counting", channelId = lounge })));
        config = await Configure(admin, new { bot = "counting", math = true });
        Assert.True(config.GetProperty("math").GetBoolean());
        Assert.Equal(0, config.GetProperty("best").GetInt64());

        var audit = (await admin.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray()
            .Where(e => e.GetProperty("action").GetString() == "builtin.bot.config").ToList();
        Assert.Equal(4, audit.Count);
    }

    // ── Tags ─────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Tags_are_managed_by_admins_and_the_manager_role_with_names_and_limits_checked()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await TurnOn(admin, "tags");

        Assert.Equal("tags_manage", ErrorKey(await alice.RequestAsync("tags.set", new { name = "rules", text = "Be kind." })));
        var managers = await Role(admin, "Tag keepers");
        await Configure(admin, new { bot = "tags", managerRoleId = managers });
        await Give(admin, alice, managers);
        var saved = await alice.RequestAsync("tags.set", new { name = "Rules", text = "Be **kind**.\nNo spam." });
        Assert.Equal("result", saved.Type());
        Assert.Equal("rules", saved.Body().GetProperty("tag").GetProperty("name").GetString()); // lowercased
        Assert.True(saved.Body().GetProperty("created").GetBoolean());
        Assert.False((await alice.RequestAsync("tags.set", new { name = "rules", text = "Be kind." })).Body().GetProperty("created").GetBoolean());

        foreach (var bad in new[] { "two words", "list", "set", "remove", "ünicode", new string('a', 33) })
            Assert.Equal("tags_name", ErrorKey(await alice.RequestAsync("tags.set", new { name = bad, text = "x" })));
        Assert.Equal("tags_text", ErrorKey(await alice.RequestAsync("tags.set", new { name = "long", text = new string('a', 2001) })));
        Assert.Equal("tags_text", ErrorKey(await alice.RequestAsync("tags.set", new { name = "empty", text = "   " })));

        // Everyone can list them; only managers are told they can manage.
        var list = (await bob.RequestAsync("tags.list")).Body();
        Assert.False(list.GetProperty("canManage").GetBoolean());
        Assert.Equal(200, list.GetProperty("max").GetInt32());
        Assert.Equal("rules", Assert.Single(list.GetProperty("tags").EnumerateArray()).GetProperty("name").GetString());
        Assert.True((await alice.RequestAsync("tags.list")).Body().GetProperty("canManage").GetBoolean());

        // At most 200.
        for (var i = 0; i < 199; i++) server.World.Store.SetTag($"t{i}", "x", admin.Key, 1, TagsBot.MaxTags);
        Assert.Equal("tags_max", ErrorKey(await alice.RequestAsync("tags.set", new { name = "one-more", text = "x" })));
        Assert.Equal("result", (await alice.RequestAsync("tags.set", new { name = "rules", text = "Replacing is fine." })).Type());

        Assert.Equal("tags_manage", ErrorKey(await bob.RequestAsync("tags.remove", new { name = "rules" })));
        Assert.Equal("result", (await admin.RequestAsync("tags.remove", new { name = "rules" })).Type());
        Assert.Equal("tags_unknown", ErrorKey(await admin.RequestAsync("tags.remove", new { name = "rules" })));

        // Audited by name, never the text.
        var audit = (await admin.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray()
            .Where(e => e.GetProperty("action").GetString() is "tag.set" or "tag.remove").ToList();
        Assert.Equal(4, audit.Count);
        Assert.DoesNotContain("kind", string.Join("", audit.Select(a => a.GetRawText())));
    }

    [Fact]
    public async Task Slash_tag_posts_the_snippet_without_pinging_anyone_and_answers_mistakes_privately()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var bot = await TurnOn(admin, "tags");
        Assert.Equal("result", (await admin.RequestAsync("tags.set",
            new { name = "ping", text = $"Hello @everyone and @here, <@{alice.Key}> and <@&5>!" })).Type());

        await Say(alice, server.General, "/tag ping");
        var post = await BotMessage(alice, bot);
        var text = post.GetProperty("text").GetString()!;
        Assert.DoesNotContain("@everyone", text, StringComparison.Ordinal);
        Assert.DoesNotContain("@here", text, StringComparison.Ordinal);
        Assert.DoesNotContain("<@", text, StringComparison.Ordinal);
        Assert.Equal("tag", post.GetProperty("builtin").GetProperty("kind").GetString());
        Assert.Equal("ping", post.GetProperty("builtin").GetProperty("name").GetString());
        Assert.Equal(text, post.GetProperty("builtin").GetProperty("text").GetString());
        Assert.Empty(server.World.Store.InboxItems(alice.Key, null, 10)); // nobody got a mention

        await Say(alice, server.General, "/tag list");
        var list = await Private(alice);
        Assert.Equal("tag.list", list.GetProperty("kind").GetString());
        Assert.Equal(["ping"], list.GetProperty("names").EnumerateArray().Select(n => n.GetString()));
        await Say(alice, server.General, "/tag nope");
        Assert.Equal("tag.unknown", (await Private(alice)).GetProperty("kind").GetString());
        await Say(alice, server.General, "/tag set mine It's mine");
        var refused = await Private(alice);
        Assert.Equal("error", refused.GetProperty("kind").GetString());
        Assert.Equal("tags_manage", refused.GetProperty("error").GetProperty("key").GetString());

        await Say(admin, server.General, "/tag set faq Read the pins.");
        Assert.Equal("tag.saved", (await Private(admin)).GetProperty("kind").GetString());
        Assert.Equal("Read the pins.", server.World.Store.GetTag("faq")!.Text);
        await Say(admin, server.General, "/tag remove faq");
        Assert.Equal("tag.removed", (await Private(admin)).GetProperty("kind").GetString());
        Assert.Null(server.World.Store.GetTag("faq"));
        Assert.Single(Posts(server, server.General, bot)); // only the snippet was public
    }

    // ── Suggestions ──────────────────────────────────────────────────────────

    [Fact]
    public async Task A_suggestion_becomes_a_card_with_changeable_votes_and_staff_decide_it()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        Assert.Equal("suggestions_off", ErrorKey(await alice.RequestAsync("suggestion.create", new { text = "Movie night" })));
        var bot = await TurnOn(admin, "suggestions");
        var board = Channel(server, "suggestions");

        // /suggest: the card goes to #suggestions, the command goes away, the answer is private.
        var command = await Say(alice, server.General, "/suggest Movie night on Fridays @everyone");
        var posted = await Private(alice);
        Assert.Equal("suggestion.posted", posted.GetProperty("kind").GetString());
        var id = posted.GetProperty("messageId").GetInt64();
        Assert.Null(server.World.Store.GetMessage(command));
        var card = Builtin(server, id);
        Assert.Equal("suggestion", card.GetProperty("kind").GetString());
        Assert.Equal(alice.Key, card.GetProperty("author").GetString());
        Assert.DoesNotContain("@everyone", card.GetProperty("text").GetString(), StringComparison.Ordinal);
        Assert.Equal(board, server.World.Store.GetMessage(id)!.ChannelId);

        // One vote each, changeable, and taken back with 0.
        Assert.Equal(1, (await bob.RequestAsync("suggestion.vote", new { messageId = id, vote = 1 })).Body().GetProperty("up").GetInt32());
        Assert.Equal(1, (await bob.RequestAsync("suggestion.vote", new { messageId = id, vote = 1 })).Body().GetProperty("up").GetInt32());
        await carol.RequestAsync("suggestion.vote", new { messageId = id, vote = 1 });
        var changed = (await bob.RequestAsync("suggestion.vote", new { messageId = id, vote = -1 })).Body();
        Assert.Equal((1, 1), (changed.GetProperty("up").GetInt32(), changed.GetProperty("down").GetInt32()));
        Assert.Equal((1, 1), (Builtin(server, id).GetProperty("up").GetInt32(), Builtin(server, id).GetProperty("down").GetInt32()));
        Assert.Contains("👍 1 · 👎 1", server.World.Store.GetMessage(id)!.Text);
        await carol.RequestAsync("suggestion.vote", new { messageId = id, vote = 0 });
        Assert.Equal(0, Builtin(server, id).GetProperty("up").GetInt32());
        Assert.Equal("bad_request", (await bob.RequestAsync("suggestion.vote", new { messageId = id, vote = 2 })).ErrorCode());
        var mine = (await bob.RequestAsync("builtin.cards.mine", new { messageIds = new[] { id } })).Body();
        Assert.Equal(-1, mine.GetProperty("votes").GetProperty(id.ToString()).GetInt32());
        // Votes only on the bot's cards.
        var plain = await Say(bob, server.General, "not a card");
        Assert.Equal("not_found", (await bob.RequestAsync("suggestion.vote", new { messageId = plain, vote = 1 })).ErrorCode());

        // Staff (admins and the staff role) decide; the author hears privately; voting ends.
        Assert.Equal("suggestions_staff", ErrorKey(await bob.RequestAsync("suggestion.decide", new { messageId = id, status = "accepted" })));
        var staff = await Role(admin, "Staff");
        await Configure(admin, new { bot = "suggestions", staffRoleId = staff });
        await Give(admin, bob, staff);
        Assert.Equal("suggestion_reason", ErrorKey(await bob.RequestAsync("suggestion.decide", new { messageId = id, status = "declined", reason = new string('r', 301) })));
        Assert.Equal("result", (await bob.RequestAsync("suggestion.decide", new { messageId = id, status = "declined", reason = "We tried, nobody came" })).Type());
        var note = await Private(alice);
        Assert.Equal("suggestion.decided", note.GetProperty("kind").GetString());
        Assert.Equal("declined", note.GetProperty("status").GetString());
        Assert.Equal("We tried, nobody came", note.GetProperty("reason").GetString());
        card = Builtin(server, id);
        Assert.Equal("declined", card.GetProperty("status").GetString());
        Assert.Equal(bob.Key, card.GetProperty("decidedBy").GetString());
        Assert.Equal("suggestion_closed", ErrorKey(await carol.RequestAsync("suggestion.vote", new { messageId = id, vote = 1 })));
        Assert.Contains(server.World.Store.Audit(null, null, null, 20).Select(e => e.Action), a => a == "suggestion.decide");

        // In Alice's data; Bob's vote goes when he leaves, Alice's authorship when she does.
        var data = await ComplianceTests.Download(server, (await alice.RequestAsync("data.export")).Body());
        Assert.Equal(id, Assert.Single(data.GetProperty("suggestionsMade").EnumerateArray()).GetProperty("message_id").GetInt64());
        Assert.Equal("result", (await bob.RequestAsync("member.leave")).Type());
        Assert.Equal((0, 0), server.World.Store.SuggestionVotes(id));
        Assert.Equal("result", (await alice.RequestAsync("member.leave")).Type());
        Assert.Null(server.World.Store.GetSuggestion(id)!.AuthorKey);
        _ = bot;
    }

    [Fact]
    public async Task Anonymous_suggestions_hide_the_author_but_staff_can_look_and_people_are_limited()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var bot = await TurnOn(admin, "suggestions");
        await Configure(admin, new { bot = "suggestions", anonymous = true });

        var made = (await alice.RequestAsync("suggestion.create", new { text = "A quieter #general" })).Body();
        var id = made.GetProperty("messageId").GetInt64();
        var card = Builtin(server, id);
        Assert.True(card.GetProperty("anonymous").GetBoolean());
        Assert.Equal(JsonValueKind.Null, card.GetProperty("author").ValueKind);
        Assert.Equal(bot, card.GetProperty("for").GetString()); // not the author
        Assert.DoesNotContain("Alice", server.World.Store.GetMessage(id)!.Text);
        Assert.Equal(alice.Key, server.World.Store.GetSuggestion(id)!.AuthorKey); // kept for staff

        Assert.Equal("suggestions_staff", ErrorKey(await alice.RequestAsync("suggestion.author", new { messageId = id })));
        Assert.Equal(alice.Key, (await admin.RequestAsync("suggestion.author", new { messageId = id })).Body().GetProperty("accountKey").GetString());
        Assert.Contains(server.World.Store.Audit(null, null, null, 20), e => e.Action == "suggestion.author");

        // Three every ten minutes; text limits.
        await alice.RequestAsync("suggestion.create", new { text = "Two" });
        await alice.RequestAsync("suggestion.create", new { text = "Three" });
        Assert.Equal("suggestions_slow", ErrorKey(await alice.RequestAsync("suggestion.create", new { text = "Four" })));
        Assert.Equal("suggestion_text", ErrorKey(await admin.RequestAsync("suggestion.create", new { text = new string('a', 1001) })));

        // The prompt card with its Suggest button: admins post it.
        Assert.Equal("builtin_bots_config_admin", ErrorKey(await alice.RequestAsync("suggestions.prompt")));
        var prompt = (await admin.RequestAsync("suggestions.prompt")).Body().GetProperty("messageId").GetInt64();
        Assert.Equal("suggestion.prompt", Builtin(server, prompt).GetProperty("kind").GetString());

        // No channel (or one the bot can't see): a clear answer.
        await Configure(admin, new { bot = "suggestions", channelId = (long?)null });
        Assert.Equal("suggestions_channel", ErrorKey(await admin.RequestAsync("suggestion.create", new { text = "Hello" })));
    }

    // ── Giveaways ────────────────────────────────────────────────────────────

    [Fact]
    public void The_draw_is_fair_and_repeatable_with_a_seeded_generator()
    {
        string[] pool = ["a", "b", "c", "d", "e", "f"];
        var first = GiveawayBot.Draw(pool, 3, new Random(42).Next);
        var again = GiveawayBot.Draw(pool, 3, new Random(42).Next);
        Assert.Equal(first, again);
        Assert.Equal(3, first.Distinct().Count());
        Assert.All(first, w => Assert.Contains(w, pool));
        Assert.Equal(6, GiveawayBot.Draw(pool, 10, new Random(1).Next).Distinct().Count()); // more winners than people: everyone
        Assert.Empty(GiveawayBot.Draw([], 2));

        // Every entrant equally likely: 6000 single draws from three land about 2000 each.
        var random = new Random(7);
        var counts = new Dictionary<string, int> { ["x"] = 0, ["y"] = 0, ["z"] = 0 };
        for (var i = 0; i < 6000; i++) counts[GiveawayBot.Draw(["x", "y", "z"], 1, random.Next)[0]]++;
        Assert.All(counts.Values, n => Assert.InRange(n, 1800, 2200));
        // The real one uses the secure generator.
        Assert.Single(GiveawayBot.Draw(pool, 1));
    }

    [Theory]
    [InlineData("1h Steam key", 3_600_000L, 1, null, "Steam key")]
    [InlineData("1h30m 2w A pizza", 5_400_000L, 2, null, "A pizza")]
    [InlineData("2d <@&7> 3w Big prize", 172_800_000L, 3, 7L, "Big prize")]
    public void Giveaway_commands_parse(string args, long ms, int winners, long? role, string prize)
    {
        var start = GiveawayBot.Parse(args)!;
        Assert.Equal((ms, winners, role, prize), (start.DurationMs, start.Winners, start.RoleId, start.Prize));
    }

    [Theory]
    [InlineData("Steam key")]
    [InlineData("1h")]
    [InlineData("1y prize")]
    public void Not_giveaway_commands(string args) => Assert.Null(GiveawayBot.Parse(args));

    [Fact]
    public async Task A_giveaway_takes_entries_draws_fairly_from_who_may_win_and_rerolls()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var bot = await TurnOn(admin, "giveaways");
        var dice = await TurnOn(admin, "dice");

        // Staff only; a member's try is answered privately.
        await Say(alice, server.General, "/giveaway 1h Free stuff");
        Assert.Equal("giveaways_staff", (await Private(alice)).GetProperty("error").GetProperty("key").GetString());
        await Say(admin, server.General, "/giveaway soon Free stuff");
        Assert.Equal("giveaway.usage", (await Private(admin)).GetProperty("kind").GetString());
        await Say(admin, server.General, "/giveaway 31d Too long");
        Assert.Equal("giveaway_duration", (await Private(admin)).GetProperty("error").GetProperty("key").GetString());

        await Say(admin, server.General, "/giveaway 1h 2w Steam key @everyone");
        var card = await BotMessage(alice, bot);
        var id = card.GetProperty("id").GetInt64();
        var builtin = card.GetProperty("builtin");
        Assert.Equal("giveaway", builtin.GetProperty("kind").GetString());
        Assert.Equal(2, builtin.GetProperty("winners").GetInt32());
        Assert.Equal("open", builtin.GetProperty("status").GetString());
        Assert.DoesNotContain("@everyone", builtin.GetProperty("prize").GetString(), StringComparison.Ordinal);

        // Enter, leave again, enter: one entry each. Bots can't enter.
        foreach (var user in new[] { alice, bob, carol })
            Assert.True((await user.RequestAsync("giveaway.enter", new { messageId = id, entered = true })).Body().GetProperty("entered").GetBoolean());
        Assert.Equal(2, (await bob.RequestAsync("giveaway.enter", new { messageId = id, entered = false })).Body().GetProperty("entrants").GetInt32());
        Assert.Equal(3, (await bob.RequestAsync("giveaway.enter", new { messageId = id, entered = true })).Body().GetProperty("entrants").GetInt32());
        Assert.Equal(3, (await bob.RequestAsync("giveaway.enter", new { messageId = id, entered = true })).Body().GetProperty("entrants").GetInt32());
        Assert.Equal(3, Builtin(server, id).GetProperty("entrants").GetInt32());
        server.World.Store.SetGiveawayEntry(id, dice, true, 1); // even if one got in somehow, it can't win
        Assert.Equal([id], (await alice.RequestAsync("builtin.cards.mine", new { messageIds = new[] { id } })).Body()
            .GetProperty("entered").EnumerateArray().Select(e => e.GetInt64()));

        // Carol leaves: she can't win. At the end two winners, exactly Alice and Bob, announced with mentions.
        Assert.Equal("result", (await carol.RequestAsync("member.leave")).Type());
        Runtime(server).Tick(DateTimeOffset.UtcNow.AddHours(2));
        var g = server.World.Store.GetGiveaway(id)!;
        Assert.NotNull(g.EndedAt);
        Assert.Equal(new[] { alice.Key, bob.Key }.Order(StringComparer.Ordinal), g.WinnerKeys.Order(StringComparer.Ordinal));
        var won = Posts(server, server.General, bot).Last();
        Assert.Contains($"<@{alice.Key}>", won.Text);
        Assert.Contains($"<@{bob.Key}>", won.Text);
        Assert.Equal("giveaway.won", Builtin(server, won.Id).GetProperty("kind").GetString());
        Assert.Equal("ended", Builtin(server, id).GetProperty("status").GetString());
        Runtime(server).Tick(DateTimeOffset.UtcNow.AddHours(3)); // only once
        Assert.Equal(won.Id, Posts(server, server.General, bot).Last().Id);
        Assert.Equal("giveaway_ended", ErrorKey(await alice.RequestAsync("giveaway.enter", new { messageId = id, entered = false })));

        // Reroll: nobody drawn before can win again, so nobody's left.
        Assert.Equal("giveaways_staff", ErrorKey(await alice.RequestAsync("giveaway.reroll", new { messageId = id })));
        Assert.Equal("giveaway_no_one", ErrorKey(await admin.RequestAsync("giveaway.reroll", new { messageId = id })));
        var data = await ComplianceTests.Download(server, (await alice.RequestAsync("data.export")).Body());
        Assert.Single(data.GetProperty("giveawayEntries").EnumerateArray());
        Assert.Single(data.GetProperty("giveawaysWon").EnumerateArray());

        // Entries are forgotten a week after the end (no reroll after that).
        Assert.Equal(0, GiveawayBot.ForgetOld(server.World.Store, g.EndedAt!.Value + 60_000));
        Assert.True(GiveawayBot.ForgetOld(server.World.Store, g.EndedAt!.Value + 8L * 24 * 3_600_000) > 0);
        Assert.Equal(0, server.World.Store.CountGiveawayEntrants(id));
    }

    [Fact]
    public async Task Giveaways_can_need_a_role_be_cancelled_ended_early_and_rerolled_by_command()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bot = await TurnOn(admin, "giveaways");
        var gamers = await Role(admin, "Gamers", selfAssign: true);
        await Give(admin, alice, gamers);

        await Say(admin, server.General, $"/giveaway 1h <@&{gamers}> Game key");
        var id = (await BotMessage(bob, bot, "giveaway")).GetProperty("id").GetInt64();
        Assert.Equal(gamers, Builtin(server, id).GetProperty("roleId").GetInt64());
        var refused = await bob.RequestAsync("giveaway.enter", new { messageId = id, entered = true });
        Assert.Equal("giveaway_role", ErrorKey(refused));
        Assert.Equal("Gamers", refused.Body().GetProperty("args").GetProperty("role").GetString());
        Assert.Equal("result", (await alice.RequestAsync("giveaway.enter", new { messageId = id, entered = true })).Type());

        // Ended early by command: Alice wins. A reroll finds nobody else.
        await Say(admin, server.General, "/giveaway end");
        await BotMessage(bob, bot);
        Assert.Equal([alice.Key], server.World.Store.GetGiveaway(id)!.WinnerKeys);
        await Say(admin, server.General, "/giveaway reroll");
        Assert.Equal("giveaway_no_one", (await Private(admin)).GetProperty("error").GetProperty("key").GetString());

        // Bob gets the role and was in a second one; Alice already won the first, Bob wins the reroll of the second.
        await Say(admin, server.General, $"/giveaway 1h <@&{gamers}> Second key");
        var second = (await BotMessage(bob, bot, "giveaway")).GetProperty("id").GetInt64();
        await Give(admin, bob, gamers);
        await alice.RequestAsync("giveaway.enter", new { messageId = second, entered = true });
        await bob.RequestAsync("giveaway.enter", new { messageId = second, entered = true });
        Assert.Equal("giveaway_not_ended", ErrorKey(await admin.RequestAsync("giveaway.reroll", new { messageId = second })));
        Assert.Equal("result", (await admin.RequestAsync("giveaway.end", new { messageId = second })).Type());
        var first = server.World.Store.GetGiveaway(second)!.WinnerKeys.Single();
        Assert.Equal("result", (await admin.RequestAsync("giveaway.reroll", new { messageId = second })).Type());
        var rerolled = server.World.Store.GetGiveaway(second)!;
        Assert.NotEqual(first, rerolled.WinnerKeys.Single());
        Assert.Equal(2, rerolled.Drawn.Length);
        Assert.True(Builtin(server, Posts(server, server.General, bot).Last().Id).GetProperty("reroll").GetBoolean());

        // Cancelled: no draw, no announcement.
        await Say(admin, server.General, "/giveaway 10m Third");
        var third = (await BotMessage(bob, bot, "giveaway")).GetProperty("id").GetInt64();
        var posts = Posts(server, server.General, bot).Count;
        await Say(admin, server.General, "/giveaway cancel");
        while ((await bob.EventAsync("chat.edited")).Body().GetProperty("message").GetProperty("id").GetInt64() != third) { }
        Assert.True(server.World.Store.GetGiveaway(third)!.Cancelled);
        Assert.Equal("cancelled", Builtin(server, third).GetProperty("status").GetString());
        Runtime(server).Tick(DateTimeOffset.UtcNow.AddHours(1));
        Assert.Equal(posts, Posts(server, server.General, bot).Count);
        Assert.Contains(server.World.Store.Audit(null, null, null, 20).Select(e => e.Action), a => a == "giveaway.cancel");
    }

    [Fact]
    public async Task A_giveaway_due_while_the_server_was_off_ends_after_a_restart()
    {
        string world;
        long id;
        string alice;
        using (var server = new IskraServer { KeepWorld = true, Settings = { ["BuiltinBots:TickMs"] = "0" } })
        {
            using var admin = await server.JoinAsync("Admin", "admin");
            using var member = await server.JoinAsync("Alice");
            var bot = await TurnOn(admin, "giveaways");
            await Say(admin, server.General, "/giveaway 1m Restart prize");
            id = (await BotMessage(member, bot)).GetProperty("id").GetInt64();
            var entered = await member.RequestAsync("giveaway.enter", new { messageId = id, entered = true });
            Assert.True(entered.Type() == "result", entered.GetRawText());
            world = server.WorldPath;
            alice = member.Key;
        }
        using var again = new IskraServer { WorldPath = world, Settings = { ["BuiltinBots:TickMs"] = "0" } };
        Assert.Null(again.World.Store.GetGiveaway(id)!.EndedAt);
        Runtime(again).Tick(DateTimeOffset.UtcNow.AddMinutes(5));
        Assert.Equal([alice], again.World.Store.GetGiveaway(id)!.WinnerKeys);
    }

    // ── Counting ─────────────────────────────────────────────────────────────

    private static IEnumerable<string> ReactionsOf(IskraServer server, long id, string bot) =>
        server.World.Store.Reactions(id).Where(r => r.Accounts.Contains(bot)).Select(r => r.Emoji);

    [Fact]
    public async Task Counting_takes_the_next_number_once_per_person_and_starts_over_on_a_mistake()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bot = await TurnOn(admin, "counting");
        var channel = Channel(server, "counting");

        var one = await Say(alice, channel, "1");
        Assert.Equal(["✅"], ReactionsOf(server, one, bot));
        await Say(bob, channel, "2");
        await Say(alice, channel, "nice, keep going"); // chat doesn't count
        var three = await Say(alice, channel, "3");
        Assert.Equal(["✅"], ReactionsOf(server, three, bot));
        Assert.Equal(3, server.World.Store.GetCounting(channel).Current);
        Assert.Equal(3, server.World.Store.GetCounting(channel).Best);

        // Twice in a row: ❌, a short line, and it starts over (the best stays).
        var twice = await Say(alice, channel, "4");
        Assert.Equal(["❌"], ReactionsOf(server, twice, bot));
        var line = Posts(server, channel, bot).Last();
        var broken = Builtin(server, line.Id);
        Assert.Equal(("counting.broken", "double", 3L), (broken.GetProperty("kind").GetString(), broken.GetProperty("reason").GetString(), broken.GetProperty("count").GetInt64()));
        Assert.Equal((0L, 3L), (server.World.Store.GetCounting(channel).Current, server.World.Store.GetCounting(channel).Best));

        // A wrong number at 0 only gets ❌ and a private hint; wrong later starts over.
        var early = await Say(bob, channel, "5");
        Assert.Equal(["❌"], ReactionsOf(server, early, bot));
        Assert.Equal("counting.start", (await Private(bob)).GetProperty("kind").GetString());
        await Say(bob, channel, "1");
        await Say(alice, channel, "2");
        var wrong = await Say(bob, channel, "4");
        Assert.Equal(["❌"], ReactionsOf(server, wrong, bot));
        broken = Builtin(server, Posts(server, channel, bot).Last().Id);
        Assert.Equal(("wrong", 2L, 3L, 4L), (broken.GetProperty("reason").GetString(), broken.GetProperty("count").GetInt64(),
            broken.GetProperty("expected").GetInt64(), broken.GetProperty("said").GetInt64()));

        // Sums count only with math on.
        await Say(alice, channel, "0+1");
        Assert.Equal(0, server.World.Store.GetCounting(channel).Current);
        await Configure(admin, new { bot = "counting", math = true });
        var sum = await Say(alice, channel, "(3 - 2) * 1");
        Assert.Equal(["✅"], ReactionsOf(server, sum, bot));
        await Say(bob, channel, "4/2");
        await Say(alice, channel, "3");
        await Say(bob, channel, "8÷2");
        Assert.Equal(4, server.World.Store.GetCounting(channel).Current);

        // A new best shows on the card; no people are ranked anywhere.
        var card = server.World.Store.GetCounting(channel).CardId!.Value;
        Assert.Equal(4, Builtin(server, card).GetProperty("best").GetInt64());
        Assert.Contains("Best streak: 4", server.World.Store.GetMessage(card)!.Text);

        // Messages elsewhere, and bots, never count.
        await Say(alice, server.General, "5");
        Assert.Equal(4, server.World.Store.GetCounting(channel).Current);
    }

    [Fact]
    public async Task Editing_or_deleting_a_counted_number_doesnt_break_the_count()
    {
        using var server = Server();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bot = await TurnOn(admin, "counting");
        var channel = Channel(server, "counting");

        await Say(alice, channel, "1");
        var two = await Say(bob, channel, "2");
        Assert.Equal("result", (await bob.RequestAsync("chat.edit", new { id = two, text = "lol" })).Type());
        var changed = Builtin(server, Posts(server, channel, bot).Last().Id);
        Assert.Equal(("counting.changed", "edited", 3L), (changed.GetProperty("kind").GetString(), changed.GetProperty("how").GetString(), changed.GetProperty("next").GetInt64()));
        var posts = Posts(server, channel, bot).Count;
        await bob.RequestAsync("chat.edit", new { id = two, text = "lol again" }); // said once
        Assert.Equal(posts, Posts(server, channel, bot).Count);
        Assert.Equal(2, server.World.Store.GetCounting(channel).Current);

        // Bob still can't go twice; Alice goes on from 2.
        var three = await Say(alice, channel, "3");
        Assert.Equal(["✅"], ReactionsOf(server, three, bot));
        Assert.Equal("result", (await alice.RequestAsync("chat.delete", new { id = three })).Type());
        Assert.Equal("deleted", Builtin(server, Posts(server, channel, bot).Last().Id).GetProperty("how").GetString());
        Assert.Equal(3, server.World.Store.GetCounting(channel).Current);
        var again = await Say(alice, channel, "4"); // the deleted 3 was still Alice's: twice in a row
        Assert.Equal(["❌"], ReactionsOf(server, again, bot));

        // An edit that keeps the number says nothing; deleting an older number says nothing either.
        await Say(bob, channel, "1");
        var keep = await Say(alice, channel, "2");
        posts = Posts(server, channel, bot).Count;
        await alice.RequestAsync("chat.edit", new { id = keep, text = " 2 " });
        await admin.RequestAsync("chat.delete", new { id = two });
        Assert.Equal(posts, Posts(server, channel, bot).Count);
        Assert.Equal(2, server.World.Store.GetCounting(channel).Current);
    }

    [Theory]
    [InlineData("12", false, 12L)]
    [InlineData(" 7 ", false, 7L)]
    [InlineData("3+4", false, null)]
    [InlineData("3+4", true, 7L)]
    [InlineData("(1+2)*3", true, 9L)]
    [InlineData("7/2", true, null)]
    [InlineData("1/0", true, null)]
    [InlineData("2x3", true, 6L)]
    [InlineData("hello 5", true, null)]
    [InlineData("((1)", true, null)]
    [InlineData("-1", true, null)]
    public void Counting_reads_numbers_and_simple_sums(string text, bool math, long? value) => Assert.Equal(value, CountingBot.Value(text, math));
}
