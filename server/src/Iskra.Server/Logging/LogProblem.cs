namespace Iskra.Server.Logging;

/// <summary>
/// The server couldn't open its world folder (before logging is set up): one coded line in the day's log file too,
/// so whoever reads logs/ later sees why it didn't start. The full sentence (with paths) goes to the console only.
/// </summary>
public static class LogProblem
{
    public static void Write(string worldPath, Exception ex)
    {
        try
        {
            var why = ex switch
            {
                System.Text.Json.JsonException => "settings-json",
                Microsoft.Data.Sqlite.SqliteException => "database",
                UnauthorizedAccessException => "no-access",
                IOException => "files",
                _ => "invalid",
            };
            var dir = Path.Combine(Path.GetFullPath(worldPath), "logs");
            if (!Directory.Exists(Path.GetFullPath(worldPath))) return;
            var now = DateTimeOffset.UtcNow;
            new LogSink(dir, console: false).Write(now, LogLevel.Error,
                LogLine.Format(now, LogLevel.Error, new LogEntry("srv", "store", "failed", "STO-110", [("why", why)]), ex));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { }
    }
}
