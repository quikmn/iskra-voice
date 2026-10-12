using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace Iskra.Server.Hosting;

/// <summary>
/// Tailscale, the recommended "gaming VPN" for hosts behind CGNAT. Found from this computer's own network interfaces
/// only: Iskra never asks Tailscale's API, its local daemon or anything on the network.
/// </summary>
public static partial class Tailscale
{
    /// <summary>One IPv4 address on a network interface, as far as detection cares.</summary>
    public readonly record struct Nic(string Name, string Description, IPAddress Address, bool HasGateway);

    /// <summary>100.64.0.0/10: the shared (carrier-grade NAT) range, which Tailscale hands its devices addresses from.</summary>
    public static bool InRange(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return b[0] == 100 && b[1] >= 64 && b[1] <= 127;
    }

    /// <summary>A host name or address that only reaches us over Tailscale: a 100.64.0.0/10 address or a MagicDNS name.</summary>
    public static bool IsTailscaleHost(string host)
    {
        host = host.Trim('[', ']').TrimEnd('.');
        if (IPAddress.TryParse(host, out var ip)) return InRange(ip);
        return host.EndsWith(".ts.net", StringComparison.OrdinalIgnoreCase);
    }

    // The adapter is "Tailscale" on Windows and tailscale0 on Linux; macOS gives it a plain utunN.
    [GeneratedRegex("tailscale", RegexOptions.IgnoreCase)]
    private static partial Regex NamedTailscale();

    [GeneratedRegex(@"^utun\d+$")]
    private static partial Regex Utun();

    /// <summary>
    /// This computer's Tailscale address: a 100.64.0.0/10 address on an interface without a default gateway (a
    /// provider's CGNAT address on the real network card has one), named like Tailscale's adapter. Null if none.
    /// </summary>
    public static IPAddress? Pick(IEnumerable<Nic> nics)
    {
        var candidates = nics
            .Where(n => InRange(n.Address) && !n.HasGateway && !n.Address.Equals(MagicDns))
            .ToList();
        return candidates.FirstOrDefault(n => NamedTailscale().IsMatch(n.Name) || NamedTailscale().IsMatch(n.Description)).Address
            ?? candidates.FirstOrDefault(n => Utun().IsMatch(n.Name)).Address;
    }

    /// <summary>Tailscale's own DNS resolver address, never a device's.</summary>
    private static readonly IPAddress MagicDns = IPAddress.Parse("100.100.100.100");

    /// <summary>This computer's Tailscale address right now (see <see cref="Pick"/>).</summary>
    public static IPAddress? LocalAddress()
    {
        var nics = new List<Nic>();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                var props = nic.GetIPProperties();
                var hasGateway = props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any));
                foreach (var unicast in props.UnicastAddresses)
                    if (unicast.Address.AddressFamily == AddressFamily.InterNetwork)
                        nics.Add(new Nic(nic.Name, nic.Description, unicast.Address, hasGateway));
            }
        }
        catch (NetworkInformationException) { }
        return Pick(nics);
    }
}
