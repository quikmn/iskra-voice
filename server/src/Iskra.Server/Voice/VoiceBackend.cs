using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary>What the rest of the server needs from the voice backend. Tests swap in a fake.</summary>
public interface IVoiceBackend
{
    bool Available { get; }
    /// <summary>Raised when voice comes up or goes down (LiveKit starts a moment after the server).</summary>
    event Action<bool>? AvailabilityChanged;
    string ClientUrl { get; }
    string ApiKey { get; }
    string ApiSecret { get; }
    Task RemoveParticipantAsync(string room, string identity);
    /// <summary>Changes whether someone already in a room may publish (stage speakers). True if LiveKit applied it or they aren't there.</summary>
    Task<bool> SetCanPublishAsync(string room, string identity, bool canPublish);
    /// <summary>Mutes someone's microphone track (they can unmute themselves if they may still publish).</summary>
    Task MuteMicrophoneAsync(string room, string identity);
    /// <summary>The same for a bot: keeps its narrower grants (audio only, never subscribing).</summary>
    Task<bool> SetBotCanPublishAsync(string room, string identity, bool canPublish) => SetCanPublishAsync(room, identity, canPublish);
}

/// <summary>
/// Starts livekit-server as a child process with a config generated from the world, restarts it if it dies,
/// and stops it with the server. Keys live in the world folder (livekit.key).
/// </summary>
public sealed class LiveKitHost : BackgroundService, IVoiceBackend
{
    private readonly World _world;
    private readonly ILogger<LiveKitHost> _log;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private readonly Hosting.InternetHost? _internet;
    private Process? _process;
    private volatile bool _restarting;

    private bool _available;

    public bool Available
    {
        get => _available;
        private set
        {
            if (_available == value) return;
            _available = value;
            AvailabilityChanged?.Invoke(value);
        }
    }

    public event Action<bool>? AvailabilityChanged;
    public string ClientUrl { get; }
    public string ApiKey { get; }
    public string ApiSecret { get; }

    private VoiceSettings Settings => _world.Settings.Voice;
    private string ApiUrl => $"http://127.0.0.1:{Settings.Port}";

    public LiveKitHost(World world, ILogger<LiveKitHost> log, Hosting.InternetHost? internet = null)
    {
        _world = world;
        _log = log;
        _internet = internet;
        if (internet is not null) internet.VoiceIpChanged += Restart;
        (ApiKey, ApiSecret) = LoadOrCreateKeys(world.Path);
        ClientUrl = Settings.ClientUrl?.TrimEnd('/') ?? DefaultClientUrl(world.Settings.EffectivePublicUrl);
    }

    /// <summary>Voice signaling goes through iskra-server itself (proxied at /livekit), so friends only need the one web port.</summary>
    internal static string DefaultClientUrl(string publicUrl)
    {
        var uri = new Uri(publicUrl);
        return $"{(uri.Scheme == "https" ? "wss" : "ws")}://{uri.Authority}{uri.AbsolutePath.TrimEnd('/')}/livekit";
    }

    /// <summary>Where iskra-server reaches LiveKit locally (for the proxy and API calls).</summary>
    public string LocalUrl => $"http://127.0.0.1:{Settings.Port}";

    /// <summary>
    /// On the internet LiveKit must advertise the public IP; on a LAN, localhost or Tailscale (100.64.0.0/10 or a
    /// .ts.net name) its interface addresses, or it would advertise the home's shared CGNAT address and voice breaks.
    /// </summary>
    internal static bool IsLocalOnly(string publicUrl)
    {
        var host = new Uri(publicUrl).Host;
        if (host is "localhost" || Hosting.Tailscale.IsTailscaleHost(host)) return true;
        return System.Net.IPAddress.TryParse(host, out var ip) && Hosting.Networks.IsNonPublic(ip);
    }

    /// <summary>
    /// The voice URL for a client that connected through <paramref name="origin"/>: over HTTPS (internet hosting) or
    /// Tailscale, voice goes through the address the client used; otherwise the server's own.
    /// </summary>
    internal static string ClientUrlFor(string? origin, IVoiceBackend backend, string? configured)
    {
        if (configured is not null || origin is null || !Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return backend.ClientUrl;
        return uri.Scheme == "https" || Hosting.Tailscale.IsTailscaleHost(uri.Host) ? DefaultClientUrl(origin) : backend.ClientUrl;
    }

    private static (string, string) LoadOrCreateKeys(string worldPath)
    {
        var path = Path.Combine(worldPath, "livekit.key");
        if (File.Exists(path))
        {
            var lines = File.ReadAllLines(path).Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
            if (lines.Length == 2) return (lines[0], lines[1]);
            throw new InvalidDataException($"{path} must contain an API key line and a secret line.");
        }
        var key = "iskra" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();
        var secret = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32));
        AtomicFile.WriteAllText(path, $"{key}\n{secret}\n");
        return (key, secret);
    }

    private string? FindBinary()
    {
        var name = OperatingSystem.IsWindows() ? "livekit-server.exe" : "livekit-server";
        var candidates = new List<string?>
        {
            Settings.LiveKitPath,
            Path.Combine(AppContext.BaseDirectory, name),
            Environment.GetEnvironmentVariable("ISKRA_LIVEKIT"),
        };
        candidates.AddRange((Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Select(dir => Path.Combine(dir, name)));
        return candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c) && File.Exists(c));
    }

    /// <summary>Internet hosting knows the public IP from the router: advertise it, and keep the LAN address for friends at home.</summary>
    internal static string RtcAddressYaml(System.Net.IPAddress? publicIp, string publicUrl) => publicIp is not null
        ? $"use_external_ip: false\n  node_ip: {publicIp}\n  advertise_internal_ip: true"
        : $"use_external_ip: {(IsLocalOnly(publicUrl) ? "false" : "true")}";

    /// <summary>The public IP changed (or hosting was switched): restart LiveKit with the new address.</summary>
    private void Restart()
    {
        try
        {
            if (_process is not { HasExited: false } process) return;
            _log.LogInformation("Restarting voice for the new public address");
            _restarting = true;
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
    }

    // LiveKit's API only listens on localhost: clients reach it through the server's /livekit proxy. Media ports stay open.
    // No enabled_codecs: LiveKit's defaults include audio/red, which clients publish voice with (redundant audio).
    private string ConfigYaml(int iskraPort) => $"""
        port: {Settings.Port}
        bind_addresses: [127.0.0.1]
        rtc:
          tcp_port: {Settings.RtcTcpPort}
          udp_port: {Settings.RtcUdpPort}
          {RtcAddressYaml(_internet?.VoiceIp, _world.Settings.EffectivePublicUrl)}
        keys:
          {ApiKey}: {ApiSecret}
        webhook:
          api_key: {ApiKey}
          urls:
            - http://127.0.0.1:{iskraPort}/internal/livekit-webhook
        room:
          empty_timeout: 30
        logging:
          level: warn
        """;

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (!Settings.Enabled)
        {
            _log.LogInformation("Voice is turned off in server.json.");
            return;
        }
        var binary = FindBinary();
        if (binary is null)
        {
            _log.LogWarning("Voice is unavailable: livekit-server was not found (put it next to iskra-server, set Voice.LiveKitPath, or ISKRA_LIVEKIT).");
            return;
        }

        var failures = 0;
        while (!stopping.IsCancellationRequested)
        {
            var started = DateTime.UtcNow;
            try
            {
                await RunOnceAsync(binary, stopping);
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Voice server failed");
            }
            Available = false;
            if (stopping.IsCancellationRequested) break;
            if (_restarting)
            {
                _restarting = false;
                failures = 0;
                continue;
            }

            failures = DateTime.UtcNow - started > TimeSpan.FromMinutes(1) ? 1 : failures + 1;
            var delay = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, failures)));
            _log.LogWarning("Voice server stopped; restarting in {Delay}s", delay.TotalSeconds);
            await Task.Delay(delay, stopping).ContinueWith(_ => { }, TaskScheduler.Default);
        }
    }

    private async Task RunOnceAsync(string binary, CancellationToken stopping)
    {
        var iskraPort = _world.Settings.Port;
        var info = new ProcessStartInfo(binary)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        // The config holds the API secret: pass it in the environment (private to us), not on the command line (visible to every user).
        info.Environment["LIVEKIT_CONFIG"] = ConfigYaml(iskraPort);

        using var process = Process.Start(info) ?? throw new InvalidOperationException("Could not start livekit-server.");
        Hosting.ChildProcesses.Bind(process); // dies with us, even if we're killed
        _process = process;
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) _log.LogDebug("livekit: {Line}", e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) _log.LogInformation("livekit: {Line}", e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        try
        {
            for (var i = 0; i < 100 && !process.HasExited && !Available; i++)
            {
                try
                {
                    Available = (await _http.GetAsync(ApiUrl, stopping)).IsSuccessStatusCode;
                }
                catch (HttpRequestException) { }
                if (!Available) await Task.Delay(100, stopping);
            }
            if (Available) _log.LogInformation("Voice ready (LiveKit on port {Port}, clients use {Url})", Settings.Port, ClientUrl);
            await process.WaitForExitAsync(stopping);
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            _process = null;
        }
    }

    public async Task RemoveParticipantAsync(string room, string identity)
    {
        if (!Available) return;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{ApiUrl}/twirp/livekit.RoomService/RemoveParticipant")
        {
            Content = new StringContent(JsonSerializer.Serialize(new { room, identity }), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", LiveKitTokens.Admin(ApiKey, ApiSecret, room, DateTimeOffset.UtcNow));
        try
        {
            using var response = await _http.SendAsync(request);
            if (!response.IsSuccessStatusCode && response.StatusCode != System.Net.HttpStatusCode.NotFound)
                _log.LogWarning("Removing {Identity} from {Room} failed: {Status}", identity[..8], room, response.StatusCode);
        }
        catch (HttpRequestException ex)
        {
            _log.LogWarning(ex, "Could not reach the voice server to remove a participant");
        }
    }

    /// <summary>Calls one LiveKit RoomService method (Twirp JSON, signed with a short-lived room-admin token).</summary>
    private async Task<HttpResponseMessage?> RoomServiceAsync(string method, string room, object body)
    {
        if (!Available) return null;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{ApiUrl}/twirp/livekit.RoomService/{method}")
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", LiveKitTokens.Admin(ApiKey, ApiSecret, room, DateTimeOffset.UtcNow));
        try
        {
            return await _http.SendAsync(request);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            _log.LogWarning(ex, "Could not reach the voice server ({Method})", method);
            return null;
        }
    }

    public Task<bool> SetCanPublishAsync(string room, string identity, bool canPublish) =>
        // The permission replaces the old one as a whole, so subscribing is spelled out too.
        UpdatePermissionAsync(room, identity, new { canSubscribe = true, canPublish, canPublishData = canPublish });

    public Task<bool> SetBotCanPublishAsync(string room, string identity, bool canPublish) =>
        UpdatePermissionAsync(room, identity, new { canSubscribe = false, canPublish, canPublishData = false, canPublishSources = new[] { "MICROPHONE" } });

    private async Task<bool> UpdatePermissionAsync(string room, string identity, object permission)
    {
        using var response = await RoomServiceAsync("UpdateParticipant", room, new { room, identity, permission });
        if (response is null) return false;
        if (response.IsSuccessStatusCode || response.StatusCode == System.Net.HttpStatusCode.NotFound) return true;
        _log.LogWarning("Changing {Identity}'s permissions in {Room} failed: {Status}", identity[..Math.Min(8, identity.Length)], room, response.StatusCode);
        return false;
    }

    public async Task MuteMicrophoneAsync(string room, string identity)
    {
        using var response = await RoomServiceAsync("GetParticipant", room, new { room, identity });
        if (response is not { IsSuccessStatusCode: true }) return;
        using var info = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!info.RootElement.TryGetProperty("tracks", out var tracks) || tracks.ValueKind != JsonValueKind.Array) return;
        foreach (var track in tracks.EnumerateArray())
        {
            if (!IsMicrophone(track) || !track.TryGetProperty("sid", out var sid)) continue;
            using var _ = await RoomServiceAsync("MutePublishedTrack", room, new { room, identity, trackSid = sid.GetString(), muted = true });
        }
    }

    /// <summary>protojson leaves out zero enum values: type AUDIO is 0, source MICROPHONE is 2.</summary>
    internal static bool IsMicrophone(JsonElement track)
    {
        static string? Name(JsonElement t, string field) =>
            !t.TryGetProperty(field, out var v) ? null : v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString();
        var source = Name(track, "source");
        if (source is not null and not ("UNKNOWN" or "0")) return source is "MICROPHONE" or "2";
        return Name(track, "type") is null or "AUDIO" or "0";
    }

    public override void Dispose()
    {
        if (_internet is not null) _internet.VoiceIpChanged -= Restart;
        try
        {
            if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        _http.Dispose();
        base.Dispose();
    }
}
