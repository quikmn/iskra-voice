using System.Collections.Concurrent;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Join sounds: a member picks one short soundboard sound, and the others in a voice channel hear it when the member
/// enters. The choice is per server (the soundboard is per server). The owner can turn join sounds off for the server.
/// The sound is not mixed into anyone's audio: the server tells the people in the channel which sound to play, as the
/// soundboard does, so it works the same in encrypted voice channels.
/// </summary>
public static class JoinSoundFeature
{
    /// <summary>The longest sound that can be a join sound.</summary>
    public const int MaxMs = 5000;
    /// <summary>Measured lengths can be a little over the nominal one (encoder padding), as for the soundboard's limit.</summary>
    private const int SlackMs = 150;
    /// <summary>One join sound per person in this time, so leaving and rejoining can't be used to spam a channel.</summary>
    public const int CooldownMs = 30_000;

    public static void Register(Router router)
    {
        router.Add("joinsound.get", (s, me, _) => Mine(s.World.Store, me.AccountKey));
        router.Add("joinsound.set", Set);
        router.Add("joinsound.configure", Configure);
    }

    public static bool Fits(Sound sound) => sound.DurationMs <= MaxMs + SlackMs;

    private static object Mine(Store store, string accountKey) =>
        new { soundId = store.GetJoinSound(accountKey)?.Id, enabled = store.JoinSoundsEnabled(), maxMs = MaxMs };

    private static object Set(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        if (body.OptionalString("id", 64) is not { } id) store.ClearJoinSound(me.AccountKey);
        else
        {
            var sound = store.GetSound(id) ?? throw RequestException.NotFound("Sound");
            if (!Fits(sound))
                throw RequestException.BadRequest($"A join sound can be at most {MaxMs / 1000} seconds long.", "join_sound_long", new { seconds = MaxMs / 1000 });
            store.SetJoinSound(me.AccountKey, sound.Id, s.Now);
        }
        var mine = Mine(store, me.AccountKey);
        // The member's other devices show the same choice.
        var frame = Frames.Event("joinsound.updated", mine);
        foreach (var session in s.Hub.Sessions)
            if (session != s && session.AccountKey == me.AccountKey) session.Send(frame);
        return mine;
    }

    private static object? Configure(Session s, Member me, Body body)
    {
        if (!BaseRoles.Allows(me, BaseAbility.RunServer)) throw RequestException.Forbidden("Only the owner can turn join sounds on or off.", "owner_join_sounds");
        var enabled = body.OptionalBool("enabled") ?? throw RequestException.BadRequest("'enabled' is required.");
        if (enabled == s.World.Store.JoinSoundsEnabled()) return null;
        s.World.Store.SetJoinSoundsEnabled(enabled);
        Audit.Record(s, "server.joinSounds", details: new { enabled });
        s.Hub.Broadcast(Frames.Event("joinsound.enabled", new { enabled }));
        return null;
    }

    /// <summary>
    /// Someone entered a voice channel (LiveKit said so): tells the others there to play that person's join sound.
    /// The same rules as playing a soundboard sound: the person can speak in the channel, and stages are left out
    /// (people arrive there as audience). Nothing is sent to the person who joined.
    /// </summary>
    public static void Entered(World world, Hub hub, VoiceRegistry voice, ConcurrentDictionary<string, long> lastPlayed, long channelId, string accountKey, long now)
    {
        var store = world.Store;
        if (!store.JoinSoundsEnabled()) return;
        if (store.GetJoinSound(accountKey) is not { } sound || !Fits(sound)) return;
        var channel = store.GetChannel(channelId);
        var member = store.GetMember(accountKey);
        if (channel is null || member is null || channel.Kind != "voice") return;
        if (!Permissions.CanRead(member, channel) || !Permissions.CanWrite(member, channel)) return;
        if (store.Afk().ChannelId == channelId || voice.IsServerMuted(accountKey)) return;
        if (lastPlayed.TryGetValue(accountKey, out var last) && now - last < CooldownMs) return;

        var listeners = voice.Participants(channelId).Select(p => p.AccountKey).Where(k => k != accountKey).ToHashSet();
        if (listeners.Count == 0) return;
        lastPlayed[accountKey] = now;
        var frame = Frames.Event("joinsound.played", new { channelId, accountKey, sound = SoundboardFeature.Public(sound, store.GetFile(sound.FileId)) });
        foreach (var session in hub.Sessions)
        {
            if (session.AccountKey is null || !listeners.Contains(session.AccountKey)) continue;
            var listener = session.CurrentMember();
            if (listener is not null && Permissions.CanRead(listener, channel)) session.Send(frame);
        }
    }
}
