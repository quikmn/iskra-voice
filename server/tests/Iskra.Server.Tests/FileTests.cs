using System.Net;
using System.Text;
using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class FileTests
{
    // A real 3×2 PNG.
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=");

    private static async Task<JsonElement> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").Clone();
    }

    [Fact]
    public async Task Images_are_detected_by_content_and_served_safely()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var file = await Upload(server, alice, Png, "cat.png");
        Assert.Equal("image/png", file.GetProperty("type").GetString());
        Assert.Equal(3, file.GetProperty("width").GetInt32());
        Assert.Equal(2, file.GetProperty("height").GetInt32());

        using var response = await server.CreateClient().GetAsync(file.GetProperty("url").GetString());
        Assert.Equal("image/png", response.Content.Headers.ContentType!.MediaType);
        Assert.StartsWith("inline", response.Content.Headers.ContentDisposition!.ToString());
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Contains("sandbox", response.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal(Png, await response.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task Html_pretending_to_be_an_image_is_only_ever_a_download()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var file = await Upload(server, alice, Encoding.UTF8.GetBytes("<script>alert(document.cookie)</script>"), "totally-a-cat.png");
        Assert.Equal("application/octet-stream", file.GetProperty("type").GetString());

        using var response = await server.CreateClient().GetAsync(file.GetProperty("url").GetString());
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType!.MediaType);
        Assert.StartsWith("attachment", response.Content.Headers.ContentDisposition!.ToString());
    }

    [Fact]
    public async Task Tickets_are_single_use_and_sizes_are_enforced()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var http = server.CreateClient();

        var ticket = (await alice.RequestAsync("upload.begin", new { name = "a.bin", size = 4 })).Body().GetProperty("url").GetString();
        Assert.Equal(HttpStatusCode.OK, (await http.PutAsync(ticket, new ByteArrayContent([1, 2, 3, 4]))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.PutAsync(ticket, new ByteArrayContent([1, 2, 3, 4]))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.PutAsync("/upload/made-up", new ByteArrayContent([1]))).StatusCode);

        // Sending more than you announced is cut off.
        var small = (await alice.RequestAsync("upload.begin", new { name = "b.bin", size = 4 })).Body().GetProperty("url").GetString();
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await http.PutAsync(small, new ByteArrayContent(new byte[100]))).StatusCode);

        // Over the server's limit is refused up front.
        Assert.Equal("bad_request", (await alice.RequestAsync("upload.begin", new { name = "huge.iso", size = 10L * 1024 * 1024 * 1024 })).ErrorCode());
        Assert.False(Directory.EnumerateFiles(Path.Combine(server.WorldPath, "uploads"), ".incoming-*").Any());
    }

    [Fact]
    public async Task A_jpeg_size_is_found_past_large_metadata()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        // Two 64 KB APP1 segments (like a big EXIF block and a colour profile), then the frame header.
        var jpeg = new List<byte> { 0xFF, 0xD8 };
        for (var i = 0; i < 2; i++)
        {
            jpeg.AddRange([0xFF, 0xE1, 0xFF, 0xFF]);
            jpeg.AddRange(new byte[0xFFFF - 2]);
        }
        jpeg.AddRange([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        jpeg.AddRange([0xFF, 0xD9]);
        var file = await Upload(server, alice, jpeg.ToArray(), "big-exif.jpg");
        Assert.Equal("image/jpeg", file.GetProperty("type").GetString());
        Assert.Equal(800, file.GetProperty("width").GetInt32());
        Assert.Equal(600, file.GetProperty("height").GetInt32());
    }

    [Fact]
    public async Task Identical_files_are_stored_once()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var a = await Upload(server, alice, Png, "one.png");
        var b = await Upload(server, alice, Png, "two.png");
        Assert.NotEqual(a.GetProperty("id").GetString(), b.GetProperty("id").GetString());
        Assert.Single(Directory.EnumerateFiles(Path.Combine(server.WorldPath, "uploads"), "*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task Attachments_go_out_with_messages_and_must_be_your_own()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var file = await Upload(server, alice, Png, "cat.png");
        var id = file.GetProperty("id").GetString();

        var sent = await alice.RequestAsync("chat.send", new { channelId = server.General, text = "", attachments = new[] { id } });
        Assert.Equal("result", sent.Type());
        var received = (await bob.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("cat.png", received.GetProperty("attachments")[0].GetProperty("name").GetString());

        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "mine now", attachments = new[] { id } })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "" })).ErrorCode());
    }
}

public class ReplyAndReactionTests
{
    private static async Task<long> Post(User u, long channel, string text) =>
        (await u.RequestAsync("chat.send", new { channelId = channel, text })).Body().GetProperty("message").GetProperty("id").GetInt64();

    [Fact]
    public async Task Replies_carry_a_preview_of_the_original()
    {
        using var server = new IskraServer();
        var other = server.World.Store.CreateChannel("other", "text", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var original = await Post(alice, server.General, "who's up for a game?");

        var reply = (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "me!", replyTo = original })).Body().GetProperty("message");
        var preview = reply.GetProperty("replyTo");
        Assert.Equal(original, preview.GetProperty("id").GetInt64());
        Assert.Equal(alice.Key, preview.GetProperty("author").GetString());
        Assert.Equal("who's up for a game?", preview.GetProperty("text").GetString());

        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = other, text = "x", replyTo = original })).ErrorCode());
    }

    [Fact]
    public async Task Reactions_toggle_and_are_broadcast()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = await Post(alice, server.General, "gg");

        await bob.RequestAsync("chat.react", new { id, emoji = "🔥" });
        var update = (await alice.EventAsync("chat.reactions")).Body();
        Assert.Equal("🔥", update.GetProperty("reactions")[0].GetProperty("emoji").GetString());
        Assert.Equal(bob.Key, update.GetProperty("reactions")[0].GetProperty("accounts")[0].GetString());

        await bob.RequestAsync("chat.react", new { id, emoji = "🔥", on = false });
        Assert.Equal(0, (await alice.EventAsync("chat.reactions")).Body().GetProperty("reactions").GetArrayLength());

        Assert.Equal("bad_request", (await bob.RequestAsync("chat.react", new { id, emoji = "" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.react", new { id, emoji = "not an emoji at all, too long" })).ErrorCode());

        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages")[0];
        Assert.Equal(0, history.GetProperty("reactions").GetArrayLength());
    }
}
