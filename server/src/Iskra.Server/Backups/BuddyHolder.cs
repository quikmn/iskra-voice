using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Backups;

/// <summary>
/// The holder's side of backup buddies (PROTOCOL.md → Backup buddies): spots for friends' servers, the signed HTTP
/// requests they make, and opaque copies in buddy-held/&lt;spot&gt;/ that are never parsed, opened or run. A sweep
/// deletes removed spots after their grace period, unused pairing codes, stale uploads and orphans.
/// </summary>
public sealed partial class BuddyHolder(World world, Hub hub, TimeProvider time, IConfiguration config, ILogger<BuddyHolder> log) : BackgroundService
{
    public const int MaxSpots = 20;
    public const int PartBytes = 4 * 1024 * 1024;
    public const int MaxJsonBytes = 4096;
    public const long CodeLifetimeMs = 24 * 60 * 60 * 1000;
    public const long ClockSkewMs = 5 * 60 * 1000;
    public const long NonceMemoryMs = 10 * 60 * 1000;
    public const long UploadLifetimeMs = 24 * 60 * 60 * 1000;
    public const int UploadsPerDay = 3;
    public const long DayMs = 24 * 60 * 60 * 1000;
    public const string FolderName = "buddy-held";
    /// <summary>The newest copy at least this old is never pruned, so a source taken over can't flush every good copy.</summary>
    public const long ProtectAfterMs = 48 * 60 * 60 * 1000;
    /// <summary>When the source removes itself, the copies stay at least this long, whatever the spot's grace period.</summary>
    public const int MinSourceGraceDays = 1;
    public const int MaxAddressBuckets = 10_000;

    private readonly long _minFreeBytes = config.GetValue("BuddyBackups:MinFreeMb", 1024L) * 1024 * 1024;
    private readonly ConcurrentDictionary<string, long> _nonces = new();
    private readonly ConcurrentDictionary<string, WebhookIngress.TokenBucket> _addressBuckets = new();
    private readonly ConcurrentQueue<string> _addressOrder = new();
    /// <summary>Nonces are remembered in memory only: requests signed before this start are refused, so none replays after a restart.</summary>
    private readonly long _startedAt = time.GetUtcNow().ToUnixTimeMilliseconds();
    private readonly ConcurrentDictionary<string, WebhookIngress.TokenBucket> _spotBuckets = new();
    private readonly ConcurrentDictionary<string, object> _spotLocks = new();

    [GeneratedRegex("^[0-9a-f]{16}$")]
    private static partial Regex Id();

    public static string NewId() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));

    public string Root => Path.Combine(world.Path, FolderName);
    private string SpotFolder(string spotId) => Path.Combine(Root, spotId);
    private string VersionPath(string spotId, string versionId) => Path.Combine(SpotFolder(spotId), $"{versionId}.blob");
    private string IncomingPath(string spotId, string uploadId) => Path.Combine(SpotFolder(spotId), $".incoming-{uploadId}");

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    // ── The holder owner's requests (BuddyBackupFeature) ─────────────────────

    /// <summary>What a new pairing code carries as this server's address, or null when there's none to give.</summary>
    public string? Address()
    {
        var s = world.Settings;
        var url = world.InternetUrl ?? s.PublicUrl ?? (s.Https.Enabled ? s.Https.DefaultUrl : null) ?? (s.LocalOnly ? s.EffectivePublicUrl : null);
        return url?.TrimEnd('/');
    }

    public object Spots() => new { spots = world.Store.BuddySpots().Select(SpotView), address = Address() };

    public object SpotView(BuddySpotRow spot)
    {
        var versions = world.Store.BuddyVersions(spot.Id);
        return new
        {
            id = spot.Id,
            label = spot.Label,
            state = spot.DeleteAt is not null ? "removing" : spot.PairedAt is null ? "waiting" : "active",
            sourceName = spot.SourceName,
            sourceKey = spot.SourceKey,
            quotaBytes = spot.QuotaBytes,
            keep = spot.Keep,
            graceDays = spot.GraceDays,
            used = versions.Sum(v => v.Size),
            versions = versions.Select(v => new { id = v.Id, size = v.Size, at = v.At }),
            createdAt = spot.CreatedAt,
            lastUploadAt = spot.LastUploadAt,
            codeExpiresAt = spot.CodeExpiresAt,
            deleteAt = spot.DeleteAt,
        };
    }

    public (BuddySpotRow Spot, string Code) CreateSpot(string label, long quotaBytes, int keep, int graceDays, string address)
    {
        if (world.Store.CountBuddySpots() >= MaxSpots)
            throw RequestException.BadRequest($"This server keeps backups for {MaxSpots} servers already. Remove one first.", "buddy_spots_full", new { max = MaxSpots });
        var token = RandomNumberGenerator.GetBytes(32);
        var now = Now;
        var spot = new BuddySpotRow(NewId(), label, quotaBytes, keep, graceDays, BuddyCrypto.TokenHash(token), now + CodeLifetimeMs,
            null, null, null, now, null, null, null, "[]");
        world.Store.AddBuddySpot(spot);
        return (spot, BuddyCrypto.EncodePairingCode(address, world.ServerPublicKey, token));
    }

    /// <summary>Stops a spot: never-paired spots go now; others after the grace period (or now).</summary>
    public long? RemoveSpot(BuddySpotRow spot, bool now, string by)
    {
        long? deleteAt = null;
        if (spot.PairedAt is null || now) DeleteSpot(spot.Id);
        else
        {
            // The source can't shorten the grace: a source taken over must not wipe its own copies.
            var graceDays = by == "source" ? Math.Max(MinSourceGraceDays, spot.GraceDays) : spot.GraceDays;
            deleteAt = Now + graceDays * DayMs;
            world.Store.RemoveBuddySpotLater(spot.Id, deleteAt.Value);
            if (graceDays == 0) DeleteSpot(spot.Id);
            DropUploads(spot.Id);
        }
        SecurityLog.Record(world.Store, Now, "buddy.spot.removed", details: new { by, sourceKey = spot.SourceKey, deleteAt });
        Changed();
        return deleteAt;
    }

    private void DeleteSpot(string spotId)
    {
        lock (SpotLock(spotId))
        {
            world.Store.DeleteBuddySpot(spotId);
            try { if (Directory.Exists(SpotFolder(spotId))) Directory.Delete(SpotFolder(spotId), recursive: true); }
            catch (IOException ex) { log.LogWarning(ex, "Couldn't delete a backup buddy's copies yet"); }
            catch (UnauthorizedAccessException ex) { log.LogWarning(ex, "Couldn't delete a backup buddy's copies yet"); }
        }
    }

    private void DropUploads(string spotId)
    {
        foreach (var upload in world.Store.BuddyUploads().Where(u => u.SpotId == spotId))
        {
            world.Store.DeleteBuddyUpload(upload.Id);
            TryDelete(IncomingPath(spotId, upload.Id));
        }
    }

    private object SpotLock(string spotId) => _spotLocks.GetOrAdd(spotId, _ => new object());

    /// <summary>Tells the owner's sessions to look again.</summary>
    public void Changed()
    {
        var frame = Frames.Event("buddy.changed", new { });
        foreach (var session in hub.Sessions)
            if (session.CurrentMember() is { Role: Roles.Owner }) session.Send(frame);
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    public static void MapEndpoints(WebApplication app)
    {
        app.MapGet("/buddy/v1/hello", (HttpContext c, BuddyHolder h) => h.Hello(c));
        app.MapPost("/buddy/v1/pair", (HttpContext c, BuddyHolder h) => h.PairAsync(c));
        app.MapGet("/buddy/v1/spot", (HttpContext c, BuddyHolder h) => h.Signed(c, false, (spot, _, _) => Task.FromResult(h.SpotInfo(spot))));
        app.MapDelete("/buddy/v1/spot", (HttpContext c, BuddyHolder h) => h.Signed(c, true, (spot, _, _) => Task.FromResult(h.SourceRemoves(c, spot))));
        app.MapPost("/buddy/v1/uploads", (HttpContext c, BuddyHolder h) => h.Signed(c, true, (spot, body, _) => Task.FromResult(h.BeginUpload(spot, body))));
        app.MapGet("/buddy/v1/uploads/{id}", (HttpContext c, string id, BuddyHolder h) => h.Signed(c, true, (spot, _, _) => Task.FromResult(h.UploadStatus(spot, id))));
        app.MapPut("/buddy/v1/uploads/{id}", (HttpContext c, string id, BuddyHolder h) => h.Signed(c, true, (spot, body, _) => Task.FromResult(h.PutPart(c, spot, id, body))));
        app.MapPost("/buddy/v1/uploads/{id}/finish", (HttpContext c, string id, BuddyHolder h) => h.Signed(c, true, (spot, body, _) => Task.FromResult(h.Finish(spot, id, body))));
        app.MapGet("/buddy/v1/versions/{id}", (HttpContext c, string id, BuddyHolder h) => h.Signed(c, false, (spot, _, _) => Task.FromResult(h.Download(spot, id))));
    }

    private static IResult Status(int code, object? body = null) => body is null ? Results.StatusCode(code) : Results.Json(body, statusCode: code);

    private static string Address(HttpContext context) => AddressKey(context.Connection.RemoteIpAddress);

    /// <summary>The rate-limit key for a client address: IPv4 as is, IPv6 by its /64 (one home network).</summary>
    internal static string AddressKey(System.Net.IPAddress? ip)
    {
        if (ip is null) return "local";
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetworkV6) return ip.ToString();
        return Convert.ToHexStringLower(ip.GetAddressBytes().AsSpan(0, 8)) + "::/64";
    }

    private string? LoggedIp(HttpContext context) => world.Settings.Retention.SecurityLogIps ? context.Connection.RemoteIpAddress?.ToString() : null;

    /// <summary>Pairing and refused requests, per client address: a burst of 10, then one every 6 seconds.</summary>
    private bool AddressAllows(HttpContext context)
    {
        var bucket = _addressBuckets.GetOrAdd(Address(context), key =>
        {
            _addressOrder.Enqueue(key);
            return new WebhookIngress.TokenBucket(10, 1 / 6.0, time);
        });
        // Many addresses: forget the oldest ones, never all at once (that would reset everyone's limit).
        while (_addressBuckets.Count > MaxAddressBuckets && _addressOrder.TryDequeue(out var oldest)) _addressBuckets.TryRemove(oldest, out _);
        return bucket.TryTake(out _);
    }

    private static void NoStore(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
    }

    private IResult Hello(HttpContext context)
    {
        NoStore(context);
        return Results.Json(new { iskra = 1, key = Ed25519.ToB64u(world.ServerPublicKey) });
    }

    private static async Task<byte[]?> ReadBody(HttpContext context, int max)
    {
        if (context.Request.ContentLength > max) return null;
        if (context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = max + 1;
        var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0)
        {
            buffer.Write(chunk, 0, read);
            if (buffer.Length > max) return null;
        }
        return buffer.ToArray();
    }

    private sealed record PairBody(string Token, string SourceKey, string RestoreKey, string Name, long At, string Sig, string RestoreSig);

    private async Task<IResult> PairAsync(HttpContext context)
    {
        NoStore(context);
        if (!AddressAllows(context)) return TooMany(context);
        var bytes = await ReadBody(context, MaxJsonBytes);
        if (bytes is null) return Status(413);
        PairBody? body;
        try { body = JsonSerializer.Deserialize<PairBody>(bytes, new JsonSerializerOptions(JsonSerializerDefaults.Web)); }
        catch (JsonException) { return Status(400); }
        if (body is null || body.Name is null || body.Name.Trim().Length is 0 or > 100 || body.Name.Any(char.IsControl)
            || !Ed25519.TryFromB64u(body.Token, out var token) || token.Length != 32
            || !Ed25519.TryFromB64u(body.SourceKey, out var sourceKey) || sourceKey.Length != 32
            || !Ed25519.TryFromB64u(body.RestoreKey, out var restoreKey) || restoreKey.Length != 32
            || !Ed25519.TryFromB64u(body.Sig, out var sig) || !Ed25519.TryFromB64u(body.RestoreSig, out var restoreSig)) return Status(400);
        var now = Now;
        if (Math.Abs(now - body.At) > ClockSkewMs) return Status(400);
        if (!Ed25519.Verify(sourceKey, BuddyCrypto.PairPayload(world.ServerPublicKey, token, restoreKey, body.At, body.Name), sig))
        {
            SecurityLog.Record(world.Store, now, "buddy.auth.failed", ip: LoggedIp(context), details: new { reason = "pair_signature" }, source: Address(context));
            return Status(400);
        }
        // The restore key proves it's held too, so nobody registers someone else's key (e.g. a server key from /hello).
        if (!Ed25519.Verify(restoreKey, BuddyCrypto.PairRestorePayload(world.ServerPublicKey, token, sourceKey, body.At), restoreSig))
        {
            SecurityLog.Record(world.Store, now, "buddy.auth.failed", ip: LoggedIp(context), details: new { reason = "pair_restore_signature" }, source: Address(context));
            return Status(400);
        }
        if (sourceKey.AsSpan().SequenceEqual(world.ServerPublicKey) || sourceKey.AsSpan().SequenceEqual(restoreKey)) return Status(400);
        var hash = BuddyCrypto.TokenHash(token);
        var spot = world.Store.BuddySpotForToken(hash);
        if (spot is null || spot.CodeExpiresAt < now || spot.DeleteAt is not null) return Status(404);
        var sourceB64 = Ed25519.ToB64u(sourceKey);
        // Every key appears once across both columns, so a request's key always means one spot and one role.
        if (world.Store.BuddyKeyInUse(sourceB64) || world.Store.BuddyKeyInUse(Ed25519.ToB64u(restoreKey))) return Status(409);
        if (!world.Store.PairBuddySpot(spot.Id, hash, sourceB64, body.Name.Trim(), Ed25519.ToB64u(restoreKey), now)) return Status(409);
        AtomicFile.CreatePrivateDirectory(Root);
        AtomicFile.CreatePrivateDirectory(SpotFolder(spot.Id));
        SecurityLog.Record(world.Store, now, "buddy.spot.paired", ip: LoggedIp(context), details: new { sourceKey = sourceB64, name = body.Name.Trim() });
        Changed();
        var holderSig = Ed25519.Sign(world.ServerKey, BuddyCrypto.PairedPayload(sourceKey, token, now, spot.Id));
        return Results.Json(new
        {
            spotId = spot.Id, quotaBytes = spot.QuotaBytes, keep = spot.Keep, graceDays = spot.GraceDays, name = world.Settings.Name,
            at = now, sig = Ed25519.ToB64u(holderSig),
        });
    }

    private IResult TooMany(HttpContext context)
    {
        context.Response.Headers.RetryAfter = "6";
        return Status(429);
    }

    /// <summary>Checks the signature, then runs <paramref name="handle"/> with the spot, the body and whether it's the source.</summary>
    private async Task<IResult> Signed(HttpContext context, bool sourceOnly, Func<BuddySpotRow, byte[], bool, Task<IResult>> handle)
    {
        NoStore(context);
        var auth = BuddyCrypto.ParseAuthorization(context.Request.Headers.Authorization.ToString());
        var now = Now;
        // Who it claims to be is checked before the body is read (a key nobody paired never gets that far); refused requests
        // count against the client address, so even someone using a known public key can't make us read 4 MB parts often.
        var spot = auth is null ? null : world.Store.BuddySpotForKey(Ed25519.ToB64u(auth.Key));
        string? reason = auth is null ? "no_signature" : Math.Abs(now - auth.At) > ClockSkewMs ? "clock"
            : auth.At < _startedAt ? "before_start" : spot is null ? "unknown_key" : null;
        byte[]? bytes = null;
        if (reason is null)
        {
            bytes = await ReadBody(context, HttpMethods.IsPut(context.Request.Method) ? PartBytes : MaxJsonBytes);
            if (bytes is null) return Status(413);
            var path = $"{context.Request.PathBase}{context.Request.Path}{context.Request.QueryString}";
            if (!Ed25519.Verify(auth!.Key, BuddyCrypto.RequestPayload(world.ServerPublicKey, auth.At, auth.Nonce, context.Request.Method, path, bytes), auth.Sig))
                reason = "signature";
            else if (!RememberNonce(auth, now)) reason = "replay";
        }
        if (reason is not null || spot is null || auth is null || bytes is null)
        {
            if (!AddressAllows(context)) return TooMany(context);
            SecurityLog.Record(world.Store, now, "buddy.auth.failed", ip: LoggedIp(context), details: new { reason }, source: Address(context));
            return Status(401);
        }
        var isSource = Ed25519.ToB64u(auth.Key) == spot.SourceKey;
        if (sourceOnly && !isSource) return Status(403);
        if (!_spotBuckets.GetOrAdd(spot.Id, _ => new WebhookIngress.TokenBucket(60, 2, time)).TryTake(out _)) return TooMany(context);
        return await handle(spot, bytes, isSource);
    }

    private bool RememberNonce(BuddyAuth auth, long now)
    {
        if (_nonces.Count > 50_000)
            foreach (var (key, until) in _nonces)
                if (until < now) _nonces.TryRemove(key, out _);
        return _nonces.TryAdd($"{Ed25519.ToB64u(auth.Key)}:{Ed25519.ToB64u(auth.Nonce)}", now + NonceMemoryMs);
    }

    private IResult SpotInfo(BuddySpotRow spot)
    {
        var versions = world.Store.BuddyVersions(spot.Id).Where(v => File.Exists(VersionPath(spot.Id, v.Id))).ToList();
        return Results.Json(new
        {
            spotId = spot.Id, quotaBytes = spot.QuotaBytes, keep = spot.Keep, graceDays = spot.GraceDays,
            used = versions.Sum(v => v.Size), removing = spot.DeleteAt is not null, deleteAt = spot.DeleteAt,
            versions = versions.Select(v => new { id = v.Id, size = v.Size, at = v.At }),
        });
    }

    private IResult SourceRemoves(HttpContext context, BuddySpotRow spot)
    {
        if (spot.DeleteAt is { } already) return Results.Json(new { deleteAt = already });
        var deleteAt = RemoveSpot(spot, now: false, by: "source");
        return Results.Json(new { deleteAt = deleteAt ?? Now });
    }

    private List<long> RecentUploads(BuddySpotRow spot, long now)
    {
        try { return (JsonSerializer.Deserialize<List<long>>(spot.RecentUploads) ?? []).Where(at => at > now - DayMs).ToList(); }
        catch (JsonException) { return []; }
    }

    private IResult BeginUpload(BuddySpotRow spot, byte[] bytes)
    {
        if (spot.DeleteAt is not null) return Status(410);
        long size;
        try
        {
            using var doc = JsonDocument.Parse(bytes);
            size = doc.RootElement.GetProperty("size").GetInt64();
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return Status(400);
        }
        if (size < 1) return Status(400);
        var now = Now;
        // The protected copy (see Protected) stays, so the new one has to fit beside it.
        var guarded = Protected(world.Store.BuddyVersions(spot.Id), now);
        if (size + (guarded?.Size ?? 0) > spot.QuotaBytes) return Status(413, new { quotaBytes = spot.QuotaBytes, protectedBytes = guarded?.Size ?? 0 });
        if (RecentUploads(spot, now).Count >= UploadsPerDay) return Status(429);
        try
        {
            if (new DriveInfo(Path.GetPathRoot(Path.GetFullPath(world.Path))!).AvailableFreeSpace < size + _minFreeBytes) return Status(507);
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException) { /* can't tell: carry on */ }
        lock (SpotLock(spot.Id))
        {
            var upload = new BuddyUploadRow(NewId(), spot.Id, size, now);
            foreach (var old in world.Store.StartBuddyUpload(upload)) TryDelete(IncomingPath(spot.Id, old));
            AtomicFile.CreatePrivateDirectory(Root);
            AtomicFile.CreatePrivateDirectory(SpotFolder(spot.Id));
            using (BackupArchive.PrivateCreate(IncomingPath(spot.Id, upload.Id))) { }
            return Results.Json(new { id = upload.Id, received = 0L, chunkBytes = PartBytes });
        }
    }

    private BuddyUploadRow? UploadOf(BuddySpotRow spot, string id) =>
        Id().IsMatch(id) && world.Store.GetBuddyUpload(id) is { } upload && upload.SpotId == spot.Id && File.Exists(IncomingPath(spot.Id, id)) ? upload : null;

    private IResult UploadStatus(BuddySpotRow spot, string id)
    {
        if (UploadOf(spot, id) is not { } upload) return Status(404);
        return Results.Json(new { id, size = upload.Size, received = new FileInfo(IncomingPath(spot.Id, id)).Length });
    }

    private IResult PutPart(HttpContext context, BuddySpotRow spot, string id, byte[] part)
    {
        if (spot.DeleteAt is not null) return Status(410);
        if (!long.TryParse(context.Request.Query["offset"], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var offset))
            return Status(400);
        if (part.Length == 0) return Status(400);
        lock (SpotLock(spot.Id))
        {
            if (UploadOf(spot, id) is not { } upload) return Status(404);
            var path = IncomingPath(spot.Id, id);
            var received = new FileInfo(path).Length;
            if (offset != received) return Status(409, new { received });
            if (received + part.Length > upload.Size) return Status(400);
            using (var file = new FileStream(path, FileMode.Append, FileAccess.Write))
                file.Write(part);
            return Results.Json(new { received = received + part.Length });
        }
    }

    private IResult Finish(BuddySpotRow spot, string id, byte[] bytes)
    {
        if (spot.DeleteAt is not null) return Status(410);
        string? expected;
        try
        {
            using var doc = JsonDocument.Parse(bytes);
            expected = doc.RootElement.GetProperty("sha256").GetString();
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return Status(400);
        }
        if (expected is null || !Sha256Hex().IsMatch(expected)) return Status(400);
        var now = Now;
        BuddyVersionRow version;
        lock (SpotLock(spot.Id))
        {
            if (UploadOf(spot, id) is not { } upload) return Status(404);
            var path = IncomingPath(spot.Id, id);
            var received = new FileInfo(path).Length;
            if (received != upload.Size) return Status(409, new { received });
            var recent = RecentUploads(spot, now);
            if (recent.Count >= UploadsPerDay) return Status(429);
            string actual;
            using (var file = File.OpenRead(path)) actual = Convert.ToHexStringLower(SHA256.HashData(file));
            world.Store.DeleteBuddyUpload(id);
            if (actual != expected)
            {
                TryDelete(path);
                return Status(422);
            }
            version = new BuddyVersionRow(NewId(), spot.Id, received, now, actual);
            File.Move(path, VersionPath(spot.Id, version.Id));
            world.Store.AddBuddyVersion(version);
            recent.Add(now);
            world.Store.BuddySpotUploaded(spot.Id, now, JsonSerializer.Serialize(recent));
            Prune(spot, version.Id, now);
        }
        Changed();
        return Results.Json(new { version = new { id = version.Id, size = version.Size, at = version.At } });
    }

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex Sha256Hex();

    /// <summary>
    /// The protected copy among the copies older than the one arriving: the newest one at least 48 hours old, or, when
    /// none is that old yet, the oldest one. Never pruned, whatever keep and the quota say, so once there are two copies
    /// there is always an older one a flood of junk can't push out.
    /// </summary>
    internal static BuddyVersionRow? Protected(List<BuddyVersionRow> olderNewestFirst, long now) =>
        olderNewestFirst.FirstOrDefault(v => v.At <= now - ProtectAfterMs) ?? olderNewestFirst.LastOrDefault();

    /// <summary>
    /// The newest <c>keep</c> versions, then the oldest go until the spot fits its quota. Never the newest, and never the
    /// protected one (the newest at least 48 hours old), so junk uploads can't push out every good copy at once.
    /// </summary>
    private void Prune(BuddySpotRow spot, string newest, long now)
    {
        var versions = world.Store.BuddyVersions(spot.Id);
        var guarded = Protected(versions.Where(v => v.Id != newest).ToList(), now);
        var kept = new List<BuddyVersionRow>();
        var counted = 0;
        foreach (var v in versions)
        {
            if (v.Id == newest || counted < spot.Keep)
            {
                kept.Add(v);
                counted++;
            }
            else if (v.Id == guarded?.Id) kept.Add(v);
            else DropVersion(v);
        }
        var used = kept.Sum(v => v.Size);
        foreach (var v in kept.AsEnumerable().Reverse())
        {
            if (used <= spot.QuotaBytes) break;
            if (v.Id == newest || v.Id == guarded?.Id) continue;
            DropVersion(v);
            used -= v.Size;
        }
    }

    private void DropVersion(BuddyVersionRow v)
    {
        world.Store.DeleteBuddyVersion(v.Id);
        TryDelete(VersionPath(v.SpotId, v.Id));
    }

    private IResult Download(BuddySpotRow spot, string id)
    {
        if (!Id().IsMatch(id) || world.Store.BuddyVersions(spot.Id).FirstOrDefault(v => v.Id == id) is null) return Status(404);
        var path = VersionPath(spot.Id, id);
        if (!File.Exists(path)) return Status(404);
        return Results.File(path, "application/octet-stream", enableRangeProcessing: true);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    // ── The sweep ────────────────────────────────────────────────────────────

    /// <summary>Removed spots past their grace period, unused codes, stale uploads, and copies or folders nothing knows.</summary>
    public void Sweep()
    {
        var now = Now;
        var changed = false;
        foreach (var spot in world.Store.BuddySpots())
        {
            if (spot.DeleteAt is { } at && at <= now)
            {
                DeleteSpot(spot.Id);
                SecurityLog.Record(world.Store, now, "buddy.spot.deleted", details: new { sourceKey = spot.SourceKey });
                changed = true;
            }
            else if (spot.PairedAt is null && spot.CodeExpiresAt < now)
            {
                DeleteSpot(spot.Id);
                changed = true;
            }
            else
            {
                foreach (var v in world.Store.BuddyVersions(spot.Id).Where(v => !File.Exists(VersionPath(spot.Id, v.Id))))
                {
                    world.Store.DeleteBuddyVersion(v.Id); // e.g. this server was restored from a backup (copies aren't in it)
                    changed = true;
                }
            }
        }
        foreach (var upload in world.Store.BuddyUploads().Where(u => u.CreatedAt < now - UploadLifetimeMs))
        {
            world.Store.DeleteBuddyUpload(upload.Id);
            TryDelete(IncomingPath(upload.SpotId, upload.Id));
        }
        if (Directory.Exists(Root))
        {
            var known = world.Store.BuddySpots().Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var dir in Directory.EnumerateDirectories(Root))
            {
                if (known.Contains(Path.GetFileName(dir))) continue;
                try { Directory.Delete(dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
        if (changed) Changed();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var every = TimeSpan.FromMilliseconds(config.GetValue("BuddyBackups:SweepMs", 60 * 60 * 1000));
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try { Sweep(); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException)
                {
                    log.LogWarning(ex, "Sweeping backup buddies' copies failed");
                }
                await Task.Delay(every, time, stoppingToken);
            }
        }
        catch (OperationCanceledException) { /* stopping */ }
    }
}
