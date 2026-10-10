using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Categories and channel order, nicknames, and notification settings.</summary>
public class OrganizeTests
{
    private static long Id(JsonElement reply, string field) => reply.Body().GetProperty(field).GetProperty("id").GetInt64();

    private static List<long> Ids(JsonElement list) => list.EnumerateArray().Select(c => c.GetProperty("id").GetInt64()).ToList();

    private static long? CategoryOf(JsonElement channels, long id) =>
        channels.EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == id).GetProperty("categoryId") is { ValueKind: JsonValueKind.Number } v
            ? v.GetInt64() : null;

    /// <summary>Channel ids in display order (by position).</summary>
    private static List<long> Order(JsonElement channels) =>
        channels.EnumerateArray().OrderBy(c => c.GetProperty("position").GetInt32()).Select(c => c.GetProperty("id").GetInt64()).ToList();

    // ── Categories ───────────────────────────────────────────────────────────

    [Fact]
    public async Task Admins_create_rename_reorder_and_delete_categories()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        Assert.Equal(0, admin.Welcome.Body().GetProperty("categories").GetArrayLength());

        Assert.Equal("forbidden", (await member.RequestAsync("category.create", new { name = "Games" })).ErrorCode());
        var games = Id(await admin.RequestAsync("category.create", new { name = "  Games " }), "category");
        var events = await admin.EventAsync("channels");
        Assert.Equal("Games", events.Body().GetProperty("categories")[0].GetProperty("name").GetString());
        var talk = Id(await admin.RequestAsync("category.create", new { name = "Just talking" }), "category");

        Assert.Equal("bad_request", (await admin.RequestAsync("category.create", new { name = "" })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("category.create", new { name = new string('x', 33) })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("category.create", new { name = "bad‮name" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("category.update", new { id = games, name = "Mine" })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("category.update", new { id = 999, name = "Nope" })).ErrorCode());

        Assert.Equal("Board games", (await admin.RequestAsync("category.update", new { id = games, name = "Board games" }))
            .Body().GetProperty("category").GetProperty("name").GetString());
        Assert.Equal("result", (await admin.RequestAsync("category.move", new { id = talk, before = games })).Type());
        Assert.Equal("bad_request", (await admin.RequestAsync("category.move", new { id = talk, before = talk })).ErrorCode());
        Assert.Equal([talk, games], server.World.Store.AllCategories().Select(c => c.Id).ToList());
        Assert.Equal("result", (await admin.RequestAsync("category.move", new { id = talk })).Type()); // to the end
        Assert.Equal([games, talk], server.World.Store.AllCategories().Select(c => c.Id).ToList());

        // Deleting a category keeps its channels, uncategorized.
        await admin.RequestAsync("channel.move", new { id = server.General, categoryId = games });
        Assert.Equal("forbidden", (await member.RequestAsync("category.delete", new { id = games })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("category.delete", new { id = games })).Type());
        Assert.Null(server.World.Store.GetChannel(server.General)!.CategoryId);
        Assert.Equal([talk], server.World.Store.AllCategories().Select(c => c.Id).ToList());
    }

    [Fact]
    public async Task Categories_of_private_channels_stay_hidden()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        var secret = Id(await admin.RequestAsync("category.create", new { name = "Staff room" }), "category");
        var open = Id(await admin.RequestAsync("category.create", new { name = "Hangout" }), "category");
        await admin.RequestAsync("channel.move", new { id = staff, categoryId = secret });
        await admin.RequestAsync("channel.move", new { id = server.General, categoryId = open });

        // The member's latest view: only the category with a channel they can read, renumbered from 0.
        JsonElement view;
        do view = (await member.EventAsync("channels")).Body();
        while (CategoryOf(view.GetProperty("channels"), server.General) != open);
        var categories = view.GetProperty("categories");
        Assert.Equal([open], Ids(categories));
        Assert.Equal(0, categories[0].GetProperty("position").GetInt32());
        Assert.DoesNotContain("Staff room", view.GetRawText());

        // Admins see every category, empty ones too.
        var empty = Id(await admin.RequestAsync("category.create", new { name = "Empty" }), "category");
        using var again = await server.JoinAsync("Late admin", "admin");
        Assert.Equal([secret, open, empty], Ids(again.Welcome.Body().GetProperty("categories")));
        using var late = await server.JoinAsync("Late member");
        Assert.Equal([open], Ids(late.Welcome.Body().GetProperty("categories")));

        // Moving into or touching a channel you can't see is not_found, never forbidden.
        Assert.Equal("not_found", (await admin.RequestAsync("channel.move", new { id = 999, categoryId = open })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("channel.move", new { id = server.General })).ErrorCode());
    }

    [Fact]
    public async Task Channels_move_between_categories_and_reorder()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        var general = server.General;
        var memes = Id(await admin.RequestAsync("channel.create", new { name = "memes" }), "channel");
        var lounge = Id(await admin.RequestAsync("channel.create", new { name = "lounge", kind = "voice" }), "channel");
        var games = Id(await admin.RequestAsync("category.create", new { name = "Games" }), "category");

        // Created straight into a category: last in it.
        var created = await admin.RequestAsync("channel.create", new { name = "minecraft", categoryId = games });
        Assert.Equal(games, created.Body().GetProperty("channel").GetProperty("categoryId").GetInt64());
        var minecraft = Id(created, "channel");
        Assert.Equal("not_found", (await admin.RequestAsync("channel.create", new { name = "x", categoryId = 999 })).ErrorCode());

        await admin.RequestAsync("channel.move", new { id = lounge, categoryId = games, before = minecraft });
        await admin.RequestAsync("channel.move", new { id = memes, categoryId = games }); // end of the category
        var channels = server.World.Store.AllChannels();
        Assert.Equal([general, lounge, minecraft, memes], channels.Select(c => c.Id).ToList());
        Assert.Equal([0, 1, 2, 3], channels.Select(c => c.Position).ToList());

        // Back to the top, before #general.
        await admin.RequestAsync("channel.move", new { id = memes, before = general });
        Assert.Equal([memes, general, lounge, minecraft], server.World.Store.AllChannels().Select(c => c.Id).ToList());
        Assert.Null(server.World.Store.GetChannel(memes)!.CategoryId);

        // 'before' must sit in the destination category and be another visible channel.
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.move", new { id = memes, categoryId = games, before = general })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.move", new { id = memes, before = memes })).ErrorCode());
        var ownerOnly = server.World.Store.CreateChannel("vault", "text", "owner", "owner", 0).Id;
        Assert.Equal("not_found", (await admin.RequestAsync("channel.move", new { id = ownerOnly })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("channel.move", new { id = memes, before = ownerOnly })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("channel.move", new { id = memes, categoryId = 999 })).ErrorCode());

        // A channel admins can't see keeps its place among the others.
        await owner.RequestAsync("channel.move", new { id = ownerOnly, categoryId = games, before = minecraft });
        await admin.RequestAsync("channel.move", new { id = memes, categoryId = games, before = lounge });
        Assert.Equal([general, memes, lounge, ownerOnly, minecraft], server.World.Store.AllChannels().Select(c => c.Id).ToList());

        // Threads aren't channels you can arrange.
        var root = server.World.Store.AddMessage(general, admin.Key, "root", 1).Id;
        var thread = (await admin.RequestAsync("thread.create", new { messageId = root, name = "side" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await admin.RequestAsync("channel.move", new { id = thread, categoryId = games })).ErrorCode());

        // Everyone gets the new layout.
        var view = (await admin.EventAsync("channels")).Body();
        Assert.True(view.TryGetProperty("categories", out _));
    }

    // ── Nicknames ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Members_set_and_reset_their_own_nickname()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob", "guest");

        var reply = (await bob.RequestAsync("member.nick", new { nick = "  Bobby " })).Body().GetProperty("member");
        Assert.Equal("Bobby", reply.GetProperty("name").GetString());
        Assert.Equal("Bobby", reply.GetProperty("nick").GetString());
        Assert.Equal("Bob", reply.GetProperty("profileName").GetString());
        JsonElement seen;
        do seen = (await alice.EventAsync("member.updated")).Body().GetProperty("member");
        while (seen.GetProperty("accountKey").GetString() != bob.Key || seen.GetProperty("nick").ValueKind == JsonValueKind.Null);
        Assert.Equal("Bobby", seen.GetProperty("name").GetString());

        Assert.Equal("bad_request", (await bob.RequestAsync("member.nick", new { nick = new string('b', 33) })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("member.nick", new { nick = "evil​name" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("member.nick", new { })).ErrorCode());

        // Changing your profile name doesn't touch the nickname.
        await bob.RequestAsync("profile.update", new { name = "Robert" });
        var member = server.World.Store.GetMember(bob.Key)!;
        Assert.Equal("Bobby", server.World.Store.DisplayName(member));

        var reset = (await bob.RequestAsync("member.nick", new { nick = "" })).Body().GetProperty("member");
        Assert.Equal("Robert", reset.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, reset.GetProperty("nick").ValueKind);
    }

    [Fact]
    public async Task Admins_change_nicknames_of_members_ranked_below_them()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var other = await server.JoinAsync("Other admin", "admin");
        using var member = await server.JoinAsync("Member");
        using var trusted = await server.JoinAsync("Trusted", "trusted");

        Assert.Equal("forbidden", (await trusted.RequestAsync("member.nick", new { accountKey = member.Key, nick = "lol" })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("member.nick", new { accountKey = other.Key, nick = "lol" })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("member.nick", new { accountKey = owner.Key, nick = "lol" })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("member.nick", new { accountKey = "nobody", nick = "lol" })).ErrorCode());

        Assert.Equal("result", (await admin.RequestAsync("member.nick", new { accountKey = member.Key, nick = "Mr Member" })).Type());
        Assert.Equal("Mr Member", server.World.Store.GetNickname(member.Key));
        Assert.Equal("result", (await owner.RequestAsync("member.nick", new { accountKey = admin.Key, nick = "Boss" })).Type());
        Assert.Equal("result", (await owner.RequestAsync("member.nick", new { accountKey = member.Key, nick = "" })).Type());
        Assert.Null(server.World.Store.GetNickname(member.Key));

        // A nickname goes away with the membership.
        await admin.RequestAsync("member.nick", new { accountKey = member.Key, nick = "Temp" });
        Assert.Equal("result", (await admin.RequestAsync("member.kick", new { accountKey = member.Key })).Type());
        Assert.Null(server.World.Store.GetNickname(member.Key));
    }

    [Fact]
    public async Task Nicknames_show_in_the_welcome_and_in_pushes()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await alice.RequestAsync("member.nick", new { nick = "Ali" });
        await bob.RequestAsync("member.nick", new { nick = "B-man" });
        var endpoint = await SubscribeAsync(bob);

        using var carol = await server.JoinAsync("Carol");
        var members = carol.Welcome.Body().GetProperty("members").EnumerateArray().ToList();
        var ali = members.Single(m => m.GetProperty("accountKey").GetString() == alice.Key);
        Assert.Equal("Ali", ali.GetProperty("name").GetString());
        Assert.Equal("Alice", ali.GetProperty("profileName").GetString());

        await alice.RequestAsync("chat.send", new { channelId = server.General, text = $"hi <@{bob.Key}>" });
        var push = (await server.Push.WaitForAsync(endpoint)).Single();
        Assert.Equal("Ali in #general", push.GetProperty("title").GetString());
        Assert.Equal("hi @B-man", push.GetProperty("body").GetString());
    }

    // ── Notification settings ────────────────────────────────────────────────

    private static object Subscription(string endpoint)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        return new
        {
            endpoint,
            keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
        };
    }

    private static async Task<string> SubscribeAsync(User user)
    {
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        Assert.Equal("result", (await user.RequestAsync("push.subscribe", Subscription(endpoint))).Type());
        return endpoint;
    }

    private static Task<JsonElement> Say(User user, long channelId, string text) => user.RequestAsync("chat.send", new { channelId, text });

    [Fact]
    public async Task Settings_are_validated_saved_and_sent_to_every_session()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var second = await server.ConnectAsync();
        await second.LoginAsync(alice.Identity, "Alice");
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;

        Assert.Equal("bad_request", (await alice.RequestAsync("notify.set", new { level = "loud" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("notify.set", new { muteMinutes = -2 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("notify.set", new { muteMinutes = 30 * 24 * 60 + 1 })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("notify.set", new { channelId = staff, level = "all" })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("notify.set", new { channelId = 999, level = "all" })).ErrorCode());

        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var setting = (await alice.RequestAsync("notify.set", new { channelId = server.General, level = "all", muteMinutes = 15 })).Body().GetProperty("setting");
        Assert.Equal(server.General, setting.GetProperty("channelId").GetInt64());
        Assert.Equal("all", setting.GetProperty("level").GetString());
        var until = setting.GetProperty("mutedUntil").GetInt64();
        Assert.InRange(until, before + 15 * 60_000 - 1000, before + 15 * 60_000 + 5000);
        var echoed = (await second.EventAsync("notify.updated")).Body().GetProperty("setting");
        Assert.Equal(until, echoed.GetProperty("mutedUntil").GetInt64());

        var server_ = (await alice.RequestAsync("notify.set", new { level = "none", muteMinutes = -1 })).Body().GetProperty("setting");
        Assert.Equal(JsonValueKind.Null, server_.GetProperty("channelId").ValueKind);
        Assert.Equal(-1, server_.GetProperty("mutedUntil").GetInt64());

        // They come back in the welcome, on any device.
        using var third = await server.ConnectAsync();
        var welcome = await third.LoginAsync(alice.Identity, "Alice");
        Assert.Equal(2, welcome.Body().GetProperty("notify").GetArrayLength());

        // Unmuting and going back to the default leaves nothing stored.
        await alice.RequestAsync("notify.set", new { level = "default", muteMinutes = 0 });
        await alice.RequestAsync("notify.set", new { channelId = server.General, level = "default", muteMinutes = 0 });
        Assert.Empty(server.World.Store.NotifySettings(alice.Key));
        second.Dispose();
    }

    [Fact]
    public async Task Expired_mutes_read_as_unmuted()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        server.World.Store.SaveNotifySetting(alice.Key, new Storage.NotifySetting(server.General, null, 1000));
        server.World.Store.SaveNotifySetting(alice.Key, new Storage.NotifySetting(0, "all", 1000));
        using var again = await server.ConnectAsync();
        var notify = (await again.LoginAsync(alice.Identity, "Alice")).Body().GetProperty("notify");
        Assert.Equal(1, notify.GetArrayLength()); // the empty, expired channel mute is left out
        Assert.Equal(JsonValueKind.Null, notify[0].GetProperty("mutedUntil").ValueKind);
        Assert.Equal("all", Features.NotifyFeature.EffectiveLevel(server.World.Store.NotifySettings(alice.Key), server.General, 5000));
    }

    [Fact]
    public void Effective_level_combines_channel_server_and_mute()
    {
        Storage.NotifySetting S(long channel, string? level, long? until = null) => new(channel, level, until);
        static string Level(long channel, params Storage.NotifySetting[] settings) => Features.NotifyFeature.EffectiveLevel(settings, channel, 10_000);

        Assert.Equal("mentions", Level(1));
        Assert.Equal("all", Level(1, S(0, "all")));
        Assert.Equal("none", Level(1, S(0, "all"), S(1, "none")));
        Assert.Equal("all", Level(1, S(0, "none"), S(1, "all")));
        Assert.Equal("mentions", Level(1, S(1, "all", 20_000)));      // muted: down to mentions
        Assert.Equal("mentions", Level(1, S(0, null, -1), S(1, "all"))); // server muted for good
        Assert.Equal("all", Level(1, S(1, "all", 5_000)));             // mute over
        Assert.Equal("none", Level(1, S(1, "none", -1)));
        Assert.Equal("all", Level(2, S(0, "all"), S(1, "none")));
    }

    [Fact]
    public async Task Pushes_follow_each_persons_levels()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var bobEndpoint = await SubscribeAsync(bob);
        var carolEndpoint = await SubscribeAsync(carol);
        var games = server.World.Store.CreateChannel("games", "text", "member", "member", 0).Id;
        var news = server.World.Store.CreateChannel("news", "text", "member", "member", 0).Id;

        // Bob wants everything in #games; Carol wants nothing from this server.
        await bob.RequestAsync("notify.set", new { channelId = games, level = "all" });
        await carol.RequestAsync("notify.set", new { level = "none" });
        await Say(alice, games, $"anyone? <@{carol.Key}>");
        var push = (await server.Push.WaitForAsync(bobEndpoint)).Single();
        Assert.Equal("message", push.GetProperty("kind").GetString());
        Assert.Equal("Alice in #games", push.GetProperty("title").GetString());
        await server.Push.NoneAsync(carolEndpoint);

        // Plain messages elsewhere still don't push by default.
        await Say(alice, news, "patch notes");
        await server.Push.NoneAsync(bobEndpoint, already: 1);

        // Muting #games: plain messages stop, mentions still come through.
        await bob.RequestAsync("notify.set", new { channelId = games, muteMinutes = 60 });
        await Task.Delay(700); // past the merge window
        await Say(alice, games, "quiet now");
        await server.Push.NoneAsync(bobEndpoint, already: 1);
        await Task.Delay(700);
        await Say(alice, games, $"<@{bob.Key}> you there?");
        Assert.Equal("mention", (await server.Push.WaitForAsync(bobEndpoint, 2))[1].GetProperty("kind").GetString());

        // Nothing means nothing, mentions included; a channel choice overrides the server's.
        await bob.RequestAsync("notify.set", new { channelId = news, level = "none" });
        await Say(alice, news, $"<@{bob.Key}> read this");
        await server.Push.NoneAsync(bobEndpoint, already: 2);
        await carol.RequestAsync("notify.set", new { channelId = news, level = "mentions" });
        await Say(alice, news, $"<@{carol.Key}> and you");
        Assert.Equal("mention", (await server.Push.WaitForAsync(carolEndpoint)).Single().GetProperty("kind").GetString());
    }

    [Fact]
    public async Task Threads_follow_their_channels_settings()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = await SubscribeAsync(bob);
        var root = (await Say(alice, server.General, "plans")).Body().GetProperty("message").GetProperty("id").GetInt64();
        var thread = (await alice.RequestAsync("thread.create", new { messageId = root, name = "plans" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await bob.RequestAsync("notify.set", new { channelId = thread, level = "all" })).ErrorCode());

        await bob.RequestAsync("notify.set", new { channelId = server.General, level = "none" });
        await Say(alice, thread, $"<@{bob.Key}> in the thread");
        await server.Push.NoneAsync(endpoint);
        await bob.RequestAsync("notify.set", new { channelId = server.General, level = "all" });
        await Say(alice, thread, "anything");
        Assert.Equal("message", (await server.Push.WaitForAsync(endpoint)).Single().GetProperty("kind").GetString());
    }

    [Fact]
    public async Task Settings_leave_with_the_member_and_the_channel()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var games = Id(await admin.RequestAsync("channel.create", new { name = "games" }), "channel");
        await bob.RequestAsync("notify.set", new { channelId = games, level = "all" });
        await bob.RequestAsync("notify.set", new { level = "none" });
        Assert.Equal(2, server.World.Store.NotifySettings(bob.Key).Count);

        await admin.RequestAsync("channel.delete", new { id = games });
        Assert.Single(server.World.Store.NotifySettings(bob.Key));
        await admin.RequestAsync("member.kick", new { accountKey = bob.Key });
        Assert.Empty(server.World.Store.NotifySettings(bob.Key));
    }
}
