using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Whisper (talk only to chosen people, or to everyone in another voice channel) and priority speakers. A whisper is its
/// own LiveKit room: the whisperer's token may publish one microphone track and never subscribe, listeners' tokens may
/// only subscribe, and the server hands listener tokens only to the people the whisper reaches right now
/// (WhisperRegistry). Priority is a flag in voice.state; apps turn others down while a priority speaker talks.
/// </summary>
public static class WhisperFeature
{
    public static void Register(Router router)
    {
        router.Add("whisper.start", Start);
        router.Add("whisper.stop", Stop);
        router.Add("whisper.join", Join);
        router.Add("voice.priority", Priority);
    }

    private static object Start(Session s, Member me, Body body)
    {
        var slot = body.OptionalLong("slot", 1, WhisperRegistry.MaxSlots) ?? throw RequestException.BadRequest($"'slot' must be 1–{WhisperRegistry.MaxSlots}.");
        var channelId = body.OptionalLong("channelId");
        var people = body.OptionalStringArray("targets", WhisperRegistry.MaxPeople, 64).Distinct().Where(k => k != me.AccountKey).ToArray();
        if ((channelId is null) == !body.Has("targets"))
            throw RequestException.BadRequest("Send either 'targets' or 'channelId'.");
        if (channelId is null && people.Length == 0)
            throw RequestException.BadRequest("Pick someone to whisper to.", "whisper_no_targets");

        var whisper = s.Voice.Whisper;
        if (!s.Voice.Backend.Available) throw new RequestException("voice_unavailable", "Voice isn't available on this server right now.");
        if (whisper.WhispererProblem(me) is { } problem) throw problem;
        if (channelId is { } id && whisper.ChannelProblem(me, ChatFeature.ReadableChannel(s, me, id)) is { } channelProblem) throw channelProblem;

        var (session, reached) = whisper.Start(me, (int)slot, channelId, people);
        var backend = s.Voice.Backend;
        var token = LiveKitTokens.ForWhisper(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, session.Room, speaker: true, s.Time.GetUtcNow());
        var url = LiveKitHost.ClientUrlFor(s.Origin, backend, s.World.Settings.Voice.ClientUrl, s.Tunnelled);
        return new { id = session.Id, url, token, room = session.Room, reached };
    }

    private static object? Stop(Session s, Member me, Body body)
    {
        if (!s.Voice.Whisper.Stop(me.AccountKey, body.String("id", 32))) throw RequestException.NotFound("Whisper");
        return null;
    }

    /// <summary>A listener's token for a whisper that reaches them (after whisper.incoming).</summary>
    private static object Join(Session s, Member me, Body body)
    {
        var session = s.Voice.Whisper.Joinable(body.String("id", 32), me.AccountKey) ?? throw RequestException.NotFound("Whisper");
        var backend = s.Voice.Backend;
        var token = LiveKitTokens.ForWhisper(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, session.Room, speaker: false, s.Time.GetUtcNow());
        var url = LiveKitHost.ClientUrlFor(s.Origin, backend, s.World.Settings.Voice.ClientUrl, s.Tunnelled);
        return new { url, token, room = session.Room };
    }

    /// <summary>Priority on (the key is held, or "always") or off. Only priority speakers who can talk where they are.</summary>
    private static object? Priority(Session s, Member me, Body body)
    {
        var on = body.OptionalBool("on") ?? throw RequestException.BadRequest("'on' must be true or false.");
        if (on)
        {
            if (!Permissions.Has(me, Perm.PrioritySpeaker))
                throw RequestException.Forbidden("You aren't a priority speaker on this server.", "priority_not_allowed");
            if (s.Voice.ChannelOfMember(me.AccountKey) is not { } channelId || s.World.Store.GetChannel(channelId) is not { } channel)
                throw RequestException.BadRequest("Join a voice channel first.", "priority_not_in_voice");
            var canTalk = channel.Kind == "stage" ? s.Voice.Stages.IsSpeaker(channelId, me.AccountKey) : Permissions.CanWrite(me, channel);
            if (!canTalk || s.Voice.IsServerMuted(me.AccountKey) || s.Voice.IsAfkForced(me.AccountKey))
                throw RequestException.Forbidden("You can't talk here.", "priority_cant_talk");
        }
        s.Voice.SetPriority(me.AccountKey, on);
        return null;
    }
}
