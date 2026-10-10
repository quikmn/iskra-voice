using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Iskra.Server.Files;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class SoundboardTests
{
    /// <summary>A silent 8 kHz, 8-bit mono WAV.</summary>
    internal static byte[] Wav(int ms)
    {
        var samples = 8 * ms;
        var bytes = new byte[44 + samples];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)(36 + samples));
        Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(bytes, 8);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(16), 16);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(20), 1);    // PCM
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(22), 1);    // mono
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(24), 8000); // sample rate
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(28), 8000); // byte rate
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(32), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(34), 8);
        Encoding.ASCII.GetBytes("data").CopyTo(bytes, 36);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(40), (uint)samples);
        Array.Fill(bytes, (byte)128, 44, samples);
        return bytes;
    }

    /// <summary>MPEG-1 layer III frames at 128 kbps, 44.1 kHz (417 bytes, 1152 samples each).</summary>
    private static byte[] Mp3(int frames)
    {
        var bytes = new byte[10 + frames * 417];
        Encoding.ASCII.GetBytes("ID3").CopyTo(bytes, 0);
        bytes[3] = 4; // ID3v2.4, empty tag
        for (var i = 0; i < frames; i++)
        {
            var at = 10 + i * 417;
            bytes[at] = 0xFF; bytes[at + 1] = 0xFB; bytes[at + 2] = 0x90; bytes[at + 3] = 0x00;
        }
        return bytes;
    }

    /// <summary>An Ogg Opus stream: an OpusHead page, then a last page whose granule position says how long it is.</summary>
    private static byte[] OggOpus(long samples48k) => OggOpusPages((samples48k + 312, 0));

    private static byte[] OggPage(long granule, byte[] payload, uint serial = 0)
    {
        var page = new byte[28 + payload.Length];
        Encoding.ASCII.GetBytes("OggS").CopyTo(page, 0);
        BinaryPrimitives.WriteInt64LittleEndian(page.AsSpan(6), granule);
        BinaryPrimitives.WriteUInt32LittleEndian(page.AsSpan(14), serial);
        page[26] = 1;
        page[27] = (byte)payload.Length;
        payload.CopyTo(page, 28);
        return page;
    }

    /// <summary>The OpusHead page, then audio pages with these granule positions and stream serials.</summary>
    private static byte[] OggOpusPages(params (long Granule, uint Serial)[] pages)
    {
        var head = new byte[19];
        Encoding.ASCII.GetBytes("OpusHead").CopyTo(head, 0);
        head[8] = 1; head[9] = 2;
        BinaryPrimitives.WriteUInt16LittleEndian(head.AsSpan(10), 312);
        BinaryPrimitives.WriteUInt32LittleEndian(head.AsSpan(12), 48000);
        return [.. OggPage(0, head), .. pages.SelectMany(p => OggPage(p.Granule, new byte[100], p.Serial))];
    }

    [Fact]
    public void Ogg_lengths_are_checked_across_every_page()
    {
        const long second = 48_000;
        Assert.Equal(2000, AudioProbe.DurationMs(OggOpusPages((second + 312, 0), (2 * second + 312, 0), (-1, 0)), "audio/ogg"));
        // A long stream that ends on a page claiming to be short.
        Assert.Null(AudioProbe.DurationMs(OggOpusPages((60 * second, 0), (second, 0)), "audio/ogg"));
        // A second stream hidden next to a short one.
        Assert.Null(AudioProbe.DurationMs(OggOpusPages((second, 0), (60 * second, 7)), "audio/ogg"));
        // Bytes after the last page, or a page cut short.
        Assert.Null(AudioProbe.DurationMs([.. OggOpus(second), .. new byte[500]], "audio/ogg"));
        Assert.Null(AudioProbe.DurationMs(OggOpus(second)[..^10], "audio/ogg"));
        // Absurd granules don't overflow.
        Assert.Equal(int.MaxValue, AudioProbe.DurationMs(OggOpusPages((long.MaxValue, 0)), "audio/ogg"));
    }

    [Fact]
    public void Durations_come_from_the_file_itself()
    {
        Assert.Equal(1500, AudioProbe.DurationMs(Wav(1500), "audio/wav"));
        Assert.Equal(2612, AudioProbe.DurationMs(Mp3(100), "audio/mpeg")); // 100 × 1152 / 44100 s
        Assert.Equal(4000, AudioProbe.DurationMs(OggOpus(4 * 48_000), "audio/ogg"));
        Assert.Null(AudioProbe.DurationMs(Encoding.ASCII.GetBytes("RIFF....WAVEjunk"), "audio/wav"));
        Assert.Null(AudioProbe.DurationMs([0xFF, 0xFB, 0x00, 0x00, 1, 2, 3], "audio/mpeg"));
        Assert.Equal("audio/wav", FileSniffer.Sniff(Wav(10)).Type);
    }

    private static async Task<JsonElement> AddSound(IskraServer server, User user, byte[] audio, string name = "airhorn", string? emoji = "📯") =>
        await user.RequestAsync("sound.create", new { name, emoji, fileId = await EmojiTests.Upload(server, user, audio, name + ".bin") });

    private static void InVoice(IskraServer server, long channelId, User user) =>
        server.Services.GetRequiredService<VoiceRegistry>().Joined(channelId, user.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    [Fact]
    public async Task Trusted_members_add_sounds_within_limits()
    {
        using var server = new IskraServer();
        using var member = await server.JoinAsync("Member");
        using var trusted = await server.JoinAsync("Trusted", "trusted");

        Assert.Equal("forbidden", (await AddSound(server, member, Wav(1000))).ErrorCode());
        var created = await AddSound(server, trusted, Wav(2000));
        var sound = created.Body().GetProperty("sound");
        Assert.Equal("airhorn", sound.GetProperty("name").GetString());
        Assert.Equal("📯", sound.GetProperty("emoji").GetString());
        Assert.Equal(2000, sound.GetProperty("durationMs").GetInt32());
        Assert.Equal("airhorn", (await member.EventAsync("sounds.updated")).Body().GetProperty("sounds")[0].GetProperty("name").GetString());

        Assert.Equal("bad_request", (await AddSound(server, trusted, Wav(6000), "long")).ErrorCode());
        Assert.Equal("bad_request", (await AddSound(server, trusted, Mp3(250), "long-mp3")).ErrorCode()); // 6.5 s
        Assert.Equal("result", (await AddSound(server, trusted, Mp3(150), "short-mp3")).Type());          // 3.9 s
        Assert.Equal("result", (await AddSound(server, trusted, OggOpus(48_000), "ogg")).Type());
        Assert.Equal("bad_request", (await AddSound(server, trusted, EmojiTests.Png, "image")).ErrorCode());
        Assert.Equal("bad_request", (await AddSound(server, trusted, Wav(1000), "", null)).ErrorCode());
        Assert.Equal("bad_request", (await AddSound(server, trusted, Wav(1000), "spaced", "a b")).ErrorCode());
        // Over 512 KB, even if it claims to be short.
        var big = Wav(1000).Concat(new byte[512 * 1024]).ToArray();
        Assert.Equal("bad_request", (await AddSound(server, trusted, big, "big")).ErrorCode());
    }

    [Fact]
    public async Task Only_the_uploader_or_an_admin_changes_a_sound()
    {
        using var server = new IskraServer();
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var other = await server.JoinAsync("Other", "trusted");
        using var admin = await server.JoinAsync("Admin", "admin");
        var id = (await AddSound(server, trusted, Wav(500))).Body().GetProperty("sound").GetProperty("id").GetString();

        Assert.Equal("forbidden", (await other.RequestAsync("sound.update", new { id, name = "mine now" })).ErrorCode());
        Assert.Equal("forbidden", (await other.RequestAsync("sound.delete", new { id })).ErrorCode());
        Assert.Equal("honk", (await trusted.RequestAsync("sound.update", new { id, name = "honk", emoji = "🦆" })).Body().GetProperty("sound").GetProperty("name").GetString());
        Assert.Equal("result", (await admin.RequestAsync("sound.delete", new { id })).Type());
        Assert.Equal(0, (await other.RequestAsync("sound.list")).Body().GetProperty("sounds").GetArrayLength());
    }

    [Fact]
    public async Task Playing_needs_you_in_voice_and_reaches_only_that_channel()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        var other = server.World.Store.CreateChannel("other", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        var id = (await AddSound(server, alice, Wav(500))).Body().GetProperty("sound").GetProperty("id").GetString();

        Assert.Equal("bad_request", (await bob.RequestAsync("sound.play", new { id })).ErrorCode());

        InVoice(server, lounge, alice);
        InVoice(server, lounge, bob);
        InVoice(server, other, carol);
        Assert.Equal("result", (await bob.RequestAsync("sound.play", new { id })).Type());
        var played = (await alice.EventAsync("sound.played")).Body();
        Assert.Equal(lounge, played.GetProperty("channelId").GetInt64());
        Assert.Equal(bob.Key, played.GetProperty("accountKey").GetString());
        Assert.Equal("airhorn", played.GetProperty("sound").GetProperty("name").GetString());
        await bob.EventAsync("sound.played");
        await carol.NoEventAsync("sound.played");

        Assert.Equal("not_found", (await bob.RequestAsync("sound.play", new { id = "nope" })).ErrorCode());
    }

    [Fact]
    public async Task Listen_only_voice_channels_cant_play_sounds()
    {
        using var server = new IskraServer();
        var stage = server.World.Store.CreateChannel("stage", "voice", "member", "trusted", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        using var bob = await server.JoinAsync("Bob");
        var id = (await AddSound(server, alice, Wav(500))).Body().GetProperty("sound").GetProperty("id").GetString();
        InVoice(server, stage, bob);
        Assert.Equal("forbidden", (await bob.RequestAsync("sound.play", new { id })).ErrorCode());
    }

    [Fact]
    public async Task Playing_is_rate_limited()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice", "trusted");
        var id = (await AddSound(server, alice, Wav(500))).Body().GetProperty("sound").GetProperty("id").GetString();
        InVoice(server, lounge, alice);

        var codes = new List<string?>();
        for (var i = 0; i < 5; i++) codes.Add((await alice.RequestAsync("sound.play", new { id })).ErrorCode());
        Assert.Equal(3, codes.Count(c => c is null));
        Assert.Contains("rate_limited", codes);
    }
}
