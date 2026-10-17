global using Iskra.Server.Logging;

namespace Iskra.Server.Logging;

/// <summary>
/// One-line structured logging: <c>log.Info("sess", "opened", ("conn", id))</c>,
/// <c>log.Warn("PSH-110", "push", "failed", ("status", 410))</c>. Codes are listed in protocol/log-codes.json.
/// Values are ids, counts, durations and fixed words; never names, text, keys, addresses or paths (see LogLine).
/// </summary>
public static class IskraLog
{
    public static void Debug(this ILogger log, string area, string evt, params (string, object?)[] fields) =>
        Write(log, LogLevel.Debug, "srv", null, area, evt, null, fields);

    public static void Info(this ILogger log, string area, string evt, params (string, object?)[] fields) =>
        Write(log, LogLevel.Information, "srv", null, area, evt, null, fields);

    /// <summary>Info with a code: an end nobody asked for (a dropped session, a refused join).</summary>
    public static void Note(this ILogger log, string code, string area, string evt, params (string, object?)[] fields) =>
        Write(log, LogLevel.Information, "srv", code, area, evt, null, fields);

    public static void Warn(this ILogger log, string code, string area, string evt, params (string, object?)[] fields) =>
        Write(log, LogLevel.Warning, "srv", code, area, evt, null, fields);

    public static void Warn(this ILogger log, Exception? ex, string code, string area, string evt, params (string, object?)[] fields) =>
        Write(log, LogLevel.Warning, "srv", code, area, evt, ex, fields);

    public static void Error(this ILogger log, Exception? ex, string code, string area, string evt, params (string, object?)[] fields) =>
        Write(log, LogLevel.Error, "srv", code, area, evt, ex, fields);

    /// <summary>Any level and source (<c>lk</c>, <c>p2p</c>, <c>hook</c>, <c>bug</c>, <c>bot:&lt;id&gt;</c>).</summary>
    public static void Write(this ILogger log, LogLevel level, string src, string? code, string area, string evt, Exception? ex,
        params (string, object?)[] fields)
    {
        if (!log.IsEnabled(level)) return;
        log.Log(level, default, new LogEntry(src, area, evt, code, fields), ex, static (entry, _) => entry.ToString());
    }
}
