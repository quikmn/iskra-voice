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
/// </summary>
public static partial class EmojiFeature
{
    public const int MaxEmojis = 200;
    public const int MaxBytes = 256 * 1024;
    public const int MaxSide = 128;
    private static readonly string[] Types = ["image/png", "image/gif", "image/webp"];

    [GeneratedRegex("^[a-z0-9_]{2,32}$")]
    private static partial Regex NamePattern();

    [GeneratedRegex("^<:([a-z0-9_]{2,32}):([A-Za-z0-9_-]{12})>$")]
    private static partial Regex TokenPattern();

    public static void Register(Router router)
    {
        router.Add("emoji.list", (s, _, _) => new { emojis = List(s.World.Store) });
        router.Add("emoji.create", Create);
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
    };

    public static List<object> List(Store store) => store.AllEmojis().Select(e => Public(e, store.GetFile(e.FileId))).ToList();

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
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can manage emoji.");
    }

    private static string Name(Body body, Store store, string? exceptId = null)
    {
        var name = body.String("name", 64).Trim().ToLowerInvariant();
        if (!IsValidName(name)) throw RequestException.BadRequest("Emoji names are 2–32 characters: a–z, 0–9 and _.");
        if (store.EmojiNameTaken(name, exceptId)) throw RequestException.BadRequest($"There's already an emoji called :{name}:.");
        return name;
    }

    private static object Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var name = Name(body, store);
        if (store.EmojiCount() >= MaxEmojis) throw RequestException.BadRequest($"This server already has {MaxEmojis} emoji.");

        var file = store.GetFile(body.String("fileId", 64));
        if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown file.");
        if (!Types.Contains(file.Type)) throw RequestException.BadRequest("Emoji must be PNG, GIF or WebP images.");
        if (file.Size > MaxBytes) throw RequestException.BadRequest($"Emoji can be up to {MaxBytes / 1024} KB.");
        if (file.Width is not { } w || file.Height is not { } h || w < 1 || h < 1)
            throw RequestException.BadRequest("Couldn't read that image's size.");
        if (w > MaxSide || h > MaxSide) throw RequestException.BadRequest($"Emoji can be up to {MaxSide}×{MaxSide} pixels.");

        var emoji = new CustomEmoji(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)), name, file.Id, me.AccountKey, s.Now);
        store.AddEmoji(emoji);
        Changed(s);
        return new { emoji = Public(emoji, file) };
    }

    private static object Rename(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var emoji = store.GetEmoji(body.String("id", 64)) ?? throw RequestException.NotFound("Emoji");
        var name = Name(body, store, emoji.Id);
        store.RenameEmoji(emoji.Id, name);
        Changed(s);
        return new { emoji = Public(emoji with { Name = name }, store.GetFile(emoji.FileId)) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var emoji = s.World.Store.GetEmoji(body.String("id", 64)) ?? throw RequestException.NotFound("Emoji");
        s.World.Store.DeleteEmoji(emoji.Id);
        Changed(s);
        return null;
    }

    private static void Changed(Session s) => s.Hub.Broadcast(Frames.Event("emoji.updated", new { emojis = List(s.World.Store) }));
}
