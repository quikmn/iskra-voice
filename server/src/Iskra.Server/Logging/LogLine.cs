using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Iskra.Server.Logging;

/// <summary>
/// One structured log entry: who wrote it (<see cref="Src"/>), the area, a kebab event, a code (required on warnings
/// and errors, see protocol/log-codes.json) and key=value fields from a fixed vocabulary. Rendered by <see cref="LogLine"/>.
/// </summary>
public sealed record LogEntry(string Src, string Area, string Event, string? Code, (string Key, object? Value)[] Fields)
{
    public override string ToString() => LogLine.Body(this, null);
}

/// <summary>
/// The one log line format (docs/development.md "Logs"):
/// <c>UTC-time  LEVEL  SRC  AREA  event  CODE  key=value…</c>, one line per entry, never a newline inside a field.
/// What may appear is fixed here: unknown areas become <c>misc</c>, unknown field keys are dropped, every text value is
/// scrubbed of addresses, paths, emails and long tokens, and exceptions show only their type and method.
/// </summary>
public static partial class LogLine
{
    /// <summary>Sources: <c>srv</c> the server, <c>lk</c> LiveKit, <c>p2p</c> the tunnel sidecar, <c>hook</c> webhooks,
    /// <c>bug</c> the bug inbox, <c>bot:&lt;id&gt;</c> a built-in bot (ids from the fixed built-in list).</summary>
    public static readonly HashSet<string> Sources = ["srv", "lk", "p2p", "hook", "bug"];

    public static readonly HashSet<string> BotIds = ["dice", "polls", "reminders", "starboard", "birthdays", "welcome"];

    public static readonly HashSet<string> Areas =
    [
        "life", "conn", "sess", "voice", "call", "media", "e2ee", "tunnel", "nat", "tls", "update", "push", "backup",
        "sweep", "rate", "store", "ui", "http", "sched", "misc",
    ];

    /// <summary>Field keys that may appear; anything else is dropped.</summary>
    public static readonly HashSet<string> Fields =
    [
        // the shared vocabulary (client and server)
        "srv", "conn", "acct", "chan", "room", "call", "path", "via", "nat", "ice", "proto", "codec", "loss", "rtt",
        "jitter", "took", "dur", "retry", "n", "close", "why", "reason", "op", "name", "msg", "ver", "os", "engine",
        "kind", "count", "status", "port",
        // server only
        "world", "local", "https", "voice", "rtc", "turn", "p2p", "plain", "keep", "maxmb", "debug", "gz", "deleted",
        "bytes", "from", "to", "id", "exit", "delay", "kinds", "frame", "inner", "cgnat", "ext", "what", "state",
        "files", "msgs", "envelopes", "dir", "level", "ok", "failed", "queued", "mode", "expires", "how",
        // the tunnel's own lines (p2p): its route and counters
        "peer", "in", "out",
    ];

    private const int CodeWidth = 7;

    /// <summary>The whole line for <paramref name="entry"/> at <paramref name="time"/>.</summary>
    public static string Format(DateTimeOffset time, LogLevel level, LogEntry entry, Exception? exception = null)
    {
        var src = Source(entry.Src);
        var code = entry.Code ?? (level >= LogLevel.Warning ? "SRV-900" : null);
        var head = new StringBuilder(128);
        head.Append(Time(time)).Append(' ')
            .Append(Level(level).PadRight(5)).Append(' ')
            .Append(src.PadRight(5)).Append(' ')
            .Append(Area(entry.Area).PadRight(6)).Append(' ')
            .Append(Event(entry.Event).PadRight(11)).Append(' ')
            .Append((code is { } c && CodePattern().IsMatch(c) ? c : "-").PadRight(CodeWidth));
        var body = Body(entry, exception);
        if (body.Length > 0) head.Append(' ').Append(body);
        return head.ToString().TrimEnd();
    }

    /// <summary>A line for a message that didn't come through the structured helpers (ASP.NET, a library).</summary>
    public static string FormatText(DateTimeOffset time, LogLevel level, string category, string message, Exception? exception = null) =>
        Format(time, level, new LogEntry("srv", AreaOf(category), "note", null, [("msg", message)]), exception);

    /// <summary>The key=value part: allowed keys only, in the order given, then the exception's type and method.</summary>
    public static string Body(LogEntry entry, Exception? exception)
    {
        var sb = new StringBuilder();
        foreach (var (key, value) in entry.Fields)
        {
            if (!Fields.Contains(key) || Value(value) is not { } text) continue;
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(key).Append('=').Append(text);
        }
        if (exception is not null)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append("name=").Append(Value(exception.GetType().Name));
            if (Frame(exception) is { } frame) sb.Append(" frame=").Append(Value(frame));
            if (exception.InnerException is { } inner) sb.Append(" inner=").Append(Value(inner.GetType().Name));
        }
        return sb.ToString();
    }

    public static string Time(DateTimeOffset time) => time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static string Level(LogLevel level) => level switch
    {
        LogLevel.Trace or LogLevel.Debug => "DEBUG",
        LogLevel.Information => "INFO",
        LogLevel.Warning => "WARN",
        _ => "ERROR",
    };

    private static string Source(string src) =>
        Sources.Contains(src) ? src : src.StartsWith("bot:", StringComparison.Ordinal) && BotIds.Contains(src[4..]) ? src : "srv";

    private static string Area(string area) => Areas.Contains(area) ? area : "misc";

    private static string Event(string evt) => EventPattern().IsMatch(evt) ? evt : "note";

    /// <summary>The area for an unstructured message from <paramref name="category"/> (a logger name).</summary>
    public static string AreaOf(string category) => category switch
    {
        _ when category.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal) || category.StartsWith("Yarp", StringComparison.Ordinal) => "http",
        _ when category.StartsWith("Microsoft.Hosting", StringComparison.Ordinal) || category.StartsWith("Microsoft.Extensions.Hosting", StringComparison.Ordinal) => "life",
        _ when category.Contains(".Voice.", StringComparison.Ordinal) => "voice",
        _ when category.Contains(".Backups.", StringComparison.Ordinal) => "backup",
        _ => "misc",
    };

    /// <summary>A field value as text: plain when it's simple, else quoted (scrubbed, one line, at most 120 chars). Null skips the field.</summary>
    public static string? Value(object? value)
    {
        switch (value)
        {
            case null:
                return null;
            case bool b:
                return b ? "yes" : "no";
            case TimeSpan t:
                return t.TotalMilliseconds < 1000 ? $"{(long)t.TotalMilliseconds}ms" : (t.TotalSeconds < 100 ? t.TotalSeconds.ToString("0.0", CultureInfo.InvariantCulture) : ((long)t.TotalSeconds).ToString(CultureInfo.InvariantCulture)) + "s";
            case double d:
                return d.ToString("0.##", CultureInfo.InvariantCulture);
            case float f:
                return f.ToString("0.##", CultureInfo.InvariantCulture);
            case IFormattable formattable and not Enum:
                return formattable.ToString(null, CultureInfo.InvariantCulture);
        }
        var text = Scrub(value.ToString() ?? "");
        if (text.Length == 0) return null;
        if (PlainValue().IsMatch(text)) return text;
        var sb = new StringBuilder(text.Length + 2).Append('"');
        foreach (var ch in text.Length > 120 ? text[..119] + "…" : text)
            sb.Append(ch switch { '"' => '\'', _ when char.IsControl(ch) => ' ', _ => ch });
        return sb.Append('"').ToString();
    }

    /// <summary>
    /// Takes out what a log line must never carry, whatever a library put in its message: IP addresses, emails, URLs
    /// past their host, file paths, and long base64/hex runs (keys, tokens, secrets, invite codes).
    /// </summary>
    public static string Scrub(string text)
    {
        if (text.Length > 2000) text = text[..2000];
        text = Url().Replace(text, m => m.Groups["scheme"].Value + "://" + (IPv4().IsMatch(m.Groups["host"].Value) || m.Groups["host"].Value.Contains(':') ? "<ip>" : m.Groups["host"].Value) + "/…");
        text = Email().Replace(text, "<email>");
        text = WindowsPath().Replace(text, "<path>");
        text = UnixPath().Replace(text, "<path>");
        text = IPv4().Replace(text, "<ip>");
        text = IPv6().Replace(text, "<ip>");
        text = LongToken().Replace(text, m => m.Length >= 32 || m.Value.Any(char.IsAsciiDigit) ? "<token>" : m.Value);
        return text.Replace('\r', ' ').Replace('\n', ' ').Trim();
    }

    /// <summary>The method an exception came from (Type.Method), preferring Iskra's own frames; never a file path.</summary>
    private static string? Frame(Exception exception)
    {
        var methods = new System.Diagnostics.StackTrace(exception, false).GetFrames().Select(f => f.GetMethod()).Where(m => m?.DeclaringType is not null).ToList();
        var method = methods.FirstOrDefault(m => m!.DeclaringType!.FullName?.StartsWith("Iskra", StringComparison.Ordinal) == true) ?? methods.FirstOrDefault();
        if (method?.DeclaringType is not { } type) return null;
        var name = method.Name;
        // Compiler-made names: async state machines (<Name>d__12.MoveNext), lambdas (<>c.<Name>b__0), local functions (<Outer>g__Name|3_0).
        while (type.Name.StartsWith('<') && type.DeclaringType is { } outer)
        {
            if (Generated().Match(type.Name) is { Success: true } m && m.Groups[1].Value.Length > 0) name = m.Groups[1].Value;
            type = outer;
        }
        if (name.Contains("g__", StringComparison.Ordinal)) name = name[(name.IndexOf("g__", StringComparison.Ordinal) + 3)..].Split('|')[0];
        else if (Generated().Match(name) is { Success: true } inner && inner.Groups[1].Value.Length > 0) name = inner.Groups[1].Value;
        return $"{type.Name.Split('`')[0]}.{name}";
    }

    [GeneratedRegex(@"^<([^>]*)>")]
    private static partial Regex Generated();

    [GeneratedRegex("^[A-Z][A-Z0-9]{1,2}-[0-9]{3}$")]
    public static partial Regex CodePattern();

    [GeneratedRegex("^[a-z][a-z0-9-]{0,23}$")]
    private static partial Regex EventPattern();

    [GeneratedRegex(@"^[A-Za-z0-9._:/,+@=%<>-]{1,80}$")]
    private static partial Regex PlainValue();

    [GeneratedRegex(@"(?<scheme>[A-Za-z][A-Za-z0-9+.-]{1,9})://(?<host>\[[^\]]*\]|[^/\s:?#""']+)(:\d+)?[^\s""']*")]
    private static partial Regex Url();

    [GeneratedRegex(@"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")]
    private static partial Regex Email();

    [GeneratedRegex(@"(?<![A-Za-z])[A-Za-z]:[\\/][^\s""']*|\\\\[^\s""']+")]
    private static partial Regex WindowsPath();

    [GeneratedRegex(@"(?<![\w.:/<])/(?:home|Users|var|tmp|root|etc|opt|srv|mnt|private|usr|run|data|Volumes|Library)(?:/[^\s""']*)?")]
    private static partial Regex UnixPath();

    [GeneratedRegex(@"(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?![\d.])")]
    private static partial Regex IPv4();

    [GeneratedRegex(@"(?<![\w:])\[?(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\]?(?:%\w+)?(?::\d+)?(?![\w:])")]
    private static partial Regex IPv6();

    [GeneratedRegex(@"[A-Za-z0-9_+/=-]{20,}")]
    private static partial Regex LongToken();
}
