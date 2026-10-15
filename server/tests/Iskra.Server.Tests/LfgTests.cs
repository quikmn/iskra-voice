using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Looking for group: posts, slots, notifications, expiry and limits.</summary>
public class LfgTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string? Key(JsonElement frame) =>
        frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    private static Task<JsonElement> Post(User user, long channelId, int slots = 2, long? startAt = null, long? voiceChannelId = null, string game = "Valheim", string? note = null) =>
        user.RequestAsync("lfg.create", new { channelId, game, slots, startAt, voiceChannelId, note });

    private static long Id(JsonElement created) => created.Body().GetProperty("message").GetProperty("id").GetInt64();

    private static string[] Joined(JsonElement lfg) => lfg.GetProperty("joined").EnumerateArray().Select(k => k.GetString()!).ToArray();

    private static async Task<string> SubscribeAsync(User user)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        var keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) };
        Assert.Equal("result", (await user.RequestAsync("push.subscribe", new { endpoint, keys })).Type());
        Assert.Equal("result", (await user.RequestAsync("notify.set", new { level = "mentions" })).Type());
        return endpoint;
    }

    [Fact]
    public async Task A_post_fills_up_and_everyone_hears_about_it()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dave = await server.JoinAsync("Dave");
        var alicePush = await SubscribeAsync(alice);
        var bobPush = await SubscribeAsync(bob);

        var start = Now + 3_600_000;
        var created = await Post(alice, server.General, slots: 2, startAt: start, voiceChannelId: lounge, note: "Chill run");
        var message = created.Body().GetProperty("message");
        Assert.Equal("Looking for 2 for Valheim", message.GetProperty("text").GetString());
        var lfg = message.GetProperty("lfg");
        Assert.Equal("Valheim", lfg.GetProperty("game").GetString());
        Assert.Equal(lounge, lfg.GetProperty("voiceChannelId").GetInt64());
        Assert.Equal("Chill run", lfg.GetProperty("note").GetString());
        Assert.Equal(start + 2 * 3_600_000, lfg.GetProperty("expiresAt").GetInt64());
        Assert.Empty(Joined(lfg));
        var id = Id(created);
        Assert.Equal(id, (await bob.EventAsync("chat.message")).Body().GetProperty("message").GetProperty("id").GetInt64());

        // Bob joins: the poster hears about it, everyone sees the slot fill.
        var joined = (await bob.RequestAsync("lfg.join", new { id })).Body().GetProperty("lfg");
        Assert.Equal([bob.Key], Joined(joined));
        var heard = (await alice.EventAsync("lfg.joined")).Body();
        Assert.Equal(bob.Key, heard.GetProperty("accountKey").GetString());
        Assert.Equal([bob.Key], Joined((await carol.EventAsync("lfg.updated")).Body().GetProperty("lfg")));
        var push = (await server.Push.WaitForAsync(alicePush)).Single();
        Assert.Equal("lfg", push.GetProperty("kind").GetString());
        Assert.Equal("lfgJoined", push.GetProperty("text").GetProperty("title").GetString());
        Assert.Equal(id, push.GetProperty("messageId").GetInt64());

        // Joining twice changes nothing; your own post can't be joined.
        Assert.Equal([bob.Key], Joined((await bob.RequestAsync("lfg.join", new { id })).Body().GetProperty("lfg")));
        Assert.Equal("lfg_own", Key(await alice.RequestAsync("lfg.join", new { id })));

        // Carol fills it: the poster and everyone in it get the full ping (once), Dave finds it full.
        await carol.RequestAsync("lfg.join", new { id });
        Assert.Equal(id, (await alice.EventAsync("lfg.full")).Body().GetProperty("id").GetInt64());
        Assert.Equal(id, (await bob.EventAsync("lfg.full")).Body().GetProperty("id").GetInt64());
        Assert.Equal([bob.Key, carol.Key], Joined((await carol.EventAsync("lfg.full")).Body().GetProperty("lfg")));
        await dave.NoEventAsync("lfg.full");
        var full = await dave.RequestAsync("lfg.join", new { id });
        Assert.Equal("lfg_full", Key(full));
        var bobPushes = await server.Push.WaitForAsync(bobPush);
        Assert.Contains(bobPushes, p => p.GetProperty("text").GetProperty("title").GetString() == "lfgFull");

        // Someone leaves: a slot opens; filling it again doesn't ping again.
        await carol.RequestAsync("lfg.leave", new { id });
        Assert.Equal("result", (await dave.RequestAsync("lfg.join", new { id })).Type());
        await bob.NoEventAsync("lfg.full");

        // Posts can't be edited; history carries them.
        Assert.Equal("lfg_no_edit", Key(await alice.RequestAsync("chat.edit", new { id, text = "changed" })));
        var history = await bob.RequestAsync("chat.history", new { channelId = server.General });
        Assert.Equal("Valheim", history.Body().GetProperty("messages")[0].GetProperty("lfg").GetProperty("game").GetString());
    }

    [Fact]
    public async Task Fields_are_checked()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        var hidden = server.World.Store.CreateChannel("staff", "voice", "admin", "admin", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("lfg_channel", Key(await Post(alice, lounge)));
        Assert.Equal("lfg_slots", Key(await Post(alice, server.General, slots: 0)));
        Assert.Equal("lfg_slots", Key(await Post(alice, server.General, slots: 21)));
        Assert.Equal("lfg_game", Key(await Post(alice, server.General, game: "   ")));
        Assert.Equal("lfg_time", Key(await Post(alice, server.General, startAt: Now - 3_600_000)));
        Assert.Equal("lfg_time", Key(await Post(alice, server.General, startAt: Now + 8L * 24 * 3_600_000)));
        Assert.Equal("lfg_voice", Key(await Post(alice, server.General, voiceChannelId: hidden)));
        Assert.Equal("lfg_voice", Key(await Post(alice, server.General, voiceChannelId: server.General)));
        Assert.Equal("bad_request", (await Post(alice, server.General, game: new string('x', 300))).ErrorCode());
        Assert.Equal("not_found", (await Post(alice, 99999)).ErrorCode());
    }

    [Fact]
    public async Task Readers_only_and_writers_only()
    {
        using var server = new IskraServer();
        var news = server.World.Store.CreateChannel("news", "text", "member", "admin", 0).Id;
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        Assert.Equal("cant_send_here", Key(await Post(member, news)));
        var secret = Id(await Post(admin, staff));
        Assert.Equal("not_found", (await member.RequestAsync("lfg.join", new { id = secret })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("lfg.join", new { id = 424242 })).ErrorCode());
        var plain = (await member.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("not_found", (await admin.RequestAsync("lfg.join", new { id = plain })).ErrorCode());
    }

    [Fact]
    public async Task Posts_expire_and_can_be_closed_by_the_poster_or_a_moderator()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var closer = server.Services.GetRequiredService<LfgCloser>();

        // Without a time: 24 hours.
        var created = (await Post(alice, server.General)).Body().GetProperty("message");
        var id = created.GetProperty("id").GetInt64();
        var expires = created.GetProperty("lfg").GetProperty("expiresAt").GetInt64();
        Assert.InRange(expires - created.GetProperty("createdAt").GetInt64(), 24 * 3_600_000 - 1, 24 * 3_600_000 + 1);
        Assert.Equal(0, closer.CloseExpired(expires - 1));
        Assert.Equal(1, closer.CloseExpired(expires));
        var update = (await bob.EventAsync("lfg.updated")).Body().GetProperty("lfg");
        Assert.Equal(expires, update.GetProperty("closedAt").GetInt64());
        Assert.Equal("lfg_closed", Key(await bob.RequestAsync("lfg.join", new { id })));
        Assert.Equal(0, closer.CloseExpired(expires + 60_000));

        // Closing: not by just anyone; by the poster, or by a moderator above them.
        var second = Id(await Post(alice, server.General));
        Assert.Equal("lfg_close_author", Key(await bob.RequestAsync("lfg.close", new { id = second })));
        Assert.Equal("result", (await owner.RequestAsync("lfg.close", new { id = second })).Type());
        Assert.NotNull(server.World.Store.GetLfg(second)!.ClosedAt);
        Assert.Equal("lfg_closed", Key(await bob.RequestAsync("lfg.join", new { id = second })));

        // Deleting the message deletes the post.
        var third = Id(await Post(alice, server.General));
        await alice.RequestAsync("chat.delete", new { id = third });
        Assert.Null(server.World.Store.GetLfg(third));
    }

    [Fact]
    public async Task Notify_me_for_LFG_is_opt_in_and_respects_blocks_and_channels()
    {
        using var server = new IskraServer();
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var fan = await server.JoinAsync("Fan");
        using var quiet = await server.JoinAsync("Quiet");
        using var blocker = await server.JoinAsync("Blocker");
        Assert.False((await fan.RequestAsync("lfg.notify.get")).Body().GetProperty("on").GetBoolean());
        Assert.True((await fan.RequestAsync("lfg.notify.set", new { on = true })).Body().GetProperty("on").GetBoolean());
        Assert.True((await fan.RequestAsync("lfg.notify.get")).Body().GetProperty("on").GetBoolean());
        await blocker.RequestAsync("lfg.notify.set", new { on = true });
        server.World.Store.SaveBlocks(blocker.Key, [new Iskra.Server.Storage.BlockEntry(admin.Key, true, Now)]);
        await admin.RequestAsync("lfg.notify.set", new { on = true });

        var id = Id(await Post(admin, server.General, game: "Deep Rock"));
        var posted = (await fan.EventAsync("lfg.posted")).Body();
        Assert.Equal(id, posted.GetProperty("id").GetInt64());
        Assert.Equal("Deep Rock", posted.GetProperty("game").GetString());
        Assert.Equal(admin.Key, posted.GetProperty("author").GetString());
        await quiet.NoEventAsync("lfg.posted");
        await blocker.NoEventAsync("lfg.posted");
        await admin.NoEventAsync("lfg.posted"); // never your own

        // A channel the fan can't read stays quiet.
        await Post(admin, staff);
        await fan.NoEventAsync("lfg.posted");

        await fan.RequestAsync("lfg.notify.set", new { on = false });
        await Post(admin, server.General);
        await fan.NoEventAsync("lfg.posted");
    }

    [Fact]
    public async Task Creating_is_rate_limited_and_data_goes_with_the_account()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var codes = new List<string?>();
        for (var i = 0; i < 4; i++) codes.Add((await Post(alice, server.General)).ErrorCode());
        Assert.Equal([null, null, null, "rate_limited"], codes);

        var post = server.World.Store.History(server.General, null, null, 10).First(m => server.World.Store.GetLfg(m.Id) is not null).Id;
        await bob.RequestAsync("lfg.join", new { id = post });
        await bob.RequestAsync("lfg.notify.set", new { on = true });
        Assert.Contains(bob.Key, server.World.Store.LfgMembers(post));
        server.World.Store.DeleteAccount(new Iskra.Server.Storage.AccountDeletion(bob.Key, Now, false, "sig"), Now);
        Assert.DoesNotContain(bob.Key, server.World.Store.LfgMembers(post));
        Assert.False(server.World.Store.LfgNotifyOn(bob.Key));
    }
}
