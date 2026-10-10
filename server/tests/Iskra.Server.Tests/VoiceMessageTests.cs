using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class VoiceMessageTests
{
    private static readonly string Wave = Ed25519.ToB64u(Enumerable.Range(0, 64).Select(i => (byte)(i * 4)).ToArray());

    /// <summary>What Chrome's MediaRecorder starts a WebM file with (an EBML header), plus some bytes.</summary>
    private static byte[] Webm(int size = 2000) => [0x1A, 0x45, 0xDF, 0xA3, .. new byte[size]];

    /// <summary>An MP4 (Safari's MediaRecorder): a box with the ftyp brand.</summary>
    private static byte[] Mp4() => [0, 0, 0, 0x18, .. "ftypM4A "u8.ToArray(), .. new byte[2000]];

    private static byte[] OggPage(long granule, byte[] payload)
    {
        var page = new byte[28 + payload.Length];
        Encoding.ASCII.GetBytes("OggS").CopyTo(page, 0);
        BinaryPrimitives.WriteInt64LittleEndian(page.AsSpan(6), granule);
        page[26] = 1;
        page[27] = (byte)payload.Length;
        payload.CopyTo(page, 28);
        return page;
    }

    /// <summary>Ogg Opus lasting <paramref name="ms"/> (by its last granule position).</summary>
    private static byte[] OggOpus(long ms)
    {
        var head = new byte[19];
        Encoding.ASCII.GetBytes("OpusHead").CopyTo(head, 0);
        head[8] = 1; head[9] = 1;
        BinaryPrimitives.WriteUInt16LittleEndian(head.AsSpan(10), 312);
        BinaryPrimitives.WriteUInt32LittleEndian(head.AsSpan(12), 48000);
        return [.. OggPage(0, head), .. OggPage(ms * 48 + 312, new byte[100])];
    }

    private static async Task<JsonElement> SendVoice(IskraServer server, User user, byte[] audio, string name, object voice, string text = "") =>
        await user.RequestAsync("chat.send", new
        {
            channelId = server.General, text,
            attachments = new[] { await EmojiTests.Upload(server, user, audio, name) },
            voice,
        });

    [Fact]
    public async Task A_voice_message_carries_its_length_and_waveform_everywhere()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var sent = await SendVoice(server, alice, Webm(), "voice-message.webm", new { duration = 12_345, waveform = Wave });
        Assert.Equal("result", sent.Type());
        var voice = sent.Body().GetProperty("message").GetProperty("voice");
        Assert.Equal(12_345, voice.GetProperty("duration").GetInt32());
        Assert.Equal(Wave, voice.GetProperty("waveform").GetString());

        var seen = (await bob.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal(12_345, seen.GetProperty("voice").GetProperty("duration").GetInt32());
        Assert.Equal("video/webm", seen.GetProperty("attachments")[0].GetProperty("type").GetString());

        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(Wave, history[0].GetProperty("voice").GetProperty("waveform").GetString());

        // Ordinary messages have none, and voice messages can't be edited.
        var plain = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Body().GetProperty("message");
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("voice").ValueKind);
        var id = sent.Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.edit", new { id, text = "sneaky" })).ErrorCode());
    }

    [Fact]
    public async Task Safari_mp4_recordings_are_accepted()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("result", (await SendVoice(server, alice, Mp4(), "voice-message.m4a", new { duration = 2000, waveform = Wave })).Type());
    }

    [Fact]
    public async Task Ogg_lengths_are_measured_by_the_server()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var sent = await SendVoice(server, alice, OggOpus(3000), "voice-message.ogg", new { duration = 99_000, waveform = Wave });
        Assert.Equal(3000, sent.Body().GetProperty("message").GetProperty("voice").GetProperty("duration").GetInt32());

        var tooLong = await SendVoice(server, alice, OggOpus(6 * 60 * 1000), "long.ogg", new { duration = 1000, waveform = Wave });
        Assert.Equal("bad_request", tooLong.ErrorCode());
        var broken = await SendVoice(server, alice, [.. "OggS"u8.ToArray(), .. new byte[200]], "broken.ogg", new { duration = 1000, waveform = Wave });
        Assert.Equal("bad_request", broken.ErrorCode());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(300_001)]
    [InlineData(-5)]
    public async Task Lengths_are_one_ms_to_five_minutes(int duration)
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await SendVoice(server, alice, Webm(), "v.webm", new { duration, waveform = Wave })).ErrorCode());
    }

    [Fact]
    public async Task Waveforms_are_size_limited()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("result", (await SendVoice(server, alice, Webm(), "v.webm", new { duration = 1000, waveform = Ed25519.ToB64u(new byte[128]) })).Type());
        Assert.Equal("bad_request", (await SendVoice(server, alice, Webm(), "v.webm", new { duration = 1000, waveform = Ed25519.ToB64u(new byte[129]) })).ErrorCode());
        Assert.Equal("bad_request", (await SendVoice(server, alice, Webm(), "v.webm", new { duration = 1000, waveform = "" })).ErrorCode());
        Assert.Equal("bad_request", (await SendVoice(server, alice, Webm(), "v.webm", new { duration = 1000, waveform = "not base64!" })).ErrorCode());
        Assert.Equal("bad_request", (await SendVoice(server, alice, Webm(), "v.webm", new { duration = 1000 })).ErrorCode());
    }

    [Fact]
    public async Task Voice_messages_are_one_audio_file_and_no_text()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var voice = new { duration = 1000, waveform = Wave };

        Assert.Equal("bad_request", (await SendVoice(server, alice, Webm(), "v.webm", voice, text: "hello")).ErrorCode());
        Assert.Equal("bad_request", (await SendVoice(server, alice, EmojiTests.Png, "picture.png", voice)).ErrorCode());
        Assert.Equal("bad_request", (await SendVoice(server, alice, Encoding.UTF8.GetBytes("just text"), "v.webm", voice)).ErrorCode());

        var two = new[] { await EmojiTests.Upload(server, alice, Webm(), "a.webm"), await EmojiTests.Upload(server, alice, Webm(10), "b.webm") };
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "", attachments = two, voice })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "", attachments = Array.Empty<string>(), voice })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "", attachments = two[..1], voice = "yes" })).ErrorCode());
    }

    [Fact]
    public async Task Voice_files_are_size_limited()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var big = await SendVoice(server, alice, Webm(10 * 1024 * 1024), "v.webm", new { duration = 1000, waveform = Wave });
        Assert.Equal("bad_request", big.ErrorCode());
    }
}
