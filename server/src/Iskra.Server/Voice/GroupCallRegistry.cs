using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary>A call in a group DM. Media is end-to-end encrypted with a key that travels in group envelopes; the server never sees it.</summary>
public sealed class GroupCall
{
    public required string Id { get; init; }
    public required string GroupId { get; init; }
    public required string Starter { get; init; }
    public required bool Video { get; init; }
    public required string Room { get; init; }
    public required long CreatedAt { get; init; }
    /// <summary>The newest key envelope (a group envelope carrying the media key), handed to whoever joins. Memory only.</summary>
    public string KeyEnvelope { get; set; } = "{}";
    /// <summary>The group version that envelope was encrypted for. Older than the group's: someone in the call should rekey.</summary>
    public long KeyVersion { get; set; }
    /// <summary>Who LiveKit says is in the room, in the order they joined.</summary>
    public List<string> InRoom { get; } = [];
    /// <summary>Members still being rung.</summary>
    public HashSet<string> Ringing { get; } = [];
    public ITimer? RingTimer { get; set; }
    /// <summary>The starter got a ticket but LiveKit hasn't reported them yet (until they join, leave, or the ringing is over).</summary>
    public bool StarterPending { get; set; } = true;
}

/// <summary>
/// Group calls on this server: one per group at a time, open to the group's current members only (tickets, webhooks and
/// membership changes are all checked against the group). Who is in the room comes from LiveKit's signed webhooks.
/// </summary>
public sealed class GroupCallRegistry
{
    public const string RoomPrefix = "gcall-";
    private readonly Lock _gate = new();
    private readonly Dictionary<string, GroupCall> _calls = new(StringComparer.Ordinal);
    private readonly World _world;
    private readonly Hub _hub;
    private readonly IVoiceBackend _backend;
    private readonly TimeProvider _time;
    private readonly ILogger<GroupCallRegistry> _log;

    public TimeSpan RingTimeout { get; }

    public GroupCallRegistry(World world, Hub hub, IVoiceBackend backend, TimeProvider time, IConfiguration config, ILogger<GroupCallRegistry> log)
    {
        _world = world;
        _hub = hub;
        _backend = backend;
        _time = time;
        _log = log;
        RingTimeout = TimeSpan.FromMilliseconds(config.GetValue("Calls:RingTimeoutMs", 45_000));
        backend.AvailabilityChanged += available =>
        {
            if (!available) EndWhere(_ => true);
        };
    }

    public static string RoomName(string groupId, string callId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"iskra/group-call-room/v1\0{groupId}\0{callId}"));
        return RoomPrefix + Convert.ToHexString(hash, 0, 16).ToLowerInvariant();
    }

    public static bool IsRoom(string? room) => room is not null && room.StartsWith(RoomPrefix, StringComparison.Ordinal);

    /// <summary>Must hold the lock (or own the call).</summary>
    public static object Public(GroupCall c) => new
    {
        id = c.Id, group = c.GroupId, from = c.Starter, video = c.Video, createdAt = c.CreatedAt,
        participants = c.InRoom.ToArray(), keyVersion = c.KeyVersion,
    };

    private object Snapshot(GroupCall c)
    {
        lock (_gate) return Public(c);
    }

    /// <summary>The call with its newest key envelope.</summary>
    public object WithKey(GroupCall c)
    {
        lock (_gate) return new { call = Public(c), envelope = JsonDocument.Parse(c.KeyEnvelope).RootElement.Clone() };
    }

    private string[] MembersOf(GroupCall c) => _world.Store.GetGroup(c.GroupId)?.Members ?? [];

    private bool CanBeIn(GroupCall c, string accountKey) =>
        _world.Store.GetGroup(c.GroupId) is { } g && g.Members.Contains(accountKey) && _world.Store.GetMember(accountKey) is not null;

    private void ToMembers(GroupCall c, string frame)
    {
        foreach (var account in MembersOf(c)) _hub.SendToAccount(account, frame);
    }

    public GroupCall Start(GroupRecord group, string starter, string id, bool video, string envelope)
    {
        GroupCall call;
        lock (_gate)
        {
            if (_calls.ContainsKey(id)) throw RequestException.BadRequest("That call id is already in use.");
            if (_calls.Values.Any(c => c.GroupId == group.Id)) throw new RequestException("busy", "There's already a call in this group. Join it instead.", "group_call_exists");
            call = new GroupCall
            {
                Id = id, GroupId = group.Id, Starter = starter, Video = video, Room = RoomName(group.Id, id),
                CreatedAt = _time.GetUtcNow().ToUnixTimeMilliseconds(), KeyEnvelope = envelope, KeyVersion = group.Version,
            };
            // Members who blocked the starter (or were blocked by them) aren't rung; they can still join from the group.
            foreach (var member in group.Members.Where(m => m != starter && _world.Store.GetMember(m) is not null && !_world.Store.EitherBlocked(m, starter)))
                call.Ringing.Add(member);
            _calls[id] = call;
            call.RingTimer = _time.CreateTimer(_ => RingOver(id), null, RingTimeout, Timeout.InfiniteTimeSpan);
        }
        var ring = Frames.Event("gcall.ring", WithKey(call));
        foreach (var account in call.Ringing) _hub.SendToAccount(account, ring);
        ToMembers(call, Frames.Event("gcall.state", new { call = Snapshot(call) }));
        return call;
    }

    /// <summary>A call in a group <paramref name="accountKey"/> is in right now. Anyone else gets "not found".</summary>
    public GroupCall Get(string id, string accountKey)
    {
        GroupCall? call;
        lock (_gate) _calls.TryGetValue(id, out call);
        return call is not null && CanBeIn(call, accountKey) ? call : throw RequestException.NotFound("Call");
    }

    /// <summary>Joining (or answering): the ticket is issued by the feature; here it only stops the ringing.</summary>
    public GroupCall Join(string id, string accountKey, Session joining)
    {
        var call = Get(id, accountKey);
        bool wasRinging;
        lock (_gate) wasRinging = call.Ringing.Remove(accountKey);
        if (wasRinging) StopRinging(call, accountKey, except: joining);
        return call;
    }

    public void Decline(string id, string accountKey, Session declining)
    {
        var call = Get(id, accountKey);
        bool wasRinging;
        lock (_gate) wasRinging = call.Ringing.Remove(accountKey);
        if (wasRinging) StopRinging(call, accountKey, except: declining);
        EndIfDeserted(call);
    }

    private void StopRinging(GroupCall call, string accountKey, Session? except)
    {
        var frame = Frames.Event("gcall.ring.stopped", new { callId = call.Id });
        foreach (var session in _hub.Sessions.Where(s => s != except && s.AccountKey == accountKey)) session.Send(frame);
    }

    /// <summary>A new media key, from someone in the call, encrypted for the group's current member list.</summary>
    public void Rekey(string id, string accountKey, long version, string envelope)
    {
        var call = Get(id, accountKey);
        var group = _world.Store.GetGroup(call.GroupId)!;
        if (version != group.Version) throw new RequestException("conflict", "The group changed in the meantime. Refresh and try again.", "group_changed");
        lock (_gate)
        {
            if (!call.InRoom.Contains(accountKey) && call.Starter != accountKey)
                throw RequestException.Forbidden("Only someone in the call can change its key.");
            call.KeyEnvelope = envelope;
            call.KeyVersion = version;
        }
        ToMembers(call, Frames.Event("gcall.key", WithKey(call)));
    }

    public void Leave(string id, string accountKey)
    {
        var call = Get(id, accountKey);
        bool left;
        lock (_gate)
        {
            left = call.InRoom.Remove(accountKey);
            if (accountKey == call.Starter) call.StarterPending = false;
        }
        _ = _backend.RemoveParticipantAsync(call.Room, accountKey);
        if (left) Publish(call);
        EndIfDeserted(call);
    }

    /// <summary>Ongoing calls in your groups (with their newest key envelope), so a device that connects can join or still ring.</summary>
    public List<object> ForAccount(string accountKey)
    {
        List<GroupCall> calls;
        lock (_gate) calls = [.. _calls.Values];
        return calls.Where(c => CanBeIn(c, accountKey))
            .Select(c =>
            {
                lock (_gate) return (object)new { call = Public(c), envelope = JsonDocument.Parse(c.KeyEnvelope).RootElement.Clone(), ringing = c.Ringing.Contains(accountKey) };
            }).ToList();
    }

    /// <summary>After a group change: people no longer in the group leave the call right away; a group nobody is in ends it.</summary>
    public void MembershipChanged(GroupRecord group)
    {
        GroupCall? call;
        List<string> gone;
        lock (_gate)
        {
            call = _calls.Values.FirstOrDefault(c => c.GroupId == group.Id);
            if (call is null) return;
            gone = call.InRoom.Where(k => !group.Members.Contains(k)).ToList();
            call.InRoom.RemoveAll(gone.Contains);
            call.Ringing.RemoveWhere(k => !group.Members.Contains(k));
        }
        foreach (var account in gone) _ = _backend.RemoveParticipantAsync(call.Room, account);
        if (group.Members.Length == 0)
        {
            EndWhere(c => c == call);
            return;
        }
        Publish(call); // keyVersion is now behind the group's, which tells the people in the call to rekey
        EndIfDeserted(call);
    }

    /// <summary>After a kick or ban: people who are no longer members of this server leave group calls.</summary>
    public void EnforceAccess()
    {
        List<GroupCall> calls;
        lock (_gate) calls = [.. _calls.Values];
        foreach (var call in calls)
        {
            List<string> gone;
            lock (_gate)
            {
                gone = call.InRoom.Where(k => !CanBeIn(call, k)).ToList();
                call.InRoom.RemoveAll(gone.Contains);
            }
            if (gone.Count == 0) continue;
            foreach (var account in gone) _ = _backend.RemoveParticipantAsync(call.Room, account);
            Publish(call);
            EndIfDeserted(call);
        }
    }

    private void RingOver(string id)
    {
        GroupCall? call;
        List<string> unanswered;
        lock (_gate)
        {
            if (!_calls.TryGetValue(id, out call)) return;
            unanswered = [.. call.Ringing];
            call.Ringing.Clear();
            call.StarterPending = false;
            call.RingTimer?.Dispose();
            call.RingTimer = null;
        }
        foreach (var account in unanswered) StopRinging(call, account, except: null);
        EndIfDeserted(call);
    }

    /// <summary>A call with nobody in the room and nobody left to ring is over.</summary>
    private void EndIfDeserted(GroupCall call)
    {
        lock (_gate)
        {
            if (call.InRoom.Count > 0 || call.Ringing.Count > 0 || call.StarterPending) return;
        }
        EndWhere(c => c == call);
    }

    private void EndWhere(Func<GroupCall, bool> which)
    {
        List<GroupCall> ended;
        lock (_gate)
        {
            ended = _calls.Values.Where(which).ToList();
            foreach (var call in ended)
            {
                _calls.Remove(call.Id);
                call.RingTimer?.Dispose();
                call.RingTimer = null;
            }
        }
        foreach (var call in ended)
        {
            ToMembers(call, Frames.Event("gcall.ended", new { callId = call.Id, group = call.GroupId }));
            string[] inRoom;
            lock (_gate) inRoom = [.. call.InRoom];
            foreach (var account in inRoom) _ = _backend.RemoveParticipantAsync(call.Room, account);
        }
    }

    private void Publish(GroupCall call) => ToMembers(call, Frames.Event("gcall.state", new { call = Snapshot(call) }));

    /// <summary>A verified LiveKit webhook for a group call room.</summary>
    public void HandleWebhook(string? type, string room, string? identity)
    {
        GroupCall? call;
        lock (_gate) call = _calls.Values.FirstOrDefault(c => c.Room == room);

        switch (type)
        {
            case "participant_joined" when identity is not null:
                // Only current group members get tickets; anyone else (or anyone in a call that's over) is removed.
                if (call is null || !CanBeIn(call, identity))
                {
                    _ = _backend.RemoveParticipantAsync(room, identity);
                    return;
                }
                bool wasRinging;
                lock (_gate)
                {
                    if (!call.InRoom.Contains(identity)) call.InRoom.Add(identity);
                    if (identity == call.Starter) call.StarterPending = false;
                    wasRinging = call.Ringing.Remove(identity);
                }
                if (wasRinging) StopRinging(call, identity, except: null);
                Publish(call);
                break;
            case "participant_left" when identity is not null && call is not null:
                bool removed;
                lock (_gate) removed = call.InRoom.Remove(identity);
                if (removed) Publish(call);
                EndIfDeserted(call);
                break;
            case "room_finished" when call is not null:
                EndWhere(c => c == call);
                break;
            default:
                _log.Debug("call", "skipped", ("kind", type));
                break;
        }
    }
}
