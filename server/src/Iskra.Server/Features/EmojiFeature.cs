using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Server emoji: small images admins upload, used in messages and reactions as &lt;:name:id&gt;.
/// The image goes through the normal upload pipeline first; emoji.create then claims the file.
/// Members may also bring an emoji over from another server they're on (emoji.import): their app uploads the picture
/// here and it becomes an external emoji, usable like any other but not in the picker; the same bytes are stored once.
/// </summary>
public static partial class EmojiFeature
{
    public const int MaxEmojis = 200;
    /// <summary>External emoji kept per server; beyond that the oldest are forgotten.</summary>
    public const int MaxExternal = 300;
    public const int MaxSide = 128;
    private static readonly string[] Types = ["image/png", "image/gif", "image/webp"];

    [GeneratedRegex("^[a-z0-9_]{2,32}$")]
    private static partial Regex NamePattern();

    [GeneratedRegex("^<:([a-z0-9_]{2,32}):([A-Za-z0-9_-]{12})>$")]
    private static partial Regex TokenPattern();

    public static void Register(Router router)
    {
        router.Add("emoji.list", (s, _, _) => Lists(s.World.Store));
        router.Add("emoji.create", Create);
        router.Add("emoji.import", Import);
        router.Add("emoji.rename", Rename);
        router.Add("emoji.delete", Delete);
    }

    public static bool IsValidName(string? name) => name is not null && NamePattern().IsMatch(name);

    public static object Public(CustomEmoji e, StoredFile? file) => new
    {
        id = e.Id,
        name = e.Name,
        url = file is null ? null : Uploads.UrlOf(file),
        animated = file?.Type == "image/gif",
        createdBy = e.CreatedBy,
        external = e.External,
    };

    public static List<object> List(Store store) => store.AllEmojis().Select(e => Public(e, store.GetFile(e.FileId))).ToList();

    /// <summary>The server's own emoji (the picker) and the external ones (so apps can show them in messages and reactions).</summary>
    public static object Lists(Store store) =>
        new { emojis = List(store), external = store.AllExternalEmojis().Select(e => Public(e, store.GetFile(e.FileId))).ToList() };

    /// <summary>
    /// Checks a reaction: either a standard emoji (≤ 16 chars, no spaces) or &lt;:name:id&gt; for an emoji on this server,
    /// stored under its current name. Returns null when it isn't valid.
    /// </summary>
    public static string? Reaction(Store store, string raw)
    {
        var token = TokenPattern().Match(raw);
        if (token.Success)
            return store.GetEmoji(token.Groups[2].Value) is { } emoji ? $"<:{emoji.Name}:{emoji.Id}>" : null;
        var emojiText = Text.Normalize(raw, 16, allowNewlines: false);
        return emojiText is null || emojiText.Any(char.IsWhiteSpace) || emojiText.StartsWith("<:") ? null : emojiText;
    }

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageExpressions)) throw RequestException.Forbidden("You can't manage emoji on this server.", "manage_emoji");
    }

    private static string Name(Body body, Store store, string? exceptId = null)
    {
        var name = body.String("name", 64).Trim().ToLowerInvariant();
        if (!IsValidName(name)) throw RequestException.BadRequest("Emoji names are 2–32 characters: a–z, 0–9 and _.", "emoji_name");
        if (store.EmojiNameTaken(name, exceptId)) throw RequestException.BadRequest($"There's already an emoji called :{name}:.", "emoji_exists", new { name });
        return name;
    }

    /// <summary>Your own upload, the right kind and size for an emoji here.</summary>
    private static StoredFile CheckedImage(Session s, Member me, Body body)
    {
        var file = s.World.Store.GetFile(body.String("fileId", 64));
        if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown file.");
        if (!Types.Contains(file.Type)) throw RequestException.BadRequest("Emoji must be PNG, GIF or WebP images.", "emoji_type");
        var maxKb = s.World.Settings.Limits.EmojiMaxKb;
        if (maxKb > 0 && file.Size > maxKb * 1024L) throw RequestException.BadRequest($"Emoji can be up to {maxKb} KB on this server.", "emoji_kb", new { kb = maxKb });
        if (file.Width is not { } w || file.Height is not { } h || w < 1 || h < 1)
            throw RequestException.BadRequest("Couldn't read that image's size.", "image_size_unreadable");
        if (w > MaxSide || h > MaxSide) throw RequestException.BadRequest($"Emoji can be up to {MaxSide}×{MaxSide} pixels.", "emoji_pixels", new { side = MaxSide });
        return file;
    }

    private static object Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var name = Name(body, store);
        if (store.EmojiCount() >= MaxEmojis) throw RequestException.BadRequest($"This server already has {MaxEmojis} emoji.", "emoji_max", new { max = MaxEmojis });
        var file = CheckedImage(s, me, body);

        var emoji = new CustomEmoji(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)), name, file.Id, me.AccountKey, s.Now);
        store.AddEmoji(emoji);
        Audit.Record(s, "emoji.create", details: new { id = emoji.Id, name });
        Changed(s);
        return new { emoji = Public(emoji, file) };
    }

    /// <summary>
    /// An emoji from another server, as a member's app uploaded it here: the picture is checked like any emoji, and if
    /// this server already has the same bytes (its own emoji or an external one) that emoji is the answer, so nothing
    /// is stored twice. The server never fetches anything from the other server; the app brings the file.
    /// </summary>
    private static object Import(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.ExternalEmoji)) throw RequestException.Forbidden("You can't use emoji or stickers from other servers here.", "external_emoji");
        var store = s.World.Store;
        var name = body.String("name", 64).Trim().ToLowerInvariant();
        if (!IsValidName(name)) throw RequestException.BadRequest("Emoji names are 2–32 characters: a–z, 0–9 and _.", "emoji_name");
        var file = CheckedImage(s, me, body);
        if (store.EmojiWithBytes(file.Sha256) is { } same) return new { emoji = Public(same, store.GetFile(same.FileId)) };

        store.TrimExternalEmojis(MaxExternal - 1);
        var emoji = new CustomEmoji(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)), name, file.Id, me.AccountKey, s.Now, External: true);
        store.AddExternalEmoji(emoji, file.Sha256);
        Changed(s);
        return new { emoji = Public(emoji, file) };
    }

    private static object Rename(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var emoji = store.GetEmoji(body.String("id", 64)) is { External: false } own ? own : throw RequestException.NotFound("Emoji");
        var name = Name(body, store, emoji.Id);
        store.RenameEmoji(emoji.Id, name);
        Audit.Record(s, "emoji.rename", details: new { id = emoji.Id, from = emoji.Name, to = name });
        Changed(s);
        return new { emoji = Public(emoji with { Name = name }, store.GetFile(emoji.FileId)) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var emoji = s.World.Store.GetEmoji(body.String("id", 64)) ?? throw RequestException.NotFound("Emoji");
        if (emoji.External) s.World.Store.DeleteExternalEmoji(emoji.Id);
        else s.World.Store.DeleteEmoji(emoji.Id);
        Audit.Record(s, "emoji.delete", details: new { id = emoji.Id, name = emoji.Name, external = emoji.External });
        Changed(s);
        return null;
    }

    private static void Changed(Session s) => s.Hub.Broadcast(Frames.Event("emoji.updated", Lists(s.World.Store)));
}
