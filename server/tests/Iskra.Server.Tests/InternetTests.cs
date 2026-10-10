using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Hosting;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>A router that does what the test says.</summary>
public sealed class FakeRouter : IPortMapper, INatRouter
{
    public volatile bool Present = true;
    public volatile IPAddress External = IPAddress.Parse("203.0.113.7");
    public volatile bool RefuseLowPorts;
    public TimeSpan? Grant;
    public ConcurrentDictionary<(PortProtocol, int), MappedPort> Mappings { get; } = new();
    public int MapCalls;

    public string Kind => "UPnP";

    public Task<INatRouter?> FindRouterAsync(CancellationToken cancel) => Task.FromResult<INatRouter?>(Present ? this : null);

    public Task<IPAddress> ExternalAddressAsync(CancellationToken cancel) =>
        Present ? Task.FromResult(External) : throw new PortMappingException("The router didn't answer.", refused: false);

    public Task<MappedPort> MapAsync(PortProtocol protocol, int internalPort, int externalPort, TimeSpan lifetime, string description, CancellationToken cancel)
    {
        if (!Present) throw new PortMappingException("The router didn't answer.", refused: false);
        if (RefuseLowPorts && externalPort < 1024) throw new PortMappingException("The router doesn't allow opening this port.");
        Interlocked.Increment(ref MapCalls);
        var mapped = new MappedPort(protocol, internalPort, externalPort, Grant ?? lifetime);
        Mappings[(protocol, externalPort)] = mapped;
        return Task.FromResult(mapped);
    }

    public Task UnmapAsync(MappedPort mapping, CancellationToken cancel)
    {
        Mappings.TryRemove((mapping.Protocol, mapping.ExternalPort), out _);
        return Task.CompletedTask;
    }
}

public class InternetTests : IDisposable
{
    private readonly FakeRouter _router = new();
    private readonly IskraServer _server;

    public InternetTests()
    {
        _server = new IskraServer { PortMapper = _router };
        // Never talk to the real Let's Encrypt from tests: point ACME at a closed port.
        Directory.CreateDirectory(_server.WorldPath);
        File.WriteAllText(Path.Combine(_server.WorldPath, "server.json"), JsonSerializer.Serialize(new
        {
            Port = 47999,
            Voice = new { RtcTcpPort = 7991, RtcUdpPort = 7992 },
            Https = new { AcmeDirectory = "http://127.0.0.1:9/directory" },
        }));
    }

    public void Dispose() => _server.Dispose();

    private static JsonElement Body(JsonElement frame) => frame.GetProperty("body");

    /// <summary>Polls host.status until <paramref name="done"/> holds.</summary>
    private static async Task<JsonElement> StatusUntil(User user, Func<JsonElement, bool> done, string what)
    {
        JsonElement status = default;
        for (var i = 0; i < 150; i++)
        {
            status = Body(await user.RequestAsync("host.status")).GetProperty("status");
            if (done(status)) return status;
            await Task.Delay(100);
        }
        throw new Xunit.Sdk.XunitException($"Timed out waiting for {what}. Last status: {status}");
    }

    private static JsonElement PortNamed(JsonElement status, string name) =>
        status.GetProperty("ports").EnumerateArray().Single(p => p.GetProperty("name").GetString() == name);

    [Fact]
    public async Task Status_is_for_admins_and_switching_is_for_the_owner()
    {
        using var owner = await _server.JoinAsync("Owner", "owner");
        using var admin = await _server.JoinAsync("Admin", "admin");
        using var member = await _server.JoinAsync("Member");

        var denied = await member.RequestAsync("host.status");
        Assert.Equal("error", denied.GetProperty("type").GetString());
        Assert.Equal("forbidden", Body(denied).GetProperty("code").GetString());

        var status = Body(await admin.RequestAsync("host.status")).GetProperty("status");
        Assert.False(status.GetProperty("enabled").GetBoolean());
        Assert.Equal("off", status.GetProperty("router").GetProperty("state").GetString());

        foreach (var who in new[] { admin, member })
        {
            var refused = await who.RequestAsync("host.internet.set", new { enabled = true });
            Assert.Equal("forbidden", Body(refused).GetProperty("code").GetString());
        }
        Assert.False(_server.World.Settings.Internet.Enabled);

        var bad = await owner.RequestAsync("host.internet.set", new { enabled = "yes" });
        Assert.Equal("bad_request", Body(bad).GetProperty("code").GetString());
        var missing = await owner.RequestAsync("host.internet.set", new { });
        Assert.Equal("bad_request", Body(missing).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Opening_maps_the_ports_picks_an_address_and_is_saved()
    {
        using var owner = await _server.JoinAsync("Owner", "owner");
        using var admin = await _server.JoinAsync("Admin", "admin");
        using var member = await _server.JoinAsync("Member");

        var result = await owner.RequestAsync("host.internet.set", new { enabled = true });
        Assert.Equal("result", result.GetProperty("type").GetString());

        var status = await StatusUntil(owner, s => s.GetProperty("ports").GetArrayLength() == 4
            && s.GetProperty("ports").EnumerateArray().All(p => p.GetProperty("state").GetString() == "open"), "every port open");
        Assert.True(status.GetProperty("enabled").GetBoolean());
        Assert.Equal("found", status.GetProperty("router").GetProperty("state").GetString());
        Assert.Equal("UPnP", status.GetProperty("router").GetProperty("kind").GetString());
        Assert.Equal("203.0.113.7", status.GetProperty("publicIp").GetString());
        Assert.False(status.GetProperty("cgnat").GetBoolean());
        Assert.Equal("203-0-113-7.sslip.io", status.GetProperty("address").GetString());
        Assert.True(status.GetProperty("autoAddress").GetBoolean());

        // Outside 80 (Let's Encrypt) and 443 lead to the server's one port; voice ports map straight through.
        Assert.Equal(80, PortNamed(status, "acme").GetProperty("external").GetInt32());
        Assert.Equal(47999, PortNamed(status, "acme").GetProperty("internal").GetInt32());
        Assert.Equal(443, PortNamed(status, "web").GetProperty("external").GetInt32());
        Assert.Equal(7991, PortNamed(status, "voice-tcp").GetProperty("external").GetInt32());
        Assert.Equal("udp", PortNamed(status, "voice-udp").GetProperty("protocol").GetString());
        Assert.True(_router.Mappings.ContainsKey((PortProtocol.Udp, 7992)));

        // The certificate is attempted (and fails here: no Let's Encrypt in tests), honestly reported.
        status = await StatusUntil(owner, s => s.GetProperty("https").GetProperty("state").GetString() == "failed", "the certificate attempt");
        Assert.Equal("203-0-113-7.sslip.io", status.GetProperty("https").GetProperty("domain").GetString());
        Assert.False(string.IsNullOrEmpty(status.GetProperty("https").GetProperty("error").GetString()));
        Assert.Equal("unknown", status.GetProperty("reachable").GetString());

        // Admins hear about changes; members don't.
        await admin.EventAsync("host.status");
        await member.NoEventAsync("host.status");

        // Saved in server.json, next to what was there.
        var saved = JsonNode.Parse(File.ReadAllText(Path.Combine(_server.WorldPath, "server.json")))!;
        Assert.True(saved["Internet"]!["Enabled"]!.GetValue<bool>());
        Assert.Equal(47999, saved["Port"]!.GetValue<int>());

        // Closing removes every mapping.
        await owner.RequestAsync("host.internet.set", new { enabled = false });
        await StatusUntil(owner, s => !s.GetProperty("enabled").GetBoolean(), "hosting off");
        for (var i = 0; i < 50 && !_router.Mappings.IsEmpty; i++) await Task.Delay(100);
        Assert.Empty(_router.Mappings);
        Assert.False(_server.World.Settings.Internet.Enabled);
    }

    [Fact]
    public async Task Carrier_grade_nat_is_detected_and_no_ports_are_opened()
    {
        _router.External = IPAddress.Parse("100.72.10.5");
        using var owner = await _server.JoinAsync("Owner", "owner");
        await owner.RequestAsync("host.internet.set", new { enabled = true });

        var status = await StatusUntil(owner, s => s.GetProperty("cgnat").GetBoolean(), "CGNAT");
        Assert.Equal("100.72.10.5", status.GetProperty("publicIp").GetString());
        Assert.All(status.GetProperty("ports").EnumerateArray(), p => Assert.Equal("skipped", p.GetProperty("state").GetString()));
        Assert.Equal(JsonValueKind.Null, status.GetProperty("address").ValueKind);
        Assert.Equal(JsonValueKind.Null, status.GetProperty("publicUrl").ValueKind);
        Assert.Empty(_router.Mappings);
    }

    [Fact]
    public async Task Without_a_certificate_no_plain_http_address_is_advertised()
    {
        _router.RefuseLowPorts = true;
        using var owner = await _server.JoinAsync("Owner", "owner");
        using var member = await _server.JoinAsync("Member");
        Assert.Equal(JsonValueKind.Null, member.Welcome.GetProperty("body").GetProperty("server").GetProperty("publicUrl").ValueKind);

        await owner.RequestAsync("host.internet.set", new { enabled = true });
        var status = await StatusUntil(owner, s => s.GetProperty("https").GetProperty("state").GetString() == "needs_port_80", "needs port 80");
        Assert.Equal("failed", PortNamed(status, "acme").GetProperty("state").GetString());
        Assert.Contains("doesn't allow", PortNamed(status, "acme").GetProperty("error").GetString());
        Assert.Equal("open", PortNamed(status, "web").GetProperty("state").GetString());
        Assert.Equal(47999, PortNamed(status, "web").GetProperty("external").GetInt32());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("publicUrl").ValueKind);
        await member.NoEventAsync("server.address");
        using var later = await _server.JoinAsync("Later");
        Assert.Equal(JsonValueKind.Null, later.Welcome.GetProperty("body").GetProperty("server").GetProperty("publicUrl").ValueKind);

        // Only an address the owner set by hand is used (the panel warns that it's plain HTTP).
        _server.World.UpdateSettings(s => s with { PublicUrl = "http://203.0.113.7:47999/" });
        status = Body(await owner.RequestAsync("host.internet.set", new { enabled = true })).GetProperty("status");
        Assert.Equal("http://203.0.113.7:47999", status.GetProperty("publicUrl").GetString());
        Assert.Equal("http://203.0.113.7:47999", Body(await member.EventAsync("server.address")).GetProperty("publicUrl").GetString());
    }

    [Fact]
    public async Task Leases_are_renewed_before_they_run_out()
    {
        _router.Grant = TimeSpan.FromSeconds(2);
        using var owner = await _server.JoinAsync("Owner", "owner");
        await owner.RequestAsync("host.internet.set", new { enabled = true });
        await StatusUntil(owner, s => s.GetProperty("ports").GetArrayLength() == 4, "ports");
        var first = Volatile.Read(ref _router.MapCalls);
        for (var i = 0; i < 60 && Volatile.Read(ref _router.MapCalls) < first + 4; i++) await Task.Delay(100);
        Assert.True(Volatile.Read(ref _router.MapCalls) >= first + 4, "Mappings weren't renewed at half their lease.");
    }

    [Fact]
    public async Task A_new_public_ip_moves_the_address_and_a_lost_router_is_found_again()
    {
        var internet = (InternetHost)_server.Services.GetService(typeof(InternetHost))!;
        var voiceChanges = 0;
        internet.VoiceIpChanged += () => Interlocked.Increment(ref voiceChanges);
        using var owner = await _server.JoinAsync("Owner", "owner");
        await owner.RequestAsync("host.internet.set", new { enabled = true });
        await StatusUntil(owner, s => s.GetProperty("address").GetString() == "203-0-113-7.sslip.io", "the first address");
        Assert.Equal(IPAddress.Parse("203.0.113.7"), internet.VoiceIp);

        // The router restarts and comes back with another address (and without our mappings).
        _router.Present = false;
        _router.Mappings.Clear();
        await owner.RequestAsync("host.internet.set", new { enabled = true }); // "try again"
        await StatusUntil(owner, s => s.GetProperty("router").GetProperty("state").GetString() == "not_found", "the router to go missing");

        _router.External = IPAddress.Parse("198.51.100.20");
        _router.Present = true;
        await owner.RequestAsync("host.internet.set", new { enabled = true });
        var status = await StatusUntil(owner, s => s.GetProperty("address").GetString() == "198-51-100-20.sslip.io", "the new address");
        Assert.Equal("198.51.100.20", status.GetProperty("publicIp").GetString());
        Assert.Equal(4, _router.Mappings.Count); // re-mapped
        Assert.Equal(IPAddress.Parse("198.51.100.20"), internet.VoiceIp);
        Assert.True(voiceChanges >= 2);
    }

    [Fact]
    public async Task Without_a_router_the_owner_gets_the_ports_to_forward_by_hand()
    {
        _router.Present = false;
        using var owner = await _server.JoinAsync("Owner", "owner");
        await owner.RequestAsync("host.internet.set", new { enabled = true });
        var status = await StatusUntil(owner, s => s.GetProperty("router").GetProperty("state").GetString() == "not_found", "no router");
        Assert.All(status.GetProperty("ports").EnumerateArray(), p => Assert.Equal("manual", p.GetProperty("state").GetString()));
        Assert.Equal(JsonValueKind.Null, status.GetProperty("publicUrl").ValueKind);
        Assert.Equal(JsonValueKind.Null, status.GetProperty("publicIp").ValueKind);
    }

    [Fact]
    public void Port_plan_follows_the_settings()
    {
        var plan = InternetHost.Plan(new WorldSettings { Port = 47070 });
        Assert.Equal(["acme", "web", "voice-tcp", "voice-udp"], plan.Select(p => p.Name));
        Assert.Equal([443, 47070], plan.Single(p => p.Name == "web").Externals);

        var manual = InternetHost.Plan(new WorldSettings
        {
            Https = new HttpsSettings { Mode = "files", Port = 8443 },
            Voice = new VoiceSettings { Enabled = false },
        });
        Assert.Equal(["web"], manual.Select(p => p.Name));
        Assert.Equal(8443, manual[0].Internal);
    }

    [Fact]
    public void Shared_and_private_addresses_count_as_not_public()
    {
        foreach (var ip in new[] { "10.1.2.3", "100.64.0.1", "100.127.255.254", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.1.1", "0.0.0.0" })
            Assert.True(Networks.IsNonPublic(IPAddress.Parse(ip)), ip);
        foreach (var ip in new[] { "100.63.255.255", "100.128.0.1", "203.0.113.7", "8.8.8.8", "172.32.0.1" })
            Assert.False(Networks.IsNonPublic(IPAddress.Parse(ip)), ip);
        Assert.Equal("203-0-113-7", Networks.Dashed(IPAddress.Parse("203.0.113.7")));
    }

    [Fact]
    public void LiveKit_advertises_the_public_ip_and_keeps_the_lan_one()
    {
        var yaml = Iskra.Server.Voice.LiveKitHost.RtcAddressYaml(IPAddress.Parse("203.0.113.7"), "http://192.168.1.5:47070");
        Assert.Contains("node_ip: 203.0.113.7", yaml);
        Assert.Contains("advertise_internal_ip: true", yaml);
        Assert.Contains("use_external_ip: false", yaml);
        Assert.Equal("use_external_ip: false", Iskra.Server.Voice.LiveKitHost.RtcAddressYaml(null, "http://192.168.1.5:47070"));
    }
}
