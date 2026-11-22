using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Iskra.Server.Voice;

/// <summary>
/// LiveKit's own output, relayed as <c>lk</c> lines. Its lines (<c>time  LEVEL  logger  file.go:N  message  {json}</c>)
/// can carry participant identities, ICE candidates and addresses, so only the level, the message (scrubbed, LiveKit's
/// fixed wording), the voice channel id and the error's wording (scrubbed the same way) pass; the other JSON fields
/// are dropped. The same message with the same error at most once a minute.
/// Anything that isn't a log line (a panic, a banner) goes to debug only.
/// </summary>
public static partial class LiveKitLines
{
    private static readonly ConcurrentDictionary<string, (long At, int Skipped)> Recent = new();
    private static readonly TimeSpan Quiet = TimeSpan.FromMinutes(1);

    public sealed record Parsed(LogLevel Level, string Message, long? Channel, string? Error = null);

    public static void Relay(ILogger log, string line, TimeProvider? time = null)
    {
        if (Parse(line) is not { } parsed)
        {
            log.Write(LogLevel.Debug, "lk", null, "voice", "output", null, ("msg", line.Length > 300 ? line[..300] : line));
            return;
        }
        if (parsed.Level < LogLevel.Warning)
        {
            log.Write(LogLevel.Debug, "lk", null, "voice", "output", null, ("msg", parsed.Message), ("chan", parsed.Channel));
            return;
        }
        var now = (time ?? TimeProvider.System).GetTimestamp();
        var skipped = 0;
        var emit = true;
        Recent.AddOrUpdate(parsed.Error is null ? parsed.Message : $"{parsed.Message}|{parsed.Error}", _ => (now, 0), (_, seen) =>
        {
            if ((time ?? TimeProvider.System).GetElapsedTime(seen.At, now) < Quiet)
            {
                emit = false;
                return (seen.At, seen.Skipped + 1);
            }
            skipped = seen.Skipped;
            return (now, 0);
        });
        if (Recent.Count > 500) Recent.Clear();
        if (!emit) return;
        var error = parsed.Level >= LogLevel.Error;
        log.Write(parsed.Level, "lk", error ? "LK-160" : "LK-120", "voice", error ? "error" : "warn", null,
            ("msg", parsed.Message), ("why", parsed.Error), ("chan", parsed.Channel), ("n", skipped > 0 ? skipped : null));
    }

    /// <summary>LiveKit's level and message, or null when the line isn't one of its log lines.</summary>
    public static Parsed? Parse(string line)
    {
        var parts = line.Split('\t');
        var levelAt = Array.FindIndex(parts, p => LevelOf(p.Trim()) is not null);
        if (levelAt < 0 || parts.Length < levelAt + 2) return null;
        var level = LevelOf(parts[levelAt].Trim())!.Value;
        string? message = null;
        long? channel = null;
        string? error = null;
        foreach (var raw in parts.Skip(levelAt + 1))
        {
            var part = raw.Trim();
            if (part.StartsWith('{'))
            {
                channel ??= ChannelIn(part);
                error ??= ErrorIn(part);
                continue;
            }
            // the logger's name (livekit, livekit.transport.pion.ice) and the caller (file.go:123) come before the message
            if (message is null && part.Length > 0 && !LoggerName().IsMatch(part) && !Caller().IsMatch(part)) message = part;
        }
        if (message is null) return null;
        message = Words(LogLine.Scrub(message));
        if (message.Length > 100) message = message[..100];
        return new(level, message, channel, error);
    }

    /// <summary>
    /// Why it failed: the "error" field's wording ("room is closed", "context deadline exceeded"), with anything that
    /// isn't a plain lowercase word (an identity, an id, an address) as "…".
    /// </summary>
    private static string? ErrorIn(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("error", out var error) || error.ValueKind != JsonValueKind.String) return null;
            var text = error.GetString()!;
            if (text.Length > 300) text = text[..300];
            text = string.Join(' ', LogLine.Scrub(text).Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(w => w.Length <= 24 && ErrorWord().IsMatch(w) ? w : "…"));
            return text.Length == 0 ? null : text.Length > 100 ? text[..100] : text;
        }
        catch (JsonException) { }
        return null;
    }

    private static LogLevel? LevelOf(string token) => token.ToUpperInvariant() switch
    {
        "DEBUG" => LogLevel.Debug,
        "INFO" => LogLevel.Information,
        "WARN" or "WARNING" => LogLevel.Warning,
        "ERROR" or "DPANIC" or "PANIC" or "FATAL" => LogLevel.Error,
        _ => null,
    };

    /// <summary>The voice channel id from the line's fields ("room": "voice-12"); nothing else is read from them.</summary>
    private static long? ChannelIn(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            foreach (var key in new[] { "room", "roomName" })
                if (doc.RootElement.TryGetProperty(key, out var room) && room.ValueKind == JsonValueKind.String && VoiceRegistry.ChannelOf(room.GetString()) is { } id)
                    return id;
        }
        catch (JsonException) { }
        return null;
    }

    /// <summary>
    /// LiveKit's messages are fixed lowercase wording; anything else in them (a name, an id) becomes "…". Short
    /// all-caps acronyms (ICE, SDP, TURN) and the scrubber's placeholders stay.
    /// </summary>
    private static string Words(string message) => string.Join(' ', message.Split(' ', StringSplitOptions.RemoveEmptyEntries)
        .Select(w => FixedWord().IsMatch(w) ? w : "…"));

    [GeneratedRegex(@"^([a-z0-9.,:;()'/_=-]+|[A-Z]{2,5}s?[,:.]?|<ip>|<token>|<path>|<email>)$")]
    private static partial Regex FixedWord();

    /// <summary>A lowercase word of an error text (letters only, so no id, room or key), or the scrubber's placeholder.</summary>
    [GeneratedRegex(@"^([a-z]+[a-z'-]*[,:;.]?|[A-Z]{2,5}s?[,:.]?|\d{1,5}|<ip>|<token>|<path>|<email>)$")]
    private static partial Regex ErrorWord();

    [GeneratedRegex(@"^livekit(\.[a-z0-9_-]+)*$")]
    private static partial Regex LoggerName();

    /// <summary>service/signal.go:123, or a module's: v4@v4.4.0/agent_stats.go:106.</summary>
    [GeneratedRegex(@"^[\w.@/-]+\.go:\d+$")]
    private static partial Regex Caller();
}
