using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Iskra.Server.Hosting;

/// <summary>
/// Keys for limits per client address: IPv4 as is, IPv6 by its /64 (one home network usually has a whole /64, so
/// rotating addresses inside it doesn't buy fresh limits). Every per-address limit uses these.
/// </summary>
public static class AddressLimits
{
    /// <summary>The address a limit is kept for: the address itself, or the /64 network for IPv6 (<see cref="IPAddress.None"/> for none).</summary>
    public static IPAddress Network(IPAddress? address)
    {
        if (address is null) return IPAddress.None;
        if (address.IsIPv4MappedToIPv6) return address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return address;
        var bytes = address.GetAddressBytes();
        Array.Clear(bytes, 8, 8);
        return new IPAddress(bytes);
    }

    /// <summary>The same as a string key ("local" when there's no address: the in-memory test host).</summary>
    public static string Key(IPAddress? address) =>
        address is null ? "local" : Network(address) is { AddressFamily: AddressFamily.InterNetworkV6 } network ? $"{network}/64" : Network(address).ToString();

    /// <summary>The key for a request's client address.</summary>
    public static string Key(Microsoft.AspNetCore.Http.HttpContext context) => Key(context.Connection.RemoteIpAddress);
}

/// <summary>
/// A table of limits (token buckets) per key that holds at most <paramref name="max"/> entries. When it's full, the
/// entries with the most room left (<paramref name="slack"/>: 1 = untouched, 0 = limited) go first, a tenth at a time:
/// never all at once, and never the ones that are limiting someone, so a flood of fresh addresses can't reset the
/// limit of the address that's being held back.
/// </summary>
public sealed class BoundedTable<TKey, TValue>(int max, Func<TValue, double> slack) where TKey : notnull
{
    private readonly ConcurrentDictionary<TKey, TValue> _entries = new();
    private readonly Lock _trim = new();

    public int Count => _entries.Count;

    public bool Contains(TKey key) => _entries.ContainsKey(key);

    public TValue GetOrAdd(TKey key, Func<TKey, TValue> make)
    {
        var value = _entries.GetOrAdd(key, make);
        if (_entries.Count > max) Trim(key);
        return value;
    }

    private void Trim(TKey keep)
    {
        lock (_trim)
        {
            if (_entries.Count <= max) return;
            var drop = _entries.Count - max * 9 / 10;
            var comparer = EqualityComparer<TKey>.Default;
            foreach (var key in _entries.Where(e => !comparer.Equals(e.Key, keep)).OrderByDescending(e => slack(e.Value)).Take(drop).Select(e => e.Key).ToList())
                _entries.TryRemove(key, out _);
        }
    }
}
