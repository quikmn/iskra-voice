using System.Buffers;
using System.Globalization;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server.Sessions;

public sealed class SessionLimits
{
    public int AuthTimeoutMs { get; set; } = 5_000;
    public int MaxPreAuthFrameBytes { get; set; } = 4 * 1024;
    public int MaxFrameBytes { get; set; } = 64 * 1024;
    public int MaxConsecutiveBadFrames { get; set; } = 10;
    public int CloseGraceMs { get; set; } = 2_000;
}

/// <summary>
/// One client connection. The read loop is the only reader and the write loop is the only writer,
/// so the socket is never used concurrently (a v1 bug). Everything outbound goes through <see cref="_outbox"/>.
/// </summary>
public sealed class Session
{
    private readonly WebSocket _ws;
    private readonly World _world;
    private readonly SessionLimits _options;
    private readonly ILogger _log;
    private readonly TimeProvider _time;
    private readonly Channel<Outbound> _outbox =
        Channel.CreateUnbounded<Outbound>(new UnboundedChannelOptions { SingleReader = true });

    private Task<Frame>? _pendingReceive;
    private bool _closing;

    public Member? Member { get; private set; }

    public Session(WebSocket ws, World world, SessionLimits options, ILogger log, TimeProvider time)
    {
        _ws = ws;
        _world = world;
        _options = options;
        _log = log;
        _time = time;
    }

    public async Task RunAsync(CancellationToken aborted)
    {
        using var _ = aborted.Register(() => _ws.Abort());
        var writer = WriteLoopAsync();
        try
        {
            await ReadLoopAsync();
        }
        catch (WebSocketException) { /* client went away */ }
        catch (Exception ex)
        {
            _log.LogError(ex, "Session crashed");
            Close(WebSocketCloseStatus.InternalServerError, "Internal error");
        }
        finally
        {
            _outbox.Writer.TryComplete();
            await writer;
            await AwaitCloseAckAsync();
        }
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    private async Task ReadLoopAsync()
    {
        var nonce = RandomNumberGenerator.GetBytes(32);
        Send(Frames.Event("hello", new
        {
            v = 1,
            serverKey = Ed25519.ToB64u(_world.ServerPublicKey),
            nonce = Ed25519.ToB64u(nonce),
            name = _world.Settings.Name,
        }));

        var first = await NextFrameAsync(_options.MaxPreAuthFrameBytes, TimeSpan.FromMilliseconds(_options.AuthTimeoutMs));
        if (!HandleControlFrame(first)) return;

        var envelope = first.Kind == FrameKind.Text ? Envelope.TryParse(first.Data) : null;
        Member = envelope is null ? null : Authenticate(envelope, nonce);
        if (Member is null)
        {
            Send(Frames.Error(envelope?.Id, "auth_failed", "Authentication failed."));
            Close(CloseCodes.AuthFailed, "Authentication failed");
            return;
        }

        Send(Frames.Event("welcome", new
        {
            you = new { accountKey = Member.AccountKey, name = Member.Name, role = Member.Role },
            server = new { name = _world.Settings.Name },
        }));
        _log.LogInformation("{Name} ({Key}) connected", Member.Name, Member.AccountKey[..8]);

        var badFrames = 0;
        while (!_closing)
        {
            var frame = await NextFrameAsync(_options.MaxFrameBytes, timeout: null);
            if (!HandleControlFrame(frame)) return;

            var request = frame.Kind == FrameKind.Text ? Envelope.TryParse(frame.Data) : null;
            if (request is null)
            {
                Send(Frames.Error(null, "bad_request", "Malformed frame."));
                if (++badFrames >= _options.MaxConsecutiveBadFrames)
                    Close(CloseCodes.BadRequests, "Too many bad requests");
                continue;
            }

            badFrames = 0;
            Dispatch(request);
        }
    }

    /// <summary>Handles close, timeout and oversize frames. Returns false when the session should stop reading.</summary>
    private bool HandleControlFrame(Frame frame)
    {
        switch (frame.Kind)
        {
            case FrameKind.Closed:
                return false;
            case FrameKind.Timeout:
                Send(Frames.Error(null, "auth_failed", "Authentication timed out."));
                Close(CloseCodes.AuthFailed, "Authentication timed out");
                return false;
            case FrameKind.TooLarge:
                Close(CloseCodes.TooLarge, "Frame too large");
                return false;
            default:
                return true;
        }
    }

    private void Dispatch(Envelope request)
    {
        switch (request.Type)
        {
            case "ping":
                Send(Frames.Result(request.Id, new { }));
                break;
            default:
                Send(Frames.Error(request.Id, "unknown_type", $"Unknown type '{Truncate(request.Type, 64)}'."));
                break;
        }
    }

    private async Task<Frame> NextFrameAsync(int maxBytes, TimeSpan? timeout)
    {
        // Never cancel a pending ReceiveAsync: in .NET that aborts the socket and we couldn't send a close reason.
        _pendingReceive ??= ReceiveFrameAsync(maxBytes);
        if (timeout is { } t)
        {
            var finished = await Task.WhenAny(_pendingReceive, Task.Delay(t, _time));
            if (finished != _pendingReceive) return Frame.Timeout;
        }
        var frame = await _pendingReceive;
        _pendingReceive = null;
        return frame;
    }

    private async Task<Frame> ReceiveFrameAsync(int maxBytes)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(4096);
        try
        {
            using var message = new MemoryStream();
            while (true)
            {
                var result = await _ws.ReceiveAsync(buffer.AsMemory(), CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close) return Frame.Closed;
                if (message.Length + result.Count > maxBytes) return Frame.TooLarge;
                message.Write(buffer, 0, result.Count);
                if (result.EndOfMessage)
                {
                    return result.MessageType == WebSocketMessageType.Text
                        ? new Frame(FrameKind.Text, message.ToArray())
                        : new Frame(FrameKind.Binary, []);
                }
            }
        }
        catch (WebSocketException)
        {
            return Frame.Closed;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    // ── Auth ─────────────────────────────────────────────────────────────────

    private Member? Authenticate(Envelope envelope, byte[] nonce)
    {
        if (envelope.Type != "auth" || envelope.Body.ValueKind != JsonValueKind.Object) return null;
        var body = envelope.Body;

        if (!body.TryGetProperty("cert", out var certElement) || certElement.ValueKind != JsonValueKind.Object) return null;
        DeviceCert? cert;
        try
        {
            cert = certElement.Deserialize<DeviceCert>(Json.Options);
        }
        catch (JsonException)
        {
            return null;
        }
        if (cert is null) return null;

        var signature = body.TryGetProperty("sig", out var sigElement) && sigElement.ValueKind == JsonValueKind.String
            ? sigElement.GetString()
            : null;

        string? name = null;
        if (body.TryGetProperty("profile", out var profile) && profile.ValueKind == JsonValueKind.Object &&
            profile.TryGetProperty("name", out var nameElement) && nameElement.ValueKind == JsonValueKind.String)
        {
            name = Names.Normalize(nameElement.GetString());
        }
        if (name is null) return null;

        if (!Identity.VerifyDeviceCert(cert)) return null;
        if (!Identity.VerifyAuth(cert, _world.ServerPublicKey, nonce, signature)) return null;

        // M0: anyone with a valid identity can join; the first member becomes owner.
        // M1 replaces this with invite-based joining.
        var role = _world.Store.CountMembers() == 0 ? Roles.Owner : Roles.Member;
        return _world.Store.UpsertMember(cert.AccountKey, name, role, _time.GetUtcNow().ToUnixTimeMilliseconds());
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    private void Send(string json) => _outbox.Writer.TryWrite(new Outbound(json, null, null));

    private void Close(int code, string reason) => Close((WebSocketCloseStatus)code, reason);

    private void Close(WebSocketCloseStatus status, string reason)
    {
        _closing = true;
        _outbox.Writer.TryWrite(new Outbound(null, status, reason));
        _outbox.Writer.TryComplete();
    }

    private async Task WriteLoopAsync()
    {
        try
        {
            await foreach (var item in _outbox.Reader.ReadAllAsync())
            {
                if (_ws.State is not (WebSocketState.Open or WebSocketState.CloseReceived)) break;
                if (item.CloseStatus is { } status)
                {
                    await _ws.CloseOutputAsync(status, item.CloseReason, CancellationToken.None);
                    break;
                }
                await _ws.SendAsync(Encoding.UTF8.GetBytes(item.Json!), WebSocketMessageType.Text, true, CancellationToken.None);
            }
        }
        catch (WebSocketException) { /* client went away */ }
    }

    private async Task AwaitCloseAckAsync()
    {
        if (_ws.State != WebSocketState.CloseSent) return;
        _pendingReceive ??= ReceiveFrameAsync(_options.MaxFrameBytes);
        await Task.WhenAny(_pendingReceive, Task.Delay(TimeSpan.FromMilliseconds(_options.CloseGraceMs), _time));
    }

    private static string Truncate(string text, int max) => text.Length <= max ? text : text[..max];

    private sealed record Outbound(string? Json, WebSocketCloseStatus? CloseStatus, string? CloseReason);

    private enum FrameKind { Text, Binary, Closed, Timeout, TooLarge }

    private sealed record Frame(FrameKind Kind, byte[] Data)
    {
        public static readonly Frame Closed = new(FrameKind.Closed, []);
        public static readonly Frame Timeout = new(FrameKind.Timeout, []);
        public static readonly Frame TooLarge = new(FrameKind.TooLarge, []);
    }
}

public static class Roles
{
    public const string Guest = "guest";
    public const string Member = "member";
    public const string Trusted = "trusted";
    public const string Admin = "admin";
    public const string Owner = "owner";
}

public static class Names
{
    public const int MaxLength = 32;

    /// <summary>Trims and validates a display name. Rejects control and invisible formatting characters (e.g. RTL overrides).</summary>
    public static string? Normalize(string? name)
    {
        if (name is null) return null;
        name = name.Trim().Normalize(NormalizationForm.FormC);
        if (name.Length is 0 or > MaxLength) return null;
        foreach (var c in name)
        {
            if (c == '‍') continue; // zero-width joiner: needed for emoji sequences
            var category = char.GetUnicodeCategory(c);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format
                or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
                return null;
        }
        return name;
    }
}
