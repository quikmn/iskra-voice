using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Backups;

/// <summary>The holder answered with something other than success.</summary>
public sealed class BuddyHttpException(int status, string message, long? received = null) : Exception(message)
{
    public int Status { get; } = status;
    /// <summary>On a 409 for a part: how much the holder has.</summary>
    public long? Received { get; } = received;
}

/// <summary>The address isn't one a buddy may be reached at (see PROTOCOL.md → Backup buddies, Connections).</summary>
public sealed class BuddyAddressException(string message) : Exception(message);

public sealed record BuddyVersion(string Id, long Size, long At);

public sealed record BuddySpotInfo(string SpotId, long QuotaBytes, int Keep, int GraceDays, long Used, bool Removing, long? DeleteAt, List<BuddyVersion> Versions);

public sealed record BuddyPaired(string SpotId, long QuotaBytes, int Keep, int GraceDays, string Name);

/// <summary>
/// The one way an Iskra server talks to another Iskra server: a friend's server that keeps our backups. Only to the
/// address in a pairing code, never following redirects; plain http only to loopback and private networks (never
/// link-local), and only loopback from a LocalOnly server. Tests hand in their own handler.
/// </summary>
public sealed class BuddyHttp : IDisposable
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;

    public bool LocalOnly { get; }

    public BuddyHttp(HttpMessageHandler? handler, bool localOnly)
    {
        LocalOnly = localOnly;
        handler ??= new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            UseCookies = false,
            UseProxy = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectCallback = Connect(localOnly),
        };
        _http = new HttpClient(handler) { Timeout = Timeout };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Iskra-Buddy/1");
    }

    // ── Addresses ────────────────────────────────────────────────────────────

    public static bool MayConnect(IPAddress address, bool localOnly, bool plainHttp)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (localOnly) return IPAddress.IsLoopback(address);
        return plainHttp ? OutgoingWebhooks.IsLocalNetwork(address) : LinkPreviews.IsPublic(address) || OutgoingWebhooks.IsLocalNetwork(address);
    }

    private static Func<SocketsHttpConnectionContext, CancellationToken, ValueTask<Stream>> Connect(bool localOnly) =>
        async (context, cancel) =>
        {
            var plain = context.InitialRequestMessage.RequestUri?.Scheme == Uri.UriSchemeHttp;
            var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancel);
            var allowed = addresses.Where(a => MayConnect(a, localOnly, plain)).ToList();
            if (allowed.Count == 0) throw new BuddyAddressException("That address isn't allowed for a backup buddy.");
            Exception? last = null;
            foreach (var address in allowed)
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(address, context.DnsEndPoint.Port, cancel);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch (SocketException ex)
                {
                    socket.Dispose();
                    last = ex;
                }
            }
            throw last!;
        };

    /// <summary>
    /// A buddy's address: http(s), no user name or password, no query or fragment, ≤ 512 characters. Plain http only to a
    /// host that is a loopback or private address (or resolves only to such), a LocalOnly server only to loopback.
    /// Returns the address without a trailing slash, or throws <see cref="Protocol.RequestException"/> (key buddy_address).
    /// </summary>
    public static async Task<string> CheckUrlAsync(string url, bool localOnly, CancellationToken cancel)
    {
        static Protocol.RequestException Bad() =>
            Protocol.RequestException.BadRequest("That address can't be used for a backup buddy.", "buddy_address");
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || uri.Host.Length == 0
            || !string.IsNullOrEmpty(uri.UserInfo) || uri.Query.Length > 0 || uri.Fragment.Length > 0 || url.Length > 512) throw Bad();
        IPAddress[] addresses;
        if (IPAddress.TryParse(uri.Host.Trim('[', ']'), out var literal)) addresses = [literal];
        else
        {
            try { addresses = await Dns.GetHostAddressesAsync(uri.IdnHost, cancel); }
            catch (SocketException) { addresses = []; }
        }
        // A LocalOnly server, or plain http: every address must be allowed (checked again on every connection).
        var plain = uri.Scheme == "http";
        if ((localOnly || plain) && (addresses.Length == 0 || !addresses.All(a => MayConnect(a, localOnly, plain)))) throw Bad();
        if (addresses.Length > 0 && !addresses.Any(a => MayConnect(a, localOnly, plain))) throw Bad();
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    /// <summary>The holder's server key (GET /buddy/v1/hello, unsigned).</summary>
    public async Task<byte[]> HelloAsync(string url, CancellationToken cancel)
    {
        using var response = await _http.GetAsync($"{url}/buddy/v1/hello", cancel);
        await ThrowUnlessOk(response, cancel);
        var hello = await ReadJson(response, cancel);
        if (!Ed25519.TryFromB64u(hello.GetProperty("key").GetString(), out var key) || key.Length != Ed25519.PublicKeySize)
            throw new BuddyHttpException(502, "That isn't an Iskra server that keeps backups.");
        return key;
    }

    /// <summary>Pairs with the spot in the code, and checks the holder's signed answer against the code's key.</summary>
    public async Task<BuddyPaired> PairAsync(BuddyPairingCode code, Key serverKey, byte[] restoreKey, string name, long now, CancellationToken cancel)
    {
        var sourceKey = Ed25519.PublicKeyOf(serverKey);
        var sig = Ed25519.Sign(serverKey, BuddyCrypto.PairPayload(code.HolderKey, code.Token, restoreKey, now, name));
        var body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            token = Ed25519.ToB64u(code.Token), sourceKey = Ed25519.ToB64u(sourceKey), restoreKey = Ed25519.ToB64u(restoreKey),
            name, at = now, sig = Ed25519.ToB64u(sig),
        });
        using var content = new ByteArrayContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var response = await _http.PostAsync($"{code.Url}/buddy/v1/pair", content, cancel);
        await ThrowUnlessOk(response, cancel);
        var answer = await ReadJson(response, cancel);
        try
        {
            var spotId = answer.GetProperty("spotId").GetString() ?? "";
            var at = answer.GetProperty("at").GetInt64();
            if (spotId.Length is 0 or > 64 || !Ed25519.TryFromB64u(answer.GetProperty("sig").GetString(), out var holderSig)
                || !Ed25519.Verify(code.HolderKey, BuddyCrypto.PairedPayload(sourceKey, code.Token, at, spotId), holderSig))
                throw new BuddyHttpException(0, "wrong_server");
            var holderName = answer.GetProperty("name").GetString() ?? "";
            return new BuddyPaired(spotId, answer.GetProperty("quotaBytes").GetInt64(), answer.GetProperty("keep").GetInt32(),
                answer.GetProperty("graceDays").GetInt32(), holderName.Length > 100 ? holderName[..100] : holderName);
        }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException)
        {
            throw new BuddyHttpException(0, "wrong_server");
        }
    }

    private async Task<HttpResponseMessage> SendAsync(string url, byte[] holderKey, Key key, HttpMethod method, string pathAndQuery,
        byte[]? body, long now, CancellationToken cancel, HttpCompletionOption completion = HttpCompletionOption.ResponseContentRead)
    {
        var request = new HttpRequestMessage(method, url + pathAndQuery);
        request.Headers.TryAddWithoutValidation("Authorization", BuddyCrypto.Authorization(key, holderKey, now, method.Method, pathAndQuery, body ?? []));
        if (body is not null)
        {
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(pathAndQuery.Contains("offset=") ? "application/octet-stream" : "application/json");
        }
        try
        {
            return await _http.SendAsync(request, completion, cancel);
        }
        finally
        {
            if (completion == HttpCompletionOption.ResponseContentRead) request.Dispose();
        }
    }

    public async Task<BuddySpotInfo> SpotAsync(string url, byte[] holderKey, Key key, long now, CancellationToken cancel)
    {
        using var response = await SendAsync(url, holderKey, key, HttpMethod.Get, "/buddy/v1/spot", null, now, cancel);
        await ThrowUnlessOk(response, cancel);
        var spot = await ReadJson(response, cancel);
        return new BuddySpotInfo(
            spot.GetProperty("spotId").GetString() ?? "", spot.GetProperty("quotaBytes").GetInt64(), spot.GetProperty("keep").GetInt32(),
            spot.GetProperty("graceDays").GetInt32(), spot.GetProperty("used").GetInt64(), spot.GetProperty("removing").GetBoolean(),
            spot.GetProperty("deleteAt").ValueKind == JsonValueKind.Number ? spot.GetProperty("deleteAt").GetInt64() : null,
            spot.GetProperty("versions").EnumerateArray()
                .Select(v => new BuddyVersion(v.GetProperty("id").GetString() ?? "", v.GetProperty("size").GetInt64(), v.GetProperty("at").GetInt64()))
                .ToList());
    }

    public async Task<(string Id, long Received, int ChunkBytes)> BeginUploadAsync(string url, byte[] holderKey, Key key, long size, long now, CancellationToken cancel)
    {
        using var response = await SendAsync(url, holderKey, key, HttpMethod.Post, "/buddy/v1/uploads", JsonSerializer.SerializeToUtf8Bytes(new { size }), now, cancel);
        await ThrowUnlessOk(response, cancel);
        var upload = await ReadJson(response, cancel);
        return (upload.GetProperty("id").GetString() ?? "", upload.GetProperty("received").GetInt64(), upload.GetProperty("chunkBytes").GetInt32());
    }

    /// <summary>How much of an upload the holder has, or null when it doesn't know that upload (any more).</summary>
    public async Task<long?> UploadReceivedAsync(string url, byte[] holderKey, Key key, string id, long now, CancellationToken cancel)
    {
        using var response = await SendAsync(url, holderKey, key, HttpMethod.Get, $"/buddy/v1/uploads/{Uri.EscapeDataString(id)}", null, now, cancel);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        await ThrowUnlessOk(response, cancel);
        return (await ReadJson(response, cancel)).GetProperty("received").GetInt64();
    }

    public async Task<long> PutPartAsync(string url, byte[] holderKey, Key key, string id, long offset, byte[] part, long now, CancellationToken cancel)
    {
        using var response = await SendAsync(url, holderKey, key, HttpMethod.Put, $"/buddy/v1/uploads/{Uri.EscapeDataString(id)}?offset={offset}", part, now, cancel);
        await ThrowUnlessOk(response, cancel);
        return (await ReadJson(response, cancel)).GetProperty("received").GetInt64();
    }

    public async Task<BuddyVersion> FinishAsync(string url, byte[] holderKey, Key key, string id, string sha256, long now, CancellationToken cancel)
    {
        using var response = await SendAsync(url, holderKey, key, HttpMethod.Post, $"/buddy/v1/uploads/{Uri.EscapeDataString(id)}/finish",
            JsonSerializer.SerializeToUtf8Bytes(new { sha256 }), now, cancel);
        await ThrowUnlessOk(response, cancel);
        var version = (await ReadJson(response, cancel)).GetProperty("version");
        return new BuddyVersion(version.GetProperty("id").GetString() ?? "", version.GetProperty("size").GetInt64(), version.GetProperty("at").GetInt64());
    }

    /// <summary>Downloads a version into <paramref name="output"/> (at most <paramref name="maxBytes"/>).</summary>
    public async Task DownloadAsync(string url, byte[] holderKey, Key key, string id, Stream output, long maxBytes, long now,
        Action<long>? progress, CancellationToken cancel)
    {
        using var response = await SendAsync(url, holderKey, key, HttpMethod.Get, $"/buddy/v1/versions/{Uri.EscapeDataString(id)}", null, now, cancel,
            HttpCompletionOption.ResponseHeadersRead);
        await ThrowUnlessOk(response, cancel);
        await using var body = await response.Content.ReadAsStreamAsync(cancel);
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await body.ReadAsync(buffer, cancel)) > 0)
        {
            total += read;
            if (total > maxBytes) throw new BuddyHttpException(502, "The copy is bigger than the holder said.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancel);
            progress?.Invoke(total);
        }
    }

    public async Task RemoveAsync(string url, byte[] holderKey, Key key, long now, CancellationToken cancel)
    {
        using var response = await SendAsync(url, holderKey, key, HttpMethod.Delete, "/buddy/v1/spot", null, now, cancel);
        await ThrowUnlessOk(response, cancel);
    }

    private const int MaxJsonBytes = 1024 * 1024;

    private static async Task<JsonElement> ReadJson(HttpResponseMessage response, CancellationToken cancel)
    {
        if (response.Content.Headers.ContentLength > MaxJsonBytes) throw new BuddyHttpException(502, "The holder's answer is too big.");
        var bytes = await response.Content.ReadAsByteArrayAsync(cancel);
        if (bytes.Length > MaxJsonBytes) throw new BuddyHttpException(502, "The holder's answer is too big.");
        try
        {
            using var doc = JsonDocument.Parse(bytes);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new BuddyHttpException(502, "That isn't an Iskra server that keeps backups.");
        }
    }

    private static async Task ThrowUnlessOk(HttpResponseMessage response, CancellationToken cancel)
    {
        if (response.IsSuccessStatusCode) return;
        var status = (int)response.StatusCode;
        long? received = null;
        if (status == 409)
        {
            try
            {
                var body = await ReadJson(response, cancel);
                if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("received", out var r) && r.ValueKind == JsonValueKind.Number) received = r.GetInt64();
            }
            catch (BuddyHttpException) { /* no body */ }
        }
        throw new BuddyHttpException(status, $"The holder answered {status}.", received);
    }

    public void Dispose() => _http.Dispose();
}
