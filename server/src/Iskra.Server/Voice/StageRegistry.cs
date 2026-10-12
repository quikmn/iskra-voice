using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

public sealed record StageHand(string AccountKey, long RaisedAt);

/// <summary>
/// Live stage channels: topic, speakers and raised hands. Everyone joins a stage listen-only; speaking is granted
/// (and taken back) by the server through LiveKit's API, so a client can't give itself the right to publish.
/// Speakers and hands only ever include people LiveKit reports in the room.
/// </summary>
public sealed class StageRegistry
{
    public const int MaxTopicLength = 120;
    public const int MaxSpeakers = 16;
    public const int MaxHands = 100;

    private sealed class Stage
    {
        public bool Live;
        public string Topic = "";
        public long StartedAt;
        public string StartedBy = "";
        public readonly List<string> Speakers = [];
        public readonly List<StageHand> Hands = [];
    }

    private readonly Dictionary<long, Stage> _stages = [];
    private readonly Lock _gate = new();
    /// <summary>Permission changes go to LiveKit one at a time, each sending what's true now, so they can't land out of order.</summary>
    private readonly SemaphoreSlim _apply = new(1, 1);
    private readonly World world;
    private readonly Hub hub;
    private readonly IVoiceBackend backend;
    private readonly VoiceRegistry voice;

    public StageRegistry(World world, Hub hub, IVoiceBackend backend, VoiceRegistry voice)
    {
        this.world = world;
        this.hub = hub;
        this.backend = backend;
        this.voice = voice;
    }

    public static bool IsStage(Channel? channel) => channel?.Kind == "stage";

    /// <summary>Admins moderate every stage they can see; admins can also make anyone a moderator of one stage.</summary>
    public bool IsModerator(Member member, Channel channel) =>
        Permissions.CanRead(member, channel) && (Permissions.IsAdmin(member) || world.Store.IsStageModerator(channel.Id, member.AccountKey));

    /// <summary>Who may be brought up to speak: moderators and the channel's writers.</summary>
    public bool MaySpeak(Member member, Channel channel) => IsModerator(member, channel) || Permissions.CanWrite(member, channel);

    public bool InRoom(long channelId, string accountKey) => voice.Participants(channelId).Any(p => p.AccountKey == accountKey);

    public bool IsLive(long channelId)
    {
        lock (_gate) return _stages.TryGetValue(channelId, out var stage) && stage.Live;
    }

    public bool IsSpeaker(long channelId, string accountKey)
    {
        lock (_gate) return _stages.TryGetValue(channelId, out var stage) && stage.Speakers.Contains(accountKey);
    }

    public object PublicState(long channelId)
    {
        lock (_gate)
        {
            _stages.TryGetValue(channelId, out var stage);
            return new
            {
                channelId,
                live = stage?.Live ?? false,
                topic = stage is { Live: true } ? stage.Topic : null,
                startedAt = stage is { Live: true } ? stage.StartedAt : (long?)null,
                startedBy = stage is { Live: true } ? stage.StartedBy : null,
                speakers = stage?.Speakers.ToArray() ?? [],
                hands = stage?.Hands.Select(h => new { accountKey = h.AccountKey, raisedAt = h.RaisedAt }).ToArray() ?? [],
                moderators = world.Store.StageModerators(channelId),
            };
        }
    }

    /// <summary>State of every stage channel this member can see (for the welcome).</summary>
    public List<object> Snapshot(Member member) =>
        world.Store.AllChannels().Where(c => IsStage(c) && Permissions.CanRead(member, c)).Select(c => PublicState(c.Id)).ToList();

    public void Publish(long channelId)
    {
        var channel = world.Store.GetChannel(channelId);
        if (IsStage(channel)) hub.BroadcastToReaders(channel!, Frames.Event("stage.state", PublicState(channelId)));
        voice.Watch.Sync(channelId); // a host who stopped speaking hands the watch party on
    }

    private Stage Get(long channelId) => _stages.TryGetValue(channelId, out var stage) ? stage : _stages[channelId] = new Stage();

    /// <summary>Goes live with a topic. False if it's live already.</summary>
    public bool Start(long channelId, string by, string topic, long now)
    {
        lock (_gate)
        {
            var stage = Get(channelId);
            if (stage.Live) return false;
            stage.Live = true;
            stage.Topic = topic;
            stage.StartedAt = now;
            stage.StartedBy = by;
            stage.Hands.Clear();
        }
        Publish(channelId);
        return true;
    }

    public void SetTopic(long channelId, string topic)
    {
        lock (_gate) Get(channelId).Topic = topic;
        Publish(channelId);
    }

    /// <summary>Takes a stage that couldn't start back down, without sending anyone off.</summary>
    public void Cancel(long channelId)
    {
        lock (_gate) _stages.Remove(channelId);
        Publish(channelId);
    }

    /// <summary>Ends the stage and sends everyone in the room off.</summary>
    public void End(long channelId)
    {
        lock (_gate) _stages.Remove(channelId);
        Publish(channelId);
        foreach (var p in voice.Participants(channelId)) _ = backend.RemoveParticipantAsync(VoiceRegistry.RoomName(channelId), p.AccountKey);
    }

    /// <summary>Raises or lowers a hand. False if the queue is full.</summary>
    public bool SetHand(long channelId, string accountKey, bool raised, long now)
    {
        lock (_gate)
        {
            var stage = Get(channelId);
            var index = stage.Hands.FindIndex(h => h.AccountKey == accountKey);
            if (raised == index >= 0) return true;
            if (raised && stage.Hands.Count >= MaxHands) return false;
            if (raised) stage.Hands.Add(new StageHand(accountKey, now));
            else stage.Hands.RemoveAt(index);
        }
        Publish(channelId);
        return true;
    }

    public bool HasHand(long channelId, string accountKey)
    {
        lock (_gate) return _stages.TryGetValue(channelId, out var stage) && stage.Hands.Any(h => h.AccountKey == accountKey);
    }

    /// <summary>
    /// Brings someone up to speak and tells LiveKit. If LiveKit can't be told, nothing changes and this returns false.
    /// </summary>
    public async Task<bool> AddSpeakerAsync(long channelId, string accountKey)
    {
        lock (_gate)
        {
            var stage = Get(channelId);
            stage.Hands.RemoveAll(h => h.AccountKey == accountKey);
            if (!stage.Speakers.Contains(accountKey))
            {
                if (stage.Speakers.Count >= MaxSpeakers) throw RequestException.BadRequest($"A stage can have up to {MaxSpeakers} speakers.", "stage_speakers_max", new { max = MaxSpeakers });
                stage.Speakers.Add(accountKey);
            }
        }
        Publish(channelId);
        if (await ApplyAsync(channelId, accountKey)) return true;
        lock (_gate) Get(channelId).Speakers.Remove(accountKey);
        Publish(channelId);
        return false;
    }

    /// <summary>Moves someone back to the audience. If LiveKit can't take the right back, they're removed from the room instead.</summary>
    public async Task RemoveSpeakerAsync(long channelId, string accountKey)
    {
        lock (_gate)
        {
            if (!_stages.TryGetValue(channelId, out var stage) || !stage.Speakers.Remove(accountKey)) return;
        }
        Publish(channelId);
        await ApplyAsync(channelId, accountKey);
    }

    /// <summary>Sends LiveKit what the server believes right now. Taking the right away fails closed.</summary>
    private async Task<bool> ApplyAsync(long channelId, string accountKey)
    {
        var room = VoiceRegistry.RoomName(channelId);
        await _apply.WaitAsync();
        try
        {
            var speak = IsSpeaker(channelId, accountKey) && !voice.IsServerMuted(accountKey); // a server mute wins over the stage
            if (await backend.SetCanPublishAsync(room, accountKey, speak)) return true;
            if (!speak) await backend.RemoveParticipantAsync(room, accountKey);
            return false;
        }
        finally
        {
            _apply.Release();
        }
    }

    /// <summary>
    /// After anyone joins or leaves the room, or roles and channels change: drops speakers and hands of people who left
    /// (or may no longer speak), and ends the stage once the room is empty.
    /// </summary>
    public void Sync(long channelId)
    {
        var channel = world.Store.GetChannel(channelId);
        var present = voice.Participants(channelId).Select(p => p.AccountKey).ToHashSet();
        List<string> revoke = [];
        bool changed;
        lock (_gate)
        {
            if (!_stages.TryGetValue(channelId, out var stage)) return;
            if (!IsStage(channel) || present.Count == 0)
            {
                _stages.Remove(channelId);
                changed = true;
            }
            else
            {
                bool Allowed(string key) => present.Contains(key) && world.Store.GetMember(key) is { } m && MaySpeak(m, channel!);
                var gone = stage.Speakers.Where(k => !Allowed(k)).ToList();
                foreach (var key in gone)
                {
                    stage.Speakers.Remove(key);
                    if (present.Contains(key)) revoke.Add(key);
                }
                changed = gone.Count > 0 | stage.Hands.RemoveAll(h => !Allowed(h.AccountKey)) > 0;
            }
        }
        if (changed) Publish(channelId);
        foreach (var key in revoke) _ = ApplyAsync(channelId, key);
    }

    /// <summary>Re-checks every stage (after kicks, bans, role and channel changes).</summary>
    public void SyncAll()
    {
        List<long> ids;
        lock (_gate) ids = [.. _stages.Keys];
        foreach (var id in ids) Sync(id);
    }
}
