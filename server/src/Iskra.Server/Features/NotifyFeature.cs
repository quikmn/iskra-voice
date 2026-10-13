using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Per-account notification settings for the whole server and for single channels: a level (all messages,
/// only mentions, nothing) and an optional mute. Stored here so every device and Web Push follow them.
/// </summary>
public static class NotifyFeature
{
    public const string All = "all";
    public const string Mentions = "mentions";
    public const string Nothing = "none";
    /// <summary>Below this many people (bots not counted) the level when nothing is set is "all messages".</summary>
    public const int SmallServer = 15;
    public const long Forever = -1;
    public const int MaxMuteMinutes = 30 * 24 * 60;

    private static readonly string[] Levels = [All, Mentions, Nothing];

    public static void Register(Router router) => router.Add("notify.set", Set);

    private static bool Active(NotifySetting setting, long now) => setting.MutedUntil is { } until && (until == Forever || until > now);

    /// <summary>The wire shape. An expired mute reads as not muted.</summary>
    public static object Public(NotifySetting setting, long now) => new
    {
        channelId = setting.ChannelId == 0 ? (long?)null : setting.ChannelId,
        level = setting.Level,
        mutedUntil = Active(setting, now) ? setting.MutedUntil : null,
    };

    /// <summary>An account's settings for the welcome (empty rows left by expired mutes are skipped).</summary>
    public static List<object> Settings(Store store, string accountKey, long now) =>
        store.NotifySettings(accountKey).Where(n => n.Level is not null || Active(n, now)).Select(n => Public(n, now)).ToList();

    /// <summary>
    /// The level when nothing is set: every message on a small server (a friend group, where that's what people
    /// expect), only mentions and replies on a bigger one. Any choice of the member's wins.
    /// </summary>
    public static string DefaultFor(int people) => people < SmallServer ? All : Mentions;

    /// <summary>
    /// What a member hears about messages in a channel: the channel's level, else the server's, else the default.
    /// Muting (the channel or the server) lowers "all" to mentions: a muted place stays quiet unless you're pinged.
    /// </summary>
    public static string EffectiveLevel(IReadOnlyList<NotifySetting> settings, long channelId, long now, string defaultLevel = Mentions)
    {
        var channel = settings.FirstOrDefault(n => n.ChannelId == channelId);
        var server = settings.FirstOrDefault(n => n.ChannelId == 0);
        var level = channel?.Level ?? server?.Level ?? defaultLevel;
        var muted = (channel is not null && Active(channel, now)) || (server is not null && Active(server, now));
        return muted && level == All ? Mentions : level;
    }

    private static object Set(Session s, Member me, Body body)
    {
        var channelId = body.OptionalLong("channelId", 1) ?? 0;
        if (channelId != 0 && !(s.World.Store.GetChannel(channelId) is { Kind: not "thread" } channel && Permissions.CanRead(me, channel)))
            throw RequestException.NotFound("Channel");

        var current = s.World.Store.NotifySettings(me.AccountKey).FirstOrDefault(n => n.ChannelId == channelId) ?? new NotifySetting(channelId, null, null);
        var next = current;
        if (body.OptionalString("level", 16) is { } level)
        {
            if (level != "default" && !Levels.Contains(level)) throw RequestException.BadRequest("'level' must be all, mentions, none or default.");
            next = next with { Level = level == "default" ? null : level };
        }
        if (body.OptionalLong("muteMinutes", -1, MaxMuteMinutes) is { } minutes)
            next = next with { MutedUntil = minutes switch { 0 => null, -1 => Forever, _ => s.Now + minutes * 60_000 } };
        if (!Active(next, s.Now) && next.MutedUntil is not null) next = next with { MutedUntil = null };

        s.World.Store.SaveNotifySetting(me.AccountKey, next);
        var setting = Public(next, s.Now);
        s.Hub.SendToAccount(me.AccountKey, Frames.Event("notify.updated", new { setting }));
        return new { setting };
    }
}
