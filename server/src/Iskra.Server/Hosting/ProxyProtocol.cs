using System.Buffers;
using System.Buffers.Binary;
using System.IO.Pipelines;
using System.Net;
using System.Text;
using Microsoft.AspNetCore.Connections;

namespace Iskra.Server.Hosting;

/// <summary>A connection relayed by a trusted proxy (Https.ProxyProtocol): the client's address it named, and the proxy's own.</summary>
public sealed record ProxiedPeer(IPEndPoint Address, IPEndPoint Proxy);

/// <summary>
/// PROXY protocol (HAProxy's, versions 1 and 2) on the HTTPS and plain HTTP listeners, for a reverse proxy on this
/// machine that passes TLS through (nginx <c>stream</c> with <c>ssl_preread</c> and <c>proxy_protocol on</c>, HAProxy
/// <c>send-proxy</c>). Only connections from <see cref="HttpsSettings.ProxyTrustedFrom"/> are taken, and each must start
/// with a header; the address in it becomes the connection's remote address, so rate limits and the security log see
/// the real client, and the client never counts as this machine (see <see cref="Networks.IsElsewhere"/>).
/// </summary>
public static class ProxyProtocol
{
    private static readonly TimeSpan HeaderTimeout = TimeSpan.FromSeconds(10);
    private static ReadOnlySpan<byte> SignatureV2 => [0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A];
    private static ReadOnlySpan<byte> PrefixV1 => "PROXY "u8;
    /// <summary>The longest v1 header the spec allows, CRLF included.</summary>
    private const int MaxV1 = 107;
    /// <summary>v2 headers carry TLVs after the addresses; nothing we take needs more than this.</summary>
    private const int MaxV2Length = 2048;

    public enum Header { Ok, Incomplete, Invalid }

    /// <summary>The addresses a header may come from: Https.ProxyTrustedFrom (IPs; IPv4-mapped IPv6 counts as IPv4).</summary>
    public static IReadOnlyList<IPAddress> Trusted(IEnumerable<string> from)
    {
        var list = new List<IPAddress>();
        foreach (var text in from)
        {
            if (!IPAddress.TryParse(text?.Trim(), out var ip))
                throw new InvalidDataException($"Https.ProxyTrustedFrom: \"{text}\" isn't an IP address.");
            list.Add(Normal(ip));
        }
        if (list.Count == 0) throw new InvalidDataException("Https.ProxyTrustedFrom is empty: no proxy could connect.");
        return list;
    }

    private static IPAddress Normal(IPAddress ip) => ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip;

    /// <summary>
    /// Kestrel connection middleware, before TLS: drops a connection from an untrusted address, or one without a valid
    /// header within 10 seconds; otherwise strips the header and carries on as the client it names.
    /// </summary>
    public static Func<ConnectionDelegate, ConnectionDelegate> Middleware(IReadOnlyList<IPAddress> trusted, ILogger log) => next => async context =>
    {
        if (context.RemoteEndPoint is not IPEndPoint proxy || !trusted.Contains(Normal(proxy.Address)))
        {
            Refused(log, "it doesn't come from an address in Https.ProxyTrustedFrom");
            context.Abort(new ConnectionAbortedException("Not from a trusted proxy."));
            return;
        }
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
                Refused(log, "no PROXY protocol header arrived");
                context.Abort(new ConnectionAbortedException("No PROXY header."));
                return;
            }
            var buffer = result.Buffer;
            var outcome = TryParse(buffer, out var consumed, out var peer);
            if (outcome == Header.Ok)
            {
                input.AdvanceTo(buffer.GetPosition(consumed));
                context.RemoteEndPoint = peer;
                context.Features.Set(new ProxiedPeer(peer!, proxy));
                break;
            }
            if (outcome == Header.Invalid || result.IsCompleted)
            {
                input.AdvanceTo(buffer.Start, buffer.End);
                if (outcome == Header.Invalid) Refused(log, "it didn't start with a PROXY protocol header (v1 or v2, TCP)");
                context.Abort(new ConnectionAbortedException("Not a PROXY header."));
                return;
            }
            input.AdvanceTo(buffer.Start, buffer.End); // need more bytes
        }
        await next(context);
    };

    private static long _lastWarning;

    /// <summary>A misconfigured proxy shows up in the log, at most once a minute (no addresses: see docs/compliance).</summary>
    private static void Refused(ILogger log, string why)
    {
        var now = Environment.TickCount64;
        var last = Interlocked.Read(ref _lastWarning);
        if (last != 0 && now - last < 60_000) return;
        if (Interlocked.CompareExchange(ref _lastWarning, now, last) != last) return;
        log.Warn("TLS-150", "http", "dropped", ("what", "proxy-protocol"), ("why", why));
    }

    /// <summary>A PROXY protocol v1 or v2 header for a TCP connection over IPv4 or IPv6. Anything else is refused.</summary>
    public static Header TryParse(ReadOnlySequence<byte> buffer, out long consumed, out IPEndPoint? peer)
    {
        consumed = 0;
        peer = null;
        if (buffer.Length == 0) return Header.Incomplete;
        var first = buffer.FirstSpan[0];
        if (first == SignatureV2[0]) return TryParseV2(buffer, out consumed, out peer);
        if (first == PrefixV1[0]) return TryParseV1(buffer, out consumed, out peer);
        return Header.Invalid;
    }

    /// <summary>Version 2 (binary), command PROXY, TCP over IPv4 or IPv6; TLVs after the addresses are skipped.</summary>
    public static Header TryParseV2(ReadOnlySequence<byte> buffer, out long consumed, out IPEndPoint? peer)
    {
        consumed = 0;
        peer = null;
        Span<byte> head = stackalloc byte[16];
        var have = (int)Math.Min(buffer.Length, 16);
        buffer.Slice(0, have).CopyTo(head);
        var signature = Math.Min(have, 12);
        if (!head[..signature].SequenceEqual(SignatureV2[..signature])) return Header.Invalid;
        if (have < 16) return Header.Incomplete;
        if (head[12] != 0x21) return Header.Invalid; // version 2, command PROXY (LOCAL has no client to name)
        var family = head[13];
        var length = BinaryPrimitives.ReadUInt16BigEndian(head[14..16]);
        int addressBytes;
        switch (family)
        {
            case 0x11: addressBytes = 4; break;  // TCP over IPv4
            case 0x21: addressBytes = 16; break; // TCP over IPv6
            default: return Header.Invalid;
        }
        if (length < addressBytes * 2 + 4 || length > MaxV2Length) return Header.Invalid;
        if (buffer.Length < 16 + length) return Header.Incomplete;
        Span<byte> addresses = stackalloc byte[addressBytes * 2 + 4];
        buffer.Slice(16, addresses.Length).CopyTo(addresses);
        var source = new IPAddress(addresses[..addressBytes]);
        var port = BinaryPrimitives.ReadUInt16BigEndian(addresses[(addressBytes * 2)..]);
        peer = new IPEndPoint(Normal(source), port);
        consumed = 16 + length;
        return Header.Ok;
    }

    /// <summary>Version 1 (text): <c>PROXY TCP4|TCP6 &lt;source&gt; &lt;destination&gt; &lt;source port&gt; &lt;destination port&gt;\r\n</c>.</summary>
    public static Header TryParseV1(ReadOnlySequence<byte> buffer, out long consumed, out IPEndPoint? peer)
    {
        consumed = 0;
        peer = null;
        Span<byte> line = stackalloc byte[MaxV1];
        var have = (int)Math.Min(buffer.Length, MaxV1);
        buffer.Slice(0, have).CopyTo(line);
        var prefix = Math.Min(have, PrefixV1.Length);
        if (!line[..prefix].SequenceEqual(PrefixV1[..prefix])) return Header.Invalid;
        var end = -1;
        for (var i = 0; i < have && end < 0; i++)
        {
            var b = line[i];
            if (b == '\r' && i + 1 < have && line[i + 1] == '\n') end = i;
            else if ((b < 0x20 || b > 0x7E) && !(b == '\r' && i + 1 == have)) return Header.Invalid; // only printable text, then CRLF
        }
        if (end < 0) return have >= MaxV1 ? Header.Invalid : Header.Incomplete;
        var parts = Encoding.ASCII.GetString(line[..end]).Split(' ');
        if (parts.Length != 6 || parts[0] != "PROXY") return Header.Invalid;
        var family = parts[1] switch
        {
            "TCP4" => System.Net.Sockets.AddressFamily.InterNetwork,
            "TCP6" => System.Net.Sockets.AddressFamily.InterNetworkV6,
            _ => System.Net.Sockets.AddressFamily.Unknown, // UNKNOWN: no client to name
        };
        if (family == System.Net.Sockets.AddressFamily.Unknown) return Header.Invalid;
        if (!Address(parts[2], family, out var source) || !Address(parts[3], family, out _)) return Header.Invalid;
        if (!Port(parts[4], out var sourcePort) || !Port(parts[5], out _)) return Header.Invalid;
        peer = new IPEndPoint(Normal(source!), sourcePort);
        consumed = end + 2;
        return Header.Ok;
    }

    private static bool Address(string text, System.Net.Sockets.AddressFamily family, out IPAddress? ip)
    {
        ip = null;
        if (text.Length == 0 || !IPAddress.TryParse(text, out var parsed) || parsed.AddressFamily != family) return false;
        // IPv4 strictly dotted-quad (IPAddress.TryParse also takes "1" or "0x7f.1").
        if (family == System.Net.Sockets.AddressFamily.InterNetwork && parsed.ToString() != text) return false;
        if (family == System.Net.Sockets.AddressFamily.InterNetworkV6 && (text.Contains('%') || text.Contains('['))) return false;
        ip = parsed;
        return true;
    }

    private static bool Port(string text, out int port)
    {
        port = 0;
        if (text.Length is 0 or > 5 || !text.All(char.IsAsciiDigit) || (text.Length > 1 && text[0] == '0')) return false;
        port = int.Parse(text, System.Globalization.CultureInfo.InvariantCulture);
        return port <= 65535;
    }
}
