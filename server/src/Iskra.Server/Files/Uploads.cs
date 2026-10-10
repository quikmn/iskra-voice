using System.Collections.Concurrent;
using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Files;

/// <summary>
/// Uploads and downloads over plain HTTP. A WebSocket request (upload.begin) hands out a single-use ticket;
/// the bytes are then PUT to /upload/{ticket}. Files are stored once per content (uploads/ab/abcdef…)
/// and served from unguessable ids with headers that never let a file run as part of the site.
/// </summary>
public sealed partial class Uploads(World world, TimeProvider time, ILogger<Uploads> log, Voice.VoiceRegistry voice)
{
    private sealed record Ticket(string Uploader, string Name, long MaxBytes, DateTimeOffset Expires)
    {
        public int Claimed;
    }

    private static readonly TimeSpan QuotaWindow = TimeSpan.FromHours(24);

    /// <summary>Tickets stay here until their upload ends, so they count against the quota while in flight.</summary>
    private readonly ConcurrentDictionary<string, Ticket> _tickets = new();
    private readonly Lock _quotaLock = new();
    /// <summary>Held while a file appears on or leaves the disk, so a sweep never deletes content a new upload just reused.</summary>
    private readonly Lock _diskLock = new();

    public long MaxBytes => (long)world.Settings.MaxUploadMb * 1024 * 1024;

    /// <summary>Bytes per 24 hours for this role, or null for no limit (admins, the owner, or 0 in server.json).</summary>
    public long? DailyQuota(string role)
    {
        if (Roles.Rank(role) >= Roles.Rank(Roles.Admin)) return null;
        var quota = world.Settings.UploadQuota;
        var mb = role == Roles.Guest ? quota.GuestMbPerDay : quota.MemberMbPerDay;
        return mb > 0 ? mb * 1024L * 1024 : null;
    }

    /// <summary>Hands out a ticket for <paramref name="size"/> bytes, or null if that would pass the uploader's daily quota.</summary>
    public string? Issue(string uploader, string role, string name, long size)
    {
        var now = time.GetUtcNow();
        lock (_quotaLock)
        {
            foreach (var (key, old) in _tickets)
                if (old.Expires < now && old.Claimed == 0) _tickets.TryRemove(key, out _);
            if (DailyQuota(role) is { } quota)
            {
                var used = world.Store.UploadedBytesSince(uploader, (now - QuotaWindow).ToUnixTimeMilliseconds())
                    + _tickets.Values.Where(t => t.Uploader == uploader).Sum(t => t.MaxBytes);
                if (used + size > quota) return null;
            }
            var token = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(24));
            _tickets[token] = new Ticket(uploader, FileSniffer.CleanName(name), size, now.AddMinutes(10));
            return token;
        }
    }

    public string PathFor(string sha256) => Path.Combine(world.Path, "uploads", sha256[..2], sha256);

    public async Task HandleUploadAsync(HttpContext context, string token)
    {
        AllowCors(context);
        if (!_tickets.TryGetValue(token, out var ticket) || Interlocked.Exchange(ref ticket.Claimed, 1) != 0)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        try
        {
            await ReceiveAsync(context, ticket);
        }
        finally
        {
            _tickets.TryRemove(token, out _);
        }
    }

    private async Task ReceiveAsync(HttpContext context, Ticket ticket)
    {
        if (ticket.Expires < time.GetUtcNow())
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (context.Request.ContentLength is { } declared && declared > ticket.MaxBytes)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            return;
        }

        var temp = Path.Combine(world.Path, "uploads", $".incoming-{Guid.NewGuid():N}");
        long size = 0;
        var head = new byte[64 * 1024];
        var headLength = 0;
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        try
        {
            await using (var output = File.Create(temp))
            {
                var buffer = new byte[81920];
                int read;
                while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) > 0)
                {
                    size += read;
                    if (size > ticket.MaxBytes)
                    {
                        context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                        return;
                    }
                    if (headLength < head.Length)
                    {
                        var take = Math.Min(read, head.Length - headLength);
                        buffer.AsSpan(0, take).CopyTo(head.AsSpan(headLength));
                        headLength += take;
                    }
                    sha.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), context.RequestAborted);
                }
            }
            if (size == 0)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }

            var hash = Convert.ToHexStringLower(sha.GetHashAndReset());
            var target = PathFor(hash);
            var kind = FileSniffer.Sniff(head.AsSpan(0, headLength));
            if (kind.Type == "image/jpeg" && kind.Width is null)
            {
                await using var whole = File.OpenRead(temp);
                var (width, height) = FileSniffer.JpegSize(whole);
                kind = kind with { Width = width, Height = height };
            }
            var file = new StoredFile(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), hash, ticket.Name, size, kind.Type,
                kind.Width, kind.Height, ticket.Uploader, time.GetUtcNow().ToUnixTimeMilliseconds());
            lock (_diskLock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                if (File.Exists(target)) File.Delete(temp); // same content uploaded before: keep one copy
                else File.Move(temp, target);
                world.Store.AddFile(file);
            }
            await context.Response.WriteAsJsonAsync(new { file = Public(file) });
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            log.LogInformation("Upload aborted: {Message}", ex.Message);
            if (!context.Response.HasStarted) context.Response.StatusCode = StatusCodes.Status400BadRequest;
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    public IResult Serve(HttpContext context, string id)
    {
        AllowCors(context);
        var file = world.Store.GetFile(id);
        if (file is null || !File.Exists(PathFor(file.Sha256))) return Results.NotFound();

        var kind = FileSniffer.Sniff(ReadHead(PathFor(file.Sha256)));
        var headers = context.Response.Headers;
        headers.XContentTypeOptions = "nosniff";
        // Even if a browser is talked into rendering it, a file can't run scripts or load anything.
        headers.ContentSecurityPolicy = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
        headers.CacheControl = "private, max-age=31536000, immutable";
        var disposition = new System.Net.Http.Headers.ContentDispositionHeaderValue(kind.Inline ? "inline" : "attachment") { FileNameStar = file.Name };
        headers.ContentDisposition = disposition.ToString();
        return Results.File(PathFor(file.Sha256), kind.Type, enableRangeProcessing: true);
    }

    private static byte[] ReadHead(string path)
    {
        using var stream = File.OpenRead(path);
        var head = new byte[64 * 1024];
        var read = stream.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
        return head[..read];
    }

    /// <summary>The web app lives on another origin; tickets and unguessable ids are the credentials, not cookies.</summary>
    public static void AllowCors(HttpContext context)
    {
        context.Response.Headers.AccessControlAllowOrigin = "*";
        context.Response.Headers.AccessControlAllowMethods = "GET, PUT, OPTIONS";
        context.Response.Headers.AccessControlAllowHeaders = "Content-Type";
        context.Response.Headers.AccessControlMaxAge = "86400";
    }

    public static object Public(StoredFile f) =>
        new { id = f.Id, name = f.Name, size = f.Size, type = f.Type, width = f.Width, height = f.Height, url = UrlOf(f) };

    public static string UrlOf(StoredFile f) => $"/files/{f.Id}/{Uri.EscapeDataString(f.Name)}";
}
