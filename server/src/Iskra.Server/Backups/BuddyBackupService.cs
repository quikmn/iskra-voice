using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Backups;

/// <summary>server.json → BuddyBackups.</summary>
public sealed record BuddyBackupSettings
{
    /// <summary>How fast copies go to buddies, in KB a second (0 = as fast as the connection allows).</summary>
    public int UploadKbPerSecond { get; init; } = 1024;
}

/// <summary>
/// The source's side of backup buddies (PROTOCOL.md → Backup buddies): pairs with a friend's server, then sends it the
/// newest daily backup, encrypted with the recovery code, in parts that resume after a cut, with retries that back off.
/// One buddy at a time.
/// </summary>
public sealed class BuddyBackupService(World world, BackupService backups, BuddyHttp http, Hub hub, TimeProvider time,
    IConfiguration config, ILogger<BuddyBackupService> log) : BackgroundService
{
    public const int MaxBuddies = 8;
    private static readonly long[] RetryMinutes = [1, 5, 15, 60, 180, 360];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly SemaphoreSlim _running = new(1, 1);
    private readonly ConcurrentDictionary<string, (long Done, long Total)> _progress = new();
    private readonly TimeSpan _tick = TimeSpan.FromMilliseconds(config.GetValue("BuddyBackups:TickMs", 60_000));
    private readonly bool _unpaced = config.GetValue("BuddyBackups:Unpaced", false);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    // ── The owner's requests ─────────────────────────────────────────────────

    public object Status()
    {
        var buddies = world.Store.Buddies();
        return new
        {
            autoEnabled = world.Settings.Backups.Enabled,
            recoveryCodeSet = world.Store.BuddyRecoveryCode() is not null,
            buddies = buddies.Select(View),
        };
    }

    private object View(BuddyRow b) => new
    {
        id = b.Id,
        url = b.Url,
        holderKey = b.HolderKey,
        name = b.Name,
        quotaBytes = b.QuotaBytes,
        keep = b.Keep,
        addedAt = b.AddedAt,
        lastOk = b.OkAt is { } at ? new { at, name = b.OkName, size = b.OkSize ?? 0 } : null,
        error = b.Error is null ? (JsonElement?)null : JsonSerializer.Deserialize<JsonElement>(b.Error),
        nextTryAt = b.NextTryAt,
        uploading = _progress.TryGetValue(b.Id, out var p) ? new { done = p.Done, total = p.Total } : null,
        removed = b.Removed,
    };

    public string RecoveryCode() => BuddyCrypto.FormatRecoveryCode(world.Store.BuddyRecoveryCode()
        ?? throw new RequestException("not_found", "There's no recovery code yet: it's made when you add the first backup buddy.", "buddy_no_code"));

    /// <summary>Pairs with the spot in <paramref name="text"/>. Returns the recovery code when this made it.</summary>
    public async Task<(BuddyRow Buddy, string? RecoveryCode)> AddAsync(string text, CancellationToken cancel)
    {
        var code = BuddyCrypto.DecodePairingCode(text)
            ?? throw RequestException.BadRequest("That isn't a backup buddy pairing code. Ask your friend for a new one.", "buddy_code");
        if (code.HolderKey.AsSpan().SequenceEqual(world.ServerPublicKey))
            throw RequestException.BadRequest("That code is from this server. Backups need to go to a friend's server.", "buddy_self");
        var holderKey = Ed25519.ToB64u(code.HolderKey);
        var buddies = world.Store.Buddies();
        if (buddies.Any(b => b.HolderKey == holderKey))
            throw RequestException.BadRequest("That server keeps backups for this one already.", "buddy_already");
        if (buddies.Count >= MaxBuddies)
            throw RequestException.BadRequest($"This server has {MaxBuddies} backup buddies already.", "buddy_max", new { max = MaxBuddies });
        var url = await BuddyHttp.CheckUrlAsync(code.Url, http.LocalOnly, cancel);

        var made = world.Store.BuddyRecoveryCode() is null;
        var recovery = world.Store.EnsureBuddyRecoveryCode(BuddyCrypto.NewRecoveryCode(), Now);
        using var restoreKey = BuddyCrypto.RestoreKey(recovery);
        var name = world.Settings.Name.Trim();
        if (name.Length > 100) name = name[..100];
        if (name.Length == 0) name = "Iskra";
        BuddyPaired paired;
        try
        {
            paired = await http.PairAsync(code with { Url = url }, world.ServerKey, Ed25519.PublicKeyOf(restoreKey), name, Now, cancel);
        }
        catch (BuddyHttpException ex)
        {
            throw ex.Status switch
            {
                0 => RequestException.BadRequest("That server isn't the one the code was made on.", "buddy_wrong_server"),
                404 => RequestException.BadRequest("That code was used already or has expired. Ask your friend for a new one.", "buddy_code_used"),
                409 => RequestException.BadRequest("That server keeps backups for this one already.", "buddy_already"),
                _ => RequestException.BadRequest($"Your friend's server said no ({ex.Status}).", "buddy_refused", new { status = ex.Status }),
            };
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or BuddyAddressException)
        {
            throw RequestException.BadRequest($"Your friend's server couldn't be reached: {Reason(ex)}", "buddy_unreachable", new { reason = Reason(ex) });
        }
        var buddy = new BuddyRow(BuddyHolder.NewId(), url, holderKey, paired.Name.Length > 0 ? paired.Name : url, paired.SpotId,
            paired.QuotaBytes, paired.Keep, Now, null, null, null, null, 0, Now, null, null, false);
        world.Store.AddBuddy(buddy);
        log.LogInformation("Backups now also go to {Url}", url);
        Wake();
        return (buddy, made ? BuddyCrypto.FormatRecoveryCode(recovery) : null);
    }

    public async Task RemoveAsync(BuddyRow buddy)
    {
        world.Store.DeleteBuddy(buddy.Id);
        _progress.TryRemove(buddy.Id, out _);
        // Tell the holder (it keeps the copies for its grace period); it's gone here either way.
        try
        {
            if (Ed25519.TryFromB64u(buddy.HolderKey, out var holderKey))
                await http.RemoveAsync(buddy.Url, holderKey, world.ServerKey, Now, CancellationToken.None);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or BuddyHttpException or BuddyAddressException)
        {
            log.LogInformation("Couldn't tell {Url} that it no longer keeps backups: {Reason}", buddy.Url, Reason(ex));
        }
    }

    /// <summary>"Back up now": today's daily backup if there's none yet, then every buddy tries at once.</summary>
    public async Task BackupNowAsync()
    {
        if (!world.Settings.Backups.Enabled)
            throw RequestException.BadRequest("Turn on daily backups first: those are what go to your backup buddies.", "buddy_backups_off");
        await Task.Run(backups.RunDaily);
        world.Store.BuddiesTryNow(Now);
        Wake();
    }

    private static string Reason(Exception ex) => ex switch
    {
        TaskCanceledException => "it took too long to answer",
        BuddyAddressException => ex.Message,
        HttpRequestException { InnerException: { } inner } => inner.Message,
        _ => ex.Message,
    };

    // ── Sending ──────────────────────────────────────────────────────────────

    public void Wake()
    {
        if (_wake.CurrentCount == 0) try { _wake.Release(); } catch (SemaphoreFullException) { }
    }

    /// <summary>Tells the owner's sessions to look again.</summary>
    private void Changed()
    {
        var frame = Frames.Event("buddy.changed", new { });
        foreach (var session in hub.Sessions)
            if (session.CurrentMember() is { Role: Roles.Owner }) session.Send(frame);
    }

    /// <summary>One pass over every buddy that's due. Tests call it directly.</summary>
    public async Task RunOnceAsync(CancellationToken cancel)
    {
        await _running.WaitAsync(cancel);
        try
        {
            foreach (var buddy in world.Store.Buddies())
            {
                if (buddy.Removed || (buddy.NextTryAt is { } next && next > Now)) continue;
                if (world.Store.GetBuddy(buddy.Id) is not { } current) continue; // removed meanwhile
                await SyncAsync(current, cancel);
            }
        }
        finally
        {
            _running.Release();
        }
    }

    private sealed record Sealed(string Name, string Path, long Size, string Sha256);

    private Sealed? _sealed;

    /// <summary>The newest daily backup, encrypted with the recovery code once, for every buddy.</summary>
    private Sealed SealNewest(LocalBackup newest, string recovery)
    {
        if (_sealed is { } s && s.Name == newest.Name && File.Exists(s.Path)) return s;
        var folder = backups.Folder;
        var path = Path.Combine(folder, $"buddy-{Path.GetFileNameWithoutExtension(newest.Name)}{BackupFile.Extension}");
        foreach (var old in Directory.EnumerateFiles(folder, $"buddy-*{BackupFile.Extension}"))
            if (old != path) TryDelete(old);
        if (!File.Exists(path))
        {
            var temp = path + ".tmp";
            TryDelete(temp);
            try
            {
                using (var source = File.OpenRead(Path.Combine(folder, newest.Name)))
                using (var output = BackupArchive.PrivateCreate(temp))
                using (var encrypted = BackupFile.Encrypt(output, recovery, Ed25519.ToB64u(world.ServerPublicKey), world.Settings.Name,
                           newest.CreatedAt, BuddyCrypto.KdfOps, BuddyCrypto.KdfMem))
                    source.CopyTo(encrypted);
                File.Move(temp, path);
            }
            finally
            {
                TryDelete(temp);
            }
        }
        string sha;
        using (var file = File.OpenRead(path)) sha = Convert.ToHexStringLower(SHA256.HashData(file));
        return _sealed = new Sealed(newest.Name, path, new FileInfo(path).Length, sha);
    }

    private async Task SyncAsync(BuddyRow buddy, CancellationToken cancel)
    {
        if (!world.Settings.Backups.Enabled)
        {
            Idle(buddy, RequestException.BadRequest("Turn on daily backups first: those are what go to your backup buddies.", "buddy_backups_off"));
            return;
        }
        var newest = backups.LocalBackups().FirstOrDefault();
        var recovery = world.Store.BuddyRecoveryCode();
        if (newest is null || recovery is null || buddy.OkName == newest.Name)
        {
            Idle(buddy, null);
            return;
        }
        if (!Ed25519.TryFromB64u(buddy.HolderKey, out var holderKey)) return;
        try
        {
            var copy = await Task.Run(() => SealNewest(newest, recovery), cancel);
            if (copy.Size > buddy.QuotaBytes) throw TooBig(copy.Size, buddy.QuotaBytes);
            // Resume an upload of this same copy if the holder still has it.
            long received = 0;
            string? id = null;
            if (buddy.UploadId is { } previous && buddy.UploadName == copy.Name + ":" + copy.Sha256)
            {
                if (await http.UploadReceivedAsync(buddy.Url, holderKey, world.ServerKey, previous, Now, cancel) is { } got)
                {
                    id = previous;
                    received = got;
                }
            }
            var partBytes = BuddyHolder.PartBytes;
            if (id is null)
            {
                int chunk;
                try
                {
                    (id, received, chunk) = await http.BeginUploadAsync(buddy.Url, holderKey, world.ServerKey, copy.Size, Now, cancel);
                }
                catch (BuddyHttpException ex) when (ex.Status == 413)
                {
                    // The friend made the spot smaller: say by how much.
                    var quota = (await http.SpotAsync(buddy.Url, holderKey, world.ServerKey, Now, cancel)).QuotaBytes;
                    throw TooBig(copy.Size, quota);
                }
                partBytes = Math.Clamp(chunk, 64 * 1024, BuddyHolder.PartBytes);
                world.Store.BuddyUploading(buddy.Id, id, copy.Name + ":" + copy.Sha256);
            }
            Progress(buddy.Id, received, copy.Size, force: true);
            var pace = _unpaced ? 0 : (long)world.Settings.BuddyBackups.UploadKbPerSecond * 1024;
            var clock = Stopwatch.StartNew();
            long sent = 0;
            await using (var file = File.OpenRead(copy.Path))
            {
                var buffer = new byte[partBytes];
                while (received < copy.Size)
                {
                    file.Position = received;
                    var length = await file.ReadAtLeastAsync(buffer.AsMemory(0, (int)Math.Min(partBytes, copy.Size - received)), (int)Math.Min(partBytes, copy.Size - received), throwOnEndOfStream: true, cancel);
                    var part = length == buffer.Length ? buffer : buffer[..length];
                    try
                    {
                        received = await http.PutPartAsync(buddy.Url, holderKey, world.ServerKey, id, received, part, Now, cancel);
                    }
                    catch (BuddyHttpException ex) when (ex.Status == 409 && ex.Received is { } at && at <= copy.Size)
                    {
                        received = at; // the holder has a different amount (a part went through but the answer didn't): carry on from there
                        continue;
                    }
                    sent += length;
                    Progress(buddy.Id, received, copy.Size, force: false);
                    // Bandwidth-friendly: no faster than BuddyBackups.UploadKbPerSecond on average.
                    if (pace > 0)
                    {
                        var due = TimeSpan.FromSeconds((double)sent / pace) - clock.Elapsed;
                        if (due > TimeSpan.Zero) await Task.Delay(due, time, cancel);
                    }
                }
            }
            await http.FinishAsync(buddy.Url, holderKey, world.ServerKey, id, copy.Sha256, Now, cancel);
            var spot = await http.SpotAsync(buddy.Url, holderKey, world.ServerKey, Now, cancel);
            world.Store.BuddySucceeded(buddy.Id, Now, newest.Name, copy.Size, spot.QuotaBytes, spot.Keep);
            log.LogInformation("Daily backup sent to backup buddy {Url}", buddy.Url);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancel.IsCancellationRequested)
        {
            var (problem, removed) = Classify(ex);
            Failed(buddy, problem, removed);
        }
        finally
        {
            _progress.TryRemove(buddy.Id, out _);
            Changed();
        }
    }

    private long _lastProgress;

    private void Progress(string id, long done, long total, bool force)
    {
        _progress[id] = (done, total);
        var now = Environment.TickCount64;
        if (!force && now - _lastProgress < 1000) return;
        _lastProgress = now;
        Changed();
    }

    private static RequestException TooBig(long size, long quota) =>
        RequestException.BadRequest($"The backup ({size} bytes) is bigger than the space your friend gave it ({quota} bytes).", "buddy_too_big", new { size, quota });

    private (RequestException Problem, bool Removed) Classify(Exception ex) => ex switch
    {
        RequestException r => (r, false),
        BuddyHttpException { Status: 410 } => (RequestException.BadRequest("Your friend's server stopped keeping backups for this one.", "buddy_removed"), true),
        BuddyHttpException { Status: 401 or 403 } => (RequestException.BadRequest("Your friend's server doesn't know this server any more.", "buddy_unknown"), false),
        BuddyHttpException { Status: 507 } => (RequestException.BadRequest("Your friend's server is out of disk space.", "buddy_full"), false),
        BuddyHttpException { Status: 429 } => (RequestException.BadRequest("Your friend's server asked to wait a while.", "buddy_limited"), false),
        BuddyHttpException h => (RequestException.BadRequest($"Sending the backup failed: {h.Message}", "buddy_failed", new { reason = h.Message }), false),
        HttpRequestException or TaskCanceledException or BuddyAddressException or IOException =>
            (RequestException.BadRequest($"Your friend's server couldn't be reached: {Reason(ex)}", "buddy_unreachable", new { reason = Reason(ex) }), false),
        _ => (RequestException.BadRequest($"Sending the backup failed: {ex.Message}", "buddy_failed", new { reason = ex.Message }), false),
    };

    private static string ErrorJson(RequestException e) =>
        JsonSerializer.Serialize(new { code = e.Code, message = e.Message, key = e.Key, args = e.Args }, Json);

    private void Idle(BuddyRow buddy, RequestException? problem)
    {
        var json = problem is null ? null : ErrorJson(problem);
        if (json == buddy.Error && buddy.NextTryAt is null) return;
        world.Store.BuddyIdle(buddy.Id, json);
        Changed();
    }

    private void Failed(BuddyRow buddy, RequestException problem, bool removed)
    {
        var failures = buddy.Failures + 1;
        long? next = removed ? null : Now + RetryMinutes[Math.Min(failures, RetryMinutes.Length) - 1] * 60_000;
        var json = ErrorJson(problem);
        // Logged once per new problem, not on every retry.
        var previousKey = buddy.Error is null ? null : JsonSerializer.Deserialize<JsonElement>(buddy.Error).GetProperty("key").GetString();
        if (previousKey != problem.Key)
        {
            log.LogWarning("Backup not sent to backup buddy {Url}: {Problem}", buddy.Url, problem.Message);
            SecurityLog.Record(world.Store, Now, "buddy.upload.failed", details: new { url = buddy.Url, error = problem.Key });
        }
        world.Store.BuddyFailed(buddy.Id, json, failures, next, removed);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            // Let everything come up first.
            await Task.Delay(TimeSpan.FromSeconds(30) < _tick ? TimeSpan.FromSeconds(30) : _tick, time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                try { await RunOnceAsync(stoppingToken); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException)
                {
                    log.LogWarning(ex, "Sending backups to backup buddies failed");
                }
                await _wake.WaitAsync(_tick, stoppingToken);
            }
        }
        catch (OperationCanceledException) { /* stopping */ }
    }
}
