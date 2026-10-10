using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

public static class VoiceFeature
{
    public static void Register(Router router)
    {
        router.Add("voice.join", Join);
        router.Add("voice.state", State);
    }

    /// <summary>
    /// Hands out a LiveKit token for one voice channel. Speaking needs the channel's write role;
    /// readers can listen. The actual join is confirmed later by LiveKit's webhook.
    /// </summary>
    private static object Join(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind != "voice") throw RequestException.BadRequest("That isn't a voice channel.");
        var backend = s.Voice.Backend;
        if (!backend.Available) throw new RequestException("voice_unavailable", "Voice isn't available on this server right now.");

        var room = VoiceRegistry.RoomName(channel.Id);
        var token = LiveKitTokens.ForRoom(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, room,
            canPublish: Permissions.CanWrite(me, channel), s.Time.GetUtcNow());
        return new { url = backend.ClientUrl, token, room, canSpeak = Permissions.CanWrite(me, channel) };
    }

    private static object? State(Session s, Member me, Body body)
    {
        var muted = body.OptionalBool("muted") ?? false;
        var deafened = body.OptionalBool("deafened") ?? false;
        s.Voice.SetFlags(me.AccountKey, muted, deafened);
        return null;
    }
}
