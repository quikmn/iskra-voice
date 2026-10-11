using System.Collections.Concurrent;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary><see cref="Clips"/>: they have clips (saving the last seconds of the call) turned on, shown to everyone in the call.</summary>
public sealed record VoiceMember(string AccountKey, bool Muted, bool Deafened, long JoinedAt, bool Clips = false);

/// <summary>
/// Who is in which voice channel. Joins and leaves come only from LiveKit's signed webhooks
/// (never from what a client claims); mute/deafen flags are cosmetic and client-reported.
/// </summary>
public sealed class VoiceRegistry
{
    private readonly ConcurrentDictionary<long, ConcurrentDictionary<string, VoiceMember>> _rooms = new();
    private readonly World world;
    private readonly Hub hub;
    private readonly IVoiceBackend backend;
    private readonly ILogger<VoiceRegistry> log;

    public VoiceRegistry(World world, Hub hub, IVoiceBackend backend, CallRegistry calls, GroupCallRegistry groupCalls, ILogger<VoiceRegistry> log, TimeProvider time)
    {
        Calls = calls;
        GroupCalls = groupCalls;
        this.world = world;
        this.hub = hub;
        this.backend = backend;
        this.log = log;
        Stages = new StageRegistry(world, hub, backend, this);
        Watch = new WatchRegistry(world, hub, this, time);
        backend.AvailabilityChanged += available =>
        {
            if (!available) _rooms.Clear(); // LiveKit restarted: everyone was dropped
            if (!available) Stages.SyncAll(); // ...and every stage ended
            if (!available) Watch.SyncAll(); // ...and every watch party
            hub.Broadcast(Frames.Event("voice.available", new { available }));
        };
    }

    public IVoiceBackend Backend => backend;

    /// <summary>Stage channels: voice rooms where only invited speakers may publish.</summary>
    public StageRegistry Stages { get; }

    /// <summary>Watch parties: a shared play/pause/position clock per voice channel.</summary>
    public WatchRegistry Watch { get; }
    /// <summary>Members a moderator muted on this server (kept until unmuted; a restart forgets them).</summary>
    private readonly ConcurrentDictionary<string, byte> _serverMuted = new();

    public bool IsServerMuted(string accountKey) => _serverMuted.ContainsKey(accountKey);

    /// <summary>Server mute: LiveKit stops (or allows again) their publishing, and everyone in the channel sees it.</summary>
    public void SetServerMuted(string accountKey, bool muted, bool canSpeak)
    {
        if (muted) _serverMuted[accountKey] = 0;
        else _serverMuted.TryRemove(accountKey, out _);
        if (ChannelOfMember(accountKey) is not { } channelId) return;
        _ = backend.SetCanPublishAsync(RoomName(channelId), accountKey, canPublish: !muted && canSpeak);
        Publish(channelId);
    }

    /// <summary>Takes someone out of whatever voice channel they're in (a move to another channel).</summary>
    public void Disconnect(string accountKey)
    {
        if (ChannelOfMember(accountKey) is not { } channelId) return;
        _ = backend.RemoveParticipantAsync(RoomName(channelId), accountKey);
        Left(channelId, accountKey);
    }

    /// <summary>DM calls (rooms named call-…), next to the voice channels.</summary>
    public CallRegistry Calls { get; }

    /// <summary>Group DM calls (rooms named gcall-…).</summary>
    public GroupCallRegistry GroupCalls { get; }

    /// <summary>Someone a moderator moved may join that channel for a short while even when it's full.</summary>
    private readonly ConcurrentDictionary<(string Account, long Channel), long> _movePasses = new();

    public void GrantMovePass(string accountKey, long channelId, long until)
    {
        foreach (var (key, expires) in _movePasses) if (expires < until - Features.VoiceLimitFeature.MovePassMs) _movePasses.TryRemove(key, out _);
        _movePasses[(accountKey, channelId)] = until;
    }

    public bool HasMovePass(string accountKey, long channelId, long now) =>
        _movePasses.TryGetValue((accountKey, channelId), out var until) && until >= now;

    public static string RoomName(long channelId) => $"voice-{channelId}";

    public static long? ChannelOf(string? room) =>
        room is not null && room.StartsWith("voice-", StringComparison.Ordinal) && long.TryParse(room.AsSpan(6), out var id) ? id : null;

    public VoiceMember? Participant(long channelId, string accountKey) =>
        _rooms.TryGetValue(channelId, out var room) && room.TryGetValue(accountKey, out var member) ? member : null;

    public IReadOnlyList<VoiceMember> Participants(long channelId) =>
        _rooms.TryGetValue(channelId, out var room) ? room.Values.OrderBy(m => m.JoinedAt).ToList() : [];

    public long? ChannelOfMember(string accountKey) =>
        _rooms.FirstOrDefault(r => r.Value.ContainsKey(accountKey)).Key is var id && id != 0 ? id : null;

    public object PublicState(long channelId) => new
    {
        channelId,
        participants = Participants(channelId).Select(m => new
        {
            accountKey = m.AccountKey, muted = m.Muted, deafened = m.Deafened, serverMuted = _serverMuted.ContainsKey(m.AccountKey), clips = m.Clips,
        }),
    };

    /// <summary>Voice state for every voice channel this member can see.</summary>
    public List<object> Snapshot(Member member) =>
        world.Store.AllChannels()
            .Where(c => c.Kind is "voice" or "stage" && Permissions.CanRead(member, c) && Participants(c.Id).Count > 0)
            .Select(c => PublicState(c.Id))
            .ToList();

    public void Joined(long channelId, string accountKey, long now)
    {
        var room = _rooms.GetOrAdd(channelId, _ => new());
        room[accountKey] = new VoiceMember(accountKey, false, false, now);
        Publish(channelId);
    }

    public void Left(long channelId, string accountKey)
    {
        if (_rooms.TryGetValue(channelId, out var room) && room.TryRemove(accountKey, out _)) Publish(channelId);
    }

    public void RoomFinished(long channelId)
    {
        if (_rooms.TryRemove(channelId, out _)) Publish(channelId);
    }

    public bool SetFlags(string accountKey, bool muted, bool deafened, bool? clips = null)
    {
        var channelId = ChannelOfMember(accountKey);
        if (channelId is null || !_rooms.TryGetValue(channelId.Value, out var room) || !room.TryGetValue(accountKey, out var current)) return false;
        room[accountKey] = current with { Muted = muted, Deafened = deafened, Clips = clips ?? current.Clips };
        Publish(channelId.Value);
        return true;
    }

    /// <summary>After a kick, ban, role change or channel change: drop anyone from rooms they can no longer read.</summary>
    public void EnforceAccess()
    {
        Calls.EnforceAccess();
        GroupCalls.EnforceAccess();
        foreach (var (channelId, room) in _rooms)
        {
            var channel = world.Store.GetChannel(channelId);
            foreach (var accountKey in room.Keys)
            {
                var member = world.Store.GetMember(accountKey);
                if (channel is not null && member is not null && Permissions.CanConnect(member, channel)) continue;
                room.TryRemove(accountKey, out _);
                _ = backend.RemoveParticipantAsync(RoomName(channelId), accountKey);
                Publish(channelId);
            }
        }
        Stages.SyncAll();
        Watch.SyncAll();
    }

    /// <summary>After a timeout: out of every voice channel and call on this server.</summary>
    public void RemoveEverywhere(string accountKey)
    {
        Calls.EndWhere(c => c.Involves(accountKey));
        foreach (var (channelId, room) in _rooms)
        {
            if (!room.TryRemove(accountKey, out _)) continue;
            _ = backend.RemoveParticipantAsync(RoomName(channelId), accountKey);
            Publish(channelId);
        }
    }

    private void Publish(long channelId)
    {
        var channel = world.Store.GetChannel(channelId);
        if (channel is not null) hub.BroadcastToReaders(channel, Frames.Event("voice.state", PublicState(channelId)));
        Stages.Sync(channelId);
        Watch.Sync(channelId);
    }

    /// <summary>Handles a verified LiveKit webhook body.</summary>
    public void HandleWebhook(JsonElement evt, long now)
    {
        var type = evt.TryGetProperty("event", out var e) ? e.GetString() : null;
        var room = evt.TryGetProperty("room", out var r) && r.TryGetProperty("name", out var n) ? n.GetString() : null;
        var identity = evt.TryGetProperty("participant", out var p) && p.TryGetProperty("identity", out var i) ? i.GetString() : null;
        if (CallRegistry.IsCallRoom(room))
        {
            Calls.HandleWebhook(type, room!, identity);
            return;
        }
        if (GroupCallRegistry.IsRoom(room))
        {
            GroupCalls.HandleWebhook(type, room!, identity);
            return;
        }
        if (ChannelOf(room) is not { } channelId) return;

        switch (type)
        {
            case "participant_joined" when identity is not null:
                // A token only works for members who could read the channel when it was issued; re-check anyway.
                var member = world.Store.GetMember(identity);
                var channel = world.Store.GetChannel(channelId);
                if (member is null || channel is null || !Permissions.CanConnect(member, channel)
                    || Features.ModerationFeature.IsTimedOut(world.Store, identity, now)
                    || Features.RulesFeature.MustAgree(world.Store, member)
                    || !Features.VoiceLimitFeature.HasRoom(world.Store, this, member, channel, now))
                {
                    _ = backend.RemoveParticipantAsync(room!, identity);
                    return;
                }
                Joined(channelId, identity, now);
                break;
            case "participant_left" when identity is not null:
                Left(channelId, identity);
                break;
            case "room_finished":
                RoomFinished(channelId);
                break;
            default:
                log.LogDebug("Ignoring LiveKit event {Type}", type);
                break;
        }
    }
}
