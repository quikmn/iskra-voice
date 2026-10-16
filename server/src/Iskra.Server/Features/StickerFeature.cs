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
/// Members may bring a sticker over from another server they're on (sticker.import): their app uploads the picture
/// here and it becomes an external sticker, sendable but not in the picker; the same bytes are stored once.
/// </summary>
public static class StickerFeature
{
    public const int MaxStickers = 60;
    /// <summary>External stickers kept per server; beyond that the oldest are forgotten.</summary>
    public const int MaxExternal = 100;
    public const int MaxSide = 320;
    public const int MaxNameLength = 30;
    private static readonly string[] Types = ["image/png", "image/gif", "image/webp"];

    public static void Register(Router router)
    {
        router.Add("sticker.list", (s, _, _) => new { stickers = List(s.World.Store) });
        router.Add("sticker.create", Create);
        router.Add("sticker.import", Import);
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
        external = sticker.External,
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
        if (attachments.Length > 0 || text.Length > 0) throw RequestException.BadRequest("A sticker is sent on its own.", "sticker_alone");
        return s.World.Store.GetSticker(id) ?? throw RequestException.BadRequest("Unknown sticker.");
    }

    private static string Name(Body body) =>
        Text.Normalize(body.String("name", MaxNameLength * 2), MaxNameLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Sticker names are 1–{MaxNameLength} characters.", "sticker_name", new { max = MaxNameLength });

    private static void RequireAdmin(Member me)
    {
        if (!BaseRoles.Allows(me, BaseAbility.Stickers)) throw RequestException.Forbidden("Only admins can manage stickers.", "admins_stickers");
    }

    /// <summary>Your own upload, the right kind and size for a sticker here.</summary>
    private static StoredFile CheckedImage(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var file = store.GetFile(body.String("fileId", 64));
        if (file is null || file.Uploader != me.AccountKey || store.GetDmFile(file.Id) is not null) throw RequestException.BadRequest("Unknown file.");
        if (!Types.Contains(file.Type)) throw RequestException.BadRequest("Stickers must be PNG, GIF or WebP images.", "sticker_type");
        var maxKb = s.World.Settings.Limits.StickerMaxKb;
        if (maxKb > 0 && file.Size > maxKb * 1024L) throw RequestException.BadRequest($"Stickers can be up to {maxKb} KB on this server.", "sticker_kb", new { kb = maxKb });
        if (file.Width is not { } w || file.Height is not { } h || w < 1 || h < 1)
            throw RequestException.BadRequest("Couldn't read that image's size.", "image_size_unreadable");
        if (w > MaxSide || h > MaxSide) throw RequestException.BadRequest($"Stickers can be up to {MaxSide}×{MaxSide} pixels.", "sticker_pixels", new { side = MaxSide });
        return file;
    }

    private static object Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var name = Name(body);
        if (store.StickerCount() >= MaxStickers) throw RequestException.BadRequest($"This server already has {MaxStickers} stickers.", "stickers_max", new { max = MaxStickers });
        var file = CheckedImage(s, me, body);

        var sticker = new Sticker(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)), name, file.Id, me.AccountKey, s.Now);
        store.AddSticker(sticker);
        Changed(s);
        return new { sticker = Public(sticker, file) };
    }

    /// <summary>
    /// A sticker from another server, as a member's app uploaded it here (see EmojiFeature.Import): checked like any
    /// sticker, the same bytes answered with the sticker already here. Nothing is announced: a sent sticker carries its url.
    /// </summary>
    private static object Import(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.ExternalEmoji)) throw RequestException.Forbidden("You can't use emoji or stickers from other servers here.", "external_emoji");
        var store = s.World.Store;
        var name = Name(body);
        var file = CheckedImage(s, me, body);
        if (store.StickerWithBytes(file.Sha256) is { } same) return new { sticker = Public(same, store.GetFile(same.FileId)) };

        store.TrimExternalStickers(MaxExternal - 1);
        var sticker = new Sticker(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)), name, file.Id, me.AccountKey, s.Now, External: true);
        store.AddExternalSticker(sticker, file.Sha256);
        return new { sticker = Public(sticker, file) };
    }

    private static object Rename(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var sticker = store.GetSticker(body.String("id", 64)) is { External: false } own ? own : throw RequestException.NotFound("Sticker");
        var name = Name(body);
        store.RenameSticker(sticker.Id, name);
        Changed(s);
        return new { sticker = Public(sticker with { Name = name }, store.GetFile(sticker.FileId)) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var sticker = s.World.Store.GetSticker(body.String("id", 64)) ?? throw RequestException.NotFound("Sticker");
        if (sticker.External) s.World.Store.DeleteExternalSticker(sticker.Id);
        else s.World.Store.DeleteSticker(sticker.Id);
        Changed(s);
        return null;
    }

    private static void Changed(Session s) => s.Hub.Broadcast(Frames.Event("stickers.updated", new { stickers = List(s.World.Store) }));
}
