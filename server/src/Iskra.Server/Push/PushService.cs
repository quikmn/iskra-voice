using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Push;

/// <summary>What one push says. <see cref="Tag"/> groups pushes about the same conversation (they replace each other).</summary>
public sealed record PushNote(string Kind, string Tag, string Title, string Body, string FromName,
    long? ChannelId = null, long? MessageId = null, string? Peer = null, bool Coalesce = true, int TtlSeconds = 24 * 3600);

/// <summary>
/// Web Push for members' devices that aren't looking at Iskra right now: mentions, replies, DMs (never their content)
/// and incoming calls. Devices with a focused session get nothing, and bursts about the same conversation are merged
/// into one push per window per device.
/// </summary>
public sealed partial class PushService
{
    public const int MaxSubscriptionsPerAccount = 10;
    public const int MaxEndpointLength = 1024;

    /// <summary>The browser push services we deliver to (host or a subdomain of it). Endpoints are user-supplied, so nothing else.</summary>
    public static readonly string[] KnownPushHosts =
    [
        "fcm.googleapis.com",        // Chrome, Android, Brave, Opera, Samsung Internet
        "android.googleapis.com",
        "push.services.mozilla.com", // Firefox
        "notify.windows.com",        // Edge (WNS)
        "push.apple.com",            // Safari, iOS home-screen apps
    ];

    private readonly World _world;
    private readonly Hub _hub;
    private readonly IPushSender _sender;
    private readonly TimeProvider _time;
    private readonly ILogger<PushService> _log;
    private readonly TimeSpan _window;
    private readonly string[] _extraHosts;
    private readonly ConditionalWeakTable<Session, StrongBox<bool>> _focus = new();
    private readonly Dictionary<string, Burst> _bursts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> _lastRing = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private readonly SemaphoreSlim _sending = new(8);

    public VapidKeys Keys { get; }

    public PushService(World world, Hub hub, VapidKeys keys, IPushSender sender, TimeProvider time, IConfiguration config, ILogger<PushService> log)
    {
        _world = world;
        _hub = hub;
        Keys = keys;
        _sender = sender;
        _time = time;
        _log = log;
        _window = TimeSpan.FromMilliseconds(config.GetValue("Push:CoalesceMs", 15_000));
        _extraHosts = (config["Push:ExtraHosts"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    // ── Subscriptions ────────────────────────────────────────────────────────

    /// <summary>Null if the endpoint is acceptable, else why not: https, default port, a known push service, no credentials.</summary>
    public string? CheckEndpoint(string endpoint)
    {
        if (endpoint.Length > MaxEndpointLength || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri))
            return "That isn't a push endpoint.";
        if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0 || uri.HostNameType != UriHostNameType.Dns)
            return "Push endpoints must be plain https URLs.";
        var host = uri.IdnHost.ToLowerInvariant();
        return KnownPushHosts.Concat(_extraHosts).Any(h => host == h || host.EndsWith("." + h, StringComparison.Ordinal))
            ? null
            : "That push service isn't supported.";
    }

    /// <summary>p256dh: an uncompressed P-256 point (65 bytes); auth: a 16-byte secret. Both base64url.</summary>
    public static bool ValidKeys(string p256dh, string auth) =>
        Ed25519.TryFromB64u(p256dh, out var point) && point.Length == 65 && point[0] == 4
        && Ed25519.TryFromB64u(auth, out var secret) && secret.Length == 16;

    // ── Focus: is someone looking at Iskra on this device right now? ────────

    public void SetFocus(Session session, bool focused) => _focus.GetOrCreateValue(session).Value = focused;

    public bool IsFocused(string accountKey, string deviceKey) =>
        _hub.Sessions.Any(s => s.AccountKey == accountKey && s.DeviceKey == deviceKey && _focus.TryGetValue(s, out var f) && f.Value);

    // ── What gets pushed ─────────────────────────────────────────────────────

    [GeneratedRegex("<@([A-Za-z0-9_-]{43})>")]
    private static partial Regex MentionToken();

    [GeneratedRegex(@"(^|\s)@(everyone|here)\b")]
    private static partial Regex GroupMention();

    /// <summary>
    /// Who may ping a group with @everyone (all members) or @here (members online now): trusted and above.
    /// From anyone else the text is shown but nobody is notified. Clients apply the same rule.
    /// </summary>
    public static bool CanPingGroups(Member author) => Roles.Rank(author.Role) >= Roles.Rank(Roles.Trusted);

    /// <summary>A new channel message: mentioned people (or a group, for @everyone/@here) and the author of the message it replies to.</summary>
    public void ChatMessage(Channel channel, Message message)
    {
        var store = _world.Store;
        if (store.GetMember(message.AuthorKey) is not { } author) return;
        var kinds = new Dictionary<string, string>(StringComparer.Ordinal);
        if (message.ReplyTo is { } replyId && store.GetMessage(replyId) is { } original) kinds[original.AuthorKey] = "reply";
        var groups = GroupMention().Matches(message.Text).Select(m => m.Groups[2].Value).ToHashSet();
        if (groups.Count > 0 && CanPingGroups(author))
            foreach (var member in store.AllMembers())
                if (groups.Contains("everyone") || Features.PresenceFeature.Of(store, _hub, member.AccountKey, _time.GetUtcNow().ToUnixTimeMilliseconds()).Online) kinds[member.AccountKey] = "mention";
        foreach (Match m in MentionToken().Matches(message.Text)) kinds[m.Groups[1].Value] = "mention";
        kinds.Remove(message.AuthorKey);
        if (kinds.Count == 0) return;

        var text = MentionToken().Replace(message.Text, m => "@" + (store.GetMember(m.Groups[1].Value)?.Name ?? "unknown"));
        var body = text.Length == 0 ? "Sent an attachment" : Excerpt(text, 140);
        foreach (var (accountKey, kind) in kinds)
        {
            var target = store.GetMember(accountKey);
            if (target is null || !Permissions.CanRead(target, channel)) continue;
            var title = kind == "reply" ? $"{author.Name} replied in #{channel.Name}" : $"{author.Name} in #{channel.Name}";
            Notify(accountKey, new PushNote(kind, $"c:{channel.Id}", title, body, author.Name, ChannelId: channel.Id, MessageId: message.Id));
        }
    }

    /// <summary>A direct message. The server can't read DMs, and the push never claims to: it only says who it's from.</summary>
    public void DirectMessage(Member from, Member to)
    {
        if (from.AccountKey == to.AccountKey) return;
        Notify(to.AccountKey, new PushNote("dm", $"dm:{from.AccountKey}", $"New message from {from.Name}", "Open Iskra to read it.", from.Name,
            Peer: from.AccountKey));
    }

    /// <summary>
    /// Hook for calls: rings <paramref name="calleeKey"/>'s devices right away (no merging), short-lived so a stale
    /// call never rings later. <paramref name="channelId"/> is where the call happens, if it's in a channel.
    /// </summary>
    public void IncomingCall(Member caller, string calleeKey, long? channelId = null)
    {
        if (caller.AccountKey == calleeKey) return;
        // One ringing push per caller and callee per window: calling again and again doesn't buzz their phone each time.
        var now = _time.GetUtcNow();
        lock (_gate)
        {
            var pair = $"{calleeKey}|{caller.AccountKey}";
            if (_lastRing.TryGetValue(pair, out var last) && now - last < _window) return;
            if (_lastRing.Count > 10_000)
                foreach (var old in _lastRing.Where(r => now - r.Value >= _window).Select(r => r.Key).ToList()) _lastRing.Remove(old);
            _lastRing[pair] = now;
        }
        Notify(calleeKey, new PushNote("call", $"call:{caller.AccountKey}", $"{caller.Name} is calling", "Tap to answer.", caller.Name,
            ChannelId: channelId, Peer: caller.AccountKey, Coalesce: false, TtlSeconds: 30));
    }

    private static string Excerpt(string text, int max)
    {
        text = text.ReplaceLineEndings(" ");
        return text.Length <= max ? text : text[..max] + "…";
    }

    // ── Delivery ─────────────────────────────────────────────────────────────

    private sealed class Burst
    {
        public DateTimeOffset WindowEnd;
        public int Pending;
        public PushNote? Latest;
        public bool Scheduled;
    }

    /// <summary>
    /// Sends to each of the account's devices that isn't focused. Per device and conversation, the first push goes out at
    /// once; more within the window are merged into one push at the end of it.
    /// </summary>
    public void Notify(string accountKey, PushNote note)
    {
        List<PushSubscriptionRecord> subscriptions;
        try
        {
            if (Features.PresenceFeature.DoNotDisturb(_world.Store, accountKey)) return; // do not disturb: no pushes at all
            subscriptions = _world.Store.PushSubscriptions(accountKey);
        }
        catch (ObjectDisposedException) { return; } // shutting down
        foreach (var sub in subscriptions)
        {
            if (IsFocused(accountKey, sub.DeviceKey)) continue;
            if (!note.Coalesce)
            {
                Deliver(sub, note, 1);
                continue;
            }

            var key = sub.DeviceKey + "|" + note.Tag;
            var now = _time.GetUtcNow();
            TimeSpan? flushIn = null;
            var sendNow = false;
            lock (_gate)
            {
                if (!_bursts.TryGetValue(key, out var burst) || now >= burst.WindowEnd && !burst.Scheduled)
                {
                    if (_bursts.Count > 10_000) PruneBursts(now);
                    _bursts[key] = new Burst { WindowEnd = now + _window };
                    sendNow = true;
                }
                else
                {
                    burst.Pending++;
                    burst.Latest = note;
                    if (!burst.Scheduled)
                    {
                        burst.Scheduled = true;
                        flushIn = burst.WindowEnd - now;
                    }
                }
            }
            if (sendNow) Deliver(sub, note, 1);
            else if (flushIn is { } delay) _ = FlushLaterAsync(key, accountKey, sub.DeviceKey, delay);
        }
    }

    private void PruneBursts(DateTimeOffset now)
    {
        foreach (var (key, burst) in _bursts.Where(b => now >= b.Value.WindowEnd && !b.Value.Scheduled).ToList()) _bursts.Remove(key);
    }

    private async Task FlushLaterAsync(string key, string accountKey, string deviceKey, TimeSpan delay)
    {
        try
        {
            if (delay > TimeSpan.Zero) await Task.Delay(delay, _time);
            PushNote? note;
            int count;
            lock (_gate)
            {
                var burst = _bursts[key];
                note = burst.Latest;
                count = burst.Pending;
                burst.Pending = 0;
                burst.Latest = null;
                burst.Scheduled = false;
                burst.WindowEnd = _time.GetUtcNow() + _window; // keeps a steady stream down to one push per window
            }
            // They may have opened Iskra meanwhile.
            if (note is null || IsFocused(accountKey, deviceKey)) return;
            if (_world.Store.PushSubscriptionFor(deviceKey) is { } sub && sub.AccountKey == accountKey) Deliver(sub, note, count);
        }
        catch (ObjectDisposedException) { }
    }

    private void Deliver(PushSubscriptionRecord sub, PushNote note, int count)
    {
        var payload = JsonSerializer.Serialize(Payload(note, count), Json.Options);
        var topic = Ed25519.ToB64u(SHA256.HashData(Encoding.UTF8.GetBytes(note.Tag)))[..32];
        var delivery = new PushDelivery(sub.Endpoint, sub.P256dh, sub.Auth, payload, topic, Urgent: true, note.TtlSeconds);
        _ = Task.Run(async () =>
        {
            await _sending.WaitAsync();
            try
            {
                var outcome = await _sender.SendAsync(delivery, CancellationToken.None);
                if (outcome == PushOutcome.Gone) _world.Store.DeletePushEndpoint(sub.Endpoint);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                _log.LogDebug(e, "Push to {Host} failed", new Uri(sub.Endpoint).Host);
            }
            finally
            {
                _sending.Release();
            }
        });
    }

    /// <summary>The JSON the service worker gets (encrypted to the device; the push service can't read it).</summary>
    private object Payload(PushNote note, int count)
    {
        var (title, body) = (note.Kind, count) switch
        {
            (_, <= 1) => (note.Title, note.Body),
            ("dm", _) => ($"{count} new messages from {note.FromName}", note.Body),
            _ => (note.Title, $"{note.Body} (+{count - 1} more)"),
        };
        return new
        {
            v = 1,
            kind = note.Kind,
            server = Ed25519.ToB64u(_world.ServerPublicKey),
            serverName = _world.Settings.Name,
            title,
            body,
            tag = note.Tag,
            channelId = note.ChannelId,
            messageId = note.MessageId,
            peer = note.Peer,
            count,
            at = _time.GetUtcNow().ToUnixTimeMilliseconds(),
        };
    }
}

public static class PushServices
{
    public static IServiceCollection AddPush(this IServiceCollection services, World world)
    {
        services.AddSingleton(_ => VapidKeys.LoadOrCreate(world.Path));
        services.AddSingleton<IPushSender, WebPushSender>();
        services.AddSingleton<PushService>();
        return services;
    }
}
