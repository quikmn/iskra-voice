using System.Security.Cryptography;
using System.Text;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary>One voice/video call between two members. Media is end-to-end encrypted; the server never sees the key.</summary>
public sealed class Call
{
    public required string Id { get; init; }
    public required string Caller { get; init; }
    public required string Callee { get; init; }
    public required bool Video { get; init; }
    public required string Room { get; init; }
    public required long CreatedAt { get; init; }
    /// <summary>The caller's encrypted invite (carries the media key), relayed to the callee and never stored.</summary>
    public required string Envelope { get; init; }
    public string State { get; set; } = "ringing";
    public HashSet<string> InRoom { get; } = [];
    public ITimer? RingTimer { get; set; }

    public bool Involves(string accountKey) => Caller == accountKey || Callee == accountKey;
}

/// <summary>
/// DM calls on this server: ringing, accepting and ending, with events going only to the two people's sessions.
/// Who is in a call's LiveKit room comes from LiveKit's signed webhooks, like voice channels.
/// </summary>
public sealed class CallRegistry
{
    public const int IdLength = 22; // 16 random bytes, base64url
    private readonly object _gate = new();
    private readonly Dictionary<string, Call> _calls = new(StringComparer.Ordinal);
    private readonly World _world;
    private readonly Hub _hub;
    private readonly IVoiceBackend _backend;
    private readonly TimeProvider _time;
    private readonly ILogger<CallRegistry> _log;

    public TimeSpan RingTimeout { get; }

    public CallRegistry(World world, Hub hub, IVoiceBackend backend, TimeProvider time, IConfiguration config, ILogger<CallRegistry> log)
    {
        _world = world;
        _hub = hub;
        _backend = backend;
        _time = time;
        _log = log;
        RingTimeout = TimeSpan.FromMilliseconds(config.GetValue("Calls:RingTimeoutMs", 45_000));
        backend.AvailabilityChanged += available =>
        {
            if (!available) EndAll("ended"); // LiveKit went away: every call dropped
        };
    }

    /// <summary>
    /// The LiveKit room of a call. Derived from both accounts and the call id, and tokens for it are only
    /// ever issued to those two accounts (and joins by anyone else are kicked).
    /// </summary>
    public static string RoomName(string a, string b, string callId)
    {
        var (first, second) = string.CompareOrdinal(a, b) <= 0 ? (a, b) : (b, a);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"iskra/call-room/v1\0{first}\0{second}\0{callId}"));
        return "call-" + Convert.ToHexString(hash, 0, 16).ToLowerInvariant();
    }

    public static bool IsCallRoom(string? room) => room is not null && room.StartsWith("call-", StringComparison.Ordinal);

    public static object Public(Call c) =>
        new { id = c.Id, from = c.Caller, to = c.Callee, video = c.Video, state = c.State, createdAt = c.CreatedAt };

    private static object Ring(Call c) =>
        new { call = Public(c), envelope = System.Text.Json.JsonDocument.Parse(c.Envelope).RootElement.Clone() };

    public Call Start(string caller, string callee, string id, bool video, string envelope)
    {
        Call call;
        List<Call> replaced;
        lock (_gate)
        {
            if (_calls.ContainsKey(id)) throw RequestException.BadRequest("That call id is already in use.");
            if (_calls.Values.Any(c => c.Involves(callee) && !c.Involves(caller)))
                throw new RequestException("busy", "They're in another call.");
            // Starting a call ends whatever call you were in (or a stale one from a closed tab).
            replaced = _calls.Values.Where(c => c.Involves(caller)).ToList();
            foreach (var old in replaced) Remove(old);

            call = new Call
            {
                Id = id, Caller = caller, Callee = callee, Video = video, Envelope = envelope,
                Room = RoomName(caller, callee, id), CreatedAt = _time.GetUtcNow().ToUnixTimeMilliseconds(),
            };
            _calls[id] = call;
            call.RingTimer = _time.CreateTimer(_ => Timeout(id), null, RingTimeout, System.Threading.Timeout.InfiniteTimeSpan);
        }
        foreach (var old in replaced) Ended(old, "ended");
        _hub.SendToAccount(callee, Frames.Event("call.ring", Ring(call)));
        return call;
    }

    /// <summary>A call where <paramref name="accountKey"/> is one of the two people. Anyone else gets "not found".</summary>
    public Call Get(string id, string accountKey)
    {
        lock (_gate)
        {
            return _calls.TryGetValue(id, out var call) && call.Involves(accountKey) ? call : throw RequestException.NotFound("Call");
        }
    }

    public Call Accept(string id, string callee, Session accepting)
    {
        Call call;
        lock (_gate)
        {
            call = Get(id, callee);
            if (call.Callee != callee) throw RequestException.Forbidden("Only the person being called can answer.");
            if (call.State != "ringing") throw RequestException.BadRequest("This call was already answered.");
            call.State = "active";
            call.RingTimer?.Dispose();
            call.RingTimer = null;
        }
        // The caller, and your other devices (so they stop ringing).
        var frame = Frames.Event("call.accepted", new { callId = id });
        foreach (var session in _hub.Sessions.Where(s => s != accepting && (s.AccountKey == call.Caller || s.AccountKey == call.Callee)))
            session.Send(frame);
        return call;
    }

    public void Decline(string id, string callee, string reason)
    {
        Call call;
        lock (_gate)
        {
            call = Get(id, callee);
            if (call.Callee != callee) throw RequestException.Forbidden("Only the person being called can decline.");
            if (call.State != "ringing") throw RequestException.BadRequest("This call was already answered.");
            Remove(call);
        }
        Ended(call, reason);
    }

    public void Hangup(string id, string accountKey)
    {
        Call call;
        lock (_gate)
        {
            call = Get(id, accountKey);
            Remove(call);
        }
        var reason = call.State == "active" ? "ended" : call.Caller == accountKey ? "cancelled" : "declined";
        Ended(call, reason);
    }

    /// <summary>Calls still ringing for you (a device that connects mid-ring can still answer).</summary>
    public List<object> Pending(string accountKey)
    {
        lock (_gate)
        {
            return _calls.Values.Where(c => c.Callee == accountKey && c.State == "ringing").Select(Ring).ToList();
        }
    }

    private void Timeout(string id)
    {
        Call? call;
        lock (_gate)
        {
            if (!_calls.TryGetValue(id, out call) || call.State != "ringing") return;
            Remove(call);
        }
        Ended(call, "no_answer");
    }

    /// <summary>After a kick or ban: calls with someone who is no longer a member end.</summary>
    public void EnforceAccess()
    {
        List<Call> gone;
        lock (_gate)
        {
            gone = _calls.Values.Where(c => _world.Store.GetMember(c.Caller) is null || _world.Store.GetMember(c.Callee) is null).ToList();
            foreach (var call in gone) Remove(call);
        }
        foreach (var call in gone) Ended(call, "ended");
    }

    /// <summary>Ends the calls that match (a block, a timeout).</summary>
    public void EndWhere(Func<Call, bool> match)
    {
        List<Call> gone;
        lock (_gate)
        {
            gone = _calls.Values.Where(match).ToList();
            foreach (var call in gone) Remove(call);
        }
        foreach (var call in gone) Ended(call, "ended");
    }

    private void EndAll(string reason)
    {
        List<Call> all;
        lock (_gate)
        {
            all = [.. _calls.Values];
            foreach (var call in all) Remove(call);
        }
        foreach (var call in all) Ended(call, reason);
    }

    /// <summary>Must hold the lock.</summary>
    private void Remove(Call call)
    {
        _calls.Remove(call.Id);
        call.RingTimer?.Dispose();
        call.RingTimer = null;
    }

    private void Ended(Call call, string reason)
    {
        var frame = Frames.Event("call.ended", new { callId = call.Id, reason });
        _hub.SendToAccount(call.Caller, frame);
        _hub.SendToAccount(call.Callee, frame);
        foreach (var identity in new[] { call.Caller, call.Callee }) _ = _backend.RemoveParticipantAsync(call.Room, identity);
    }

    private void PublishState(Call call)
    {
        string[] participants;
        lock (_gate) participants = [.. call.InRoom];
        var frame = Frames.Event("call.state", new { callId = call.Id, participants });
        _hub.SendToAccount(call.Caller, frame);
        _hub.SendToAccount(call.Callee, frame);
    }

    /// <summary>A verified LiveKit webhook for a call room.</summary>
    public void HandleWebhook(string? type, string room, string? identity)
    {
        Call? call;
        lock (_gate) call = _calls.Values.FirstOrDefault(c => c.Room == room);

        switch (type)
        {
            case "participant_joined" when identity is not null:
                // Only the two people ever get tokens for this room; anyone else (or a call that's over) is removed.
                if (call is null || !call.Involves(identity))
                {
                    _ = _backend.RemoveParticipantAsync(room, identity);
                    return;
                }
                lock (_gate) call.InRoom.Add(identity);
                PublishState(call);
                break;
            case "participant_left" when identity is not null && call is not null && call.Involves(identity):
                bool end;
                lock (_gate)
                {
                    call.InRoom.Remove(identity);
                    // Someone leaving an answered call (or the caller giving up while it rings) ends it.
                    end = (call.State == "active" || identity == call.Caller) && _calls.ContainsKey(call.Id);
                    if (end) Remove(call);
                }
                if (end) Ended(call, call.State == "active" ? "ended" : "cancelled");
                else PublishState(call);
                break;
            case "room_finished" when call is not null:
                lock (_gate)
                {
                    if (!_calls.ContainsKey(call.Id)) return;
                    Remove(call);
                }
                Ended(call, call.State == "active" ? "ended" : "cancelled");
                break;
            default:
                _log.LogDebug("Ignoring LiveKit event {Type} for a call", type);
                break;
        }
    }
}
