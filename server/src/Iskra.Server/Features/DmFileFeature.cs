using System.Security.Cryptography;
using System.Text;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// End-to-end encrypted DM attachments. Apps encrypt each file with its own random key and upload only ciphertext;
/// the key, name, type and size travel inside the DM envelope. The server stores the bytes opaquely (never sniffed,
/// never served from /files/), counts them against the upload quota, and hands short-lived download links only to
/// the accounts in the file's access list: the people in the conversation (both people of a DM, or the group's members
/// when it was uploaded, for a group DM).
/// </summary>
public static class DmFileFeature
{
    public const int MaxFilesPerMessage = 10;
    public static readonly TimeSpan LinkLifetime = TimeSpan.FromMinutes(10);
    private const string LinkContext = "iskra/dm-file-link/v1";

    /// <summary>Signs download links. Per process: links simply stop working after a restart.</summary>
    private static readonly byte[] LinkKey = RandomNumberGenerator.GetBytes(32);

    public static void Register(Router router)
    {
        router.Add("dm.upload.begin", Begin);
        router.Add("dm.file.url", Link);
    }

    private static object Begin(Session s, Member me, Body body)
    {
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't send direct messages.");
        string[] readers;
        if (body.OptionalString("groupId", GroupChain.IdLength) is { } groupId)
        {
            // A group DM: everyone in the group now (the access list doesn't change when the group does).
            var group = GroupFeature.Mine(s, me, groupId);
            readers = [.. group.Members];
        }
        else if (body.OptionalLong("channelId") is { } channelId)
        {
            // An encrypted channel: everyone in its chain now.
            readers = E2eeChannelFeature.UploadReaders(s, me, channelId);
        }
        else
        {
            var key = body.String("accountKey", 64);
            var peer = (key == me.AccountKey ? me : s.World.Store.GetMember(key)) ?? throw RequestException.NotFound("Member");
            readers = [me.AccountKey, peer.AccountKey];
        }
        var size = body.OptionalLong("size", min: 1) ?? throw RequestException.BadRequest("'size' is required.");
        if (size > s.Uploads.MaxBytes)
            throw RequestException.BadRequest($"Files can be up to {s.Uploads.MaxBytes / 1024 / 1024} MB on this server.");
        if (!s.Hub.Limits.TryTake(me.AccountKey, "upload.begin")) throw new RequestException("rate_limited", "Slow down a little.");
        var token = s.Uploads.Issue(me.AccountKey, me.Role, "dm-file", size, readers.Distinct().ToArray())
            ?? throw new RequestException("rate_limited",
                $"You've reached today's upload limit on this server ({s.Uploads.DailyQuota(me.Role)!.Value / 1024 / 1024} MB a day). Try again later.");
        return new { url = $"/upload/{token}", maxBytes = s.Uploads.MaxBytes, partBytes = Uploads.PartBytes };
    }

    private static object Link(Session s, Member me, Body body)
    {
        var id = body.String("id", 64);
        var file = s.World.Store.GetFile(id);
        if (file is null || s.World.Store.GetDmFile(id) is null || !s.World.Store.CanReadDmFile(id, me.AccountKey))
            throw RequestException.NotFound("File");
        var expires = s.Now + (long)LinkLifetime.TotalMilliseconds;
        return new { url = $"/dmfiles/{id}?exp={expires}&sig={Sign(id, expires)}", size = file.Size };
    }

    private static string Sign(string id, long expires) =>
        Ed25519.ToB64u(HMACSHA256.HashData(LinkKey, Encoding.UTF8.GetBytes($"{LinkContext}\0{id}\0{expires}")));

    /// <summary>The files a dm.send carries: your own DM uploads, for this person, not sent before.</summary>
    public static string[] CheckAttachments(Session s, Member me, Member peer, Body body)
    {
        var ids = body.OptionalStringArray("files", MaxFilesPerMessage, 64).Distinct().ToArray();
        foreach (var id in ids)
        {
            var file = s.World.Store.GetDmFile(id);
            if (file is null || file.Uploader != me.AccountKey || file.MessageId is not null || !s.World.Store.CanReadDmFile(id, peer.AccountKey))
                throw RequestException.BadRequest("Unknown attachment.");
        }
        return ids;
    }

    /// <summary>The files a group.send carries: your own DM uploads, readable by every current member, not sent before.</summary>
    public static string[] CheckGroupAttachments(Session s, Member me, IReadOnlyCollection<string> members, Body body)
    {
        var ids = body.OptionalStringArray("files", MaxFilesPerMessage, 64).Distinct().ToArray();
        foreach (var id in ids)
        {
            var file = s.World.Store.GetDmFile(id);
            if (file is null || file.Uploader != me.AccountKey || file.MessageId is not null || members.Any(m => !s.World.Store.CanReadDmFile(id, m)))
                throw RequestException.BadRequest("Unknown attachment.");
        }
        return ids;
    }

    /// <summary>GET /dmfiles/{id}?exp=&amp;sig=: the ciphertext, as an opaque download.</summary>
    public static IResult Serve(HttpContext context, World world, Uploads uploads, string id)
    {
        Uploads.AllowCors(context);
        var now = context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow().ToUnixTimeMilliseconds();
        if (!long.TryParse(context.Request.Query["exp"], out var expires) || expires < now
            || !Ed25519.TryFromB64u(context.Request.Query["sig"].ToString(), out var sig)
            || !CryptographicOperations.FixedTimeEquals(sig, Ed25519.TryFromB64u(Sign(id, expires), out var good) ? good : []))
            return Results.StatusCode(StatusCodes.Status403Forbidden);

        var file = world.Store.GetFile(id);
        if (file is null || world.Store.GetDmFile(id) is null || !File.Exists(uploads.PathFor(file.Sha256))) return Results.NotFound();
        var headers = context.Response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        headers.CacheControl = "private, max-age=600";
        headers.ContentDisposition = "attachment; filename=\"encrypted.bin\"";
        return Results.File(uploads.PathFor(file.Sha256), "application/octet-stream", enableRangeProcessing: true);
    }
}
