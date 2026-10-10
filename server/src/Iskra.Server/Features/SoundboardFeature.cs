using System.Security.Cryptography;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Soundboard: short sounds anyone in a voice channel can play for the people in it. Trusted members
/// upload them; the server checks length from the file itself and that the player is really in voice.
/// </summary>
public static class SoundboardFeature
{
    public const int MaxSounds = 100;
    public const int MaxBytes = 512 * 1024;
    public const int MaxDurationMs = 5_000;
    /// <summary>Encoders pad a few frames, so a "5 second" clip may measure slightly longer.</summary>
    private const int DurationSlackMs = 150;
    private static readonly string[] Types = ["audio/mpeg", "audio/ogg", "audio/wav"];

    public static void Register(Router router)
    {
        router.Add("sound.list", (s, _, _) => new { sounds = List(s.World.Store) });
        router.Add("sound.create", Create);
        router.Add("sound.update", Update);
        router.Add("sound.delete", Delete);
        router.Add("sound.play", Play);
    }

    public static object Public(Sound sound, StoredFile? file) => new
    {
        id = sound.Id,
        name = sound.Name,
        emoji = sound.Emoji,
        url = file is null ? null : Uploads.UrlOf(file),
        durationMs = sound.DurationMs,
        createdBy = sound.CreatedBy,
    };

    public static List<object> List(Store store) => store.AllSounds().Select(x => Public(x, store.GetFile(x.FileId))).ToList();

    private static bool CanUpload(Member me) => Roles.Rank(me.Role) >= Roles.Rank(Roles.Trusted) || Permissions.Has(me, Perm.ManageExpressions);

    private static bool CanManage(Member me, Sound sound) => sound.CreatedBy == me.AccountKey || Permissions.Has(me, Perm.ManageExpressions);

    private static string Name(Body body) =>
        Text.Normalize(body.String("name", 64), Names.MaxLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Sound names are 1–{Names.MaxLength} characters.");

    private static string? Emoji(Body body)
    {
        var raw = body.OptionalString("emoji", 64);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var emoji = Text.Normalize(raw, 16, allowNewlines: false);
        if (emoji is null || emoji.Any(char.IsWhiteSpace)) throw RequestException.BadRequest("That isn't a valid emoji.");
        return emoji;
    }

    private static object Create(Session s, Member me, Body body)
    {
        if (!CanUpload(me)) throw RequestException.Forbidden("Only trusted members and admins can add sounds.");
        var store = s.World.Store;
        var name = Name(body);
        var emoji = Emoji(body);
        if (store.SoundCount() >= MaxSounds) throw RequestException.BadRequest($"This server already has {MaxSounds} sounds.");

        var file = store.GetFile(body.String("fileId", 64));
        if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown file.");
        if (!Types.Contains(file.Type)) throw RequestException.BadRequest("Sounds must be MP3, Ogg or WAV files.");
        if (file.Size > MaxBytes) throw RequestException.BadRequest($"Sounds can be up to {MaxBytes / 1024} KB.");

        var path = s.Uploads.PathFor(file.Sha256);
        var duration = File.Exists(path) ? AudioProbe.DurationMs(File.ReadAllBytes(path), file.Type) : null;
        if (duration is null) throw RequestException.BadRequest("Couldn't read that sound. Try an MP3, Ogg or WAV file.");
        if (duration > MaxDurationMs + DurationSlackMs) throw RequestException.BadRequest($"Sounds can be up to {MaxDurationMs / 1000} seconds long.");

        var sound = new Sound(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(9)), name, emoji, file.Id, Math.Min(duration.Value, MaxDurationMs),
            me.AccountKey, s.Now);
        store.AddSound(sound);
        Audit.Record(s, "sound.create", details: new { id = sound.Id, name });
        Changed(s);
        return new { sound = Public(sound, file) };
    }

    private static object Update(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var sound = store.GetSound(body.String("id", 64)) ?? throw RequestException.NotFound("Sound");
        if (!CanManage(me, sound)) throw RequestException.Forbidden("Only the person who added this sound or an admin can change it.");
        var updated = sound with { Name = Name(body), Emoji = Emoji(body) };
        store.UpdateSound(sound.Id, updated.Name, updated.Emoji);
        Audit.Record(s, "sound.update", sound.CreatedBy, details: new { id = sound.Id, from = sound.Name, to = updated.Name });
        Changed(s);
        return new { sound = Public(updated, store.GetFile(sound.FileId)) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        var sound = s.World.Store.GetSound(body.String("id", 64)) ?? throw RequestException.NotFound("Sound");
        if (!CanManage(me, sound)) throw RequestException.Forbidden("Only the person who added this sound or an admin can delete it.");
        s.World.Store.DeleteSound(sound.Id);
        Audit.Record(s, "sound.delete", sound.CreatedBy, details: new { id = sound.Id, name = sound.Name });
        Changed(s);
        return null;
    }

    /// <summary>
    /// Plays a sound for everyone in your voice channel. Being in voice comes from LiveKit's webhooks (never the client),
    /// and you need to be allowed to speak there. Rate-limited per connection.
    /// </summary>
    private static object? Play(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var sound = store.GetSound(body.String("id", 64)) ?? throw RequestException.NotFound("Sound");
        if (s.Voice.ChannelOfMember(me.AccountKey) is not { } channelId) throw RequestException.BadRequest("Join a voice channel to use the soundboard.");
        var channel = store.GetChannel(channelId);
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.BadRequest("Join a voice channel to use the soundboard.");
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can only listen in this channel.");

        var listeners = s.Voice.Participants(channelId).Select(p => p.AccountKey).ToHashSet();
        var frame = Frames.Event("sound.played", new { channelId, accountKey = me.AccountKey, sound = Public(sound, store.GetFile(sound.FileId)) });
        foreach (var session in s.Hub.Sessions)
        {
            if (session.AccountKey is null || !listeners.Contains(session.AccountKey)) continue;
            var member = session.CurrentMember();
            if (member is not null && Permissions.CanRead(member, channel)) session.Send(frame);
        }
        return null;
    }

    private static void Changed(Session s) => s.Hub.Broadcast(Frames.Event("sounds.updated", new { sounds = List(s.World.Store) }));
}
