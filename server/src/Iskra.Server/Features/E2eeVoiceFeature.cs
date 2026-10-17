using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// End-to-end encrypted voice channels: an encrypted channel (E2eeChannelFeature) of kind voice. Members' apps encrypt
/// every audio and video frame with a key derived from the channel's current epoch key, so LiveKit only forwards
/// ciphertext. The server can't check the media; what it can do is keep the room to the people who hold the key:
/// only members of the channel's chain get a token, LiveKit joins by anyone else are removed, and a chain change
/// re-checks everyone in the room. Features that would need plaintext on the server refuse these channels.
/// </summary>
public static class E2eeVoiceFeature
{
    /// <summary>The channel is end-to-end encrypted (its media and its chat).</summary>
    public static bool IsEncrypted(Store store, long channelId) => store.GetE2ee(channelId) is not null;

    /// <summary>
    /// <c>voice.join</c>: only people in the channel's chain hold its key. Anyone else (not added yet, or the chain is
    /// full) is told why instead of joining a room they couldn't hear or be heard in.
    /// </summary>
    public static void CheckJoin(Store store, Member me, Channel channel)
    {
        if (store.GetE2ee(channel.Id) is not { } e || e.Members.Contains(me.AccountKey)) return;
        if (e.Members.Length >= E2eeChannelFeature.MaxMembers)
            throw RequestException.BadRequest(
                $"This encrypted voice channel is full: at most {E2eeChannelFeature.MaxMembers} people can hold its key.",
                "e2ee_voice_full", new { max = E2eeChannelFeature.MaxMembers });
        throw RequestException.BadRequest(
            "This voice channel is end-to-end encrypted and you don't have its key yet. Someone in it hands it to you automatically when they're online.",
            "e2ee_voice_waiting");
    }

    /// <summary>For LiveKit's webhooks, access checks and moves: in an encrypted channel, only members of its chain.</summary>
    public static bool MayBeIn(Store store, Member member, Channel channel) =>
        store.GetE2ee(channel.Id) is not { } e || e.Members.Contains(member.AccountKey);

    /// <summary><c>voice.move</c> into an encrypted channel: the person must hold its key.</summary>
    public static void CheckMove(Store store, Member target, Channel to)
    {
        if (!MayBeIn(store, target, to))
            throw RequestException.Forbidden("They don't have this encrypted channel's key yet, so they couldn't hear or be heard there.", "e2ee_voice_they_waiting");
    }

    /// <summary>Features whose content the server would see (watch parties) are off in encrypted voice channels.</summary>
    public static void RefuseWatch(Store store, Channel channel)
    {
        if (IsEncrypted(store, channel.Id))
            throw RequestException.BadRequest("Watch parties are off in encrypted voice channels: the server would see what's played.", "watch_e2ee");
    }

    /// <summary>The AFK channel moves people in by itself, so it can't be one only some of them hold the key to.</summary>
    public static void RefuseAfk(Store store, long? channelId)
    {
        if (channelId is { } id && IsEncrypted(store, id))
            throw RequestException.BadRequest("An encrypted voice channel can't be the AFK channel.", "afk_encrypted");
    }

    /// <summary>The chain changed: anyone in the room who isn't in it any more leaves (they won't get the new key).</summary>
    public static void ChainChanged(Session s, Channel channel)
    {
        if (channel.Kind == "voice") s.Voice.EnforceAccess();
    }
}
