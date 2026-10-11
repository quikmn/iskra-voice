using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// User limits on voice channels (Discord's "2/5"). Checked when a token is handed out and again when LiveKit reports the
/// join, so racing tokens can't overfill a room. People who can move members get in anyway, and so does someone a
/// moderator just moved there. Stages have no limit: they're built for a big audience that only listens.
/// </summary>
public static class VoiceLimitFeature
{
    public const int MaxUserLimit = 99;
    /// <summary>How long a move lets someone into a full channel (their app joins right away).</summary>
    public const long MovePassMs = 60_000;

    /// <summary>`userLimit` on channel.create / channel.update: 0–99, voice channels only.</summary>
    internal static int? Field(Body body, string kind)
    {
        if (body.OptionalLong("userLimit", min: 0, max: MaxUserLimit) is not { } value) return null;
        if (kind == "stage") throw RequestException.BadRequest("Stages don't have a user limit: anyone who can see one can listen in.");
        if (kind != "voice") throw RequestException.BadRequest("Only voice channels have a user limit.");
        return (int)value;
    }

    public static bool Bypasses(Member member) => Permissions.Has(member, Perm.MoveMembers);

    /// <summary>True if the member may be in the channel as far as its limit goes (they don't count against themselves).</summary>
    internal static bool HasRoom(Store store, VoiceRegistry voice, Member member, Channel channel, long now)
    {
        if (channel.Kind != "voice") return true;
        var limit = store.UserLimit(channel.Id);
        if (limit <= 0 || Bypasses(member) || voice.HasMovePass(member.AccountKey, channel.Id, now)) return true;
        return voice.Participants(channel.Id).Count(p => p.AccountKey != member.AccountKey) < limit;
    }

    internal static void CheckJoin(Session s, Member me, Channel channel)
    {
        if (HasRoom(s.World.Store, s.Voice, me, channel, s.Now)) return;
        var limit = s.World.Store.UserLimit(channel.Id);
        throw new RequestException("channel_full", $"{channel.Name} is full ({limit}/{limit}). Try again when someone leaves.");
    }
}
