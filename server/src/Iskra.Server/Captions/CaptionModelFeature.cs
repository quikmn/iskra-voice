using System.Security.Cryptography;
using System.Text;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Captions;

/// <summary>
/// GET /models/{dir}/{part}: the live-captions model for members' apps, so their devices only ever talk to their own
/// server. Members only: the app asks for a short-lived signed link over its session (captions.model.link), and every
/// request without a valid one is refused before anything is fetched. The first request (or one after a failed
/// attempt) makes the server fetch the model once; everyone else waits for that same download. HEAD answers whether
/// this server offers captions, without fetching anything.
/// </summary>
public static class CaptionModelFeature
{
    public static readonly TimeSpan LinkLifetime = TimeSpan.FromHours(1);
    private const string LinkContext = "iskra/captions-model-link/v1";

    /// <summary>Signs links. Per process: links simply stop working after a restart (the app asks again).</summary>
    private static readonly byte[] LinkKey = RandomNumberGenerator.GetBytes(32);

    public static void Register(Router router, CaptionModelService model) =>
        router.Add("captions.model.link", (s, me, _) => Link(s, me, model));

    private static object Link(Session s, Member me, CaptionModelService model)
    {
        if (!model.Enabled) return new { offered = false };
        var expires = s.Now + (long)LinkLifetime.TotalMilliseconds;
        return new
        {
            offered = true,
            path = $"/models/{model.Manifest.Dir}",
            query = $"a={Uri.EscapeDataString(me.AccountKey)}&exp={expires}&sig={Sign(model.Manifest.Dir, me.AccountKey, expires)}",
            expires,
        };
    }

    internal static string Sign(string dir, string account, long expires) =>
        Ed25519.ToB64u(HMACSHA256.HashData(LinkKey, Encoding.UTF8.GetBytes($"{LinkContext}\0{dir}\0{account}\0{expires}")));

    /// <summary>A link from captions.model.link that hasn't expired, for someone who is still a member.</summary>
    private static bool Allowed(HttpContext context, World world, string dir)
    {
        var query = context.Request.Query;
        var account = query["a"].ToString();
        var now = context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow().ToUnixTimeMilliseconds();
        if (account.Length is 0 or > 64 || !long.TryParse(query["exp"], out var expires) || expires < now
            || expires > now + (long)LinkLifetime.TotalMilliseconds + 60_000
            || !Ed25519.TryFromB64u(query["sig"].ToString(), out var sig)
            || !Ed25519.TryFromB64u(Sign(dir, account, expires), out var good) || !CryptographicOperations.FixedTimeEquals(sig, good))
            return false;
        return world.Store.GetMember(account) is not null;
    }

    public static void Map(WebApplication app)
    {
        app.MapMethods("/models/{dir}/{part}", ["GET", "HEAD"], ServeAsync);
        app.MapMethods("/models/{dir}/{part}", ["OPTIONS"], (HttpContext context) =>
        {
            Uploads.AllowCors(context);
            return Results.NoContent();
        });
    }

    private static async Task<IResult> ServeAsync(HttpContext context, string dir, string part, CaptionModelService model, Hub hub, World world)
    {
        // app://, capacitor:// and the web app's own origin all download it; the link in the address is the credential (no cookies).
        Uploads.AllowCors(context);
        if (!model.Enabled || model.PathOf(dir, part) is not { } path) return Results.NotFound();
        var client = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (!hub.Limits.TryTake(client, "captions.model")) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
        if (!Allowed(context, world, dir)) return Results.StatusCode(StatusCodes.Status403Forbidden);
        if (HttpMethods.IsHead(context.Request.Method)) return Results.Ok();
        if (!File.Exists(path))
        {
            try
            {
                await model.EnsureAsync().WaitAsync(context.RequestAborted);
            }
            catch (ModelDownloadException)
            {
                return Results.StatusCode(StatusCodes.Status502BadGateway);
            }
            catch (OperationCanceledException)
            {
                return Results.Empty;
            }
            if (!File.Exists(path)) return Results.StatusCode(StatusCodes.Status502BadGateway);
        }
        context.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
        return Results.File(path, "application/octet-stream", enableRangeProcessing: true);
    }
}
