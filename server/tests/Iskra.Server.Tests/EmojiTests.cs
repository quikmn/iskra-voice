using System.Net;
using System.Text;
using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class EmojiTests
{
    // A real 3×2 PNG.
    internal static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=");

    /// <summary>The start of a PNG with the given size (enough for the sniffer).</summary>
    private static byte[] PngHeader(int width, int height)
    {
        var bytes = (byte[])Png.Clone();
        bytes[16] = (byte)(width >> 24); bytes[17] = (byte)(width >> 16); bytes[18] = (byte)(width >> 8); bytes[19] = (byte)width;
        bytes[20] = (byte)(height >> 24); bytes[21] = (byte)(height >> 16); bytes[22] = (byte)(height >> 8); bytes[23] = (byte)height;
        return bytes;
    }

    internal static async Task<string> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
    }

    private static async Task<JsonElement> AddEmoji(IskraServer server, User user, string name, byte[]? image = null) =>
        await user.RequestAsync("emoji.create", new { name, fileId = await Upload(server, user, image ?? Png, name + ".png") });

    [Theory]
    [InlineData("ok", true)]
    [InlineData("party_parrot_2", true)]
    [InlineData("a", false)]
    [InlineData("Caps", false)]
    [InlineData("with-dash", false)]
    [InlineData("with space", false)]
    [InlineData("ünï", false)]
    [InlineData("abcdefghijklmnopqrstuvwxyz012345", true)]
    [InlineData("abcdefghijklmnopqrstuvwxyz0123456", false)]
    public void Emoji_names(string name, bool valid) => Assert.Equal(valid, EmojiFeature.IsValidName(name));

    [Fact]
    public void Webp_sizes_are_read()
    {
        var lossless = new byte[32];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(lossless, 0);
        Encoding.ASCII.GetBytes("WEBPVP8L").CopyTo(lossless, 8);
        lossless[20] = 0x2F;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(lossless.AsSpan(21), (64 - 1) | ((uint)(100 - 1) << 14));
        var kind = Files.FileSniffer.Sniff(lossless);
        Assert.Equal(("image/webp", 64, 100), (kind.Type, kind.Width, kind.Height));

        var extended = new byte[32];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(extended, 0);
        Encoding.ASCII.GetBytes("WEBPVP8X").CopyTo(extended, 8);
        extended[24] = 127; extended[27] = 199; // 128 × 200
        kind = Files.FileSniffer.Sniff(extended);
        Assert.Equal((128, 200), (kind.Width, kind.Height));
    }

    [Fact]
    public async Task Admins_add_emoji_and_everyone_hears_about_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        var created = await AddEmoji(server, admin, "Blob_Wave");
        var emoji = created.Body().GetProperty("emoji");
        Assert.Equal("blob_wave", emoji.GetProperty("name").GetString()); // names are lowercased
        Assert.Equal(12, emoji.GetProperty("id").GetString()!.Length);
        Assert.StartsWith("/files/", emoji.GetProperty("url").GetString());
        Assert.False(emoji.GetProperty("animated").GetBoolean());

        var update = (await bob.EventAsync("emoji.updated")).Body().GetProperty("emojis");
        Assert.Equal("blob_wave", update[0].GetProperty("name").GetString());
        Assert.Equal("blob_wave", (await bob.RequestAsync("emoji.list")).Body().GetProperty("emojis")[0].GetProperty("name").GetString());

        // Rename and delete.
        var id = emoji.GetProperty("id").GetString();
        Assert.Equal("wave", (await admin.RequestAsync("emoji.rename", new { id, name = "wave" })).Body().GetProperty("emoji").GetProperty("name").GetString());
        Assert.Equal("result", (await admin.RequestAsync("emoji.delete", new { id })).Type());
        Assert.Equal(0, (await bob.RequestAsync("emoji.list")).Body().GetProperty("emojis").GetArrayLength());
    }

    [Fact]
    public async Task Only_admins_manage_emoji()
    {
        using var server = new IskraServer();
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var admin = await server.JoinAsync("Admin", "admin");
        Assert.Equal("forbidden", (await AddEmoji(server, trusted, "nope")).ErrorCode());
        var id = (await AddEmoji(server, admin, "mine")).Body().GetProperty("emoji").GetProperty("id").GetString();
        Assert.Equal("forbidden", (await trusted.RequestAsync("emoji.rename", new { id, name = "theirs" })).ErrorCode());
        Assert.Equal("forbidden", (await trusted.RequestAsync("emoji.delete", new { id })).ErrorCode());
    }

    [Fact]
    public async Task Emoji_files_are_checked()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var other = await server.JoinAsync("Other", "admin");

        Assert.Equal("bad_request", (await AddEmoji(server, admin, "bad name")).ErrorCode());
        Assert.Equal("bad_request", (await AddEmoji(server, admin, "big", PngHeader(129, 64))).ErrorCode());
        Assert.Equal("result", (await AddEmoji(server, admin, "edge", PngHeader(128, 128))).Type());
        Assert.Equal("bad_request", (await AddEmoji(server, admin, "html", Encoding.UTF8.GetBytes("<svg onload=alert(1)>"))).ErrorCode());
        server.World.UpdateSettings(s => s with { Limits = s.Limits with { EmojiMaxKb = 256 } });
        var heavy = new byte[256 * 1024 + 1];
        Png.CopyTo(heavy, 0);
        Assert.Equal("bad_request", (await AddEmoji(server, admin, "heavy", heavy)).ErrorCode());

        // Names are unique, and you can only claim your own uploads.
        Assert.Equal("bad_request", (await AddEmoji(server, admin, "edge")).ErrorCode());
        var theirs = await Upload(server, other, Png, "x.png");
        Assert.Equal("bad_request", (await admin.RequestAsync("emoji.create", new { name = "stolen", fileId = theirs })).ErrorCode());
    }

    [Fact]
    public async Task There_is_a_limit_per_server()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var fileId = await Upload(server, admin, Png, "e.png");
        for (var i = 0; i < EmojiFeature.MaxEmojis; i++)
            server.World.Store.AddEmoji(new Storage.CustomEmoji($"id{i:D10}", $"e{i}", fileId, admin.Key, 0));
        Assert.Equal("bad_request", (await admin.RequestAsync("emoji.create", new { name = "onemore", fileId })).ErrorCode());
    }

    [Fact]
    public async Task Custom_emoji_work_as_reactions()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var id = (await AddEmoji(server, admin, "blob")).Body().GetProperty("emoji").GetProperty("id").GetString();
        var message = (await bob.RequestAsync("chat.send", new { channelId = server.General, text = $"hi <:blob:{id}>" })).Body().GetProperty("message").GetProperty("id").GetInt64();

        // A stale name is stored under the current one.
        Assert.Equal("result", (await bob.RequestAsync("chat.react", new { id = message, emoji = $"<:oldname:{id}>" })).Type());
        var reactions = (await bob.EventAsync("chat.reactions")).Body().GetProperty("reactions");
        Assert.Equal($"<:blob:{id}>", reactions[0].GetProperty("emoji").GetString());

        Assert.Equal("bad_request", (await bob.RequestAsync("chat.react", new { id = message, emoji = "<:blob:AAAAAAAAAAAA>" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.react", new { id = message, emoji = "<:x>" })).ErrorCode());
        Assert.Equal("result", (await bob.RequestAsync("chat.react", new { id = message, emoji = "🔥" })).Type());
    }

    // ── Emoji from other servers ─────────────────────────────────────────────

    private static async Task<JsonElement> Import(IskraServer server, User user, string name, byte[] image) =>
        await user.RequestAsync("emoji.import", new { name, fileId = await Upload(server, user, image, name + ".png") });

    [Fact]
    public async Task Members_bring_emoji_over_from_other_servers_and_the_same_bytes_are_kept_once()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var other = PngHeader(3, 2);
        other[^1] ^= 1; // different bytes from Png

        var imported = (await Import(server, bob, "wave", other)).Body().GetProperty("emoji");
        Assert.True(imported.GetProperty("external").GetBoolean());
        Assert.Equal("wave", imported.GetProperty("name").GetString());
        var id = imported.GetProperty("id").GetString()!;
        // Everyone learns about it so messages render, but it isn't in the picker's list.
        var updated = (await carol.EventAsync("emoji.updated")).Body();
        Assert.Empty(updated.GetProperty("emojis").EnumerateArray());
        Assert.Equal(id, updated.GetProperty("external")[0].GetProperty("id").GetString());
        var lists = (await carol.RequestAsync("emoji.list")).Body();
        Assert.Empty(lists.GetProperty("emojis").EnumerateArray());
        Assert.Single(lists.GetProperty("external").EnumerateArray());

        // The same picture again (any name, anyone): the emoji already here, nothing new.
        var again = (await Import(server, carol, "hello", other)).Body().GetProperty("emoji");
        Assert.Equal(id, again.GetProperty("id").GetString());
        Assert.Equal(1, server.World.Store.ExternalEmojiCount());
        // A picture that is already one of the server's own emoji answers with that one.
        var own = (await AddEmoji(server, admin, "blob")).Body().GetProperty("emoji").GetProperty("id").GetString();
        await carol.EventAsync("emoji.updated");
        Assert.Equal(own, (await Import(server, bob, "blob_copy", Png)).Body().GetProperty("emoji").GetProperty("id").GetString());

        // Usable in messages and reactions like any emoji; admins can't rename it but can delete it.
        var message = (await carol.RequestAsync("chat.send", new { channelId = server.General, text = $"<:wave:{id}>" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("result", (await carol.RequestAsync("chat.react", new { id = message, emoji = $"<:wave:{id}>" })).Type());
        Assert.Equal("not_found", (await admin.RequestAsync("emoji.rename", new { id, name = "renamed" })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("emoji.delete", new { id })).Type());
        Assert.Equal(0, server.World.Store.ExternalEmojiCount());
    }

    [Fact]
    public async Task Importing_needs_the_ability_and_keeps_only_the_newest()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        using var guest = await server.JoinAsync("Guest", "guest");
        Assert.Equal("forbidden", (await Import(server, guest, "nope", Png)).ErrorCode());
        Assert.Equal("bad_request", (await Import(server, bob, "Bad Name", Png)).ErrorCode());
        Assert.Equal("bad_request", (await Import(server, bob, "big", PngHeader(129, 10))).ErrorCode());

        // Members can lose the ability.
        Assert.Equal("result", (await owner.RequestAsync("role.base.update", new { role = "member", abilities = new[] { "invite", "events", "whisper" } })).Type());
        Assert.Equal("forbidden", (await Import(server, bob, "wave", Png)).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("role.base.update", new { role = "member", reset = true })).Type());

        // Beyond the cap the oldest go.
        var fileId = await Upload(server, bob, Png, "e.png");
        for (var i = 0; i < EmojiFeature.MaxExternal; i++)
            server.World.Store.AddExternalEmoji(new Storage.CustomEmoji($"ext{i:D9}", $"e{i}", fileId, bob.Key, i, External: true), $"hash{i}");
        var fresh = PngHeader(3, 2);
        fresh[^1] ^= 2;
        Assert.Equal("result", (await Import(server, bob, "newest", fresh)).Type());
        Assert.Equal(EmojiFeature.MaxExternal, server.World.Store.ExternalEmojiCount());
        Assert.Null(server.World.Store.GetEmoji("ext000000000"));
        Assert.NotNull(server.World.Store.GetEmoji("ext000000001"));
    }
}
