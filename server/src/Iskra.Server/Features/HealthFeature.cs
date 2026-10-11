using System.Diagnostics;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>GET /health for uptime monitors: no names, addresses, counts or settings, just whether it works.</summary>
public static class HealthFeature
{
    private static readonly long Started = Stopwatch.GetTimestamp();

    public static IResult Report(World world, IVoiceBackend voice, string version)
    {
        var voiceState = !world.Settings.Voice.Enabled ? "off" : voice.Available ? "up" : "down";
        return Results.Json(new
        {
            iskra = 1,
            status = "ok",
            version,
            uptimeSeconds = (long)Stopwatch.GetElapsedTime(Started).TotalSeconds,
            voice = voiceState,
        }, statusCode: 200);
    }
}
