using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Server stickers: bigger images than emoji that admins upload, sent on their own as a message (chat.send with
/// <c>sticker</c>). Like emoji, the image goes through the normal upload first; sticker.create claims the file.
/// </summary>
public static class StickerFeature
{
    public const int MaxStickers = 60;
    public const int MaxSide = 320;
    public const int MaxNameLength = 30;
    private static readonly string[] Types = ["image/png", "image/gif", "image/webp"];

    public static void Register(Router router)
    {
        router.Add("sticker.list", (s, _, _) => new { stickers = List(s.World.Store) });
        router.Add("sticker.create", Create);
        router.Add("sticker.rename", Rename);
        router.Add("sticker.delete", Delete);
    }

    public static object Public(Sticker sticker, StoredFile? file) => new
    {
        id = sticker.Id,
        name = sticker.Name,
        url = file is null ? null : Uploads.UrlOf(file),
        animated = file?.Type == "image/gif",
        createdBy = sticker.CreatedBy,
    };

    public static List<object> List(Store store) => store.AllStickers().Select(s => Public(s, store.GetFile(s.FileId))).ToList();

    /// <summary>The <c>sticker</c> of a message as everyone sees it (url null once the sticker was deleted).</summary>
    public static object? View(Store store, long messageId)
    {
        if (store.GetMessageSticker(messageId) is not { } sent) return null;
        var sticker = store.GetSticker(sent.StickerId);
        var file = sticker is null ? null : store.GetFile(sticker.FileId);
        return new { id = sent.StickerId, name = sent.Name, url = file is null ? null : Uploads.UrlOf(file), animated = file?.Type == "image/gif" };
    }

    /// <summary>chat.send's optional <c>sticker</c> (an id on this server). A sticker message has no text or attachments.</summary>
    public static Sticker? Parse(Session s, Body body, string[] attachments, string text)
    {
        var id = body.OptionalString("sticker", 64);
        if (id is null) return null;
        if (attachments.Length > 0 || text.Length > 0) throw RequestException.BadRequest("A sticker is sent on its own.");
        return s.World.Store.GetSticker(id) ?? throw RequestException.BadRequest("Unknown sticker.");
    }

    private static string Name(Body body) =>
        Text.Normalize(body.String("name", MaxNameLength * 2), MaxNameLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Sticker names are 1–{MaxNameLength} characters.");

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can manage stickers.");
    }

    private static object Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var name = Name(body);
        if (store.StickerCount() >= MaxStickers) throw RequestException.BadRequest($"This server already has {MaxStickers} stickers.");
        var file = store.GetFile(body.String("fileId", 64));
        if (file is null || file.Uploader != me.AccountKey || store.GetDmFile(file.Id) is not null) throw RequestException.BadRequest("Unknown file.");
        if (!Types.Contains(file.Type)) throw RequestException.BadRequest("Stickers must be PNG, GIF or WebP images.");
        var maxKb = s.World.Settings.Limits.StickerMaxKb;
        if (maxKb > 0 && file.Size > maxKb * 1024L) throw RequestException.BadRequest($"Stickers can be up to {maxKb} KB on this server.");
        if (file.Width is not { } w || file.Height is not { } h || w < 1 || h < 1)
            throw RequestException.BadRequest("Couldn't read that image's size.");
        if (w > MaxSide || h > MaxSide) throw RequestException.BadRequest($"Stickers can be up to {MaxSide}×{MaxSide} pixels.");

        var sticker = new Sticker(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)), name, file.Id, me.AccountKey, s.Now);
        store.AddSticker(sticker);
        Changed(s);
        return new { sticker = Public(sticker, file) };
    }

    private static object Rename(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var sticker = store.GetSticker(body.String("id", 64)) ?? throw RequestException.NotFound("Sticker");
        var name = Name(body);
        store.RenameSticker(sticker.Id, name);
        Changed(s);
        return new { sticker = Public(sticker with { Name = name }, store.GetFile(sticker.FileId)) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var sticker = s.World.Store.GetSticker(body.String("id", 64)) ?? throw RequestException.NotFound("Sticker");
        s.World.Store.DeleteSticker(sticker.Id);
        Changed(s);
        return null;
    }

    private static void Changed(Session s) => s.Hub.Broadcast(Frames.Event("stickers.updated", new { stickers = List(s.World.Store) }));
}
