using Iskra.Server.Storage;

namespace Iskra.Server.Logging;

/// <summary>
/// The log's own upkeep: the startup summary (what this server runs with, no secrets), the retention stairs at start
/// and daily (<see cref="LogRetention"/>), and once a minute a summary of rate-limit refusals and webhook traffic by kind.
/// </summary>
public sealed class LogMaintenance(World world, ILogger<LogMaintenance> log, TimeProvider time, IHostApplicationLifetime lifetime) : BackgroundService
{
    /// <summary>The desktop app and autostart used to append the server's output to server.log forever: capped here.</summary>
    internal const long LegacyLogCap = 5L * 1024 * 1024;

    public static string Dir(World world) => Path.Combine(world.Path, "logs");

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        var startedAt = time.GetUtcNow();
        lifetime.ApplicationStarted.Register(Summary);
        lifetime.ApplicationStopping.Register(() =>
        {
            Summarize();
            log.Info("life", "stop", ("dur", time.GetUtcNow() - startedAt));
        });
        return base.StartAsync(cancellationToken);
    }

    private void Summary()
    {
        var s = world.Settings;
        var logs = s.Logs.Bounded();
        log.Info("life", "start", ("ver", Updates.Versions.Current), ("srv", LogIds.Server(world.ServerPublicKey)),
            ("world", Path.GetFileName(world.Path)), ("os", System.Runtime.InteropServices.RuntimeInformation.OSDescription));
        log.Info("life", "config", ("port", s.Port), ("local", s.LocalOnly), ("https", s.Https.Mode),
            ("voice", s.Voice.Enabled), ("rtc", s.Voice.Enabled ? $"{s.Voice.Port}/{s.Voice.RtcTcpPort}/{s.Voice.RtcUdpPort}" : null),
            ("p2p", s.P2p.Enabled), ("plain", logs.PlainDays), ("keep", logs.KeepDays), ("maxmb", logs.MaxMb), ("debug", logs.Debug));
    }

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        CapLegacyLog();
        var nextSweep = DateTimeOffset.MinValue;
        while (!stopping.IsCancellationRequested)
        {
            var now = time.GetUtcNow();
            if (now >= nextSweep)
            {
                nextSweep = now.AddDays(1);
                Sweep(now);
            }
            Summarize();
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(1), time, stopping);
            }
            catch (OperationCanceledException) { break; }
        }
    }

    internal void Summarize()
    {
        Summarize(LogCounts.Rate(world), "srv", "rate");
        Summarize(LogCounts.Hooks(world), "hook", "http");
    }

    private void Summarize(LogCounts counts, string src, string area)
    {
        if (counts.Drain() is { Count: > 0 } hits)
            log.Write(LogLevel.Information, src, null, area, "summary", null,
                ("count", hits.Sum(h => h.Count)), ("kinds", string.Join(',', hits.Take(8).Select(h => $"{h.Kind}:{h.Count}"))));
    }

    internal void Sweep(DateTimeOffset now)
    {
        try
        {
            var result = LogRetention.Run(Dir(world), now, world.Settings.Logs);
            if (result.Compressed + result.Deleted + result.Skipped > 0)
                log.Info("sweep", "done", ("what", "logs"), ("gz", result.Compressed), ("deleted", result.Deleted), ("n", result.Skipped), ("bytes", result.Bytes));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.Warn(ex, "LOG-110", "sweep", "failed", ("what", "logs"));
        }
    }

    /// <summary>An old server.log (raw output the desktop app or autostart appended) over 5 MB is emptied.</summary>
    private void CapLegacyLog()
    {
        var legacy = Path.Combine(world.Path, "server.log");
        try
        {
            if (File.Exists(legacy) && new FileInfo(legacy).Length > LegacyLogCap)
            {
                using (new FileStream(legacy, FileMode.Truncate, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) { }
                log.Info("sweep", "done", ("what", "server.log"), ("deleted", 1));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.Warn(ex, "LOG-110", "sweep", "failed", ("what", "server.log"));
        }
    }
}
