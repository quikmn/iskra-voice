using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Listen together: the watch party's queue, moving on to the next item, and audio-only mode.</summary>
public class WatchQueueTests
{
    private static long Voice(IskraServer server) => server.World.Store.CreateChannel("jukebox", "voice", "member", "member", 0).Id;

    private static async Task Join(IskraServer server, long channel, User user)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { @event = "participant_joined", room = new { name = $"voice-{channel}" }, participant = new { identity = user.Key } });
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

    private static object Url(string file) => new { kind = "url", url = $"https://media.example.com/{file}" };

    private static string? Key(JsonElement frame) => frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    private static async Task<JsonElement> Party(User user, string type, object body)
    {
        var result = await user.RequestAsync(type, body);
        Assert.Null(result.ErrorCode());
        return result.Body().GetProperty("party");
    }

    private static string[] Titles(JsonElement party) =>
        party.GetProperty("queue").EnumerateArray().Select(i => i.GetProperty("source").GetProperty("title").GetString() ?? "").ToArray();

    private static string[] Ids(JsonElement party) => party.GetProperty("queue").EnumerateArray().Select(i => i.GetProperty("id").GetString()!).ToArray();

    private static async Task<JsonElement> StateWhere(User user, Func<JsonElement, bool> match)
    {
        for (var i = 0; i < 30; i++)
        {
            var state = (await user.EventAsync("watch.state")).Body();
            if (match(state)) return state;
        }
        throw new Xunit.Sdk.XunitException("no matching watch.state");
    }

    [Fact]
    public async Task Controllers_queue_items_reorder_and_remove_them_and_the_party_moves_on()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await Join(server, lounge, alice);
        await Join(server, lounge, bob);
        var party = await Party(alice, "watch.start", new { channelId = lounge, source = Url("film.mp4"), title = "Film" });
        var id = party.GetProperty("id").GetString();
        var playId = party.GetProperty("playId").GetString();
        Assert.False(string.IsNullOrEmpty(playId));
        Assert.Empty(party.GetProperty("queue").EnumerateArray());
        Assert.False(party.GetProperty("audioOnly").GetBoolean());

        // Only people who may control the party touch its queue.
        Assert.Equal("watch_host_only", Key(await bob.RequestAsync("watch.queue.add", new { channelId = lounge, partyId = id, source = Url("a.mp3"), title = "A" })));
        Assert.Equal("watch_title", Key(await alice.RequestAsync("watch.queue.add", new { channelId = lounge, partyId = id, source = Url("a.mp3"), title = new string('x', 201) })));
        Assert.Equal("bad_request", (await alice.RequestAsync("watch.queue.add", new { channelId = lounge, partyId = id, source = new { kind = "url", url = "http://media.example.com/a.mp3" } })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("watch.queue.add", new { channelId = lounge, partyId = "stale", source = Url("a.mp3") })).ErrorCode());

        party = await Party(alice, "watch.queue.add", new { channelId = lounge, partyId = id, source = Url("a.mp3"), title = "A" });
        party = await Party(alice, "watch.queue.add", new { channelId = lounge, partyId = id, source = new { kind = "youtube", videoId = "dQw4w9WgXcQ" } });
        party = await Party(alice, "watch.queue.add", new { channelId = lounge, partyId = id, source = Url("b.mp3"), title = "B" });
        Assert.Equal(["A", "", "B"], Titles(party));
        Assert.Equal(alice.Key, party.GetProperty("queue")[0].GetProperty("addedBy").GetString());
        Assert.Equal("dQw4w9WgXcQ", party.GetProperty("queue")[1].GetProperty("source").GetProperty("videoId").GetString());
        var ids = Ids(party);
        // Everyone in the channel sees the queue grow.
        await StateWhere(bob, s => s.GetProperty("party").GetProperty("queue").GetArrayLength() == 3);

        // Reorder: B before A, then A to the end; remove the video.
        party = await Party(alice, "watch.queue.move", new { channelId = lounge, partyId = id, itemId = ids[2], before = ids[0] });
        Assert.Equal(["B", "A", ""], Titles(party));
        party = await Party(alice, "watch.queue.move", new { channelId = lounge, partyId = id, itemId = ids[0] });
        Assert.Equal(["B", "", "A"], Titles(party));
        Assert.Equal("not_found", (await alice.RequestAsync("watch.queue.move", new { channelId = lounge, partyId = id, itemId = "nope" })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("watch.queue.move", new { channelId = lounge, partyId = id, itemId = ids[0], before = "nope" })).ErrorCode());
        party = await Party(alice, "watch.queue.remove", new { channelId = lounge, partyId = id, itemId = ids[1] });
        Assert.Equal(["B", "A"], Titles(party));
        Assert.Equal("not_found", (await alice.RequestAsync("watch.queue.remove", new { channelId = lounge, partyId = id, itemId = ids[1] })).ErrorCode());

        // Next: a stale playId changes nothing (someone else already moved on); the current one plays B from the start.
        party = await Party(alice, "watch.next", new { channelId = lounge, partyId = id, playId = "stale" });
        Assert.Equal("Film", party.GetProperty("source").GetProperty("title").GetString());
        party = await Party(alice, "watch.next", new { channelId = lounge, partyId = id, playId });
        Assert.Equal("B", party.GetProperty("source").GetProperty("title").GetString());
        Assert.True(party.GetProperty("playing").GetBoolean());
        Assert.Equal(0, party.GetProperty("position").GetDouble());
        Assert.NotEqual(playId, party.GetProperty("playId").GetString());
        Assert.Equal(["A"], Titles(party));
        await StateWhere(bob, s => s.GetProperty("party").GetProperty("source").GetProperty("title").GetString() == "B");

        // Anyone can control: Bob skips to A; with nothing left, next changes nothing.
        Assert.Null((await alice.RequestAsync("watch.settings", new { channelId = lounge, partyId = id, anyoneControls = true })).ErrorCode());
        party = await Party(bob, "watch.next", new { channelId = lounge, partyId = id });
        Assert.Equal("A", party.GetProperty("source").GetProperty("title").GetString());
        Assert.Equal(bob.Key, party.GetProperty("updatedBy").GetString());
        var same = await Party(bob, "watch.next", new { channelId = lounge, partyId = id });
        Assert.Equal(party.GetProperty("playId").GetString(), same.GetProperty("playId").GetString());
        Assert.Empty(same.GetProperty("queue").EnumerateArray());
    }

    [Fact]
    public async Task The_queue_holds_a_hundred_items()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        await Join(server, lounge, alice);
        var party = await Party(alice, "watch.start", new { channelId = lounge, source = Url("film.mp4") });
        var id = party.GetProperty("id").GetString()!;
        var watch = server.Services.GetRequiredService<VoiceRegistry>().Watch;
        var full = Enumerable.Range(0, WatchFeature.MaxQueue).Select(i => new WatchItem($"q{i}", new WatchSource("url", $"https://media.example.com/{i}.mp3", null, null, null), alice.Key, 0)).ToList();
        watch.Update(lounge, id, p => p with { Queue = full });
        var refused = await alice.RequestAsync("watch.queue.add", new { channelId = lounge, partyId = id, source = Url("one-more.mp3") });
        Assert.Equal("watch_queue_full", Key(refused));
        Assert.Equal(WatchFeature.MaxQueue, refused.Body().GetProperty("args").GetProperty("max").GetInt32());
        Assert.Equal(WatchFeature.MaxQueue, watch.Get(lounge)!.Queue.Count);
    }

    [Fact]
    public async Task Audio_only_is_the_hosts_setting_and_queued_files_are_kept_by_the_sweep()
    {
        using var server = new IskraServer();
        var lounge = Voice(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await Join(server, lounge, alice);
        await Join(server, lounge, bob);
        var id = (await Party(alice, "watch.start", new { channelId = lounge, source = Url("film.mp4") })).GetProperty("id").GetString();

        Assert.Equal("bad_request", (await alice.RequestAsync("watch.settings", new { channelId = lounge, partyId = id })).ErrorCode());
        Assert.Equal("watch_host_control", Key(await bob.RequestAsync("watch.settings", new { channelId = lounge, partyId = id, audioOnly = true })));
        Assert.Null((await alice.RequestAsync("watch.settings", new { channelId = lounge, partyId = id, audioOnly = true })).ErrorCode());
        var state = await StateWhere(bob, s => s.GetProperty("party").GetProperty("audioOnly").GetBoolean());
        Assert.False(state.GetProperty("party").GetProperty("anyoneControls").GetBoolean()); // left alone
        Assert.Null((await alice.RequestAsync("watch.settings", new { channelId = lounge, partyId = id, anyoneControls = true })).ErrorCode());
        Assert.True(server.Services.GetRequiredService<VoiceRegistry>().Watch.Get(lounge)!.AudioOnly); // left alone the other way

        // A queued upload counts as in use, like the one playing (a WebM header is enough for the sniffer to call it a video).
        byte[] webm = [0x1A, 0x45, 0xDF, 0xA3, .. RandomNumberGenerator.GetBytes(64)];
        var ticket = (await alice.RequestAsync("upload.begin", new { name = "song.webm", size = webm.Length })).Body();
        using var put = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(webm));
        var fileId = JsonDocument.Parse(await put.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
        var watch = server.Services.GetRequiredService<VoiceRegistry>().Watch;
        Assert.DoesNotContain(fileId, watch.FileIds());
        Assert.Null((await alice.RequestAsync("watch.queue.add", new { channelId = lounge, partyId = id, source = new { kind = "file", fileId } })).ErrorCode());
        Assert.Contains(fileId, watch.FileIds());
        var queued = watch.Get(lounge)!.Queue.Single();
        Assert.Equal("song.webm", queued.Source.Title); // a file's name stands in for a missing title
        Assert.StartsWith("/files/", queued.Source.Url);
    }
}
