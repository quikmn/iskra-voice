using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Files;

/// <summary>
/// Uploads and downloads over plain HTTP. A WebSocket request (upload.begin) hands out a single-use ticket;
/// the bytes are then PUT to /upload/{ticket}, in one go or in parts (?offset=n). Files are stored once per content
/// (uploads/ab/abcdef…) and served from unguessable ids with headers that never let a file run as part of the site.
/// </summary>
public sealed partial class Uploads(World world, TimeProvider time, ILogger<Uploads> log, Voice.VoiceRegistry? voice = null)
{
    /// <summary>The most one PUT of an upload in parts may carry.</summary>
    public const long PartBytes = 16 * 1024 * 1024;

    /// <summary>How long a ticket waits for its upload, or for the next part of one.</summary>
    private static readonly TimeSpan TicketLifetime = TimeSpan.FromMinutes(10);

    /// <summary><paramref name="DmAccess"/>: an end-to-end encrypted DM attachment, readable only by these accounts.</summary>
    private sealed record Ticket(string Uploader, string Name, long MaxBytes, string[]? DmAccess = null)
    {
        /// <summary>1 while a PUT runs (and for good after a plain PUT), 0 while free.</summary>
        public int Claimed;
        public DateTimeOffset Expires;
        /// <summary>Uploads in parts: the file so far, and how many bytes of it count.</summary>
        public string? Temp;
        public long Received;
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
    public string? Issue(string uploader, string role, string name, long size, string[]? dmAccess = null)
    {
        var now = time.GetUtcNow();
        lock (_quotaLock)
        {
            DropExpired(now);
            if (DailyQuota(role) is { } quota)
            {
                var used = world.Store.UploadedBytesSince(uploader, (now - QuotaWindow).ToUnixTimeMilliseconds())
                    + _tickets.Values.Where(t => t.Uploader == uploader).Sum(t => t.MaxBytes);
                if (used + size > quota) return null;
            }
            var token = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(24));
            _tickets[token] = new Ticket(uploader, FileSniffer.CleanName(name), size, dmAccess) { Expires = now + TicketLifetime };
            return token;
        }
    }

    /// <summary>Forgets tickets nobody used in time, with whatever parts they had.</summary>
    private void DropExpired(DateTimeOffset now)
    {
        foreach (var (key, old) in _tickets)
            if (old.Expires < now && Interlocked.CompareExchange(ref old.Claimed, 1, 0) == 0) Drop(key, old);
    }

    private void Drop(string token, Ticket ticket)
    {
        _tickets.TryRemove(token, out _);
        if (ticket.Temp is { } temp)
        {
            try { File.Delete(temp); }
            catch (IOException ex) { log.LogInformation("Couldn't delete an unfinished upload: {Message}", ex.Message); }
        }
    }

    public string PathFor(string sha256) => Path.Combine(world.Path, "uploads", sha256[..2], sha256);

    public async Task HandleUploadAsync(HttpContext context, string token)
    {
        AllowCors(context);
        if (!_tickets.TryGetValue(token, out var ticket) || Interlocked.CompareExchange(ref ticket.Claimed, 1, 0) != 0)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (context.Request.Query.ContainsKey("offset"))
        {
            var keep = false;
            try
            {
                keep = await ReceivePartAsync(context, ticket);
            }
            finally
            {
                if (keep) Volatile.Write(ref ticket.Claimed, 0);
                else Drop(token, ticket);
            }
            return;
        }
        if (ticket.Temp is not null) // already taking parts
        {
            Volatile.Write(ref ticket.Claimed, 0);
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        try
        {
            await ReceiveAsync(context, ticket);
        }
        finally
        {
            Drop(token, ticket);
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

        var temp = NewTemp();
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
            await StoreAsync(context, ticket, temp, size, head.AsSpan(0, headLength).ToArray(), Convert.ToHexStringLower(sha.GetHashAndReset()));
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

    /// <summary>One part of an upload in parts. True if the ticket stays for the next part.</summary>
    private async Task<bool> ReceivePartAsync(HttpContext context, Ticket ticket)
    {
        var now = time.GetUtcNow();
        if (ticket.Expires < now)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return false;
        }
        if (!long.TryParse(context.Request.Query["offset"].ToString(), NumberStyles.None, CultureInfo.InvariantCulture, out var offset))
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return true;
        }
        if (offset != ticket.Received)
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            await context.Response.WriteAsJsonAsync(new { received = ticket.Received });
            return true;
        }
        if (context.Request.ContentLength is { } declared && (declared > PartBytes || offset + declared > ticket.MaxBytes))
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            return false;
        }

        ticket.Temp ??= NewTemp();
        long part = 0;
        try
        {
            await using (var output = new FileStream(ticket.Temp, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None))
            {
                output.SetLength(ticket.Received); // drops whatever a cut-off part left behind
                output.Seek(0, SeekOrigin.End);
                var buffer = new byte[81920];
                int read;
                while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) > 0)
                {
                    part += read;
                    if (part > PartBytes || offset + part > ticket.MaxBytes)
                    {
                        context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                        return false;
                    }
                    await output.WriteAsync(buffer.AsMemory(0, read), context.RequestAborted);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            log.LogInformation("Upload part aborted: {Message}", ex.Message);
            if (!context.Response.HasStarted) context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return true; // the next try starts again from Received
        }
        if (part == 0)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return true;
        }

        ticket.Received += part;
        ticket.Expires = time.GetUtcNow() + TicketLifetime;
        if (ticket.Received < ticket.MaxBytes)
        {
            await context.Response.WriteAsJsonAsync(new { received = ticket.Received });
            return true;
        }

        // All there: hash and store it like a plain upload.
        string hash;
        byte[] head;
        await using (var whole = File.OpenRead(ticket.Temp))
        {
            hash = Convert.ToHexStringLower(await SHA256.HashDataAsync(whole, context.RequestAborted));
        }
        head = ReadHead(ticket.Temp);
        await StoreAsync(context, ticket, ticket.Temp, ticket.Received, head, hash);
        return false;
    }

    private string NewTemp() => Path.Combine(world.Path, "uploads", $".incoming-{Guid.NewGuid():N}");

    /// <summary>Moves a complete upload into place, records it and answers <c>{ file }</c>.</summary>
    private async Task StoreAsync(HttpContext context, Ticket ticket, string temp, long size, byte[] head, string hash)
    {
        var target = PathFor(hash);
        // DM attachments are ciphertext: never sniffed, never shown inline.
        var kind = ticket.DmAccess is not null ? new FileSniffer.Kind("application/octet-stream", false) : FileSniffer.Sniff(head);
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
            if (ticket.DmAccess is not null) world.Store.AddDmFile(file.Id, ticket.Uploader, ticket.DmAccess);
        }
        await context.Response.WriteAsJsonAsync(new { file = Public(file) });
    }

    public IResult Serve(HttpContext context, string id)
    {
        AllowCors(context);
        var file = world.Store.GetFile(id);
        if (file is null || !File.Exists(PathFor(file.Sha256))) return Results.NotFound();
        if (world.Store.GetDmFile(id) is not null) return Results.NotFound(); // only via /dmfiles, for the people in the DM

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
