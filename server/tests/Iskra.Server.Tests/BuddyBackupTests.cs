using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Backups;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Backup buddies: a source server sends encrypted daily backups to a friend's server (the holder).</summary>
public class BuddyBackupTests
{
    private static readonly Dictionary<string, string> Quick = new()
    {
        ["BuddyBackups:TickMs"] = "3600000", // the tests run the uploads themselves
        ["BuddyBackups:Unpaced"] = "true",
        ["BuddyBackups:MinFreeMb"] = "0",
    };

    /// <summary>Two real servers: the source reaches the holder through the holder's own test handler.</summary>
    internal sealed class Pair : IDisposable
    {
        public IskraServer Holder { get; } = new() { Settings = Quick };
        private readonly IskraServer _sourceBase = new() { Settings = Quick };
        public WebApplicationFactory<Program> Source { get; }

        /// <param name="wrap">Stands between the source and the holder (a holder that misbehaves).</param>
        public Pair(Func<HttpMessageHandler, HttpMessageHandler>? wrap = null)
        {
            var handler = Holder.Server.CreateHandler();
            if (wrap is not null) handler = wrap(handler);
            // The holder answers at http://localhost: only a LocalOnly source may go there.
            Source = _sourceBase.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddSingleton(new BuddyHttp(handler, localOnly: true))));
        }

        public World SourceWorld => Source.Services.GetRequiredService<World>();
        public BuddyBackupService SourceBuddies => Source.Services.GetRequiredService<BuddyBackupService>();
        public BackupService SourceBackups => Source.Services.GetRequiredService<BackupService>();
        public BuddyHolder HolderSide => Holder.Services.GetRequiredService<BuddyHolder>();
        public string SourcePath => _sourceBase.WorldPath;

        /// <summary>The holder's HTTP side, as another server would call it.</summary>
        public BuddyHttp Http() => new(Holder.Server.CreateHandler(), localOnly: false, allowLoopback: true);

        public Task<User> SourceOwnerAsync() => SourceJoinAsync("Source owner", "owner");

        public async Task<User> SourceJoinAsync(string name, string role)
        {
            var world = SourceWorld;
            var identity = new TestIdentity();
            var ws = await Source.Server.CreateWebSocketClient().ConnectAsync(new Uri(Source.Server.BaseAddress, "ws"), CancellationToken.None);
            var client = new TestClient(ws);
            var invite = world.Store.CreateInvite(InviteFeature.NewCode(), "test", role, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null, null).Code;
            var welcome = await client.LoginAsync(identity, name, invite);
            return new User(identity, client, welcome);
        }

        public void Dispose()
        {
            Source.Dispose();
            _sourceBase.Dispose();
            Holder.Dispose();
        }
    }

    /// <summary>The holder's address in the tests (its in-memory handler answers any address).</summary>
    private const string Url = "http://localhost";

    internal static async Task<(string Id, string Code)> CreateSpot(User holderOwner, object? body = null)
    {
        var result = (await holderOwner.RequestAsync("buddy.spot.create", body ?? new { label = "Anna's server", url = Url })).Body();
        return (result.GetProperty("spot").GetProperty("id").GetString()!, result.GetProperty("code").GetString()!);
    }

    private static string? ErrorKey(JsonElement frame) =>
        frame.Type() == "error" && frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    internal static async Task<string> PairedAsync(Pair pair, User holderOwner, User sourceOwner)
    {
        var (_, code) = await CreateSpot(holderOwner);
        var added = await sourceOwner.RequestAsync("buddy.add", new { code });
        Assert.Equal("result", added.Type());
        return added.Body().GetProperty("recoveryCode").GetString()!;
    }

    [Fact]
    public void Recovery_and_pairing_codes_read_back()
    {
        var code = BuddyCrypto.NewRecoveryCode();
        var shown = BuddyCrypto.FormatRecoveryCode(code);
        Assert.Matches("^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$", shown);
        Assert.Equal(code, BuddyCrypto.NormalizeRecoveryCode(" " + shown.ToLowerInvariant() + " "));
        Assert.Null(BuddyCrypto.NormalizeRecoveryCode("ABCDE-FGHJK"));
        Assert.Null(BuddyCrypto.NormalizeRecoveryCode(shown + "U"));
        // O, I and L read as 0, 1 and 1.
        Assert.Equal("0".PadRight(25, '1'), BuddyCrypto.NormalizeRecoveryCode("O" + new string('l', 12) + new string('I', 12)));
        // The same code always gives the same restore key; another code another one.
        using var a = BuddyCrypto.RestoreKey(code);
        using var b = BuddyCrypto.RestoreKey(code);
        using var c = BuddyCrypto.RestoreKey(BuddyCrypto.NewRecoveryCode());
        Assert.Equal(Ed25519.PublicKeyOf(a), Ed25519.PublicKeyOf(b));
        Assert.NotEqual(Ed25519.PublicKeyOf(a), Ed25519.PublicKeyOf(c));

        var key = RandomNumberGenerator.GetBytes(32);
        var token = RandomNumberGenerator.GetBytes(32);
        var pairing = BuddyCrypto.DecodePairingCode(BuddyCrypto.EncodePairingCode("https://friend.example/", key, token))!;
        Assert.Equal("https://friend.example", pairing.Url);
        Assert.Equal(key, pairing.HolderKey);
        Assert.Equal(token, pairing.Token);
        Assert.Null(BuddyCrypto.DecodePairingCode("iskra-buddy:not base64!"));
        Assert.Null(BuddyCrypto.DecodePairingCode("hello"));
        Assert.Null(BuddyCrypto.DecodePairingCode("iskra-buddy:" + new string('A', 2000)));
    }

    [Fact]
    public async Task Addresses_follow_the_connection_rules()
    {
        Assert.Equal("http://localhost:4000", await BuddyHttp.CheckUrlAsync("http://localhost:4000/", localOnly: true, default));
        Assert.Equal("http://192.168.1.20:47070", await BuddyHttp.CheckUrlAsync("http://192.168.1.20:47070", localOnly: false, default));
        Assert.Equal("https://8.8.8.8", await BuddyHttp.CheckUrlAsync("https://8.8.8.8", localOnly: false, default));
        // LocalOnly servers only pair over localhost; plain http never crosses the internet; never link-local.
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("http://192.168.1.20:47070", localOnly: true, default));
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("http://8.8.8.8", localOnly: false, default));
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("https://169.254.169.254", localOnly: false, default));
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("https://user:pw@friend.example", localOnly: false, default));
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("ftp://friend.example", localOnly: false, default));
        Assert.False(BuddyHttp.MayConnect(IPAddress.Parse("169.254.169.254"), localOnly: false, plainHttp: false));
        Assert.True(BuddyHttp.MayConnect(IPAddress.Loopback, localOnly: true, plainHttp: true));
        Assert.False(BuddyHttp.MayConnect(IPAddress.Parse("10.0.0.2"), localOnly: true, plainHttp: false));
        // Regression: a server that isn't LocalOnly never reaches its own machine, and a code can't pick the path.
        Assert.False(BuddyHttp.MayConnect(IPAddress.Loopback, localOnly: false, plainHttp: true));
        Assert.False(BuddyHttp.MayConnect(IPAddress.IPv6Loopback, localOnly: false, plainHttp: false));
        Assert.True(BuddyHttp.MayConnect(IPAddress.Loopback, localOnly: false, plainHttp: true, allowLoopback: true));
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("http://127.0.0.1:8080", localOnly: false, default));
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("http://localhost:4000/admin", localOnly: true, default));
        await Assert.ThrowsAsync<Protocol.RequestException>(() => BuddyHttp.CheckUrlAsync("https://friend.example/x/", localOnly: false, default));
        Assert.Equal("http://localhost:4000", await BuddyHttp.CheckUrlAsync("http://localhost:4000", localOnly: false, default, allowLoopback: true));
    }

    [Fact]
    public async Task A_paired_source_sends_its_daily_backup_and_the_holder_cannot_read_it()
    {
        using var pair = new Pair();
        using var holderOwner = await pair.Holder.JoinAsync("Holder owner", "owner");
        using var sourceOwner = await pair.SourceOwnerAsync();
        await sourceOwner.RequestAsync("chat.send", new { channelId = pair.SourceWorld.Store.AllChannels().Single(c => c.Name == "general").Id, text = "a secret only the source knows" });

        var (spotId, code) = await CreateSpot(holderOwner, new { label = "Anna's server", quotaMb = 500, keep = 4, graceDays = 3, url = Url });
        Assert.StartsWith("iskra-buddy:", code);
        var waiting = (await holderOwner.RequestAsync("buddy.spots")).Body().GetProperty("spots")[0];
        Assert.Equal("waiting", waiting.GetProperty("state").GetString());

        var added = (await sourceOwner.RequestAsync("buddy.add", new { code })).Body();
        var recovery = added.GetProperty("recoveryCode").GetString()!;
        Assert.NotNull(BuddyCrypto.NormalizeRecoveryCode(recovery));
        var buddy = added.GetProperty("buddies")[0];
        Assert.Equal("My Iskra server", buddy.GetProperty("name").GetString());
        Assert.Equal(500L * 1024 * 1024, buddy.GetProperty("quotaBytes").GetInt64());
        Assert.Equal(4, buddy.GetProperty("keep").GetInt32());
        // Shown once; asking again gives the same code (and is logged), the next buddy doesn't make a new one.
        Assert.Equal(recovery, (await sourceOwner.RequestAsync("buddy.recoveryCode")).Body().GetProperty("recoveryCode").GetString());

        var spot = (await holderOwner.RequestAsync("buddy.spots")).Body().GetProperty("spots")[0];
        Assert.Equal("active", spot.GetProperty("state").GetString());
        Assert.Equal(Ed25519.ToB64u(pair.SourceWorld.ServerPublicKey), spot.GetProperty("sourceKey").GetString());

        // "Back up now": today's daily backup, then the upload.
        Assert.Equal("result", (await sourceOwner.RequestAsync("buddy.backupNow")).Type());
        await pair.SourceBuddies.RunOnceAsync(default);
        var status = (await sourceOwner.RequestAsync("buddy.status")).Body().GetProperty("buddies")[0];
        Assert.Equal(JsonValueKind.Null, status.GetProperty("error").ValueKind);
        Assert.StartsWith("auto-", status.GetProperty("lastOk").GetProperty("name").GetString());

        spot = (await holderOwner.RequestAsync("buddy.spots")).Body().GetProperty("spots")[0];
        var version = spot.GetProperty("versions")[0];
        Assert.Equal(spot.GetProperty("used").GetInt64(), version.GetProperty("size").GetInt64());
        var blob = await File.ReadAllBytesAsync(Path.Combine(pair.Holder.WorldPath, "buddy-held", spotId, version.GetProperty("id").GetString() + ".blob"));

        // Opaque to the holder: the backup format, nothing readable, and its passphrase is only the recovery code.
        Assert.True(BackupFile.LooksEncrypted(blob));
        Assert.Equal(-1, IndexOf(blob, "SQLite format 3"u8.ToArray()));
        Assert.Equal(-1, IndexOf(blob, "a secret only the source knows"u8.ToArray()));
        Assert.Equal(-1, IndexOf(blob, "PK\u0003\u0004"u8.ToArray()));
        Assert.Throws<CryptographicException>(() => BackupFile.Decrypt(new MemoryStream(blob), "not the code at all"));
        var (header, plain) = BackupFile.Decrypt(new MemoryStream(blob), BuddyCrypto.NormalizeRecoveryCode(recovery)!);
        Assert.Equal(Ed25519.ToB64u(pair.SourceWorld.ServerPublicKey), header.ServerKey);
        using (var zip = new System.IO.Compression.ZipArchive(plain)) Assert.NotNull(zip.GetEntry("iskra.db"));

        // Up to date: nothing is sent twice.
        await pair.SourceBuddies.RunOnceAsync(default);
        Assert.Single((await holderOwner.RequestAsync("buddy.spots")).Body().GetProperty("spots")[0].GetProperty("versions").EnumerateArray());

        // Both security logs, and never the code.
        var sourceLog = pair.SourceWorld.Store.SecurityEvents(null, null, null, 100);
        Assert.Contains(sourceLog, e => e.Event == "buddy.added");
        Assert.Contains(sourceLog, e => e.Event == "buddy.recovery.shown");
        var holderLog = pair.Holder.World.Store.SecurityEvents(null, null, null, 100);
        Assert.Contains(holderLog, e => e.Event == "buddy.spot.created");
        Assert.Contains(holderLog, e => e.Event == "buddy.spot.paired");
        var normalized = BuddyCrypto.NormalizeRecoveryCode(recovery)!;
        Assert.DoesNotContain(sourceLog.Concat(holderLog), e => (e.Details ?? "").Contains(normalized[..10]) || (e.Details ?? "").Contains(recovery[..10]));
        Assert.DoesNotContain(holderLog, e => (e.Details ?? "").Contains(code[12..40]));

        // The copies are never in the holder's own backups.
        Assert.True(pair.Holder.Services.GetRequiredService<BackupService>().RunDaily());
        var local = pair.Holder.Services.GetRequiredService<BackupService>().LocalBackups()[0];
        using (var zip = System.IO.Compression.ZipFile.OpenRead(Path.Combine(pair.Holder.WorldPath, "backups", local.Name)))
            Assert.DoesNotContain(zip.Entries, e => e.FullName.Contains("buddy-held"));
    }

    [Fact]
    public async Task The_recovery_code_restores_the_server_and_a_changed_copy_is_refused()
    {
        using var pair = new Pair();
        using var holderOwner = await pair.Holder.JoinAsync("Holder owner", "owner");
        using var sourceOwner = await pair.SourceOwnerAsync();
        var recovery = await PairedAsync(pair, holderOwner, sourceOwner);
        await sourceOwner.RequestAsync("buddy.backupNow");
        await pair.SourceBuddies.RunOnceAsync(default);
        using var http = pair.Http();

        // Listing needs the code.
        Assert.Single(await BuddyRestore.ListAsync(http, "http://localhost", recovery, default));
        var wrong = await Assert.ThrowsAsync<InvalidDataException>(() => BuddyRestore.ListAsync(http, "http://localhost", BuddyCrypto.FormatRecoveryCode(BuddyCrypto.NewRecoveryCode()), default));
        Assert.Contains("isn't known there", wrong.Message);
        await Assert.ThrowsAsync<InvalidDataException>(() => BuddyRestore.ListAsync(http, "http://localhost", "not a code", default));

        var target = Path.Combine(Path.GetTempPath(), $"iskra-buddy-restored-{Guid.NewGuid():N}");
        try
        {
            var restored = await BuddyRestore.RestoreAsync(http, "http://localhost", recovery.ToLowerInvariant(), target, null, null, default);
            Assert.Equal(Ed25519.ToB64u(pair.SourceWorld.ServerPublicKey), restored.ServerKey);
            using (var world = World.OpenOrCreate(target))
            {
                // The restored server knows its buddy and its code: it carries on sending there.
                Assert.Single(world.Store.Buddies());
                Assert.Equal(BuddyCrypto.NormalizeRecoveryCode(recovery), world.Store.BuddyRecoveryCode());
            }
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        }
        finally
        {
            try { Directory.Delete(target, true); } catch (IOException) { }
        }

        // The holder (or anyone on the way) changes a byte: the restore fails and leaves nothing behind.
        var spotId = pair.Holder.World.Store.BuddySpots().Single().Id;
        var blobPath = Directory.EnumerateFiles(Path.Combine(pair.Holder.WorldPath, "buddy-held", spotId), "*.blob").Single();
        var blob = await File.ReadAllBytesAsync(blobPath);
        blob[blob.Length / 2] ^= 0x40;
        await File.WriteAllBytesAsync(blobPath, blob);
        var target2 = Path.Combine(Path.GetTempPath(), $"iskra-buddy-restored-{Guid.NewGuid():N}");
        await Assert.ThrowsAnyAsync<Exception>(() => BuddyRestore.RestoreAsync(http, "http://localhost", recovery, target2, null, null, default));
        Assert.False(Directory.Exists(target2));
    }

    [Fact]
    public async Task Only_signed_requests_from_paired_servers_are_answered()
    {
        using var pair = new Pair();
        using var holderOwner = await pair.Holder.JoinAsync("Holder owner", "owner");
        using var sourceOwner = await pair.SourceOwnerAsync();
        var recovery = await PairedAsync(pair, holderOwner, sourceOwner);
        using var client = pair.Holder.CreateClient();
        var holderKey = pair.Holder.World.ServerPublicKey;
        var sourceKey = pair.SourceWorld.ServerKey;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        async Task<HttpStatusCode> Send(HttpMethod method, string path, string? auth, byte[]? body = null)
        {
            using var request = new HttpRequestMessage(method, path);
            if (auth is not null) request.Headers.TryAddWithoutValidation("Authorization", auth);
            if (body is not null) request.Content = new ByteArrayContent(body);
            using var response = await client.SendAsync(request);
            return response.StatusCode;
        }

        Assert.Equal(HttpStatusCode.OK, await Send(HttpMethod.Get, "/buddy/v1/hello", null));
        Assert.Equal(HttpStatusCode.Unauthorized, await Send(HttpMethod.Get, "/buddy/v1/spot", null));
        // A stranger's key.
        using var stranger = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        Assert.Equal(HttpStatusCode.Unauthorized, await Send(HttpMethod.Get, "/buddy/v1/spot", BuddyCrypto.Authorization(stranger, holderKey, now, "GET", "/buddy/v1/spot", [])));
        // Signed for another holder, another path, or long ago.
        Assert.Equal(HttpStatusCode.Unauthorized, await Send(HttpMethod.Get, "/buddy/v1/spot", BuddyCrypto.Authorization(sourceKey, RandomNumberGenerator.GetBytes(32), now, "GET", "/buddy/v1/spot", [])));
        Assert.Equal(HttpStatusCode.Unauthorized, await Send(HttpMethod.Get, "/buddy/v1/spot", BuddyCrypto.Authorization(sourceKey, holderKey, now, "GET", "/buddy/v1/uploads", [])));
        Assert.Equal(HttpStatusCode.Unauthorized, await Send(HttpMethod.Get, "/buddy/v1/spot", BuddyCrypto.Authorization(sourceKey, holderKey, now - 10 * 60_000, "GET", "/buddy/v1/spot", [])));
        // The body is signed too.
        var begin = Encoding.UTF8.GetBytes("""{"size":1000}""");
        Assert.Equal(HttpStatusCode.Unauthorized, await Send(HttpMethod.Post, "/buddy/v1/uploads",
            BuddyCrypto.Authorization(sourceKey, holderKey, now, "POST", "/buddy/v1/uploads", Encoding.UTF8.GetBytes("""{"size":1}""")), begin));
        // The real thing works once; the same signature again is a replay.
        var good = BuddyCrypto.Authorization(sourceKey, holderKey, now, "GET", "/buddy/v1/spot", []);
        Assert.Equal(HttpStatusCode.OK, await Send(HttpMethod.Get, "/buddy/v1/spot", good));
        Assert.Equal(HttpStatusCode.Unauthorized, await Send(HttpMethod.Get, "/buddy/v1/spot", good));

        // The restore key can list and download, never upload or unpair.
        using var restoreKey = BuddyCrypto.RestoreKey(BuddyCrypto.NormalizeRecoveryCode(recovery)!);
        Assert.Equal(HttpStatusCode.OK, await Send(HttpMethod.Get, "/buddy/v1/spot", BuddyCrypto.Authorization(restoreKey, holderKey, now, "GET", "/buddy/v1/spot", [])));
        Assert.Equal(HttpStatusCode.Forbidden, await Send(HttpMethod.Post, "/buddy/v1/uploads", BuddyCrypto.Authorization(restoreKey, holderKey, now, "POST", "/buddy/v1/uploads", begin), begin));
        Assert.Equal(HttpStatusCode.Forbidden, await Send(HttpMethod.Delete, "/buddy/v1/spot", BuddyCrypto.Authorization(restoreKey, holderKey, now, "DELETE", "/buddy/v1/spot", [])));
        Assert.Contains(pair.Holder.World.Store.SecurityEvents("buddy.auth.failed", null, null, 100), e => e.Details!.Contains("replay"));

        // Too many refused requests from one address: 429.
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 15; i++) codes.Add(await Send(HttpMethod.Get, "/buddy/v1/spot", null));
        Assert.Contains(HttpStatusCode.TooManyRequests, codes);
    }

    [Fact]
    public async Task The_holder_enforces_its_quota_versions_and_upload_rules()
    {
        using var holder = new IskraServer { Settings = Quick };
        using var holderOwner = await holder.JoinAsync("Holder owner", "owner");
        // Fewer than 3 copies isn't allowed: daily copies would never get old enough to be the protected one.
        Assert.Equal("bad_request", (await holderOwner.RequestAsync("buddy.spot.create", new { label = "Bo", keep = 2, url = Url })).ErrorCode());
        var (spotId, code) = await CreateSpot(holderOwner, new { label = "Bo", quotaMb = 100, keep = 3, url = Url });
        using var http = new BuddyHttp(holder.Server.CreateHandler(), localOnly: true);
        using var source = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        using var restore = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var pairing = BuddyCrypto.DecodePairingCode(code)! with { Url = "http://localhost" };
        var paired = await http.PairAsync(pairing, source, restore, "Bo's server", Now(), default);
        Assert.Equal(spotId, paired.SpotId);
        // Single use.
        using var other = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        Assert.Equal(404, (await Assert.ThrowsAsync<BuddyHttpException>(() => http.PairAsync(pairing, other, restore, "Other", Now(), default))).Status);
        var holderKey = pairing.HolderKey;
        const string url = "http://localhost";

        // Over the quota: refused before anything is sent.
        Assert.Equal(413, (await Assert.ThrowsAsync<BuddyHttpException>(() => http.BeginUploadAsync(url, holderKey, source, 101L * 1024 * 1024, Now(), default))).Status);

        async Task<BuddyVersion> Upload(byte[] data)
        {
            var (id, received, chunk) = await http.BeginUploadAsync(url, holderKey, source, data.Length, Now(), default);
            Assert.Equal(0, received);
            while (received < data.Length)
            {
                var part = data[(int)received..(int)Math.Min(data.Length, received + chunk)];
                received = await http.PutPartAsync(url, holderKey, source, id, received, part, Now(), default);
            }
            return await http.FinishAsync(url, holderKey, source, id, Convert.ToHexStringLower(SHA256.HashData(data)), Now(), default);
        }

        // Parts must come in order; a resumed upload asks where it stands.
        var data = RandomNumberGenerator.GetBytes(5 * 1024 * 1024);
        var (uploadId, _, chunkBytes) = await http.BeginUploadAsync(url, holderKey, source, data.Length, Now(), default);
        Assert.Equal(4 * 1024 * 1024, chunkBytes);
        await http.PutPartAsync(url, holderKey, source, uploadId, 0, data[..1000], Now(), default);
        var skipped = await Assert.ThrowsAsync<BuddyHttpException>(() => http.PutPartAsync(url, holderKey, source, uploadId, 5000, data[5000..6000], Now(), default));
        Assert.Equal((409, 1000L), (skipped.Status, skipped.Received));
        Assert.Equal(1000, await http.UploadReceivedAsync(url, holderKey, source, uploadId, Now(), default));
        // Unfinished: can't be finished. A wrong hash drops the upload.
        Assert.Equal(409, (await Assert.ThrowsAsync<BuddyHttpException>(() => http.FinishAsync(url, holderKey, source, uploadId, new string('0', 64), Now(), default))).Status);
        // Parts are at most 4 MB.
        Assert.Equal(413, (await Assert.ThrowsAsync<BuddyHttpException>(() => http.PutPartAsync(url, holderKey, source, uploadId, 1000, data[1000..], Now(), default))).Status);
        var middle = 1000 + chunkBytes;
        await http.PutPartAsync(url, holderKey, source, uploadId, 1000, data[1000..middle], Now(), default);
        await http.PutPartAsync(url, holderKey, source, uploadId, middle, data[middle..], Now(), default);
        Assert.Equal(422, (await Assert.ThrowsAsync<BuddyHttpException>(() => http.FinishAsync(url, holderKey, source, uploadId, new string('0', 64), Now(), default))).Status);
        Assert.Null(await http.UploadReceivedAsync(url, holderKey, source, uploadId, Now(), default));

        // Keep 3: all three stay.
        var first = await Upload(RandomNumberGenerator.GetBytes(3000));
        var second = await Upload(RandomNumberGenerator.GetBytes(4000));
        var third = await Upload(RandomNumberGenerator.GetBytes(5000));
        var spot = await http.SpotAsync(url, holderKey, source, Now(), default);
        Assert.Equal([third.Id, second.Id, first.Id], spot.Versions.Select(v => v.Id));
        Assert.Equal(12000, spot.Used);
        // What comes back is exactly what went in.
        using (var got = new MemoryStream())
        {
            await http.DownloadAsync(url, holderKey, restore, third.Id, got, third.Size, Now(), null, default);
            Assert.Equal(5000, got.Length);
        }
        // At most 3 finished uploads a day per spot.
        Assert.Equal(429, (await Assert.ThrowsAsync<BuddyHttpException>(() => http.BeginUploadAsync(url, holderKey, source, 1000, Now(), default))).Status);

        // A smaller quota: the next prune keeps only what fits (but never the newest).
        Assert.Equal("result", (await holderOwner.RequestAsync("buddy.spot.update", new { id = spotId, keep = 5, label = "Bo again" })).Type());
        var view = (await holderOwner.RequestAsync("buddy.spots")).Body().GetProperty("spots")[0];
        Assert.Equal(5, view.GetProperty("keep").GetInt32());
        Assert.Equal("Bo again", view.GetProperty("label").GetString());
    }

    [Fact]
    public async Task Removing_from_either_side_keeps_the_copies_for_the_grace_period()
    {
        using var pair = new Pair();
        using var holderOwner = await pair.Holder.JoinAsync("Holder owner", "owner");
        using var sourceOwner = await pair.SourceOwnerAsync();
        var recovery = await PairedAsync(pair, holderOwner, sourceOwner);
        await sourceOwner.RequestAsync("buddy.backupNow");
        await pair.SourceBuddies.RunOnceAsync(default);
        var spotId = pair.Holder.World.Store.BuddySpots().Single().Id;

        // The holder's owner removes the spot: uploads stop, the copies stay until deleteAt.
        var removed = (await holderOwner.RequestAsync("buddy.spot.remove", new { id = spotId })).Body().GetProperty("spots")[0];
        Assert.Equal("removing", removed.GetProperty("state").GetString());
        var deleteAt = removed.GetProperty("deleteAt").GetInt64();
        Assert.InRange(deleteAt - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), 6.9 * BuddyHolder.DayMs, 7 * BuddyHolder.DayMs);
        // A new daily backup can't go there any more: the source shows why.
        File.Move(Directory.EnumerateFiles(Path.Combine(pair.SourcePath, "backups"), "auto-*.zip").Single(),
            Path.Combine(pair.SourcePath, "backups", "auto-2099-01-01.zip"));
        await pair.SourceBuddies.RunOnceAsync(default);
        var buddy = (await sourceOwner.RequestAsync("buddy.status")).Body().GetProperty("buddies")[0];
        Assert.True(buddy.GetProperty("removed").GetBoolean());
        Assert.Equal("buddy_removed", buddy.GetProperty("error").GetProperty("key").GetString());
        // A restore still works during the grace period.
        using var http = pair.Http();
        Assert.Single(await BuddyRestore.ListAsync(http, "http://localhost", recovery, default));

        // After the grace period the sweep deletes everything.
        pair.Holder.World.Store.RemoveBuddySpotLater(spotId, 1);
        pair.HolderSide.Sweep();
        Assert.Empty(pair.Holder.World.Store.BuddySpots());
        Assert.False(Directory.Exists(Path.Combine(pair.Holder.WorldPath, "buddy-held", spotId)));
        Assert.Contains(pair.Holder.World.Store.SecurityEvents("buddy.spot.deleted", null, null, 10), _ => true);
        await Assert.ThrowsAsync<InvalidDataException>(() => BuddyRestore.ListAsync(http, "http://localhost", recovery, default));

        // The source removes a buddy: the holder keeps that spot's copies for the grace period too.
        var (secondSpot, code) = await CreateSpot(holderOwner, new { label = "Again", graceDays = 2, url = Url });
        await sourceOwner.RequestAsync("buddy.remove", new { id = buddy.GetProperty("id").GetString() });
        Assert.Equal("result", (await sourceOwner.RequestAsync("buddy.add", new { code })).Type());
        var again = (await sourceOwner.RequestAsync("buddy.status")).Body().GetProperty("buddies")[0].GetProperty("id").GetString();
        Assert.Equal("result", (await sourceOwner.RequestAsync("buddy.remove", new { id = again })).Type());
        Assert.Empty((await sourceOwner.RequestAsync("buddy.status")).Body().GetProperty("buddies").EnumerateArray());
        var held = pair.Holder.World.Store.GetBuddySpot(secondSpot)!;
        Assert.NotNull(held.DeleteAt);
        Assert.Contains(pair.Holder.World.Store.SecurityEvents("buddy.spot.removed", null, null, 10), e => e.Details!.Contains("\"source\""));

        // A spot nobody paired with goes at once; unused codes expire.
        var (waiting, _) = await CreateSpot(holderOwner, new { label = "Never used", url = Url });
        await holderOwner.RequestAsync("buddy.spot.remove", new { id = waiting });
        Assert.Null(pair.Holder.World.Store.GetBuddySpot(waiting));
    }

    [Fact]
    public async Task Pairing_problems_are_explained_and_only_the_owner_may_ask()
    {
        using var pair = new Pair();
        using var holderOwner = await pair.Holder.JoinAsync("Holder owner", "owner");
        using var holderAdmin = await pair.Holder.JoinAsync("Holder admin", "admin");
        using var sourceOwner = await pair.SourceOwnerAsync();

        Assert.Equal("owner_backup", ErrorKey(await holderAdmin.RequestAsync("buddy.spots")));
        Assert.Equal("owner_backup", ErrorKey(await holderAdmin.RequestAsync("buddy.spot.create", new { label = "x" })));
        Assert.Equal("owner_backup", ErrorKey(await holderAdmin.RequestAsync("buddy.status")));
        Assert.Equal("buddy_label", ErrorKey(await holderOwner.RequestAsync("buddy.spot.create", new { label = " " })));
        Assert.Equal("bad_request", (await holderOwner.RequestAsync("buddy.spot.create", new { label = "x", quotaMb = 5 })).ErrorCode());
        Assert.Equal("buddy_address", ErrorKey(await holderOwner.RequestAsync("buddy.spot.create", new { label = "x", url = "ftp://nope" })));

        Assert.Equal("buddy_code", ErrorKey(await sourceOwner.RequestAsync("buddy.add", new { code = "hello" })));
        Assert.Equal("not_found", (await sourceOwner.RequestAsync("buddy.recoveryCode")).ErrorCode());
        // Your own server's code.
        var own = (await sourceOwner.RequestAsync("buddy.spot.create", new { label = "Me", url = Url })).Body().GetProperty("code").GetString();
        Assert.Equal("buddy_self", ErrorKey(await sourceOwner.RequestAsync("buddy.add", new { code = own })));
        // A code whose key isn't the holder's: the holder doesn't accept the pairing, nothing is saved.
        var (_, code) = await CreateSpot(holderOwner);
        var real = BuddyCrypto.DecodePairingCode(code)!;
        var forged = BuddyCrypto.EncodePairingCode(real.Url, RandomNumberGenerator.GetBytes(32), real.Token);
        Assert.NotNull(ErrorKey(await sourceOwner.RequestAsync("buddy.add", new { code = forged })));
        Assert.Empty(pair.SourceWorld.Store.Buddies());
        // The real one works once.
        Assert.Equal("result", (await sourceOwner.RequestAsync("buddy.add", new { code })).Type());
        Assert.Equal("buddy_already", ErrorKey(await sourceOwner.RequestAsync("buddy.add", new { code })));
        // Back up now needs daily backups on.
        await sourceOwner.RequestAsync("backup.settings", new { enabled = false });
        Assert.Equal("buddy_backups_off", ErrorKey(await sourceOwner.RequestAsync("buddy.backupNow")));
        await pair.SourceBuddies.RunOnceAsync(default);
        var status = (await sourceOwner.RequestAsync("buddy.status")).Body();
        Assert.False(status.GetProperty("autoEnabled").GetBoolean());
        Assert.Equal("buddy_backups_off", status.GetProperty("buddies")[0].GetProperty("error").GetProperty("key").GetString());
    }

    /// <summary>A holder with one fake source paired to a spot (keep, quota), and an upload helper.</summary>
    private sealed class Held : IDisposable
    {
        public IskraServer Holder { get; } = new() { Settings = Quick };
        public BuddyHttp Http { get; }
        public NSec.Cryptography.Key Source { get; } = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        public NSec.Cryptography.Key Restore { get; } = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        public byte[] HolderKey => Holder.World.ServerPublicKey;
        public string SpotId { get; private set; } = "";
        public const string At = "http://localhost";

        public Held() => Http = new BuddyHttp(Holder.Server.CreateHandler(), localOnly: true);

        public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        public async Task<User> PairAsync(object spot)
        {
            var owner = await Holder.JoinAsync("Holder owner", "owner");
            var (id, code) = await CreateSpot(owner, spot);
            SpotId = id;
            await Http.PairAsync(BuddyCrypto.DecodePairingCode(code)! with { Url = At }, Source, Restore, "Source", Now(), default);
            return owner;
        }

        public async Task<BuddyVersion> UploadAsync(byte[] data)
        {
            var (id, _, _) = await Http.BeginUploadAsync(At, HolderKey, Source, data.Length, Now(), default);
            await Http.PutPartAsync(At, HolderKey, Source, id, 0, data, Now(), default);
            return await Http.FinishAsync(At, HolderKey, Source, id, Convert.ToHexStringLower(SHA256.HashData(data)), Now(), default);
        }

        public void Dispose()
        {
            Http.Dispose();
            Source.Dispose();
            Restore.Dispose();
            Holder.Dispose();
        }
    }

    [Fact]
    public async Task Regression_a_source_taken_over_cannot_flush_the_last_good_copy()
    {
        using var held = new Held();
        using var owner = await held.PairAsync(new { label = "Bo", quotaMb = 100, keep = 3, graceDays = 0, url = Url });
        var good = await held.UploadAsync(RandomNumberGenerator.GetBytes(3000));
        // Two days later the source starts sending junk.
        held.Holder.World.Store.SetBuddyVersionAt(good.Id, Held.Now() - 49 * 60 * 60 * 1000L);
        // A copy as big as the whole quota would push the good one out: refused.
        Assert.Equal(413, (await Assert.ThrowsAsync<BuddyHttpException>(() =>
            held.Http.BeginUploadAsync(Held.At, held.HolderKey, held.Source, 100L * 1024 * 1024, Held.Now(), default))).Status);
        // Junk replaces junk (over several days: the daily limit is reset here), never the protected copy.
        var junk = new List<BuddyVersion>();
        for (var i = 0; i < 4; i++)
        {
            held.Holder.World.Store.BuddySpotUploaded(held.SpotId, Held.Now(), "[]");
            junk.Add(await held.UploadAsync(RandomNumberGenerator.GetBytes(1000)));
        }
        var ids = (await held.Http.SpotAsync(Held.At, held.HolderKey, held.Restore, Held.Now(), default)).Versions.Select(v => v.Id).ToList();
        Assert.Equal([junk[3].Id, junk[2].Id, junk[1].Id, good.Id], ids);

        // The source removing itself can't skip the grace period, even when the spot's is 0 days.
        using var request = new HttpRequestMessage(HttpMethod.Delete, "/buddy/v1/spot");
        request.Headers.TryAddWithoutValidation("Authorization", BuddyCrypto.Authorization(held.Source, held.HolderKey, Held.Now(), "DELETE", "/buddy/v1/spot", []));
        using var client = held.Holder.CreateClient();
        using var removed = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, removed.StatusCode);
        var spot = held.Holder.World.Store.GetBuddySpot(held.SpotId)!;
        Assert.InRange(spot.DeleteAt!.Value - Held.Now(), BuddyHolder.DayMs - 60_000, BuddyHolder.DayMs);
        Assert.Equal(4, held.Holder.World.Store.BuddyVersions(held.SpotId).Count);
        // The holder's own owner may still delete at once.
        await owner.RequestAsync("buddy.spot.remove", new { id = held.SpotId, now = true });
        Assert.Null(held.Holder.World.Store.GetBuddySpot(held.SpotId));
    }

    [Fact]
    public async Task Regression_with_no_copy_two_days_old_the_oldest_one_is_protected()
    {
        using var held = new Held();
        using var owner = await held.PairAsync(new { label = "Bo", quotaMb = 100, keep = 3, url = Url });
        // A flood right after the last good copy (nothing is 48 hours old yet): the good one still stays.
        var good = await held.UploadAsync(RandomNumberGenerator.GetBytes(3000));
        var junk = new List<BuddyVersion>();
        for (var i = 0; i < 5; i++)
        {
            held.Holder.World.Store.BuddySpotUploaded(held.SpotId, Held.Now(), "[]");
            junk.Add(await held.UploadAsync(RandomNumberGenerator.GetBytes(1000)));
        }
        var ids = held.Holder.World.Store.BuddyVersions(held.SpotId).Select(v => v.Id).ToList();
        Assert.Equal([junk[4].Id, junk[3].Id, junk[2].Id, good.Id], ids);
        // And an upload must fit beside it.
        held.Holder.World.Store.BuddySpotUploaded(held.SpotId, Held.Now(), "[]");
        Assert.Equal(413, (await Assert.ThrowsAsync<BuddyHttpException>(() =>
            held.Http.BeginUploadAsync(Held.At, held.HolderKey, held.Source, 100L * 1024 * 1024 - 2000, Held.Now(), default))).Status);
    }

    [Fact]
    public async Task Regression_a_restore_key_must_be_held_and_every_key_is_used_once()
    {
        using var held = new Held();
        using var owner = await held.PairAsync(new { label = "Bo", url = Url });
        using var client = held.Holder.CreateClient();

        async Task<HttpStatusCode> Pair(NSec.Cryptography.Key source, byte[] restoreKey, Func<byte[], byte[]> restoreSig)
        {
            var (_, code) = await CreateSpot(owner, new { label = "Other", url = Url });
            var pairing = BuddyCrypto.DecodePairingCode(code)!;
            var now = Held.Now();
            var sourceKey = Ed25519.PublicKeyOf(source);
            var body = JsonSerializer.Serialize(new
            {
                token = Ed25519.ToB64u(pairing.Token), sourceKey = Ed25519.ToB64u(sourceKey), restoreKey = Ed25519.ToB64u(restoreKey), name = "Other", at = now,
                sig = Ed25519.ToB64u(Ed25519.Sign(source, BuddyCrypto.PairPayload(pairing.HolderKey, pairing.Token, restoreKey, now, "Other"))),
                restoreSig = Ed25519.ToB64u(restoreSig(BuddyCrypto.PairRestorePayload(pairing.HolderKey, pairing.Token, sourceKey, now))),
            });
            using var response = await client.PostAsync("/buddy/v1/pair", new StringContent(body, Encoding.UTF8, "application/json"));
            return response.StatusCode;
        }

        using var attacker = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        // Registering someone else's public key (here the paired source's) as a restore key: no signature, no pairing.
        var victim = Ed25519.PublicKeyOf(held.Source);
        Assert.Equal(HttpStatusCode.BadRequest, await Pair(attacker, victim, payload => Ed25519.Sign(attacker, payload)));
        // Keys already in use, as a source or a restore key, in either direction.
        Assert.Equal(HttpStatusCode.Conflict, await Pair(attacker, Ed25519.PublicKeyOf(held.Restore), payload => Ed25519.Sign(held.Restore, payload)));
        using var fresh = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        Assert.Equal(HttpStatusCode.Conflict, await Pair(held.Restore, Ed25519.PublicKeyOf(fresh), payload => Ed25519.Sign(fresh, payload)));
        // The same key as source and restore key isn't allowed either.
        Assert.Equal(HttpStatusCode.BadRequest, await Pair(fresh, Ed25519.PublicKeyOf(fresh), payload => Ed25519.Sign(fresh, payload)));
        // A proper pairing still works.
        using var restore = Ed25519.KeyFromSeed(Ed25519.NewSeed());
        Assert.Equal(HttpStatusCode.OK, await Pair(attacker, Ed25519.PublicKeyOf(restore), payload => Ed25519.Sign(restore, payload)));
    }

    /// <summary>A holder that answers every part with what the test says.</summary>
    private sealed class PartsAnswer(HttpMessageHandler inner, Func<long, long, HttpResponseMessage> answer) : DelegatingHandler(inner)
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
        {
            if (request.Method != HttpMethod.Put) return await base.SendAsync(request, cancel);
            var offset = long.Parse(request.RequestUri!.Query.Split('=')[1]);
            var length = (await request.Content!.ReadAsByteArrayAsync(cancel)).Length;
            return answer(offset, length);
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, object body) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    [Theory]
    [InlineData("rewind")]
    [InlineData("overclaim")]
    [InlineData("creep")]
    public async Task Regression_a_holder_that_lies_about_parts_fails_the_sync(string lie)
    {
        var puts = 0;
        using var pair = new Pair(inner => new PartsAnswer(inner, (offset, length) =>
        {
            puts++;
            return lie switch
            {
                "rewind" => Json(HttpStatusCode.Conflict, new { received = 0 }),
                // One byte further each time: would resend a part per byte forever.
                "creep" => Json(HttpStatusCode.Conflict, new { received = offset + 1 }),
                _ => Json(HttpStatusCode.OK, new { received = offset + length + 1 }),
            };
        }));
        using var holderOwner = await pair.Holder.JoinAsync("Holder owner", "owner");
        using var sourceOwner = await pair.SourceOwnerAsync();
        await PairedAsync(pair, holderOwner, sourceOwner);
        await sourceOwner.RequestAsync("buddy.backupNow");
        await pair.SourceBuddies.RunOnceAsync(default);
        var buddy = (await sourceOwner.RequestAsync("buddy.status")).Body().GetProperty("buddies")[0];
        Assert.Equal("buddy_failed", buddy.GetProperty("error").GetProperty("key").GetString());
        Assert.InRange(puts, 1, 2 * (BuddyBackupService.MaxRewinds + 2));
    }

    [Fact]
    public async Task Regression_answers_are_never_buffered_past_a_mebibyte()
    {
        var huge = new FakeHandler(() => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(new MemoryStream(new byte[3 * 1024 * 1024])), // no length: as if chunked
        });
        using var http = new BuddyHttp(huge, localOnly: true);
        await Assert.ThrowsAnyAsync<Exception>(() => http.HelloAsync("http://localhost", default));
        Assert.Equal(1024 * 1024, BuddyHttp.MaxJsonBytes);
    }

    private sealed class FakeHandler(Func<HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel) => Task.FromResult(answer());
    }

    [Fact]
    public void Regression_restores_check_the_size_the_holder_reports()
    {
        BuddyRestore.CheckRoom(1000, 10_000, 10_000);
        BuddyRestore.CheckRoom(1000, null, null); // can't tell: carry on
        Assert.Throws<InvalidDataException>(() => BuddyRestore.CheckRoom(0, null, null));
        Assert.Throws<InvalidDataException>(() => BuddyRestore.CheckRoom(BuddyRestore.MaxCopyBytes + 1, null, null));
        Assert.Throws<InvalidDataException>(() => BuddyRestore.CheckRoom(1000, 500, 10_000));
        Assert.Throws<InvalidDataException>(() => BuddyRestore.CheckRoom(1000, 1500, 1500)); // same disk: room for two
    }

    [Fact]
    public void Regression_rate_limits_group_ipv6_by_network_and_restore_buddy_arguments_end_at_double_dash()
    {
        Assert.Equal(BuddyHolder.AddressKey(IPAddress.Parse("2001:db8:1:2::1")), BuddyHolder.AddressKey(IPAddress.Parse("2001:db8:1:2:ffff::9")));
        Assert.NotEqual(BuddyHolder.AddressKey(IPAddress.Parse("2001:db8:1:2::1")), BuddyHolder.AddressKey(IPAddress.Parse("2001:db8:1:3::1")));
        Assert.Equal("192.0.2.4", BuddyHolder.AddressKey(IPAddress.Parse("::ffff:192.0.2.4")));
        Assert.Equal("local", BuddyHolder.AddressKey(null));

        var (positional, version, flags) = Cli.ParseRestoreBuddy(["restore-buddy", "--code-stdin", "--json", "--", "--list", "C:/world"]);
        Assert.Equal(["--list", "C:/world"], positional);
        Assert.Null(version);
        Assert.Equal(["--code-stdin", "--json"], flags.Order());
    }

    [Fact]
    public async Task Regression_requests_signed_before_the_holder_started_are_refused()
    {
        using var held = new Held();
        using var owner = await held.PairAsync(new { label = "Bo", url = Url });
        using var client = held.Holder.CreateClient();
        // Within the clock skew, but from before this start: its nonce may have been seen by the last run.
        using var request = new HttpRequestMessage(HttpMethod.Get, "/buddy/v1/spot");
        request.Headers.TryAddWithoutValidation("Authorization", BuddyCrypto.Authorization(held.Source, held.HolderKey, Held.Now() - 4 * 60_000, "GET", "/buddy/v1/spot", []));
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Contains(held.Holder.World.Store.SecurityEvents("buddy.auth.failed", null, null, 10), e => e.Details!.Contains("before_start"));
    }

    private static int IndexOf(byte[] haystack, byte[] needle)
    {
        for (var i = 0; i <= haystack.Length - needle.Length; i++)
            if (haystack.AsSpan(i, needle.Length).SequenceEqual(needle)) return i;
        return -1;
    }
}
