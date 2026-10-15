using System.Buffers;
using System.Net;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Hosting;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;

namespace Iskra.Server.Tests;

/// <summary>"Let friends connect without port forwarding": the owner's switch, the secret, and what members learn.</summary>
public class P2pTests : IDisposable
{
    private readonly IskraServer _server = new();

    public void Dispose() => _server.Dispose();

    private static JsonElement Body(JsonElement frame) => frame.GetProperty("body");

    private string KeyFile => Path.Combine(_server.WorldPath, "p2p.key");

    [Fact]
    public async Task Status_and_switching_are_for_the_owner()
    {
        using var owner = await _server.JoinAsync("Owner", "owner");
        using var admin = await _server.JoinAsync("Admin", "admin");
        using var member = await _server.JoinAsync("Member");

        foreach (var who in new[] { admin, member })
        {
            foreach (var type in new[] { "p2p.status", "p2p.rotate" })
                Assert.Equal("forbidden", Body(await who.RequestAsync(type)).GetProperty("code").GetString());
            Assert.Equal("forbidden", Body(await who.RequestAsync("p2p.set", new { enabled = true })).GetProperty("code").GetString());
        }
        Assert.False(File.Exists(KeyFile));

        var status = Body(await owner.RequestAsync("p2p.status")).GetProperty("status");
        Assert.False(status.GetProperty("enabled").GetBoolean());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("hostKey").ValueKind);
        Assert.Equal(0, status.GetProperty("connected").GetInt32());

        Assert.Equal("bad_request", Body(await owner.RequestAsync("p2p.set", new { enabled = "yes" })).GetProperty("code").GetString());
        Assert.Equal("bad_request", Body(await owner.RequestAsync("p2p.set", new { })).GetProperty("code").GetString());
        // Nobody got the secret: there is none.
        Assert.Equal(JsonValueKind.Null, member.Welcome.GetProperty("body").GetProperty("server").GetProperty("p2p").ValueKind);
    }

    [Fact]
    public async Task Turning_on_makes_a_secret_members_learn_rotating_replaces_it_and_turning_off_hides_it()
    {
        using var owner = await _server.JoinAsync("Owner", "owner");
        using var member = await _server.JoinAsync("Member");

        var on = Body(await owner.RequestAsync("p2p.set", new { enabled = true })).GetProperty("status");
        Assert.True(on.GetProperty("enabled").GetBoolean());
        Assert.True(_server.World.Settings.P2p.Enabled);
        Assert.True(File.Exists(KeyFile));
        var secret = File.ReadAllText(KeyFile).Trim();
        Assert.Equal(43, secret.Length); // 32 bytes, b64u
        Assert.Matches("^[0-9a-f]{64}$", on.GetProperty("hostKey").GetString());
        Assert.Equal(P2pKeys.HostPublicKeyHex(Convert.FromBase64String(secret.Replace('-', '+').Replace('_', '/') + "=")), on.GetProperty("hostKey").GetString());
        Assert.True(on.GetProperty("since").GetInt64() > 0);

        // Everyone online hears the secret (they make invites), and new sessions get it in welcome.
        var told = Body(await member.EventAsync("server.p2p"));
        Assert.Equal(secret, told.GetProperty("p2p").GetString());
        using var late = await _server.JoinAsync("Late");
        Assert.Equal(secret, late.Welcome.GetProperty("body").GetProperty("server").GetProperty("p2p").GetString());

        // Rotating: a new secret, a new host key, and old links are dead.
        var rotated = Body(await owner.RequestAsync("p2p.rotate")).GetProperty("status");
        var next = File.ReadAllText(KeyFile).Trim();
        Assert.NotEqual(secret, next);
        Assert.NotEqual(on.GetProperty("hostKey").GetString(), rotated.GetProperty("hostKey").GetString());
        Assert.Equal(next, Body(await member.EventAsync("server.p2p")).GetProperty("p2p").GetString());

        // Off: members are told there is no secret; the file stays for next time.
        var off = Body(await owner.RequestAsync("p2p.set", new { enabled = false })).GetProperty("status");
        Assert.False(off.GetProperty("enabled").GetBoolean());
        Assert.Equal(JsonValueKind.Null, Body(await member.EventAsync("server.p2p")).GetProperty("p2p").ValueKind);
        Assert.True(File.Exists(KeyFile));
        using var later = await _server.JoinAsync("Later");
        Assert.Equal(JsonValueKind.Null, later.Welcome.GetProperty("body").GetProperty("server").GetProperty("p2p").ValueKind);
        // Setting the same value again changes nothing and tells nobody.
        await owner.RequestAsync("p2p.set", new { enabled = false });
        await member.NoEventAsync("server.p2p");

        // The audit log has the owner's actions.
        var audit = Body(await owner.RequestAsync("audit.list", new { }));
        var actions = audit.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("server.p2p", actions);
        Assert.Contains("server.p2p.rotate", actions);
    }

    [Fact]
    public void Keys_derive_exactly_as_the_desktop_app_derives_them()
    {
        // Computed with the desktop app's stack (sodium-universal crypto_generichash + hyperdht's keyPair) for the
        // secret 01 02 … 20; the desktop unit test checks the same vector (desktop/src/p2p/keys.test.ts).
        var secret = Enumerable.Range(1, 32).Select(i => (byte)i).ToArray();
        Assert.Equal("4f36d1a0830dda1df53248fb70b7e0ab13b8d0af3ee45f68cd8508a7c85add86", Convert.ToHexString(P2pKeys.Seed(secret, P2pKeys.HostContext)).ToLowerInvariant());
        Assert.Equal("71b61f4c35ce6e8f87eb58793b6fcdcebf6a42b7435f70f2b4c6fab4b541ae30", P2pKeys.HostPublicKeyHex(secret));
        Assert.Throws<ArgumentException>(() => P2pKeys.Seed(new byte[31], P2pKeys.HostContext));
    }

    [Fact]
    public void Voice_through_the_tunnel_uses_the_address_the_friend_used()
    {
        var backend = new FakeVoiceBackend();
        Assert.Equal("ws://127.0.0.1:51234/livekit", LiveKitHost.ClientUrlFor("http://127.0.0.1:51234", backend, null, tunnelled: true));
        Assert.Equal("ws://voice.test:7880", LiveKitHost.ClientUrlFor("http://127.0.0.1:51234", backend, null, tunnelled: false));
        // A voice URL set by hand in server.json wins (the backend's ClientUrl is that one then).
        Assert.Equal("ws://voice.test:7880", LiveKitHost.ClientUrlFor("http://127.0.0.1:51234", backend, "wss://voice.example.com", tunnelled: true));

        var yaml = LiveKitHost.TurnYaml(new VoiceSettings { RtcUdpPort = 7882 }, [IPAddress.Parse("192.168.1.20"), IPAddress.Parse("192.168.1.20"), IPAddress.IPv6Loopback]);
        Assert.Contains("udp_port: 7883", yaml);
        Assert.Contains("relay_range_start: 40000", yaml);
        Assert.Contains("allow_restricted_peer_cidrs: [127.0.0.0/8, 192.168.1.20/32]", yaml);
        Assert.Equal(7900, new VoiceSettings { RtcUdpPort = 7882, TurnUdpPort = 7900 }.EffectiveTurnUdpPort);
    }

    private static ProxyProtocol.Header Parse(byte[] bytes, out IPEndPoint? peer, out long consumed) =>
        TunnelListener.TryParse(new ReadOnlySequence<byte>(bytes), out consumed, out peer);

    private static byte[] ProxyV2(byte family, byte[] source, int sourcePort, byte[] destination, int destinationPort, byte command = 0x21)
    {
        var header = new List<byte> { 0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A, command, family };
        var length = source.Length + destination.Length + 4;
        header.AddRange([(byte)(length >> 8), (byte)length]);
        header.AddRange(source);
        header.AddRange(destination);
        header.AddRange([(byte)(sourcePort >> 8), (byte)sourcePort, (byte)(destinationPort >> 8), (byte)destinationPort]);
        return [.. header];
    }

    [Fact]
    public void The_tunnel_listener_reads_proxy_v2_headers_and_refuses_anything_else()
    {
        var v4 = ProxyV2(0x11, [203, 0, 113, 9], 4321, [127, 0, 0, 1], 47070);
        Assert.Equal(ProxyProtocol.Header.Ok, Parse([.. v4, .. "GET /"u8.ToArray()], out var peer, out var consumed));
        Assert.Equal(new IPEndPoint(IPAddress.Parse("203.0.113.9"), 4321), peer);
        Assert.Equal(28, consumed);

        var v6 = ProxyV2(0x21, IPAddress.Parse("2001:db8::9").GetAddressBytes(), 5000, IPAddress.IPv6Loopback.GetAddressBytes(), 47070);
        Assert.Equal(ProxyProtocol.Header.Ok, Parse(v6, out peer, out consumed));
        Assert.Equal(new IPEndPoint(IPAddress.Parse("2001:db8::9"), 5000), peer);
        Assert.Equal(52, consumed);

        Assert.Equal(ProxyProtocol.Header.Incomplete, Parse(v4[..10], out _, out _));
        Assert.Equal(ProxyProtocol.Header.Incomplete, Parse(v4[..20], out _, out _));
        Assert.Equal(ProxyProtocol.Header.Invalid, Parse("GET / HTTP/1.1\r\nHost: x\r\n\r\n"u8.ToArray(), out _, out _));
        Assert.Equal(ProxyProtocol.Header.Invalid, Parse(ProxyV2(0x11, [203, 0, 113, 9], 1, [127, 0, 0, 1], 2, command: 0x20), out _, out _)); // LOCAL
        Assert.Equal(ProxyProtocol.Header.Invalid, Parse(ProxyV2(0x12, [203, 0, 113, 9], 1, [127, 0, 0, 1], 2), out _, out _)); // UDP
        Assert.Equal(ProxyProtocol.Header.Invalid, Parse(ProxyV2(0x31, [1, 2, 3, 4], 1, [5, 6, 7, 8], 2), out _, out _)); // AF_UNIX
    }

    [Fact]
    public async Task The_owner_sees_how_the_servers_own_tunnel_is_doing()
    {
        using var owner = await _server.JoinAsync("Owner", "owner");
        var off = Body(await owner.RequestAsync("p2p.status")).GetProperty("status").GetProperty("tunnel");
        Assert.Equal("off", off.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, off.GetProperty("nat").ValueKind);

        // On, but this test server has no iskra-p2p next to it: the owner is told rather than left waiting.
        Body(await owner.RequestAsync("p2p.set", new { enabled = true }));
        for (var i = 0; i < 100; i++)
        {
            var tunnel = Body(await owner.RequestAsync("p2p.status")).GetProperty("status").GetProperty("tunnel");
            if (tunnel.GetProperty("state").GetString() == "missing") return;
            await Task.Delay(50);
        }
        Assert.Fail("The tunnel's state never became missing.");
    }
}
