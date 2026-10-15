using System.Security.Cryptography;
using System.Text;
using Iskra.Server.Captions;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Translate;

/// <summary>
/// Message translation runs on members' devices; this server only hands out the models (PROTOCOL.md "Translation
/// models"). GET /models/translate/{dir}/{part}, for members only: the app asks for a short-lived signed link over its
/// session (translate.models.link), and every request without a valid one is refused before anything is fetched. The
/// owner turns it on in Server settings → Translation (translate.config, translate.configure).
/// </summary>
public static class TranslateFeature
{
    public static readonly TimeSpan LinkLifetime = TimeSpan.FromHours(1);
    private const string LinkContext = "iskra/translate-models-link/v1";
    public const string Path = "/models/translate";

    /// <summary>Signs links. Per process: links simply stop working after a restart (the app asks again).</summary>
    private static readonly byte[] LinkKey = RandomNumberGenerator.GetBytes(32);

    public static void Register(Router router, TranslationModelService models)
    {
        router.Add("translate.models.link", (s, me, _) => Link(s, me, models));
        router.Add("translate.config", (_, me, _) =>
        {
            OwnerOnly(me);
            return Config(models);
        });
        router.Add("translate.configure", (s, me, body) =>
        {
            OwnerOnly(me);
            var offer = body.OptionalBool("offer") ?? throw RequestException.BadRequest("offer is required.");
            var before = s.World.Settings.Translate.Offer;
            if (offer != before)
            {
                s.World.UpdateSettings(w => w with { Translate = w.Translate with { Offer = offer } });
                SecurityLog.Record(s, "translate.settings", details: new { offer });
            }
            return Config(models);
        });
    }

    private static void OwnerOnly(Member me)
    {
        if (!BaseRoles.Allows(me, BaseAbility.RunServer)) throw RequestException.Forbidden("Only the owner can change translation.", "owner_translate");
    }

    private static object Config(TranslationModelService models) => new { offer = models.Enabled, downloaded = models.Downloaded };

    private static object Link(Session s, Member me, TranslationModelService models)
    {
        if (!models.Enabled) return new { offered = false };
        var expires = s.Now + (long)LinkLifetime.TotalMilliseconds;
        return new
        {
            offered = true,
            models = models.Pins.Models.Select(m => m.Name).ToArray(),
            path = Path,
            query = $"a={Uri.EscapeDataString(me.AccountKey)}&exp={expires}&sig={Sign(me.AccountKey, expires)}",
            expires,
        };
    }

    internal static string Sign(string account, long expires) =>
        Ed25519.ToB64u(HMACSHA256.HashData(LinkKey, Encoding.UTF8.GetBytes($"{LinkContext}\0{account}\0{expires}")));

    /// <summary>A link from translate.models.link that hasn't expired, for someone who is still a member.</summary>
    private static bool Allowed(HttpContext context, World world)
    {
        var query = context.Request.Query;
        var account = query["a"].ToString();
        var now = context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow().ToUnixTimeMilliseconds();
        if (account.Length is 0 or > 64 || !long.TryParse(query["exp"], out var expires) || expires < now
            || expires > now + (long)LinkLifetime.TotalMilliseconds + 60_000
            || !Ed25519.TryFromB64u(query["sig"].ToString(), out var sig)
            || !Ed25519.TryFromB64u(Sign(account, expires), out var good) || !CryptographicOperations.FixedTimeEquals(sig, good))
            return false;
        return world.Store.GetMember(account) is not null;
    }

    public static void Map(WebApplication app)
    {
        app.MapMethods($"{Path}/{{dir}}/{{part}}", ["GET", "HEAD"], ServeAsync);
        app.MapMethods($"{Path}/{{dir}}/{{part}}", ["OPTIONS"], (HttpContext context) =>
        {
            Uploads.AllowCors(context);
            return Results.NoContent();
        });
    }

    private static async Task<IResult> ServeAsync(HttpContext context, string dir, string part, TranslationModelService models, Hub hub, World world)
    {
        // app://, capacitor:// and the web app's own origin all download it; the link in the address is the credential (no cookies).
        Uploads.AllowCors(context);
        if (!models.Enabled || models.ByDir(dir) is not { } model || model.PathOf(dir, part) is not { } path) return Results.NotFound();
        var client = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (!hub.Limits.TryTake(client, "translate.model")) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
        if (!Allowed(context, world)) return Results.StatusCode(StatusCodes.Status403Forbidden);
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
