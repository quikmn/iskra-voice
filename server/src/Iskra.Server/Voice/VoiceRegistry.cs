using System.Collections.Concurrent;
using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary><see cref="Clips"/>: they have clips (saving the last seconds of the call) turned on, shown to everyone in the call.
/// <see cref="Priority"/>: a priority speaker talking with priority on (others are turned down for listeners).</summary>
public sealed record VoiceMember(string AccountKey, bool Muted, bool Deafened, long JoinedAt, bool Clips = false, bool Priority = false);

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
        Whisper = new WhisperRegistry(world, hub, backend, this, time);
        Recordings = new RecordingRegistry(world, this, log, time);
        _time = time;
        backend.AvailabilityChanged += available =>
        {
            if (!available) Whisper.Clear();
            if (!available) Recordings.Clear(); // every recording mark ends with the calls
            if (!available) _rooms.Clear(); // LiveKit restarted: everyone was dropped
            if (!available) _afkForced.Clear();
            if (!available) Statuses.ClearAll(); // ...and every call's status
            if (!available) Stages.SyncAll(); // ...and every stage ended
            if (!available) Watch.SyncAll(); // ...and every watch party
            if (!available) Features.ActivitiesFeature.SyncAll(hub, world.Store, this); // ...and every activity
            hub.Broadcast(Frames.Event("voice.available", new { available }));
        };
    }

    public IVoiceBackend Backend => backend;

    /// <summary>Stage channels: voice rooms where only invited speakers may publish.</summary>
    public StageRegistry Stages { get; }

    /// <summary>Watch parties: a shared play/pause/position clock per voice channel.</summary>
    public WatchRegistry Watch { get; }

    /// <summary>Whispers: talking only to chosen people or another voice channel, each in its own LiveKit room.</summary>
    public WhisperRegistry Whisper { get; }

    /// <summary>Recording marks and "don't record me" (RecordingFeature).</summary>
    public RecordingRegistry Recordings { get; }

    private readonly TimeProvider _time;

    /// <summary>Voice channel statuses (VoiceStatusFeature): cleared when the call empties.</summary>
    public VoiceStatusBoard Statuses { get; } = new();

    /// <summary>Priority on or off for someone in voice (the caller checked the permission). False if they aren't in voice.</summary>
    public bool SetPriority(string accountKey, bool on)
    {
        if (ChannelOfMember(accountKey) is not { } channelId || !_rooms.TryGetValue(channelId, out var room) || !room.TryGetValue(accountKey, out var current)) return false;
        if (current.Priority == on) return true;
        room[accountKey] = current with { Priority = on };
        Publish(channelId);
        return true;
    }

    /// <summary>After role changes: priority goes off for anyone who is no longer a priority speaker.</summary>
    private void SyncPriority()
    {
        foreach (var (channelId, room) in _rooms)
        {
            var changed = false;
            foreach (var (key, m) in room)
            {
                if (!m.Priority || world.Store.GetMember(key) is { } member && Permissions.Has(member, Perm.PrioritySpeaker)) continue;
                room[key] = m with { Priority = false };
                changed = true;
            }
            if (changed) Publish(channelId);
        }
    }
    /// <summary>Members a moderator muted on this server (kept until unmuted; a restart forgets them).</summary>
    private readonly ConcurrentDictionary<string, byte> _serverMuted = new();

    public bool IsServerMuted(string accountKey) => _serverMuted.ContainsKey(accountKey);

    /// <summary>Server mute: LiveKit stops (or allows again) their publishing, and everyone in the channel sees it.</summary>
    public void SetServerMuted(string accountKey, bool muted, bool canSpeak)
    {
        if (muted) _serverMuted[accountKey] = 0;
        else _serverMuted.TryRemove(accountKey, out _);
        if (ChannelOfMember(accountKey) is not { } channelId) return;
        if (_afkForced.ContainsKey(accountKey))
        {
            Publish(channelId); // the AFK channel's forced mute stays
            return;
        }
        _ = world.Store.IsBot(accountKey)
            ? backend.SetBotCanPublishAsync(RoomName(channelId), accountKey, canPublish: !muted && canSpeak)
            : backend.SetCanPublishAsync(RoomName(channelId), accountKey, canPublish: !muted && canSpeak);
        Publish(channelId);
    }

    /// <summary>
    /// Moves someone to another voice channel (a moderator, or the AFK sweeper with <paramref name="reason"/> "afk"): their
    /// app joins it (even when it's full, for a short while) and they leave the old room.
    /// </summary>
    public void Move(string accountKey, long toChannelId, long now, string? reason = null, int removeAfterMs = 0)
    {
        var move = Interlocked.Increment(ref _moves);
        _lastMove[accountKey] = (move, toChannelId);
        GrantMovePass(accountKey, toChannelId, now + Features.VoiceLimitFeature.MovePassMs);
        hub.SendToAccount(accountKey, Frames.Event("voice.moved", reason is null ? new { channelId = toChannelId } : new { channelId = toChannelId, reason }));
        if (removeAfterMs <= 0 || ChannelOfMember(accountKey) is not { } from)
        {
            Disconnect(accountKey);
            return;
        }
        // Many moves at once (teams): the apps switch rooms themselves, and LiveKit's removal from the old room follows a
        // moment later, so it can't end an app's voice session before the move reaches it.
        Left(from, accountKey);
        _ = RemoveLaterAsync(from, accountKey, removeAfterMs, move);
    }

    /// <summary>Each person's latest move: its number and where to.</summary>
    private readonly ConcurrentDictionary<string, (long Move, long To)> _lastMove = new();
    private long _moves;

    private async Task RemoveLaterAsync(long channelId, string accountKey, int delayMs, long move)
    {
        await Task.Delay(delayMs);
        // Moved back into this channel since (teams: "Bring everyone back" within the delay): their app is on its way in
        // with a new session, which LiveKit's removal by identity would end (before its join webhook makes them a
        // Participant here).
        if (_lastMove.TryGetValue(accountKey, out var last) && last.Move != move && last.To == channelId) return;
        if (Participant(channelId, accountKey) is null) await backend.RemoveParticipantAsync(RoomName(channelId), accountKey);
    }

    // ── AFK channel: muted and deafened by LiveKit ───────────────────────────

    /// <summary>People in the AFK channel who may neither publish nor subscribe right now (what LiveKit was last told).</summary>
    private readonly ConcurrentDictionary<string, byte> _afkForced = new();

    public bool IsAfkForced(string accountKey) => _afkForced.ContainsKey(accountKey);

    /// <summary>After the AFK setting or someone's roles change: tells LiveKit about everyone whose forced state changed.</summary>
    public void SyncAfk()
    {
        var afk = world.Store.Afk();
        foreach (var (channelId, room) in _rooms)
        {
            var changed = false;
            foreach (var accountKey in room.Keys) changed |= ApplyAfk(afk, channelId, accountKey, force: false);
            if (changed) Publish(channelId);
        }
    }

    /// <summary>True if their forced state changed (or <paramref name="force"/>, on joining): LiveKit gets their permissions again.</summary>
    private bool ApplyAfk(Storage.AfkSettings afk, long channelId, string accountKey, bool force)
    {
        if (world.Store.GetMember(accountKey) is not { } member || world.Store.GetChannel(channelId) is not { Kind: "voice" } channel) return false;
        var forced = Features.AfkFeature.IsForced(afk, member, channelId);
        if (!force && forced == _afkForced.ContainsKey(accountKey)) return false;
        if (forced) _afkForced[accountKey] = 0;
        else _afkForced.TryRemove(accountKey, out _);
        var canPublish = !forced && Permissions.CanWrite(member, channel) && !IsServerMuted(accountKey);
        _ = world.Store.IsBot(accountKey)
            ? backend.SetBotCanPublishAsync(RoomName(channelId), accountKey, canPublish)
            : backend.SetPermissionsAsync(RoomName(channelId), accountKey, canPublish, canSubscribe: !forced);
        return true;
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

    /// <summary>People moved to this channel a moment ago whose apps may still be on their way in.</summary>
    public IReadOnlyList<string> MovedInto(long channelId, long now) =>
        _movePasses.Where(p => p.Key.Channel == channelId && p.Value >= now).Select(p => p.Key.Account).ToList();

    public bool HasMovePass(string accountKey, long channelId, long now) =>
        _movePasses.TryGetValue((accountKey, channelId), out var until) && until >= now;

    public static string RoomName(long channelId) => $"voice-{channelId}";

    public static long? ChannelOf(string? room) =>
        room is not null && room.StartsWith("voice-", StringComparison.Ordinal) && long.TryParse(room.AsSpan(6), out var id) ? id : null;

    public VoiceMember? Participant(long channelId, string accountKey) =>
        _rooms.TryGetValue(channelId, out var room) && room.TryGetValue(accountKey, out var member) ? member : null;

    public IReadOnlyList<VoiceMember> Participants(long channelId) =>
        _rooms.TryGetValue(channelId, out var room) ? room.Values.OrderBy(m => m.JoinedAt).ToList() : [];

    /// <summary>How many people are in voice channels right now.</summary>
    public int InVoice => _rooms.Values.Sum(r => r.Count);

    public long? ChannelOfMember(string accountKey) =>
        _rooms.FirstOrDefault(r => r.Value.ContainsKey(accountKey)).Key is var id && id != 0 ? id : null;

    public object PublicState(long channelId) => new
    {
        channelId,
        participants = Participants(channelId).Select(m => new
        {
            accountKey = m.AccountKey, muted = m.Muted, deafened = m.Deafened, serverMuted = _serverMuted.ContainsKey(m.AccountKey), clips = m.Clips,
            afk = _afkForced.ContainsKey(m.AccountKey),
            priority = m.Priority && !m.Muted && !_serverMuted.ContainsKey(m.AccountKey) && !_afkForced.ContainsKey(m.AccountKey),
            noRecord = Recordings.OptedOut(m.AccountKey), recordConsent = Recordings.Consent(channelId, m.AccountKey),
        }),
        status = VoiceStatusBoard.Public(Statuses.Get(channelId)),
        recording = Recordings.Public(channelId),
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
        if (room.IsEmpty) log.Info("voice", "opened", ("chan", channelId));
        room[accountKey] = new VoiceMember(accountKey, false, false, now);
        log.Info("voice", "joined", ("chan", channelId), ("acct", LogIds.Account(world, accountKey)), ("count", room.Count));
        // Into the AFK channel: LiveKit gets the forced state again (the setting may have changed since the token).
        var afk = world.Store.Afk();
        if (afk.ChannelId == channelId) ApplyAfk(afk, channelId, accountKey, force: true);
        else _afkForced.TryRemove(accountKey, out _);
        Publish(channelId);
    }

    public void Left(long channelId, string accountKey)
    {
        if (!_rooms.TryGetValue(channelId, out var room) || !room.TryRemove(accountKey, out var was)) return;
        log.Info("voice", "left", ("chan", channelId), ("acct", LogIds.Account(world, accountKey)), ("dur", TimeSpan.FromMilliseconds(Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - was.JoinedAt))), ("count", room.Count));
        if (room.IsEmpty) log.Info("voice", "closed", ("chan", channelId), ("why", "empty"));
        _afkForced.TryRemove(accountKey, out _);
        Publish(channelId);
    }

    public void RoomFinished(long channelId)
    {
        if (!_rooms.TryRemove(channelId, out _)) return;
        log.Info("voice", "closed", ("chan", channelId), ("why", "room-finished"));
        Publish(channelId);
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
                if (channel is not null && member is not null && Permissions.CanConnect(member, channel)
                    && Features.VoiceBotFeature.MayBeIn(world.Store, member, channel)
                    && Features.E2eeVoiceFeature.MayBeIn(world.Store, member, channel)) continue;
                room.TryRemove(accountKey, out _);
                log.Note("VOI-150", "voice", "removed", ("chan", channelId), ("acct", LogIds.Account(world, accountKey)), ("why", "access"), ("count", room.Count));
                _ = backend.RemoveParticipantAsync(RoomName(channelId), accountKey);
                Publish(channelId);
            }
        }
        SyncAfk();
        SyncPriority();
        Stages.SyncAll();
        Watch.SyncAll();
        Features.ActivitiesFeature.SyncAll(hub, world.Store, this);
        Whisper.Sync();
        Recordings.SyncAll();
    }

    /// <summary>After a timeout: out of every voice channel and call on this server.</summary>
    public void RemoveEverywhere(string accountKey)
    {
        Calls.EndWhere(c => c.Involves(accountKey));
        foreach (var (channelId, room) in _rooms)
        {
            if (!room.TryRemove(accountKey, out _)) continue;
            log.Note("VOI-150", "voice", "removed", ("chan", channelId), ("acct", LogIds.Account(world, accountKey)), ("why", "timeout"), ("count", room.Count));
            _ = backend.RemoveParticipantAsync(RoomName(channelId), accountKey);
            Publish(channelId);
        }
    }

    /// <summary>Sends the channel's voice state again (its status changed).</summary>
    public void Republish(long channelId) => Publish(channelId);

    private void Publish(long channelId)
    {
        if (Participants(channelId).Count == 0) Statuses.Clear(channelId); // the call emptied: its status goes too
        Recordings.Check(channelId, _time.GetUtcNow().ToUnixTimeMilliseconds()); // the recorder left, or everyone agreed
        var channel = world.Store.GetChannel(channelId);
        if (channel is not null) hub.BroadcastToReaders(channel, Frames.Event("voice.state", PublicState(channelId)));
        hub.Outhooks?.VoicePresence(channelId, channel, Participants(channelId).Select(p => p.AccountKey));
        Stages.Sync(channelId);
        Watch.Sync(channelId);
        Features.ActivitiesFeature.Sync(hub, world.Store, this, channelId);
        Whisper.Sync();
        Features.RoomFeature.Sync(world.Store, hub, this, channelId);
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
        if (WhisperRegistry.IsRoom(room))
        {
            Whisper.HandleWebhook(type, room!, identity);
            return;
        }
        if (ChannelOf(room) is not { } channelId) return;

        switch (type)
        {
            case "participant_joined" when identity is not null:
                // A token only works for members who could read the channel when it was issued; re-check anyway.
                // (Nobody stays in a lobby: joining one hands out a token for a room of your own instead.)
                var member = world.Store.GetMember(identity);
                var channel = world.Store.GetChannel(channelId);
                if (member is null || channel is null || !Permissions.CanConnect(member, channel)
                    || !Features.VoiceBotFeature.MayBeIn(world.Store, member, channel)
                    || !Features.E2eeVoiceFeature.MayBeIn(world.Store, member, channel)
                    || Features.ModerationFeature.IsTimedOut(world.Store, identity, now)
                    || Features.RulesFeature.MustAgree(world.Store, member)
                    || !Features.VoiceLimitFeature.HasRoom(world.Store, this, member, channel, now)
                    || Features.RoomFeature.IsLobby(world.Store, channelId)
                    || !Features.RoomFeature.MayEnter(world.Store, this, member, channel, now))
                {
                    log.Note("VOI-150", "voice", "refused", ("chan", channelId), ("acct", LogIds.Account(world, identity)));
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
                log.Debug("voice", "skipped", ("kind", type));
                break;
        }
    }
}
