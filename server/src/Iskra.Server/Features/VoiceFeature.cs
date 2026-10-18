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
    /// readers can listen. The actual join is confirmed later by LiveKit's webhook. Joining a lobby makes a room of
    /// your own (RoomFeature) and hands out the token for that instead: the answer's <c>channelId</c> says where you went.
    /// </summary>
    private static object Join(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind is not ("voice" or "stage")) throw RequestException.BadRequest("That isn't a voice channel.");
        var bot = s.World.Store.IsBot(me.AccountKey);
        if (bot) VoiceBotFeature.CheckJoin(s.World.Store, me, channel);
        if (!Permissions.CanConnect(me, channel)) throw RequestException.Forbidden("You can't join this voice channel.", "voice_cant_join");
        E2eeVoiceFeature.CheckJoin(s.World.Store, me, channel);
        var lobby = channel.Kind == "voice" && RoomFeature.IsLobby(s.World.Store, channel.Id);
        if (!lobby)
        {
            VoiceLimitFeature.CheckJoin(s, me, channel);
            RoomFeature.CheckJoin(s, me, channel);
        }
        var backend = s.Voice.Backend;
        if (!backend.Available) throw new RequestException("voice_unavailable", "Voice isn't available on this server right now.");
        if (lobby) channel = RoomFeature.Create(s, me, channel);
        s.Voice.Recordings.SetAware(me.AccountKey, s.RecordingAware && !bot); // only apps that show the mark are ever recorded

        var room = VoiceRegistry.RoomName(channel.Id);
        // Everyone joins a stage listening; speaking is granted later through LiveKit's API (StageRegistry).
        // The AFK channel mutes and deafens everyone without a talk level or role (AfkFeature).
        var afk = channel.Kind == "voice" && AfkFeature.IsForced(s.World.Store, me, channel.Id);
        var canSpeak = channel.Kind == "voice" && !afk && Permissions.CanWrite(me, channel) && !s.Voice.IsServerMuted(me.AccountKey);
        var token = bot
            ? LiveKitTokens.ForBot(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, room, canPublish: canSpeak, s.Time.GetUtcNow())
            : LiveKitTokens.ForRoom(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, room, canPublish: canSpeak, s.Time.GetUtcNow(), canSubscribe: !afk);
        // Over HTTPS (internet hosting) or Tailscale voice goes through the same address the client used.
        var url = LiveKitHost.ClientUrlFor(s.Origin, backend, s.World.Settings.Voice.ClientUrl, s.Tunnelled);
        // Whisper and priority (WhisperFeature): what the app may offer here; the server checks each use again.
        var whisper = !bot && channel.Kind == "voice" && BaseRoles.Allows(me, BaseAbility.Whisper) && !E2eeChannelFeature.IsEncrypted(s.World.Store, channel);
        var priority = !bot && Permissions.Has(me, Perm.PrioritySpeaker);
        return new { url, token, room, channelId = channel.Id, canSpeak, canHear = !afk && !bot, afk, whisper, priority };
    }

    private static object? State(Session s, Member me, Body body)
    {
        var muted = body.OptionalBool("muted") ?? false;
        var deafened = body.OptionalBool("deafened") ?? false;
        s.Voice.SetFlags(me.AccountKey, muted, deafened, body.OptionalBool("clips"));
        return null;
    }
}
