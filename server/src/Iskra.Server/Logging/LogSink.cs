using System.Text;

namespace Iskra.Server.Logging;

/// <summary>
/// Where log lines go: the console (stdout) and, with a folder, one file per UTC day (<c>YYYY-MM-DD.log</c>) that the
/// server owns and trims itself (<see cref="LogRetention"/>). Debug lines reach the file only with the debug switch.
/// Logging never throws: a line that can't be written is dropped.
/// </summary>
public sealed class LogSink(string? dir, bool console = true, bool debugToFile = false)
{
    private readonly Lock _gate = new();
    private bool _dirReady;

    public string? Dir => dir;

    /// <summary>Every line written (tests).</summary>
    public event Action<string>? Tap;

    public void Write(DateTimeOffset now, LogLevel level, string line)
    {
        Tap?.Invoke(line);
        lock (_gate)
        {
            if (console)
            {
                try { Console.Out.WriteLine(line); } catch (IOException) { } catch (ObjectDisposedException) { }
            }
            if (dir is null || (level < LogLevel.Information && !debugToFile)) return;
            try
            {
                if (!_dirReady)
                {
                    // Not into a world folder that's gone (deleted, moved): never recreate it just to log.
                    if (Path.GetDirectoryName(dir) is { } parent && !Directory.Exists(parent)) return;
                    Storage.AtomicFile.CreatePrivateDirectory(dir);
                    _dirReady = true;
                }
                // Opened per line: nothing held open, so the day's file can be read, moved or deleted any time.
                using var file = new FileStream(Path.Combine(dir, FileName(now)), FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                file.Write(bytes);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _dirReady = false;
            }
        }
    }

    /// <summary>The day's file name: <c>2026-10-17.log</c> (UTC).</summary>
    public static string FileName(DateTimeOffset now) => now.UtcDateTime.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) + ".log";
}

/// <summary>Renders every ILogger entry as one <see cref="LogLine"/> into a <see cref="LogSink"/>.</summary>
public sealed class IskraLoggerProvider(LogSink sink, TimeProvider? time = null) : ILoggerProvider
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public LogSink Sink => sink;

    public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);

    public void Dispose() { }

    private sealed class Logger(IskraLoggerProvider provider, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            var now = provider._time.GetUtcNow();
            string line;
            try
            {
                line = state is LogEntry entry
                    ? LogLine.Format(now, logLevel, entry, exception)
                    : LogLine.FormatText(now, logLevel, category, formatter(state, exception), exception);
            }
            catch (Exception e) when (e is FormatException or ArgumentException or InvalidOperationException)
            {
                line = LogLine.FormatText(now, logLevel, category, "unformattable entry", exception);
            }
            provider.Sink.Write(now, logLevel, line);
        }
    }
}

public static class IskraLoggingBuilder
{
    /// <summary>Replaces the default console logger with Iskra's one-line format, writing <paramref name="dir"/>'s daily files too.</summary>
    public static ILoggingBuilder AddIskraLog(this ILoggingBuilder logging, string? dir, bool debugToFile = false, Action<string>? tap = null)
    {
        var sink = new LogSink(dir, console: true, debugToFile);
        if (tap is not null) sink.Tap += tap;
        logging.ClearProviders();
        logging.AddProvider(new IskraLoggerProvider(sink));
        // ASP.NET's own chatter (every request, "Now listening on") only from warnings up, also when appsettings.json
        // isn't next to the working folder (the desktop app runs the server in its world folder).
        logging.AddFilter("Microsoft", LogLevel.Warning);
        logging.AddFilter("Yarp", LogLevel.Warning);
        return logging;
    }
}
