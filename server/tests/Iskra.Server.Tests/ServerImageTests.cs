using System.Buffers.Binary;
using System.Net;
using System.Text;
using System.Text.Json;
using Iskra.Server.Files;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class ServerImageTests
{
    // ── Pictures (the server reads their structure, never their pixels) ─────

    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data)
        {
            crc ^= b;
            for (var k = 0; k < 8; k++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
        }
        return ~crc;
    }

    private static byte[] Chunk(string type, byte[] data)
    {
        var typeBytes = Encoding.ASCII.GetBytes(type);
        var bytes = new byte[12 + data.Length];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)data.Length);
        typeBytes.CopyTo(bytes, 4);
        data.CopyTo(bytes, 8);
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(8 + data.Length), Crc32([.. typeBytes, .. data]));
        return bytes;
    }

    /// <summary>A PNG of the given size, with any extra chunks (metadata) before its image data.</summary>
    internal static byte[] Png(int width, int height, params byte[][] extra)
    {
        var header = new byte[13];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)width);
        BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(4), (uint)height);
        header[8] = 8; header[9] = 2;
        return [137, 80, 78, 71, 13, 10, 26, 10, .. Chunk("IHDR", header), .. extra.SelectMany(c => c),
            .. Chunk("IDAT", [0x78, 0x9C, 0x63, 0x60, 0, 0, 0, 2, 0, 1]), .. Chunk("IEND", [])];
    }

    private static byte[] Segment(byte marker, byte[] payload)
    {
        var bytes = new byte[4 + payload.Length];
        bytes[0] = 0xFF; bytes[1] = marker;
        BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(2), (ushort)(payload.Length + 2));
        payload.CopyTo(bytes, 4);
        return bytes;
    }

    /// <summary>A JPEG of the given size with EXIF (GPS) and a comment, and a JFIF header with a thumbnail.</summary>
    private static byte[] JpegWithExif(int width, int height)
    {
        byte[] jfif = [.. "JFIF\0"u8, 1, 1, 0, 0, 72, 0, 72, 1, 1, 0xAB, 0xCD, 0xEF];
        byte[] frame = [8, (byte)(height >> 8), (byte)height, (byte)(width >> 8), (byte)width, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
        return [0xFF, 0xD8, .. Segment(0xE0, jfif), .. Segment(0xE1, [.. "Exif\0\0GPSLatitude 59.3293 secret"u8]),
            .. Segment(0xFE, [.. "a secret comment"u8]), .. Segment(0xC0, frame),
            .. Segment(0xDA, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0]), 0x12, 0x34, 0xFF, 0x00, 0x56, 0xFF, 0xD0, 0x78, 0xFF, 0xD9];
    }

    private static byte[] RiffChunk(string fourcc, byte[] data)
    {
        var padded = data.Length + (data.Length & 1);
        var bytes = new byte[8 + padded];
        Encoding.ASCII.GetBytes(fourcc).CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)data.Length);
        data.CopyTo(bytes, 8);
        return bytes;
    }

    private static byte[] Webp(int width, int height, byte flags, params byte[][] chunks)
    {
        var vp8x = new byte[10];
        vp8x[0] = flags;
        vp8x[4] = (byte)(width - 1); vp8x[5] = (byte)((width - 1) >> 8);
        vp8x[7] = (byte)(height - 1); vp8x[8] = (byte)((height - 1) >> 8);
        byte[] body = [.. "WEBP"u8, .. RiffChunk("VP8X", vp8x), .. chunks.SelectMany(c => c)];
        var bytes = new byte[8 + body.Length];
        "RIFF"u8.CopyTo(bytes);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)body.Length);
        body.CopyTo(bytes, 8);
        return bytes;
    }

    private static byte[] Vp8l(int width, int height)
    {
        var bits = (uint)(width - 1) | ((uint)(height - 1) << 14);
        var data = new byte[5];
        data[0] = 0x2F;
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(1), bits);
        return RiffChunk("VP8L", data);
    }

    private static string? Key(JsonElement frame) => frame.Body().TryGetProperty("key", out var k) ? k.GetString() : null;

    private static async Task<JsonElement> SetIcon(IskraServer server, User user, byte[] image, string name = "icon.png") =>
        await user.RequestAsync("server.images.set", new { icon = await EmojiTests.Upload(server, user, image, name) });

    private static async Task<JsonElement> SetBanner(IskraServer server, User user, byte[] image, string name = "banner.png") =>
        await user.RequestAsync("server.images.set", new { banner = await EmojiTests.Upload(server, user, image, name) });

    // ── Tests ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Admins_set_the_icon_and_banner_members_cant_and_everyone_sees_them_live()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        var images = bob.Welcome.GetProperty("body").GetProperty("server").GetProperty("images");
        Assert.Equal(JsonValueKind.Null, images.GetProperty("icon").ValueKind);
        Assert.Equal(JsonValueKind.Null, images.GetProperty("banner").ValueKind);

        var denied = await SetIcon(server, bob, Png(256, 256));
        Assert.Equal("forbidden", denied.ErrorCode());
        Assert.Equal("server_images_admins", Key(denied));

        var set = await admin.RequestAsync("server.images.set", new
        {
            icon = await EmojiTests.Upload(server, admin, Png(256, 256), "icon.png"),
            banner = await EmojiTests.Upload(server, admin, Png(960, 360), "banner.png"),
        });
        Assert.Equal("result", set.Type());
        var seen = (await bob.EventAsync("server.images")).Body();
        Assert.StartsWith("/files/", seen.GetProperty("icon").GetProperty("url").GetString());
        Assert.Equal(960, seen.GetProperty("banner").GetProperty("width").GetInt32());
        var http = server.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync(seen.GetProperty("banner").GetProperty("url").GetString())).StatusCode);

        // Someone joining later gets both in the welcome.
        using var carol = await server.JoinAsync("Carol");
        var welcome = carol.Welcome.GetProperty("body").GetProperty("server").GetProperty("images");
        Assert.Equal(seen.GetProperty("icon").GetProperty("id").GetString(), welcome.GetProperty("icon").GetProperty("id").GetString());

        // Removing one leaves the other.
        Assert.Equal("result", (await owner.RequestAsync("server.images.set", new { icon = "" })).Type());
        var after = (await bob.EventAsync("server.images")).Body();
        Assert.Equal(JsonValueKind.Null, after.GetProperty("icon").ValueKind);
        Assert.Equal(JsonValueKind.Object, after.GetProperty("banner").ValueKind);
        Assert.Contains(server.World.Store.Audit(null, null, null, 50).Select(a => a.Action), a => a == "server.images");
    }

    [Fact]
    public async Task An_admin_without_the_power_cant()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        var all = (await owner.RequestAsync("role.list")).Body().GetProperty("baseRoles").EnumerateArray().Single(r => r.GetProperty("id").GetString() == "admin");
        var abilities = all.GetProperty("abilities").EnumerateArray().Select(a => a.GetString()!).ToList();
        Assert.Contains("serverImages", abilities);
        Assert.Equal("result", (await owner.RequestAsync("role.base.update", new { role = "admin", abilities = abilities.Where(a => a != "serverImages").ToArray() })).Type());
        Assert.Equal("forbidden", (await SetIcon(server, admin, Png(256, 256))).ErrorCode());
    }

    [Fact]
    public async Task Pictures_are_checked_by_their_bytes_size_and_shape()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var other = await server.JoinAsync("Other", "admin");
        using var third = await server.JoinAsync("Third", "admin");

        Assert.Equal("server_icon_small", Key(await SetIcon(server, admin, Png(64, 64))));
        Assert.Equal("server_icon_square", Key(await SetIcon(server, admin, Png(256, 200))));
        Assert.Equal("image_too_large", Key(await SetIcon(server, admin, Png(5000, 5000))));
        Assert.Equal("server_icon_size", Key(await SetIcon(server, admin, Png(256, 256, Chunk("tEXt", new byte[1024 * 1024])))));
        Assert.Equal("server_image_type", Key(await SetIcon(server, admin, "not an image at all, just text"u8.ToArray(), "fake.png")));
        Assert.Equal("server_image_type", Key(await SetIcon(server, admin, [.. "GIF89a"u8, 0, 1, 0, 1, 0, 0, 0, 0x3B], "a.gif")));
        Assert.Equal("server_image_animated", Key(await SetIcon(server, admin, Webp(256, 256, 0x02, RiffChunk("ANIM", new byte[6])), "a.webp")));
        Assert.Equal("image_size_unreadable", Key(await SetIcon(server, admin, Png(256, 256)[..40], "cut.png")));

        Assert.Equal("server_banner_shape", Key(await SetBanner(server, other, Png(960, 960))));
        Assert.Equal("server_banner_shape", Key(await SetBanner(server, other, Png(2000, 400))));
        Assert.Equal("server_banner_small", Key(await SetBanner(server, other, Png(300, 100))));
        Assert.Equal("result", (await SetBanner(server, other, Png(1500, 500))).Type());

        // Only your own uploads; and a bad banner doesn't leave a new icon behind.
        var theirs = await EmojiTests.Upload(server, other, Png(256, 256), "theirs.png");
        Assert.Equal("bad_request", (await admin.RequestAsync("server.images.set", new { icon = theirs })).ErrorCode());
        var bad = await third.RequestAsync("server.images.set", new
        {
            icon = await EmojiTests.Upload(server, third, Png(256, 256), "ok.png"),
            banner = await EmojiTests.Upload(server, third, Png(100, 100), "bad.png"),
        });
        Assert.Equal("bad_request", bad.ErrorCode());
        Assert.Null(server.World.Store.GetServerImage("icon"));
        Assert.Equal("bad_request", (await admin.RequestAsync("server.images.set", new { })).ErrorCode());
    }

    [Fact]
    public async Task Metadata_is_stripped_and_the_original_goes()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var http = server.CreateClient();

        async Task<byte[]> Served(JsonElement result, string kind)
        {
            Assert.Equal("result", result.Type());
            return await http.GetByteArrayAsync(result.Body().GetProperty(kind).GetProperty("url").GetString());
        }
        static bool Has(byte[] bytes, string text) => bytes.AsSpan().IndexOf(Encoding.ASCII.GetBytes(text)) >= 0;

        // PNG: text, EXIF and time chunks go; the image stays byte for byte.
        var pngUpload = await EmojiTests.Upload(server, admin,
            Png(256, 256, Chunk("tEXt", [.. "Comment\0GPS secret"u8]), Chunk("eXIf", [.. "MM\0*secret"u8]), Chunk("tIME", new byte[7])), "icon.png");
        var png = await Served(await admin.RequestAsync("server.images.set", new { icon = pngUpload }), "icon");
        Assert.False(Has(png, "secret"));
        Assert.False(Has(png, "eXIf") || Has(png, "tIME") || Has(png, "tEXt"));
        Assert.Equal(Png(256, 256), png);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/files/{pngUpload}/icon.png")).StatusCode);

        // JPEG: EXIF (GPS), comments and the JFIF thumbnail go; the frame and scan stay.
        var jpeg = await Served(await SetIcon(server, admin, JpegWithExif(300, 300), "icon.jpg"), "icon");
        Assert.False(Has(jpeg, "secret") || Has(jpeg, "Exif") || Has(jpeg, "GPS"));
        Assert.Equal((300, 300), FileSniffer.JpegSize(new MemoryStream(jpeg)));
        Assert.Equal([0xFF, 0xD9], jpeg[^2..]);
        Assert.True(Has(jpeg, "JFIF"));

        // WebP: the EXIF and XMP chunks go and the header stops announcing them.
        var webp = await Served(await SetIcon(server, admin,
            Webp(256, 256, 0x08 | 0x04, Vp8l(256, 256), RiffChunk("EXIF", [.. "GPS secret"u8]), RiffChunk("XMP ", [.. "<x>secret</x>"u8])), "icon.webp"), "icon");
        Assert.False(Has(webp, "secret") || Has(webp, "EXIF") || Has(webp, "XMP "));
        Assert.Equal(0, webp[20] & 0x0C);
        Assert.Equal(webp.Length - 8, (int)BinaryPrimitives.ReadUInt32LittleEndian(webp.AsSpan(4)));
    }

    [Fact]
    public async Task The_invite_landing_gets_the_icon_and_nothing_else()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var http = server.CreateClient();

        var root = JsonDocument.Parse(await http.GetStringAsync("/")).RootElement;
        Assert.Equal(JsonValueKind.Null, root.GetProperty("icon").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/icon")).StatusCode);

        await SetIcon(server, admin, Png(256, 256, Chunk("tEXt", [.. "Comment\0secret"u8])));
        Assert.Equal("result", (await SetBanner(server, admin, Png(960, 360))).Type());
        root = JsonDocument.Parse(await http.GetStringAsync("/")).RootElement;
        Assert.Equal(["iskra", "name", "icon"], root.EnumerateObject().Select(p => p.Name).ToArray());
        var version = root.GetProperty("icon").GetString();
        Assert.Matches("^[0-9a-f]{16}$", version!);

        using var response = await http.GetAsync($"/icon?v={version}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("image/png", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("*", response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Contains("sandbox", response.Headers.GetValues("Content-Security-Policy").Single());
        Assert.True(response.Headers.CacheControl?.Public);
        Assert.Equal(Png(256, 256), await response.Content.ReadAsByteArrayAsync());

        // Asked again with its tag: nothing to send.
        using var again = new HttpRequestMessage(HttpMethod.Get, "/icon");
        again.Headers.TryAddWithoutValidation("If-None-Match", response.Headers.ETag!.ToString());
        Assert.Equal(HttpStatusCode.NotModified, (await http.SendAsync(again)).StatusCode);
    }

    [Fact]
    public async Task The_icon_and_banner_survive_the_sweep_of_unused_uploads()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var icon = (await SetIcon(server, admin, Png(256, 256))).Body().GetProperty("icon").GetProperty("url").GetString();
        var banner = (await SetBanner(server, admin, Png(960, 360))).Body().GetProperty("banner").GetProperty("url").GetString();
        server.Services.GetRequiredService<Uploads>().Sweep(DateTimeOffset.UtcNow.AddHours(25));
        var http = server.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync(icon)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync(banner)).StatusCode);
    }
}
