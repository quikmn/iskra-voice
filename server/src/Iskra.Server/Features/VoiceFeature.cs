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
        if (channel.Kind is not ("voice" or "stage")) throw RequestException.BadRequest("That isn't a voice channel.");
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't join voice.");
        if (!Permissions.CanConnect(me, channel)) throw RequestException.Forbidden("You can't join this voice channel.", "voice_cant_join");
        VoiceLimitFeature.CheckJoin(s, me, channel);
        var backend = s.Voice.Backend;
        if (!backend.Available) throw new RequestException("voice_unavailable", "Voice isn't available on this server right now.");

        var room = VoiceRegistry.RoomName(channel.Id);
        // Everyone joins a stage listening; speaking is granted later through LiveKit's API (StageRegistry).
        var canSpeak = channel.Kind == "voice" && Permissions.CanWrite(me, channel) && !s.Voice.IsServerMuted(me.AccountKey);
        var token = LiveKitTokens.ForRoom(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, room,
            canPublish: canSpeak, s.Time.GetUtcNow());
        // Over HTTPS (internet hosting) or Tailscale voice goes through the same address the client used.
        var url = LiveKitHost.ClientUrlFor(s.Origin, backend, s.World.Settings.Voice.ClientUrl, s.Tunnelled);
        return new { url, token, room, canSpeak };
    }

    private static object? State(Session s, Member me, Body body)
    {
        var muted = body.OptionalBool("muted") ?? false;
        var deafened = body.OptionalBool("deafened") ?? false;
        s.Voice.SetFlags(me.AccountKey, muted, deafened, body.OptionalBool("clips"));
        return null;
    }
}
