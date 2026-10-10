using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Microsoft.Extensions.DependencyInjection;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;

namespace Iskra.Server.Tests;

public class WatchTests
{
    private static long Voice(IskraServer server, string kind = "voice", string write = "member") =>
        server.World.Store.CreateChannel(kind == "stage" ? "town-hall" : "movie-night", kind, "member", write, 0).Id;

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

    private static Task Join(IskraServer server, long channel, User user) => Webhook(server, "participant_joined", channel, user.Key);
    private static Task Leave(IskraServer server, long channel, User user) => Webhook(server, "participant_left", channel, user.Key);

    private static object Url(string url = "https://media.example.com/film.mp4") => new { kind = "url", url };

    private static async Task<JsonElement> StartAsync(User user, long channel, object? source = null, string? title = "Film")
    {
        var result = await user.RequestAsync("watch.start", new { channelId = channel, source = source ?? Url(), title });
        Assert.Null(result.ErrorCode());
        return result.Body().GetProperty("party");
    }

    private static async Task<JsonElement> StateWhere(User user, Func<JsonElement, bool> match)
    {
        for (var i = 0; i < 20; i++)
        {
            var state = (await user.EventAsync("watch.state")).Body();
            if (match(state)) return state;
        }
        throw new Xunit.Sdk.XunitException("no matching watch.state");
    }

    [Fact]
    public async Task Someone_in_the_channel_starts_a_party_and_everyone_who_can_read_it_hears()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        Assert.Equal("bad_request", (await alice.RequestAsync("watch.start", new { channelId = lounge, source = Url() })).ErrorCode()); // not in it
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.start", new { channelId = server.General, source = Url() })).ErrorCode());
        await Join(server, lounge, alice);
        var party = await StartAsync(alice, lounge);
        Assert.Equal("url", party.GetProperty("source").GetProperty("kind").GetString());
        Assert.Equal(alice.Key, party.GetProperty("host").GetString());
        Assert.False(party.GetProperty("playing").GetBoolean());

        var state = await StateWhere(bob, s => s.GetProperty("party").ValueKind == JsonValueKind.Object);
        Assert.Equal("Film", state.GetProperty("party").GetProperty("source").GetProperty("title").GetString());
        Assert.True(state.GetProperty("serverTime").GetInt64() > 0);

        // A second party needs the first one stopped (or the host or an admin to replace it).
        await Join(server, lounge, bob);
        Assert.Equal("bad_request", (await bob.RequestAsync("watch.start", new { channelId = lounge, source = Url() })).ErrorCode());

        // Late joiners get it in the welcome.
        using var carol = await server.JoinAsync("Carol");
        Assert.Equal(party.GetProperty("id").GetString(), carol.Welcome.Body().GetProperty("watch")[0].GetProperty("id").GetString());
    }

    [Theory]
    [InlineData("http://media.example.com/film.mp4")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://user:pass@media.example.com/film.mp4")]
    [InlineData("https://media.example.com/my film.mp4")]
    [InlineData("/files/abc/film.mp4")]
    public async Task Only_https_media_links_are_accepted(string url)
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        await Join(server, lounge, alice);
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.start", new { channelId = lounge, source = Url(url) })).ErrorCode());
    }

    [Fact]
    public async Task Sources_are_checked()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        await Join(server, lounge, alice);
        async Task<string?> Try(object source) => (await alice.RequestAsync("watch.start", new { channelId = lounge, source })).ErrorCode();

        Assert.Equal("bad_request", await Try(Url("https://example.com/" + new string('a', 2048))));
        Assert.Equal("bad_request", await Try(new { kind = "youtube", videoId = "../../etc" }));
        Assert.Equal("bad_request", await Try(new { kind = "ftp", url = "x" }));
        Assert.Equal("not_found", await Try(new { kind = "file", fileId = "nope" }));
        server.World.Store.AddFile(new StoredFile("doc-file-id-0001", "sha1", "notes.pdf", 10, "application/octet-stream", null, null, alice.Key, 0));
        Assert.Equal("bad_request", await Try(new { kind = "file", fileId = "doc-file-id-0001" }));

        server.World.Store.AddFile(new StoredFile("film-file-id-001", "sha2", "film.webm", 10, "video/webm", null, null, alice.Key, 0));
        var party = (await alice.RequestAsync("watch.start", new { channelId = lounge, source = new { kind = "file", fileId = "film-file-id-001" } })).Body().GetProperty("party");
        Assert.Equal("/files/film-file-id-001/film.webm", party.GetProperty("source").GetProperty("url").GetString());
        Assert.Equal("film.webm", party.GetProperty("source").GetProperty("title").GetString());

        // The host can switch to something else.
        var yt = await StartAsync(alice, lounge, new { kind = "youtube", videoId = "dQw4w9WgXcQ" });
        Assert.Equal("dQw4w9WgXcQ", yt.GetProperty("source").GetProperty("videoId").GetString());
        Assert.Equal(JsonValueKind.Null, yt.GetProperty("source").GetProperty("url").ValueKind);
    }

    [Fact]
    public async Task The_host_controls_playback_and_can_let_anyone_control()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await Join(server, lounge, alice);
        await Join(server, lounge, bob);
        var id = (await StartAsync(alice, lounge)).GetProperty("id").GetString();

        Assert.Equal("forbidden", (await bob.RequestAsync("watch.control", new { channelId = lounge, partyId = id, playing = true })).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("watch.settings", new { channelId = lounge, partyId = id, anyoneControls = true })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = "stale", playing = true })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = id, rate = 3 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = id, rate = 1.1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = id, position = -1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = id, position = "10" })).ErrorCode());

        var playing = (await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = id, playing = true, position = 61.5, rate = 1.5 })).Body().GetProperty("party");
        Assert.True(playing.GetProperty("playing").GetBoolean());
        Assert.Equal(61.5, playing.GetProperty("position").GetDouble());
        Assert.Equal(1.5, playing.GetProperty("rate").GetDouble());

        // Pausing without a position keeps the shared clock's position.
        await Task.Delay(200);
        var paused = (await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = id, playing = false })).Body().GetProperty("party");
        Assert.False(paused.GetProperty("playing").GetBoolean());
        Assert.InRange(paused.GetProperty("position").GetDouble(), 61.5 + 0.2 * 1.5 - 0.05, 61.5 + 2);
        Assert.Equal(1.5, paused.GetProperty("rate").GetDouble());

        Assert.Null((await alice.RequestAsync("watch.settings", new { channelId = lounge, partyId = id, anyoneControls = true })).ErrorCode());
        Assert.Null((await bob.RequestAsync("watch.control", new { channelId = lounge, partyId = id, position = 10 })).ErrorCode());
        var state = await StateWhere(alice, s => s.GetProperty("party").GetProperty("updatedBy").GetString() == bob.Key);
        Assert.Equal(10, state.GetProperty("party").GetProperty("position").GetDouble());

        Assert.Equal("forbidden", (await bob.RequestAsync("watch.stop", new { channelId = lounge, partyId = id })).ErrorCode());
        Assert.Null((await alice.RequestAsync("watch.stop", new { channelId = lounge, partyId = id })).ErrorCode());
        await StateWhere(bob, s => s.GetProperty("party").ValueKind == JsonValueKind.Null);
    }

    [Fact]
    public async Task Sync_messages_are_rate_limited()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        await Join(server, lounge, alice);
        var id = (await StartAsync(alice, lounge)).GetProperty("id").GetString();
        var codes = new List<string?>();
        for (var i = 0; i < 16; i++) codes.Add((await alice.RequestAsync("watch.control", new { channelId = lounge, partyId = id, position = i })).ErrorCode());
        Assert.Contains("rate_limited", codes);
    }

    [Fact]
    public async Task The_party_passes_on_when_the_host_leaves_and_ends_when_the_room_empties()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await Join(server, lounge, alice);
        await Join(server, lounge, bob);
        await StartAsync(alice, lounge);

        await Leave(server, lounge, alice);
        await StateWhere(bob, s => s.GetProperty("party").ValueKind == JsonValueKind.Object && s.GetProperty("party").GetProperty("host").GetString() == bob.Key);
        await Leave(server, lounge, bob);
        await StateWhere(bob, s => s.GetProperty("party").ValueKind == JsonValueKind.Null);
    }

    [Fact]
    public async Task Listen_only_members_and_stage_audiences_cannot_drive_it()
    {
        using var server = new IskraServer();
        var quiet = Voice(server, write: "trusted");
        using var bob = await server.JoinAsync("Bob");
        await Join(server, quiet, bob);
        Assert.Equal("forbidden", (await bob.RequestAsync("watch.start", new { channelId = quiet, source = Url() })).ErrorCode());

        var stage = Voice(server, "stage");
        using var admin = await server.JoinAsync("Admin", "admin");
        await Join(server, stage, admin);
        await admin.RequestAsync("stage.start", new { channelId = stage, topic = "Premiere" });
        await Join(server, stage, bob);
        Assert.Equal("forbidden", (await bob.RequestAsync("watch.start", new { channelId = stage, source = Url() })).ErrorCode());
        var id = (await StartAsync(admin, stage)).GetProperty("id").GetString();
        await admin.RequestAsync("watch.settings", new { channelId = stage, partyId = id, anyoneControls = true });
        Assert.Equal("forbidden", (await bob.RequestAsync("watch.control", new { channelId = stage, partyId = id, playing = true })).ErrorCode());

        // Brought up to speak, Bob may control (anyone can, here); back in the audience, he can't.
        await admin.RequestAsync("stage.invite", new { channelId = stage, accountKey = bob.Key });
        Assert.Null((await bob.RequestAsync("watch.control", new { channelId = stage, partyId = id, playing = true })).ErrorCode());
        await bob.RequestAsync("stage.audience", new { channelId = stage });
        Assert.Equal("forbidden", (await bob.RequestAsync("watch.control", new { channelId = stage, partyId = id, playing = false })).ErrorCode());
    }

    [Fact]
    public async Task Party_chat_goes_only_to_people_in_the_room()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await Join(server, lounge, alice);
        await Join(server, lounge, bob);

        Assert.Equal("not_found", (await alice.RequestAsync("watch.chat", new { channelId = lounge, text = "hi" })).ErrorCode()); // no party yet
        await StartAsync(alice, lounge);
        Assert.Equal("bad_request", (await carol.RequestAsync("watch.chat", new { channelId = lounge, text = "hi" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.chat", new { channelId = lounge, text = "   " })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.chat", new { channelId = lounge, text = new string('x', 1001) })).ErrorCode());
        Assert.Null((await alice.RequestAsync("watch.chat", new { channelId = lounge, text = "  popcorn ready?  " })).ErrorCode());

        var line = (await bob.EventAsync("watch.chat")).Body();
        Assert.Equal("popcorn ready?", line.GetProperty("text").GetString());
        Assert.Equal(alice.Key, line.GetProperty("accountKey").GetString());
        await carol.NoEventAsync("watch.chat");
    }

    [Fact]
    public async Task The_clock_answers_with_server_time()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var now = (await alice.RequestAsync("watch.clock")).Body().GetProperty("now").GetInt64();
        Assert.InRange(now, before - 1000, before + 5000);
    }

    [Fact]
    public async Task A_video_uploaded_for_a_running_party_is_not_swept()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        await Join(server, lounge, alice);
        // A WebM header is enough for the sniffer to call it a video.
        byte[] webm = [0x1A, 0x45, 0xDF, 0xA3, .. RandomNumberGenerator.GetBytes(64)];
        var ticket = (await alice.RequestAsync("upload.begin", new { name = "film.webm", size = webm.Length })).Body();
        using var put = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(webm));
        var fileId = JsonDocument.Parse(await put.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
        var party = await StartAsync(alice, lounge, new { kind = "file", fileId });

        var uploads = server.Services.GetRequiredService<Uploads>();
        Assert.Equal(0, uploads.Sweep(DateTimeOffset.UtcNow.AddHours(25)));
        Assert.NotNull(server.World.Store.GetFile(fileId));

        await alice.RequestAsync("watch.stop", new { channelId = lounge, partyId = party.GetProperty("id").GetString() });
        Assert.Equal(1, uploads.Sweep(DateTimeOffset.UtcNow.AddHours(25)));
        Assert.Null(server.World.Store.GetFile(fileId));
    }

    [Fact]
    public void Position_follows_the_shared_clock()
    {
        var source = new WatchSource("url", "https://x/y.mp4", null, null, null);
        var playing = new WatchParty("p", 1, source, "a", false, true, 10, 2, 1_000, 0, "a");
        Assert.Equal(14, playing.PositionAt(3_000));
        Assert.Equal(10, (playing with { Playing = false }).PositionAt(3_000));
        Assert.Equal(10, playing.PositionAt(500)); // never backwards
        Assert.Null(WatchFeature.ValidMediaUrl("https://"));
        Assert.Equal("https://cdn.example.com/a%20b.mp4", WatchFeature.ValidMediaUrl("https://cdn.example.com/a%20b.mp4"));
    }
}
