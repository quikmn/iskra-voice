using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace Iskra.Server.Hosting;

/// <summary>
/// NAT-PMP (RFC 6886): small UDP requests to the default gateway on port 5351. Apple routers and many
/// open-source ones (miniupnpd, which also answers PCP clients this way) speak it.
/// </summary>
public sealed class NatPmp(IPEndPoint gateway) : INatRouter
{
    public const int Port = 5351;
    private const byte OpExternalAddress = 0, OpUdp = 1, OpTcp = 2;

    public string Kind => "NAT-PMP";
    public IPEndPoint Gateway { get; } = gateway;

    /// <summary>The first gateway that answers an external-address request.</summary>
    public static async Task<INatRouter?> DiscoverAsync(IEnumerable<IPAddress> gateways, CancellationToken cancel, int port = Port)
    {
        var probes = gateways.Select(async g =>
        {
            var router = new NatPmp(new IPEndPoint(g, port));
            try
            {
                await router.ExternalAddressAsync(cancel, attempts: 3);
                return router;
            }
            catch (PortMappingException)
            {
                return null;
            }
            catch (SocketException)
            {
                return null;
            }
        }).ToList();
        while (probes.Count > 0)
        {
            var done = await Task.WhenAny(probes);
            probes.Remove(done);
            if (await done is { } router) return router;
        }
        return null;
    }

    public Task<IPAddress> ExternalAddressAsync(CancellationToken cancel) => ExternalAddressAsync(cancel, attempts: 4);

    private async Task<IPAddress> ExternalAddressAsync(CancellationToken cancel, int attempts)
    {
        var reply = await SendAsync([0, OpExternalAddress], OpExternalAddress, 12, attempts, cancel);
        return new IPAddress(reply.AsSpan(8, 4));
    }

    public async Task<MappedPort> MapAsync(PortProtocol protocol, int internalPort, int externalPort, TimeSpan lifetime, string description,
        CancellationToken cancel)
    {
        var seconds = (uint)Math.Max(1, lifetime.TotalSeconds); // 0 would mean "delete"
        var reply = await SendAsync(MapRequest(protocol, internalPort, externalPort, seconds), Op(protocol), 16, 4, cancel);
        var mapped = BinaryPrimitives.ReadUInt16BigEndian(reply.AsSpan(10));
        var granted = BinaryPrimitives.ReadUInt32BigEndian(reply.AsSpan(12));
        return new MappedPort(protocol, internalPort, mapped, TimeSpan.FromSeconds(granted));
    }

    public async Task UnmapAsync(MappedPort mapping, CancellationToken cancel) =>
        await SendAsync(MapRequest(mapping.Protocol, mapping.InternalPort, 0, 0), Op(mapping.Protocol), 16, 2, cancel);

    private static byte Op(PortProtocol protocol) => protocol == PortProtocol.Tcp ? OpTcp : OpUdp;

    internal static byte[] MapRequest(PortProtocol protocol, int internalPort, int externalPort, uint lifetime)
    {
        var request = new byte[12];
        request[1] = Op(protocol);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(4), (ushort)internalPort);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(6), (ushort)externalPort);
        BinaryPrimitives.WriteUInt32BigEndian(request.AsSpan(8), lifetime);
        return request;
    }

    /// <summary>Sends with the RFC's retry schedule (250 ms, doubling) until a matching answer arrives.</summary>
    private async Task<byte[]> SendAsync(byte[] request, byte op, int replyLength, int attempts, CancellationToken cancel)
    {
        using var udp = new UdpClient(Gateway.AddressFamily);
        udp.Connect(Gateway); // replies from anyone else are dropped
        var delay = TimeSpan.FromMilliseconds(250);
        for (var attempt = 0; attempt < attempts; attempt++, delay *= 2)
        {
            await udp.SendAsync(request, cancel);
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            wait.CancelAfter(delay);
            try
            {
                while (true)
                {
                    var result = await udp.ReceiveAsync(wait.Token);
                    var reply = result.Buffer;
                    if (reply.Length < replyLength || reply[0] != 0 || reply[1] != 128 + op) continue;
                    var code = BinaryPrimitives.ReadUInt16BigEndian(reply.AsSpan(2));
                    if (code != 0) throw new PortMappingException(Explain(code));
                    return reply;
                }
            }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested) { }
            catch (SocketException) when (attempt < attempts - 1) { } // ICMP port unreachable: nothing listening (yet)
        }
        throw new PortMappingException("The router didn't answer.", refused: false);
    }

    internal static string Explain(int code) => code switch
    {
        2 => "The router doesn't allow opening this port.",
        3 => "The router isn't connected to the internet right now.",
        4 => "The router has no room for more port forwards.",
        _ => $"The router said no (NAT-PMP error {code}).",
    };
}
