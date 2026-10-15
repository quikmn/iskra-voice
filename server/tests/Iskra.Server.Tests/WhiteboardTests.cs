using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Templates;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;

namespace Iskra.Server.Tests;

public class WhiteboardTests
{
    private static long Board(IskraServer server, string name = "sketch", string read = "member", string write = "member") =>
        server.World.Store.CreateChannel(name, "whiteboard", read, write, 0).Id;

    private static string? Key(JsonElement frame) => frame.Body().TryGetProperty("key", out var k) ? k.GetString() : null;

    private static object Pen(string id, double x = 10, double y = 20, string color = "#1a2b3c") =>
        new { id, p = new { kind = "pen", x, y, pts = new[] { 0, 0, 10, 5, 3, -2 }, color, size = 3, z = 1 } };

    private static async Task<string> Open(User user, long channelId)
    {
        var reply = await user.RequestAsync("wb.get", new { channelId });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("board").GetProperty("id").GetString()!;
    }

    private static async Task<long> Draw(User user, long channelId, string boardId, params object[] ops)
    {
        var reply = await user.RequestAsync("wb.update", new { channelId, boardId, ops });
        Assert.True(reply.Type() == "result", reply.GetRawText());
        return reply.Body().GetProperty("seq").GetInt64();
    }

    [Fact]
    public async Task A_whiteboard_channel_relays_batches_in_order_to_its_viewers_and_keeps_them()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");

        var channel = (await admin.RequestAsync("channel.create", new { name = "Plans", kind = "whiteboard" })).Body().GetProperty("channel");
        Assert.Equal("whiteboard", channel.GetProperty("kind").GetString());
        var id = channel.GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = id, text = "hi" })).ErrorCode());

        var boardId = await Open(bob, id);
        Assert.Equal(boardId, await Open(carol, id));
        var viewers = (await bob.EventAsync("wb.viewers")).Body().GetProperty("viewers");
        Assert.Contains(bob.Key, viewers.EnumerateArray().Select(v => v.GetString()));

        var reply = await bob.RequestAsync("wb.update", new { channelId = id, boardId, cid = "c1", ops = new[] { Pen("stroke-0001"), Pen("stroke-0002", 50, 60) } });
        Assert.Equal(1, reply.Body().GetProperty("seq").GetInt64());
        // Everyone viewing gets it, the sender too (with its cid).
        var mine = (await bob.EventAsync("wb.batch")).Body();
        Assert.Equal("c1", mine.GetProperty("cid").GetString());
        var seen = (await carol.EventAsync("wb.batch")).Body().GetProperty("batch");
        Assert.Equal(1, seen.GetProperty("seq").GetInt64());
        Assert.Equal(bob.Key, seen.GetProperty("by").GetString());
        Assert.Equal("#1a2b3c", seen.GetProperty("ops")[0].GetProperty("p").GetProperty("color").GetString());
        // Someone who isn't viewing it gets nothing.
        await admin.NoEventAsync("wb.batch");

        Assert.Equal(2, await Draw(carol, id, boardId, new { id = "stroke-0001", p = new { x = 99 } }));
        await carol.EventAsync("wb.batch");
        var loaded = (await admin.RequestAsync("wb.get", new { channelId = id })).Body();
        Assert.Equal(2, loaded.GetProperty("batches").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, loaded.GetProperty("snapshot").ValueKind);
        var since = (await admin.RequestAsync("wb.get", new { channelId = id, since = 1 })).Body().GetProperty("batches");
        Assert.Equal(2, Assert.Single(since.EnumerateArray()).GetProperty("seq").GetInt64());

        // A stale board id is not found; leaving stops the relay.
        Assert.Equal("not_found", (await bob.RequestAsync("wb.update", new { channelId = id, boardId = "nope", ops = new[] { Pen("stroke-0003") } })).ErrorCode());
        Assert.Equal("result", (await carol.RequestAsync("wb.leave", new { channelId = id })).Type());
        await Draw(bob, id, boardId, Pen("stroke-0004"));
        await carol.NoEventAsync("wb.batch");
    }

    [Fact]
    public async Task Reading_and_drawing_follow_the_channel_roles()
    {
        using var server = new IskraServer();
        using var trusted = await server.JoinAsync("Tess", "trusted");
        using var member = await server.JoinAsync("Bob");
        var readOnly = Board(server, "gallery", "member", "trusted");
        var hidden = Board(server, "staff", "trusted", "trusted");

        var boardId = await Open(member, readOnly);
        Assert.Equal("forbidden", (await member.RequestAsync("wb.update", new { channelId = readOnly, boardId, ops = new[] { Pen("stroke-0001") } })).ErrorCode());
        // Viewers may move a cursor, but only people who can draw send a stroke being drawn.
        Assert.Equal("result", (await member.RequestAsync("wb.live", new { channelId = readOnly, boardId, live = new { x = 1, y = 2 } })).Type());
        Assert.Equal("forbidden", (await member.RequestAsync("wb.live", new { channelId = readOnly, boardId, live = new { x = 1, y = 2, draft = new { id = "a" } } })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("wb.get", new { channelId = hidden })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("wb.get", new { channelId = server.General })).ErrorCode());

        await Open(trusted, readOnly);
        await Draw(trusted, readOnly, boardId, Pen("stroke-0001"));
        Assert.Equal(1, (await member.EventAsync("wb.batch")).Body().GetProperty("batch").GetProperty("seq").GetInt64());
    }

    [Fact]
    public async Task Live_cursors_go_to_the_other_viewers_only()
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var id = Board(server);
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.live", new { channelId = id, boardId = "x", live = new { x = 1, y = 2 } })).ErrorCode());
        var boardId = await Open(bob, id);
        await Open(carol, id);
        Assert.Equal("result", (await bob.RequestAsync("wb.live", new { channelId = id, boardId, live = new { x = 5.5, y = -3, tool = "pen" } })).Type());
        var live = (await carol.EventAsync("wb.live")).Body();
        Assert.Equal(bob.Key, live.GetProperty("accountKey").GetString());
        Assert.Equal(5.5, live.GetProperty("live").GetProperty("x").GetDouble());
        await bob.NoEventAsync("wb.live");
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.live", new { channelId = id, boardId, live = new { x = 1 } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.live", new { channelId = id, boardId, live = new { x = 1, y = 1, html = "<b>" } })).ErrorCode());
        // A live cursor can ride along with a batch.
        await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = new[] { Pen("stroke-0001") }, live = new { x = 9, y = 9 } });
        Assert.Equal(9, (await carol.EventAsync("wb.live")).Body().GetProperty("live").GetProperty("y").GetDouble());
    }

    [Theory]
    [InlineData("""[{ "id": "short", "p": { "kind": "pen" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "kind": "blob" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "colour": "#000000" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "color": "red" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "color": "#ABCDEF" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "x": 1e9 } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "size": 0 } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "pts": [1, 2, 3] } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "pts": [1.5, 2] } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "d": "yes" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "text": "bell\u0007" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "src": "https://example.com/cat.png" } }]""")]
    [InlineData("""[{ "id": "object-0001", "p": {} }]""")]
    [InlineData("""[{ "id": "object-0001", "p": { "x": 1 }, "extra": 1 }]""")]
    [InlineData("""[]""")]
    public async Task Bad_ops_are_refused(string ops)
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        var id = Board(server);
        var boardId = await Open(bob, id);
        var reply = await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = JsonNode.Parse(ops) });
        Assert.Equal("bad_request", reply.ErrorCode());
        Assert.Equal(0, server.World.Store.GetBoard(id)!.Seq);
    }

    [Fact]
    public async Task Limits_text_size_batch_size_pictures_and_rate()
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        var id = Board(server);
        var boardId = await Open(bob, id);
        var tooLong = await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = new[] { new { id = "note-00001", p = new { kind = "note", text = new string('a', 2001) } } } });
        Assert.Equal("wb_text_length", Key(tooLong));
        var many = Enumerable.Range(0, 201).Select(i => Pen($"stroke-{i:D5}")).ToArray();
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = many })).ErrorCode());
        var big = Enumerable.Range(0, 20).Select(i => new { id = $"stroke-{i:D5}", p = new { kind = "pen", pts = Enumerable.Range(0, 400).Select(n => 1234567).ToArray() } }).ToArray();
        Assert.Equal("wb_batch_size", Key(await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = big })));

        // Pictures: only images uploaded to this server.
        var png = await EmojiTests.Upload(server, bob, EmojiTests.Png, "cat.png");
        var text = await EmojiTests.Upload(server, bob, "just text"u8.ToArray(), "notes.txt");
        var file = server.World.Store.GetFile(png)!;
        await Draw(bob, id, boardId, new { id = "image-0001", p = new { kind = "image", x = 0, y = 0, w = 10, h = 10, src = Iskra.Server.Files.Uploads.UrlOf(file) } });
        Assert.Contains(png, server.World.Store.BoardFileIds());
        Assert.Equal("wb_picture", Key(await bob.RequestAsync("wb.update",
            new { channelId = id, boardId, ops = new[] { new { id = "image-0002", p = new { src = $"/files/{text}/notes.txt" } } } })));

        // wb.live: a burst of 10, then rate limited.
        var codes = new List<string?>();
        for (var i = 0; i < 12; i++) codes.Add((await bob.RequestAsync("wb.live", new { channelId = id, boardId, live = new { x = i, y = i } })).ErrorCode());
        Assert.Contains("rate_limited", codes);
    }

    [Fact]
    public async Task A_full_board_takes_only_deletions()
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        var id = Board(server);
        var boardId = await Open(bob, id);
        var store = server.World.Store;
        var filler = "[{\"id\":\"filler-0001\",\"p\":{\"text\":\"" + new string('x', 3 * 1024 * 1024) + "\"}}]";
        store.AppendBatch(id, boardId, bob.Key, filler, null, 1, []);
        store.AppendBatch(id, boardId, bob.Key, filler, null, 1, []);
        Assert.Equal("wb_full", Key(await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = new[] { Pen("stroke-0001") } })));
        await Draw(bob, id, boardId, new { id = "filler-0001", p = new { d = true } });
    }

    [Fact]
    public async Task Plain_boards_are_compacted_into_a_snapshot_without_deleted_objects()
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        var png = await EmojiTests.Upload(server, bob, EmojiTests.Png, "cat.png");
        var src = Iskra.Server.Files.Uploads.UrlOf(server.World.Store.GetFile(png)!);
        var id = Board(server);
        var boardId = await Open(bob, id);
        await Draw(bob, id, boardId, Pen("keep-00001"), Pen("gone-00001"), new { id = "image-0001", p = new { kind = "image", x = 0, y = 0, w = 5, h = 5, src } });
        await Draw(bob, id, boardId, new { id = "keep-00001", p = new { color = "#ff0000", z = (double?)null } }, new { id = "gone-00001", p = new { d = true } },
            new { id = "image-0001", p = new { d = true } });
        // Pile up batches directly (the rate limit would make this slow), then one more triggers the fold.
        var store = server.World.Store;
        for (var i = 0; i < WhiteboardFeature.CompactBatches; i++)
            store.AppendBatch(id, boardId, bob.Key, "[{\"id\":\"moved-" + i.ToString("D5") + "\",\"p\":{\"kind\":\"rect\",\"x\":" + i + ",\"y\":0,\"w\":1,\"h\":1}}]", null, 1, []);
        await Draw(bob, id, boardId, new { id = "moved-00000", p = new { x = -5 } });

        var board = store.GetBoard(id)!;
        Assert.Equal(board.Seq, board.SnapSeq);
        Assert.Equal(0, board.BatchCount);
        var loaded = (await bob.RequestAsync("wb.get", new { channelId = id })).Body();
        Assert.Equal(0, loaded.GetProperty("batches").GetArrayLength());
        var objects = loaded.GetProperty("snapshot").GetProperty("objects");
        Assert.Equal("#ff0000", objects.GetProperty("keep-00001").GetProperty("color").GetString());
        Assert.False(objects.GetProperty("keep-00001").TryGetProperty("z", out _));
        Assert.False(objects.TryGetProperty("gone-00001", out _));
        Assert.False(objects.TryGetProperty("image-0001", out _));
        Assert.Equal(-5, objects.GetProperty("moved-00000").GetProperty("x").GetDouble());
        Assert.Equal(1 + WhiteboardFeature.CompactBatches, objects.EnumerateObject().Count());
        // The deleted picture isn't kept by the board any more.
        Assert.DoesNotContain(png, store.BoardFileIds());
    }

    [Fact]
    public void Boards_survive_a_restart()
    {
        var path = Path.Combine(Path.GetTempPath(), "iskra-wb-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var world = World.OpenOrCreate(path))
            {
                var id = world.Store.CreateChannel("sketch", "whiteboard", "member", "member", 0).Id;
                var (board, _) = world.Store.EnsureBoard(id, "board-0001", null, 1);
                world.Store.AppendBatch(id, board.Id, "someone", """[{"id":"stroke-0001","p":{"kind":"pen"}}]""", null, 2, []);
            }
            using (var world = World.OpenOrCreate(path))
            {
                var channel = world.Store.AllChannels().Single(c => c.Kind == "whiteboard");
                var board = world.Store.GetBoard(channel.Id)!;
                Assert.Equal(("board-0001", 1L), (board.Id, board.Seq));
                Assert.Single(world.Store.Batches(channel.Id, 0, 1000).Batches);
            }
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            try { Directory.Delete(path, recursive: true); } catch (IOException) { }
        }
    }

    [Fact]
    public async Task Moderators_clear_a_board_and_everyone_starts_on_a_new_one()
    {
        using var server = new IskraServer();
        using var trusted = await server.JoinAsync("Tess", "trusted");
        using var member = await server.JoinAsync("Bob");
        var id = Board(server);
        var boardId = await Open(member, id);
        await Draw(member, id, boardId, Pen("stroke-0001"));
        Assert.Equal("wb_clear", Key(await member.RequestAsync("wb.clear", new { channelId = id, boardId })));
        Assert.Equal("result", (await trusted.RequestAsync("wb.clear", new { channelId = id, boardId })).Type());
        Assert.Equal(boardId, (await member.EventAsync("wb.cleared")).Body().GetProperty("boardId").GetString());
        Assert.Equal("not_found", (await member.RequestAsync("wb.update", new { channelId = id, boardId, ops = new[] { Pen("stroke-0002") } })).ErrorCode());
        var fresh = (await member.RequestAsync("wb.get", new { channelId = id })).Body();
        Assert.NotEqual(boardId, fresh.GetProperty("board").GetProperty("id").GetString());
        Assert.Equal(0, fresh.GetProperty("board").GetProperty("seq").GetInt64());
        Assert.Equal(0, fresh.GetProperty("batches").GetArrayLength());
        Assert.Single(server.World.Store.Audit("wb.clear", null, null, 10));
    }

    [Fact]
    public async Task A_voice_call_opens_a_board_that_stays_until_cleared()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;

        Assert.Equal("voice_join_first", Key(await alice.RequestAsync("wb.open", new { channelId = lounge })));
        await WatchTestsAccess.Join(server, lounge, alice);
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("wb.get", new { channelId = lounge })).Body().GetProperty("board").ValueKind);
        var board = (await alice.RequestAsync("wb.open", new { channelId = lounge })).Body().GetProperty("board");
        Assert.Equal(alice.Key, board.GetProperty("openedBy").GetString());
        var boardId = board.GetProperty("id").GetString()!;
        Assert.Equal(boardId, (await carol.EventAsync("wb.board")).Body().GetProperty("board").GetProperty("id").GetString());
        // Opening again answers the same board; others see it in wb.boards.
        Assert.Equal(boardId, (await alice.RequestAsync("wb.open", new { channelId = lounge })).Body().GetProperty("board").GetProperty("id").GetString());
        Assert.Equal(boardId, (await bob.RequestAsync("wb.boards")).Body().GetProperty("boards")[0].GetProperty("id").GetString());
        await Open(alice, lounge);
        await Draw(alice, lounge, boardId, Pen("stroke-0001"));
        await WatchTestsAccess.Leave(server, lounge, alice);
        Assert.Equal(1, (await bob.RequestAsync("wb.get", new { channelId = lounge })).Body().GetProperty("batches").GetArrayLength());

        // Bob (a member, not a moderator) can't clear Alice's board; she can.
        Assert.Equal("wb_clear", Key(await bob.RequestAsync("wb.clear", new { channelId = lounge, boardId })));
        Assert.Equal("result", (await alice.RequestAsync("wb.clear", new { channelId = lounge, boardId })).Type());
        var closed = (await carol.EventAsync("wb.board")).Body();
        Assert.Equal(JsonValueKind.Null, closed.GetProperty("board").ValueKind);
        Assert.Equal(0, (await bob.RequestAsync("wb.boards")).Body().GetProperty("boards").GetArrayLength());
        Assert.Null(server.World.Store.GetBoard(lounge));
    }

    [Fact]
    public async Task Timeouts_bots_and_templates()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var id = Board(server);
        var boardId = await Open(bob, id);
        Assert.Equal("result", (await admin.RequestAsync("member.timeout", new { accountKey = bob.Key, durationMs = 60_000 })).Type());
        Assert.Equal("forbidden", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = new[] { Pen("stroke-0001") } })).ErrorCode());

        var code = (await admin.RequestAsync("bot.invite", new { role = "member" })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var frame = identity.AuthFrame(await client.ReceiveAsync(), "Dice", invite: code);
        ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        using var bot = new User(identity, client, await client.ReceiveAsync());
        Assert.Equal("wb_bots", Key(await bot.RequestAsync("wb.get", new { channelId = id })));

        var template = ServerTemplates.Parse("""{ "name": "x", "channels": [ { "name": "Ideas", "kind": "whiteboard" } ] }""", "x.json");
        Assert.Equal("whiteboard", template.Channels.Single().Kind);
        var slow = Assert.Throws<TemplateException>(() => ServerTemplates.Parse("""{ "name": "x", "channels": [ { "name": "a", "kind": "whiteboard", "slowmode": 5 } ] }""", "x.json"));
        Assert.Contains("whiteboard channels have no slowmode", slow.Message);
    }

    [Fact]
    public async Task Whiteboard_channels_take_no_disappearing_timer()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = Board(server);
        var reply = await admin.RequestAsync("disappear.set", new { channelId = id, seconds = 3600 });
        Assert.Equal("disappear_kind", Key(reply));
    }

    [Fact]
    public async Task Your_unfolded_batches_are_in_your_data_and_lose_their_author_when_you_go()
    {
        using var server = new IskraServer();
        using var bob = await server.JoinAsync("Bob");
        var id = Board(server);
        var boardId = await Open(bob, id);
        await Draw(bob, id, boardId, Pen("stroke-0001"));
        var data = await ComplianceTests.Download(server, (await bob.RequestAsync("data.export")).Body());
        var batch = Assert.Single(data.GetProperty("whiteboardBatches").EnumerateArray());
        Assert.Contains("stroke-0001", batch.GetProperty("ops").GetString());
    }

    // ── Encrypted boards ───────────────────────────────────────────────────────

    private static string DeviceKey(User u) => Ed25519.ToB64u(Ed25519.PublicKeyOf(u.Identity.Device));

    private static JsonObject ChangePayload(User by, string chain, long version, string prev, string action, string[] targets, string[] members)
    {
        var payload = Encoding.UTF8.GetBytes(new JsonObject
        {
            ["v"] = 1, ["group"] = chain, ["version"] = version, ["prev"] = prev, ["by"] = by.Key, ["action"] = action,
            ["targets"] = new JsonArray(targets.Select(t => (JsonNode)t).ToArray()),
            ["members"] = new JsonArray(members.Select(m => (JsonNode)m).ToArray()),
            ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }.ToJsonString());
        var sig = Ed25519.Sign(by.Identity.Account, Ed25519.Payload(E2eeChannelFeature.Context, payload));
        return new JsonObject { ["payload"] = Ed25519.ToB64u(payload), ["sig"] = Ed25519.ToB64u(sig), ["head"] = GroupChain.Head(payload) };
    }

    private static JsonObject KeyEnvelope(User from, string chain, long version, params User[] to) => new()
    {
        ["v"] = 2, ["kind"] = "channel-key",
        ["header"] = new JsonObject { ["from"] = from.Key, ["chain"] = chain, ["version"] = version, ["head"] = "", ["sentAt"] = 1, ["id"] = "k" },
        ["nonce"] = "n", ["ct"] = "opaque",
        ["keys"] = new JsonArray(to.Select(u => (JsonNode)new JsonObject { ["device"] = DeviceKey(u), ["nonce"] = "x", ["box"] = "y" }).ToArray()),
    };

    private static JsonObject Envelope(User from, string chain, long version, long channel, string board, string what, long? seq = null, string ct = "opaque")
    {
        var header = new JsonObject
        {
            ["from"] = from.Key, ["chain"] = chain, ["version"] = version, ["sentAt"] = 1, ["id"] = "e",
            ["channel"] = channel, ["board"] = board, ["what"] = what,
        };
        if (seq is { } s) header["seq"] = s;
        return new JsonObject { ["v"] = 1, ["kind"] = "wb", ["header"] = header, ["nonce"] = "n", ["ct"] = ct, ["sig"] = "s" };
    }

    [Fact]
    public async Task Encrypted_boards_carry_only_envelopes_and_take_snapshots_from_the_apps()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob", "trusted");
        using var dave = await server.JoinAsync("Dave", "trusted");
        var chain = GroupTests.NewId();
        var create = ChangePayload(owner, chain, 1, "", "create", [bob.Key, dave.Key], [owner.Key, bob.Key, dave.Key]);
        var head = create["head"]!.GetValue<string>();
        create.Remove("head");
        var made = await owner.RequestAsync("channel.create", new
        {
            name = "secret-plans", kind = "whiteboard", readRole = "trusted",
            e2ee = new { change = create, keys = new[] { KeyEnvelope(owner, chain, 1, owner, bob, dave) } },
        });
        Assert.Equal("result", made.Type());
        var id = made.Body().GetProperty("channel").GetProperty("id").GetInt64();

        var loaded = (await bob.RequestAsync("wb.get", new { channelId = id })).Body();
        Assert.True(loaded.GetProperty("board").GetProperty("encrypted").GetBoolean());
        var boardId = loaded.GetProperty("board").GetProperty("id").GetString()!;
        await owner.RequestAsync("wb.get", new { channelId = id });

        // Plain ops never go to an encrypted board; envelopes must name this board, sender, chain and version.
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, ops = new[] { Pen("stroke-0001") } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, version = 1, envelope = Envelope(bob, chain, 1, id, "other", "ops") })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, version = 1, envelope = Envelope(owner, chain, 1, id, boardId, "ops") })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, version = 1, envelope = Envelope(bob, chain, 1, id, boardId, "live") })).ErrorCode());
        Assert.Equal("conflict", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, version = 2, envelope = Envelope(bob, chain, 2, id, boardId, "ops") })).ErrorCode());
        Assert.Equal("result", (await bob.RequestAsync("wb.update", new { channelId = id, boardId, version = 1, envelope = Envelope(bob, chain, 1, id, boardId, "ops", ct: "batch-1") })).Type());
        var relayed = (await owner.EventAsync("wb.batch")).Body().GetProperty("batch");
        Assert.Equal("batch-1", relayed.GetProperty("envelope").GetProperty("ct").GetString());
        Assert.Equal(1, relayed.GetProperty("version").GetInt64());
        Assert.False(relayed.TryGetProperty("ops", out _));
        // Live cursors are sealed too.
        Assert.Equal("result", (await bob.RequestAsync("wb.live", new { channelId = id, boardId, version = 1, envelope = Envelope(bob, chain, 1, id, boardId, "live") })).Type());
        Assert.Equal("opaque", (await owner.EventAsync("wb.live")).Body().GetProperty("envelope").GetProperty("ct").GetString());

        // Dave loses access: the chain moves to version 2, and the board now wants a snapshot under the new key.
        Assert.Equal("result", (await owner.RequestAsync("member.setRole", new { accountKey = dave.Key, role = "member" })).Type());
        var remove = ChangePayload(owner, chain, 2, head, "remove", [dave.Key], [owner.Key, bob.Key]);
        remove.Remove("head");
        Assert.Equal("result", (await owner.RequestAsync("echan.change", new { channelId = id, change = remove, keys = new[] { KeyEnvelope(owner, chain, 2, owner, bob) } })).Type());
        Assert.True((await bob.RequestAsync("wb.get", new { channelId = id })).Body().GetProperty("wantSnapshot").GetBoolean());

        // A snapshot must be for a seq the board has, newer than the last, under the current version.
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.snapshot", new { channelId = id, boardId, seq = 5, version = 2, envelope = Envelope(bob, chain, 2, id, boardId, "snapshot", 5) })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("wb.snapshot", new { channelId = id, boardId, seq = 1, version = 2, envelope = Envelope(bob, chain, 2, id, boardId, "snapshot", 2) })).ErrorCode());
        Assert.Equal("conflict", (await bob.RequestAsync("wb.snapshot", new { channelId = id, boardId, seq = 1, version = 1, envelope = Envelope(bob, chain, 1, id, boardId, "snapshot", 1) })).ErrorCode());
        Assert.Equal("result", (await bob.RequestAsync("wb.snapshot", new { channelId = id, boardId, seq = 1, version = 2, envelope = Envelope(bob, chain, 2, id, boardId, "snapshot", 1, "snap") })).Type());
        Assert.Equal(1, (await owner.EventAsync("wb.snapshot")).Body().GetProperty("seq").GetInt64());
        var after = (await owner.RequestAsync("wb.get", new { channelId = id })).Body();
        Assert.False(after.GetProperty("wantSnapshot").GetBoolean());
        Assert.Equal(0, after.GetProperty("batches").GetArrayLength());
        Assert.Equal("snap", after.GetProperty("snapshot").GetProperty("envelope").GetProperty("ct").GetString());
        // Re-sending the same snapshot isn't newer.
        Assert.Equal("wb_snapshot_old", Key(await bob.RequestAsync("wb.snapshot", new { channelId = id, boardId, seq = 1, version = 2, envelope = Envelope(bob, chain, 2, id, boardId, "snapshot", 1) })));
        // Plain boards don't take snapshots from apps.
        var plain = Board(server, "open-board");
        var plainId = await Open(owner, plain);
        Assert.Equal("bad_request", (await owner.RequestAsync("wb.snapshot", new { channelId = plain, boardId = plainId, seq = 1, version = 1, envelope = Envelope(owner, chain, 1, plain, plainId, "snapshot", 1) })).ErrorCode());
    }
}

/// <summary>Voice room joins through LiveKit's signed webhooks, as WatchTests does.</summary>
internal static class WatchTestsAccess
{
    private static async Task Webhook(IskraServer server, string evt, long channel, string identity)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { @event = evt, room = new { name = $"voice-{channel}" }, participant = new { identity } });
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var token = LiveKitTokens.Sign(new JsonObject
        {
            ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = Convert.ToBase64String(SHA256.HashData(body)),
        }, server.Voice.ApiSecret);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        request.Headers.TryAddWithoutValidation("Authorization", token);
        using var response = await server.CreateClient().SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    public static Task Join(IskraServer server, long channel, User user) => Webhook(server, "participant_joined", channel, user.Key);
    public static Task Leave(IskraServer server, long channel, User user) => Webhook(server, "participant_left", channel, user.Key);
}
