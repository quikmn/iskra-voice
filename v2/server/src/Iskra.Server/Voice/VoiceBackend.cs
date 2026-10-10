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
    string ClientUrl { get; }
    string ApiKey { get; }
    string ApiSecret { get; }
    Task RemoveParticipantAsync(string room, string identity);
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
    private Process? _process;

    public bool Available { get; private set; }
    public string ClientUrl { get; }
    public string ApiKey { get; }
    public string ApiSecret { get; }

    private VoiceSettings Settings => _world.Settings.Voice;
    private string ApiUrl => $"http://127.0.0.1:{Settings.Port}";

    public LiveKitHost(World world, ILogger<LiveKitHost> log)
    {
        _world = world;
        _log = log;
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

    /// <summary>On the internet LiveKit must advertise the public IP; on a LAN or localhost the local one.</summary>
    internal static bool IsLocalOnly(string publicUrl)
    {
        var host = new Uri(publicUrl).Host;
        if (host is "localhost") return true;
        if (!System.Net.IPAddress.TryParse(host, out var ip)) return false;
        if (System.Net.IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        return b.Length == 4 && (b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168));
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

    private string ConfigYaml(int iskraPort) => $"""
        port: {Settings.Port}
        rtc:
          tcp_port: {Settings.RtcTcpPort}
          udp_port: {Settings.RtcUdpPort}
          use_external_ip: {(IsLocalOnly(_world.Settings.EffectivePublicUrl) ? "false" : "true")}
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
        info.ArgumentList.Add("--config-body");
        info.ArgumentList.Add(ConfigYaml(iskraPort));

        using var process = Process.Start(info) ?? throw new InvalidOperationException("Could not start livekit-server.");
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

    public override void Dispose()
    {
        try
        {
            if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        _http.Dispose();
        base.Dispose();
    }
}
