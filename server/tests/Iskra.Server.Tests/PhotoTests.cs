using System.Buffers.Binary;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class PhotoTests
{
    // ── Fixtures: files with the metadata phones and cameras write ───────────────

    private static byte[] Segment(byte marker, byte[] payload)
    {
        var bytes = new byte[4 + payload.Length];
        bytes[0] = 0xFF; bytes[1] = marker;
        BinaryPrimitives.WriteUInt16BigEndian(bytes.AsSpan(2), (ushort)(payload.Length + 2));
        payload.CopyTo(bytes, 4);
        return bytes;
    }

    /// <summary>
    /// A little-endian TIFF block as a phone writes it: make, orientation, the date taken with its time zone, a body
    /// serial number and a GPS directory.
    /// </summary>
    internal static byte[] Tiff(int orientation = 6, string? date = "2026:07:14 18:30:05", string? offset = "+02:00")
    {
        var data = new List<byte>();
        var ifd0 = new List<(ushort Tag, ushort Type, uint Count, byte[] Value)>
        {
            (0x010F, 2, 10, "SecretCam\0"u8.ToArray()),
            (0x0112, 3, 1, [(byte)orientation, 0, 0, 0]),
            (0x8769, 4, 1, []), // filled in below
            (0x8825, 4, 1, []),
        };
        var exif = new List<(ushort, ushort, uint, byte[])>();
        if (date is not null) exif.Add((0x9003, 2, 20, Encoding.ASCII.GetBytes(date + "\0")));
        if (offset is not null) exif.Add((0x9011, 2, 7, Encoding.ASCII.GetBytes(offset + "\0")));
        exif.Add((0xA431, 2, 9, "SN-12345\0"u8.ToArray()));
        var gps = new List<(ushort, ushort, uint, byte[])> { (0x0001, 2, 2, [(byte)'N', 0, 0, 0]), (0x0002, 2, 12, "59.3293 lat\0"u8.ToArray()) };

        var ifd0At = 8;
        var exifAt = ifd0At + 2 + ifd0.Count * 12 + 4;
        var gpsAt = exifAt + 2 + exif.Count * 12 + 4;
        var dataAt = gpsAt + 2 + gps.Count * 12 + 4;
        ifd0[2] = (0x8769, 4, 1, BitConverter.GetBytes((uint)exifAt));
        ifd0[3] = (0x8825, 4, 1, BitConverter.GetBytes((uint)gpsAt));

        var bytes = new List<byte> { (byte)'I', (byte)'I', 42, 0, 8, 0, 0, 0 };
        void Directory(List<(ushort Tag, ushort Type, uint Count, byte[] Value)> entries)
        {
            bytes.AddRange(BitConverter.GetBytes((ushort)entries.Count));
            foreach (var (tag, type, count, value) in entries)
            {
                bytes.AddRange(BitConverter.GetBytes(tag));
                bytes.AddRange(BitConverter.GetBytes(type));
                bytes.AddRange(BitConverter.GetBytes(count));
                if (value.Length <= 4) bytes.AddRange([.. value, .. new byte[4 - value.Length]]);
                else
                {
                    bytes.AddRange(BitConverter.GetBytes((uint)(dataAt + data.Count)));
                    data.AddRange(value);
                }
            }
            bytes.AddRange(new byte[4]);
        }
        Directory(ifd0);
        Directory(exif);
        Directory(gps);
        bytes.AddRange(data);
        return [.. bytes];
    }

    /// <summary>A JPEG with a JFIF header, EXIF (see <see cref="Tiff"/>), XMP and a comment.</summary>
    internal static byte[] Jpeg(int width, int height, byte[]? tiff, byte seed = 0x12)
    {
        byte[] jfif = [.. "JFIF\0"u8, 1, 1, 0, 0, 72, 0, 72, 0, 0];
        byte[] frame = [8, (byte)(height >> 8), (byte)height, (byte)(width >> 8), (byte)width, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
        return [0xFF, 0xD8, .. Segment(0xE0, jfif),
            .. tiff is null ? [] : Segment(0xE1, [.. "Exif\0\0"u8, .. tiff]),
            .. Segment(0xE1, [.. "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret owner</x:xmpmeta>"u8]),
            .. Segment(0xFE, [.. "a secret comment"u8]), .. Segment(0xC0, frame),
            .. Segment(0xDA, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0]), seed, 0x34, 0xFF, 0x00, 0x56, 0xFF, 0xD9];
    }

    private static byte[] Box(string type, params byte[][] parts)
    {
        var body = parts.SelectMany(p => p).ToArray();
        var bytes = new byte[8 + body.Length];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)bytes.Length);
        Encoding.Latin1.GetBytes(type).CopyTo(bytes, 4);
        body.CopyTo(bytes, 8);
        return bytes;
    }

    private static byte[] U32(params uint[] values)
    {
        var bytes = new byte[values.Length * 4];
        for (var i = 0; i < values.Length; i++) BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(i * 4), values[i]);
        return bytes;
    }

    private const uint Created = 3_860_000_000; // seconds since 1904

    private static byte[] Track(string handler, string name, params byte[][] sampleTable) =>
        Box("trak",
            Box("tkhd", U32(0, Created, Created, 1, 0, 0)),
            Box("udta", "track note"u8.ToArray()),
            Box("mdia",
                Box("mdhd", U32(0, Created, Created, 1000, 0, 0)),
                Box("hdlr", U32(0, 0), Encoding.Latin1.GetBytes(handler), new byte[12], Encoding.Latin1.GetBytes(name + "\0")),
                Box("minf", Box("stbl", sampleTable))));

    /// <summary>
    /// A phone video: a video track, a timed metadata track whose two samples are a GPS trail inside the media data,
    /// location and make in udta and meta, and an XMP uuid box.
    /// </summary>
    internal static byte[] Mp4()
    {
        var ftyp = Box("ftyp", "isom"u8.ToArray(), U32(0x200), "isom"u8.ToArray());
        var media = Box("mdat", "VIDEODATA"u8.ToArray(), "GPS1"u8.ToArray(), "GPSTWO"u8.ToArray());
        var gpsAt = (uint)(ftyp.Length + 8 + 9);
        var moov = Box("moov",
            Box("mvhd", U32(0, Created, Created, 1000, 5000)),
            Box("udta", Box("©xyz", "+59.3293+018.0686/"u8.ToArray())),
            Box("meta", "com.apple.quicktime.make SecretCam"u8.ToArray()),
            Track("vide", "SecretCam Video", Box("stco", U32(0, 1, (uint)(ftyp.Length + 8))), Box("stsc", U32(0, 1, 1, 1, 1)), Box("stsz", U32(0, 9, 1))),
            Track("meta", "Location Track", Box("stco", U32(0, 1, gpsAt)), Box("stsc", U32(0, 1, 1, 2, 1)), Box("stsz", U32(0, 0, 2, 4, 6))));
        return [.. ftyp, .. media, .. moov, .. Box("uuid", "XMP secret owner"u8.ToArray())];
    }

    private static bool Has(byte[] haystack, string needle) => haystack.AsSpan().IndexOf(Encoding.Latin1.GetBytes(needle)) >= 0;

    // ── Cleaning ───────────────────────────────────────────────────────────────

    [Fact]
    public void A_jpeg_keeps_its_pixels_which_way_is_up_and_optionally_the_date_and_nothing_else()
    {
        var jpeg = Jpeg(400, 300, Tiff());
        var kept = PhotoMetadata.ReadExif(PhotoMetadata.JpegExif(jpeg));
        Assert.Equal(new PhotoMetadata.Kept(6, "2026:07:14 18:30:05", "+02:00"), kept);

        var withDate = PhotoMetadata.Clean(jpeg, "image/jpeg", keepDate: true);
        foreach (var secret in new[] { "SecretCam", "SN-12345", "59.3293", "secret owner", "secret comment", "xmpmeta" }) Assert.False(Has(withDate, secret), secret);
        Assert.Equal(kept, PhotoMetadata.ReadExif(PhotoMetadata.JpegExif(withDate)));
        Assert.Equal((400, 300), FileSniffer.JpegSize(new MemoryStream(withDate)));
        // The image data is the uploader's, byte for byte.
        Assert.True(withDate.AsSpan().EndsWith(jpeg.AsSpan(jpeg.Length - 7)));

        var withoutDate = PhotoMetadata.Clean(jpeg, "image/jpeg", keepDate: false);
        Assert.Equal(new PhotoMetadata.Kept(6, null, null), PhotoMetadata.ReadExif(PhotoMetadata.JpegExif(withoutDate)));
        Assert.False(Has(withoutDate, "2026:07:14"));

        // Cleaning twice changes nothing more (the app cleans first, the server again).
        Assert.Equal(withDate, PhotoMetadata.Clean(withDate, "image/jpeg", keepDate: true));
        Assert.Equal(withoutDate, PhotoMetadata.Clean(withDate, "image/jpeg", keepDate: false));

        // An upright picture without a date to keep carries no EXIF at all.
        var upright = PhotoMetadata.Clean(Jpeg(400, 300, Tiff(orientation: 1)), "image/jpeg", keepDate: false);
        Assert.True(PhotoMetadata.JpegExif(upright).IsEmpty);
        Assert.Equal(ImageMetadata.Strip(jpeg, "image/jpeg"), upright);
        // Damaged EXIF is dropped, never copied.
        Assert.True(PhotoMetadata.JpegExif(PhotoMetadata.Clean(Jpeg(400, 300, "II*\0garbage 59.3293"u8.ToArray()), "image/jpeg", true)).IsEmpty);
        Assert.Throws<ImageMetadata.Refused>(() => PhotoMetadata.Clean("not a jpeg"u8.ToArray(), "image/jpeg", true));
    }

    [Fact]
    public void A_webp_and_a_png_lose_their_metadata_too()
    {
        static byte[] Riff(string fourcc, byte[] data)
        {
            var bytes = new byte[8 + data.Length + (data.Length & 1)];
            Encoding.ASCII.GetBytes(fourcc).CopyTo(bytes, 0);
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)data.Length);
            data.CopyTo(bytes, 8);
            return bytes;
        }
        byte[] body = [.. "WEBP"u8, .. Riff("VP8X", [0x0C, 0, 0, 0, 99, 0, 0, 49, 0, 0]), .. Riff("VP8L", [0x2F, 0, 0, 0, 0]),
            .. Riff("EXIF", Tiff()), .. Riff("XMP ", "secret owner"u8.ToArray())];
        byte[] webp = [.. "RIFF"u8, .. BitConverter.GetBytes((uint)body.Length), .. body];

        var clean = PhotoMetadata.Clean(webp, "image/webp", keepDate: true);
        foreach (var secret in new[] { "SecretCam", "SN-12345", "59.3293", "secret owner" }) Assert.False(Has(clean, secret), secret);
        Assert.True(Has(clean, "2026:07:14 18:30:05"));
        Assert.Equal(0x08, clean[20]); // EXIF only: the minimal block
        Assert.Equal(clean.Length - 8, (int)BinaryPrimitives.ReadUInt32LittleEndian(clean.AsSpan(4)));
        Assert.Equal(clean, PhotoMetadata.Clean(clean, "image/webp", keepDate: true));
        var bare = PhotoMetadata.Clean(webp, "image/webp", keepDate: false);
        Assert.True(Has(bare, "EXIF")); // it lies on its side: the orientation stays
        Assert.False(Has(bare, "2026:07:14"));

        var png = ServerImageTests.Png(64, 64, ServerImageTests.Chunk("tEXt", "Author\0secret owner"u8.ToArray()), ServerImageTests.Chunk("eXIf", Tiff()));
        var cleanPng = PhotoMetadata.Clean(png, "image/png", keepDate: true);
        Assert.False(Has(cleanPng, "secret owner"));
        Assert.False(Has(cleanPng, "SecretCam"));
        Assert.Equal(ServerImageTests.Png(64, 64), cleanPng);
    }

    [Fact]
    public void A_video_loses_location_device_and_extra_tracks_in_place()
    {
        var mp4 = Mp4();
        foreach (var keepDate in new[] { true, false })
        {
            var clean = (byte[])mp4.Clone();
            using (var stream = new MemoryStream(clean))
            {
                var patches = Mp4Metadata.Plan(stream, keepDate);
                Assert.NotEmpty(patches);
                Mp4Metadata.Apply(stream, patches);
            }
            Assert.Equal(mp4.Length, clean.Length);
            foreach (var secret in new[] { "59.3293", "SecretCam", "XMP secret", "Location Track", "track note", "GPS1", "GPSTWO", "udta", "uuid" })
                Assert.False(Has(clean, secret), secret);
            Assert.True(Has(clean, "VIDEODATA"));
            Assert.True(Has(clean, "vide"));
            Assert.Equal(keepDate, Has(clean, Encoding.Latin1.GetString(U32(Created))));
            using var again = new MemoryStream(clean);
            Assert.Empty(Mp4Metadata.Plan(again, keepDate));
        }
        Assert.Throws<Mp4Metadata.Refused>(() => Mp4Metadata.Plan(new MemoryStream(Box("ftyp", "isom"u8.ToArray())), true));
    }

    /// <summary>
    /// The fixtures the app's tests clean too (client/src/core/photoMetadata.test.ts has the same hashes): the server and
    /// the app must write the same bytes, so a file the app cleaned passes through the server unchanged.
    /// </summary>
    [Theory]
    [InlineData("gps.jpg", "image/jpeg", true, "4ede4a1beb081d03ce7fdee76946cc6bfa1f038b90957f8f7544a5c2eff75f98")]
    [InlineData("gps.jpg", "image/jpeg", false, "15d98e762c0f219ee0cfe9ca7dbee81aecd6059952f4d9073f81294a542af6a0")]
    [InlineData("screenshot.png", "image/png", true, "e13a12ae4444c46faea8a0ca3090994f15cab1f141efc956188adb5d6c76c9c6")]
    [InlineData("clip.mp4", "video/mp4", true, "0972284705233ff86b1f1a6b6315b49bf07d920ec4f570c0bcbd3a97afdab909")]
    [InlineData("clip.mp4", "video/mp4", false, "83037acc02d5b5d3219e4980712d4e3262f619ef008b5995225d7ff1228a4b3a")]
    public void The_server_and_the_app_clean_a_file_to_the_same_bytes(string name, string type, bool keepDate, string sha256)
    {
        var original = File.ReadAllBytes(Path.Combine(Path.GetDirectoryName(Repo.ProtocolFile("PROTOCOL.md"))!, "..", "client", "e2e", "fixtures", "photos", name));
        byte[] cleaned;
        if (type == "video/mp4")
        {
            cleaned = (byte[])original.Clone();
            using var stream = new MemoryStream(cleaned);
            Mp4Metadata.Apply(stream, Mp4Metadata.Plan(stream, keepDate));
        }
        else cleaned = PhotoMetadata.Clean(original, type, keepDate);
        Assert.Equal(sha256, Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(cleaned)));
        foreach (var secret in new[] { "SecretCam", "SecretPhone", "Secret Owner", "SN-SECRET", "59.3293", "Secret title" }) Assert.False(Has(cleaned, secret), secret);
    }

    // ── Helpers for the channel ────────────────────────────────────────────────

    private static string? Key(JsonElement frame) => frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    private static async Task<long> Channel(User admin, string name = "holiday", object? more = null)
    {
        var body = JsonSerializer.SerializeToNode(more ?? new { })!.AsObject();
        body["name"] = name;
        body["kind"] = "photos";
        var reply = await admin.RequestAsync("channel.create", body);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("channel").GetProperty("id").GetInt64();
    }

    /// <summary>Uploads a photo and its thumbnail with photo.upload.begin; returns their file ids.</summary>
    private static async Task<(string File, string Thumb)> Upload(IskraServer server, User user, long channelId, byte[] content, string name, byte[]? thumb = null)
    {
        thumb ??= Jpeg(32, 24, null, (byte)content.Length);
        var ticket = await user.RequestAsync("photo.upload.begin", new { channelId, name, size = content.Length, thumbSize = thumb.Length });
        Assert.Equal("result", ticket.Type());
        var http = server.CreateClient();
        async Task<string> Put(string url, byte[] bytes)
        {
            using var response = await http.PutAsync(url, new ByteArrayContent(bytes));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
        }
        return (await Put(ticket.Body().GetProperty("url").GetString()!, content), await Put(ticket.Body().GetProperty("thumbUrl").GetString()!, thumb));
    }

    private static int _seed;

    /// <summary>Adds one photo (a JPEG unlike any other in the test) and returns it as the server shows it.</summary>
    private static async Task<JsonElement> AddPhoto(IskraServer server, User user, long channelId, string name = "IMG_1.jpg", object? more = null, byte[]? content = null)
    {
        content ??= Jpeg(400, 300, Tiff(), (byte)Interlocked.Increment(ref _seed));
        var (file, thumb) = await Upload(server, user, channelId, content, name);
        var body = JsonSerializer.SerializeToNode(more ?? new { })!.AsObject();
        body["channelId"] = channelId;
        body["items"] = new JsonArray(new JsonObject { ["file"] = file, ["thumb"] = thumb, ["width"] = 300, ["height"] = 400, ["takenAt"] = 1_784_000_000_000 });
        var reply = await user.RequestAsync("photo.add", body);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("photos")[0];
    }

    private static long Id(JsonElement item) => item.GetProperty("id").GetInt64();

    private static async Task<List<JsonElement>> Listed(User user, long channelId) =>
        (await user.RequestAsync("photo.list", new { channelId })).Body().GetProperty("photos").EnumerateArray().ToList();

    private static async Task<byte[]> Served(IskraServer server, JsonElement file) =>
        await server.CreateClient().GetByteArrayAsync(file.GetProperty("url").GetString());

    // ── The channel ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Photos_are_cleaned_by_the_server_listed_and_seen_live()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var channel = await Channel(admin);

        // Alice's app didn't clean anything (an old or unofficial app): the server does.
        var original = Jpeg(400, 300, Tiff());
        var photo = await AddPhoto(server, alice, channel, "IMG 1.jpg", new { batch = "b1", total = 3 }, original);
        Assert.Equal("image", photo.GetProperty("kind").GetString());
        Assert.Equal(alice.Key, photo.GetProperty("uploader").GetString());
        Assert.Equal(1_784_000_000_000, photo.GetProperty("takenAt").GetInt64());
        Assert.Equal(300, photo.GetProperty("width").GetInt32());
        Assert.Equal("IMG 1.jpg", photo.GetProperty("file").GetProperty("name").GetString());
        var stored = await Served(server, photo.GetProperty("file"));
        Assert.NotEqual(original, stored);
        foreach (var secret in new[] { "SecretCam", "SN-12345", "59.3293", "secret owner", "secret comment" }) Assert.False(Has(stored, secret), secret);
        Assert.Equal(new PhotoMetadata.Kept(6, "2026:07:14 18:30:05", "+02:00"), PhotoMetadata.ReadExif(PhotoMetadata.JpegExif(stored)));
        // The upload with the metadata is gone from the server.
        Assert.DoesNotContain(Directory.EnumerateFiles(Path.Combine(server.WorldPath, "uploads"), "*", SearchOption.AllDirectories), f => Has(File.ReadAllBytes(f), "SecretCam"));

        var added = (await bob.EventAsync("photo.added")).Body();
        Assert.Equal(Id(photo), Id(added.GetProperty("photos")[0]));
        Assert.True(added.GetProperty("batch").GetProperty("first").GetBoolean());
        Assert.Equal(3, added.GetProperty("batch").GetProperty("total").GetInt32());
        Assert.Equal(1, added.GetProperty("usage").GetProperty("count").GetInt32());

        // Without the date: neither in the file nor in the list.
        var undated = await AddPhoto(server, alice, channel, "IMG_2.jpg", new { batch = "b1", keepDate = false });
        Assert.Equal(JsonValueKind.Null, undated.GetProperty("takenAt").ValueKind);
        Assert.False(Has(await Served(server, undated.GetProperty("file")), "2026:07:14"));
        Assert.False((await bob.EventAsync("photo.added")).Body().GetProperty("batch").GetProperty("first").GetBoolean());

        // A video is cleaned the same way.
        var video = await AddPhoto(server, bob, channel, "clip.mp4", content: Mp4());
        Assert.Equal("video", video.GetProperty("kind").GetString());
        var storedVideo = await Served(server, video.GetProperty("file"));
        Assert.False(Has(storedVideo, "59.3293"));
        Assert.False(Has(storedVideo, "GPSTWO"));
        Assert.True(Has(storedVideo, "VIDEODATA"));

        Assert.Equal([Id(photo), Id(undated), Id(video)], (await Listed(bob, channel)).Select(Id));
        var page = (await bob.RequestAsync("photo.list", new { channelId = channel, limit = 2 })).Body();
        Assert.True(page.GetProperty("hasMore").GetBoolean());
        Assert.Equal(Id(video), Id((await bob.RequestAsync("photo.list", new { channelId = channel, after = Id(undated) })).Body().GetProperty("photos")[0]));

        // The caption and the date belong to whoever added the photo.
        Assert.Equal("photo_change_owner", Key(await bob.RequestAsync("photo.update", new { id = Id(photo), caption = "mine" })));
        var edited = (await alice.RequestAsync("photo.update", new { id = Id(photo), caption = "  At the lake " })).Body().GetProperty("photo");
        Assert.Equal("At the lake", edited.GetProperty("caption").GetString());
        Assert.Equal("At the lake", (await bob.EventAsync("photo.updated")).Body().GetProperty("photo").GetProperty("caption").GetString());

        // Only what a photos channel takes, only your own unused uploads, only in photos channels.
        var (gif, gifThumb) = await Upload(server, alice, channel, [.. "GIF89a"u8, 1, 0, 1, 0, 0, 0, 0], "anim.gif");
        Assert.Equal("photo_type", Key(await alice.RequestAsync("photo.add", new { channelId = channel, items = new[] { new { file = gif, thumb = gifThumb } } })));
        var heic = Box("ftyp", "heic"u8.ToArray(), U32(0), "mif1"u8.ToArray());
        var (heicFile, heicThumb) = await Upload(server, alice, channel, heic, "IMG.heic");
        Assert.Equal("photo_type", Key(await alice.RequestAsync("photo.add", new { channelId = channel, items = new[] { new { file = heicFile, thumb = heicThumb } } })));
        var used = photo.GetProperty("file").GetProperty("id").GetString();
        Assert.Equal("photo_upload_unknown", Key(await bob.RequestAsync("photo.add", new { channelId = channel, items = new[] { new { file = used } } })));
        Assert.Equal("photo_upload_unknown", Key(await alice.RequestAsync("photo.add", new { channelId = channel, items = new[] { new { file = used } } })));
        Assert.Equal("bad_request", (await alice.RequestAsync("photo.list", new { channelId = server.General })).ErrorCode());
        Assert.Equal("cant_send_there", Key(await alice.RequestAsync("chat.send", new { channelId = channel, text = "hi" })));
    }

    [Fact]
    public async Task Reading_and_adding_follow_the_channels_access()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var member = await server.JoinAsync("Member");
        using var guest = await server.JoinAsync("Guest", "guest");
        var channel = await Channel(admin, "family", new { readRole = "member", writeRole = "trusted" });
        var photo = await AddPhoto(server, trusted, channel);

        Assert.Single(await Listed(member, channel));
        Assert.Equal("photos_write", Key(await member.RequestAsync("photo.upload.begin", new { channelId = channel, size = 10 })));
        Assert.Equal("photos_write", Key(await member.RequestAsync("photo.album.create", new { channelId = channel, name = "x" })));
        Assert.Equal("forbidden", (await member.RequestAsync("photo.react", new { id = Id(photo), emoji = "👍" })).ErrorCode());
        Assert.Equal("not_found", (await guest.RequestAsync("photo.list", new { channelId = channel })).ErrorCode());
        Assert.Equal("not_found", (await guest.RequestAsync("photo.info", new { channelId = channel })).ErrorCode());
        Assert.Equal("not_found", (await guest.RequestAsync("photo.delete", new { ids = new[] { Id(photo) } })).ErrorCode());
        Assert.Equal("not_found", (await guest.RequestAsync("photo.comments", new { id = Id(photo) })).ErrorCode());
        await guest.NoEventAsync("photo.added");
    }

    [Fact]
    public async Task Albums_hold_photos_and_deleting_is_for_the_owner_and_moderators()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var channel = await Channel(admin);

        var album = (await alice.RequestAsync("photo.album.create", new { channelId = channel, name = "  Summer 2026 " })).Body().GetProperty("album");
        Assert.Equal("Summer 2026", album.GetProperty("name").GetString());
        Assert.Equal(Id(album), Id((await bob.EventAsync("photo.album.updated")).Body().GetProperty("album")));
        Assert.Equal("photo_album_name", Key(await alice.RequestAsync("photo.album.create", new { channelId = channel, name = " " })));

        var inAlbum = await AddPhoto(server, alice, channel, "a.jpg", new { albumId = Id(album) });
        Assert.Equal(Id(album), inAlbum.GetProperty("albumId").GetInt64());
        var loose = await AddPhoto(server, alice, channel, "b.jpg");
        var bobs = await AddPhoto(server, bob, channel, "c.jpg");
        Assert.Equal("photo_album_gone", Key(await alice.RequestAsync("photo.add", new { channelId = channel, albumId = 999, items = new[] { new { file = "x" } } })));

        // Moving: your own photos; a moderator anyone's.
        Assert.Equal("photo_move_owner", Key(await bob.RequestAsync("photo.move", new { ids = new[] { Id(loose) }, albumId = Id(album) })));
        Assert.Equal("result", (await alice.RequestAsync("photo.move", new { ids = new[] { Id(loose) }, albumId = Id(album) })).Type());
        var moved = (await bob.EventAsync("photo.moved")).Body();
        Assert.Equal(Id(album), moved.GetProperty("albumId").GetInt64());
        Assert.Equal(2, moved.GetProperty("albums")[0].GetProperty("count").GetInt32());
        Assert.Equal("result", (await admin.RequestAsync("photo.move", new { ids = new[] { Id(bobs) }, albumId = Id(album) })).Type());

        // The cover is a photo of the album; renaming and the cover are for whoever made the album, or a moderator.
        Assert.Equal("photo_album_owner", Key(await bob.RequestAsync("photo.album.update", new { id = Id(album), name = "Mine" })));
        var renamed = (await alice.RequestAsync("photo.album.update", new { id = Id(album), name = "Summer", coverId = Id(loose) })).Body().GetProperty("album");
        Assert.Equal("Summer", renamed.GetProperty("name").GetString());
        Assert.Equal(Id(loose), renamed.GetProperty("coverId").GetInt64());
        var other = (await bob.RequestAsync("photo.album.create", new { channelId = channel, name = "Other" })).Body().GetProperty("album");
        Assert.Equal("photo_album_cover", Key(await bob.RequestAsync("photo.album.update", new { id = Id(other), coverId = Id(loose) })));

        // Deleting: your own; a moderator anyone's, and that is in the audit log. The files go with the photo.
        Assert.Equal("photo_delete_owner", Key(await bob.RequestAsync("photo.delete", new { ids = new[] { Id(inAlbum), Id(bobs) } })));
        Assert.Equal(3, (await Listed(bob, channel)).Count);
        var url = loose.GetProperty("file").GetProperty("url").GetString();
        Assert.Equal("result", (await alice.RequestAsync("photo.delete", new { ids = new[] { Id(loose) } })).Type());
        var deleted = (await bob.EventAsync("photo.deleted")).Body();
        Assert.Equal([Id(loose)], deleted.GetProperty("ids").EnumerateArray().Select(x => x.GetInt64()));
        Assert.Equal(2, deleted.GetProperty("usage").GetProperty("count").GetInt32());
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync(url)).StatusCode);
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("photo.info", new { channelId = channel })).Body().GetProperty("albums")[0].GetProperty("coverId").ValueKind);
        Assert.Equal("result", (await admin.RequestAsync("photo.delete", new { ids = new[] { Id(bobs) } })).Type());
        var audit = (await admin.RequestAsync("audit.list", new { action = "photo.delete" })).Body().GetProperty("entries").EnumerateArray().Single();
        Assert.Equal(bob.Key, audit.GetProperty("target").GetString());

        // Deleting an album leaves its photos in the channel.
        Assert.Equal("photo_album_delete_owner", Key(await bob.RequestAsync("photo.album.delete", new { id = Id(album) })));
        Assert.Equal("result", (await alice.RequestAsync("photo.album.delete", new { id = Id(album) })).Type());
        Assert.Equal(Id(album), (await bob.EventAsync("photo.album.deleted")).Body().GetProperty("id").GetInt64());
        var left = Assert.Single(await Listed(bob, channel));
        Assert.Equal(JsonValueKind.Null, left.GetProperty("albumId").ValueKind);
    }

    [Fact]
    public async Task The_storage_cap_is_set_by_admins_and_refuses_what_does_not_fit()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var channel = await Channel(admin);
        var first = await AddPhoto(server, alice, channel);
        var usage = (await alice.RequestAsync("photo.info", new { channelId = channel })).Body().GetProperty("usage");
        Assert.Equal(first.GetProperty("size").GetInt64(), usage.GetProperty("bytes").GetInt64());
        Assert.Equal(JsonValueKind.Null, usage.GetProperty("capBytes").ValueKind);

        Assert.Equal("manage_channels", Key(await alice.RequestAsync("photo.cap.set", new { channelId = channel, mb = 1 })));
        var capped = (await admin.RequestAsync("photo.cap.set", new { channelId = channel, mb = 1 })).Body().GetProperty("usage");
        Assert.Equal(1024 * 1024, capped.GetProperty("capBytes").GetInt64());
        Assert.Equal(1024 * 1024, (await alice.EventAsync("photo.usage")).Body().GetProperty("usage").GetProperty("capBytes").GetInt64());

        // Too big for what is left: refused before anything is uploaded.
        var refused = await alice.RequestAsync("photo.upload.begin", new { channelId = channel, name = "big.jpg", size = 2 * 1024 * 1024 });
        Assert.Equal("photos_full", Key(refused));
        Assert.Equal(1, refused.Body().GetProperty("args").GetProperty("mb").GetInt32());
        // And at photo.add, whatever the tickets said: the cap came down after the upload began.
        var (file, thumb) = await Upload(server, alice, channel, Jpeg(400, 300, null, 0x77), "late.jpg");
        server.World.Store.SetPhotoCap(channel, first.GetProperty("size").GetInt64() + 10);
        Assert.Equal("photos_full", Key(await alice.RequestAsync("photo.add", new { channelId = channel, items = new[] { new { file, thumb } } })));
        Assert.Single(await Listed(alice, channel));

        // No cap again.
        var open = (await admin.RequestAsync("photo.cap.set", JsonSerializer.Deserialize<JsonElement>($$"""{ "channelId": {{channel}}, "mb": null }"""))).Body();
        Assert.Equal(JsonValueKind.Null, open.GetProperty("usage").GetProperty("capBytes").ValueKind);
        Assert.Equal("result", (await alice.RequestAsync("photo.add", new { channelId = channel, items = new[] { new { file, thumb } } })).Type());
        Assert.Equal(2, (await admin.RequestAsync("audit.list", new { action = "photo.cap" })).Body().GetProperty("entries").GetArrayLength());
    }

    [Fact]
    public async Task An_album_downloads_as_a_zip_of_the_cleaned_originals()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var guest = await server.JoinAsync("Guest", "guest");
        var channel = await Channel(admin);
        var album = Id((await alice.RequestAsync("photo.album.create", new { channelId = channel, name = "Summer 2026" })).Body().GetProperty("album"));
        var one = await AddPhoto(server, alice, channel, "IMG.jpg", new { albumId = album });
        var two = await AddPhoto(server, alice, channel, "IMG.jpg", new { albumId = album });
        await AddPhoto(server, alice, channel, "loose.jpg");

        var link = (await alice.RequestAsync("photo.album.zip", new { channelId = channel, albumId = album })).Body();
        Assert.Equal(2, link.GetProperty("count").GetInt32());
        var http = server.CreateClient();
        using var response = await http.GetAsync(link.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/zip", response.Content.Headers.ContentType?.MediaType);
        Assert.Contains("Summer%202026.zip", response.Content.Headers.ContentDisposition?.ToString());
        using var zip = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()));
        Assert.Equal(["IMG.jpg", "IMG (2).jpg"], zip.Entries.Select(e => e.FullName));
        using var entry = new MemoryStream();
        zip.Entries[0].Open().CopyTo(entry);
        Assert.Equal(await Served(server, one.GetProperty("file")), entry.ToArray());
        Assert.False(Has(entry.ToArray(), "SecretCam"));

        // The whole channel, and the photos in no album.
        Assert.Equal(3, (await alice.RequestAsync("photo.album.zip", new { channelId = channel, all = true })).Body().GetProperty("count").GetInt32());
        Assert.Equal(1, (await alice.RequestAsync("photo.album.zip", new { channelId = channel })).Body().GetProperty("count").GetInt32());

        // A changed link, or one whose owner lost access, gives nothing.
        var url = link.GetProperty("url").GetString()!;
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync(url.Replace("album=" + album, "album=all"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.GetAsync(url.Replace(alice.Key, guest.Key))).StatusCode);
        Assert.Equal("not_found", (await guest.RequestAsync("photo.album.zip", new { channelId = channel, all = true })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("channel.update", new { id = channel, readRole = "admin", writeRole = "admin" })).Type());
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync(url)).StatusCode);
        _ = two;
    }

    [Fact]
    public async Task Photos_have_reactions_and_a_comment_thread()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var channel = await Channel(admin);
        var photo = await AddPhoto(server, alice, channel);
        await alice.RequestAsync("photo.update", new { id = Id(photo), caption = "The lake" });

        Assert.Equal("result", (await bob.RequestAsync("photo.react", new { id = Id(photo), emoji = "❤️" })).Type());
        Assert.Equal("result", (await alice.RequestAsync("photo.react", new { id = Id(photo), emoji = "❤️" })).Type());
        var reactions = (await alice.EventAsync("photo.reactions")).Body().GetProperty("reactions");
        Assert.Equal("❤️", reactions[0].GetProperty("emoji").GetString());
        await bob.RequestAsync("photo.react", new { id = Id(photo), emoji = "❤️", on = false });
        var listed = Assert.Single(await Listed(bob, channel));
        Assert.Equal([alice.Key], listed.GetProperty("reactions")[0].GetProperty("accounts").EnumerateArray().Select(a => a.GetString()));
        Assert.Equal("bad_request", (await bob.RequestAsync("photo.react", new { id = Id(photo), emoji = "not an emoji" })).ErrorCode());

        // The first comment makes the thread; it is the photo's from then on.
        Assert.Equal(JsonValueKind.Null, listed.GetProperty("threadId").ValueKind);
        var thread = (await bob.RequestAsync("photo.comments", new { id = Id(photo) })).Body().GetProperty("thread");
        Assert.Equal("The lake", thread.GetProperty("name").GetString());
        Assert.Equal(channel, thread.GetProperty("channelId").GetInt64());
        var threadId = thread.GetProperty("id").GetInt64();
        Assert.Equal(threadId, (await alice.RequestAsync("photo.comments", new { id = Id(photo) })).Body().GetProperty("thread").GetProperty("id").GetInt64());
        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = threadId, text = "Lovely!" })).Type());
        var commented = Assert.Single(await Listed(alice, channel));
        Assert.Equal(threadId, commented.GetProperty("threadId").GetInt64());
        Assert.Equal(1, commented.GetProperty("comments").GetInt32());
        Assert.Equal("photo_thread", Key(await bob.RequestAsync("thread.delete", new { id = threadId })));
        Assert.Equal("photo_thread", Key(await bob.RequestAsync("thread.update", new { id = threadId, name = "x" })));

        // Deleting the photo takes its comments along.
        Assert.Equal("result", (await alice.RequestAsync("photo.delete", new { ids = new[] { Id(photo) } })).Type());
        Assert.Equal(threadId, (await bob.EventAsync("thread.deleted")).Body().GetProperty("id").GetInt64());
        Assert.Equal("not_found", (await bob.RequestAsync("thread.get", new { id = threadId })).ErrorCode());
    }

    [Fact]
    public async Task A_batch_notifies_once_whoever_wants_every_message()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var dave = await server.JoinAsync("Dave");
        var channel = await Channel(admin);
        async Task<string> Subscribe(User user, string level, bool mute = false)
        {
            var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
            Assert.Equal("result", (await user.RequestAsync("push.subscribe", PushTests.Subscription(endpoint))).Type());
            Assert.Equal("result", (await user.RequestAsync("notify.set", new { level })).Type());
            if (mute) Assert.Equal("result", (await user.RequestAsync("notify.set", new { channelId = channel, muteMinutes = -1 })).Type());
            return endpoint;
        }
        var bobAt = await Subscribe(bob, "all");
        var carolAt = await Subscribe(carol, "mentions");
        var daveAt = await Subscribe(dave, "all", mute: true);
        var aliceAt = await Subscribe(alice, "all");

        await AddPhoto(server, alice, channel, "1.jpg", new { batch = "one", total = 12 });
        await AddPhoto(server, alice, channel, "2.jpg", new { batch = "one", total = 12 });
        await AddPhoto(server, alice, channel, "3.jpg", new { batch = "two", total = 1 }); // straight after: still the same burst
        var push = Assert.Single(await server.Push.WaitForAsync(bobAt));
        Assert.Equal("photos", push.GetProperty("kind").GetString());
        Assert.Equal(channel, push.GetProperty("channelId").GetInt64());
        Assert.Equal("Added 12 photos", push.GetProperty("body").GetString());
        Assert.Equal("photosAdded", push.GetProperty("text").GetProperty("body").GetString());
        await Task.Delay(200);
        Assert.Single(server.Push.SentTo(bobAt));
        Assert.Empty(server.Push.SentTo(carolAt));
        Assert.Empty(server.Push.SentTo(daveAt));
        Assert.Empty(server.Push.SentTo(aliceAt));

        server.Clock.Advance(PhotoFeature.NotifyEvery + TimeSpan.FromSeconds(20));
        await AddPhoto(server, alice, channel, "4.jpg", new { batch = "three" });
        Assert.Equal("Added a photo", (await server.Push.WaitForAsync(bobAt, 2))[1].GetProperty("body").GetString());
    }

    [Fact]
    public async Task Deleting_an_account_with_its_messages_takes_its_photos()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var channel = await Channel(admin);
        var album = Id((await alice.RequestAsync("photo.album.create", new { channelId = channel, name = "Hers" })).Body().GetProperty("album"));
        var photo = await AddPhoto(server, alice, channel, "a.jpg", new { albumId = album });
        var kept = await AddPhoto(server, admin, channel, "b.jpg", new { albumId = album });
        await alice.RequestAsync("photo.react", new { id = Id(kept), emoji = "👍" });
        await alice.RequestAsync("photo.album.update", new { id = album, coverId = Id(photo) });

        var export = (await alice.RequestAsync("data.export")).Body();
        _ = export;
        server.World.Store.DeleteAccount(new Storage.AccountDeletion(alice.Key, 1, true, ""), 2);
        var left = Assert.Single(await Listed(admin, channel));
        Assert.Equal(Id(kept), Id(left));
        Assert.Equal(0, left.GetProperty("reactions").GetArrayLength());
        var albums = (await admin.RequestAsync("photo.info", new { channelId = channel })).Body().GetProperty("albums");
        Assert.Equal("", albums[0].GetProperty("createdBy").GetString());
        Assert.Equal(JsonValueKind.Null, albums[0].GetProperty("coverId").ValueKind);
    }

    // ── End-to-end encrypted photos channels ────────────────────────────────────

    private static JsonObject Envelope(User from, string chain, long version, long channel, string what, string ct = "opaque") => new()
    {
        ["v"] = 1, ["kind"] = "photo",
        ["header"] = new JsonObject { ["from"] = from.Key, ["chain"] = chain, ["version"] = version, ["sentAt"] = 1, ["id"] = "e", ["channel"] = channel, ["what"] = what },
        ["nonce"] = "n", ["ct"] = ct, ["sig"] = "s",
    };

    [Fact]
    public async Task An_encrypted_photos_channel_holds_only_ciphertext_and_envelopes()
    {
        using var t = await E2eeChannelTests.CreateAsync("photos");
        var (server, owner, bob, dave, channel, chain) = (t.Server, t.Owner, t.Bob, t.Dave, t.ChannelId, t.Chain);

        // The files are ciphertext for the channel's members: never sniffed, never served from /files.
        var secret = Jpeg(400, 300, Tiff());
        var (file, thumb) = await Upload(server, bob, channel, secret, "IMG_1.jpg");
        Assert.Equal("not_found", (await dave.RequestAsync("photo.upload.begin", new { channelId = channel, size = 10 })).ErrorCode());

        // Plain items, wrong routing and old versions are refused.
        Assert.Equal("bad_request", (await bob.RequestAsync("photo.add", new { channelId = channel, version = 1, items = new[] { new { file, thumb, caption = "plain" } } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("photo.add", new { channelId = channel, version = 1, items = new[] { new { file, thumb, envelope = Envelope(owner, chain, 1, channel, "photo") } } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("photo.add", new { channelId = channel, version = 1, items = new[] { new { file, thumb, envelope = Envelope(bob, chain, 1, channel, "album") } } })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("photo.add", new { channelId = channel, version = 1, items = new[] { new { file, thumb, envelope = Envelope(bob, chain, 1, channel + 1, "photo") } } })).ErrorCode());
        Assert.Equal("conflict", (await bob.RequestAsync("photo.add", new { channelId = channel, version = 2, items = new[] { new { file, thumb, envelope = Envelope(bob, chain, 2, channel, "photo") } } })).ErrorCode());

        var added = await bob.RequestAsync("photo.add", new { channelId = channel, version = 1, items = new[] { new { file, thumb, envelope = Envelope(bob, chain, 1, channel, "photo", "sealed-photo") } } });
        Assert.Equal("result", added.Type());
        var photo = added.Body().GetProperty("photos")[0];
        Assert.Equal("sealed-photo", photo.GetProperty("e2ee").GetProperty("envelope").GetProperty("ct").GetString());
        Assert.Equal(JsonValueKind.Null, photo.GetProperty("file").ValueKind);
        Assert.Equal(JsonValueKind.Null, photo.GetProperty("kind").ValueKind);
        Assert.Equal("", photo.GetProperty("caption").GetString());
        Assert.Equal(Id(photo), Id((await owner.EventAsync("photo.added")).Body().GetProperty("photos")[0]));
        var http = server.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/files/{file}/photo")).StatusCode);

        // Members get links to the ciphertext; the bytes are exactly what the app uploaded (the server cleaned nothing).
        var links = (await owner.RequestAsync("photo.links", new { channelId = channel, ids = new[] { Id(photo) }, what = "file" })).Body().GetProperty("links");
        Assert.Equal(secret, await http.GetByteArrayAsync(links.GetProperty(Id(photo).ToString()).GetString()));
        Assert.Equal("not_found", (await dave.RequestAsync("photo.links", new { channelId = channel, ids = new[] { Id(photo) } })).ErrorCode());

        // Albums are envelopes too; the server can't zip what it can't read.
        Assert.Equal("bad_request", (await bob.RequestAsync("photo.album.create", new { channelId = channel, name = "Summer" })).ErrorCode());
        var album = (await bob.RequestAsync("photo.album.create", new { channelId = channel, version = 1, envelope = Envelope(bob, chain, 1, channel, "album", "sealed-name") })).Body().GetProperty("album");
        Assert.Equal("", album.GetProperty("name").GetString());
        Assert.Equal("sealed-name", album.GetProperty("e2ee").GetProperty("envelope").GetProperty("ct").GetString());
        Assert.Equal("result", (await bob.RequestAsync("photo.move", new { ids = new[] { Id(photo) }, albumId = Id(album) })).Type());
        Assert.Equal("photo_zip_encrypted", Key(await bob.RequestAsync("photo.album.zip", new { channelId = channel, albumId = Id(album) })));

        // A new caption is a new envelope from whoever added the photo.
        Assert.Equal("photo_change_owner", Key(await owner.RequestAsync("photo.update", new { id = Id(photo), version = 1, envelope = Envelope(owner, chain, 1, channel, "photo") })));
        var edited = (await bob.RequestAsync("photo.update", new { id = Id(photo), version = 1, envelope = Envelope(bob, chain, 1, channel, "photo", "sealed-again") })).Body().GetProperty("photo");
        Assert.Equal("sealed-again", edited.GetProperty("e2ee").GetProperty("envelope").GetProperty("ct").GetString());

        // Comments are a thread under the encrypted channel: nameless, and plain text is refused there.
        var thread = (await owner.RequestAsync("photo.comments", new { id = Id(photo) })).Body().GetProperty("thread");
        Assert.Equal(ThreadFeature.EncryptedThreadName, thread.GetProperty("name").GetString());
        Assert.Equal("e2ee_update_app", Key(await owner.RequestAsync("chat.send", new { channelId = thread.GetProperty("id").GetInt64(), text = "plain" })));

        // Deleting removes the ciphertext.
        Assert.Equal("result", (await bob.RequestAsync("photo.delete", new { ids = new[] { Id(photo) } })).Type());
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync(links.GetProperty(Id(photo).ToString()).GetString())).StatusCode);
    }
}
