using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Net.Http.Headers;

namespace Iskra.Server.Features;

/// <summary>
/// The HTTP side of webhooks: <c>POST /hooks/{id}/{secret}</c> (Discord-style JSON), and the vendor formats at
/// <c>/hooks/{id}/{secret}/github</c>, <c>/gitea</c>, <c>/gitlab</c> and <c>/slack</c>.
/// Answers like Discord does (204, or 200 with the message for <c>?wait=true</c>; 429 with <c>retry_after</c>), so
/// existing tools understand it.
/// </summary>
public sealed class WebhookIngress(World world, Hub hub, TimeProvider time, ILogger<WebhookIngress> log)
{
    public const int MaxBodyBytes = 64 * 1024;
    public const int MaxGitHubBodyBytes = 1024 * 1024;

    /// <summary>The URL suffixes for other services' own formats (each ≤ 1 MB).</summary>
    public enum Format { Discord, GitHub, Gitea, GitLab, Slack }

    /// <summary>Per webhook: 5 at once, then one every 2 seconds (30 a minute), like Discord.</summary>
    public const double Burst = 5, PerSecond = 0.5;

    /// <summary>Per client address, for wrong ids or secrets: 20 at once, then one a second.</summary>
    public const double FailBurst = 20, FailPerSecond = 1;

    private readonly ConcurrentDictionary<string, TokenBucket> _hooks = new();
    private readonly ConcurrentDictionary<IPAddress, TokenBucket> _failures = new();

    /// <summary>
    /// Where plain HTTP would be redirected to HTTPS, webhooks from other machines are refused instead: their URL holds
    /// the secret, which has then already crossed the network unencrypted. A redirect would hide that; a 403 shows it.
    /// </summary>
    public static bool RefuseOverPlainHttp(HttpContext context) =>
        !context.Request.IsHttps && context.Request.Path.StartsWithSegments("/hooks")
        && Hosting.Networks.IsElsewhere(context);

    public static Task WriteUseHttpsAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.ContentType = "text/plain; charset=utf-8";
        return context.Response.WriteAsync("Use https:// for this webhook. The secret in its URL was sent unencrypted: regenerate it in Iskra.");
    }

    public static void Map(WebApplication app)
    {
        app.MapPost("/hooks/{id}/{secret}", (HttpContext c, string id, string secret, WebhookIngress hooks) => hooks.PostAsync(c, id, secret, Format.Discord));
        app.MapPost("/hooks/{id}/{secret}/{format}", (HttpContext c, string id, string secret, string format, WebhookIngress hooks) =>
            ParseFormat(format) is { } f ? hooks.PostAsync(c, id, secret, f) : Task.FromResult(Error(StatusCodes.Status404NotFound, "Unknown Webhook", 10015)));
        app.MapGet("/hooks/{id}/{secret}", (HttpContext c, string id, string secret, WebhookIngress hooks) => hooks.Info(c, id, secret));
    }

    private static Format? ParseFormat(string suffix) => suffix switch
    {
        "github" => Format.GitHub,
        "gitea" => Format.Gitea,
        "gitlab" => Format.GitLab,
        "slack" => Format.Slack,
        _ => null,
    };

    private static IResult Error(int status, string message, int code = 0) =>
        Results.Json(new { message, code }, statusCode: status);

    private (Webhook? Hook, IResult? Failure) Authorize(HttpContext context, string id, string secret)
    {
        var ip = context.Connection.RemoteIpAddress ?? IPAddress.None;
        var hook = world.Store.GetWebhook(id);
        if (hook is not null && WebhookFeature.SecretMatches(hook, secret)) return (hook, null);
        // Secrets are 256-bit, so guessing is hopeless; this just keeps junk traffic cheap.
        var bucket = _failures.GetOrAdd(ip, _ => new TokenBucket(FailBurst, FailPerSecond, time));
        if (_failures.Count > 10_000) _failures.Clear();
        if (!bucket.TryTake(out var wait)) return (null, RateLimited(context, wait));
        return (null, Error(StatusCodes.Status404NotFound, "Unknown Webhook", 10015));
    }

    private static IResult RateLimited(HttpContext context, TimeSpan wait)
    {
        context.Response.Headers.RetryAfter = Math.Ceiling(wait.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Results.Json(new { message = "You are being rate limited.", retry_after = Math.Round(wait.TotalSeconds, 3), global = false },
            statusCode: StatusCodes.Status429TooManyRequests);
    }

    public IResult Info(HttpContext context, string id, string secret)
    {
        var (hook, failure) = Authorize(context, id, secret);
        if (hook is null) return failure!;
        return Results.Json(new { type = 1, id = hook.Id, name = hook.Name, channel_id = hook.ChannelId.ToString() });
    }

    public async Task<IResult> PostAsync(HttpContext context, string id, string secret, Format format)
    {
        var (hook, failure) = Authorize(context, id, secret);
        if (hook is null) return failure!;

        var vendor = format != Format.Discord;
        var limit = vendor ? MaxGitHubBodyBytes : MaxBodyBytes;
        var body = await ReadBodyAsync(context, limit);
        if (body is null) return Error(StatusCodes.Status413PayloadTooLarge, "Request entity too large", 40005);
        // Signatures first, so unsigned junk can't use up the webhook's rate; bad ones count against the sender's address.
        if (!SignatureOk(context, hook, format, body))
        {
            var ip = context.Connection.RemoteIpAddress ?? IPAddress.None;
            var bucket = _failures.GetOrAdd(ip, _ => new TokenBucket(FailBurst, FailPerSecond, time));
            if (_failures.Count > 10_000) _failures.Clear();
            if (!bucket.TryTake(out var failWait)) return RateLimited(context, failWait);
            SecurityLog.Record(world.Store, time.GetUtcNow().ToUnixTimeMilliseconds(), "webhook.bad_signature",
                ip: world.Settings.Retention.SecurityLogIps ? ip.ToString() : null,
                details: new { webhook = hook.Id, format = format.ToString().ToLowerInvariant() }, source: ip.ToString());
            return Error(StatusCodes.Status401Unauthorized, "Invalid webhook signature.", 50014);
        }
        if (!_hooks.GetOrAdd(hook.Id, _ => new TokenBucket(Burst, PerSecond, time)).TryTake(out var wait))
            return RateLimited(context, wait);

        WebhookPostRequest? post;
        try
        {
            using var doc = await PayloadDocumentAsync(context, body, vendor);
            post = format switch
            {
                Format.GitHub => WebhookGitHub.Translate(Header(context, "X-GitHub-Event"), doc.RootElement),
                Format.Gitea => WebhookGitHub.Translate(Header(context, "X-Gitea-Event") ?? Header(context, "X-Gogs-Event") ?? Header(context, "X-GitHub-Event"), doc.RootElement, gitea: true),
                Format.GitLab => WebhookGitLab.Translate(doc.RootElement),
                Format.Slack => WebhookSlack.Translate(doc.RootElement),
                _ => WebhookPayload.Parse(doc.RootElement),
            };
        }
        catch (PayloadException ex)
        {
            return Error(StatusCodes.Status400BadRequest, ex.Message, 50006);
        }
        catch (System.Text.RegularExpressions.RegexMatchTimeoutException)
        {
            return Error(StatusCodes.Status400BadRequest, "The text is too complex to post.", 50006);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException or InvalidDataException or IOException)
        {
            return Error(StatusCodes.Status400BadRequest, "The request body isn't valid JSON.", 50109);
        }
        if (post is null) return Results.NoContent(); // an event we don't post about

        var channel = world.Store.GetChannel(hook.ChannelId);
        if (channel is null) return Error(StatusCodes.Status404NotFound, "Unknown Webhook", 10015);

        // Pings only when an admin allowed this webhook to mention people, and then only what the payload allows.
        var rules = hook.Mentions ? post.Mentions : MentionRules.None;
        var text = WebhookPayload.SanitizeMentions(post.Text, rules, key => world.Store.GetMember(key)?.Name);
        var name = post.Username ?? hook.Name;
        var embeds = post.Embeds?.ToJsonString();
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        var message = world.Store.AddWebhookMessage(hook, WebhookFeature.AuthorPrefix + hook.Id, text, name, embeds, now);
        var view = MessageViews.Public(world.Store, message);
        hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = view }));
        LogCounts.Hooks(world).Hit("in");
        log.Write(LogLevel.Debug, "hook", null, "http", "received", null, ("id", hook.Id), ("chan", channel.Id));

        if (format == Format.Slack) return Results.Text("ok"); // what Slack answers, and what its tools check for
        if (!string.Equals(context.Request.Query["wait"], "true", StringComparison.OrdinalIgnoreCase)) return Results.NoContent();
        return Results.Json(new
        {
            id = message.Id.ToString(),
            type = 0,
            channel_id = channel.Id.ToString(),
            webhook_id = hook.Id,
            content = text,
            timestamp = DateTimeOffset.FromUnixTimeMilliseconds(now).ToString("O"),
            author = new { id = hook.Id, username = name, bot = true },
            embeds = post.Embeds,
            iskra = view,
        }, Json.Options);
    }

    private static string? Header(HttpContext context, string name) =>
        context.Request.Headers[name].ToString() is { Length: > 0 and <= 64 } value ? value : null;

    /// <summary>
    /// With a signing secret set, GitHub and Gitea posts must carry its HMAC of the body (X-Hub-Signature-256 or
    /// X-Gitea-Signature) and GitLab posts the secret itself (X-Gitlab-Token). A signed webhook is a GitHub, Gitea or
    /// GitLab webhook: the plain and Slack formats, which can't be signed, are refused, so a leaked URL can't post.
    /// </summary>
    private bool SignatureOk(HttpContext context, Webhook hook, Format format, byte[] body)
    {
        if (world.Store.WebhookSigningSecret(hook.Id) is not { } secret) return true;
        if (format is Format.Discord or Format.Slack) return false;
        var headers = context.Request.Headers;
        return format switch
        {
            Format.GitLab => WebhookText.TokenMatches(secret, headers["X-Gitlab-Token"].ToString()),
            Format.Gitea => WebhookText.HmacMatches(secret, body, headers["X-Hub-Signature-256"].ToString() is { Length: > 0 } hub ? hub : headers["X-Gitea-Signature"].ToString()),
            _ => WebhookText.HmacMatches(secret, body, headers["X-Hub-Signature-256"].ToString()),
        };
    }

    /// <summary>Reads at most <paramref name="limit"/> bytes. Null if the body is bigger.</summary>
    private static async Task<byte[]?> ReadBodyAsync(HttpContext context, int limit)
    {
        if (context.Request.ContentLength > limit) return null;
        var buffer = new byte[limit + 1];
        var length = 0;
        int read;
        while (length < buffer.Length && (read = await context.Request.Body.ReadAsync(buffer.AsMemory(length), context.RequestAborted)) > 0)
            length += read;
        return length > limit ? null : buffer[..length];
    }

    /// <summary>
    /// JSON straight up, or the JSON inside a form: Discord's multipart <c>payload_json</c> (files are ignored),
    /// a urlencoded <c>payload_json</c>/<c>payload</c> (GitHub's form mode), or plain <c>content</c>/<c>username</c> fields.
    /// </summary>
    private static async Task<JsonDocument> PayloadDocumentAsync(HttpContext context, byte[] body, bool vendor)
    {
        var options = new JsonDocumentOptions { MaxDepth = vendor ? 64 : 16 };
        var type = MediaTypeHeaderValue.TryParse(context.Request.ContentType, out var media) ? media.MediaType.Value : null;
        Dictionary<string, string>? form = null;
        if (string.Equals(type, "application/x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase))
        {
            form = QueryHelpers.ParseQuery(Encoding.UTF8.GetString(body)).ToDictionary(p => p.Key, p => p.Value.ToString());
        }
        else if (string.Equals(type, "multipart/form-data", StringComparison.OrdinalIgnoreCase))
        {
            form = await ReadMultipartAsync(body, HeaderUtilities.RemoveQuotes(media!.Boundary).Value
                ?? throw new InvalidDataException("Missing multipart boundary."));
        }
        if (form is null) return JsonDocument.Parse(body, options);

        if (form.TryGetValue("payload_json", out var json) || form.TryGetValue("payload", out json))
            return JsonDocument.Parse(json, options);
        var fields = new Dictionary<string, string>();
        if (form.TryGetValue("content", out var content)) fields["content"] = content;
        if (form.TryGetValue("username", out var username)) fields["username"] = username;
        return JsonDocument.Parse(JsonSerializer.Serialize(fields), options);
    }

    private static async Task<Dictionary<string, string>> ReadMultipartAsync(byte[] body, string boundary)
    {
        var reader = new MultipartReader(boundary, new MemoryStream(body)) { HeadersCountLimit = 16 };
        var fields = new Dictionary<string, string>();
        while (await reader.ReadNextSectionAsync() is { } section)
        {
            if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition)
                || disposition.FileName.HasValue || disposition.FileNameStar.HasValue) continue; // files aren't supported
            var name = HeaderUtilities.RemoveQuotes(disposition.Name).Value;
            if (name is null || fields.Count >= 16) continue;
            using var text = new StreamReader(section.Body, Encoding.UTF8);
            fields[name] = await text.ReadToEndAsync();
        }
        return fields;
    }

    /// <summary>A small thread-safe token bucket.</summary>
    internal sealed class TokenBucket(double capacity, double perSecond, TimeProvider time)
    {
        private readonly Lock _gate = new();
        private readonly double _capacity = capacity;
        private double _tokens = capacity;
        private long _updated = time.GetTimestamp();

        public bool TryTake(out TimeSpan wait)
        {
            lock (_gate)
            {
                var now = time.GetTimestamp();
                _tokens = Math.Min(_capacity, _tokens + time.GetElapsedTime(_updated, now).TotalSeconds * perSecond);
                _updated = now;
                if (_tokens >= 1)
                {
                    _tokens -= 1;
                    wait = TimeSpan.Zero;
                    return true;
                }
                wait = TimeSpan.FromSeconds((1 - _tokens) / perSecond);
                return false;
            }
        }
    }
}
