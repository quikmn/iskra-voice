using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class DmFileTests
{
    /// <summary>Starts a DM upload for <paramref name="peer"/> and PUTs the bytes; returns the file id.</summary>
    private static async Task<string> UploadFor(IskraServer server, User user, string peer, byte[] content)
    {
        var ticket = await user.RequestAsync("dm.upload.begin", new { accountKey = peer, size = content.Length });
        Assert.Equal("result", ticket.Type());
        using var response = await server.CreateClient().PutAsync(ticket.Body().GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var file = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file");
        Assert.Equal("application/octet-stream", file.GetProperty("type").GetString()); // never sniffed: it's ciphertext
        return file.GetProperty("id").GetString()!;
    }

    private static Task<JsonElement> SendDm(User from, string to, params string[] files) =>
        from.RequestAsync("dm.send", new { accountKey = to, envelope = new { v = 2 }, files });

    private static async Task<string> LinkFor(User user, string id)
    {
        var result = await user.RequestAsync("dm.file.url", new { id });
        Assert.Equal("result", result.Type());
        return result.Body().GetProperty("url").GetString()!;
    }

    [Fact]
    public async Task Only_the_two_people_in_the_dm_can_download_the_ciphertext()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        // Even bytes that look like an image stay an opaque download.
        var bytes = EmojiTests.Png.Concat(RandomNumberGenerator.GetBytes(500)).ToArray();
        var id = await UploadFor(server, alice, bob.Key, bytes);
        Assert.Equal("result", (await SendDm(alice, bob.Key, id)).Type());

        var http = server.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/files/{id}/dm-file")).StatusCode);

        foreach (var reader in new[] { alice, bob })
        {
            using var response = await http.GetAsync(await LinkFor(reader, id));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(bytes, await response.Content.ReadAsByteArrayAsync());
            Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
            Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        }
        Assert.Equal("not_found", (await carol.RequestAsync("dm.file.url", new { id })).ErrorCode());
        Assert.Equal("not_found", (await carol.RequestAsync("dm.file.url", new { id = "nope" })).ErrorCode());
    }

    [Fact]
    public async Task Download_links_are_signed_and_expire()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = await UploadFor(server, alice, bob.Key, RandomNumberGenerator.GetBytes(100));
        var other = await UploadFor(server, alice, bob.Key, RandomNumberGenerator.GetBytes(100));
        var link = await LinkFor(bob, id);
        var http = server.CreateClient();
        var query = link[(link.IndexOf('?') + 1)..];

        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync($"/dmfiles/{other}?{query}")).StatusCode); // another file
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync(link.Replace("sig=", "sig=x"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync($"/dmfiles/{id}")).StatusCode);
        var past = DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds();
        var exp = System.Text.RegularExpressions.Regex.Match(link, "exp=([0-9]+)").Groups[1].Value;
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync(link.Replace($"exp={exp}", $"exp={past}"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync(link.Replace($"exp={exp}", $"exp={long.Parse(exp) + 60_000}"))).StatusCode);
    }

    [Fact]
    public async Task A_dm_can_only_carry_your_own_uploads_for_that_person_once()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var forBob = await UploadFor(server, alice, bob.Key, RandomNumberGenerator.GetBytes(64));

        Assert.Equal("bad_request", (await SendDm(alice, carol.Key, forBob)).ErrorCode());   // made for someone else
        Assert.Equal("bad_request", (await SendDm(bob, alice.Key, forBob)).ErrorCode());     // not Bob's upload
        Assert.Equal("bad_request", (await SendDm(alice, bob.Key, "made-up")).ErrorCode());
        var channelFile = await EmojiTests.Upload(server, alice, EmojiTests.Png, "a.png");
        Assert.Equal("bad_request", (await SendDm(alice, bob.Key, channelFile)).ErrorCode()); // a channel upload
        Assert.Equal("result", (await SendDm(alice, bob.Key, forBob)).Type());
        Assert.Equal("bad_request", (await SendDm(alice, bob.Key, forBob)).ErrorCode());     // already sent
        Assert.Equal("bad_request", (await SendDm(alice, bob.Key, Enumerable.Range(0, 11).Select(i => $"f{i}").ToArray())).ErrorCode());

        // Notes to yourself work too.
        var mine = await UploadFor(server, alice, alice.Key, RandomNumberGenerator.GetBytes(64));
        Assert.Equal("result", (await SendDm(alice, alice.Key, mine)).Type());
        Assert.Equal("not_found", (await bob.RequestAsync("dm.file.url", new { id = mine })).ErrorCode());
    }

    [Fact]
    public async Task Dm_uploads_follow_the_size_limit_and_unsent_ones_are_swept()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        Assert.Equal("bad_request", (await alice.RequestAsync("dm.upload.begin", new { accountKey = bob.Key, size = 513L * 1024 * 1024 })).ErrorCode());
        Assert.Equal("not_found", (await alice.RequestAsync("dm.upload.begin", new { accountKey = "nobody", size = 10 })).ErrorCode());

        var sent = await UploadFor(server, alice, bob.Key, RandomNumberGenerator.GetBytes(64));
        var unsent = await UploadFor(server, alice, bob.Key, RandomNumberGenerator.GetBytes(64));
        await SendDm(alice, bob.Key, sent);
        var uploads = server.Services.GetRequiredService<Uploads>();
        Assert.Equal(1, uploads.Sweep(DateTimeOffset.UtcNow.AddHours(25)));
        Assert.Equal("result", (await bob.RequestAsync("dm.file.url", new { id = sent })).Type());
        Assert.Equal("not_found", (await alice.RequestAsync("dm.file.url", new { id = unsent })).ErrorCode());
        Assert.Null(server.World.Store.GetDmFile(unsent));
    }

    [Fact]
    public async Task Group_dm_attachments_are_for_the_members_of_the_group()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var eve = await server.JoinAsync("Eve");
        var group = GroupTests.NewId();
        await GroupTests.CreateAsync(alice, group, bob, carol);
        Assert.Equal("not_found", (await eve.RequestAsync("dm.upload.begin", new { groupId = group, size = 10 })).ErrorCode());

        var ticket = (await alice.RequestAsync("dm.upload.begin", new { groupId = group, size = 4 })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent([1, 2, 3, 4]));
        var id = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
        Assert.Equal("result", (await alice.RequestAsync("group.send", new { groupId = group, version = 1, envelope = new { v = 2 }, files = new[] { id } })).Type());
        // Only once, and only your own.
        Assert.Equal("bad_request", (await alice.RequestAsync("group.send", new { groupId = group, version = 1, envelope = new { v = 2 }, files = new[] { id } })).ErrorCode());
        foreach (var member in new[] { alice, bob, carol }) await LinkFor(member, id);
        Assert.Equal("not_found", (await eve.RequestAsync("dm.file.url", new { id })).ErrorCode());

        // A file uploaded for a DM can't be slipped into a group whose members can't read it.
        var dmFile = await UploadFor(server, alice, bob.Key, [5, 6]);
        Assert.Equal("bad_request", (await alice.RequestAsync("group.send", new { groupId = group, version = 1, envelope = new { v = 2 }, files = new[] { dmFile } })).ErrorCode());
    }
}
