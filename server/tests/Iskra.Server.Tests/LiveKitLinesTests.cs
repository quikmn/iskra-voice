using Iskra.Server.Logging;
using Iskra.Server.Voice;
using Microsoft.Extensions.Logging;

namespace Iskra.Server.Tests;

/// <summary>LiveKit's lines in our log: why something failed is kept (its "error" field), who and where is not.</summary>
public class LiveKitLinesTests
{
    private const string Identity = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd";

    [Fact]
    public void An_error_line_keeps_why_it_failed()
    {
        // LiveKit 1.13's line for a join it refused (service/signal.go).
        var parsed = LiveKitLines.Parse("2026-11-22T21:46:11.234+0100\tERROR\tlivekit\tservice/signal.go:179\tcould not handle new participant\t" +
            $"{{\"room\": \"voice-2\", \"participant\": \"{Identity}\", \"connID\": \"CO_abcDEF123456\", \"error\": \"context deadline exceeded\"}}");
        Assert.NotNull(parsed);
        Assert.Equal(LogLevel.Error, parsed.Level);
        Assert.Equal("could not handle new participant", parsed.Message);
        Assert.Equal("context deadline exceeded", parsed.Error);
        Assert.Equal(2, parsed.Channel);
    }

    [Fact]
    public void Why_is_wording_only()
    {
        static string? Why(string error) => LiveKitLines.Parse(
            "2026-11-22T21:46:11.234Z\tWARN\tlivekit\trtc/room.go:1\tcould not join room\t" + System.Text.Json.JsonSerializer.Serialize(new { room = "voice-2", error }))?.Error;

        // an identity, an id, an address, a room name and a name never pass: only plain lowercase words do
        var why = Why($"participant {Identity} already exists in voice-2 at 198.51.100.4:61000");
        Assert.StartsWith("participant <token> already exists in … at ", why);
        Assert.DoesNotContain(Identity, why);
        Assert.DoesNotContain("198.51", why);
        Assert.DoesNotContain("voice-2", why);
        Assert.Equal("… not found for …", Why("PA_3TqZqNxrtHuk not found for Alice"));
        Assert.DoesNotContain("192.168", Why("read udp 192.168.1.20:7882: i/o timeout"));
        Assert.Equal(100, Why(string.Join(' ', Enumerable.Repeat("word", 80)))!.Length);
        Assert.Null(Why(""));
        // no "error" field: nothing
        Assert.Null(LiveKitLines.Parse("2026-11-22T21:46:11.234Z\tWARN\tlivekit\trtc/room.go:1\tcould not join room\t{\"room\": \"voice-2\"}")!.Error);
    }

    [Fact]
    public void A_sub_logger_and_a_module_path_are_not_the_message()
    {
        // pion's lines: the logger is livekit.transport.pion.ice and the caller a module path with a version
        var parsed = LiveKitLines.Parse("2026-11-22T21:46:11.234+0100\tERROR\tlivekit.transport.pion.ice\tv4@v4.4.0-warp.2/agent_stats.go:106\t" +
            $"Failed to get selected candidate pair stats: the agent is closed\t{{\"room\": \"voice-2\", \"participant\": \"{Identity}\", \"transport\": \"PUBLISHER\"}}");
        Assert.Equal("… to get selected candidate pair stats: the agent is closed", parsed!.Message);
        Assert.Equal("too much ext packets", LiveKitLines.Parse("2026-11-22T21:46:11.234+0100\tWARN\tlivekit.pub.pub.sfu\tbuffer/buffer_base.go:917\ttoo much ext packets\t{\"room\": \"voice-2\"}")!.Message);
    }

    [Fact]
    public void The_log_line_carries_why_and_the_same_failure_is_quiet_for_a_minute()
    {
        var lines = new List<string>();
        var sink = new LogSink(null, console: false);
        sink.Tap += lines.Add;
        using var provider = new IskraLoggerProvider(sink);
        var log = provider.CreateLogger("Iskra.Server.Voice.LiveKitHost");
        var unique = $"a failure nobody else has {Guid.NewGuid():N}"[..40];
        string Line(string error) => $"2026-11-22T21:46:11.234Z\tERROR\tlivekit\tservice/signal.go:179\t{unique}\t{{\"room\": \"voice-3\", \"participant\": \"{Identity}\", \"error\": \"{error}\"}}";
        LiveKitLines.Relay(log, Line("room is closed"));
        LiveKitLines.Relay(log, Line("room is closed")); // the same again: quiet
        LiveKitLines.Relay(log, Line("context canceled")); // another reason: its own line
        var mine = lines.Where(l => l.Contains(" lk ")).ToList();
        Assert.Equal(2, mine.Count);
        Assert.Contains($" ERROR lk    voice  error       LK-160  msg=\"{unique}\" why=\"room is closed\" chan=3", mine[0]);
        Assert.Contains("why=\"context canceled\"", mine[1]);
        Assert.DoesNotContain(Identity, string.Join('\n', mine));
    }
}
