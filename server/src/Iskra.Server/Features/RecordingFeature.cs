using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Recording a voice channel, with consent. The recording happens on the recorder's desktop app (nothing reaches the
/// server); the server decides who may record, keeps the "Recording" mark that everyone who can see the channel sees
/// (also anyone who joins later, through <c>voice.state</c>), carries "don't record me", and in encrypted channels asks
/// everyone in the call first. Leaving someone out is done by the recorder's app: a courtesy between honest apps.
/// </summary>
public static class RecordingFeature
{
    public static void Register(Router router)
    {
        AccountLimits.Limits.TryAdd("voice.record", (6, 1 / 20.0));       // start and stop: 6, then one every 20 s
        AccountLimits.Limits.TryAdd("voice.record.flag", (10, 0.5));      // "don't record me" and answers: 10, then one every 2 s
        router.Add("voice.record.start", Start);
        router.Add("voice.record.stop", Stop);
        router.Add("voice.record.optout", OptOut);
        router.Add("voice.record.consent", Consent);
    }

    private static Channel VoiceChannel(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind is not ("voice" or "stage")) throw RequestException.BadRequest("That isn't a voice channel.");
        return channel;
    }

    private static void Limit(Session s, Member me, string kind)
    {
        if (!s.Hub.Limits.TryTake(me.AccountKey, kind))
            throw new RequestException("rate_limited", "You're doing that too often. Try again in a few seconds.", "record_slow");
    }

    /// <summary>Starts recording the call you're in (the <c>recordVoice</c> permission). Encrypted channels ask everyone first.</summary>
    private static object Start(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.BadRequest("Bots can't record calls.", "record_bot");
        if (!Permissions.Has(me, Perm.RecordVoice)) throw RequestException.Forbidden("You can't record calls on this server.", "record_forbidden");
        if (s.Voice.Participant(channel.Id, me.AccountKey) is null) throw RequestException.BadRequest("Join the voice channel first.", "voice_join_first");
        var recordings = s.Voice.Recordings;
        if (recordings.Get(channel.Id) is { } current)
            throw RequestException.BadRequest("This call is already being recorded.", "record_already", new { by = current.By });
        Limit(s, me, "voice.record");
        var encrypted = E2eeVoiceFeature.IsEncrypted(s.World.Store, channel.Id);
        if (recordings.Start(channel.Id, me.AccountKey, encrypted) is null)
            throw RequestException.BadRequest("This call is already being recorded.", "record_already");
        Audit.Record(s, "voice.record.start", details: new { channelId = channel.Id, channelName = channel.Name, encrypted });
        s.Voice.Republish(channel.Id); // everyone alone in the call is "everyone agreed" at once
        return new { recording = recordings.Public(channel.Id) };
    }

    /// <summary>Stops it: the recorder, or anyone else who may record here (a moderator ending someone's recording).</summary>
    private static object Stop(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        var recordings = s.Voice.Recordings;
        if (recordings.Get(channel.Id) is not { } current) return new { };
        if (current.By != me.AccountKey && !Permissions.Has(me, Perm.RecordVoice))
            throw RequestException.Forbidden("Only the person recording can stop it.", "record_stop_forbidden");
        Limit(s, me, "voice.record");
        if (recordings.Stop(channel.Id) is not { } stopped) return new { };
        Audit.Record(s, "voice.record.stop", target: stopped.By == me.AccountKey ? null : stopped.By, details: new
        {
            channelId = channel.Id, channelName = channel.Name, why = "stopped", durationMs = Math.Max(0, s.Now - stopped.StartedAt), encrypted = stopped.Encrypted,
        });
        s.Voice.Republish(channel.Id);
        return new { };
    }

    /// <summary>"Don't record me" on or off, for every call on this server. Shown next to your name in the call.</summary>
    private static object OptOut(Session s, Member me, Body body)
    {
        var optOut = body.OptionalBool("optOut") ?? throw RequestException.BadRequest("optOut is required.");
        if (s.Voice.Recordings.OptedOut(me.AccountKey) == optOut) return new { optOut };
        Limit(s, me, "voice.record.flag");
        s.Voice.Recordings.SetOptOut(me.AccountKey, optOut);
        if (s.Voice.ChannelOfMember(me.AccountKey) is { } channelId) s.Voice.Republish(channelId);
        return new { optOut };
    }

    /// <summary>Encrypted channels: your answer to "may this call be recorded?". A "no" before it starts calls it off.</summary>
    private static object Consent(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        var agree = body.OptionalBool("agree") ?? throw RequestException.BadRequest("agree is required.");
        if (s.Voice.Participant(channel.Id, me.AccountKey) is null) throw RequestException.BadRequest("Join the voice channel first.", "voice_join_first");
        if (s.Voice.Recordings.Get(channel.Id) is not { Encrypted: true } r) throw RequestException.BadRequest("Nobody is asking to record this call.", "record_none");
        if (r.By == me.AccountKey) return new { }; // the recorder's own yes is a given
        Limit(s, me, "voice.record.flag");
        s.Voice.Recordings.Answer(channel.Id, me.AccountKey, agree);
        s.Voice.Republish(channel.Id);
        return new { };
    }
}
