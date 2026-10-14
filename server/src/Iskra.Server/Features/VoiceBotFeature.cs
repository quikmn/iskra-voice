using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Voice bots: an admin lets a bot join voice channels (off by default) to play audio. Its LiveKit token publishes audio
/// only and never subscribes (LiveKitTokens.ForBot). Never on stages or in encrypted channels, whose keys a bot can't
/// hold. Also <c>voice.disconnect</c>, which takes anyone (people and bots) out of voice.
/// </summary>
public static class VoiceBotFeature
{
    public static void Register(Router router)
    {
        router.Add("bot.voice.set", Set);
        router.Add("voice.disconnect", Disconnect);
    }

    /// <summary>The bot-only rules for <c>voice.join</c> (everything else is as for people).</summary>
    public static void CheckJoin(Store store, Member bot, Channel channel)
    {
        if (!store.BotJoinsVoice(bot.AccountKey))
            throw RequestException.Forbidden("This bot can't join voice. An admin can allow it in Bots & webhooks.", "bot_no_voice");
        if (channel.Kind == "stage") throw RequestException.BadRequest("Bots can't join stage channels.", "bot_stage");
        if (E2eeChannelFeature.IsEncrypted(store, channel))
            throw RequestException.BadRequest("Bots can't join end-to-end encrypted voice channels.", "bot_e2ee_voice");
    }

    /// <summary>For LiveKit's webhooks and access checks: people always; bots only where <see cref="CheckJoin"/> lets them.</summary>
    public static bool MayBeIn(Store store, Member member, Channel channel) =>
        !store.IsBot(member.AccountKey)
        || (store.BotJoinsVoice(member.AccountKey) && channel.Kind == "voice" && !E2eeChannelFeature.IsEncrypted(store, channel));

    private static object Set(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.Bots)) throw RequestException.Forbidden("Only admins can let a bot join voice.", "admins_bot_voice");
        var key = body.String("accountKey", 64);
        var bot = s.World.Store.GetMember(key);
        if (bot is null || !s.World.Store.IsBot(key)) throw RequestException.NotFound("Bot");
        if (s.World.Store.BuiltinIdOf(key) is not null) throw RequestException.BadRequest("Built-in bots don't join voice.", "bot_builtin_voice");
        var voice = body.OptionalBool("voice") ?? throw RequestException.BadRequest("'voice' is required.");
        s.World.Store.SetBotVoice(key, voice);
        if (!voice) TakeOut(s, key);
        Audit.Record(s, "bot.voice", key, details: new { voice });
        var member = s.Hub.PublicMember(bot);
        s.Hub.Broadcast(Frames.Event("member.updated", new { member }));
        return new { member };
    }

    /// <summary>Takes someone out of voice: their app (or bot) hears about it and doesn't rejoin by itself.</summary>
    private static object? Disconnect(Session s, Member me, Body body)
    {
        var (target, channel) = RoleFeature.InVoice(s, me, body, Perm.MoveMembers);
        TakeOut(s, target.AccountKey);
        Audit.Record(s, "voice.disconnect", target.AccountKey, details: new { channelId = channel.Id, channelName = channel.Name });
        return null;
    }

    private static void TakeOut(Session s, string accountKey)
    {
        if (s.Voice.ChannelOfMember(accountKey) is not { } channelId) return;
        s.Hub.SendToAccount(accountKey, Frames.Event("voice.disconnected", new { channelId }));
        s.Voice.Disconnect(accountKey);
    }
}
