using System.Globalization;
using System.IO.Compression;

namespace Iskra.Server.Logging;

/// <summary>server.json "Logs": how long the server's own log files stay (docs/hosting.md).</summary>
public sealed record LogsSettings
{
    /// <summary>Days a file stays plain text (1-365).</summary>
    public int PlainDays { get; init; } = 60;
    /// <summary>Days a file is kept at all, gzipped after <see cref="PlainDays"/> (1-365).</summary>
    public int KeepDays { get; init; } = 180;
    /// <summary>All log files together (10-2000 MB): over it, the oldest go first, whatever their age.</summary>
    public int MaxMb { get; init; } = 200;
    /// <summary>Also write debug lines to the files (a developer switch; the console follows Logging:LogLevel).</summary>
    public bool Debug { get; init; }

    /// <summary>The same, with every value inside its bounds.</summary>
    public LogsSettings Bounded() => this with
    {
        PlainDays = Math.Clamp(PlainDays, 1, 365),
        KeepDays = Math.Clamp(KeepDays, 1, 365),
        MaxMb = Math.Clamp(MaxMb, 10, 2000),
    };
}

/// <summary>
/// The retention "stairs" for logs/: one file per UTC day, plain for <see cref="LogsSettings.PlainDays"/>, then gzipped
/// until <see cref="LogsSettings.KeepDays"/>, then deleted; and never more than <see cref="LogsSettings.MaxMb"/> in all
/// (oldest first, gzipped before plain). Crash-safe: a file is compressed to a temp name, flushed, renamed, and only then
/// is the plain file deleted; a temp left by a crash is removed on the next run. A file that can't be read is skipped.
/// Today's file is never touched.
/// </summary>
public static class LogRetention
{
    public sealed record Result(int Compressed, int Deleted, int Skipped, long Bytes);

    private const string Plain = ".log";
    private const string Zipped = ".log.gz";
    private const string Temp = ".tmp";

    public static Result Run(string dir, DateTimeOffset now, LogsSettings settings)
    {
        if (!Directory.Exists(dir)) return new(0, 0, 0, 0);
        settings = settings.Bounded();
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        int compressed = 0, deleted = 0, skipped = 0;

        foreach (var temp in Directory.EnumerateFiles(dir, "*" + Temp))
            if (TryDelete(temp)) deleted++;

        foreach (var (path, day, zipped) in Files(dir).ToList())
        {
            var age = today.DayNumber - day.DayNumber;
            if (age <= 0) continue;
            if (age > settings.KeepDays)
            {
                if (TryDelete(path)) deleted++;
                else skipped++;
                continue;
            }
            if (!zipped && age > settings.PlainDays)
            {
                if (Compress(path)) compressed++;
                else skipped++;
            }
        }

        var cap = settings.MaxMb * 1024L * 1024L;
        var files = Files(dir).Where(f => f.Day < today).Select(f => (f.Path, f.Day, f.Zipped, Size: Size(f.Path))).ToList();
        var total = files.Sum(f => f.Size) + Files(dir).Where(f => f.Day >= today).Sum(f => Size(f.Path));
        // Oldest first; on the same day the gzipped copy before the plain one.
        foreach (var file in files.OrderBy(f => f.Day).ThenBy(f => f.Zipped ? 0 : 1))
        {
            if (total <= cap) break;
            if (TryDelete(file.Path))
            {
                total -= file.Size;
                deleted++;
            }
        }
        return new(compressed, deleted, skipped, total);
    }

    /// <summary>The day files in <paramref name="dir"/>: <c>YYYY-MM-DD.log</c> and <c>YYYY-MM-DD.log.gz</c>; anything else is left alone.</summary>
    public static IEnumerable<(string Path, DateOnly Day, bool Zipped)> Files(string dir)
    {
        foreach (var path in Directory.EnumerateFiles(dir))
        {
            var name = Path.GetFileName(path);
            var zipped = name.EndsWith(Zipped, StringComparison.Ordinal);
            if (!zipped && !name.EndsWith(Plain, StringComparison.Ordinal)) continue;
            var stem = name[..^(zipped ? Zipped.Length : Plain.Length)];
            if (DateOnly.TryParseExact(stem, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
                yield return (path, day, zipped);
        }
    }

    private static bool Compress(string path)
    {
        var target = path + ".gz";
        var temp = target + Temp;
        try
        {
            if (!File.Exists(target))
            {
                using (var source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var output = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
                        source.CopyTo(gzip);
                    output.Flush(flushToDisk: true);
                }
                File.Move(temp, target);
            }
            // Already compressed (a run that stopped right after the rename): the plain copy just goes.
            File.Delete(path);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            TryDelete(temp);
            return false;
        }
    }

    private static long Size(string path)
    {
        try { return new FileInfo(path).Length; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return 0; }
    }

    private static bool TryDelete(string path)
    {
        try
        {
            if (!File.Exists(path)) return false;
            File.Delete(path);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return false; }
    }
}
