using System.Buffers;
using System.Globalization;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Sessions;

public sealed class SessionLimits
{
    public int AuthTimeoutMs { get; set; } = 5_000;
    public int MaxPreAuthFrameBytes { get; set; } = 4 * 1024;
    public int MaxFrameBytes { get; set; } = 64 * 1024;
    public int MaxConsecutiveBadFrames { get; set; } = 10;
    public int CloseGraceMs { get; set; } = 2_000;
    /// <summary>
    /// Text waiting to go out to one client (in chars). A client that stops reading (a dead connection, a stalled
    /// phone) is dropped past this instead of growing the server's memory; it reconnects and catches up.
    /// </summary>
    public int MaxQueuedChars { get; set; } = 8 * 1024 * 1024;
}

/// <summary>
/// One client connection. The read loop is the only reader and the write loop is the only writer,
/// so the socket is never used concurrently. Everything outbound goes through <see cref="_outbox"/>,
/// which any thread may write to via <see cref="Send"/>.
/// </summary>
public sealed class Session
{
    private readonly WebSocket _ws;
    private readonly World _world;
    private readonly Hub _hub;
    private readonly VoiceRegistry _voice;
    private readonly Uploads _uploads;
    private readonly LinkPreviews _previews;
    private readonly Router _router;
    private readonly SessionLimits _limits;
    private readonly ILogger _log;
    private readonly TimeProvider _time;
    private readonly RateLimiter _rateLimiter;
    private readonly System.Threading.Channels.Channel<Outbound> _outbox =
        System.Threading.Channels.Channel.CreateUnbounded<Outbound>(new UnboundedChannelOptions { SingleReader = true });

    private Task<Frame>? _pendingReceive;
    private readonly Lock _earlyGate = new();
    /// <summary>Frames from other sessions that arrive before our welcome; sent right after it, in order.</summary>
    private List<string>? _early = [];
    private volatile bool _closing;
    /// <summary>Chars queued in <see cref="_outbox"/> and not yet sent.</summary>
    private long _queuedChars;

    /// <summary>The scheme and host this client connected through (e.g. https://1-2-3-4.sslip.io), when known.</summary>
    public string? Origin { get; init; }

    /// <summary>The client's IP address: limits bursts in the security log, and is recorded there only if the owner turned that on.</summary>
    public string? RemoteIp { get; init; }

    /// <summary><see cref="RemoteIp"/> if the security log records addresses (Retention.SecurityLogIps), else null.</summary>
    public string? LoggedIp => _world.Settings.Retention.SecurityLogIps ? RemoteIp : null;

    /// <summary>The authenticated account, or null before the handshake completes.</summary>
    public string? AccountKey { get; private set; }

    /// <summary>The device key from the handshake's certificate (one browser or app install).</summary>
    public string? DeviceKey { get; private set; }

    public required Push.PushService Push { get; init; }

    public required Gifs.GifService Gifs { get; init; }

    /// <summary>This session reported no activity for a while (see PresenceFeature).</summary>
    public bool Idle { get; set; }

    public World World => _world;
    public Hub Hub => _hub;
    public VoiceRegistry Voice => _voice;
    public Uploads Uploads => _uploads;
    public LinkPreviews Previews => _previews;
    public Router Router => _router;
    public TimeProvider Time => _time;
    public long Now => _time.GetUtcNow().ToUnixTimeMilliseconds();

    public Session(WebSocket ws, World world, Hub hub, VoiceRegistry voice, Uploads uploads, LinkPreviews previews, Router router,
        SessionLimits limits, ILogger log, TimeProvider time)
    {
        _uploads = uploads;
        _previews = previews;
        _ws = ws;
        _world = world;
        _hub = hub;
        _voice = voice;
        _router = router;
        _limits = limits;
        _log = log;
        _time = time;
        _rateLimiter = new RateLimiter(time);
    }

    /// <summary>
    /// A session without a connection that acts for <paramref name="accountKey"/>: scheduled messages go out through it with
    /// the same handlers and checks as a live send (<see cref="Router.Invoke"/>). Anything sent to it is dropped.
    /// </summary>
    public static Session Detached(string accountKey, World world, Hub hub, VoiceRegistry voice, Uploads uploads, LinkPreviews previews,
        Router router, ILogger log, TimeProvider time, Push.PushService push, Gifs.GifService gifs)
    {
        var session = new Session(null!, world, hub, voice, uploads, previews, router, new SessionLimits(), log, time) { Push = push, Gifs = gifs };
        session.AccountKey = accountKey;
        session._early = null;
        session._closing = true;
        return session;
    }

    /// <summary>The member record as it is right now (roles can change mid-session).</summary>
    /// <summary>A per-session limit checked by a handler itself (see <see cref="RateLimiter.TryTakeOnly"/>). Read loop only.</summary>
    public bool TryTakeLimit(string key) => _rateLimiter.TryTakeOnly(key);

    public Member? CurrentMember() => AccountKey is null ? null : _world.Store.GetMember(AccountKey);

    /// <param name="stopping">The server is shutting down: say goodbye (clients reconnect) instead of holding shutdown open.</param>
    public async Task RunAsync(CancellationToken aborted, CancellationToken stopping = default)
    {
        using var _ = aborted.Register(() => _ws.Abort());
        using var __ = stopping.Register(() =>
        {
            _hub.Restart.Settle();
            Close(_hub.Restart.Code, _hub.Restart.Reason);
        });
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
            // Going offline, or maybe idle (when the sessions left are all idle).
            if (AccountKey is not null && (_hub.Remove(this) || !Idle))
            {
                var member = _world.Store.GetMember(AccountKey);
                if (member is not null) _hub.Broadcast(Frames.Event("member.updated", new { member = _hub.PublicMember(member) }));
            }
            _outbox.Writer.TryComplete();
            await writer;
            await AwaitCloseAckAsync();
        }
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    private async Task ReadLoopAsync()
    {
        var nonce = RandomNumberGenerator.GetBytes(32);
        SendNow(Frames.Event("hello", new
        {
            v = 1,
            serverKey = Ed25519.ToB64u(_world.ServerPublicKey),
            nonce = Ed25519.ToB64u(nonce),
            name = _world.Settings.Name,
        }));

        var first = await NextFrameAsync(_limits.MaxPreAuthFrameBytes, TimeSpan.FromMilliseconds(_limits.AuthTimeoutMs));
        if (!HandleControlFrame(first)) return;

        var envelope = first.Kind == FrameKind.Text ? Envelope.TryParse(first.Data) : null;
        string? deviceKey = null;
        var (member, failure) = envelope is null ? (null, AuthFailure.Invalid) : Authenticate(envelope, nonce, out deviceKey);
        if (member is null)
        {
            var (code, message, close) = failure switch
            {
                AuthFailure.Banned => ("banned", "You are banned from this server.", CloseCodes.Forbidden),
                AuthFailure.InviteRequired => ("invite_required", "You need a valid invite to join this server.", CloseCodes.AuthFailed),
                AuthFailure.NameRequired => ("name_required", "Pick a name before joining this server.", CloseCodes.AuthFailed),
                AuthFailure.DeviceRevoked => ("device_revoked", "This device was removed from its account.", CloseCodes.AuthFailed),
                AuthFailure.KeyRotation => (_authError!.Value.Code, _authError.Value.Message, CloseCodes.AuthFailed),
                _ => ("auth_failed", "Authentication failed.", CloseCodes.AuthFailed),
            };
            SecurityLog.Record(_world.Store, Now, "auth.failed", _provenAccount, LoggedIp, new { reason = code }, source: RemoteIp);
            SendNow(Frames.Error(envelope?.Id, code, message, failure == AuthFailure.KeyRotation ? _authError!.Value.Extra : null));
            Close(close, message);
            return;
        }

        AccountKey = member.AccountKey;
        DeviceKey = deviceKey;
        var cameOnline = _hub.Add(this);
        SendNow(Frames.Event("welcome", new
        {
            you = _hub.PublicMember(member),
            server = new { name = _world.Settings.Name, key = Ed25519.ToB64u(_world.ServerPublicKey), appUrl = _world.Settings.AppUrl, publicUrl = _world.InternetUrl,
                profilePages = ProfileFeature.PagesEnabled(_world.Store),
                moved = _world.Moved is { } moved ? MoveFeature.View(moved) : null },
            presence = PresenceFeature.Mine(_world.Store, member.AccountKey, Now),
            channels = _hub.VisibleChannels(member),
            categories = _hub.VisibleCategories(member),
            notify = NotifyFeature.Settings(_world.Store, member.AccountKey, Now),
            members = _hub.PublicMembers(),
            voice = _voice.Snapshot(member),
            voiceAvailable = _voice.Backend.Available,
            stages = _voice.Stages.Snapshot(member),
            watch = _voice.Watch.Snapshot(member),
            rotations = KeyFeature.Recent(_world.Store),
            keyLog = KeyLogFeature.Head(_world, Now),
            rules = RulesFeature.View(_world.Store, member),
            botCommands = BotCommandFeature.All(_world.Store),
        }));
        lock (_earlyGate)
        {
            foreach (var frame in _early!) SendNow(frame);
            _early = null;
        }
        // A new name or profile from this connect reaches everyone, even when another of their devices was already online.
        if (cameOnline || _profileChanged)
        {
            var update = Frames.Event("member.updated", new { member = _hub.PublicMember(member) });
            foreach (var other in _hub.Sessions.Where(s => s != this)) other.Send(update);
        }
        _log.LogInformation("{Name} ({Key}) connected", member.Name, member.AccountKey[..8]);

        var badFrames = 0;
        while (!_closing)
        {
            var frame = await NextFrameAsync(_limits.MaxFrameBytes, timeout: null);
            if (!HandleControlFrame(frame)) return;

            var request = frame.Kind == FrameKind.Text ? Envelope.TryParse(frame.Data) : null;
            if (request is null)
            {
                Send(Frames.Error(null, "bad_request", "Malformed frame."));
                if (++badFrames >= _limits.MaxConsecutiveBadFrames)
                    Close(CloseCodes.BadRequests, "Too many bad requests");
                continue;
            }
            badFrames = 0;

            if (!_rateLimiter.TryTake(request.Type))
            {
                if (Now - _rateLoggedAt >= 60_000)
                {
                    _rateLoggedAt = Now;
                    SecurityLog.Record(this, "rate_limited", details: new { type = request.Type.Length <= 64 ? request.Type : request.Type[..64] });
                }
                Send(Frames.Error(request.Id, "rate_limited", "Slow down a little."));
                continue;
            }

            var current = CurrentMember();
            if (current is null)
            {
                // Removed (kicked or banned) while connected.
                Close(CloseCodes.Forbidden, "You are no longer a member of this server.");
                return;
            }
            _router.Handle(this, current, request);
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
                SendNow(Frames.Error(null, "auth_failed", "Authentication timed out."));
                Close(CloseCodes.AuthFailed, "Authentication timed out");
                return false;
            case FrameKind.TooLarge:
                Close(CloseCodes.TooLarge, "Frame too large");
                return false;
            default:
                return true;
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

    private enum AuthFailure { Invalid, Banned, InviteRequired, DeviceRevoked, KeyRotation, NameRequired }

    /// <summary>Set when the handshake fails because the account was deleted or its key rotated (AccountFeature/KeyFeature.OnAuth).</summary>
    private (string Code, string Message, object Extra)? _authError;

    /// <summary>The account a failed handshake proved it holds (signature checked), for the security log.</summary>
    private string? _provenAccount;

    /// <summary>When this session last wrote a rate_limited entry (one a minute at most).</summary>
    private long _rateLoggedAt = long.MinValue / 2;

    private (Member?, AuthFailure) Authenticate(Envelope envelope, byte[] nonce, out string? deviceKey)
    {
        deviceKey = null;
        if (envelope.Type != "auth" || envelope.Body.ValueKind != JsonValueKind.Object) return (null, AuthFailure.Invalid);
        var body = envelope.Body;

        if (!body.TryGetProperty("cert", out var certElement) || certElement.ValueKind != JsonValueKind.Object)
            return (null, AuthFailure.Invalid);
        DeviceCert? cert;
        try
        {
            cert = certElement.Deserialize<DeviceCert>(Json.Options);
        }
        catch (JsonException)
        {
            return (null, AuthFailure.Invalid);
        }
        if (cert is null) return (null, AuthFailure.Invalid);

        string? signature = null, name = null, invite = null;
        JsonElement profile = default;
        var isBot = false;
        // A device that doesn't know the account's name yet (restored from the recovery key) leaves it out: an existing
        // member keeps their profile, a new one is asked for a name (Profile sync).
        var nameOmitted = false;
        try
        {
            var fields = new Body(body);
            signature = fields.OptionalString("sig", 128);
            invite = fields.OptionalString("invite", 64);
            if (body.TryGetProperty("profile", out profile))
            {
                nameOmitted = profile.ValueKind == JsonValueKind.Object && !profile.TryGetProperty("name", out _);
                name = nameOmitted ? null : Names.Normalize(new Body(profile).OptionalString("name", 256));
                isBot = new Body(profile).OptionalBool("bot") ?? false;
            }
        }
        catch (RequestException)
        {
            return (null, AuthFailure.Invalid);
        }
        if (name is null && !nameOmitted) return (null, AuthFailure.Invalid);

        if (!Identity.VerifyDeviceCert(cert)) return (null, AuthFailure.Invalid);
        if (!Identity.VerifyAuth(cert, _world.ServerPublicKey, nonce, signature)) return (null, AuthFailure.Invalid);

        // Identity is proven from here on.
        _provenAccount = cert.AccountKey;
        if (_world.Store.IsDeviceRevoked(cert.AccountKey, cert.DeviceKey)) return (null, AuthFailure.DeviceRevoked);
        _authError = AccountFeature.OnAuth(_world.Store, cert) ?? KeyFeature.OnAuth(_world, _hub, _voice, cert, body, Now);
        if (_authError is not null) return (null, AuthFailure.KeyRotation);
        deviceKey = cert.DeviceKey;
        if (_world.Store.IsBanned(cert.AccountKey)) return (null, AuthFailure.Banned);

        var existing = _world.Store.GetMember(cert.AccountKey);
        if (existing is not null)
        {
            // A device whose profile is older than the one this server last accepted doesn't overwrite it (Profile sync).
            if (name is null || !ProfileFeature.AcceptStamp(_world.Store, existing.AccountKey, new Body(profile), Now)) name = existing.Name;
            else
            {
                if (existing.Name != name) _world.Store.SetMemberName(existing.AccountKey, name);
                _profileChanged = ProfileFeature.ApplyFromAuth(_world.Store, existing.AccountKey, profile) || existing.Name != name;
            }
            PresenceFeature.ApplyFromAuth(_world.Store, existing.AccountKey, body, Now);
            if (!_world.Store.HasDevice(cert.DeviceKey))
                SecurityLog.Record(_world.Store, Now, "device.new", cert.AccountKey, LoggedIp, new { deviceKey = cert.DeviceKey });
            _world.Store.SaveDevice(cert, Now);
            KeyFeature.SignedIn(_world.Store, cert);
            return (existing with { Name = name }, AuthFailure.Invalid);
        }

        if (name is null) return (null, AuthFailure.NameRequired);
        var role = invite is null || !BotFeature.InviteFits(_world.Store, invite, isBot) ? null : _world.Store.TryUseInvite(invite, Now);
        if (role is null) return (null, AuthFailure.InviteRequired);

        if (isBot) BotFeature.Joined(_world.Store, cert.AccountKey, invite!, Now);
        var member = _world.Store.AddMember(cert.AccountKey, name, role, Now);
        _world.Store.SaveDevice(cert, Now);
        ProfileFeature.AcceptStamp(_world.Store, member.AccountKey, new Body(profile), Now);
        ProfileFeature.ApplyFromAuth(_world.Store, member.AccountKey, profile);
        PresenceFeature.ApplyFromAuth(_world.Store, member.AccountKey, body, Now);
        if (role == Roles.Owner) OwnerSetup.OwnerJoined(_world);
        SecurityLog.Record(_world.Store, Now, "member.joined", member.AccountKey, LoggedIp, new { role, bot = isBot });
        _hub.Broadcast(Frames.Event("member.joined", new { member = _hub.PublicMember(member) }));
        return (member, AuthFailure.Invalid);
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Queues a frame. Safe from any thread; dropped silently once the session is closing.
    /// Before the welcome has gone out, frames wait so the client always sees welcome first.
    /// </summary>
    public void Send(string json)
    {
        lock (_earlyGate)
        {
            if (_early is not null)
            {
                _early.Add(json);
                return;
            }
        }
        SendNow(json);
    }

    private void SendNow(string json)
    {
        if (_closing) return;
        if (Interlocked.Add(ref _queuedChars, json.Length) > _limits.MaxQueuedChars)
        {
            Overflowed();
            return;
        }
        if (!_outbox.Writer.TryWrite(new Outbound(json, null, null))) Interlocked.Add(ref _queuedChars, -json.Length);
    }

    /// <summary>The client stopped reading: drop it now (a close frame would wait behind everything queued).</summary>
    private void Overflowed()
    {
        lock (_earlyGate)
        {
            if (_closing) return;
            _closing = true;
        }
        _log.LogWarning("Dropped {Key}: it stopped reading ({Chars} chars queued)", AccountKey?[..Math.Min(8, AccountKey.Length)], Interlocked.Read(ref _queuedChars));
        _outbox.Writer.TryComplete();
        _ws.Abort();
    }

    /// <summary>Closes the session from outside (kick, ban, removal).</summary>
    public void Kick(int code, string reason, string? key = null)
    {
        Send(Frames.Event("kicked", key is null ? new { reason } : new { reason, key }));
        Close(code, reason);
    }

    /// <summary>Whether this connect changed the member's name or profile (sent with auth).</summary>
    private bool _profileChanged;

    private Action? _afterReply;

    /// <summary>Runs <paramref name="action"/> right after the current request's result is queued (read loop only).</summary>
    public void AfterReply(Action action) => _afterReply += action;

    public void RunAfterReply()
    {
        var action = _afterReply;
        _afterReply = null;
        action?.Invoke();
    }

    /// <summary>Closes the session from outside without a kicked event (e.g. the account moved to a new key).</summary>
    public void End(int code, string reason) => Close(code, reason);

    private void Close(int code, string reason) => Close((WebSocketCloseStatus)code, reason);

    private void Close(WebSocketCloseStatus status, string reason)
    {
        if (_closing) return;
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
                Interlocked.Add(ref _queuedChars, -item.Json!.Length);
            }
        }
        catch (WebSocketException) { /* client went away */ }
        catch (OperationCanceledException) when (_ws.State == WebSocketState.Aborted) { /* dropped (see Overflowed) */ }
    }

    private async Task AwaitCloseAckAsync()
    {
        if (_ws.State != WebSocketState.CloseSent) return;
        _pendingReceive ??= ReceiveFrameAsync(_limits.MaxFrameBytes);
        await Task.WhenAny(_pendingReceive, Task.Delay(TimeSpan.FromMilliseconds(_limits.CloseGraceMs), _time));
    }

    private sealed record Outbound(string? Json, WebSocketCloseStatus? CloseStatus, string? CloseReason);

    private enum FrameKind { Text, Binary, Closed, Timeout, TooLarge }

    private sealed record Frame(FrameKind Kind, byte[] Data)
    {
        public static readonly Frame Closed = new(FrameKind.Closed, []);
        public static readonly Frame Timeout = new(FrameKind.Timeout, []);
        public static readonly Frame TooLarge = new(FrameKind.TooLarge, []);
    }
}

public static class Names
{
    public const int MaxLength = 32;

    /// <summary>Trims and validates a display name. Rejects control and invisible formatting characters (e.g. RTL overrides).</summary>
    public static string? Normalize(string? name) => Text.Normalize(name, MaxLength, allowNewlines: false);
}

public static class Text
{
    /// <summary>Trims, NFC-normalizes and validates user text. Returns null if empty, too long or containing invisible control characters.</summary>
    public static string? Normalize(string? text, int maxLength, bool allowNewlines)
    {
        if (text is null) return null;
        text = text.Replace("\r\n", "\n").Trim().Normalize(NormalizationForm.FormC);
        if (text.Length == 0 || text.Length > maxLength) return null;
        foreach (var c in text)
        {
            if (c == '‍') continue;                     // zero-width joiner: needed for emoji sequences
            if (allowNewlines && (c == '\n' || c == '\t')) continue;
            var category = char.GetUnicodeCategory(c);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format
                or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
                return null;
        }
        return text;
    }
}
