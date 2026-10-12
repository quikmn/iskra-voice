using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Files;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Uploads in parts (PUT /upload/{ticket}?offset=n), which big encrypted DM files use.</summary>
public class UploadPartTests
{
    private static async Task<string> BeginDm(User user, string peer, long size)
    {
        var begin = (await user.RequestAsync("dm.upload.begin", new { accountKey = peer, size })).Body();
        Assert.Equal(Uploads.PartBytes, begin.GetProperty("partBytes").GetInt64());
        return begin.GetProperty("url").GetString()!;
    }

    private static Task<HttpResponseMessage> Part(HttpClient http, string url, long offset, byte[] bytes) =>
        http.PutAsync($"{url}?offset={offset}", new ByteArrayContent(bytes));

    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static bool Leftovers(IskraServer server) =>
        Directory.EnumerateFiles(Path.Combine(server.WorldPath, "uploads"), ".incoming-*").Any();

    [Fact]
    public async Task Parts_add_up_to_the_file_and_it_downloads_whole()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bytes = RandomNumberGenerator.GetBytes(3000);
        var url = await BeginDm(alice, bob.Key, bytes.Length);
        var http = server.CreateClient();

        using (var first = await Part(http, url, 0, bytes[..1000]))
            Assert.Equal(1000, (await Json(first)).GetProperty("received").GetInt64());
        using (var second = await Part(http, url, 1000, bytes[1000..2500]))
            Assert.Equal(2500, (await Json(second)).GetProperty("received").GetInt64());
        using var last = await Part(http, url, 2500, bytes[2500..]);
        Assert.Equal(HttpStatusCode.OK, last.StatusCode);
        var file = (await Json(last)).GetProperty("file");
        Assert.Equal(3000, file.GetProperty("size").GetInt64());
        Assert.Equal("application/octet-stream", file.GetProperty("type").GetString());
        var id = file.GetProperty("id").GetString()!;

        // Done: the ticket is gone.
        using (var again = await Part(http, url, 3000, [1])) Assert.Equal(HttpStatusCode.Forbidden, again.StatusCode);
        var link = (await bob.RequestAsync("dm.file.url", new { id })).Body().GetProperty("url").GetString();
        Assert.Equal(bytes, await http.GetByteArrayAsync(link));
        Assert.False(Leftovers(server));
    }

    [Fact]
    public async Task A_part_at_the_wrong_offset_says_where_to_go_on()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var bytes = RandomNumberGenerator.GetBytes(200);
        var url = await BeginDm(alice, bob.Key, bytes.Length);
        var http = server.CreateClient();

        using (var skipped = await Part(http, url, 100, bytes[100..]))
        {
            Assert.Equal(HttpStatusCode.Conflict, skipped.StatusCode);
            Assert.Equal(0, (await Json(skipped)).GetProperty("received").GetInt64());
        }
        using (var first = await Part(http, url, 0, bytes[..100])) Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        // The same part again (as if its answer got lost): the server says it already has it.
        using (var repeat = await Part(http, url, 0, bytes[..100]))
        {
            Assert.Equal(HttpStatusCode.Conflict, repeat.StatusCode);
            Assert.Equal(100, (await Json(repeat)).GetProperty("received").GetInt64());
        }
        using (var bad = await http.PutAsync($"{url}?offset=-5", new ByteArrayContent([1]))) Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        // A plain PUT can't take over an upload in parts.
        using (var plain = await http.PutAsync(url, new ByteArrayContent(bytes))) Assert.Equal(HttpStatusCode.Forbidden, plain.StatusCode);
        using var last = await Part(http, url, 100, bytes[100..]);
        Assert.Equal(HttpStatusCode.OK, last.StatusCode);
        Assert.Equal(200, (await Json(last)).GetProperty("file").GetProperty("size").GetInt64());
    }

    [Fact]
    public async Task Parts_past_the_announced_size_or_the_part_limit_end_the_upload()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var http = server.CreateClient();

        var url = await BeginDm(alice, bob.Key, 100);
        using (var first = await Part(http, url, 0, new byte[60])) Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        using (var over = await Part(http, url, 60, new byte[41])) Assert.Equal(HttpStatusCode.RequestEntityTooLarge, over.StatusCode);
        using (var after = await Part(http, url, 60, new byte[40])) Assert.Equal(HttpStatusCode.Forbidden, after.StatusCode);

        var big = await BeginDm(alice, bob.Key, Uploads.PartBytes * 2);
        using (var tooBig = await Part(http, big, 0, new byte[Uploads.PartBytes + 1]))
            Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooBig.StatusCode);
        using (var after = await Part(http, big, 0, new byte[10])) Assert.Equal(HttpStatusCode.Forbidden, after.StatusCode);

        // A plain upload's ticket doesn't take parts afterwards.
        var plain = await BeginDm(alice, bob.Key, 10);
        using (var whole = await http.PutAsync(plain, new ByteArrayContent(new byte[10]))) Assert.Equal(HttpStatusCode.OK, whole.StatusCode);
        using (var part = await Part(http, plain, 0, new byte[10])) Assert.Equal(HttpStatusCode.Forbidden, part.StatusCode);
        Assert.False(Leftovers(server));
    }

    [Fact]
    public async Task Channel_uploads_in_parts_are_sniffed_like_any_other()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var png = EmojiTests.Png;
        var begin = (await alice.RequestAsync("upload.begin", new { name = "cat.png", size = png.Length })).Body();
        var url = begin.GetProperty("url").GetString()!;
        var http = server.CreateClient();
        using (var first = await Part(http, url, 0, png[..10])) Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        using var last = await Part(http, url, 10, png[10..]);
        var file = (await Json(last)).GetProperty("file");
        Assert.Equal("image/png", file.GetProperty("type").GetString());
        Assert.Equal(png, await http.GetByteArrayAsync(file.GetProperty("url").GetString()));
    }

    [Fact]
    public async Task Unfinished_uploads_are_dropped_when_their_ticket_expires()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var http = server.CreateClient();
        var url = await BeginDm(alice, bob.Key, 1000);
        using (var first = await Part(http, url, 0, new byte[500])) Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.True(Leftovers(server));

        server.Services.GetRequiredService<Uploads>().Sweep(DateTimeOffset.UtcNow.AddMinutes(11));
        Assert.False(Leftovers(server));
        using var late = await Part(http, url, 500, new byte[500]);
        Assert.Equal(HttpStatusCode.Forbidden, late.StatusCode);
    }
}
