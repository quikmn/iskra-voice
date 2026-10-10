using System.Collections.Concurrent;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

public sealed record VoiceMember(string AccountKey, bool Muted, bool Deafened, long JoinedAt);

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

    public VoiceRegistry(World world, Hub hub, IVoiceBackend backend, CallRegistry calls, GroupCallRegistry groupCalls, ILogger<VoiceRegistry> log)
    {
        Calls = calls;
        GroupCalls = groupCalls;
        this.world = world;
        this.hub = hub;
        this.backend = backend;
        this.log = log;
        backend.AvailabilityChanged += available =>
        {
            if (!available) _rooms.Clear(); // LiveKit restarted: everyone was dropped
            hub.Broadcast(Frames.Event("voice.available", new { available }));
        };
    }

    public IVoiceBackend Backend => backend;

    /// <summary>DM calls (rooms named call-…), next to the voice channels.</summary>
    public CallRegistry Calls { get; }

    /// <summary>Group DM calls (rooms named gcall-…).</summary>
    public GroupCallRegistry GroupCalls { get; }

    public static string RoomName(long channelId) => $"voice-{channelId}";

    public static long? ChannelOf(string? room) =>
        room is not null && room.StartsWith("voice-", StringComparison.Ordinal) && long.TryParse(room.AsSpan(6), out var id) ? id : null;

    public IReadOnlyList<VoiceMember> Participants(long channelId) =>
        _rooms.TryGetValue(channelId, out var room) ? room.Values.OrderBy(m => m.JoinedAt).ToList() : [];

    public long? ChannelOfMember(string accountKey) =>
        _rooms.FirstOrDefault(r => r.Value.ContainsKey(accountKey)).Key is var id && id != 0 ? id : null;

    public object PublicState(long channelId) => new
    {
        channelId,
        participants = Participants(channelId).Select(m => new { accountKey = m.AccountKey, muted = m.Muted, deafened = m.Deafened }),
    };

    /// <summary>Voice state for every voice channel this member can see.</summary>
    public List<object> Snapshot(Member member) =>
        world.Store.AllChannels()
            .Where(c => c.Kind == "voice" && Permissions.CanRead(member, c) && Participants(c.Id).Count > 0)
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

    public bool SetFlags(string accountKey, bool muted, bool deafened)
    {
        var channelId = ChannelOfMember(accountKey);
        if (channelId is null || !_rooms.TryGetValue(channelId.Value, out var room) || !room.TryGetValue(accountKey, out var current)) return false;
        room[accountKey] = current with { Muted = muted, Deafened = deafened };
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
                if (channel is not null && member is not null && Permissions.CanRead(member, channel)) continue;
                room.TryRemove(accountKey, out _);
                _ = backend.RemoveParticipantAsync(RoomName(channelId), accountKey);
                Publish(channelId);
            }
        }
    }

    private void Publish(long channelId)
    {
        var channel = world.Store.GetChannel(channelId);
        if (channel is null) return;
        hub.BroadcastToReaders(channel, Frames.Event("voice.state", PublicState(channelId)));
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
                if (member is null || channel is null || !Permissions.CanRead(member, channel))
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
