using System.Collections.Concurrent;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary>
/// A voice channel being recorded. The recording itself happens on the recorder's desktop app; the server only keeps
/// the mark everyone sees. <see cref="Live"/>: false while an encrypted channel's people are still being asked.
/// </summary>
public sealed class Recording(string by, long startedAt, bool encrypted, long askUntil)
{
    public string By { get; } = by;
    public long StartedAt { get; } = startedAt;
    public bool Encrypted { get; } = encrypted;
    public long AskUntil { get; } = askUntil;
    public bool Live { get; set; }
    public long? LiveAt { get; set; }
    /// <summary>Encrypted channels: each person's answer to "may this call be recorded?" (missing: not asked or not answered yet).</summary>
    public ConcurrentDictionary<string, bool> Answers { get; } = new();
    public ITimer? Timer { get; set; }
}

/// <summary>
/// Which voice channels are being recorded, and who said "don't record me" (Features/RecordingFeature.cs). In memory
/// only, like the rest of voice state: a restart (or LiveKit stopping) ends every call and every recording mark.
/// The state rides on <c>voice.state</c>, so everyone who can see the channel (and anyone who joins later) sees it.
/// </summary>
public sealed class RecordingRegistry(World world, VoiceRegistry voice, Hub hub, ILogger log, TimeProvider time)
{
    /// <summary>The longest recording; the recorder's app stops at the same point.</summary>
    public const long MaxMs = 4 * 60 * 60 * 1000L;
    /// <summary>How long an encrypted channel's people have to agree before the recording is called off.</summary>
    public const long AskMs = 60_000;

    private readonly ConcurrentDictionary<long, Recording> _recordings = new();
    /// <summary>"Don't record me", stored per account (record_optouts) and kept here for voice.state.</summary>
    private readonly ConcurrentDictionary<string, byte> _optedOut = new(world.Store.RecordOptOuts().Select(k => KeyValuePair.Create(k, (byte)0)));
    /// <summary>Whether the app each person last joined voice with shows recording marks (auth <c>features</c>).</summary>
    private readonly ConcurrentDictionary<string, bool> _aware = new();
    private readonly object _gate = new();

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public Recording? Get(long channelId) => _recordings.TryGetValue(channelId, out var r) ? r : null;

    /// <summary>They asked not to be recorded (stored for the account until they change it).</summary>
    public bool OptedOut(string accountKey) => _optedOut.ContainsKey(accountKey);

    /// <summary>True if it changed.</summary>
    public bool SetOptOut(string accountKey, bool optOut)
    {
        lock (_gate)
        {
            var changed = optOut ? _optedOut.TryAdd(accountKey, 0) : _optedOut.TryRemove(accountKey, out _);
            if (changed) world.Store.SetRecordOptOut(accountKey, optOut, Now);
            return changed;
        }
    }

    /// <summary>On voice.join: the app they're joining with shows recording marks (older apps and bots are never recorded).</summary>
    public void SetAware(string accountKey, bool aware) => _aware[accountKey] = aware;

    public bool Aware(string accountKey) => _aware.TryGetValue(accountKey, out var aware) && aware;

    /// <summary>Encrypted recordings only: their answer (null: none yet, or the channel isn't encrypted).</summary>
    public bool? Consent(long channelId, string accountKey) =>
        Get(channelId) is { Encrypted: true } r && r.Answers.TryGetValue(accountKey, out var yes) ? yes : null;

    public object? Public(long channelId) => Get(channelId) is not { } r ? null : new
    {
        by = r.By, startedAt = r.StartedAt, live = r.Live, liveAt = r.LiveAt, encrypted = r.Encrypted,
        askUntil = r.Live ? (long?)null : r.AskUntil,
    };

    /// <summary>Starts the mark (the caller checked the permission). Null if the channel is already being recorded.</summary>
    public Recording? Start(long channelId, string by, bool encrypted)
    {
        var now = Now;
        lock (_gate)
        {
            if (_recordings.ContainsKey(channelId)) return null;
            var r = new Recording(by, now, encrypted, now + AskMs);
            if (encrypted) r.Answers[by] = true; // starting it is the recorder's own yes
            else
            {
                r.Live = true;
                r.LiveAt = now;
            }
            _recordings[channelId] = r;
            Schedule(channelId, r, now);
            log.Info("voice", "record-start", ("chan", channelId), ("acct", LogIds.Account(world, by)), ("mode", encrypted ? "e2ee" : "plain"));
            return r;
        }
    }

    /// <summary>Someone in an encrypted channel answered. A "no" before the recording starts calls it off.</summary>
    public void Answer(long channelId, string accountKey, bool agree)
    {
        lock (_gate)
        {
            if (Get(channelId) is not { Encrypted: true } r) return;
            r.Answers[accountKey] = agree;
            if (!agree && !r.Live) End(channelId, r, "declined");
        }
    }

    /// <summary>Ends it on request (the recorder or someone with the permission). False if there was none.</summary>
    public Recording? Stop(long channelId)
    {
        lock (_gate)
        {
            if (!_recordings.TryRemove(channelId, out var r)) return null;
            r.Timer?.Dispose();
            log.Info("voice", "record-stop", ("chan", channelId), ("dur", TimeSpan.FromMilliseconds(Math.Max(0, Now - r.StartedAt))));
            return r;
        }
    }

    /// <summary>
    /// Before each <c>voice.state</c>: ends a recording that can't go on (the recorder left, lost the permission, the
    /// time ran out, the channel went) and starts an encrypted one once everyone in the call said yes. True if it changed.
    /// </summary>
    public bool Check(long channelId, long now)
    {
        lock (_gate)
        {
            if (Get(channelId) is not { } r) return false;
            var store = world.Store;
            var channel = store.GetChannel(channelId);
            var here = voice.Participants(channelId).Select(p => p.AccountKey).ToList();
            string? why =
                channel is null ? "channel"
                : !here.Contains(r.By) ? "left"
                : store.GetMember(r.By) is not { } recorder || !Permissions.Has(recorder, Perm.RecordVoice) || !Permissions.CanConnect(recorder, channel) ? "permission"
                : Features.E2eeVoiceFeature.IsEncrypted(store, channelId) != r.Encrypted ? "encrypted"
                : now - r.StartedAt >= MaxMs ? "max"
                : !r.Live && now >= r.AskUntil ? "timeout"
                : null;
            if (why is not null)
            {
                End(channelId, r, why);
                return true;
            }
            // Answers belong to this stay in the call: whoever leaves is asked again if they come back.
            foreach (var key in r.Answers.Keys) if (!here.Contains(key)) r.Answers.TryRemove(key, out _);
            if (r.Live || !here.All(k => r.Answers.TryGetValue(k, out var yes) && yes)) return false;
            r.Live = true;
            r.LiveAt = now;
            Schedule(channelId, r, now);
            log.Info("voice", "record-live", ("chan", channelId), ("count", here.Count));
            return true;
        }
    }

    /// <summary>Re-checks every recording (after role or channel changes); sends voice.state where something changed.</summary>
    public void SyncAll()
    {
        var now = Now;
        foreach (var channelId in _recordings.Keys) if (Check(channelId, now)) voice.Republish(channelId);
    }

    /// <summary>For tests and timers: checks every recording as of <paramref name="now"/>.</summary>
    public void Sweep(long now)
    {
        foreach (var channelId in _recordings.Keys) if (Check(channelId, now)) voice.Republish(channelId);
    }

    /// <summary>LiveKit stopped: every call ended, and every recording with it.</summary>
    public void Clear()
    {
        lock (_gate)
        {
            foreach (var (channelId, r) in _recordings) End(channelId, r, "unavailable");
        }
    }

    /// <summary>An end nobody asked for: logged, and in the audit log under the recorder's name (never any content).</summary>
    private void End(long channelId, Recording r, string why)
    {
        if (!_recordings.TryRemove(new KeyValuePair<long, Recording>(channelId, r))) return;
        r.Timer?.Dispose();
        var now = Now;
        log.Note("VOI-180", "voice", "record-end", ("chan", channelId), ("why", why), ("dur", TimeSpan.FromMilliseconds(Math.Max(0, now - r.StartedAt))));
        var store = world.Store;
        var channel = store.GetChannel(channelId);
        if (channel is not null && r.Live && !r.Encrypted) Features.RecordingFeature.PostNotice(store, hub, channel, r.By, "stop", now);
        store.AddAudit(now, "voice.record.stop", r.By, store.GetMember(r.By)?.Name ?? "", null, null, null,
            System.Text.Json.JsonSerializer.Serialize(new { channelId, channelName = channel?.Name, why, durationMs = Math.Max(0, now - r.StartedAt), encrypted = r.Encrypted }, Protocol.Json.Options));
    }

    /// <summary>A timer for the next deadline (the end of asking, or the longest recording).</summary>
    private void Schedule(long channelId, Recording r, long now)
    {
        r.Timer?.Dispose();
        var due = (r.Live ? r.StartedAt + MaxMs : r.AskUntil) - now;
        r.Timer = time.CreateTimer(_ =>
        {
            if (Check(channelId, Now)) voice.Republish(channelId);
        }, null, TimeSpan.FromMilliseconds(Math.Max(0, due) + 50), Timeout.InfiniteTimeSpan);
    }
}
