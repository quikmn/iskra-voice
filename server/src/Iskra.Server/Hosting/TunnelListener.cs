using System.Buffers;
using System.IO.Pipelines;
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
            if (outcome == ProxyProtocol.Header.Ok)
            {
                input.AdvanceTo(buffer.GetPosition(consumed));
                context.RemoteEndPoint = peer;
                context.Features.Set(new TunnelPeer(peer!));
                break;
            }
            if (outcome == ProxyProtocol.Header.Invalid || result.IsCompleted)
            {
                input.AdvanceTo(buffer.Start, buffer.End);
                context.Abort(new ConnectionAbortedException("Not a PROXY v2 header."));
                return;
            }
            input.AdvanceTo(buffer.Start, buffer.End); // need more bytes
        }
        await next(context);
    };

    /// <summary>PROXY protocol v2 only (the tunnel never sends v1), parsed like the proxy listeners' (see <see cref="ProxyProtocol"/>).</summary>
    internal static ProxyProtocol.Header TryParse(ReadOnlySequence<byte> buffer, out long consumed, out IPEndPoint? peer) =>
        ProxyProtocol.TryParseV2(buffer, out consumed, out peer);
}
