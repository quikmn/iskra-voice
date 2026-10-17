using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text;
using Ed25519 = Iskra.Server.Crypto.Ed25519;
using Iskra.Server.Storage;
using NSec.Cryptography;

namespace Iskra.Server.Logging;

/// <summary>
/// Ids that let log lines be matched up without saying who anyone is (docs/development.md "Logs"):
/// <c>srv</c> (this server, the same in members' bug reports), <c>conn</c> (one connection, sent in welcome as
/// <c>logId</c>) and <c>acct</c> (an account, matchable inside this server's log only).
/// </summary>
public static class LogIds
{
    private const string ServerContext = "iskra-log-v1";
    private const string SaltContext = "iskra-log-acct-salt-v1";
    private static readonly ConditionalWeakTable<World, byte[]> Salts = new();
    private static long _connections;

    /// <summary>4 hex of BLAKE2b("iskra-log-v1" ‖ server public key): reveals nothing an invite doesn't.</summary>
    public static string Server(byte[] serverPublicKey) =>
        Convert.ToHexStringLower(HashAlgorithm.Blake2b_256.Hash(Ed25519.Payload(ServerContext, serverPublicKey)))[..4];

    /// <summary>A new connection's id: a per-process counter in base 36 (at most 8 chars).</summary>
    public static string NextConnection() => Base36((ulong)Interlocked.Increment(ref _connections) % 2_821_109_907_456UL); // 36^8

    /// <summary>
    /// 6 hex of keyed BLAKE2b(world salt, account key). The salt is a hash of the server key's signature over a fixed
    /// context (deterministic, known only to this server), so the same account reads differently on every server.
    /// </summary>
    public static string Account(World world, string? accountKey)
    {
        if (string.IsNullOrEmpty(accountKey)) return "-";
        var salt = Salts.GetValue(world, w => HashAlgorithm.Blake2b_256.Hash(Ed25519.Sign(w.ServerKey, Ed25519.Payload(SaltContext))));
        using var key = Key.Import(MacAlgorithm.Blake2b_256, salt, KeyBlobFormat.RawSymmetricKey);
        return Convert.ToHexStringLower(MacAlgorithm.Blake2b_256.Mac(key, Encoding.UTF8.GetBytes(accountKey)))[..6];
    }

    private static string Base36(ulong value)
    {
        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        var sb = new StringBuilder();
        do
        {
            sb.Insert(0, digits[(int)(value % 36)]);
            value /= 36;
        } while (value > 0);
        return sb.ToString();
    }
}

/// <summary>
/// Counts by kind, summed up in the log once a minute by <see cref="LogMaintenance"/>: rate-limit refusals
/// (<see cref="Rate"/>) and webhook traffic (<see cref="Hooks"/>). No per-person or per-address lines.
/// </summary>
public sealed class LogCounts
{
    private static readonly ConditionalWeakTable<World, LogCounts> RateTable = new();
    private static readonly ConditionalWeakTable<World, LogCounts> HookTable = new();
    private readonly ConcurrentDictionary<string, int> _hits = new();

    public static LogCounts Rate(World world) => RateTable.GetValue(world, _ => new LogCounts());
    public static LogCounts Hooks(World world) => HookTable.GetValue(world, _ => new LogCounts());

    /// <summary>One more of <paramref name="kind"/>: a fixed word or a known limit name, never client text.</summary>
    public void Hit(string kind) => _hits.AddOrUpdate(kind, 1, (_, n) => n + 1);

    /// <summary>The counts since the last call, most first.</summary>
    public List<(string Kind, int Count)> Drain()
    {
        var taken = new List<(string, int)>();
        foreach (var kind in _hits.Keys)
            if (_hits.TryRemove(kind, out var n)) taken.Add((kind, n));
        return [.. taken.OrderByDescending(t => t.Item2).ThenBy(t => t.Item1, StringComparer.Ordinal)];
    }
}
