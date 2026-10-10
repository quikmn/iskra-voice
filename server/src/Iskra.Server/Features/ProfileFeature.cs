using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Profiles: bio, pronouns, accent colour, avatar, and an optional personal page.
/// Clients keep the profile locally and send it to every server they're on, so one edit updates them all.
/// </summary>
public static partial class ProfileFeature
{
    public const int MaxBioLength = 190;
    public const int MaxPronounsLength = 40;
    public const long MaxAvatarBytes = 1024 * 1024;
    public const int MaxAvatarSide = 4096;
    public const long MaxPageBytes = 512 * 1024;

    private static readonly string[] AvatarTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

    /// <summary>Avatars (members' and webhooks'): a supported image of known size, at most 1 MB and 4096 px a side.</summary>
    public static void CheckAvatarImage(StoredFile file)
    {
        if (!AvatarTypes.Contains(file.Type)) throw RequestException.BadRequest("Avatars must be PNG, JPEG, WebP or GIF images.");
        if (file.Size > MaxAvatarBytes) throw RequestException.BadRequest($"Avatars can be up to {MaxAvatarBytes / 1024} KB.");
        if (file.Width is not { } w || file.Height is not { } h || w < 1 || h < 1) throw RequestException.BadRequest("Couldn't read that image's size.");
        if (w > MaxAvatarSide || h > MaxAvatarSide) throw RequestException.BadRequest("That image is too large.");
    }

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex AccentPattern();

    public static void Register(Router router)
    {
        router.Add("profile.update", Update);
        router.Add("profile.page.set", SetPage);
        router.Add("profile.page.remove", RemovePage);
        router.Add("profile.pages.configure", ConfigurePages);
    }

    // ── Public view ──────────────────────────────────────────────────────────

    public static bool PagesEnabled(Store store) => store.GetProfileOption("pages") != "off";

    /// <summary>The member as everyone sees it, profile included.</summary>
    public static object Public(Store store, Member m, bool online)
    {
        var p = store.GetPublicProfile(m.AccountKey);
        var page = p.PageId is not null && PagesEnabled(store);
        return new
        {
            accountKey = m.AccountKey,
            name = m.Name,
            role = m.Role,
            online,
            bot = store.IsBot(m.AccountKey),
            avatar = p.Avatar is { } a ? $"/files/{a.Id}/{Uri.EscapeDataString(a.Name)}" : null,
            avatarHash = p.Avatar?.Sha256,
            bio = p.Bio,
            pronouns = p.Pronouns,
            accent = p.Accent,
            page = page ? $"/pages/{p.PageId}" : null,
            pageHash = page ? p.PageSha256 : null,
            timedOutUntil = store.GetTimeout(m.AccountKey)?.Until,
            roles = m.RoleIds,
        };
    }

    private static void BroadcastMember(Session s, string accountKey)
    {
        var member = s.World.Store.GetMember(accountKey);
        if (member is not null) s.Hub.Broadcast(Frames.Event("member.updated", new { member = s.Hub.PublicMember(member) }));
    }

    // ── Fields ───────────────────────────────────────────────────────────────

    /// <summary>"" clears; otherwise 1–190 characters, newlines allowed.</summary>
    private static string? Bio(string? raw) =>
        raw is null ? null
        : raw.Trim().Length == 0 ? ""
        : Text.Normalize(raw, MaxBioLength, allowNewlines: true)
          ?? throw RequestException.BadRequest($"Bios can be up to {MaxBioLength} characters, with no invisible characters.");

    private static string? Pronouns(string? raw) =>
        raw is null ? null
        : raw.Trim().Length == 0 ? ""
        : Text.Normalize(raw, MaxPronounsLength, allowNewlines: false)
          ?? throw RequestException.BadRequest($"Pronouns can be up to {MaxPronounsLength} characters.");

    private static string? Accent(string? raw) =>
        raw is null ? null
        : raw.Length == 0 ? ""
        : AccentPattern().IsMatch(raw) ? raw.ToLowerInvariant()
        : throw RequestException.BadRequest("'accent' must be a colour like #7c6fff.");

    /// <summary>Applies the optional profile fields sent with auth. Invalid ones are ignored, so an old value can't lock anyone out.</summary>
    public static void ApplyFromAuth(Store store, string accountKey, JsonElement profile)
    {
        if (profile.ValueKind != JsonValueKind.Object) return;
        var body = new Body(profile);
        string? Try(Func<string?> read)
        {
            try { return read(); }
            catch (RequestException) { return null; }
        }
        var bio = Try(() => Bio(body.OptionalString("bio", MaxBioLength * 2)));
        var pronouns = Try(() => Pronouns(body.OptionalString("pronouns", MaxPronounsLength * 2)));
        var accent = Try(() => Accent(body.OptionalString("accent", 16)));
        if (bio is not null || pronouns is not null || accent is not null) store.UpdateProfile(accountKey, bio, pronouns, accent);
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object Update(Session s, Member me, Body body)
    {
        var rawName = body.OptionalString("name", 256);
        var name = rawName is null ? null : Names.Normalize(rawName)
            ?? throw RequestException.BadRequest($"Names must be 1–{Names.MaxLength} characters, with no invisible characters.");
        var bio = Bio(body.OptionalString("bio", MaxBioLength * 2));
        var pronouns = Pronouns(body.OptionalString("pronouns", MaxPronounsLength * 2));
        var accent = Accent(body.OptionalString("accent", 16));
        var avatar = body.OptionalString("avatar", 64);
        if (!string.IsNullOrEmpty(avatar))
        {
            var file = s.World.Store.GetFile(avatar);
            if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown avatar file.");
            CheckAvatarImage(file);
        }

        if (name is not null) s.World.Store.SetMemberName(me.AccountKey, name);
        s.World.Store.UpdateProfile(me.AccountKey, bio, pronouns, accent, avatar);
        var member = s.Hub.PublicMember(me with { Name = name ?? me.Name });
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        return new { member };
    }

    private static object SetPage(Session s, Member me, Body body)
    {
        if (!PagesEnabled(s.World.Store)) throw RequestException.Forbidden("Profile pages are turned off on this server.");
        var file = s.World.Store.GetFile(body.String("file", 64));
        if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown page file.");
        if (file.Size > MaxPageBytes) throw RequestException.BadRequest($"Profile pages can be up to {MaxPageBytes / 1024} KB.");

        string html;
        try
        {
            var bytes = File.ReadAllBytes(s.Uploads.PathFor(file.Sha256));
            if (bytes.Length > MaxPageBytes) throw RequestException.BadRequest($"Profile pages can be up to {MaxPageBytes / 1024} KB.");
            html = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw RequestException.BadRequest("Profile pages must be UTF-8 text.");
        }
        catch (IOException)
        {
            throw RequestException.NotFound("Page file");
        }
        if (html.Contains('\0')) throw RequestException.BadRequest("Profile pages must be text.");

        s.World.Store.SetPage(me.AccountKey, Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), html, file.Sha256, s.Now);
        var member = s.Hub.PublicMember(me);
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        return new { member };
    }

    /// <summary>Your own page, or (admins) the page of someone ranked below you.</summary>
    private static object? RemovePage(Session s, Member me, Body body)
    {
        var key = body.OptionalString("accountKey", 64) ?? me.AccountKey;
        if (key != me.AccountKey)
        {
            var target = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
            if (!Permissions.IsAdmin(me) || !Permissions.Outranks(me, target))
                throw RequestException.Forbidden("You can only remove pages of members ranked below you.");
        }
        if (!s.World.Store.RemovePage(key)) throw RequestException.NotFound("Profile page");
        if (key != me.AccountKey) Audit.Record(s, "profile.page.remove", key);
        BroadcastMember(s, key);
        return null;
    }

    private static object? ConfigurePages(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        var enabled = body.OptionalBool("enabled") ?? throw RequestException.BadRequest("'enabled' is required.");
        if (enabled == PagesEnabled(s.World.Store)) return null;
        s.World.Store.SetProfileOption("pages", enabled ? "on" : "off");
        Audit.Record(s, "server.pages", details: new { enabled });
        s.Hub.Broadcast(Frames.Event("profile.pages", new { enabled }));
        // Pages appear or disappear from members (they're kept, so turning pages back on restores them).
        foreach (var key in s.World.Store.AccountsWithPages()) BroadcastMember(s, key);
        return null;
    }
}
