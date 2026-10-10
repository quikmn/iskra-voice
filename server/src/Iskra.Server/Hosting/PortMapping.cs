using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Iskra.Server.Hosting;

public enum PortProtocol { Tcp, Udp }

/// <summary>A port mapping the router agreed to. <see cref="Lifetime"/> is zero for "until removed".</summary>
public sealed record MappedPort(PortProtocol Protocol, int InternalPort, int ExternalPort, TimeSpan Lifetime);

/// <summary>The router said no. <see cref="Refused"/> separates a definite refusal from "didn't answer".</summary>
public class PortMappingException(string message, bool refused = true, Exception? inner = null) : Exception(message, inner)
{
    public bool Refused { get; } = refused;
}

/// <summary>A home router that opens ports on request (UPnP IGD or NAT-PMP).</summary>
public interface INatRouter
{
    /// <summary>"UPnP" or "NAT-PMP", shown to the owner.</summary>
    string Kind { get; }

    /// <summary>The router's own internet-side address (may itself be private behind carrier-grade NAT).</summary>
    Task<IPAddress> ExternalAddressAsync(CancellationToken cancel);

    Task<MappedPort> MapAsync(PortProtocol protocol, int internalPort, int externalPort, TimeSpan lifetime, string description, CancellationToken cancel);

    Task UnmapAsync(MappedPort mapping, CancellationToken cancel);
}

/// <summary>Finds the router. Tests swap in a fake.</summary>
public interface IPortMapper
{
    /// <summary>The first router that answers, or null if none does.</summary>
    Task<INatRouter?> FindRouterAsync(CancellationToken cancel);
}

/// <summary>Looks for a UPnP router and a NAT-PMP gateway at the same time; UPnP wins when both answer.</summary>
public sealed class PortMapper(ILogger<PortMapper> log) : IPortMapper
{
    private static readonly TimeSpan SearchTime = TimeSpan.FromSeconds(3);
    // Routers are on the LAN: no proxy, short timeouts.
    private static readonly HttpClient Http = new(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false })
    {
        Timeout = TimeSpan.FromSeconds(5),
    };

    public async Task<INatRouter?> FindRouterAsync(CancellationToken cancel)
    {
        var http = Http;
        var upnp = Upnp.DiscoverAsync(http, SearchTime, log, cancel);
        var pmp = NatPmp.DiscoverAsync(Networks.Gateways(), cancel);
        try
        {
            return await upnp ?? await pmp;
        }
        catch (Exception ex) when (ex is SocketException or HttpRequestException or IOException)
        {
            log.LogInformation(ex, "Looking for the router failed");
            return null;
        }
    }
}

public static class Networks
{
    /// <summary>A private, shared (carrier-grade NAT), loopback or otherwise non-routable IPv4 address.</summary>
    public static bool IsNonPublic(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.AddressFamily != AddressFamily.InterNetwork) return ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6UniqueLocal;
        var b = ip.GetAddressBytes();
        return b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224
            || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)      // 100.64.0.0/10: carrier-grade NAT
            || (b[0] == 169 && b[1] == 254)
            || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 192 && b[1] == 0 && b[2] == 0);
    }

    /// <summary>Private LAN ranges a home router hands out (not loopback, not carrier-grade NAT).</summary>
    public static bool IsLan(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254);
    }

    /// <summary>Up, non-loopback IPv4 interfaces with a default gateway: (local address, gateway).</summary>
    public static List<(IPAddress Local, IPAddress Gateway)> Interfaces()
    {
        var result = new List<(IPAddress, IPAddress)>();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                var props = nic.GetIPProperties();
                var gateway = props.GatewayAddresses.Select(g => g.Address)
                    .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !a.Equals(IPAddress.Any));
                var local = props.UnicastAddresses.Select(u => u.Address).FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork);
                if (gateway is not null && local is not null) result.Add((local, gateway));
            }
        }
        catch (NetworkInformationException) { }
        return result;
    }

    public static List<IPAddress> Gateways() => Interfaces().Select(i => i.Gateway).Distinct().ToList();

    /// <summary>The address friends on the same network use: the private IPv4 of the interface with a gateway.</summary>
    public static IPAddress? LanAddress() =>
        Interfaces().Select(i => i.Local).FirstOrDefault(IsLan);

    /// <summary>1.2.3.4 → "1-2-3-4", the form wildcard-DNS services (sslip.io) resolve back to the address.</summary>
    public static string Dashed(IPAddress ip) => ip.ToString().Replace('.', '-').Replace(':', '-');
}
