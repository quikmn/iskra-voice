using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Voice messages: a channel message with exactly one recorded audio file, its length and a small waveform for the
/// player. The waveform and length come from the recording app; the server checks their shape and limits, and for
/// Ogg files measures the length itself (WebM and MP4 recordings carry no reliable length, so theirs is bounded only).
/// </summary>
public static class VoiceMessageFeature
{
    public const int MaxDurationMs = 5 * 60 * 1000;
    public const long MaxBytes = 10 * 1024 * 1024;
    public const int MaxWaveform = 128;
    /// <summary>What browsers' MediaRecorder makes: Ogg or WebM Opus (Firefox, Chrome), MP4/AAC (Safari).</summary>
    public static readonly string[] Types = ["audio/ogg", "video/webm", "video/mp4"];

    public sealed record Voice(int DurationMs, byte[] Waveform);

    /// <summary>The optional <c>voice</c> of a chat.send, checked against its attachments and text. Null when absent.</summary>
    public static Voice? Parse(Session s, Body body, string[] attachments, string text)
    {
        if (body.OptionalElement("voice") is not { } element) return null;
        if (element.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'voice' must be an object.");
        if (attachments.Length != 1) throw RequestException.BadRequest("A voice message is exactly one audio file.");
        if (text.Length > 0) throw RequestException.BadRequest("Voice messages can't have text.");
        var file = s.World.Store.GetFile(attachments[0]) ?? throw RequestException.BadRequest("Unknown attachment.");
        if (!Types.Contains(file.Type)) throw RequestException.BadRequest("Voice messages must be Ogg, WebM or MP4 audio.", "voice_message_type");
        if (file.Size > MaxBytes) throw RequestException.BadRequest($"Voice messages can be up to {MaxBytes / 1024 / 1024} MB.", "voice_message_size", new { mb = MaxBytes / 1024 / 1024 });

        var voice = new Body(element);
        var duration = (int)(voice.OptionalLong("duration", min: 1, max: MaxDurationMs)
            ?? throw RequestException.BadRequest($"'duration' must be 1–{MaxDurationMs} ms."));
        if (!Ed25519.TryFromB64u(voice.String("waveform", MaxWaveform * 2), out var waveform) || waveform.Length is 0 or > MaxWaveform)
            throw RequestException.BadRequest($"'waveform' must be 1–{MaxWaveform} bytes.");

        if (file.Type == "audio/ogg")
        {
            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(s.Uploads.PathFor(file.Sha256));
            }
            catch (IOException)
            {
                throw RequestException.NotFound("Voice file");
            }
            var measured = AudioProbe.DurationMs(bytes, file.Type) ?? throw RequestException.BadRequest("Couldn't read that recording.", "recording_unreadable");
            if (measured > MaxDurationMs + 1000) throw RequestException.BadRequest("Voice messages can be up to 5 minutes.", "voice_message_5_min");
            duration = Math.Clamp(measured, 1, MaxDurationMs);
        }
        return new Voice(duration, waveform);
    }

    public static void Saved(Store store, Message message, Voice? voice)
    {
        if (voice is not null) store.SetVoiceMessage(message.Id, voice.DurationMs, voice.Waveform);
    }

    public static bool IsVoice(Store store, long messageId) => store.GetVoiceMessage(messageId) is not null;

    public static object? View(Store store, long messageId) =>
        store.GetVoiceMessage(messageId) is { } v ? new { duration = v.DurationMs, waveform = Ed25519.ToB64u(v.Waveform) } : null;
}
