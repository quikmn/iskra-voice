using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Microsoft.Extensions.Options;

namespace Iskra.Server.Features;

public sealed class LinkSettings
{
    public int TtlMs { get; set; } = 5 * 60 * 1000;
    public int MaxActivePerAccount { get; set; } = 3;
    public int MaxActive { get; set; } = 100;
    public int MaxRequestBytes { get; set; } = 1024;
    public int MaxPayloadBytes { get; set; } = 1024 * 1024;
    public int MaxPolls { get; set; } = 600;
}

/// <summary>
/// Device linking relay: a short-lived mailbox between an existing device (authenticated, over its WebSocket)
/// and a new device (no account yet, over plain HTTP). Everything that matters is end-to-end authenticated and
/// encrypted by the two devices with a secret the server never sees; the server only enforces sizes and lifetimes.
/// See "Device linking" in protocol/PROTOCOL.md.
/// </summary>
public sealed class LinkRelay
{
    private enum State { Waiting, Requested, Answered, Done }

    private sealed class Entry
    {
        public required string Token;
        public required string AccountKey;
        public required Session Creator;
        public required string PutKey;
        public required long Expires;
        public State State;
        public string? ReadKey;
        public string? NewEpk, NewMac, Info;
        public string? ExistingEpk, ExistingMac;
        public byte[]? Payload;
        public int Polls;
    }

    private static readonly ConditionalWeakTable<World, LinkRelay> ByWorld = new();

    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private readonly TimeProvider _time;

    public LinkSettings Settings { get; }

    public LinkRelay(World world, TimeProvider time, IOptions<LinkSettings> settings)
    {
        _time = time;
        Settings = settings.Value;
        ByWorld.AddOrUpdate(world, this);
    }

    /// <summary>The relay for a world (WebSocket handlers are static and reach it through the session's world).</summary>
    public static LinkRelay Of(World world) =>
        ByWorld.TryGetValue(world, out var relay) ? relay : throw new InvalidOperationException("Link relay not started.");

    private long Now => _time.GetUtcNow().ToUnixTimeMilliseconds();

    private static string NewKey(int bytes) => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(bytes));

    private void Sweep()
    {
        var now = Now;
        foreach (var (token, entry) in _entries.Where(e => e.Value.Expires <= now).ToList()) _entries.Remove(token);
    }

    private Entry? Find(string token)
    {
        Sweep();
        return _entries.GetValueOrDefault(token);
    }

    // ── The existing device (WebSocket) ─────────────────────────────────────

    public (string Token, string PutKey, long ExpiresAt) Create(Session session, string accountKey)
    {
        lock (_gate)
        {
            Sweep();
            if (_entries.Values.Count(e => e.AccountKey == accountKey) >= Settings.MaxActivePerAccount)
                throw new RequestException("rate_limited", "Too many device links in progress. Finish or cancel one first.");
            if (_entries.Count >= Settings.MaxActive) throw new RequestException("rate_limited", "This server is busy linking devices. Try again in a minute.");
            var entry = new Entry
            {
                Token = NewKey(10), AccountKey = accountKey, Creator = session, PutKey = NewKey(16), Expires = Now + Settings.TtlMs,
            };
            _entries[entry.Token] = entry;
            return (entry.Token, entry.PutKey, entry.Expires);
        }
    }

    public void Respond(string accountKey, string token, string epk, string mac)
    {
        lock (_gate)
        {
            var entry = Find(token);
            if (entry is null || entry.AccountKey != accountKey) throw RequestException.NotFound("Link");
            if (entry.State != State.Requested) throw RequestException.BadRequest("No device is waiting on this link.");
            entry.ExistingEpk = epk;
            entry.ExistingMac = mac;
            entry.State = State.Answered;
        }
    }

    public void Cancel(string accountKey, string token)
    {
        lock (_gate)
        {
            if (Find(token) is { } entry && entry.AccountKey == accountKey) _entries.Remove(token);
        }
    }

    // ── The new device (HTTP) ───────────────────────────────────────────────

    /// <summary>The new device announces its ephemeral key. Only one device per link.</summary>
    public IResult Request(string token, JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest();
        string epk, mac;
        string? info;
        try
        {
            var fields = new Body(body);
            epk = fields.String("epk", 64);
            mac = fields.String("mac", 64);
            info = fields.OptionalString("info", 256) is { } raw ? Text.Normalize(raw, 64, allowNewlines: false) : null;
        }
        catch (RequestException)
        {
            return Results.BadRequest();
        }
        if (!Is32Bytes(epk) || !Is32Bytes(mac)) return Results.BadRequest();

        Entry entry;
        lock (_gate)
        {
            var found = Find(token);
            if (found is null) return Results.NotFound();
            if (found.State != State.Waiting) return Results.Conflict();
            found.NewEpk = epk;
            found.NewMac = mac;
            found.Info = info;
            found.ReadKey = NewKey(16);
            found.State = State.Requested;
            entry = found;
        }
        entry.Creator.Send(Frames.Event("link.request", new { token, epk, mac, info }));
        return Results.Json(new { key = entry.ReadKey, expiresAt = entry.Expires });
    }

    /// <summary>The new device polls for the answer, then for the payload (handed out once).</summary>
    public IResult Poll(string token, string? key)
    {
        lock (_gate)
        {
            var entry = Find(token);
            if (entry is null || entry.ReadKey is null) return Results.NotFound();
            if (key is null || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(key), System.Text.Encoding.UTF8.GetBytes(entry.ReadKey)))
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (++entry.Polls > Settings.MaxPolls) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            switch (entry.State)
            {
                case State.Answered:
                    return Results.Json(new { state = "answered", epk = entry.ExistingEpk, mac = entry.ExistingMac });
                case State.Done:
                    _entries.Remove(token);
                    return Results.Json(new { state = "done", payload = Ed25519.ToB64u(entry.Payload) });
                default:
                    return Results.Json(new { state = "waiting", expiresAt = entry.Expires });
            }
        }
    }

    /// <summary>The existing device uploads the encrypted payload (too big for a WebSocket frame).</summary>
    public IResult Deliver(string token, string? putKey, byte[] payload)
    {
        lock (_gate)
        {
            var entry = Find(token);
            if (entry is null) return Results.NotFound();
            if (putKey is null || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(putKey), System.Text.Encoding.UTF8.GetBytes(entry.PutKey)))
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (entry.State != State.Answered) return Results.Conflict();
            entry.Payload = payload;
            entry.State = State.Done;
            return Results.Ok(new { });
        }
    }

    private static bool Is32Bytes(string text) => Ed25519.TryFromB64u(text, out var bytes) && bytes.Length == 32;

    public static void AllowCors(HttpContext context)
    {
        context.Response.Headers.AccessControlAllowOrigin = "*";
        context.Response.Headers.AccessControlAllowMethods = "GET, POST, PUT, OPTIONS";
        context.Response.Headers.AccessControlAllowHeaders = "Content-Type";
        context.Response.Headers.AccessControlMaxAge = "86400";
        context.Response.Headers.CacheControl = "no-store";
    }

    /// <summary>Reads at most <paramref name="max"/> bytes; null if the body is bigger.</summary>
    private static async Task<byte[]?> ReadBodyAsync(HttpContext context, int max)
    {
        if (context.Request.ContentLength > max) return null;
        if (context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = max;
        var buffer = new byte[max + 1];
        var length = 0;
        try
        {
            int read;
            while (length < buffer.Length && (read = await context.Request.Body.ReadAsync(buffer.AsMemory(length))) > 0) length += read;
        }
        catch (BadHttpRequestException)
        {
            return null;
        }
        return length > max ? null : buffer[..length];
    }

    public static void MapEndpoints(WebApplication app)
    {
        app.Services.GetRequiredService<LinkRelay>(); // attach to the world before any session asks for it

        app.MapMethods("/link/{token}", ["OPTIONS"], (HttpContext context) =>
        {
            AllowCors(context);
            return Results.NoContent();
        });
        app.MapPost("/link/{token}", async (HttpContext context, string token, LinkRelay relay) =>
        {
            AllowCors(context);
            var body = await ReadBodyAsync(context, relay.Settings.MaxRequestBytes);
            if (body is null) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            try
            {
                using var doc = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 4 });
                return relay.Request(token, doc.RootElement);
            }
            catch (JsonException)
            {
                return Results.BadRequest();
            }
        });
        app.MapGet("/link/{token}", (HttpContext context, string token, string? key, LinkRelay relay) =>
        {
            AllowCors(context);
            return relay.Poll(token, key);
        });
        app.MapPut("/link/{token}", async (HttpContext context, string token, string? key, LinkRelay relay) =>
        {
            AllowCors(context);
            var body = await ReadBodyAsync(context, relay.Settings.MaxPayloadBytes);
            if (body is null) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            if (body.Length == 0) return Results.BadRequest();
            return relay.Deliver(token, key, body);
        });
    }
}

/// <summary>The WebSocket side of device linking (the existing, signed-in device).</summary>
public static class LinkFeature
{
    public static void Register(Router router)
    {
        router.Add("link.create", (s, me, _) =>
        {
            var (token, putKey, expiresAt) = LinkRelay.Of(s.World).Create(s, me.AccountKey);
            return new { token, putKey, expiresAt };
        });
        router.Add("link.respond", (s, me, body) =>
        {
            var token = body.String("token", 64);
            var epk = body.String("epk", 64);
            var mac = body.String("mac", 64);
            if (!Ed25519.TryFromB64u(epk, out var e) || e.Length != 32 || !Ed25519.TryFromB64u(mac, out var m) || m.Length != 32)
                throw RequestException.BadRequest("'epk' and 'mac' must be 32 bytes.");
            LinkRelay.Of(s.World).Respond(me.AccountKey, token, epk, mac);
            return new { };
        });
        router.Add("link.cancel", (s, me, body) =>
        {
            LinkRelay.Of(s.World).Cancel(me.AccountKey, body.String("token", 64));
            return new { };
        });
    }
}
