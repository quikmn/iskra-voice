using System.Buffers;
using System.IO.Pipelines;
using System.Buffers.Binary;
using System.Net;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Server.Kestrel.Core;

namespace Iskra.Server.Hosting;

/// <summary>A connection that came through the peer-to-peer tunnel, and the friend's address as the tunnel saw it.</summary>
public sealed record TunnelPeer(IPEndPoint Address);

/// <summary>
/// The tunnel listener: a second Kestrel endpoint on 127.0.0.1 for the peer-to-peer tunnel in the host's desktop
/// app (PROTOCOL.md, "Connecting without port forwarding"). Every connection starts with a PROXY protocol v2 header
/// naming the friend's address; that becomes the connection's remote address, so tunnelled friends count as remote
/// everywhere (loopback-only endpoints, rate limits, the security log) and never as the host's own machine.
/// </summary>
public sealed class TunnelListener
{
    public const string PortFile = "p2p.port";
    private static readonly TimeSpan HeaderTimeout = TimeSpan.FromSeconds(10);
    private static ReadOnlySpan<byte> Signature => [0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A];

    /// <summary>The endpoint's options; Kestrel fills in the port it bound (TunnelPort 0 = any).</summary>
    public ListenOptions? Options { get; set; }

    public int Port => Options?.IPEndPoint?.Port ?? 0;

    /// <summary>Once the server listens: tell the desktop app which port the tunnel should reach.</summary>
    public void Started(string worldPath)
    {
        if (Port > 0) Storage.AtomicFile.WriteAllText(Path.Combine(worldPath, PortFile), $"{Port}\n");
    }

    public static ConnectionDelegate Middleware(ConnectionDelegate next) => async context =>
    {
        var input = context.Transport.Input;
        using var timeout = new CancellationTokenSource(HeaderTimeout);
        while (true)
        {
            ReadResult result;
            try
            {
                result = await input.ReadAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                context.Abort(new ConnectionAbortedException("No PROXY header on the tunnel listener."));
                return;
            }
            var buffer = result.Buffer;
            var outcome = TryParse(buffer, out var consumed, out var peer);
            if (outcome == Header.Ok)
            {
                input.AdvanceTo(buffer.GetPosition(consumed));
                context.RemoteEndPoint = peer;
                context.Features.Set(new TunnelPeer(peer!));
                break;
            }
            if (outcome == Header.Invalid || result.IsCompleted)
            {
                input.AdvanceTo(buffer.Start, buffer.End);
                context.Abort(new ConnectionAbortedException("Not a PROXY v2 header."));
                return;
            }
            input.AdvanceTo(buffer.Start, buffer.End); // need more bytes
        }
        await next(context);
    };

    internal enum Header { Ok, Incomplete, Invalid }

    /// <summary>PROXY protocol v2, command PROXY, TCP over IPv4 or IPv6. Anything else is refused.</summary>
    internal static Header TryParse(ReadOnlySequence<byte> buffer, out long consumed, out IPEndPoint? peer)
    {
        consumed = 0;
        peer = null;
        if (buffer.Length < 16) return Header.Incomplete;
        Span<byte> head = stackalloc byte[16];
        buffer.Slice(0, 16).CopyTo(head);
        if (!head[..12].SequenceEqual(Signature) || head[12] != 0x21) return Header.Invalid;
        var family = head[13];
        var length = BinaryPrimitives.ReadUInt16BigEndian(head[14..16]);
        int addressBytes;
        switch (family)
        {
            case 0x11: addressBytes = 4; break;
            case 0x21: addressBytes = 16; break;
            default: return Header.Invalid;
        }
        if (length < addressBytes * 2 + 4) return Header.Invalid;
        if (buffer.Length < 16 + length) return Header.Incomplete;
        Span<byte> addresses = stackalloc byte[addressBytes * 2 + 4];
        buffer.Slice(16, addresses.Length).CopyTo(addresses);
        var source = new IPAddress(addresses[..addressBytes]);
        var port = BinaryPrimitives.ReadUInt16BigEndian(addresses[(addressBytes * 2)..]);
        peer = new IPEndPoint(source.IsIPv4MappedToIPv6 ? source.MapToIPv4() : source, port);
        consumed = 16 + length;
        return Header.Ok;
    }
}
