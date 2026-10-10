using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Hosting;

/// <summary>One port the server needs from the router, and how that went.</summary>
public sealed record PortStatus(string Name, string Protocol, int Internal, int External, string State, string? Error);

public sealed record RouterStatus(string State, string? Kind);

public sealed record HttpsStatus(string State, string? Domain, long? ExpiresAt, string? Error);

/// <summary>Everything the owner sees in "Open to the internet" (see PROTOCOL.md, host.status).</summary>
public sealed record HostStatus(
    bool Enabled,
    string? LanUrl,
    RouterStatus Router,
    string? PublicIp,
    bool Cgnat,
    IReadOnlyList<PortStatus> Ports,
    string? Address,
    bool AutoAddress,
    HttpsStatus Https,
    string Reachable,
    string? PublicUrl,
    long? CheckedAt);

/// <summary>
/// "Open to the internet": asks the router to forward the ports (UPnP / NAT-PMP), keeps the leases fresh,
/// picks a public address (your domain, or &lt;ip&gt;.sslip.io), gets an HTTPS certificate for it, and tells
/// LiveKit the public IP. Re-checks every few minutes, so router restarts and new IPs are picked up.
/// Mappings are removed on shutdown.
/// </summary>
public sealed class InternetHost : BackgroundService
{
    private static readonly TimeSpan Lease = TimeSpan.FromHours(1);
    private static readonly TimeSpan Recheck = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RetrySoon = TimeSpan.FromMinutes(1);
    private const string Description = "Iskra";

    private readonly World _world;
    private readonly IPortMapper _mapper;
    private readonly Certificates _certificates;
    private readonly Hub _hub;
    private readonly ILogger<InternetHost> _log;
    private readonly TimeProvider _time;
    private readonly HttpClient _probe = new(new SocketsHttpHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false,
        // The probe checks that our own port answers with our own token; the certificate isn't the point.
        SslOptions = { RemoteCertificateValidationCallback = (_, _, _, _) => true },
    })
    { Timeout = TimeSpan.FromSeconds(4) };

    private readonly Lock _gate = new();
    private TaskCompletionSource _wake = new(TaskCreationOptions.RunContinuationsAsynchronously);

    // Written by the loop; read by Status().
    private volatile INatRouter? _router;
    private volatile string _routerState = "off";
    private volatile IPAddress? _publicIp;
    private volatile bool _cgnat;
    private volatile IReadOnlyList<PortStatus> _ports = [];
    private readonly List<MappedPort> _active = [];
    private volatile bool _hairpin;
    private string? _probed;
    private DateTimeOffset _probedAt;
    private long? _checkedAt;
    private string? _published;

    /// <summary>The token our own probe endpoint answers with, to recognise our server through the router.</summary>
    public string ProbeToken { get; } = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));

    /// <summary>The public IP LiveKit should advertise, or null when not hosting on the internet.</summary>
    public IPAddress? VoiceIp => _world.Settings.Internet.Enabled && !_cgnat ? _publicIp : null;

    /// <summary>Raised when <see cref="VoiceIp"/> changes (LiveKit restarts with the new address).</summary>
    public event Action? VoiceIpChanged;

    public InternetHost(World world, IPortMapper mapper, Certificates certificates, Hub hub, ILogger<InternetHost> log, TimeProvider time)
    {
        _world = world;
        _mapper = mapper;
        _certificates = certificates;
        _hub = hub;
        _log = log;
        _time = time;
        _certificates.Changed += Publish;
    }

    // ── Owner actions ────────────────────────────────────────────────────────

    /// <summary>Turns internet hosting on or off (saved in server.json). Turning it on again retries right away.</summary>
    public void SetEnabled(bool enabled)
    {
        if (_world.Settings.Internet.Enabled != enabled)
            _world.UpdateSettings(s => s with { Internet = s.Internet with { Enabled = enabled } });
        if (enabled) _certificates.RetryNow();
        Wake();
        Publish();
    }

    private void Wake() => Interlocked.Exchange(ref _wake, new(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();

    // ── The loop ─────────────────────────────────────────────────────────────

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        Publish();
        while (!stopping.IsCancellationRequested)
        {
            var wake = _wake.Task;
            TimeSpan next;
            try
            {
                next = _world.Settings.Internet.Enabled ? await PassAsync(stopping) : await CloseAsync(stopping);
            }
            catch (Exception ex) when (!stopping.IsCancellationRequested)
            {
                _log.LogWarning(ex, "Internet hosting check failed");
                _router = null;
                next = RetrySoon;
            }
            Publish();
            await Task.WhenAny(wake, Task.Delay(next, _time, stopping));
        }
    }

    /// <summary>One round: find the router, read the public IP, (re)map every port, pick the address and certificate.</summary>
    private async Task<TimeSpan> PassAsync(CancellationToken cancel)
    {
        var settings = _world.Settings;
        var next = Recheck;
        IPAddress? ip = null;

        if (!settings.Internet.PortMapping)
        {
            _routerState = "disabled";
            _router = null;
        }
        else
        {
            if (_router is null)
            {
                _routerState = "searching";
                Publish();
                _router = await _mapper.FindRouterAsync(cancel);
            }
            if (_router is { } router)
            {
                try
                {
                    ip = await router.ExternalAddressAsync(cancel);
                    _routerState = "found";
                }
                catch (Exception ex) when (ex is PortMappingException or SocketException or HttpRequestException or TaskCanceledException && !cancel.IsCancellationRequested)
                {
                    // The router restarted or went away: look for it again soon.
                    _log.LogInformation("The router stopped answering ({Message})", ex.Message);
                    _router = null;
                }
            }
            if (_router is null)
            {
                _routerState = "not_found";
                next = RetrySoon;
            }
        }

        var cgnat = IsCgnat(ip);
        if (ip is not null && !ip.Equals(_publicIp))
        {
            _log.LogInformation("Public address: {Ip}{Cgnat}", ip, cgnat ? " (shared with other customers: carrier-grade NAT)" : "");
            _hairpin = false;
        }
        var voiceBefore = VoiceIp;
        if (ip is not null) _publicIp = ip;
        else if (_router is null && settings.Internet.PortMapping) _publicIp = null;
        _cgnat = cgnat;
        if (!Equals(voiceBefore, VoiceIp)) VoiceIpChanged?.Invoke();

        var plans = Plan(settings);
        if (_router is { } r && ip is not null && !cgnat)
        {
            var (ports, shortest) = await MapAllAsync(r, plans, settings, cancel);
            _ports = ports;
            if (ports.Any(p => p.State == "failed")) next = Min(next, Recheck);
            if (shortest is { } lease && lease > TimeSpan.Zero) next = Min(next, lease / 2);
        }
        else
        {
            var state = cgnat ? "skipped" : "manual";
            _ports = plans.Select(p => new PortStatus(p.Name, Proto(p.Protocol), p.Internal, p.Externals[0], state, null)).ToList();
            if (cgnat) await UnmapAllAsync(cancel);
        }
        _checkedAt = _time.GetUtcNow().ToUnixTimeMilliseconds();

        UpdateAddress();
        await ProbeAsync(cancel);
        return next;
    }

    private static TimeSpan Min(TimeSpan a, TimeSpan b) => a < b ? a : b;

    private static string Proto(PortProtocol p) => p == PortProtocol.Tcp ? "tcp" : "udp";

    internal sealed record PortPlan(string Name, PortProtocol Protocol, int Internal, int[] Externals);

    /// <summary>
    /// The ports to open. With automatic HTTPS the main port speaks both HTTP and HTTPS, so outside 80
    /// (Let's Encrypt's check) and 443 both lead to it; voice needs LiveKit's two media ports.
    /// </summary>
    internal static List<PortPlan> Plan(WorldSettings s)
    {
        var plans = new List<PortPlan>();
        if (s.Https.Enabled)
        {
            if (s.Https.Mode == "acme") plans.Add(new("acme", PortProtocol.Tcp, s.Https.HttpPort, [80]));
            plans.Add(new("web", PortProtocol.Tcp, s.Https.Port, [s.Https.Port]));
        }
        else
        {
            plans.Add(new("acme", PortProtocol.Tcp, s.Port, [80]));
            plans.Add(new("web", PortProtocol.Tcp, s.Port, s.Port == 443 ? [443] : [443, s.Port]));
        }
        if (s.Voice.Enabled)
        {
            plans.Add(new("voice-tcp", PortProtocol.Tcp, s.Voice.RtcTcpPort, [s.Voice.RtcTcpPort]));
            plans.Add(new("voice-udp", PortProtocol.Udp, s.Voice.RtcUdpPort, [s.Voice.RtcUdpPort]));
        }
        return plans;
    }

    private async Task<(List<PortStatus>, TimeSpan?)> MapAllAsync(INatRouter router, List<PortPlan> plans, WorldSettings settings, CancellationToken cancel)
    {
        var result = new List<PortStatus>();
        TimeSpan? shortest = null;
        var acmeOpen = true;
        var wanted = new List<MappedPort>();
        foreach (var plan in plans)
        {
            // Without port 80 there's no certificate, so don't take 443 for plain HTTP: keep the server's own port.
            var externals = plan.Name == "web" && !settings.Https.Enabled && !acmeOpen ? [settings.Port] : plan.Externals;
            string? error = null;
            MappedPort? mapped = null;
            foreach (var external in externals)
            {
                try
                {
                    mapped = await router.MapAsync(plan.Protocol, plan.Internal, external, Lease, Description, cancel);
                    break;
                }
                catch (PortMappingException ex)
                {
                    error = ex.Message;
                    if (!ex.Refused) break; // no answer: trying other ports won't help
                }
            }
            if (plan.Name == "acme") acmeOpen = mapped is not null;
            if (mapped is null)
            {
                result.Add(new PortStatus(plan.Name, Proto(plan.Protocol), plan.Internal, externals[0], "failed", error));
                continue;
            }
            wanted.Add(mapped);
            if (mapped.Lifetime > TimeSpan.Zero && (shortest is null || mapped.Lifetime < shortest)) shortest = mapped.Lifetime;
            result.Add(new PortStatus(plan.Name, Proto(plan.Protocol), plan.Internal, mapped.ExternalPort, "open", null));
        }

        // Forget mappings we no longer use (e.g. 443 after falling back to the server's own port).
        List<MappedPort> stale;
        lock (_active)
        {
            stale = _active.Where(a => !wanted.Any(w => w.Protocol == a.Protocol && w.ExternalPort == a.ExternalPort)).ToList();
            _active.Clear();
            _active.AddRange(wanted);
        }
        foreach (var old in stale) await TryUnmapAsync(router, old, cancel);
        return (result, shortest);
    }

    private async Task TryUnmapAsync(INatRouter router, MappedPort mapping, CancellationToken cancel)
    {
        try
        {
            await router.UnmapAsync(mapping, cancel);
        }
        catch (Exception ex) when (ex is PortMappingException or SocketException or HttpRequestException or TaskCanceledException && !cancel.IsCancellationRequested)
        {
            _log.LogInformation("Removing port {Port} from the router failed: {Message}", mapping.ExternalPort, ex.Message);
        }
    }

    private async Task UnmapAllAsync(CancellationToken cancel)
    {
        List<MappedPort> active;
        lock (_active)
        {
            active = [.. _active];
            _active.Clear();
        }
        if (_router is { } router)
            foreach (var mapping in active) await TryUnmapAsync(router, mapping, cancel);
    }

    /// <summary>Internet hosting is off: close the ports and stop asking for a certificate.</summary>
    private async Task<TimeSpan> CloseAsync(CancellationToken cancel)
    {
        await UnmapAllAsync(cancel);
        var voiceBefore = VoiceIp;
        _router = null;
        _routerState = "off";
        _ports = [];
        _publicIp = null;
        _cgnat = false;
        _hairpin = false;
        if (!Equals(voiceBefore, VoiceIp)) VoiceIpChanged?.Invoke();
        UpdateAddress();
        return Timeout.InfiniteTimeSpan;
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await UnmapAllAsync(timeout.Token);
    }

    // ── Address, certificate, public URL ─────────────────────────────────────

    /// <summary>The loop's findings, read once so a status never mixes two moments.</summary>
    private sealed record View(IPAddress? Ip, IReadOnlyList<PortStatus> Ports)
    {
        public bool Cgnat => IsCgnat(Ip);

        public PortStatus? Port(string name) => Ports.FirstOrDefault(p => p.Name == name);
    }

    private View Now() => new(_publicIp, _ports);

    /// <summary>The router's "public" address is itself private: another NAT (the ISP's, or a second router) sits in front.</summary>
    private static bool IsCgnat(IPAddress? ip) => ip is not null && (ip.Equals(IPAddress.Any) || Networks.IsNonPublic(ip));

    private static string? Domain(WorldSettings s, View v)
    {
        if (!s.Internet.Enabled) return null;
        if (!string.IsNullOrWhiteSpace(s.Internet.Domain)) return s.Internet.Domain.Trim().ToLowerInvariant();
        if (s.Https.Enabled) return s.Https.Domain;
        return v.Ip is { } ip && !v.Cgnat ? $"{Networks.Dashed(ip)}.{s.Internet.DnsSuffix.Trim('.')}" : null;
    }

    private PortStatus? Port(string name) => _ports.FirstOrDefault(p => p.Name == name);

    /// <summary>Points the certificate at the current address and works out the public URL.</summary>
    private void UpdateAddress()
    {
        var s = _world.Settings;
        var v = Now();
        var domain = Domain(s, v);
        if (s.Https.Mode == "off")
        {
            // Let's Encrypt checks port 80: only ask when it's open (or the owner forwards ports by hand).
            var acme = v.Port("acme");
            var canValidate = acme is { State: "open" or "manual" };
            _certificates.Want(domain is not null && canValidate ? domain : null);
        }
        Publish();
    }

    private static string? PublicUrl(WorldSettings s, View v, HttpsStatus https, string? domain)
    {
        if (!s.Internet.Enabled || domain is null) return null;
        var web = v.Port("web");
        if (https.State == "valid")
        {
            var port = web?.External ?? (s.Https.Enabled ? s.Https.Port : 443);
            return $"https://{domain}{(port == 443 ? "" : $":{port}")}";
        }
        // No certificate (yet): the desktop app can still connect over plain HTTP; browsers can't.
        return web is { State: "open" } && v.Ip is { } ip && !v.Cgnat && !s.Https.Enabled ? $"http://{ip}:{web.External}" : null;
    }

    private HttpsStatus Https(WorldSettings s, View v, string? domain)
    {
        if (!s.Internet.Enabled) return new("off", null, null, null);
        var cert = _certificates.Status;
        if (s.Https.Mode == "files") return new("valid", s.Https.Domain ?? cert.Domain, cert.ExpiresAt, null);
        if (domain is null) return new("waiting", null, null, null);
        if (s.Https.Mode == "off" && v.Port("acme") is { State: "failed" or "skipped" }) return new("needs_port_80", domain, null, null);
        if (cert.Domain != domain) return new("waiting", domain, null, null);
        return cert.State switch
        {
            "valid" => new("valid", domain, cert.ExpiresAt, null),
            "failed" => new("failed", domain, null, cert.Error),
            "requesting" => new("requesting", domain, null, null),
            _ => new("waiting", domain, null, null),
        };
    }

    /// <summary>What we can honestly say about reaching the server from outside.</summary>
    private string Reachable(HttpsStatus https)
    {
        // Let's Encrypt connected to us from the internet to hand out the certificate.
        if (https.State == "valid" && _certificates.Status.VerifiedAt is not null && _certificates.Status.Domain == https.Domain) return "verified";
        return _hairpin ? "router" : "unknown";
    }

    /// <summary>Asks for our own probe token through the public address. Many routers can't loop back; that proves nothing either way.</summary>
    private async Task ProbeAsync(CancellationToken cancel)
    {
        var web = Port("web");
        if (web is not { State: "open" } || _publicIp is not { } ip || _cgnat)
        {
            _hairpin = false;
            return;
        }
        var scheme = _world.Settings.Https.Enabled ? "https" : "http";
        var target = $"{scheme}://{ip}:{web.External}";
        // Once per address, then every half hour (a failed probe waits on a timeout).
        if (target == _probed && _time.GetUtcNow() - _probedAt < TimeSpan.FromMinutes(30)) return;
        _probed = target;
        _probedAt = _time.GetUtcNow();
        try
        {
            var answer = await _probe.GetStringAsync($"{target}/.well-known/iskra-probe/{ProbeToken}", cancel);
            _hairpin = answer.Trim() == ProbeToken;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancel.IsCancellationRequested)
        {
            _hairpin = false;
        }
    }

    // ── Status ───────────────────────────────────────────────────────────────

    public HostStatus Status()
    {
        var s = _world.Settings;
        var v = Now();
        var domain = Domain(s, v);
        var https = Https(s, v, domain);
        var lan = Networks.LanAddress();
        return new HostStatus(
            Enabled: s.Internet.Enabled,
            LanUrl: lan is null || s.Https.Enabled ? null : $"http://{lan}:{s.Port}",
            Router: new RouterStatus(s.Internet.Enabled ? _routerState : "off", _router?.Kind),
            PublicIp: s.Internet.Enabled ? v.Ip?.ToString() : null,
            Cgnat: s.Internet.Enabled && v.Cgnat,
            Ports: s.Internet.Enabled ? v.Ports : [],
            Address: domain,
            AutoAddress: domain is not null && string.IsNullOrWhiteSpace(s.Internet.Domain) && !s.Https.Enabled,
            Https: https,
            Reachable: s.Internet.Enabled ? Reachable(https) : "unknown",
            PublicUrl: PublicUrl(s, v, https, domain),
            CheckedAt: s.Internet.Enabled ? _checkedAt : null);
    }

    /// <summary>Sends the status to admins when it changed, and the public address to everyone when that changed.</summary>
    private void Publish()
    {
        lock (_gate)
        {
            var status = Status();
            if (status.PublicUrl != _world.InternetUrl)
            {
                _world.InternetUrl = status.PublicUrl;
                _hub.Broadcast(Frames.Event("server.address", new { publicUrl = status.PublicUrl }));
            }
            var json = JsonSerializer.Serialize(status, Json.Options);
            if (json == _published) return;
            _published = json;
            var frame = Frames.Event("host.status", new { status });
            foreach (var session in _hub.Sessions)
            {
                if (session.CurrentMember() is { } member && Permissions.IsAdmin(member)) session.Send(frame);
            }
        }
    }

    public override void Dispose()
    {
        _certificates.Changed -= Publish;
        _probe.Dispose();
        base.Dispose();
    }
}
