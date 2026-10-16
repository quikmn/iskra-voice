using System.Text;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>A picture per server, next to the nickname: shown instead of the profile picture there, stripped of metadata.</summary>
public class MemberAvatarTests
{
    private static byte[] Png(int side) => ServerImageTests.Png(side, side, PngText("Comment", "taken at home"));

    private static byte[] PngText(string keyword, string text)
    {
        var data = Encoding.Latin1.GetBytes(keyword + "\0" + text);
        var bytes = new byte[12 + data.Length];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)data.Length);
        Encoding.ASCII.GetBytes("tEXt").CopyTo(bytes, 4);
        data.CopyTo(bytes, 8);
        var crc = Crc32([.. "tEXt"u8, .. data]);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(8 + data.Length), crc);
        return bytes;
    }

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

    [Fact]
    public async Task A_server_picture_replaces_the_profile_picture_here_only_and_loses_its_metadata()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var sam = await server.JoinAsync("Sam");
        using var watcher = await server.JoinAsync("Watcher");

        // Sam's profile picture, then a picture for this server on top of it.
        var profilePicture = await EmojiTests.Upload(server, sam, Png(64), "me.png");
        Assert.Equal("result", (await sam.RequestAsync("profile.update", new { avatar = profilePicture })).Type());
        await watcher.EventAsync("member.updated"); // the profile picture
        var upload = await EmojiTests.Upload(server, sam, Png(200), "here.png");
        var set = await sam.RequestAsync("member.avatar", new { file = upload });
        Assert.Equal("result", set.Type());
        var member = set.Body().GetProperty("member");
        var shown = member.GetProperty("avatar").GetString()!;
        Assert.Equal(shown, member.GetProperty("serverAvatar").GetString());
        Assert.DoesNotContain(profilePicture, shown);
        Assert.Equal(shown, (await watcher.EventAsync("member.updated")).Body().GetProperty("member").GetProperty("avatar").GetString());

        // The kept file is a clean copy: the upload with its text chunk is gone, the copy has none.
        var kept = server.World.Store.GetMemberAvatar(sam.Key)!;
        Assert.NotEqual(upload, kept.Id);
        Assert.Null(server.World.Store.GetFile(upload));
        var bytes = await File.ReadAllBytesAsync(server.Services.GetService(typeof(Iskra.Server.Files.Uploads)) is Iskra.Server.Files.Uploads u ? u.PathFor(kept.Sha256) : "");
        Assert.DoesNotContain("taken at home", Encoding.Latin1.GetString(bytes));
        Assert.Equal(200, kept.Width);

        // Everyone's list shows it too; the profile picture is untouched underneath.
        var listed = (await watcher.RequestAsync("ping")).Type(); // any request keeps the session warm
        Assert.Equal("result", listed);
        using var fresh = await server.JoinAsync("Fresh");
        var samInList = fresh.Welcome.Body().GetProperty("members").EnumerateArray().Single(m => m.GetProperty("accountKey").GetString() == sam.Key);
        Assert.Equal(shown, samInList.GetProperty("avatar").GetString());
        Assert.Contains(profilePicture, server.World.Store.GetPublicProfile(sam.Key).Avatar!.Id);

        // Removing it brings the profile picture back; leaving drops it.
        var removed = (await sam.RequestAsync("member.avatar", new { file = "" })).Body().GetProperty("member");
        Assert.Contains(profilePicture, removed.GetProperty("avatar").GetString());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, removed.GetProperty("serverAvatar").ValueKind);
        Assert.Equal("result", (await sam.RequestAsync("member.avatar", new { file = await EmojiTests.Upload(server, sam, Png(100), "again.png") })).Type());
        Assert.NotNull(server.World.Store.GetMemberAvatar(sam.Key));
        await owner.RequestAsync("member.kick", new { accountKey = sam.Key });
        Assert.Null(server.World.Store.GetMemberAvatar(sam.Key));
    }

    [Fact]
    public async Task Only_you_or_an_admin_above_you_change_it_and_only_real_still_pictures_are_taken()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var sam = await server.JoinAsync("Sam");
        using var other = await server.JoinAsync("Other");

        Assert.Equal("bad_request", (await sam.RequestAsync("member.avatar", new { })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("member.avatar", new { file = "nope" })).ErrorCode());
        // Someone else's upload, and a file that isn't a picture.
        var theirs = await EmojiTests.Upload(server, other, Png(64), "theirs.png");
        Assert.Equal("bad_request", (await sam.RequestAsync("member.avatar", new { file = theirs })).ErrorCode());
        var text = await EmojiTests.Upload(server, sam, Encoding.UTF8.GetBytes("not a picture"), "note.txt");
        var refused = await sam.RequestAsync("member.avatar", new { file = text });
        Assert.Equal("bad_request", refused.ErrorCode());
        Assert.Equal("server_image_type", refused.Body().GetProperty("key").GetString());
        // Too big a picture for an avatar.
        var huge = await EmojiTests.Upload(server, sam, ServerImageTests.Png(5000, 5000), "huge.png");
        Assert.Equal("image_too_large", (await sam.RequestAsync("member.avatar", new { file = huge })).Body().GetProperty("key").GetString());

        // Other members can't touch yours; admins above you can, and it's audited.
        var mine = await EmojiTests.Upload(server, other, Png(64), "for-sam.png");
        var rank = await other.RequestAsync("member.avatar", new { accountKey = sam.Key, file = mine });
        Assert.Equal("forbidden", rank.ErrorCode());
        Assert.Equal("rank_avatars", rank.Body().GetProperty("key").GetString());
        var byOwner = await EmojiTests.Upload(server, owner, Png(64), "by-owner.png");
        Assert.Equal("result", (await owner.RequestAsync("member.avatar", new { accountKey = sam.Key, file = byOwner })).Type());
        Assert.NotNull(server.World.Store.GetMemberAvatar(sam.Key));
        Assert.Equal("result", (await owner.RequestAsync("member.avatar", new { accountKey = sam.Key, file = "" })).Type());
        var entries = (await owner.RequestAsync("audit.list", new { action = "member.avatar" })).Body().GetProperty("entries");
        Assert.Equal(2, entries.GetArrayLength());
        Assert.Equal("Sam", entries[0].GetProperty("targetName").GetString());
        Assert.Equal("forbidden", (await sam.RequestAsync("member.avatar", new { accountKey = owner.Key, file = "" })).ErrorCode());
    }
}
