using System.Globalization;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Voice channel status (Discord's "CS2 ranked"): a short line people in a call set for it, shown under the channel's
/// name. It lives with the call: VoiceRegistry clears it when the call empties. Setting needs the `setVoiceStatus`
/// channel permission (with the write level by default); moderators may clear one from anywhere, and that's audited.
/// </summary>
public static class VoiceStatusFeature
{
    /// <summary>User-perceived characters (an emoji counts once).</summary>
    public const int MaxLength = 60;
    /// <summary>UTF-16 units, for long emoji sequences.</summary>
    public const int MaxUnits = 240;

    public static void Register(Router router) => router.Add("voice.status.set", Set);

    /// <summary>Clearing someone's status from outside the call: voice moderators.</summary>
    public static bool IsModerator(Member member) =>
        Permissions.Has(member, Perm.ManageChannels) || Permissions.Has(member, Perm.MuteMembers) || Permissions.Has(member, Perm.MoveMembers);

    /// <summary>The status text, or null to clear. Throws for text that can't be a status.</summary>
    internal static string? ParseText(string raw)
    {
        if (raw.Trim().Length == 0) return null;
        var text = Text.Normalize(raw, MaxUnits, allowNewlines: false);
        if (text is null || new StringInfo(text).LengthInTextElements > MaxLength)
            throw RequestException.BadRequest($"Statuses are one line of up to {MaxLength} characters.", "voice_status_text", new { max = MaxLength });
        return text;
    }

    private static object Set(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind != "voice") throw RequestException.BadRequest("Only voice channels have a status.", "voice_status_voice_only");
        var text = ParseText(body.String("text", MaxUnits * 4));
        var inCall = s.Voice.Participant(channel.Id, me.AccountKey) is not null;
        var mayUse = inCall && Permissions.CanSetVoiceStatus(me, channel);
        var asModerator = !mayUse && text is null && IsModerator(me);
        if (!mayUse && !asModerator)
        {
            if (!inCall) throw RequestException.BadRequest("Join the voice channel first.", "voice_join_first");
            throw RequestException.Forbidden("You can't set the status of this voice channel.", "voice_status_denied");
        }

        var board = s.Voice.Statuses;
        var current = board.Get(channel.Id);
        if (current?.Text == text) return new { status = VoiceStatusBoard.Public(current) }; // nothing changes
        if (!s.Hub.Limits.TryTake(me.AccountKey, "voice.status"))
            throw new RequestException("rate_limited", "You're changing the status too often. Try again in a few seconds.", "voice_status_slow");

        if (text is null)
        {
            var cleared = board.Clear(channel.Id);
            if (asModerator && cleared is not null)
                Audit.Record(s, "voice.status.clear", cleared.SetBy, details: new { channelId = channel.Id, channelName = channel.Name });
            s.Voice.Republish(channel.Id);
            return new { status = (object?)null };
        }

        AutoModFeature.Check(s, me, channel, text, "voicestatus");
        var status = new VoiceStatus(text, me.AccountKey, s.Now);
        board.Set(channel.Id, status);
        s.Voice.Republish(channel.Id);
        return new { status = VoiceStatusBoard.Public(status) };
    }
}
