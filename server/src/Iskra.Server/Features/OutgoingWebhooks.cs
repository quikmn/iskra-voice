using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Sends outgoing webhooks: chosen events as signed JSON POSTs to an admin's URL. Only public addresses (checked after
/// DNS on every connection), unless the owner allowed the local network for that webhook; never redirects. Retries with
/// backoff, a delivery log without payloads, and a webhook that keeps failing turns itself off and tells the admins.
/// </summary>
public sealed partial class OutgoingWebhooks : BackgroundService
{
    /// <summary>Signed before the timestamp, delivery id and body, so a signature can't be reused for anything else.</summary>
    public const string Context = "iskra-webhook-v1";
    public const int MaxBodyBytes = 64 * 1024;
    /// <summary>Per webhook: 30 at once, then 5 a second. More than that is dropped (and logged).</summary>
    public const double Burst = 30, PerSecond = 5;
    /// <summary>Deliveries waiting or retrying per webhook; more are dropped.</summary>
    public const int MaxPending = 100;

    public static readonly string[] EventTypes =
    [
        "message.created", "reaction.added", "member.joined", "member.left", "event.started",
        "voice.joined", "voice.left", "thread.created", "member.updated", "role.created", "role.updated", "role.deleted",
        "channel.created", "channel.updated", "channel.deleted", "message.updated", "message.deleted",
    ];

    /// <summary>Events about what happens in channels: a webhook with any of them must pick channels.</summary>
    public static readonly string[] ChannelEvents =
        ["message.created", "reaction.added", "voice.joined", "voice.left", "thread.created", "message.updated", "message.deleted"];

    private readonly World _world;
    private readonly Hub _hub;
    private readonly TimeProvider _time;
    private readonly ILogger<OutgoingWebhooks> _log;
    private readonly HttpClient _public;
    private readonly HttpClient _local;
    private readonly int[] _retryDelaysMs;
    private readonly int _disableAfter;
    private readonly System.Threading.Channels.Channel<Job> _queue = System.Threading.Channels.Channel.CreateUnbounded<Job>(new System.Threading.Channels.UnboundedChannelOptions { SingleReader = true });
    private readonly SemaphoreSlim _parallel = new(4);
    private readonly ConcurrentDictionary<string, WebhookIngress.TokenBucket> _buckets = new();
    private readonly ConcurrentDictionary<string, int> _pending = new();
    private volatile List<OutgoingWebhook>? _hooks;
    private CancellationToken _stopping;

    private sealed record Job(string HookId, string Delivery, string Event, string Body, int Attempt);

    public OutgoingWebhooks(World world, Hub hub, TimeProvider time, IConfiguration config, ILogger<OutgoingWebhooks> log)
    {
        _world = world;
        _hub = hub;
        _time = time;
        _log = log;
        _retryDelaysMs = (config["OutgoingWebhooks:RetryDelaysMs"] ?? "5000,30000,120000,600000")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(int.Parse).ToArray();
        _disableAfter = config.GetValue("OutgoingWebhooks:DisableAfter", 10);
        var timeout = TimeSpan.FromMilliseconds(config.GetValue("OutgoingWebhooks:TimeoutMs", 10_000));
        _public = Client(allowLocal: false, timeout);
        _local = Client(allowLocal: true, timeout);
        hub.Outhooks = this;
    }

    private static HttpClient Client(bool allowLocal, TimeSpan timeout)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            UseCookies = false,
            UseProxy = false,
            MaxResponseHeadersLength = 16,
            PooledConnectionLifetime = TimeSpan.FromMinutes(1),
            ConnectCallback = Connect(allowLocal),
        };
        var http = new HttpClient(handler) { Timeout = timeout };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Iskra-Webhook/1");
        return http;
    }

    // ── Addresses ────────────────────────────────────────────────────────────

    /// <summary>The URL's address isn't one this webhook may reach.</summary>
    public sealed class BlockedAddressException() : Exception("That address isn't allowed for this webhook.");

    /// <summary>
    /// Home and office networks: loopback, 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT and Tailscale) and IPv6 unique
    /// local. Never link-local (cloud metadata lives there), unspecified, multicast or broadcast.
    /// </summary>
    public static bool IsLocalNetwork(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (IPAddress.IsLoopback(address)) return true;
        var b = address.GetAddressBytes();
        if (address.AddressFamily == AddressFamily.InterNetwork)
            return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168)
                || (b[0] == 100 && b[1] >= 64 && b[1] <= 127);
        return address.AddressFamily == AddressFamily.InterNetworkV6 && (b[0] & 0xFE) == 0xFC;
    }

    /// <summary>
    /// Whether a webhook may connect to <paramref name="address"/>. Plain http only ever goes to the local network (and only
    /// when allowed), so nothing unencrypted crosses the internet.
    /// </summary>
    public static bool MayConnect(IPAddress address, bool allowLocal, bool plainHttp) =>
        plainHttp ? allowLocal && IsLocalNetwork(address) : LinkPreviews.IsPublic(address) || (allowLocal && IsLocalNetwork(address));

    private static Func<SocketsHttpConnectionContext, CancellationToken, ValueTask<Stream>> Connect(bool allowLocal) =>
        async (context, cancel) =>
        {
            var plain = context.InitialRequestMessage.RequestUri?.Scheme == Uri.UriSchemeHttp;
            var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancel);
            var allowed = addresses.FirstOrDefault(a => MayConnect(a, allowLocal, plain)) ?? throw new BlockedAddressException();
            var socket = new Socket(allowed.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(allowed, context.DnsEndPoint.Port, cancel);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        };

    /// <summary>
    /// An admin's URL: https (http only for the local network), no user name or password, at most 512 characters.
    /// Then, if the name resolves now, at least one of its addresses must be allowed (checked again on every delivery).
    /// </summary>
    public static async Task<Uri> CheckUrlAsync(string url, bool allowLocal, CancellationToken cancel)
    {
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || uri.Host.Length == 0)
            throw RequestException.BadRequest("Use a web address that starts with https://.", "outhook_url");
        if (!string.IsNullOrEmpty(uri.UserInfo))
            throw RequestException.BadRequest("Put no user name or password in the address.", "outhook_url_userinfo");
        if (uri.Scheme == "http" && !allowLocal)
            throw RequestException.BadRequest("Use https://. Plain http:// works only on your own network, with that option on.", "outhook_url_http");
        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(uri.IdnHost, cancel);
        }
        catch (SocketException)
        {
            return uri; // not resolvable right now (offline, or not yet registered): the check runs again on each delivery
        }
        if (addresses.Length > 0 && !addresses.Any(a => MayConnect(a, allowLocal, uri.Scheme == "http")))
            throw allowLocal
                ? RequestException.BadRequest("That address can't receive webhooks (it's a reserved or link-local address).", "outhook_address_reserved")
                : RequestException.BadRequest("That address is on a private network. Only the owner can allow addresses on their own network.", "outhook_address_private");
        return uri;
    }

    // ── Signing ──────────────────────────────────────────────────────────────

    /// <summary>HMAC-SHA256 over <c>iskra-webhook-v1\n{timestamp}\n{delivery id}\n{body}</c>, as lowercase hex.</summary>
    public static string Sign(string secret, long timestamp, string delivery, string body) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret),
            Encoding.UTF8.GetBytes($"{Context}\n{timestamp}\n{delivery}\n{body}")));

    public static string NewSecret() => "whs_" + Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32));

    // ── Events ───────────────────────────────────────────────────────────────

    /// <summary>Forget the cached list after a webhook was made, changed or removed.</summary>
    public void Changed() => _hooks = null;

    private long _deletions;

    /// <summary>The enabled webhooks, read again after a change or after channels were deleted (which leave their lists).</summary>
    private List<OutgoingWebhook> Hooks()
    {
        var deletions = _world.Store.ChannelDeletions;
        if (_hooks is { } hooks && deletions == Interlocked.Read(ref _deletions)) return hooks;
        Interlocked.Exchange(ref _deletions, deletions);
        return _hooks = _world.Store.OutgoingWebhooks().Where(h => h.Enabled).ToList();
    }

    /// <summary>The channel itself, or a thread's parent, is one the webhook listens to, and the server can read it.</summary>
    private bool Watches(OutgoingWebhook hook, Channel channel)
    {
        var store = _world.Store;
        if (E2eeChannelFeature.IsEncrypted(store, channel)) return false;
        if (hook.ChannelIds.Contains(channel.Id)) return true;
        if (channel.Kind != "thread" || store.GetThread(channel.Id) is not { } thread) return false;
        var parent = store.GetChannel(thread.ParentId);
        return parent is not null && !E2eeChannelFeature.IsEncrypted(store, parent) && hook.ChannelIds.Contains(parent.Id);
    }

    private object ChannelView(Channel channel) =>
        channel.Kind == "thread" && _world.Store.GetThread(channel.Id) is { } thread
            ? new { id = channel.Id, name = channel.Name, kind = channel.Kind, parentId = (long?)thread.ParentId }
            : new { id = channel.Id, name = channel.Name, kind = channel.Kind, parentId = (long?)null };

    private object Person(string accountKey) =>
        new { accountKey, name = _world.Store.GetMember(accountKey)?.Name ?? "", bot = _world.Store.IsBot(accountKey) };

    public void MessageCreated(Channel channel, Message message)
    {
        if (!Hooks().Any(h => h.Events.Contains("message.created"))) return;
        Emit("message.created", h => Watches(h, channel), () => new
        {
            message = new
            {
                id = message.Id,
                channel = ChannelView(channel),
                author = Person(message.AuthorKey),
                text = message.Text,
                createdAt = message.CreatedAt,
                replyTo = message.ReplyTo,
                attachments = message.Attachments.Select(_world.Store.GetFile).OfType<StoredFile>()
                    .Select(f => new { name = f.Name, size = f.Size, type = f.Type }),
            },
        });
    }

    public void ReactionAdded(Channel channel, Message message, string accountKey, string emoji)
    {
        if (!Hooks().Any(h => h.Events.Contains("reaction.added"))) return;
        Emit("reaction.added", h => Watches(h, channel), () => new
        {
            messageId = message.Id,
            channel = ChannelView(channel),
            emoji,
            member = Person(accountKey),
        });
    }

    public void MemberJoined(Member member) =>
        Emit("member.joined", _ => true, () => new { member = new { accountKey = member.AccountKey, name = member.Name, role = member.Role, bot = _world.Store.IsBot(member.AccountKey) } });

    /// <param name="reason"><c>left</c>, <c>kicked</c>, <c>banned</c> or <c>deleted</c>.</param>
    public void MemberLeft(string accountKey, string name, string reason) =>
        Emit("member.left", _ => true, () => new { member = new { accountKey, name }, reason });

    public void EventStarted(ServerEvent e)
    {
        var channel = e.ChannelId is { } id ? _world.Store.GetChannel(id) : null;
        // An event in a channel only goes to webhooks that listen to that channel.
        Emit("event.started", h => e.ChannelId is null || (channel is not null && Watches(h, channel)), () => new
        {
            @event = new
            {
                id = e.Id,
                title = e.Title,
                description = e.Description,
                startAt = e.StartAt,
                endAt = e.EndAt,
                channel = channel is null ? null : ChannelView(channel),
                location = e.Location,
            },
        });
    }

    private void Emit(string type, Func<OutgoingWebhook, bool> wants, Func<object> data)
    {
        try
        {
            var hooks = Hooks().Where(h => h.Events.Contains(type) && wants(h)).ToList();
            if (hooks.Count == 0) return;
            var payload = data();
            foreach (var hook in hooks)
            {
                var delivery = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));
                var body = Payload(delivery, type, payload);
                if (Encoding.UTF8.GetByteCount(body) > MaxBodyBytes)
                {
                    Log(hook.Id, delivery, type, 1, null, "too_large", 0);
                    LogCounts.Hooks(_world).Hit("out-dropped");
                    continue;
                }
                var bucket = _buckets.GetOrAdd(hook.Id, _ => new WebhookIngress.TokenBucket(Burst, PerSecond, _time));
                if (!bucket.TryTake(out _))
                {
                    Log(hook.Id, delivery, type, 1, null, "rate_limited", 0);
                    LogCounts.Hooks(_world).Hit("out-dropped");
                    continue;
                }
                if (_pending.AddOrUpdate(hook.Id, 1, (_, n) => n + 1) > MaxPending)
                {
                    Release(hook.Id);
                    Log(hook.Id, delivery, type, 1, null, "queue_full", 0);
                    LogCounts.Hooks(_world).Hit("out-dropped");
                    continue;
                }
                _queue.Writer.TryWrite(new Job(hook.Id, delivery, type, body, 1));
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Write(LogLevel.Warning, "hook", "HOK-130", "http", "failed", ex, ("what", "queue"));
        }
    }

    private string Payload(string delivery, string type, object data) => JsonSerializer.Serialize(new
    {
        id = delivery,
        type,
        timestamp = _time.GetUtcNow().ToUnixTimeMilliseconds(),
        server = new { name = _world.Settings.Name },
        data,
    }, JsonSerializerOptions.Web);

    // ── Delivery ─────────────────────────────────────────────────────────────

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        _stopping = stopping;
        try
        {
            await foreach (var job in _queue.Reader.ReadAllAsync(stopping))
            {
                await _parallel.WaitAsync(stopping);
                _ = Task.Run(async () =>
                {
                    try { await RunAsync(job); }
                    finally { _parallel.Release(); }
                }, CancellationToken.None);
            }
        }
        catch (OperationCanceledException) { }
    }

    private void Release(string hookId) => _pending.AddOrUpdate(hookId, 0, (_, n) => Math.Max(0, n - 1));

    private async Task RunAsync(Job job)
    {
        var retrying = false;
        try
        {
            var hook = _world.Store.GetOutgoingWebhook(job.HookId);
            if (hook is null || !hook.Enabled) return;
            var (ok, retry, outcome, retryAfter) = await AttemptAsync(hook, job.Delivery, job.Event, job.Body, job.Attempt);
            if (ok)
            {
                _world.Store.FinishOutgoingDelivery(hook.Id, true, outcome, Now, _disableAfter);
                LogCounts.Hooks(_world).Hit("out-ok");
            }
            else if (retry && job.Attempt <= _retryDelaysMs.Length && !_stopping.IsCancellationRequested)
            {
                var delay = TimeSpan.FromMilliseconds(_retryDelaysMs[job.Attempt - 1]);
                if (retryAfter is { } after && after > delay) delay = after < TimeSpan.FromMinutes(10) ? after : TimeSpan.FromMinutes(10);
                retrying = true;
                _ = Task.Delay(delay, _time, _stopping).ContinueWith(t =>
                {
                    if (t.IsCompletedSuccessfully) _queue.Writer.TryWrite(job with { Attempt = job.Attempt + 1 });
                    else Release(job.HookId);
                }, TaskScheduler.Default);
            }
            else if (_world.Store.FinishOutgoingDelivery(hook.Id, false, outcome, Now, _disableAfter))
            {
                _log.Write(LogLevel.Warning, "hook", "HOK-120", "http", "disabled", null, ("id", hook.Id), ("why", outcome), ("n", job.Attempt));
                Changed();
                TellAdmins(hook.Id);
            }
            else
            {
                LogCounts.Hooks(_world).Hit("out-failed");
                _log.Write(LogLevel.Warning, "hook", "HOK-110", "http", "failed", null, ("id", hook.Id), ("why", outcome), ("n", job.Attempt));
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.Write(LogLevel.Warning, "hook", "HOK-130", "http", "failed", ex, ("what", "delivery"));
        }
        finally
        {
            if (!retrying) Release(job.HookId);
        }
    }

    /// <summary>Sends <c>ping</c> once, now (no retries, and it doesn't count towards turning the webhook off).</summary>
    public async Task<OutgoingDelivery> TestAsync(OutgoingWebhook hook)
    {
        var delivery = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));
        await AttemptAsync(hook, delivery, "ping", Payload(delivery, "ping", new { hook = new { id = hook.Id, name = hook.Name } }), 1);
        return _world.Store.OutgoingLog(hook.Id).FirstOrDefault(d => d.Delivery == delivery)
            ?? new OutgoingDelivery(0, hook.Id, delivery, "ping", 1, Now, null, "dropped", 0);
    }

    private async Task<(bool Ok, bool Retry, string Outcome, TimeSpan? RetryAfter)> AttemptAsync(
        OutgoingWebhook hook, string delivery, string type, string body, int attempt)
    {
        var watch = Stopwatch.StartNew();
        int? status = null;
        string outcome;
        bool ok = false, retry = false;
        TimeSpan? retryAfter = null;
        try
        {
            var uri = new Uri(hook.Url);
            if (uri.Scheme == "http" && !hook.AllowLocal) throw new BlockedAddressException();
            var timestamp = _time.GetUtcNow().ToUnixTimeSeconds();
            using var request = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            request.Headers.Add("Iskra-Webhook-Id", delivery);
            request.Headers.Add("Iskra-Webhook-Event", type);
            request.Headers.Add("Iskra-Webhook-Timestamp", timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture));
            request.Headers.Add("Iskra-Webhook-Signature", "v1=" + Sign(hook.Secret, timestamp, delivery, body));
            using var response = await (hook.AllowLocal ? _local : _public).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, _stopping);
            status = (int)response.StatusCode;
            if (status is >= 200 and < 300) (ok, outcome) = (true, "ok");
            else if (status is >= 300 and < 400) outcome = "redirect"; // never followed
            else
            {
                outcome = "http";
                retry = status is 408 or 429 or >= 500;
                retryAfter = response.Headers.RetryAfter?.Delta;
            }
        }
        catch (Exception ex) when (Blocked(ex))
        {
            outcome = "blocked";
        }
        catch (TaskCanceledException) when (!_stopping.IsCancellationRequested)
        {
            (outcome, retry) = ("timeout", true);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or SocketException or UriFormatException)
        {
            (outcome, retry) = ("network", ex is not UriFormatException);
        }
        Log(hook.Id, delivery, type, attempt, status, outcome, (int)watch.ElapsedMilliseconds);
        return (ok, retry, outcome, retryAfter);
    }

    private static bool Blocked(Exception? ex)
    {
        for (; ex is not null; ex = ex.InnerException)
            if (ex is BlockedAddressException) return true;
        return false;
    }

    private void Log(string hookId, string delivery, string type, int attempt, int? status, string outcome, int ms) =>
        _world.Store.LogOutgoingDelivery(new OutgoingDelivery(0, hookId, delivery, type, attempt, Now, status, outcome, ms));

    /// <summary>Online admins who manage webhooks hear that one was turned off; the list shows it to the others later.</summary>
    private void TellAdmins(string hookId)
    {
        var hook = _world.Store.GetOutgoingWebhook(hookId);
        if (hook is null) return;
        var frame = Frames.Event("outhook.disabled", new { hook = OutgoingWebhookFeature.View(hook) });
        foreach (var session in _hub.Sessions)
            if (session.CurrentMember() is { } m && Permissions.Has(m, Perm.ManageWebhooks)) session.Send(frame);
    }

    private long Now => _time.GetUtcNow().ToUnixTimeMilliseconds();

    public override void Dispose()
    {
        _public.Dispose();
        _local.Dispose();
        base.Dispose();
    }
}
