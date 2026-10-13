using Iskra.Server.Storage;
using Iskra.Server.Voice;
using Microsoft.Extensions.Logging.Abstractions;

namespace Iskra.Server.Tests;

/// <summary>The LiveKit config the server writes follows the p2p switch at runtime (TURN only while it's on).</summary>
public class P2pConfigTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "iskra-p2p-config-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_path, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void LiveKit_gets_its_turn_server_only_while_p2p_is_on()
    {
        using var world = World.OpenOrCreate(_path);
        var livekit = new LiveKitHost(world, NullLogger<LiveKitHost>.Instance);
        var off = livekit.ConfigYaml(47070);
        Assert.DoesNotContain("turn:", off);
        Assert.Contains("level: warn", off);

        world.UpdateSettings(s => s with { P2p = s.P2p with { Enabled = true } });
        var on = livekit.ConfigYaml(47070);
        Assert.Contains("\nturn:\n  enabled: true\n", on);
        Assert.Contains($"udp_port: {world.Settings.Voice.EffectiveTurnUdpPort}", on);
        Assert.Contains("allow_restricted_peer_cidrs: [127.0.0.0/8", on);
        // Valid YAML shape: every line of the block is at the top level or indented under it.
        foreach (var line in on.Split('\n').SkipWhile(l => !l.StartsWith("turn:", StringComparison.Ordinal)).Skip(1).Where(l => l.Length > 0))
            Assert.StartsWith("  ", line);

        world.UpdateSettings(s => s with { P2p = s.P2p with { Enabled = false } });
        Assert.DoesNotContain("turn:", livekit.ConfigYaml(47070));
    }
}
