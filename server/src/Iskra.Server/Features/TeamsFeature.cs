using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Team splits for game nights: someone who can move members splits a voice channel into 2–8 teams. The server makes a
/// temporary voice channel per team (with the voice channel's permissions), moves everyone there, brings them back on
/// request, and deletes team channels once they've been empty for a while. The app decides who goes where.
/// </summary>
public static class TeamsFeature
{
    public const int MinTeams = 2;
    public const int MaxTeams = 8;
    public const int MaxPerTeam = 50;
    public const int MaxSplits = 10;
    public const int MaxGame = 50;
    public const long EmptyMs = 5 * 60_000;
    /// <summary>How long a moved app has to leave its old room by itself before LiveKit removes it.</summary>
    public const int RemoveAfterMs = 3_000;

    public static void Register(Router router)
    {
        router.Add("teams.start", Start);
        router.Add("teams.end", End);
        router.Add("teams.list", (s, me, _) => new { splits = Visible(s.World.Store, me) });
    }

    public static object View(Store store, TeamSplit split) => new
    {
        id = split.Id,
        channelId = split.ChannelId,
        game = split.Game,
        createdBy = split.CreatedBy,
        createdAt = split.CreatedAt,
        teams = store.TeamChannels(split.Id).Select(t => new { name = t.Name, channelId = t.ChannelId }),
    };

    /// <summary>Splits whose voice channel the member can see.</summary>
    private static List<object> Visible(Store store, Member me) =>
        store.TeamSplits()
            .Where(split => store.GetChannel(split.ChannelId) is { } channel && Permissions.CanRead(me, channel))
            .Select(split => View(store, split)).ToList();

    private static void RequireMover(Member me)
    {
        if (!Permissions.Has(me, Perm.MoveMembers)) throw RequestException.Forbidden("You can't move members on this server.", "teams_move");
    }

    private static object Start(Session s, Member me, Body body)
    {
        RequireMover(me);
        var store = s.World.Store;
        var channel = store.GetChannel(body.Long("channelId"));
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
        if (channel.Kind != "voice") throw RequestException.BadRequest("Teams can only be made from a voice channel.", "teams_voice_only");
        if (store.TeamSplitOf(channel.Id) is not null) throw RequestException.BadRequest("That's a team channel already. Start from the main voice channel.", "teams_nested");
        if (E2eeChannelFeature.IsEncrypted(store, channel))
            throw RequestException.BadRequest("Teams can't be made from an encrypted voice channel.", "teams_encrypted");

        var teams = Teams(body.Element("teams"));
        var names = body.OptionalStringArray("names", MaxTeams, 256);
        if (names.Length > 0 && names.Length != teams.Count) throw RequestException.BadRequest("'names' must have one name per team.");
        var channelNames = teams.Select((_, i) => ChannelFeature.ChannelName(names.Length > 0 ? names[i] : $"team-{i + 1}")).ToList();
        var game = body.OptionalString("game", MaxGame * 2) is { } rawGame
            ? Text.Normalize(rawGame, MaxGame, allowNewlines: false) ?? throw RequestException.BadRequest($"The game's name must be 1–{MaxGame} characters.", "teams_game", new { max = MaxGame })
            : null;

        // Everyone listed is here now, once, a person, and someone you may move.
        var here = s.Voice.Participants(channel.Id).Select(p => p.AccountKey).ToHashSet();
        var seen = new HashSet<string>();
        foreach (var key in teams.SelectMany(t => t))
        {
            var target = store.GetMember(key) ?? throw RequestException.NotFound("Member");
            var name = store.DisplayName(target);
            if (!seen.Add(key)) throw RequestException.BadRequest($"{name} is in two teams.", "teams_twice", new { name });
            if (store.IsBot(key)) throw RequestException.BadRequest($"{name} is a bot. Bots stay where they are.", "teams_bot", new { name });
            if (!here.Contains(key)) throw RequestException.BadRequest($"{name} isn't in the voice channel any more.", "teams_not_here", new { name });
            if (key != me.AccountKey && !Permissions.Outranks(me, target))
                throw RequestException.Forbidden("You can only manage members ranked below you.", "rank_members");
        }
        if (store.TeamSplits() is var splits && splits.Any(sp => sp.ChannelId == channel.Id))
            throw RequestException.BadRequest("This voice channel is split into teams already. Bring everyone back first.", "teams_active");
        if (splits.Count >= MaxSplits)
            throw RequestException.BadRequest($"A server can have up to {MaxSplits} team splits at once.", "teams_max", new { max = MaxSplits });
        if (!s.TryTakeLimit("teams.created")) throw new RequestException("rate_limited", "Slow down a little.");

        // One voice channel per team, right after the voice channel, with its permissions.
        var hifi = store.IsHifi(channel.Id);
        var ordered = store.AllChannels();
        var at = ordered.FindIndex(c => c.Id == channel.Id);
        var anchor = ordered.Skip(at + 1).FirstOrDefault(c => c.CategoryId == channel.CategoryId)?.Id;
        var created = new List<long>();
        foreach (var name in channelNames)
        {
            var team = store.CreateChannel(name, "voice", channel.ReadRole, channel.WriteRole, s.Now);
            foreach (var o in channel.Overrides) store.SetOverride(team.Id, o.RoleId, o.Allow, o.Deny);
            if (hifi) store.SetHifi(team.Id, true);
            store.MoveChannel(team.Id, channel.CategoryId, anchor);
            created.Add(team.Id);
        }
        var split = store.AddTeamSplit(channel.Id, game, me.AccountKey, created, s.Now);
        Audit.Record(s, "teams.start", details: new { channelId = channel.Id, name = channel.Name, teams = teams.Count, people = seen.Count });
        ChannelFeature.BroadcastChannels(s);

        for (var i = 0; i < teams.Count; i++)
            foreach (var key in teams[i])
                s.Voice.Move(key, created[i], s.Now, reason: "teams", removeAfterMs: RemoveAfterMs);

        var view = View(store, split);
        s.Hub.BroadcastToReaders(channel, Frames.Event("teams.split", new { split = view }));
        return new { split = view };
    }

    private static List<string[]> Teams(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest("'teams' must be a list of teams.");
        var count = element.GetArrayLength();
        if (count < MinTeams || count > MaxTeams)
            throw RequestException.BadRequest($"Make {MinTeams}–{MaxTeams} teams.", "teams_count", new { min = MinTeams, max = MaxTeams });
        var teams = new List<string[]>();
        foreach (var team in element.EnumerateArray())
        {
            if (team.ValueKind != JsonValueKind.Array) throw RequestException.BadRequest("Each team must be a list of account keys.");
            if (team.GetArrayLength() is 0 or > MaxPerTeam)
                throw RequestException.BadRequest($"Each team needs 1–{MaxPerTeam} people.", "teams_size", new { max = MaxPerTeam });
            teams.Add(team.EnumerateArray()
                .Select(k => k.ValueKind == JsonValueKind.String && k.GetString() is { Length: > 0 and <= 64 } key ? key : throw RequestException.BadRequest("Each team must be a list of account keys."))
                .ToArray());
        }
        return teams;
    }

    /// <summary>Bring everyone back: moves the people you may move back to the voice channel, then deletes empty team channels.</summary>
    private static object End(Session s, Member me, Body body)
    {
        RequireMover(me);
        var store = s.World.Store;
        var split = store.GetTeamSplit(body.Long("id")) ?? throw RequestException.NotFound("Teams");
        var origin = store.GetChannel(split.ChannelId);
        var teamChannels = store.TeamChannels(split.Id);
        // Seeing the split means seeing its voice channel (or, once that's gone, one of its team channels).
        var visible = origin is not null
            ? Permissions.CanRead(me, origin)
            : teamChannels.Any(t => store.GetChannel(t.ChannelId) is { } c && Permissions.CanRead(me, c));
        if (!visible) throw RequestException.NotFound("Teams");

        var moved = 0;
        if (origin is not null)
        {
            // Everyone in a team channel, and anyone moved there a moment ago whose app is still joining.
            var people = teamChannels
                .SelectMany(team => s.Voice.Participants(team.ChannelId).Select(p => p.AccountKey)
                    .Concat(s.Voice.MovedInto(team.ChannelId, s.Now).Where(k => s.Voice.ChannelOfMember(k) is null)))
                .Distinct().ToList();
            foreach (var key in people)
            {
                if (store.GetMember(key) is not { } target) continue;
                if (key != me.AccountKey && !Permissions.Outranks(me, target)) continue;
                if (!Permissions.CanConnect(target, origin)) continue;
                s.Voice.Move(key, origin.Id, s.Now, reason: "teams", removeAfterMs: RemoveAfterMs);
                moved++;
            }
        }
        Audit.Record(s, "teams.end", details: new { channelId = split.ChannelId, name = origin?.Name, moved });
        var deleted = teamChannels.Count(team => s.Voice.Participants(team.ChannelId).Count == 0 && DeleteChannel(store, team.ChannelId));
        if (deleted > 0) BroadcastChannels(s.Hub);
        Settle(store, s.Hub, split, changed: deleted > 0);
        return new { moved };
    }

    // ── Cleanup (also used by TeamSweeper) ───────────────────────────────────

    internal static bool DeleteChannel(Store store, long channelId)
    {
        if (store.GetChannel(channelId) is null) return false;
        store.DeleteChannel(channelId); // its team_channels row goes with it
        return true;
    }

    /// <summary>Everyone gets their own channel list (without a session to hand).</summary>
    internal static void BroadcastChannels(Hub hub)
    {
        foreach (var session in hub.Sessions)
            if (session.CurrentMember() is { } member) session.Send(hub.ChannelsEvent(member));
    }

    /// <summary>After team channels went: ends a split with none left, or tells its readers what's left.</summary>
    internal static void Settle(Store store, Hub hub, TeamSplit split, bool changed)
    {
        if (store.TeamChannels(split.Id).Count == 0)
        {
            store.DeleteTeamSplit(split.Id);
            hub.Broadcast(Frames.Event("teams.ended", new { id = split.Id }));
        }
        else if (changed && store.GetChannel(split.ChannelId) is { } origin)
            hub.BroadcastToReaders(origin, Frames.Event("teams.split", new { split = View(store, split) }));
    }
}

/// <summary>Deletes team channels that have been empty for five minutes, every 30 seconds; ends splits with none left.</summary>
public sealed class TeamSweeper(World world, Hub hub, VoiceRegistry voice, TimeProvider time, ILogger<TeamSweeper> log) : BackgroundService
{
    private readonly long _startedAt = time.GetUtcNow().ToUnixTimeMilliseconds();
    private readonly Dictionary<long, long> _busyAt = [];

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30), time);
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
                    log.Warn(ex, "SCH-110", "sched", "failed", ("what", "teams"));
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Deletes what's due; returns how many team channels went. Tests call it with their own clock.</summary>
    internal int Sweep(long now)
    {
        lock (_busyAt)
        {
            var store = world.Store;
            var deleted = 0;
            var live = new HashSet<long>();
            foreach (var split in store.TeamSplits())
            {
                var gone = 0;
                foreach (var team in store.TeamChannels(split.Id))
                {
                    live.Add(team.ChannelId);
                    if (voice.Participants(team.ChannelId).Count > 0)
                    {
                        _busyAt[team.ChannelId] = now;
                        continue;
                    }
                    var since = Math.Max(_busyAt.GetValueOrDefault(team.ChannelId, team.CreatedAt), _startedAt);
                    if (now - since < TeamsFeature.EmptyMs || !TeamsFeature.DeleteChannel(store, team.ChannelId)) continue;
                    gone++;
                }
                deleted += gone;
                // Also ends splits whose last channel an admin deleted by hand.
                TeamsFeature.Settle(store, hub, split, changed: gone > 0);
            }
            foreach (var id in _busyAt.Keys.Where(id => !live.Contains(id)).ToList()) _busyAt.Remove(id);
            if (deleted > 0) TeamsFeature.BroadcastChannels(hub);
            return deleted;
        }
    }
}
