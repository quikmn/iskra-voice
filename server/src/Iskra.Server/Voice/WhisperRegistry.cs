using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary>
/// One whisper: someone in voice talking only to chosen people (<see cref="People"/>) or to everyone in another voice
/// channel (<see cref="ChannelId"/>). It has its own LiveKit room; only the whisperer may publish there and only the
/// people it reaches right now get tokens to listen, so LiveKit never sends the audio anywhere else.
/// </summary>
public sealed class WhisperSession
{
    public required string Id { get; init; }
    public required string From { get; init; }
    /// <summary>Which of the whisperer's lists (1–3) this is: one whisper per list.</summary>
    public required int Slot { get; init; }
    public long? ChannelId { get; init; }
    public string[] People { get; init; } = [];
    public long StartedAt { get; init; }
    public long LastStart { get; set; }
    /// <summary>Who may be in the room as a listener right now (told with whisper.incoming).</summary>
    public HashSet<string> Invited { get; } = [];
    public string Room => WhisperRegistry.RoomPrefix + Id;

    public bool SameTargets(long? channelId, string[] people) =>
        ChannelId == channelId && People.Length == people.Length && People.All(people.Contains);
}

/// <summary>
/// Whispers (WhisperFeature). Who a whisper reaches is worked out again after every change in voice (joins, leaves,
/// mutes, moves, roles, blocks): people who drop out are removed from its LiveKit room at once, and a whisperer who may
/// no longer whisper has the whole room closed. Kept in memory; LiveKit restarting ends them all.
/// </summary>
public sealed class WhisperRegistry : IDisposable
{
    public const string RoomPrefix = "whisper-";
    public const int MaxPeople = 25;
    public const int MaxSlots = 3;
    /// <summary>Whispers one person can hear at once.</summary>
    public const int MaxIncoming = 8;
    /// <summary>A whisper nobody started again for this long is closed (apps stop their own after 30 s of quiet).</summary>
    public const long IdleMs = 10 * 60_000;

    private readonly Dictionary<string, WhisperSession> _sessions = [];
    private readonly Lock _gate = new();
    private readonly World world;
    private readonly Hub hub;
    private readonly IVoiceBackend backend;
    private readonly VoiceRegistry voice;
    private readonly TimeProvider time;
    private readonly ITimer _sweep;

    public WhisperRegistry(World world, Hub hub, IVoiceBackend backend, VoiceRegistry voice, TimeProvider time)
    {
        this.world = world;
        this.hub = hub;
        this.backend = backend;
        this.voice = voice;
        this.time = time;
        _sweep = time.CreateTimer(_ => Expire(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public static bool IsRoom(string? room) => room is not null && room.StartsWith(RoomPrefix, StringComparison.Ordinal);

    public WhisperSession? Get(string id)
    {
        lock (_gate) return _sessions.GetValueOrDefault(id);
    }

    /// <summary>Whispers someone is sending right now.</summary>
    public List<WhisperSession> From(string accountKey)
    {
        lock (_gate) return _sessions.Values.Where(w => w.From == accountKey).ToList();
    }

    /// <summary>Why this member can't whisper right now (null: they can). Checked on every start and after every change.</summary>
    public RequestException? WhispererProblem(Member me)
    {
        if (world.Store.IsBot(me.AccountKey)) return RequestException.Forbidden("You can't whisper on this server.", "whisper_not_allowed");
        if (!BaseRoles.Allows(me, BaseAbility.Whisper)) return RequestException.Forbidden("You can't whisper on this server.", "whisper_not_allowed");
        if (voice.ChannelOfMember(me.AccountKey) is not { } channelId || world.Store.GetChannel(channelId) is not { } channel)
            return RequestException.BadRequest("Join a voice channel to whisper.", "whisper_not_in_voice");
        if (channel.Kind != "voice") return RequestException.BadRequest("Whisper is off on stages.", "whisper_stage");
        if (Features.E2eeChannelFeature.IsEncrypted(world.Store, channel))
            return RequestException.BadRequest("Whispers aren't end-to-end encrypted, so they're off in encrypted voice channels.", "whisper_e2ee");
        if (voice.IsServerMuted(me.AccountKey) || voice.IsAfkForced(me.AccountKey))
            return RequestException.Forbidden("You're muted by the server, so you can't whisper.", "whisper_muted");
        return null;
    }

    /// <summary>Why this member can't whisper to that channel (null: they can). Speaking there is what it takes.</summary>
    public RequestException? ChannelProblem(Member me, Channel target)
    {
        if (target.Kind == "stage") return RequestException.BadRequest("Whisper is off on stages.", "whisper_stage");
        if (target.Kind != "voice") return RequestException.BadRequest("Whisper to a voice channel.", "whisper_voice_only");
        if (Features.E2eeChannelFeature.IsEncrypted(world.Store, target))
            return RequestException.BadRequest("Whispers aren't end-to-end encrypted, so they're off in encrypted voice channels.", "whisper_e2ee");
        if (!Permissions.CanWrite(me, target)) return RequestException.Forbidden("You can't whisper to that channel.", "whisper_channel");
        return null;
    }

    /// <summary>
    /// Starts a whisper on a list, or freshens the one already on it (same room, targets worked out again). Anything
    /// already on that list with other targets is closed first. The caller has checked the whisperer and the channel.
    /// </summary>
    public (WhisperSession Session, List<string> Reached) Start(Member me, int slot, long? channelId, string[] people)
    {
        var now = Now;
        lock (_gate)
        {
            var current = _sessions.Values.FirstOrDefault(w => w.From == me.AccountKey && w.Slot == slot);
            if (current is not null && !current.SameTargets(channelId, people))
            {
                End(current, notifyFrom: false);
                current = null;
            }
            if (current is null)
            {
                current = new WhisperSession
                {
                    Id = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(12)), From = me.AccountKey, Slot = slot,
                    ChannelId = channelId, People = people, StartedAt = now,
                };
                _sessions[current.Id] = current;
            }
            current.LastStart = now;
            return (current, Refresh(current, me, tell: false));
        }
    }

    /// <summary>The whisperer closes it (or a list changed).</summary>
    public bool Stop(string accountKey, string id)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(id, out var session) || session.From != accountKey) return false;
            End(session, notifyFrom: false);
            return true;
        }
    }

    /// <summary>A listener asking for its token: only while the whisper reaches them.</summary>
    public WhisperSession? Joinable(string id, string accountKey)
    {
        lock (_gate) return _sessions.TryGetValue(id, out var s) && s.Invited.Contains(accountKey) ? s : null;
    }

    /// <summary>After any change in voice, roles or blocks: whisperers who may no longer whisper are stopped, and every reach worked out again.</summary>
    public void Sync()
    {
        lock (_gate)
        {
            if (_sessions.Count == 0) return;
            foreach (var session in _sessions.Values.ToList())
            {
                var from = world.Store.GetMember(session.From);
                if (from is null || WhispererProblem(from) is not null
                    || (session.ChannelId is { } id && (world.Store.GetChannel(id) is not { } target || !Permissions.CanRead(from, target) || ChannelProblem(from, target) is not null)))
                {
                    End(session, notifyFrom: true);
                    continue;
                }
                Refresh(session, from, tell: true);
            }
        }
    }

    /// <summary>LiveKit went away: every whisper room is gone with it.</summary>
    public void Clear()
    {
        lock (_gate)
        {
            foreach (var session in _sessions.Values.ToList()) End(session, notifyFrom: true, closeRoom: false);
        }
    }

    private void Expire()
    {
        var cutoff = Now - IdleMs;
        lock (_gate)
        {
            foreach (var session in _sessions.Values.Where(s => s.LastStart < cutoff).ToList()) End(session, notifyFrom: true);
        }
    }

    /// <summary>Who this whisper reaches right now.</summary>
    private List<string> Reach(WhisperSession session, Member from)
    {
        IEnumerable<string> candidates = session.ChannelId is { } channelId
            ? voice.Participants(channelId).Select(p => p.AccountKey)
            : session.People;
        var reached = new List<string>();
        foreach (var key in candidates.Distinct())
        {
            if (key == from.AccountKey || world.Store.IsBot(key)) continue;
            if (voice.ChannelOfMember(key) is not { } where || world.Store.GetChannel(where) is not { Kind: "voice" } channel) continue;
            // People in channels the whisperer can't see aren't reached (that would tell them who is in there).
            if (!Permissions.CanRead(from, channel) || voice.IsAfkForced(key) || world.Store.EitherBlocked(from.AccountKey, key)) continue;
            if (!session.Invited.Contains(key) && _sessions.Values.Count(s => s.Invited.Contains(key)) >= MaxIncoming) continue;
            reached.Add(key);
        }
        return reached;
    }

    /// <summary>Invites the newly reached, removes those no longer reached. <paramref name="tell"/>: the whisperer hears the new reach.</summary>
    private List<string> Refresh(WhisperSession session, Member from, bool tell)
    {
        var reached = Reach(session, from);
        var gone = session.Invited.Where(k => !reached.Contains(k)).ToList();
        var added = reached.Where(k => !session.Invited.Contains(k)).ToList();
        foreach (var key in gone)
        {
            session.Invited.Remove(key);
            _ = backend.RemoveParticipantAsync(session.Room, key);
            hub.SendToAccount(key, Frames.Event("whisper.ended", new { id = session.Id }));
        }
        foreach (var key in added)
        {
            session.Invited.Add(key);
            hub.SendToAccount(key, Frames.Event("whisper.incoming", new { id = session.Id, from = session.From, channelId = session.ChannelId }));
        }
        if (tell && (gone.Count > 0 || added.Count > 0))
            hub.SendToAccount(session.From, Frames.Event("whisper.reach", new { id = session.Id, reached }));
        return reached;
    }

    private void End(WhisperSession session, bool notifyFrom, bool closeRoom = true)
    {
        _sessions.Remove(session.Id);
        var ended = Frames.Event("whisper.ended", new { id = session.Id });
        foreach (var key in session.Invited) hub.SendToAccount(key, ended);
        if (notifyFrom) hub.SendToAccount(session.From, ended);
        session.Invited.Clear();
        if (closeRoom) _ = backend.DeleteRoomAsync(session.Room);
    }

    /// <summary>A verified LiveKit webhook for a whisper room: anyone the whisper doesn't reach right now is removed.</summary>
    public void HandleWebhook(string? type, string room, string? identity)
    {
        if (type != "participant_joined" || identity is null) return;
        bool allowed;
        lock (_gate)
        {
            var session = _sessions.Values.FirstOrDefault(s => s.Room == room);
            allowed = session is not null && (session.From == identity || session.Invited.Contains(identity));
        }
        if (!allowed) _ = backend.RemoveParticipantAsync(room, identity);
    }

    public void Dispose() => _sweep.Dispose();
}
