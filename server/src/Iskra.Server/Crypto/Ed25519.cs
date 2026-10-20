using System.Buffers.Text;
using System.Text;
using NSec.Cryptography;

namespace Iskra.Server.Crypto;

/// <summary>Ed25519 helpers. Wire rules live in protocol/PROTOCOL.md.</summary>
public static class Ed25519
{
    public const int PublicKeySize = 32;
    public const int SignatureSize = 64;

    private static readonly SignatureAlgorithm Algorithm = SignatureAlgorithm.Ed25519;

    public static Key KeyFromSeed(ReadOnlySpan<byte> seed) =>
        Key.Import(Algorithm, seed, KeyBlobFormat.RawPrivateKey,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });

    public static byte[] NewSeed() => System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);

    public static byte[] PublicKeyOf(Key key) => key.PublicKey.Export(KeyBlobFormat.RawPublicKey);

    public static byte[] Sign(Key key, ReadOnlySpan<byte> message) => Algorithm.Sign(key, message);

    public static bool Verify(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        if (publicKey.Length != PublicKeySize || signature.Length != SignatureSize) return false;
        if (!PublicKey.TryImport(Algorithm, publicKey, KeyBlobFormat.RawPublicKey, out var key) || key is null) return false;
        return Algorithm.Verify(key, message, signature);
    }

    /// <summary>"context" || 0x00 || parts... (domain separation for every signed payload).</summary>
    public static byte[] Payload(string context, params byte[][] parts)
    {
        var ctx = Encoding.UTF8.GetBytes(context);
        var result = new byte[ctx.Length + 1 + parts.Sum(p => p.Length)];
        ctx.CopyTo(result, 0);
        var offset = ctx.Length + 1;
        foreach (var part in parts)
        {
            part.CopyTo(result, offset);
            offset += part.Length;
        }
        return result;
    }

    public static byte[] U64BigEndian(long value)
    {
        if (value < 0) throw new ArgumentOutOfRangeException(nameof(value));
        var bytes = new byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt64BigEndian(bytes, (ulong)value);
        return bytes;
    }

    public static string ToB64u(ReadOnlySpan<byte> bytes) => Base64Url.EncodeToString(bytes);

    /// <summary>Keys, signatures and ids: at most 256 characters unless the caller allows more (a GIF token holds two addresses).</summary>
    public static bool TryFromB64u(string? text, out byte[] bytes, int maxLength = 256)
    {
        bytes = [];
        if (string.IsNullOrEmpty(text) || text.Length > maxLength) return false;
        try
        {
            bytes = Base64Url.DecodeFromChars(text);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
