using Iskra.Server.Protocol;

namespace Iskra.Server.Features;

/// <summary>
/// Hi-fi voice channels: an admin allows them per voice channel, and there people who turn hi-fi on send stereo at
/// 128 kbps with no noise suppression, echo cancellation or automatic gain. It's a promise between clients (LiveKit
/// carries whatever a client sends, within its own limits), so the server only stores and shares the setting.
/// </summary>
public static class HifiFeature
{
    /// <summary>`hifi` on channel.create / channel.update: voice channels only.</summary>
    internal static bool? Field(Body body, string kind)
    {
        if (body.OptionalBool("hifi") is not { } value) return null;
        if (kind != "voice") throw RequestException.BadRequest("Only voice channels can allow hi-fi audio.");
        return value;
    }
}
