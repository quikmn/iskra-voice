using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Watch parties: everyone in a voice channel (or stage) watches the same video in step. The server keeps the shared
/// clock and checks who may change it; the video itself never passes through the server (except files uploaded to it).
/// </summary>
public static partial class WatchFeature
{
    public const int MaxUrlLength = 2048;
    public const int MaxTitleLength = 200;
    public const int MaxChatLength = 500;
    /// <summary>Positions are seconds, up to two days in.</summary>
    public const double MaxPosition = 2 * 86400;
    public static readonly double[] Rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    [GeneratedRegex("^[A-Za-z0-9_-]{11}$")]
    private static partial Regex YouTubeId();

    public static void Register(Router router)
    {
        router.Add("watch.start", Start);
        router.Add("watch.control", Control);
        router.Add("watch.settings", Settings);
        router.Add("watch.stop", Stop);
        router.Add("watch.chat", Chat);
        router.Add("watch.clock", (s, _, _) => new { now = s.Now });
    }

    private static Channel VoiceChannel(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind is not ("voice" or "stage")) throw RequestException.BadRequest("Watch parties happen in voice channels.");
        return channel;
    }

    private static void RequireInRoom(Session s, Member me, Channel channel)
    {
        if (!s.Voice.Watch.InRoom(channel.Id, me.AccountKey)) throw RequestException.BadRequest("Join the voice channel first.");
    }

    private static WatchParty Party(Session s, Channel channel, Body body)
    {
        var id = body.String("partyId", 32);
        return s.Voice.Watch.Get(channel.Id) is { } party && party.Id == id ? party : throw RequestException.NotFound("Watch party");
    }

    /// <summary>Numbers with fractions (Body only reads integers).</summary>
    private static double? OptionalDouble(Body body, string name, double min, double max)
    {
        if (body.OptionalElement(name) is not { } value) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number))
            throw RequestException.BadRequest($"'{name}' must be a number.");
        if (number < min || number > max) throw RequestException.BadRequest($"'{name}' is out of range.");
        return number;
    }

    /// <summary>https only, a real host, no credentials, no whitespace.</summary>
    internal static string? ValidMediaUrl(string raw)
    {
        if (raw.Length > MaxUrlLength || raw.Any(c => char.IsWhiteSpace(c) || char.IsControl(c))) return null;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        if (string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo)) return null;
        return uri.AbsoluteUri;
    }

    private static WatchSource Source(Session s, JsonElement element, string? title)
    {
        if (element.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'source' must be an object.");
        var source = new Body(element);
        switch (source.String("kind", 16))
        {
            case "url":
                var url = ValidMediaUrl(source.String("url", MaxUrlLength))
                    ?? throw RequestException.BadRequest("Use an https:// link to a video or audio file.");
                return new WatchSource("url", url, null, null, title);
            case "file":
                var file = s.World.Store.GetFile(source.String("fileId", 64)) ?? throw RequestException.NotFound("File");
                if (!(file.Type.StartsWith("video/", StringComparison.Ordinal) || file.Type.StartsWith("audio/", StringComparison.Ordinal)))
                    throw RequestException.BadRequest("That file isn't a video or audio file.");
                return new WatchSource("file", Uploads.UrlOf(file), file.Id, null, title ?? file.Name);
            case "youtube":
                var videoId = source.String("videoId", 16);
                if (!YouTubeId().IsMatch(videoId)) throw RequestException.BadRequest("That isn't a YouTube video id.");
                return new WatchSource("youtube", null, null, videoId, title);
            default:
                throw RequestException.BadRequest("'kind' must be url, file or youtube.");
        }
    }

    private static object Start(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        var raw = body.Element("source");
        var title = body.OptionalString("title", MaxTitleLength * 2) is { } t ? Text.Normalize(t, MaxTitleLength, allowNewlines: false) : null;
        var watch = s.Voice.Watch;
        RequireInRoom(s, me, channel);
        if (!watch.MayHost(me, channel))
            throw RequestException.Forbidden(channel.Kind == "stage" ? "Only speakers and moderators can start a watch party here." : "You can only listen in this channel.");
        if (watch.Get(channel.Id) is { } current && current.Host != me.AccountKey && !watch.IsModerator(me, channel))
            throw RequestException.BadRequest("A watch party is already on here.");

        var source = Source(s, raw, title);
        var now = s.Now;
        var party = new WatchParty(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(12)), channel.Id, source, me.AccountKey,
            AnyoneControls: false, Playing: false, Position: 0, Rate: 1, UpdatedAt: now, StartedAt: now, UpdatedBy: me.AccountKey);
        watch.Set(party);
        return new { party = WatchRegistry.Public(party) };
    }

    /// <summary>Play, pause, seek and speed. Missing fields keep their value (the position carries on from the shared clock).</summary>
    private static object Control(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        var party = Party(s, channel, body);
        var playing = body.OptionalBool("playing");
        var position = OptionalDouble(body, "position", 0, MaxPosition);
        var rate = OptionalDouble(body, "rate", 0.25, 2);
        if (rate is { } r && !Rates.Contains(r)) throw RequestException.BadRequest($"'rate' must be one of {string.Join(", ", Rates)}.");
        RequireInRoom(s, me, channel);
        if (!s.Voice.Watch.CanControl(me, channel, party)) throw RequestException.Forbidden("Only the host controls this watch party.");

        var now = s.Now;
        var updated = s.Voice.Watch.Update(channel.Id, party.Id, p => p with
        {
            Position = Math.Clamp(position ?? p.PositionAt(now), 0, MaxPosition),
            Playing = playing ?? p.Playing,
            Rate = rate ?? p.Rate,
            UpdatedAt = now,
            UpdatedBy = me.AccountKey,
        }) ?? throw RequestException.NotFound("Watch party");
        return new { party = WatchRegistry.Public(updated) };
    }

    private static object? Settings(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        var party = Party(s, channel, body);
        var anyone = body.OptionalBool("anyoneControls") ?? throw RequestException.BadRequest("'anyoneControls' is required.");
        if (party.Host != me.AccountKey && !s.Voice.Watch.IsModerator(me, channel))
            throw RequestException.Forbidden("Only the host can change who controls the watch party.");
        s.Voice.Watch.Update(channel.Id, party.Id, p => p with { AnyoneControls = anyone });
        return null;
    }

    private static object? Stop(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        var party = Party(s, channel, body);
        if (party.Host != me.AccountKey && !s.Voice.Watch.IsModerator(me, channel))
            throw RequestException.Forbidden("Only the host can end the watch party.");
        s.Voice.Watch.Stop(channel.Id);
        return null;
    }

    private static object? Chat(Session s, Member me, Body body)
    {
        var channel = VoiceChannel(s, me, body);
        var text = Text.Normalize(body.String("text", MaxChatLength * 2), MaxChatLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Messages must be 1–{MaxChatLength} characters.");
        RequireInRoom(s, me, channel);
        if (s.Voice.Watch.Get(channel.Id) is null) throw RequestException.NotFound("Watch party");
        AutoModFeature.Check(s, me, channel, text, "watch");
        s.Voice.Watch.Chat(channel, me.AccountKey, text);
        return null;
    }
}
