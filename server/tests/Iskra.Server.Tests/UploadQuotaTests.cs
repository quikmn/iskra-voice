using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Files;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Members can't fill the disk: a daily quota per account, an account-wide rate limit, and unused uploads are swept.</summary>
public class UploadQuotaTests
{
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=");

    private static async Task<string> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
    }

    private static Task<JsonElement> Begin(User user, long size) => user.RequestAsync("upload.begin", new { name = "a.bin", size });

    [Fact]
    public async Task Each_account_has_a_daily_quota_by_role_and_admins_have_none()
    {
        using var server = new IskraServer();
        server.World.UpdateSettings(s => s with { UploadQuota = new UploadQuotaSettings { MemberMbPerDay = 1, GuestMbPerDay = 0 } });
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var guest = await server.JoinAsync("Guest", "guest");
        const int kb600 = 600 * 1024;

        // An unfinished ticket counts too, so parallel tickets can't add up past the quota.
        Assert.Equal("result", (await Begin(alice, kb600)).Type());
        var refused = await Begin(alice, kb600);
        Assert.Equal("rate_limited", refused.ErrorCode());
        Assert.Contains("upload limit", refused.GetProperty("body").GetProperty("message").GetString());
        Assert.Equal("result", (await Begin(alice, 100 * 1024)).Type());

        // Uploaded bytes count for 24 hours.
        using var bob = await server.JoinAsync("Bob");
        await Upload(server, bob, RandomNumberGenerator.GetBytes(kb600), "big.bin");
        Assert.Equal("rate_limited", (await Begin(bob, kb600)).ErrorCode());

        // 0 means unlimited; admins and the owner aren't limited.
        Assert.Equal("result", (await Begin(guest, 5 * 1024 * 1024)).Type());
        Assert.Equal("result", (await Begin(owner, 5 * 1024 * 1024)).Type());
        Assert.Equal("result", (await Begin(owner, 5 * 1024 * 1024)).Type());
    }

    [Fact]
    public async Task Upload_rate_limit_is_per_account_not_per_session()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var sessions = new List<TestClient>();
        try
        {
            for (var i = 0; i < 2; i++)
            {
                var client = await server.ConnectAsync();
                await client.LoginAsync(alice.Identity, "Alice");
                sessions.Add(client);
            }
            // 20 tickets fit the account's burst, spread over sessions (each session allows 10)…
            for (var i = 0; i < 10; i++) Assert.Equal("result", (await Begin(alice, 10)).Type());
            for (var i = 0; i < 10; i++) Assert.Equal("result", (await sessions[0].RequestAsync("upload.begin", new { name = "a", size = 10 })).Type());
            // …and a fresh session doesn't get a fresh allowance.
            var codes = new List<string?>();
            for (var i = 0; i < 3; i++) codes.Add((await sessions[1].RequestAsync("upload.begin", new { name = "a", size = 10 })).ErrorCode());
            Assert.Contains("rate_limited", codes);
        }
        finally
        {
            foreach (var s in sessions) s.Dispose();
        }
    }

    [Fact]
    public async Task Unused_uploads_are_swept_after_a_day_and_used_ones_stay()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice", "admin");
        var uploads = server.Services.GetRequiredService<Uploads>();

        var unused = await Upload(server, alice, RandomNumberGenerator.GetBytes(100), "unused.bin");
        var unusedSameContent = await Upload(server, alice, Png, "copy.png"); // same bytes as the attachment
        var attached = await Upload(server, alice, Png, "cat.png");
        Assert.Equal("result", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "", attachments = new[] { attached } })).Type());
        var avatar = await Upload(server, alice, MakePng(1), "avatar.png");
        Assert.Equal("result", (await alice.RequestAsync("profile.update", new { avatar })).Type());
        var emoji = await Upload(server, alice, MakePng(2), "e.png");
        Assert.Equal("result", (await alice.RequestAsync("emoji.create", new { name = "party", fileId = emoji })).Type());
        var hookAvatar = await Upload(server, alice, MakePng(3), "hook.png");
        Assert.Equal("result", (await alice.RequestAsync("webhook.create", new { channelId = server.General, name = "CI", avatar = hookAvatar })).Type());
        var shown = await Upload(server, alice, MakePng(4), "shown.png");
        var page = await Upload(server, alice, Encoding.UTF8.GetBytes($"<img src=\"/files/{shown}/shown.png\">"), "page.html");
        Assert.Equal("result", (await alice.RequestAsync("profile.page.set", new { file = page })).Type());

        // Nothing is younger than a day yet.
        Assert.Equal(0, uploads.Sweep(DateTimeOffset.UtcNow));
        var removed = uploads.Sweep(DateTimeOffset.UtcNow.AddHours(25));
        Assert.Equal(3, removed); // unused, the unused copy, and the page's source file (its HTML lives in the database)

        var http = server.CreateClient();
        foreach (var gone in new[] { unused, unusedSameContent, page })
            Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/files/{gone}/x")).StatusCode);
        foreach (var kept in new[] { attached, avatar, emoji, hookAvatar, shown })
            Assert.Equal(HttpStatusCode.OK, (await http.GetAsync($"/files/{kept}/x")).StatusCode);
        // The copy shared its bytes with the attachment, so the content is still on disk; the random one isn't.
        Assert.Equal(5, Directory.EnumerateFiles(Path.Combine(server.WorldPath, "uploads"), "*", SearchOption.AllDirectories).Count());
    }

    /// <summary>A valid 1×1 PNG whose pixel differs by <paramref name="seed"/>, so each has its own content.</summary>
    private static byte[] MakePng(byte seed)
    {
        static byte[] Chunk(string type, byte[] data)
        {
            var typeBytes = Encoding.ASCII.GetBytes(type);
            var length = BitConverter.GetBytes(data.Length); Array.Reverse(length);
            var crc = BitConverter.GetBytes(Crc32([.. typeBytes, .. data])); Array.Reverse(crc);
            return [.. length, .. typeBytes, .. data, .. crc];
        }
        byte[] header = [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0];
        using var raw = new MemoryStream();
        using (var z = new System.IO.Compression.ZLibStream(raw, System.IO.Compression.CompressionLevel.Optimal, leaveOpen: true))
            z.Write([0, seed, 0, 0]);
        return [137, 80, 78, 71, 13, 10, 26, 10, .. Chunk("IHDR", header), .. Chunk("IDAT", raw.ToArray()), .. Chunk("IEND", [])];
    }

    private static uint Crc32(byte[] data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data)
        {
            crc ^= b;
            for (var k = 0; k < 8; k++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
        }
        return ~crc;
    }
}
