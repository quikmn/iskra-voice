using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class StickerTests
{
    /// <summary>A PNG with the given size in its header (the server reads the size from there).</summary>
    private static byte[] Png(int width, int height)
    {
        var bytes = (byte[])EmojiTests.Png.Clone();
        bytes[16] = (byte)(width >> 24); bytes[17] = (byte)(width >> 16); bytes[18] = (byte)(width >> 8); bytes[19] = (byte)width;
        bytes[20] = (byte)(height >> 24); bytes[21] = (byte)(height >> 16); bytes[22] = (byte)(height >> 8); bytes[23] = (byte)height;
        return bytes;
    }

    private static async Task<JsonElement> AddSticker(IskraServer server, User user, string name, byte[]? image = null) =>
        await user.RequestAsync("sticker.create", new { name, fileId = await EmojiTests.Upload(server, user, image ?? Png(160, 160), "s.png") });

    [Fact]
    public async Task Admins_add_stickers_and_everyone_hears_about_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var created = await AddSticker(server, admin, "  Party time  ");
        Assert.Equal("result", created.Type());
        var sticker = created.Body().GetProperty("sticker");
        Assert.Equal("Party time", sticker.GetProperty("name").GetString());
        Assert.StartsWith("/files/", sticker.GetProperty("url").GetString());
        var updated = (await bob.EventAsync("stickers.updated")).Body().GetProperty("stickers");
        Assert.Equal(1, updated.GetArrayLength());
        Assert.Equal(1, (await bob.RequestAsync("sticker.list")).Body().GetProperty("stickers").GetArrayLength());

        var id = sticker.GetProperty("id").GetString();
        Assert.Equal("forbidden", (await bob.RequestAsync("sticker.rename", new { id, name = "mine" })).ErrorCode());
        Assert.Equal("forbidden", (await AddSticker(server, bob, "nope")).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("sticker.rename", new { id, name = "Party!" })).Type());
    }

    [Fact]
    public async Task Sticker_images_are_checked()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        Assert.Equal("bad_request", (await AddSticker(server, admin, "huge", Png(321, 100))).ErrorCode());
        Assert.Equal("bad_request", (await AddSticker(server, admin, "text", "not an image"u8.ToArray())).ErrorCode());
        Assert.Equal("bad_request", (await AddSticker(server, admin, "")).ErrorCode());
        Assert.Equal("bad_request", (await AddSticker(server, admin, new string('x', 31))).ErrorCode());
        using var other = await server.JoinAsync("Other", "admin");
        var someoneElses = await EmojiTests.Upload(server, other, Png(10, 10), "x.png");
        Assert.Equal("bad_request", (await admin.RequestAsync("sticker.create", new { name = "steal", fileId = someoneElses })).ErrorCode());
    }

    [Fact]
    public async Task A_sticker_is_a_message_of_its_own_and_survives_being_deleted_by_name()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");
        var id = (await AddSticker(server, admin, "wave")).Body().GetProperty("sticker").GetProperty("id").GetString();

        var sent = await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", sticker = id });
        Assert.Equal("result", sent.Type());
        var message = sent.Body().GetProperty("message");
        Assert.Equal("wave", message.GetProperty("sticker").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.String, message.GetProperty("sticker").GetProperty("url").ValueKind);
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.edit", new { id = message.GetProperty("id").GetInt64(), text = "x" })).ErrorCode());

        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "hi", sticker = id })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", sticker = "nope" })).ErrorCode());
        var file = await EmojiTests.Upload(server, bob, Png(10, 10), "a.png");
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "", attachments = new[] { file }, sticker = id })).ErrorCode());

        await admin.RequestAsync("sticker.delete", new { id });
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        var stale = history.EnumerateArray().Single(m => m.GetProperty("sticker").ValueKind == JsonValueKind.Object).GetProperty("sticker");
        Assert.Equal("wave", stale.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, stale.GetProperty("url").ValueKind);
    }
}
