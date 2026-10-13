using System.Text;
using NSec.Cryptography;

namespace Iskra.Server.Crypto;

/// <summary>
/// The keys of the peer-to-peer tunnel, all derived from the world's p2p secret (p2p.key) with keyed BLAKE2b and a
/// context string per key, exactly as the desktop app derives them (desktop/src/p2p/keys.ts): the server only needs
/// the host's public key, to show the owner what friends look up.
/// </summary>
public static class P2pKeys
{
    public const int SecretSize = 32;
    public const string HostContext = "iskra/p2p/v1/host-seed";
    public const string FriendContext = "iskra/p2p/v1/friend-seed";

    /// <summary>BLAKE2b-256(key = secret, message = context): the seed of one Ed25519 key pair.</summary>
    public static byte[] Seed(ReadOnlySpan<byte> secret, string context)
    {
        if (secret.Length != SecretSize) throw new ArgumentException("The p2p secret must be 32 bytes.", nameof(secret));
        using var key = Key.Import(MacAlgorithm.Blake2b_256, secret, KeyBlobFormat.RawSymmetricKey);
        return MacAlgorithm.Blake2b_256.Mac(key, Encoding.UTF8.GetBytes(context));
    }

    /// <summary>The host's DHT public key (hex, as HyperDHT shows keys), announced on the DHT.</summary>
    public static string HostPublicKeyHex(ReadOnlySpan<byte> secret)
    {
        using var key = Ed25519.KeyFromSeed(Seed(secret, HostContext));
        return Convert.ToHexString(Ed25519.PublicKeyOf(key)).ToLowerInvariant();
    }

    public static byte[] NewSecret() => System.Security.Cryptography.RandomNumberGenerator.GetBytes(SecretSize);
}
