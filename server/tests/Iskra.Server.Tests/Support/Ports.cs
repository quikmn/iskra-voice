using System.Net;
using System.Net.Sockets;

namespace Iskra.Server.Tests.Support;

/// <summary>
/// Port numbers for listeners that bind later than the test picks them (a spawned server, Pebble, LiveKit, an
/// HttpListener). Never "listen on port 0, close, use the number": that number is one of the OS's ephemeral ports, and
/// any outgoing connection or port-0 listener can take it before the real bind ("address already in use"). These come
/// from a range below the ephemeral ports (Linux 32768+, Windows and macOS 49152+) and above the ranges of
/// client/interop/ports.ts (10000+) and client/e2e/helpers.ts (20000-31999). A number is given out once: a lock file
/// held until this process exits keeps other test processes on the same machine away from it.
/// </summary>
public static class Ports
{
    private const int First = 32000, Count = 750;
    private static readonly Lock Gate = new();
    private static readonly List<FileStream> Held = [];
    private static readonly string Folder = Path.Combine(Path.GetTempPath(), "iskra-test-ports");
    private static int _next = Random.Shared.Next(Count);

    /// <summary>A port nothing listens on (TCP and UDP, loopback), reserved for this test process.</summary>
    public static int Free() => FreeRun(1);

    /// <summary>The first of <paramref name="length"/> consecutive ports (LiveKit's TURN port is RtcUdpPort + 1).</summary>
    public static int FreeRun(int length)
    {
        lock (Gate)
        {
            Directory.CreateDirectory(Folder);
            for (var tries = 0; tries < Count; tries++)
            {
                var port = First + _next;
                _next = (_next + 1) % Count;
                if (port + length > First + Count) continue;
                var locks = new List<FileStream>();
                for (var i = 0; i < length && Reserve(port + i) is { } held; i++) locks.Add(held);
                if (locks.Count == length)
                {
                    Held.AddRange(locks);
                    _next = (_next + length - 1) % Count;
                    return port;
                }
                foreach (var held in locks) held.Dispose();
            }
        }
        throw new InvalidOperationException($"No free port in {First}-{First + Count - 1}.");
    }

    /// <summary>
    /// Waits until <paramref name="process"/> accepts connections on <paramref name="port"/> (loopback). For a helper
    /// another process is about to call: the server asks its ACME directory once at start and, when nothing answers,
    /// not again for five minutes.
    /// </summary>
    public static async Task ListeningAsync(int port, System.Diagnostics.Process process, string name)
    {
        var until = DateTime.UtcNow.AddSeconds(120); // a hang guard; it leaves as soon as the port answers
        while (true)
        {
            try
            {
                using var probe = new TcpClient();
                await probe.ConnectAsync(IPAddress.Loopback, port);
                return;
            }
            catch (SocketException) { }
            Assert.False(process.HasExited, $"{name} stopped before it listened on port {port}.");
            Assert.True(DateTime.UtcNow < until, $"{name} never listened on port {port}.");
            await Task.Delay(50);
        }
    }

    /// <summary>The lock on <paramref name="port"/> when no test process has it and nothing is bound to it; else null.</summary>
    private static FileStream? Reserve(int port)
    {
        FileStream held;
        try
        {
            // Windows removes the file with the handle. Elsewhere the empty file stays: unlinking it would let one
            // process lock the old file while another creates and locks a new one.
            held = new FileStream(Path.Combine(Folder, $"{port}.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1,
                OperatingSystem.IsWindows() ? FileOptions.DeleteOnClose : FileOptions.None);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
        if (Unbound(port)) return held;
        held.Dispose();
        return null;
    }

    private static bool Unbound(int port)
    {
        if (!Binds(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp, IPAddress.Loopback, port, out _)) return false;
        if (!Binds(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp, IPAddress.Loopback, port, out _)) return false;
        // No IPv6 on this machine is fine; a taken port isn't.
        return !Socket.OSSupportsIPv6 || Binds(AddressFamily.InterNetworkV6, SocketType.Stream, ProtocolType.Tcp, IPAddress.IPv6Loopback, port, out var why)
            || why is not (SocketError.AddressAlreadyInUse or SocketError.AccessDenied);
    }

    private static bool Binds(AddressFamily family, SocketType type, ProtocolType protocol, IPAddress address, int port, out SocketError why)
    {
        why = SocketError.Success;
        try
        {
            using var socket = new Socket(family, type, protocol);
            socket.ExclusiveAddressUse = true;
            socket.Bind(new IPEndPoint(address, port));
            return true;
        }
        catch (SocketException e)
        {
            why = e.SocketErrorCode;
            return false;
        }
    }
}
