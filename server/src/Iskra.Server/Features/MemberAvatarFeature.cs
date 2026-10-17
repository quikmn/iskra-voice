using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// A per-server avatar, next to the per-server nickname: a picture shown instead of the profile picture on this server
/// only (<c>Member.avatar</c> falls back to the profile's). Same rules as a profile picture (1 MB, 4096 px), checked by
/// its bytes and stored without metadata like the server's icon. Yours, or (admins) someone's ranked below you.
/// </summary>
public static class MemberAvatarFeature
{
    private static readonly string[] Types = ["image/png", "image/jpeg", "image/webp"];

    public static void Register(Router router) => router.Add("member.avatar", Set);

    private static object Set(Session s, Member me, Body body)
    {
        var key = body.OptionalString("accountKey", 64) ?? me.AccountKey;
        var target = key == me.AccountKey ? me : s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (target.AccountKey != me.AccountKey && !(Permissions.IsAdmin(me) && Permissions.Outranks(me, target)))
            throw RequestException.Forbidden("You can only change server pictures of members ranked below you.", "rank_avatars");
        var sent = body.OptionalString("file", 64) ?? throw RequestException.BadRequest("'file' is required.");

        var store = s.World.Store;
        var file = sent.Length == 0 ? null : Prepare(s, me, sent);
        if (file is null) store.ClearMemberAvatar(target.AccountKey);
        else store.SetMemberAvatar(target.AccountKey, file.Id, s.Now);
        if (file is not null && file.Id != sent) s.Uploads.DeleteIfUnused(sent); // the upload with its metadata
        if (target.AccountKey != me.AccountKey) Audit.Record(s, "member.avatar", target.AccountKey, details: new { removed = file is null });

        var member = s.Hub.PublicMember(target);
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        return new { member };
    }

    /// <summary>Checks an upload of yours by its bytes and returns the file to keep: a copy without metadata, or the upload itself.</summary>
    private static StoredFile Prepare(Session s, Member me, string fileId)
    {
        var store = s.World.Store;
        var file = store.GetFile(fileId);
        if (file is null || file.Uploader != me.AccountKey || store.GetDmFile(fileId) is not null) throw RequestException.BadRequest("Unknown avatar file.");
        if (file.Size > ProfileFeature.MaxAvatarBytes)
            throw RequestException.BadRequest($"Avatars can be up to {ProfileFeature.MaxAvatarBytes / 1024} KB.", "avatar_size", new { kb = ProfileFeature.MaxAvatarBytes / 1024 });
        var bytes = s.Uploads.ReadContent(file, ProfileFeature.MaxAvatarBytes)
            ?? throw RequestException.BadRequest($"Avatars can be up to {ProfileFeature.MaxAvatarBytes / 1024} KB.", "avatar_size", new { kb = ProfileFeature.MaxAvatarBytes / 1024 });
        var sniffed = FileSniffer.Sniff(bytes.AsSpan(0, Math.Min(bytes.Length, 64 * 1024)));
        if (!Types.Contains(sniffed.Type)) throw RequestException.BadRequest("Server pictures must be PNG, JPEG or WebP images.", "server_image_type");
        byte[] clean;
        try
        {
            clean = ImageMetadata.Strip(bytes, sniffed.Type);
        }
        catch (ImageMetadata.Refused refused) when (refused.Animated)
        {
            throw RequestException.BadRequest("Server pictures can't be animated.", "server_image_animated");
        }
        catch (ImageMetadata.Refused)
        {
            throw RequestException.BadRequest("Couldn't read that image's size.", "image_size_unreadable");
        }
        var (width, height) = sniffed.Type == "image/jpeg" ? JpegSize(clean) : (FileSniffer.Sniff(clean.AsSpan(0, Math.Min(clean.Length, 64 * 1024))) is var k ? (k.Width, k.Height) : (null, null));
        if (width is not { } w || height is not { } h || w < 1 || h < 1) throw RequestException.BadRequest("Couldn't read that image's size.", "image_size_unreadable");
        if (w > ProfileFeature.MaxAvatarSide || h > ProfileFeature.MaxAvatarSide) throw RequestException.BadRequest("That image is too large.", "image_too_large");
        var kept = s.Uploads.StoreCopy(file, clean, sniffed.Type, w, h);
        ProfileFeature.CheckAvatarImage(kept); // the profile picture's limits, on the clean copy
        return kept;
    }

    private static (int?, int?) JpegSize(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes, writable: false);
        return FileSniffer.JpegSize(stream);
    }
}
