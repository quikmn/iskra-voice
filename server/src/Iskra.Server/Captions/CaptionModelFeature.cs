using Iskra.Server.Files;
using Iskra.Server.Sessions;

namespace Iskra.Server.Captions;

/// <summary>
/// GET /models/{dir}/{part}: the live-captions model for members' apps, so their devices only ever talk to their own
/// server. The first request (or one after a failed attempt) makes the server fetch the model once; everyone else
/// waits for that same download. HEAD answers whether this server offers captions, without fetching anything.
/// </summary>
public static class CaptionModelFeature
{
    public static void Map(WebApplication app)
    {
        app.MapMethods("/models/{dir}/{part}", ["GET", "HEAD"], ServeAsync);
        app.MapMethods("/models/{dir}/{part}", ["OPTIONS"], (HttpContext context) =>
        {
            Uploads.AllowCors(context);
            return Results.NoContent();
        });
    }

    private static async Task<IResult> ServeAsync(HttpContext context, string dir, string part, CaptionModelService model, Hub hub)
    {
        // app://, capacitor:// and the web app's own origin all download it; the model is public, there are no cookies.
        Uploads.AllowCors(context);
        if (!model.Enabled || model.PathOf(dir, part) is not { } path) return Results.NotFound();
        if (HttpMethods.IsHead(context.Request.Method)) return Results.Ok();
        var client = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (!hub.Limits.TryTake(client, "captions.model")) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
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
        context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return Results.File(path, "application/octet-stream", enableRangeProcessing: true);
    }
}
