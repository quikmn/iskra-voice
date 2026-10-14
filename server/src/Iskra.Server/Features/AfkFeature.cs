using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// The AFK channel. People idle in another voice channel for the set time are moved there (the same way a moderator
/// moves them), and in it everyone is muted and deafened by LiveKit itself, except members with a talk level or role.
/// Idle comes from each session's own report (voice.idle): it only ever affects the person who sends it.
/// </summary>
public static class AfkFeature
{
    public static readonly int[] Minutes = [0, 5, 15, 30, 60];
    public const int MaxTalkRoles = 100;
    public const long MaxIdleMs = 3_600_000;

    public static void Register(Router router)
    {
        router.Add("afk.get", (s, _, _) => new { afk = Public(s.World.Store.Afk()) });
        router.Add("afk.update", Update);
        router.Add("voice.idle", Idle);
    }

    public static object Public(AfkSettings a) => new
    {
        channelId = a.ChannelId,
        idleMinutes = a.IdleMinutes,
        talkLevels = a.TalkLevels,
        talkRoles = a.TalkRoles,
    };

    /// <summary>True if this member is muted and deafened by the server in this channel.</summary>
    public static bool IsForced(AfkSettings afk, Member member, long channelId) =>
        afk.ChannelId == channelId && !afk.TalkLevels.Contains(member.Role) && !member.RoleIds.Any(afk.TalkRoles.Contains);

    public static bool IsForced(Store store, Member member, long channelId) => IsForced(store.Afk(), member, channelId);

    /// <summary>Checks a setting against this server (a template or a request). Throws with the key named in PROTOCOL.md.</summary>
    internal static AfkSettings Validate(Store store, long? channelId, int minutes, string[] levels, long[] roles)
    {
        if (channelId is { } id && store.GetChannel(id) is not { Kind: "voice" })
            throw RequestException.BadRequest("The AFK channel must be a voice channel.", "afk_voice_only");
        if (!Minutes.Contains(minutes))
            throw RequestException.BadRequest("Move idle people after 5, 15, 30 or 60 minutes, or never (0).", "afk_minutes");
        if (levels.Any(l => !Roles.IsValid(l)))
            throw RequestException.BadRequest("Pick base roles from guest, member, trusted, admin and owner.", "afk_levels");
        var existing = store.AllRoles().Select(r => r.Id).ToHashSet();
        if (roles.Length > MaxTalkRoles || roles.Any(r => !existing.Contains(r)))
            throw RequestException.BadRequest("One of those roles doesn't exist.", "afk_roles");
        return new AfkSettings(channelId, minutes, levels.Distinct().ToArray(), roles.Distinct().ToArray());
    }

    private static object Update(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can change the AFK channel.", "admins_afk");
        var store = s.World.Store;
        var old = store.Afk();
        var channelId = body.IsNull("channelId") ? null : body.OptionalLong("channelId") ?? old.ChannelId;
        var minutes = (int?)body.OptionalLong("idleMinutes", 0, int.MaxValue) ?? old.IdleMinutes;
        var levels = body.Has("talkLevels") ? body.OptionalStringArray("talkLevels", Roles.All.Length, 16) : old.TalkLevels;
        var roles = body.OptionalElement("talkRoles") is { } list ? Ids(list) : old.TalkRoles;
        var afk = Validate(store, channelId, minutes, levels, roles);

        store.SaveAfk(afk);
        Audit.Record(s, "afk.update", details: new { channelId = afk.ChannelId, idleMinutes = afk.IdleMinutes });
        s.Hub.Broadcast(Frames.Event("afk", new { afk = Public(afk) }));
        s.Voice.SyncAfk();
        return new { afk = Public(afk) };
    }

    private static long[] Ids(JsonElement list)
    {
        if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > MaxTalkRoles)
            throw RequestException.BadRequest($"'talkRoles' must be a list of up to {MaxTalkRoles} role ids.");
        return list.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id : throw RequestException.BadRequest("'talkRoles' must be a list of role ids."))
            .ToArray();
    }

    /// <summary>This device went idle (no input, not speaking) <c>idleMs</c> ago, or is active again.</summary>
    private static object? Idle(Session s, Member me, Body body)
    {
        var idle = body.OptionalBool("idle") ?? throw RequestException.BadRequest("'idle' is required.");
        var idleMs = body.OptionalLong("idleMs", 0, MaxIdleMs) ?? 0;
        s.VoiceIdleSince = idle ? s.Now - idleMs : null;
        return null;
    }
}

/// <summary>Moves people who have been idle in voice long enough to the AFK channel, every 15 seconds.</summary>
public sealed class AfkSweeper(World world, Hub hub, VoiceRegistry voice, TimeProvider time, ILogger<AfkSweeper> log) : BackgroundService
{
    public const int MaxMovesPerSweep = 20;
    public const long MoveGapMs = 60_000;
    private readonly Dictionary<string, long> _lastMoved = [];

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping))
            {
                try
                {
                    Sweep(time.GetUtcNow().ToUnixTimeMilliseconds());
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogWarning(ex, "Moving idle people to the AFK channel failed");
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Moves everyone who is due; returns how many moved. Tests call it with their own clock.</summary>
    internal int Sweep(long now)
    {
        lock (_lastMoved)
        {
            var store = world.Store;
            var afk = store.Afk();
            if (afk.IdleMinutes <= 0 || afk.ChannelId is not { } afkId || store.GetChannel(afkId) is not { Kind: "voice" } target) return 0;
            var after = afk.IdleMinutes * 60_000L;
            foreach (var (key, at) in _lastMoved.ToList()) if (now - at >= MoveGapMs) _lastMoved.Remove(key);

            var sessions = hub.Sessions.Where(s => s.AccountKey is not null).ToLookup(s => s.AccountKey!);
            var moved = 0;
            foreach (var channel in store.AllChannels().Where(c => c.Kind == "voice" && c.Id != afkId))
            {
                foreach (var person in voice.Participants(channel.Id))
                {
                    if (moved >= MaxMovesPerSweep) return moved;
                    if (_lastMoved.ContainsKey(person.AccountKey) || !IdleFor(sessions[person.AccountKey], now, after)) continue;
                    if (store.IsBot(person.AccountKey) || store.GetMember(person.AccountKey) is not { } member || !Permissions.CanConnect(member, target)) continue;
                    voice.Move(person.AccountKey, target.Id, now, reason: "afk");
                    _lastMoved[person.AccountKey] = now;
                    moved++;
                }
            }
            return moved;
        }
    }

    /// <summary>Every session of the account reports idle, the latest of them for at least <paramref name="after"/> ms.</summary>
    private static bool IdleFor(IEnumerable<Session> sessions, long now, long after)
    {
        long? latest = null;
        foreach (var s in sessions)
        {
            if (s.VoiceIdleSince is not { } since) return false;
            latest = Math.Max(latest ?? since, since);
        }
        return latest is { } l && now - l >= after;
    }
}
