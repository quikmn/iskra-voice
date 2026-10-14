using System.Diagnostics;
using System.Text.Json;
using Iskra.Server.Storage;

namespace Iskra.Server.Hosting;

/// <summary>
/// The peer-to-peer tunnel of a standalone server: while P2p is on, runs iskra-p2p (the desktop app's tunnel code as
/// one program, desktop/src/p2p/sidecar.ts) on the world folder, restarts it if it dies and stops it with the server,
/// like LiveKit. It reads p2p.key and p2p.port itself; stdin carries "sync" (a new secret) and its end means stop;
/// stdout carries its status as JSON lines. Not when the desktop app hosts this server (ISKRA_P2P_TUNNEL=app): the
/// app runs the tunnel in its own process.
/// </summary>
public sealed class P2pSidecar : BackgroundService
{
    public const string BinaryName = "iskra-p2p";
    private static readonly TimeSpan GracefulStop = TimeSpan.FromSeconds(3);
    private static readonly HashSet<string> ReportedStates = ["starting", "ready", "unavailable", "failed", "off"];

    private readonly World _world;
    private readonly ILogger<P2pSidecar> _log;
    private readonly IHostApplicationLifetime? _lifetime;
    private readonly SemaphoreSlim _wake = new(0);
    private readonly object _gate = new();
    private Process? _process;
    private Status _status = new("off", null, null, 0);

    /// <summary>The desktop app runs the tunnel for this server.</summary>
    public bool HostedByApp { get; }

    /// <summary>Times the program was started (tests).</summary>
    public int Starts { get; private set; }

    public P2pSidecar(World world, ILogger<P2pSidecar> log, IHostApplicationLifetime? lifetime = null) :
        this(world, log, lifetime, Environment.GetEnvironmentVariable("ISKRA_P2P_TUNNEL") == "app") { }

    internal P2pSidecar(World world, ILogger<P2pSidecar> log, IHostApplicationLifetime? lifetime, bool hostedByApp)
    {
        _world = world;
        _log = log;
        _lifetime = lifetime;
        HostedByApp = hostedByApp;
    }

    private P2pSettings Settings => _world.Settings.P2p;

    internal sealed record Nat(bool Firewalled, bool Randomized, string? PublicAddress);

    /// <summary>
    /// What the tunnel is doing: <c>off</c>, <c>missing</c> (no iskra-p2p here), <c>starting</c>, <c>ready</c>,
    /// <c>unavailable</c> (LocalOnly without a testnet) or <c>failed</c> (it's started again after a pause).
    /// </summary>
    internal sealed record Status(string State, string? Error, Nat? Nat, int Connections);

    internal Status Current
    {
        get { lock (_gate) return _status; }
    }

    /// <summary>The tunnel part of p2p.status, or null when the desktop app runs it.</summary>
    public object? View()
    {
        if (HostedByApp) return null;
        var s = Current;
        return new
        {
            state = s.State,
            nat = s.Nat is null ? null : new { firewalled = s.Nat.Firewalled, randomized = s.Nat.Randomized, publicAddress = s.Nat.PublicAddress },
            connections = s.Connections,
            error = s.Error,
        };
    }

    private void Set(Status status)
    {
        lock (_gate) _status = status;
    }

    /// <summary>The owner turned the feature on or off: start or stop the program.</summary>
    public void Changed()
    {
        if (HostedByApp) return;
        if (!Settings.Enabled) _ = Task.Run(StopProcess); // the request doesn't wait for it to leave the DHT
        try
        {
            _wake.Release();
        }
        catch (ObjectDisposedException) { } // stopping
    }

    /// <summary>A new secret in p2p.key: the program announces the new key.</summary>
    public void Rotated()
    {
        if (HostedByApp) return;
        lock (_gate)
        {
            try
            {
                if (_process is { HasExited: false } p)
                {
                    p.StandardInput.Write("sync\n"); // \n on every OS
                    p.StandardInput.Flush();
                }
            }
            catch (Exception e) when (e is IOException or InvalidOperationException) { }
        }
    }

    /// <summary>iskra-p2p next to iskra-server, a configured path, or ISKRA_P2P_SIDECAR (a .js file runs with node).</summary>
    internal string? FindBinary()
    {
        var name = OperatingSystem.IsWindows() ? BinaryName + ".exe" : BinaryName;
        string?[] candidates = [Settings.SidecarPath, Path.Combine(AppContext.BaseDirectory, name), Environment.GetEnvironmentVariable("ISKRA_P2P_SIDECAR")];
        return candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c) && File.Exists(c));
    }

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (HostedByApp) return;
        // The tunnel listener's port (p2p.port) is written once the server listens.
        if (_lifetime is not null)
        {
            var started = new TaskCompletionSource();
            using (_lifetime.ApplicationStarted.Register(() => started.TrySetResult()))
            using (stopping.Register(() => started.TrySetResult()))
                await started.Task;
        }
        var failures = 0;
        var warnedMissing = false;
        while (!stopping.IsCancellationRequested)
        {
            if (!Settings.Enabled)
            {
                Set(new("off", null, null, 0));
                failures = 0;
                await WaitAsync(Timeout.InfiniteTimeSpan, stopping);
                continue;
            }
            var binary = FindBinary();
            if (binary is null)
            {
                if (!warnedMissing)
                    _log.LogWarning("Friends can't connect without port forwarding: {Name} was not found (put it next to iskra-server, or set P2p.SidecarPath).", BinaryName);
                warnedMissing = true;
                Set(new("missing", null, null, 0));
                await WaitAsync(Timeout.InfiniteTimeSpan, stopping);
                continue;
            }

            var since = DateTime.UtcNow;
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
                _log.LogError(ex, "The peer-to-peer tunnel failed");
            }
            if (stopping.IsCancellationRequested) break;
            if (!Settings.Enabled) continue; // turned off: it was stopped on purpose

            failures = DateTime.UtcNow - since > TimeSpan.FromMinutes(1) ? 1 : failures + 1;
            var delay = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, failures)));
            var last = Current;
            Set(last with { State = "failed", Error = last.Error ?? "stopped", Connections = 0 });
            _log.LogWarning("The peer-to-peer tunnel stopped; starting it again in {Delay}s", delay.TotalSeconds);
            await WaitAsync(delay, stopping);
        }
    }

    private async Task WaitAsync(TimeSpan delay, CancellationToken stopping)
    {
        try
        {
            await _wake.WaitAsync(delay, stopping);
        }
        catch (OperationCanceledException) { }
    }

    private async Task RunOnceAsync(string binary, CancellationToken stopping)
    {
        var script = binary.EndsWith(".js", StringComparison.OrdinalIgnoreCase) || binary.EndsWith(".cjs", StringComparison.OrdinalIgnoreCase);
        var info = new ProcessStartInfo(script ? "node" : binary)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (script) info.ArgumentList.Add(binary);
        info.ArgumentList.Add(_world.Path);
        // A LocalOnly server's tunnel binds 127.0.0.1 and joins only the testnet it's given (never the public DHT).
        if (_world.Settings.LocalOnly) info.Environment["ISKRA_LOCAL_ONLY"] = "1";
        else info.Environment.Remove("ISKRA_LOCAL_ONLY");
        if (!string.IsNullOrWhiteSpace(Settings.Bootstrap)) info.Environment["ISKRA_P2P_BOOTSTRAP"] = Settings.Bootstrap;
        if (Settings.DhtPort is > 0 and < 65536) info.Environment["ISKRA_P2P_PORT"] = Settings.DhtPort.ToString();
        info.Environment.Remove("NODE_OPTIONS");

        Set(new("starting", null, null, 0));
        using var process = Process.Start(info) ?? throw new InvalidOperationException($"Could not start {BinaryName}.");
        ChildProcesses.Bind(process); // dies with us, even if we're killed (Windows); elsewhere its stdin closes
        lock (_gate) _process = process;
        Starts++;
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) OnLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) _log.LogInformation("p2p: {Line}", e.Data.Length > 500 ? e.Data[..500] : e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _log.LogInformation("Peer-to-peer tunnel started ({Name})", Path.GetFileName(binary));
        try
        {
            await process.WaitForExitAsync(stopping);
        }
        finally
        {
            lock (_gate) _process = null;
            Stop(process);
        }
    }

    /// <summary>One status line from the program. Only the fields we know, with sane sizes.</summary>
    internal void OnLine(string line)
    {
        if (line.Length > 4096) return;
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("status", out var s) || s.ValueKind != JsonValueKind.Object) return;
            var state = s.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString()! : "";
            if (!ReportedStates.Contains(state)) return;
            Nat? nat = null;
            if (s.TryGetProperty("nat", out var n) && n.ValueKind == JsonValueKind.Object)
            {
                var address = n.TryGetProperty("publicAddress", out var a) && a.ValueKind == JsonValueKind.String ? a.GetString() : null;
                nat = new(Flag(n, "firewalled"), Flag(n, "randomized"), address is { Length: <= 64 } ? address : null);
            }
            var connections = s.TryGetProperty("connections", out var c) && c.TryGetInt32(out var count) ? Math.Clamp(count, 0, 100_000) : 0;
            var error = s.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            if (error is { Length: > 200 }) error = error[..200];
            Set(new(state, error, nat, connections));
        }
        catch (JsonException) { }

        static bool Flag(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
    }

    private void StopProcess()
    {
        Process? process;
        lock (_gate) process = _process;
        if (process is not null) Stop(process);
    }

    /// <summary>Closing its stdin stops it cleanly (it leaves the DHT); killed if it hasn't gone after a few seconds.</summary>
    private static void Stop(Process process)
    {
        try
        {
            if (process.HasExited) return;
            try
            {
                process.StandardInput.Close();
            }
            catch (IOException) { }
            if (!process.WaitForExit(GracefulStop)) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
    }

    public override void Dispose()
    {
        StopProcess();
        _wake.Dispose();
        base.Dispose();
    }
}
