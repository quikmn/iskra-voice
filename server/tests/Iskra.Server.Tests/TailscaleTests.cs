using System.Net;
using Iskra.Server.Hosting;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;

namespace Iskra.Server.Tests;

/// <summary>Hosting over Tailscale: finding its address locally, and voice that works over it.</summary>
public class TailscaleTests
{
    private static Tailscale.Nic Nic(string name, string ip, bool gateway = false, string description = "") =>
        new(name, description, IPAddress.Parse(ip), gateway);

    [Theory]
    [InlineData("100.64.0.1", true)]
    [InlineData("100.101.102.103", true)]
    [InlineData("100.127.255.254", true)]
    [InlineData("100.63.255.255", false)]
    [InlineData("100.128.0.1", false)]
    [InlineData("192.168.1.20", false)]
    public void Knows_the_shared_range(string ip, bool inRange) => Assert.Equal(inRange, Tailscale.InRange(IPAddress.Parse(ip)));

    [Fact]
    public void Finds_the_tailscale_adapter_on_each_system()
    {
        // Windows: an adapter called "Tailscale"; Linux: tailscale0; macOS: a utun interface.
        Assert.Equal("100.101.102.103", Tailscale.Pick([Nic("Ethernet", "192.168.1.20", gateway: true), Nic("Tailscale", "100.101.102.103", description: "Tailscale Tunnel")])?.ToString());
        Assert.Equal("100.88.1.2", Tailscale.Pick([Nic("eth0", "10.0.0.5", gateway: true), Nic("tailscale0", "100.88.1.2")])?.ToString());
        Assert.Equal("100.70.0.9", Tailscale.Pick([Nic("en0", "192.168.0.3", gateway: true), Nic("utun4", "100.70.0.9")])?.ToString());
        // Named by its description only (a renamed Windows adapter).
        Assert.Equal("100.70.0.10", Tailscale.Pick([Nic("Ethernet 3", "100.70.0.10", description: "Tailscale Tunnel")])?.ToString());
    }

    [Fact]
    public void A_provider_cgnat_address_is_not_tailscale()
    {
        // The ISP's shared address straight on the network card has a gateway, and isn't Tailscale's adapter.
        Assert.Null(Tailscale.Pick([Nic("Ethernet", "100.72.10.20", gateway: true)]));
        Assert.Null(Tailscale.Pick([Nic("eth0", "100.72.10.20")]));
        Assert.Null(Tailscale.Pick([Nic("Tailscale", "100.72.10.20", gateway: true)]));
        // Not in the range, or Tailscale's own DNS address.
        Assert.Null(Tailscale.Pick([Nic("Tailscale", "192.168.5.5")]));
        Assert.Null(Tailscale.Pick([Nic("Tailscale", "100.100.100.100")]));
        Assert.Null(Tailscale.Pick([]));
    }

    [Fact]
    public void Prefers_the_named_adapter_over_a_utun()
    {
        Assert.Equal("100.80.0.2", Tailscale.Pick([Nic("utun2", "100.90.0.1"), Nic("Tailscale", "100.80.0.2")])?.ToString());
    }

    [Theory]
    [InlineData("100.101.102.103", true)]
    [InlineData("my-pc.tail1234.ts.net", true)]
    [InlineData("MY-PC.TAIL1234.TS.NET.", true)]
    [InlineData("192.168.1.20", false)]
    [InlineData("chat.example.com", false)]
    [InlineData("ts.net.example.com", false)]
    public void Knows_tailscale_hosts(string host, bool tailscale) => Assert.Equal(tailscale, Tailscale.IsTailscaleHost(host));

    // Regression: a PublicUrl on a Tailscale address counted as public, so LiveKit advertised the home's CGNAT address
    // (found by STUN) and voice failed.
    [Theory]
    [InlineData("http://100.101.102.103:47070")]
    [InlineData("http://100.64.0.1:47070")]
    [InlineData("http://my-pc.tail1234.ts.net:47070")]
    [InlineData("http://10.0.0.2:47070")]
    [InlineData("http://127.0.0.1:47070")]
    public void LiveKit_advertises_interface_addresses_for_tailscale_and_lan(string publicUrl)
    {
        Assert.True(LiveKitHost.IsLocalOnly(publicUrl));
        Assert.Equal("use_external_ip: false", LiveKitHost.RtcAddressYaml(null, publicUrl));
    }

    [Theory]
    [InlineData("https://chat.example.com")]
    [InlineData("http://203.0.113.5:47070")]
    [InlineData("http://100.128.0.1:47070")]
    public void LiveKit_still_finds_the_public_address_on_the_internet(string publicUrl)
    {
        Assert.False(LiveKitHost.IsLocalOnly(publicUrl));
        Assert.Equal("use_external_ip: true", LiveKitHost.RtcAddressYaml(null, publicUrl));
    }

    [Fact]
    public void Voice_goes_through_the_address_a_tailscale_friend_used()
    {
        var backend = new FakeVoiceBackend(); // its own URL: ws://voice.test:7880
        Assert.Equal("ws://100.101.102.103:47070/livekit", LiveKitHost.ClientUrlFor("http://100.101.102.103:47070", backend, null));
        Assert.Equal("ws://my-pc.tail1234.ts.net:47070/livekit", LiveKitHost.ClientUrlFor("http://my-pc.tail1234.ts.net:47070", backend, null));
        Assert.Equal("wss://chat.example.com/livekit", LiveKitHost.ClientUrlFor("https://chat.example.com", backend, null));
        // On the LAN or localhost: the server's own voice URL, as before.
        Assert.Equal("ws://voice.test:7880", LiveKitHost.ClientUrlFor("http://192.168.1.20:47070", backend, null));
        Assert.Equal("ws://voice.test:7880", LiveKitHost.ClientUrlFor(null, backend, null));
        // A voice URL set by hand always wins.
        Assert.Equal("ws://voice.test:7880", LiveKitHost.ClientUrlFor("http://100.101.102.103:47070", backend, "wss://voice.example.com"));
    }

    [Fact]
    public void No_tailscale_invite_for_a_localhost_only_server()
    {
        Assert.Null(InternetHost.TailscaleUrl(new WorldSettings { LocalOnly = true, Port = 47070 }));
    }
}
