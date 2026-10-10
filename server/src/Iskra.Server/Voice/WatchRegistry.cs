using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Voice;

/// <summary>What a watch party plays: an https media URL, a file on this server, or a YouTube video id.</summary>
public sealed record WatchSource(string Kind, string? Url, string? FileId, string? VideoId, string? Title);

/// <summary>
/// One party per voice channel. <see cref="Position"/> is where playback was at server time <see cref="UpdatedAt"/>;
/// while playing it moves on at <see cref="Rate"/>, so anyone can work out where it is now.
/// </summary>
public sealed record WatchParty(
    string Id, long ChannelId, WatchSource Source, string Host, bool AnyoneControls,
    bool Playing, double Position, double Rate, long UpdatedAt, long StartedAt, string UpdatedBy)
{
    public double PositionAt(long now) => Playing ? Position + Math.Max(0, now - UpdatedAt) / 1000.0 * Rate : Position;
}

/// <summary>
/// Watch parties in voice channels and stages. The server only relays the shared clock (play, pause, position, speed);
/// media goes straight from its source to each browser. Who is in the room comes from LiveKit's webhooks.
/// </summary>
public sealed class WatchRegistry
{
    private readonly Dictionary<long, WatchParty> _parties = [];
    private readonly Lock _gate = new();
    private readonly World world;
    private readonly Hub hub;
    private readonly VoiceRegistry voice;
    private readonly TimeProvider time;

    public WatchRegistry(World world, Hub hub, VoiceRegistry voice, TimeProvider time)
    {
        this.world = world;
        this.hub = hub;
        this.voice = voice;
        this.time = time;
    }

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public WatchParty? Get(long channelId)
    {
        lock (_gate) return _parties.GetValueOrDefault(channelId);
    }

    /// <summary>Uploaded files that running parties play (kept by the upload sweep).</summary>
    public List<string> FileIds()
    {
        lock (_gate) return _parties.Values.Select(p => p.Source.FileId).OfType<string>().ToList();
    }

    public bool InRoom(long channelId, string accountKey) => voice.Participants(channelId).Any(p => p.AccountKey == accountKey);

    /// <summary>Who may start or host a party: in a voice channel its writers; on a stage its speakers and moderators.</summary>
    public bool MayHost(Member member, Channel channel) => channel.Kind == "stage"
        ? voice.Stages.IsSpeaker(channel.Id, member.AccountKey) || voice.Stages.IsModerator(member, channel)
        : Permissions.CanWrite(member, channel);

    /// <summary>Admins in voice channels, moderators on stages: they can always control and stop a party.</summary>
    public bool IsModerator(Member member, Channel channel) =>
        channel.Kind == "stage" ? voice.Stages.IsModerator(member, channel) : Permissions.IsAdmin(member);

    public bool CanControl(Member member, Channel channel, WatchParty party) =>
        MayHost(member, channel) && (party.Host == member.AccountKey || party.AnyoneControls || IsModerator(member, channel));

    public static object Public(WatchParty p) => new
    {
        id = p.Id,
        channelId = p.ChannelId,
        source = new { kind = p.Source.Kind, url = p.Source.Url, fileId = p.Source.FileId, videoId = p.Source.VideoId, title = p.Source.Title },
        host = p.Host,
        anyoneControls = p.AnyoneControls,
        playing = p.Playing,
        position = p.Position,
        rate = p.Rate,
        updatedAt = p.UpdatedAt,
        startedAt = p.StartedAt,
        updatedBy = p.UpdatedBy,
    };

    private object StateOf(long channelId, WatchParty? party) => new { channelId, party = party is null ? null : Public(party), serverTime = Now };

    /// <summary>Parties in channels this member can read (for the welcome).</summary>
    public List<object> Snapshot(Member member)
    {
        List<WatchParty> parties;
        lock (_gate) parties = [.. _parties.Values];
        return parties
            .Where(p => world.Store.GetChannel(p.ChannelId) is { } c && Permissions.CanRead(member, c))
            .Select(p => (object)Public(p))
            .ToList();
    }

    private void Publish(long channelId)
    {
        var channel = world.Store.GetChannel(channelId);
        if (channel is null) return;
        hub.BroadcastToReaders(channel, Frames.Event("watch.state", StateOf(channelId, Get(channelId))));
    }

    public void Set(WatchParty party)
    {
        lock (_gate) _parties[party.ChannelId] = party;
        Publish(party.ChannelId);
    }

    /// <summary>Applies a change to the current party (if it's still the same one).</summary>
    public WatchParty? Update(long channelId, string partyId, Func<WatchParty, WatchParty> change)
    {
        WatchParty? updated;
        lock (_gate)
        {
            if (!_parties.TryGetValue(channelId, out var current) || current.Id != partyId) return null;
            _parties[channelId] = updated = change(current);
        }
        Publish(channelId);
        return updated;
    }

    public void Stop(long channelId)
    {
        bool removed;
        lock (_gate) removed = _parties.Remove(channelId);
        if (removed) Publish(channelId);
    }

    /// <summary>Sends a chat line to everyone in the room who can read the channel. Not stored.</summary>
    public void Chat(Channel channel, string accountKey, string text)
    {
        var present = voice.Participants(channel.Id).Select(p => p.AccountKey).ToHashSet();
        var frame = Frames.Event("watch.chat", new { channelId = channel.Id, accountKey, text, at = Now });
        foreach (var session in hub.Sessions)
        {
            if (session.AccountKey is null || !present.Contains(session.AccountKey)) continue;
            if (session.CurrentMember() is { } member && Permissions.CanRead(member, channel)) session.Send(frame);
        }
    }

    /// <summary>
    /// After people join or leave, or roles change: the party ends when the room empties, and passes to whoever has been
    /// there longest (and may host) when its host leaves or may no longer host.
    /// </summary>
    public void Sync(long channelId)
    {
        var party = Get(channelId);
        if (party is null) return;
        var channel = world.Store.GetChannel(channelId);
        var present = voice.Participants(channelId);
        if (channel is null || channel.Kind is not ("voice" or "stage") || present.Count == 0)
        {
            Stop(channelId);
            return;
        }
        bool Eligible(string key) => world.Store.GetMember(key) is { } m && Permissions.CanRead(m, channel) && MayHost(m, channel);
        if (present.Any(p => p.AccountKey == party.Host) && Eligible(party.Host)) return;
        var next = present.Select(p => p.AccountKey).FirstOrDefault(Eligible);
        if (next is null) Stop(channelId);
        else Update(channelId, party.Id, p => p with { Host = next });
    }

    public void SyncAll()
    {
        List<long> ids;
        lock (_gate) ids = [.. _parties.Keys];
        foreach (var id in ids) Sync(id);
    }
}
