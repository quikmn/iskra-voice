using System.Net;
using System.Text.RegularExpressions;
using Iskra.Server.Features;
using Iskra.Server.Hosting;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class AddressLimitTests
{
    [Fact]
    public void Regression_ipv6_addresses_share_a_limit_per_64_and_mapped_ipv4_is_plain_ipv4()
    {
        Assert.Equal(AddressLimits.Key(IPAddress.Parse("2001:db8:1:2::1")), AddressLimits.Key(IPAddress.Parse("2001:db8:1:2:ffff::9")));
        Assert.NotEqual(AddressLimits.Key(IPAddress.Parse("2001:db8:1:2::1")), AddressLimits.Key(IPAddress.Parse("2001:db8:1:3::1")));
        Assert.Equal("2001:db8:1:2::/64", AddressLimits.Key(IPAddress.Parse("2001:db8:1:2:abcd::1")));
        Assert.Equal("192.0.2.4", AddressLimits.Key(IPAddress.Parse("::ffff:192.0.2.4")));
        Assert.Equal("192.0.2.4", AddressLimits.Key(IPAddress.Parse("192.0.2.4")));
        Assert.Equal("local", AddressLimits.Key((IPAddress?)null));
        Assert.Equal(IPAddress.Parse("2001:db8:1:2::"), AddressLimits.Network(IPAddress.Parse("2001:db8:1:2:1:2:3:4")));
        Assert.Equal(AddressLimits.Network(IPAddress.Parse("2001:db8::1")), BugInbox.LimitKey(IPAddress.Parse("2001:db8::77")));
    }

    [Fact]
    public void Regression_a_flood_of_fresh_addresses_doesnt_reset_the_limited_ones()
    {
        var table = new BoundedTable<string, WebhookIngress.TokenBucket>(100, b => b.Available);
        WebhookIngress.TokenBucket Bucket(string key) => table.GetOrAdd(key, _ => new WebhookIngress.TokenBucket(3, 1 / 3600.0, TimeProvider.System));
        for (var i = 0; i < 3; i++) Assert.True(Bucket("attacker").TryTake(out _));
        Assert.False(Bucket("attacker").TryTake(out _));

        for (var i = 0; i < 1000; i++) Bucket($"fresh-{i}").TryTake(out _);

        Assert.True(table.Count <= 100);
        Assert.True(table.Contains("attacker"));
        Assert.False(Bucket("attacker").TryTake(out _)); // still limited (the old table was cleared at its cap)
    }

    [Fact]
    public void Regression_fetches_checked_for_public_addresses_never_go_through_a_proxy()
    {
        // The public-address check runs on the address connected to: through a proxy that's the proxy, not the target.
        var dir = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Repo.ProtocolFile("PROTOCOL.md")))!, "server", "src", "Iskra.Server");
        var checkedHandlers = 0;
        foreach (var file in Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains("bin") && !f.Contains("obj")))
            foreach (Match m in Regex.Matches(File.ReadAllText(file), @"new SocketsHttpHandler\s*\{(?<body>[^}]*)\}"))
            {
                var body = m.Groups["body"].Value;
                if (!body.Contains("ConnectCallback")) continue;
                checkedHandlers++;
                Assert.True(body.Contains("UseProxy = false"), $"{Path.GetFileName(file)}: a handler with a ConnectCallback must set UseProxy = false");
            }
        Assert.True(checkedHandlers >= 6, $"{checkedHandlers} handlers found");
    }
}
