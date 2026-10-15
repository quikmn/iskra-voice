using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The bug inbox: anyone's Iskra app can send a bug report to <c>POST /bug-reports</c> on a server whose owner turned it
/// on (server.json <c>BugInbox.Accept</c>, only the project's own server) and enabled; each report becomes one message in the channel the owner picked (normally a private one). Anonymous, so it's
/// limited hard: sizes, types, a rate per client address (kept in memory only) and a cap per hour for everyone.
/// </summary>
public static class BugInboxFeature
{
    public static void Register(Router router)
    {
        router.Add("buginbox.get", (s, me, _) =>
        {
            RequireOwner(me);
            RequireAccepting(s.World);
            return View(s.World.Store);
        });
        router.Add("buginbox.set", Set);
    }

    private static void RequireOwner(Member me)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can change the bug inbox.", "owner_bug_inbox");
    }

    /// <summary>Only a server whose server.json says <c>BugInbox.Accept</c> has a bug inbox.</summary>
    private static void RequireAccepting(World world)
    {
        if (!world.Settings.BugInbox.Accept) throw RequestException.Forbidden("This server doesn't take bug reports.", "bug_inbox_off");
    }

    public static object View(Store store)
    {
        var settings = store.GetBugInbox();
        return new { enabled = settings.Enabled && settings.ChannelId is not null, channelId = settings.ChannelId };
    }

    private static object Set(Session s, Member me, Body body)
    {
        RequireOwner(me);
        RequireAccepting(s.World);
        var store = s.World.Store;
        var enabled = body.OptionalBool("enabled") ?? throw RequestException.BadRequest("'enabled' is required.");
        var channelId = body.OptionalLong("channelId", min: 1) ?? store.GetBugInbox().ChannelId;
        if (channelId is { } id)
        {
            var channel = store.GetChannel(id) ?? throw RequestException.NotFound("Channel");
            if (channel.Kind != "text") throw RequestException.BadRequest("Bug reports can only go to a text channel.", "bug_inbox_text_only");
            E2eeChannelFeature.RefusePlaintext(store, channel, "The bug inbox");
        }
        else if (enabled) throw RequestException.BadRequest("Pick a channel for bug reports first.", "bug_inbox_channel");
        store.SetBugInbox(enabled, channelId);
        Audit.Record(s, "buginbox.update", details: new { enabled });
        return View(store);
    }
}

/// <summary>The HTTP side: <c>POST /bug-reports</c> (JSON), with CORS for the Iskra apps.</summary>
public sealed partial class BugInbox(World world, Hub hub, Uploads uploads, TimeProvider time, ILogger<BugInbox> log)
{
    public const string WebhookId = "bug-inbox";
    public const string AuthorKey = WebhookFeature.AuthorPrefix + WebhookId;
    public const string BotName = "Bug reports";

    /// <summary>Reports are deleted after this long (RetentionSweeper), whatever the channel's retention.</summary>
    public const int KeepDays = 365;

    public const int MaxImages = 5;
    public const int MaxImageBytes = 1536 * 1024;
    public const int MaxImagesTotalBytes = 10 * 1024 * 1024;
    /// <summary>Five base64 images at their largest plus the text, with room to spare.</summary>
    public const int MaxBodyBytes = 12 * 1024 * 1024;
    public const int MaxWhat = 1500, MaxSteps = 1400, MaxExpected = 600, MaxEmail = 254, MaxLogs = 64 * 1024;

    /// <summary>Per client address and for everyone, per hour. Settable for tests.</summary>
    public int PerAddressPerHour { get; set; } = 5;
    public int GlobalPerHour { get; set; } = 60;

    private readonly ConcurrentDictionary<IPAddress, WebhookIngress.TokenBucket> _addresses = new();
    private WebhookIngress.TokenBucket? _global;
    private int _globalLimit;

    private static readonly string[] Origins = ["https://app.iskra.foo", "app://iskra", "capacitor://localhost", "http://localhost", "https://localhost"];

    public bool Accepting => world.Settings.BugInbox.Accept;

    public static void Map(WebApplication app)
    {
        // Without BugInbox.Accept these answer 404 with an empty body, like a route that doesn't exist (and no CORS headers).
        app.MapPost("/bug-reports", (HttpContext c, BugInbox inbox) => inbox.Accepting ? inbox.PostAsync(c) : Task.FromResult(Results.NotFound()));
        app.MapMethods("/bug-reports", ["OPTIONS"], (HttpContext c, BugInbox inbox) =>
        {
            if (!inbox.Accepting) return Results.NotFound();
            AllowCors(c);
            return Results.NoContent();
        });
    }

    /// <summary>The apps' own origins (web, desktop, phones) and local development; no cookies are involved.</summary>
    public static bool AllowedOrigin(string? origin)
    {
        if (string.IsNullOrEmpty(origin)) return false;
        if (Origins.Contains(origin, StringComparer.Ordinal)) return true;
        return LocalOrigin().IsMatch(origin);
    }

    [GeneratedRegex(@"^http://(localhost|127\.0\.0\.1):\d{1,5}$")]
    private static partial Regex LocalOrigin();

    private static void AllowCors(HttpContext context)
    {
        var origin = context.Request.Headers.Origin.ToString();
        if (!AllowedOrigin(origin)) return;
        var headers = context.Response.Headers;
        headers.AccessControlAllowOrigin = origin;
        headers.Vary = "Origin";
        headers.AccessControlAllowMethods = "POST, OPTIONS";
        headers.AccessControlAllowHeaders = "Content-Type";
        headers.AccessControlMaxAge = "86400";
    }

    /// <summary>The limiter's key: the address itself, or its /64 for IPv6 (one home usually has a whole /64).</summary>
    public static IPAddress LimitKey(IPAddress? address)
    {
        if (address is null) return IPAddress.None;
        if (address.IsIPv4MappedToIPv6) return address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return address;
        var bytes = address.GetAddressBytes();
        Array.Clear(bytes, 8, 8);
        return new IPAddress(bytes);
    }

    private static IResult Error(int status, string error, string message) => Results.Json(new { error, message }, statusCode: status);

    private IResult? Limit(HttpContext context)
    {
        var perSecond = PerAddressPerHour / 3600.0;
        if (_addresses.Count > 10_000) _addresses.Clear();
        var bucket = _addresses.GetOrAdd(LimitKey(context.Connection.RemoteIpAddress), _ => new WebhookIngress.TokenBucket(PerAddressPerHour, perSecond, time));
        if (!bucket.TryTake(out var wait)) return RateLimited(context, wait);
        if (_global is null || _globalLimit != GlobalPerHour)
        {
            _globalLimit = GlobalPerHour;
            _global = new WebhookIngress.TokenBucket(GlobalPerHour, GlobalPerHour / 3600.0, time);
        }
        return _global.TryTake(out wait) ? null : RateLimited(context, wait);
    }

    private static IResult RateLimited(HttpContext context, TimeSpan wait)
    {
        context.Response.Headers.RetryAfter = Math.Ceiling(wait.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Error(StatusCodes.Status429TooManyRequests, "rate_limited", "Too many bug reports right now. Try again later.");
    }

    public async Task<IResult> PostAsync(HttpContext context)
    {
        AllowCors(context);
        var settings = world.Store.GetBugInbox();
        var channel = settings.Enabled && settings.ChannelId is { } id ? world.Store.GetChannel(id) : null;
        if (channel is null) return Error(StatusCodes.Status404NotFound, "off", "This server doesn't take bug reports.");
        if (Limit(context) is { } limited) return limited;

        var type = context.Request.ContentType ?? "";
        if (!type.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
            return Error(StatusCodes.Status415UnsupportedMediaType, "type", "Send the report as JSON.");
        var body = await ReadBodyAsync(context);
        if (body is null) return Error(StatusCodes.Status413PayloadTooLarge, "too_large", "The report is too big.");

        BugReport report;
        try
        {
            using var doc = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 8 });
            report = Parse(doc.RootElement);
        }
        catch (PayloadException ex)
        {
            return Error(StatusCodes.Status400BadRequest, "invalid", ex.Message);
        }
        catch (JsonException)
        {
            return Error(StatusCodes.Status400BadRequest, "invalid", "The report isn't valid JSON.");
        }

        var reportId = NewReportId();
        var files = new List<string>();
        for (var i = 0; i < report.Images.Count; i++)
        {
            var image = report.Images[i];
            using var stream = new MemoryStream(image.Bytes);
            var stored = uploads.StoreLocal(stream, $"bug-{reportId}-{i + 1}{Extension(image.Type)}", AuthorKey, MaxImageBytes);
            if (stored is not null) files.Add(stored.Id);
        }
        if (report.Logs is { } logs)
        {
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(logs));
            var stored = uploads.StoreLocal(stream, $"bug-{reportId}-logs.txt", AuthorKey, MaxLogs * 4L);
            if (stored is not null) files.Add(stored.Id);
        }

        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        var message = world.Store.AddBugReportMessage(channel.Id, AuthorKey, WebhookId, BotName, MessageText(report), Card(report, reportId), [.. files], now);
        hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = MessageViews.Public(world.Store, message) }));
        // Never the report itself, the sender's address or the contact address.
        log.LogInformation("Bug report {Id} posted in #{Channel}", reportId, channel.Name);
        return Results.Json(new { id = reportId }, statusCode: StatusCodes.Status201Created);
    }

    private static async Task<byte[]?> ReadBodyAsync(HttpContext context)
    {
        if (context.Request.ContentLength > MaxBodyBytes) return null;
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0)
        {
            if (buffer.Length + read > MaxBodyBytes) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private static string NewReportId()
    {
        var id = RandomNumberGenerator.GetString("ABCDEFGHJKMNPQRSTVWXYZ23456789", 8);
        return $"{id[..4]}-{id[4..]}";
    }

    private static string Extension(string type) => type switch { "image/png" => ".png", "image/jpeg" => ".jpg", _ => ".webp" };

    // ── The report ──────────────────────────────────────────────────────────

    public sealed record BugImage(string Type, byte[] Bytes);

    public sealed record BugEnv(string Version, string Commit, string Os, string? Browser, string Device, string? Language);

    public sealed record BugReport(string What, string? Steps, string? Expected, string? Email, BugEnv Env, string? Logs, List<BugImage> Images);

    private static readonly HashSet<string> Fields = ["v", "what", "steps", "expected", "email", "env", "logs", "images"];
    private static readonly HashSet<string> EnvFields = ["version", "commit", "os", "browser", "device", "language"];
    private static readonly string[] Devices = ["desktop", "web", "ios", "android"];
    private static readonly string[] ImageTypes = ["image/png", "image/jpeg", "image/webp"];

    [GeneratedRegex(@"^[0-9A-Za-z.+-]{1,32}$")]
    private static partial Regex VersionPattern();

    [GeneratedRegex(@"^([0-9a-f]{7}|dev)$")]
    private static partial Regex CommitPattern();

    /// <summary>OS and browser names: "Windows 11", "Chrome 140", "macOS", "Firefox 141".</summary>
    [GeneratedRegex(@"^[A-Za-z0-9 ._()/-]{1,40}$")]
    private static partial Regex PlatformPattern();

    [GeneratedRegex(@"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")]
    private static partial Regex LanguagePattern();

    [GeneratedRegex(@"^[^\s@<>()\[\],;:""]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")]
    private static partial Regex EmailPattern();

    /// <summary>Checks everything; anything unexpected is refused rather than dropped.</summary>
    public static BugReport Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new PayloadException("The report must be a JSON object.");
        foreach (var p in root.EnumerateObject())
            if (!Fields.Contains(p.Name)) throw new PayloadException($"Unknown field '{p.Name}'.");
        if (Field(root, "v") is { } v && (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var version) || version != 1))
            throw new PayloadException("Unsupported report version.");

        var what = UserText(root, "what", MaxWhat) ?? throw new PayloadException("'what' is required.");
        var steps = UserText(root, "steps", MaxSteps);
        var expected = UserText(root, "expected", MaxExpected);
        var email = OptionalString(root, "email", MaxEmail)?.Trim();
        if (email is { Length: 0 }) email = null;
        if (email is not null && !EmailPattern().IsMatch(email)) throw new PayloadException("'email' isn't an email address.");

        if (Field(root, "env") is not { ValueKind: JsonValueKind.Object } envElement) throw new PayloadException("'env' is required.");
        foreach (var p in envElement.EnumerateObject())
            if (!EnvFields.Contains(p.Name)) throw new PayloadException($"Unknown field 'env.{p.Name}'.");
        string Must(string name, Regex pattern) =>
            OptionalString(envElement, name, 64) is { } value && pattern.IsMatch(value) ? value : throw new PayloadException($"'env.{name}' is missing or invalid.");
        string? May(string name, Regex pattern) =>
            OptionalString(envElement, name, 64) is not { } value ? null : pattern.IsMatch(value) ? value : throw new PayloadException($"'env.{name}' is invalid.");
        var device = OptionalString(envElement, "device", 16);
        if (device is null || !Devices.Contains(device)) throw new PayloadException("'env.device' is missing or invalid.");
        var env = new BugEnv(Must("version", VersionPattern()), Must("commit", CommitPattern()), Must("os", PlatformPattern()),
            May("browser", PlatformPattern()), device, May("language", LanguagePattern()));

        string? logs = null;
        if (OptionalString(root, "logs", MaxLogs) is { } rawLogs && rawLogs.Trim().Length > 0)
            logs = Sessions.Text.Normalize(rawLogs, MaxLogs, allowNewlines: true) ?? throw new PayloadException("'logs' has characters that aren't allowed.");

        var images = new List<BugImage>();
        if (Field(root, "images") is { } list)
        {
            if (list.ValueKind != JsonValueKind.Array) throw new PayloadException("'images' must be a list.");
            if (list.GetArrayLength() > MaxImages) throw new PayloadException($"At most {MaxImages} images.");
            var total = 0;
            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) throw new PayloadException("Each image must be an object.");
                foreach (var p in item.EnumerateObject())
                    if (p.Name is not ("type" or "data")) throw new PayloadException($"Unknown image field '{p.Name}'.");
                var type = OptionalString(item, "type", 32);
                if (type is null || !ImageTypes.Contains(type)) throw new PayloadException("Images must be PNG, JPEG or WebP.");
                var data = OptionalString(item, "data", (MaxImageBytes + 2) / 3 * 4) ?? throw new PayloadException("An image has no data.");
                byte[] bytes;
                try { bytes = Convert.FromBase64String(data); }
                catch (FormatException) { throw new PayloadException("An image isn't valid base64."); }
                if (bytes.Length == 0 || bytes.Length > MaxImageBytes) throw new PayloadException("An image is empty or too big.");
                total += bytes.Length;
                if (total > MaxImagesTotalBytes) throw new PayloadException("The images are too big together.");
                // The bytes decide, not the label.
                if (FileSniffer.Sniff(bytes.AsSpan(0, Math.Min(bytes.Length, 64 * 1024))).Type != type) throw new PayloadException("An image isn't what its type says.");
                images.Add(new BugImage(type, bytes));
            }
        }
        return new BugReport(what, steps, expected, email, env, logs, images);
    }

    /// <summary>The message text: the reporter's own words, under headings; mentions never ping.</summary>
    private string MessageText(BugReport r)
    {
        var text = new StringBuilder();
        text.Append("**What happened**\n").Append(r.What);
        if (r.Steps is not null) text.Append("\n\n**Steps to reproduce**\n").Append(r.Steps);
        if (r.Expected is not null) text.Append("\n\n**Expected**\n").Append(r.Expected);
        if (r.Email is not null) text.Append("\n\n**Contact:** ").Append(r.Email);
        return Quiet(text.ToString());
    }

    private string Quiet(string text) => WebhookPayload.SanitizeMentions(text, MentionRules.None, key => world.Store.GetMember(key)?.Name);

    /// <summary>The card: the first line of what happened, then where it happened.</summary>
    private string Card(BugReport r, string reportId)
    {
        var firstLine = r.What.Split('\n')[0].Trim();
        if (firstLine.Length > 120) firstLine = firstLine[..(char.IsHighSurrogate(firstLine[119]) ? 119 : 120)] + "…";
        var fields = new JsonArray();
        void Add(string name, string? value)
        {
            if (!string.IsNullOrEmpty(value)) fields.Add(new JsonObject { ["name"] = name, ["value"] = value, ["inline"] = true });
        }
        Add("Version", r.Env.Version);
        Add("Commit", r.Env.Commit);
        Add("OS", r.Env.Os);
        Add("Browser", r.Env.Browser);
        Add("Device", r.Env.Device);
        Add("Language", r.Env.Language);
        var card = new JsonObject
        {
            ["title"] = Quiet(firstLine),
            ["color"] = 0xE5534B,
            ["fields"] = fields,
            ["footer"] = new JsonObject { ["text"] = $"Report {reportId}" },
        };
        return new JsonArray(card).ToJsonString();
    }

    // ── Field helpers ───────────────────────────────────────────────────────

    private static JsonElement? Field(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value : null;

    private static string? OptionalString(JsonElement element, string name, int maxLength)
    {
        if (Field(element, name) is not { } value) return null;
        if (value.ValueKind != JsonValueKind.String) throw new PayloadException($"'{name}' must be a string.");
        var text = value.GetString()!;
        if (text.Length > maxLength) throw new PayloadException($"'{name}' is longer than {maxLength} characters.");
        return text;
    }

    /// <summary>The same rules as chat text. Null if absent or blank.</summary>
    private static string? UserText(JsonElement element, string name, int maxLength)
    {
        var raw = OptionalString(element, name, maxLength * 2);
        if (raw is null || raw.Trim().Length == 0) return null;
        return Sessions.Text.Normalize(raw, maxLength, allowNewlines: true)
            ?? throw new PayloadException($"'{name}' must be at most {maxLength} characters, with no invisible control characters.");
    }
}
