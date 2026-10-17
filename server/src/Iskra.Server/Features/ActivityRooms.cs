using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>A message an activity sent, kept (in memory) until the next snapshot covers it.</summary>
internal sealed record ActivityMessage(long Seq, string From, JsonElement Data, int Bytes);

/// <summary>One running activity in a voice channel. Everything here lives in memory and goes with the session.</summary>
internal sealed class ActivityRun(string id, long channelId, string activity, string? name, string startedBy, long startedAt)
{
    public string Id { get; } = id;
    public long ChannelId { get; } = channelId;
    public string Activity { get; } = activity;
    public string? Name { get; } = name;
    public string StartedBy { get; } = startedBy;
    public long StartedAt { get; } = startedAt;
    /// <summary>Makes each player's id inside the activity: stable for the session, never the account key.</summary>
    public byte[] Secret { get; } = RandomNumberGenerator.GetBytes(32);
    /// <summary>Accounts playing, in the order they joined.</summary>
    public List<string> Players { get; } = [];
    /// <summary>The connections that joined, and whose they are.</summary>
    public Dictionary<Session, string> Connections { get; } = [];
    public long Seq { get; set; }
    public JsonElement? State { get; set; }
    public long StateSeq { get; set; }
    public LinkedList<ActivityMessage> Buffer { get; } = new();
    public long BufferBytes { get; set; }
    /// <summary>The newest message that went from the buffer before a snapshot covered it.</summary>
    public long DroppedUpTo { get; set; }
    public bool Missed => DroppedUpTo > StateSeq;

    public string PlayerId(string accountKey) => Ed25519.ToB64u(HMACSHA256.HashData(Secret, Encoding.UTF8.GetBytes(accountKey))[..9]);
}

/// <summary>
/// Running activities, one per voice channel (ActivitiesFeature has the rules). One lock for all of them: a message's
/// seq, keeping it and relaying it happen together, so every player gets the same order.
/// </summary>
public sealed class ActivityRooms
{
    public const int MaxBuffered = 300;
    public const int MaxBufferedBytes = 256 * 1024;

    private readonly Dictionary<long, ActivityRun> _runs = [];
    private readonly Lock _gate = new();

    internal static object View(ActivityRun r) => new
    {
        id = r.Id,
        channelId = r.ChannelId,
        activity = r.Activity,
        name = r.Name,
        startedBy = r.StartedBy,
        startedAt = r.StartedAt,
        players = r.Players.Select(k => new { id = r.PlayerId(k), accountKey = k }),
    };

    private static void Publish(Hub hub, Store store, long channelId, ActivityRun? run)
    {
        if (store.GetChannel(channelId) is not { } channel) return;
        hub.BroadcastToReaders(channel, Frames.Event("act.session", new { channelId, session = run is null ? null : View(run) }));
    }

    /// <summary>Running sessions in channels this member can read (for the welcome).</summary>
    public List<object> Snapshot(Store store, Member member)
    {
        lock (_gate)
            return _runs.Values.Where(r => store.GetChannel(r.ChannelId) is { } c && Permissions.CanRead(member, c)).Select(View).ToList();
    }

    public List<(long ChannelId, string Activity)> Running()
    {
        lock (_gate) return _runs.Values.Select(r => (r.ChannelId, r.Activity)).ToList();
    }

    internal object? Start(Hub hub, Store store, Session session, string accountKey, long channelId, string activity, string? name, string id, long now)
    {
        lock (_gate)
        {
            if (_runs.ContainsKey(channelId)) throw RequestException.BadRequest("An activity is already running here.", "act_running");
            var run = new ActivityRun(id, channelId, activity, name, accountKey, now);
            run.Players.Add(accountKey);
            run.Connections[session] = accountKey;
            _runs[channelId] = run;
            Publish(hub, store, channelId, run);
            return View(run);
        }
    }

    /// <summary>The run if it's the one named (a late request can't reach a newer session).</summary>
    private ActivityRun Current(long channelId, string sessionId) =>
        _runs.TryGetValue(channelId, out var run) && run.Id == sessionId ? run : throw RequestException.NotFound("Activity");

    private static ActivityRun Joined(ActivityRun run, Session session) =>
        run.Connections.ContainsKey(session) ? run : throw RequestException.BadRequest("Join the activity first.", "act_join_first");

    internal object Join(Hub hub, Store store, Session session, string accountKey, long channelId, string sessionId, int maxPlayers)
    {
        lock (_gate)
        {
            var run = Current(channelId, sessionId);
            if (!run.Players.Contains(accountKey))
            {
                if (run.Players.Count >= maxPlayers)
                    throw RequestException.BadRequest($"Up to {maxPlayers} people can be in an activity.", "act_full", new { max = maxPlayers });
                run.Players.Add(accountKey);
                Publish(hub, store, channelId, run);
            }
            run.Connections[session] = accountKey;
            return new
            {
                session = View(run),
                me = run.PlayerId(accountKey),
                seq = run.Seq,
                state = run.State,
                stateSeq = run.StateSeq,
                messages = run.Buffer.Select(m => new { seq = m.Seq, from = m.From, data = m.Data }),
                missed = run.Missed,
            };
        }
    }

    /// <summary>This connection leaves (the account stops playing once none of its connections are in it).</summary>
    internal void Leave(Hub hub, Store store, Session session, long channelId, string? sessionId)
    {
        lock (_gate)
        {
            if (!_runs.TryGetValue(channelId, out var run) || (sessionId is not null && run.Id != sessionId)) return;
            if (!run.Connections.Remove(session, out var accountKey)) return;
            DropIfGone(hub, store, run, accountKey);
        }
    }

    private void DropIfGone(Hub hub, Store store, ActivityRun run, string accountKey)
    {
        if (run.Connections.ContainsValue(accountKey) || !run.Players.Remove(accountKey)) return;
        if (run.Players.Count == 0)
        {
            _runs.Remove(run.ChannelId);
            Publish(hub, store, run.ChannelId, null);
        }
        else Publish(hub, store, run.ChannelId, run);
    }

    /// <summary>A closed connection leaves every activity it joined.</summary>
    public void Disconnected(Hub hub, Store store, Session session)
    {
        lock (_gate)
            foreach (var run in _runs.Values.Where(r => r.Connections.ContainsKey(session)).ToList())
            {
                var accountKey = run.Connections[session];
                run.Connections.Remove(session);
                DropIfGone(hub, store, run, accountKey);
            }
    }

    internal long Send(Session session, long channelId, string sessionId, JsonElement data, int bytes)
    {
        lock (_gate)
        {
            var run = Joined(Current(channelId, sessionId), session);
            var message = new ActivityMessage(++run.Seq, run.PlayerId(run.Connections[session]), data, bytes);
            run.Buffer.AddLast(message);
            run.BufferBytes += bytes;
            while (run.Buffer.Count > MaxBuffered || run.BufferBytes > MaxBufferedBytes)
            {
                run.BufferBytes -= run.Buffer.First!.Value.Bytes;
                run.DroppedUpTo = run.Buffer.First.Value.Seq;
                run.Buffer.RemoveFirst();
            }
            var frame = Frames.Event("act.msg", new { channelId, sessionId, seq = message.Seq, from = message.From, data });
            foreach (var connection in run.Connections.Keys) connection.Send(frame);
            return message.Seq;
        }
    }

    internal void SetState(Session session, long channelId, string sessionId, long seq, JsonElement state)
    {
        lock (_gate)
        {
            var run = Joined(Current(channelId, sessionId), session);
            if (seq > run.Seq) throw RequestException.BadRequest("That message hasn't been sent yet.", "act_seq");
            if (seq < run.StateSeq) return; // an older snapshot
            run.State = state;
            run.StateSeq = seq;
            while (run.Buffer.First is { } first && first.Value.Seq <= seq)
            {
                run.BufferBytes -= first.Value.Bytes;
                run.Buffer.RemoveFirst();
            }
        }
    }

    internal (string StartedBy, IReadOnlyCollection<string> Players)? Info(long channelId, string sessionId)
    {
        lock (_gate)
            return _runs.TryGetValue(channelId, out var run) && run.Id == sessionId ? (run.StartedBy, run.Players.ToList()) : null;
    }

    internal bool IsPlayer(Session session, long channelId, string sessionId)
    {
        lock (_gate) return _runs.TryGetValue(channelId, out var run) && run.Id == sessionId && run.Connections.ContainsKey(session);
    }

    public void End(Hub hub, Store store, long channelId, string? sessionId = null)
    {
        lock (_gate)
        {
            if (!_runs.TryGetValue(channelId, out var run) || (sessionId is not null && run.Id != sessionId)) return;
            _runs.Remove(channelId);
            Publish(hub, store, channelId, null);
        }
    }

    /// <summary>
    /// After people join or leave the call, or rules change: players must still be in the call and able to read the
    /// channel, and the activity allowed there; otherwise it ends. <paramref name="inRoom"/> lists who is in the call.
    /// </summary>
    internal void Sync(Hub hub, Store store, long channelId, IReadOnlyCollection<string> inRoom, Func<Channel, ActivityRun, bool> allowed)
    {
        lock (_gate)
        {
            if (!_runs.TryGetValue(channelId, out var run)) return;
            var channel = store.GetChannel(channelId);
            if (channel is null || !allowed(channel, run))
            {
                _runs.Remove(channelId);
                Publish(hub, store, channelId, null);
                return;
            }
            var members = store.GetMembers(run.Players.ToList());
            foreach (var key in run.Players.ToList())
            {
                if (inRoom.Contains(key) && members.TryGetValue(key, out var m) && Permissions.CanRead(m, channel)) continue;
                foreach (var connection in run.Connections.Where(c => c.Value == key).Select(c => c.Key).ToList()) run.Connections.Remove(connection);
                DropIfGone(hub, store, run, key);
                if (!_runs.ContainsKey(channelId)) return;
            }
        }
    }

    public List<long> Channels()
    {
        lock (_gate) return [.. _runs.Keys];
    }
}
