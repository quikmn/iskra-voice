using System.Collections.Concurrent;

namespace Iskra.Server.Voice;

/// <summary>A voice channel's status ("CS2 ranked"): who set it and when.</summary>
public sealed record VoiceStatus(string Text, string SetBy, long SetAt);

/// <summary>
/// Voice channel statuses (VoiceStatusFeature), in memory only like voice state: they belong to the call, so
/// <see cref="VoiceRegistry"/> clears one when its call empties.
/// </summary>
public sealed class VoiceStatusBoard
{
    private readonly ConcurrentDictionary<long, VoiceStatus> _statuses = new();

    public VoiceStatus? Get(long channelId) => _statuses.TryGetValue(channelId, out var status) ? status : null;

    public void Set(long channelId, VoiceStatus status) => _statuses[channelId] = status;

    /// <summary>The status that was there, if any.</summary>
    public VoiceStatus? Clear(long channelId) => _statuses.TryRemove(channelId, out var status) ? status : null;

    public void ClearAll() => _statuses.Clear();

    public static object? Public(VoiceStatus? status) =>
        status is null ? null : new { text = status.Text, setBy = status.SetBy, setAt = status.SetAt };
}
