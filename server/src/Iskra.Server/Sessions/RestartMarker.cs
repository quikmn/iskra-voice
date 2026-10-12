using System.Text.Json;
using System.Text.Json.Serialization;

namespace Iskra.Server.Sessions;

/// <summary>
/// "This stop is a restart": a small file, <c>&lt;world&gt;/restart-expected</c>, written by an update script just before
/// it restarts the service (<c>iskra-server expect-restart</c>). A SIGTERM can't say why it came, so when the server
/// stops it looks for a recent marker and, if there is one, tells members it's restarting (1012) instead of going
/// offline (1001). Only a reason (update or restart) and a number are read from it, never text that ends up anywhere.
/// </summary>
public static class RestartMarker
{
    public const string FileName = "restart-expected";

    /// <summary>A marker older than this is from a restart that didn't happen and is ignored.</summary>
    public static readonly TimeSpan FreshFor = TimeSpan.FromMinutes(2);

    /// <summary>The longest downtime hint a marker can give (the same cap as the close reason's etaMs).</summary>
    public const int MaxEtaSeconds = 600;

    private const int MaxBytes = 1024;
    private static readonly string[] Reasons = ["restart", "update"];

    public static bool IsReason(string? reason) => reason is not null && Reasons.Contains(reason);

    /// <summary>
    /// Writes the marker atomically. It holds nothing secret and the world folder is its owner's only (0700), so it is
    /// readable by the server even when root writes it (0644), as an update script running as root does.
    /// </summary>
    public static void Write(string worldPath, string reason, int? etaSeconds, DateTimeOffset now)
    {
        if (!IsReason(reason)) throw new ArgumentException("The reason is update or restart.", nameof(reason));
        if (etaSeconds is < 0 or > MaxEtaSeconds) throw new ArgumentOutOfRangeException(nameof(etaSeconds), $"The ETA is 0 to {MaxEtaSeconds} seconds.");
        var path = Path.Combine(worldPath, FileName);
        var json = JsonSerializer.Serialize(new Body(1, reason, etaSeconds, now.ToUnixTimeMilliseconds()));
        var temp = path + ".tmp";
        File.Delete(temp);
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;
        using (var stream = new FileStream(temp, options))
            stream.Write(System.Text.Encoding.UTF8.GetBytes(json + "\n"));
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>
    /// Reads and deletes the marker. Returns the restart it announces when it's well-formed and recent; otherwise
    /// null (and it's gone all the same).
    /// </summary>
    public static (string Reason, TimeSpan? Eta)? Consume(string worldPath, DateTimeOffset now)
    {
        var path = Path.Combine(worldPath, FileName);
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists) return null;
            try
            {
                return info.Length <= MaxBytes ? Parse(File.ReadAllBytes(path), now) : null;
            }
            finally
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>At startup any marker is left over (it was meant for the server that stopped): delete it.</summary>
    public static void Discard(string worldPath)
    {
        try
        {
            File.Delete(Path.Combine(worldPath, FileName));
            File.Delete(Path.Combine(worldPath, FileName + ".tmp"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    internal static (string Reason, TimeSpan? Eta)? Parse(ReadOnlySpan<byte> json, DateTimeOffset now)
    {
        try
        {
            using var doc = JsonDocument.Parse(json.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var version) || version != 1) return null;
            if (!root.TryGetProperty("reason", out var r) || r.ValueKind != JsonValueKind.String || r.GetString() is not { } reason || !IsReason(reason)) return null;
            if (!root.TryGetProperty("at", out var a) || a.ValueKind != JsonValueKind.Number || !a.TryGetInt64(out var at)) return null;
            var age = now.ToUnixTimeMilliseconds() - at;
            // A little slack for a clock that's slightly ahead of this one.
            if (age > FreshFor.TotalMilliseconds || age < -5_000) return null;
            TimeSpan? eta = null;
            if (root.TryGetProperty("etaSeconds", out var e) && e.ValueKind != JsonValueKind.Null)
            {
                if (e.ValueKind != JsonValueKind.Number || !e.TryGetInt32(out var seconds) || seconds is < 0 or > MaxEtaSeconds) return null;
                eta = TimeSpan.FromSeconds(seconds);
            }
            // The reason is one of ours, not the file's string.
            return (Reasons.First(x => x == reason), eta);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private sealed record Body(
        [property: JsonPropertyName("v")] int V,
        [property: JsonPropertyName("reason")] string Reason,
        [property: JsonPropertyName("etaSeconds"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? EtaSeconds,
        [property: JsonPropertyName("at")] long At);
}
