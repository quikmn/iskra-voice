using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Stage channels: a few speakers, many listeners. Moderators (admins, plus anyone an admin picks per stage) start the
/// stage, bring people up to speak and send them back. Who is in the room comes from LiveKit's webhooks only.
/// </summary>
public static class StageFeature
{
    public static void Register(Router router)
    {
        router.AddAsync("stage.start", Start);
        router.Add("stage.update", Update);
        router.Add("stage.end", End);
        router.Add("stage.hand", Hand);
        router.AddAsync("stage.invite", Invite);
        router.Add("stage.decline", Decline);
        router.AddAsync("stage.audience", Audience);
        router.Add("stage.mute", Mute);
        router.Add("stage.remove", Remove);
        router.Add("stage.moderator", Moderator);
    }

    private static Channel StageChannel(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (!StageRegistry.IsStage(channel)) throw RequestException.BadRequest("That isn't a stage channel.");
        return channel;
    }

    private static void RequireModerator(Session s, Member me, Channel channel)
    {
        if (!s.Voice.Stages.IsModerator(me, channel)) throw RequestException.Forbidden("Only stage moderators can do that.");
    }

    private static void RequireLive(Session s, Channel channel)
    {
        if (!s.Voice.Stages.IsLive(channel.Id)) throw RequestException.BadRequest("This stage isn't live.");
    }

    private static string Topic(Body body) =>
        Text.Normalize(body.String("topic", StageRegistry.MaxTopicLength * 4), StageRegistry.MaxTopicLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"The topic must be 1–{StageRegistry.MaxTopicLength} characters.");

    /// <summary>Someone in the room right now (as LiveKit reports it).</summary>
    private static Member Present(Session s, Channel channel, Body body)
    {
        var key = body.String("accountKey", 64);
        if (!s.Voice.Stages.InRoom(channel.Id, key) || s.World.Store.GetMember(key) is not { } member)
            throw RequestException.NotFound("Person on this stage");
        return member;
    }

    /// <summary>Moderators can't act on other moderators, except admins on those ranked below them.</summary>
    private static void RequireCanActOn(Session s, Member me, Channel channel, Member target)
    {
        RequireModerator(s, me, channel);
        if (target.AccountKey != me.AccountKey && s.Voice.Stages.IsModerator(target, channel)
            && !(Permissions.IsAdmin(me) && Permissions.Outranks(me, target)))
            throw RequestException.Forbidden("You can't do that to another moderator.");
    }

    private static RequestException Unavailable() => new("voice_unavailable", "Voice isn't available on this server right now.");

    private static async Task<object?> Start(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        var topic = Topic(body);
        RequireModerator(s, me, channel);
        var stages = s.Voice.Stages;
        if (!stages.InRoom(channel.Id, me.AccountKey)) throw RequestException.BadRequest("Join the stage first.");
        if (!stages.Start(channel.Id, me.AccountKey, topic, s.Now)) throw RequestException.BadRequest("This stage is already live.");
        if (!await stages.AddSpeakerAsync(channel.Id, me.AccountKey))
        {
            stages.Cancel(channel.Id);
            throw Unavailable();
        }
        return stages.PublicState(channel.Id);
    }

    private static object? Update(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        var topic = Topic(body);
        RequireModerator(s, me, channel);
        RequireLive(s, channel);
        s.Voice.Stages.SetTopic(channel.Id, topic);
        return null;
    }

    private static object? End(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        RequireModerator(s, me, channel);
        RequireLive(s, channel);
        s.Voice.Stages.End(channel.Id);
        return null;
    }

    /// <summary>Raise or lower your hand. Only people allowed to speak in the channel can ask.</summary>
    private static object? Hand(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        var raised = body.OptionalBool("raised") ?? throw RequestException.BadRequest("'raised' is required.");
        var stages = s.Voice.Stages;
        RequireLive(s, channel);
        if (!stages.InRoom(channel.Id, me.AccountKey)) throw RequestException.BadRequest("Join the stage first.");
        if (raised && !stages.MaySpeak(me, channel)) throw RequestException.Forbidden("You can only listen on this stage.");
        if (raised && stages.IsSpeaker(channel.Id, me.AccountKey)) throw RequestException.BadRequest("You're already speaking.");
        if (!stages.SetHand(channel.Id, me.AccountKey, raised, s.Now)) throw RequestException.BadRequest("Too many hands are up right now.");
        return null;
    }

    /// <summary>Brings someone up to speak (accepting their hand, or inviting them directly). Moderators can bring themselves up.</summary>
    private static async Task<object?> Invite(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        RequireModerator(s, me, channel);
        RequireLive(s, channel);
        var target = Present(s, channel, body);
        if (!s.Voice.Stages.MaySpeak(target, channel)) throw RequestException.Forbidden("They can only listen on this stage.");
        if (s.World.Store.IsBot(target.AccountKey)) throw RequestException.Forbidden("Bots can't speak.");
        if (!await s.Voice.Stages.AddSpeakerAsync(channel.Id, target.AccountKey)) throw Unavailable();
        return null;
    }

    private static object? Decline(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        RequireModerator(s, me, channel);
        var key = body.String("accountKey", 64);
        s.Voice.Stages.SetHand(channel.Id, key, false, s.Now);
        return null;
    }

    /// <summary>Back to the audience: speakers step down themselves; moderators can move others.</summary>
    private static async Task<object?> Audience(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        var key = body.OptionalString("accountKey", 64) ?? me.AccountKey;
        if (key != me.AccountKey)
        {
            var target = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
            RequireCanActOn(s, me, channel, target);
        }
        await s.Voice.Stages.RemoveSpeakerAsync(channel.Id, key);
        return null;
    }

    private static object? Mute(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        var target = Present(s, channel, body);
        RequireCanActOn(s, me, channel, target);
        if (!s.Voice.Stages.IsSpeaker(channel.Id, target.AccountKey)) throw RequestException.BadRequest("They aren't speaking.");
        _ = s.Voice.Backend.MuteMicrophoneAsync(VoiceRegistry.RoomName(channel.Id), target.AccountKey);
        return null;
    }

    /// <summary>Sends someone off the stage (they can come back; kick or ban them to keep them out).</summary>
    private static object? Remove(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        var target = Present(s, channel, body);
        if (target.AccountKey == me.AccountKey) throw RequestException.BadRequest("Leave the stage instead.");
        RequireCanActOn(s, me, channel, target);
        _ = s.Voice.Backend.RemoveParticipantAsync(VoiceRegistry.RoomName(channel.Id), target.AccountKey);
        return null;
    }

    /// <summary>Admins pick who else moderates this stage.</summary>
    private static object? Moderator(Session s, Member me, Body body)
    {
        var channel = StageChannel(s, me, body);
        var on = body.OptionalBool("on") ?? throw RequestException.BadRequest("'on' is required.");
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can choose stage moderators.");
        var key = body.String("accountKey", 64);
        if (on)
        {
            var target = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
            if (s.World.Store.IsBot(key)) throw RequestException.BadRequest("Bots can't moderate stages.");
            if (!Permissions.CanRead(target, channel)) throw RequestException.BadRequest("They can't see this stage.");
        }
        if (!s.World.Store.SetStageModerator(channel.Id, key, on, me.AccountKey, s.Now))
            throw RequestException.BadRequest($"A stage can have up to {Store.MaxStageModerators} moderators.");
        s.Voice.Stages.Publish(channel.Id);
        s.Voice.Stages.Sync(channel.Id); // a former moderator who can't otherwise speak steps down
        return null;
    }
}
