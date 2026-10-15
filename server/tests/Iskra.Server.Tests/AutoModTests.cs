using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class AutoModTests
{
    // ── Matching ─────────────────────────────────────────────────────────────

    private static bool Blocks(string text, string[] blocked, string[]? allowed = null) =>
        new WordMatcher(blocked, allowed ?? []).Find(FoldedText.Of(text)).Count > 0;

    [Theory]
    [InlineData("that is BAD")]
    [InlineData("ｂａｄ news")]                 // fullwidth
    [InlineData("bád")]                          // accent
    [InlineData("b​ad")]                    // zero-width space
    [InlineData("bád")]               // combining accent
    [InlineData("𝐛𝐚𝐝")]                          // mathematical bold
    [InlineData("so b a d")]                     // spelled out
    [InlineData("b.a.d!")]
    public void Blocked_words_survive_trivial_evasions(string text) => Assert.True(Blocks(text, ["bad"]));

    [Theory]
    [InlineData("badge")]
    [InlineData("abad")]
    [InlineData("good")]
    public void Words_match_whole_words_only(string text) => Assert.False(Blocks(text, ["bad"]));

    [Fact]
    public void Wildcards_phrases_and_allowed_words()
    {
        Assert.True(Blocks("badness", ["bad*"]));
        Assert.True(Blocks("superbad", ["*bad"]));
        Assert.False(Blocks("superbad", ["bad*"]));
        Assert.True(Blocks("you are so very rude", ["very rude"]));
        Assert.False(Blocks("very, very kind and rude", ["very rude"]));
        Assert.True(Blocks("Very   RUDE", ["very rude"]));
        Assert.True(Blocks("a big ugly cat", ["big * cat"]));
        Assert.False(Blocks("assassin", ["ass*"], ["assassin"]));
        Assert.True(Blocks("assassin ass", ["ass*"], ["assassin"]));
        Assert.False(Blocks("Scunthorpe", ["*cunt*"], ["scunthorpe"]));
        Assert.True(WordMatcher.Glob("a*b*c", "axxbyyc"));
        Assert.False(WordMatcher.Glob("a*b*c", "axxbyy"));
    }

    [Fact]
    public void Full_lists_check_long_messages_quickly()
    {
        var blocked = Enumerable.Range(0, AutoModFeature.MaxBlocked).Select(i => i % 3 == 0 ? $"w{i}x*" : i % 3 == 1 ? $"*q{i}" : $"word{i} next").ToArray();
        var matcher = new WordMatcher(blocked, ["w3xok"]);
        var text = FoldedText.Of(string.Join(' ', Enumerable.Range(0, 1300).Select(i => $"a{i % 7}")) + " w3xok");
        // Measured in work (characters compared), not milliseconds: a stopwatch failed on busy machines (CI, parallel
        // test runs) while the matcher was fine. Each word costs a few steps per pattern that could match it (its
        // first letter's bucket and the leading-* bucket), never a pass over the whole list or the whole text.
        Assert.Empty(matcher.Find(text, out var work));
        var words = text.Words.Count;
        var leadingStar = blocked.Count(b => b.StartsWith('*'));
        Assert.True(work <= words * (leadingStar + 1) * 5L, $"{work} steps for {words} words");
        // A naive matcher (every pattern against every word) does well over this.
        Assert.True(work < words * AutoModFeature.MaxBlocked * 2L, $"{work} steps for {words} words");
        Assert.NotEmpty(matcher.Find(FoldedText.Of("ab W3Xyz")));
    }

    [Fact]
    public void Masked_snippets_hide_the_matched_words()
    {
        var text = FoldedText.Of("well BÁD thing, bad");
        var hits = new WordMatcher(["bad"], []).Find(text);
        Assert.Equal("well B••• thing, b•••", WordMatcher.Masked(text, hits, 120));
        var spelled = FoldedText.Of("so b a d");
        Assert.Equal("so b•••", WordMatcher.Masked(spelled, new WordMatcher(["bad"], []).Find(spelled), 120));
    }

    [Fact]
    public void Links_mentions_and_invites()
    {
        Assert.True(AutoModRules.HasBlockedLink("join discord.gg/abc", invitesOnly: true, []));
        Assert.True(AutoModRules.HasBlockedLink("https://app.iskra.foo/#/join/xyz", invitesOnly: true, []));
        Assert.False(AutoModRules.HasBlockedLink("see https://example.com/page", invitesOnly: true, []));
        Assert.True(AutoModRules.HasBlockedLink("see https://example.com/page", invitesOnly: false, []));
        Assert.False(AutoModRules.HasBlockedLink("see https://www.youtube.com/watch?v=1", invitesOnly: false, ["youtube.com"]));
        Assert.True(AutoModRules.HasBlockedLink("see https://youtube.com.evil.net/", invitesOnly: false, ["youtube.com"]));
        Assert.True(AutoModRules.HasBlockedLink("https://youtube.com@evil.net/", invitesOnly: false, ["evil.org"]));
        Assert.True(AutoModRules.HasBlockedLink(FoldedText.Of("ｈｔｔｐｓ://evil.net").Text, invitesOnly: false, []));
        Assert.False(AutoModRules.HasBlockedLink("no links here.", invitesOnly: false, []));

        var key = new string('A', 43);
        var other = new string('B', 43);
        Assert.Equal(4, AutoModRules.Mentions($"<@{key}> <@{key}> <@{other}> <@&3> @everyone"));
        Assert.Equal(0, AutoModRules.Mentions("mail me at a@everyone.com"));
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    private static object Config(object? words = null, object? mentions = null, object? flood = null, object? duplicates = null, object? links = null,
        long[]? exemptRoles = null, long[]? exemptChannels = null, long? alertChannelId = null, bool enabled = true) => new
    {
        automod = new
        {
            enabled,
            words = words ?? new { enabled = false },
            mentions = mentions ?? new { enabled = false },
            flood = flood ?? new { enabled = false },
            duplicates = duplicates ?? new { enabled = false },
            links = links ?? new { enabled = false },
            exemptRoles = exemptRoles ?? [],
            exemptChannels = exemptChannels ?? [],
            alertChannelId,
        },
    };

    private static async Task<long> Channel(User admin, string name, string readRole = "member")
    {
        var reply = await admin.RequestAsync("channel.create", new { name, readRole, writeRole = readRole });
        return reply.Body().GetProperty("channel").GetProperty("id").GetInt64();
    }

    [Fact]
    public async Task Only_admins_and_roles_that_manage_automod_see_and_change_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        using var mod = await server.JoinAsync("Mod");

        var settings = (await admin.RequestAsync("automod.get")).Body().GetProperty("automod");
        Assert.False(settings.GetProperty("enabled").GetBoolean()); // off until enabled
        Assert.False(settings.GetProperty("words").GetProperty("enabled").GetBoolean());

        Assert.Equal("forbidden", (await member.RequestAsync("automod.get")).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("automod.update", Config())).ErrorCode());

        var role = (await admin.RequestAsync("role.create", new { name = "AutoModders", permissions = new[] { "manageAutoMod" } }))
            .Body().GetProperty("role").GetProperty("id").GetInt64();
        await admin.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { role } });
        Assert.Equal("result", (await mod.RequestAsync("automod.update", Config(words: new { enabled = true, blocked = new[] { "bad" } }))).Type());
        // Timing people out needs the right to do it yourself.
        Assert.Equal("forbidden", (await mod.RequestAsync("automod.update",
            Config(words: new { enabled = true, blocked = new[] { "bad" }, action = new { timeoutMs = 60_000 } }))).ErrorCode());

        var updated = (await admin.RequestAsync("automod.get")).Body().GetProperty("automod");
        Assert.Equal("bad", updated.GetProperty("words").GetProperty("blocked")[0].GetString());

        var audit = (await admin.RequestAsync("audit.list", new { action = "automod.update" })).Body().GetProperty("entries");
        Assert.Equal(mod.Key, audit[0].GetProperty("actor").GetString());
    }

    [Fact]
    public async Task Settings_are_validated_and_bounded()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var voice = (await admin.RequestAsync("channel.create", new { name = "talk", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();

        async Task Bad(object body) => Assert.Equal("bad_request", (await admin.RequestAsync("automod.update", body)).ErrorCode());
        await Bad(Config(words: new { enabled = true, blocked = Enumerable.Range(0, AutoModFeature.MaxBlocked + 1).Select(i => $"w{i}").ToArray() }));
        await Bad(Config(words: new { enabled = true, blocked = new[] { new string('x', AutoModFeature.MaxWordLength + 1) } }));
        await Bad(Config(words: new { enabled = true, blocked = new[] { "***" } }));
        await Bad(Config(words: new { enabled = true, blocked = new[] { "a*b*c*d*e*f" } }));
        await Bad(Config(mentions: new { enabled = true, max = 0 }));
        await Bad(Config(flood: new { enabled = true, count = 1, seconds = 10 }));
        await Bad(Config(duplicates: new { enabled = true, count = 2, seconds = 99999 }));
        await Bad(Config(links: new { enabled = true, mode = "some" }));
        await Bad(Config(links: new { enabled = true, mode = "all", allowedDomains = new[] { "not a domain" } }));
        await Bad(Config(words: new { enabled = true, action = new { timeoutMs = 1234 } }));
        await Bad(Config(exemptRoles: [999]));
        await Bad(Config(exemptChannels: [999]));
        await Bad(Config(alertChannelId: voice));
        await Bad(new { automod = "x" });

        // Blank lines go, duplicates (as AutoMod reads them) merge, domains are tidied.
        var saved = (await admin.RequestAsync("automod.update", Config(
            words: new { enabled = true, blocked = new[] { "Bad", " ", "BÁD", "bad*" } },
            links: new { enabled = true, mode = "all", allowedDomains = new[] { "https://www.YouTube.com/", "*.example.org" } }))).Body().GetProperty("automod");
        Assert.Equal(["Bad", "bad*"], saved.GetProperty("words").GetProperty("blocked").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal(["youtube.com", "example.org"], saved.GetProperty("links").GetProperty("allowedDomains").EnumerateArray().Select(x => x.GetString()));
    }

    // ── Enforcement ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Blocked_messages_are_never_stored_or_sent_and_the_sender_learns_why()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        // Off by default: nothing is checked.
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "bad" })).Type());
        await bob.EventAsync("chat.message");

        await admin.RequestAsync("automod.update", Config(words: new { enabled = true, blocked = new[] { "bad" } }));
        var refused = await alice.RequestAsync("chat.send", new { channelId = server.General, text = "this is ＢＡＤ", nonce = "nonce-0001" });
        Assert.Equal("automod", refused.ErrorCode());
        Assert.Contains("word that isn't allowed", refused.Body().GetProperty("message").GetString());
        await bob.NoEventAsync("chat.message");
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(1, history.GetArrayLength());

        // Admins are exempt; turning the whole thing off stops it too.
        Assert.Equal("result", (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "bad" })).Type());
        await admin.RequestAsync("automod.update", Config(words: new { enabled = true, blocked = new[] { "bad" } }, enabled: false));
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "bad" })).Type());
    }

    [Fact]
    public async Task Edits_polls_threads_forum_posts_forwards_and_events_are_checked()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var forum = (await admin.RequestAsync("channel.create", new { name = "help", kind = "forum" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var adminPost = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "bad idea" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        await admin.RequestAsync("automod.update", Config(words: new { enabled = true, blocked = new[] { "bad" } }));

        var sent = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "fine" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("automod", (await alice.RequestAsync("chat.edit", new { id = sent, text = "bad" })).ErrorCode());
        Assert.Equal("automod", (await alice.RequestAsync("poll.create", new { channelId = server.General, question = "Q?", options = new[] { "good", "bad" } })).ErrorCode());
        Assert.Equal("automod", (await alice.RequestAsync("thread.create", new { messageId = sent, name = "bad thread" })).ErrorCode());
        Assert.Equal("automod", (await alice.RequestAsync("forum.post.create", new { channelId = forum, title = "Help", text = "so bad" })).ErrorCode());
        Assert.Equal("automod", (await alice.RequestAsync("chat.forward", new { id = adminPost, channelId = server.General })).ErrorCode());
        var start = DateTimeOffset.UtcNow.AddDays(1).ToUnixTimeMilliseconds();
        Assert.Equal("automod", (await alice.RequestAsync("event.create", new
        {
            title = "Bad night", startAt = start, endAt = start + 3_600_000, timeZone = "UTC", location = new { text = "Here" },
        })).ErrorCode());
        Assert.Equal("fine", server.World.Store.GetMessage(sent)!.Text);
    }

    [Fact]
    public async Task Exempt_roles_and_channels_skip_the_rules()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var offTopic = await Channel(admin, "off-topic");
        var role = (await admin.RequestAsync("role.create", new { name = "Regulars" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await admin.RequestAsync("member.roles.set", new { accountKey = bob.Key, roles = new[] { role } });
        await admin.RequestAsync("automod.update", Config(words: new { enabled = true, blocked = new[] { "bad" } }, exemptRoles: [role], exemptChannels: [offTopic]));

        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "bad" })).Type());
        var root = (await alice.RequestAsync("chat.send", new { channelId = offTopic, text = "bad" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        // Threads follow their channel.
        var thread = (await alice.RequestAsync("thread.create", new { messageId = root, name = "bad" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = thread, text = "bad" })).Type());
        Assert.Equal("automod", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "bad" })).ErrorCode());
    }

    [Fact]
    public async Task A_block_can_time_out_alert_and_audit()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var mods = await Channel(admin, "mods", "admin");
        await admin.RequestAsync("automod.update", Config(
            words: new { enabled = true, blocked = new[] { "slur" }, action = new { timeoutMs = 300_000, alert = true } }, alertChannelId: mods));

        var refused = await alice.RequestAsync("chat.send", new { channelId = server.General, text = "you SLUR, really" });
        Assert.Equal("automod", refused.ErrorCode());
        Assert.Contains("timed out for 5 minutes", refused.Body().GetProperty("message").GetString());
        Assert.NotNull(server.World.Store.TimedOutUntil(alice.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        while (true)
        {
            var updated = (await admin.EventAsync("member.updated")).Body().GetProperty("member");
            if (updated.GetProperty("accountKey").GetString() == alice.Key && updated.GetProperty("timedOutUntil").ValueKind == JsonValueKind.Number) break;
        }

        // The alert names the rule and person, and masks the word.
        var alert = (await admin.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal(mods, alert.GetProperty("channelId").GetInt64());
        Assert.Equal(AutoModFeature.Author, alert.GetProperty("author").GetString());
        var details = alert.GetProperty("automod");
        Assert.Equal("words", details.GetProperty("rule").GetString());
        Assert.Equal(alice.Key, details.GetProperty("member").GetString());
        Assert.Equal("you S•••, really", details.GetProperty("snippet").GetString());
        Assert.Equal(300_000, details.GetProperty("timeoutMs").GetInt64());
        Assert.DoesNotContain("SLUR", alert.GetRawText());
        Assert.Equal("", alert.GetProperty("text").GetString());

        // Nobody can edit the alert; admins can delete it.
        Assert.Equal("forbidden", (await alice.RequestAsync("chat.edit", new { id = alert.GetProperty("id").GetInt64(), text = "x" })).ErrorCode());
        var audit = (await admin.RequestAsync("audit.list", new { action = "automod.block" })).Body().GetProperty("entries");
        Assert.Equal("AutoMod", audit[0].GetProperty("actorName").GetString());
        Assert.Equal(alice.Key, audit[0].GetProperty("target").GetString());
        Assert.DoesNotContain("slur", audit[0].GetRawText(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal("result", (await admin.RequestAsync("chat.delete", new { id = alert.GetProperty("id").GetInt64() })).Type());
    }

    [Fact]
    public async Task Alerts_keep_private_channels_private()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        var secret = await Channel(owner, "secret", "trusted");
        await owner.RequestAsync("automod.update", Config(words: new { enabled = true, blocked = new[] { "bad" }, action = new { alert = true } }, alertChannelId: server.General));

        Assert.Equal("automod", (await trusted.RequestAsync("chat.send", new { channelId = secret, text = "bad stuff" })).ErrorCode());
        var details = (await owner.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("automod");
        Assert.Equal(JsonValueKind.Null, details.GetProperty("channelId").ValueKind);
        Assert.Equal(JsonValueKind.Null, details.GetProperty("snippet").ValueKind);
    }

    [Fact]
    public async Task Mention_spam_flood_repeats_and_links()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await admin.RequestAsync("automod.update", Config(
            mentions: new { enabled = true, max = 2 },
            duplicates: new { enabled = true, count = 2, seconds = 60 },
            links: new { enabled = true, mode = "invites" }));

        Task<JsonElement> Send(string text) => alice.RequestAsync("chat.send", new { channelId = server.General, text });
        Assert.Equal("result", (await Send($"<@{bob.Key}> <@{carol.Key}>")).Type());
        Assert.Equal("automod", (await Send($"<@{bob.Key}> <@{carol.Key}> <@{admin.Key}>")).ErrorCode());
        Assert.Equal("automod", (await Send("come over: discord.gg/abcdef")).ErrorCode());
        Assert.Equal("result", (await Send("https://example.com is fine")).Type());

        Assert.Equal("result", (await Send("buy now")).Type());
        Assert.Equal("result", (await Send("Buy   NOW")).Type());
        var third = await Send("buy now");
        Assert.Equal("automod", third.ErrorCode());
        Assert.Contains("same message", third.Body().GetProperty("message").GetString());

        await admin.RequestAsync("automod.update", Config(flood: new { enabled = true, count = 3, seconds = 30 }));
        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "1" })).Type());
        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "2" })).Type());
        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "3" })).Type());
        Assert.Equal("automod", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "4" })).ErrorCode());
        // Edits don't count as new messages.
        var mine = (await carol.RequestAsync("chat.send", new { channelId = server.General, text = "x" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        for (var i = 0; i < 4; i++) Assert.Equal("result", (await carol.RequestAsync("chat.edit", new { id = mine, text = $"x{i}" })).Type());
    }
}
