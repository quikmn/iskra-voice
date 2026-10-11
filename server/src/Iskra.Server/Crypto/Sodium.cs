using System.Runtime.InteropServices;

namespace Iskra.Server.Crypto;

/// <summary>
/// The few libsodium functions NSec doesn't wrap: Argon2id (crypto_pwhash) and crypto_secretstream.
/// Bindings only; the native library is the libsodium that ships with NSec.
/// </summary>
internal static class Sodium
{
    private const string Lib = "libsodium";

    public const int SaltBytes = 16;                 // crypto_pwhash_SALTBYTES
    public const int AlgArgon2id13 = 2;              // crypto_pwhash_ALG_ARGON2ID13
    public const long OpsModerate = 3;               // crypto_pwhash_OPSLIMIT_MODERATE
    public const long MemModerate = 256L * 1024 * 1024; // crypto_pwhash_MEMLIMIT_MODERATE
    public const long OpsInteractive = 2;
    public const long MemInteractive = 64L * 1024 * 1024;

    public const int KeyBytes = 32;                  // crypto_secretstream_xchacha20poly1305_KEYBYTES
    public const int HeaderBytes = 24;               // ..._HEADERBYTES
    public const int ABytes = 17;                    // ..._ABYTES
    public const byte TagMessage = 0;
    public const byte TagFinal = 3;

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "sodium_init")]
    private static extern int Init();

    public const int SealBytes = 48; // crypto_box_SEALBYTES

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_sign_ed25519_pk_to_curve25519")]
    private static extern int EdPkToCurve(byte[] curvePk, byte[] edPk);

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_sign_ed25519_sk_to_curve25519")]
    private static extern int EdSkToCurve(byte[] curveSk, byte[] edSk);

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_box_seal")]
    private static extern int BoxSeal(byte[] c, byte[] m, ulong mLength, byte[] pk);

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_box_seal_open")]
    private static extern int BoxSealOpen(byte[] m, byte[] c, ulong cLength, byte[] pk, byte[] sk);

    /// <summary>crypto_box_seal to an Ed25519 public key (converted to X25519). The client does this; tests use it here.</summary>
    public static byte[] SealToEd25519(byte[] message, byte[] edPublicKey)
    {
        _ = Ready.Value;
        var pk = new byte[32];
        if (EdPkToCurve(pk, edPublicKey) != 0) throw new ArgumentException("Not an Ed25519 public key.");
        var c = new byte[message.Length + SealBytes];
        if (BoxSeal(c, message, (ulong)message.Length, pk) != 0) throw new InvalidOperationException("crypto_box_seal failed.");
        return c;
    }

    /// <summary>Opens a sealed box made for the Ed25519 key with this seed; null if it wasn't sealed to us or was changed.</summary>
    public static byte[]? OpenSealedWithEd25519(byte[] sealedBox, byte[] edSeed, byte[] edPublicKey)
    {
        _ = Ready.Value;
        if (sealedBox.Length < SealBytes) return null;
        var pk = new byte[32];
        var sk = new byte[32];
        var edSk = new byte[64];
        try
        {
            edSeed.CopyTo(edSk, 0);
            edPublicKey.CopyTo(edSk, 32);
            if (EdPkToCurve(pk, edPublicKey) != 0 || EdSkToCurve(sk, edSk) != 0) return null;
            var m = new byte[sealedBox.Length - SealBytes];
            return BoxSealOpen(m, sealedBox, (ulong)sealedBox.Length, pk, sk) == 0 ? m : null;
        }
        finally
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(sk);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(edSk);
        }
    }

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_pwhash")]
    private static extern int PwHash(byte[] output, ulong outputLength, byte[] password, ulong passwordLength,
        byte[] salt, ulong opsLimit, nuint memLimit, int alg);

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_secretstream_xchacha20poly1305_statebytes")]
    private static extern nuint StateBytes();

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_secretstream_xchacha20poly1305_init_push")]
    private static extern int InitPush(byte[] state, byte[] header, byte[] key);

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_secretstream_xchacha20poly1305_push")]
    private static extern int Push(byte[] state, byte[] c, out ulong cLength, byte[] m, ulong mLength,
        byte[] ad, ulong adLength, byte tag);

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_secretstream_xchacha20poly1305_init_pull")]
    private static extern int InitPull(byte[] state, byte[] header, byte[] key);

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, EntryPoint = "crypto_secretstream_xchacha20poly1305_pull")]
    private static extern int Pull(byte[] state, byte[] m, out ulong mLength, out byte tag, byte[] c, ulong cLength,
        byte[] ad, ulong adLength);

    private static readonly Lazy<int> Ready = new(() =>
    {
        if (Init() < 0) throw new InvalidOperationException("libsodium failed to initialise.");
        return (int)StateBytes();
    });

    public static int StateSize => Ready.Value;

    /// <summary>Argon2id key from a passphrase.</summary>
    public static byte[] DeriveKey(byte[] passphrase, byte[] salt, long ops, long mem)
    {
        _ = Ready.Value;
        if (salt.Length != SaltBytes) throw new ArgumentException("Bad salt length.", nameof(salt));
        var key = new byte[KeyBytes];
        if (PwHash(key, KeyBytes, passphrase, (ulong)passphrase.Length, salt, (ulong)ops, (nuint)mem, AlgArgon2id13) != 0)
            throw new InsufficientMemoryException("Not enough memory to derive the backup key.");
        return key;
    }

    /// <summary>One direction of a crypto_secretstream_xchacha20poly1305 stream.</summary>
    public sealed class SecretStream
    {
        private readonly byte[] _state = new byte[StateSize];

        private SecretStream() { }

        /// <summary>Starts an encrypting stream; <paramref name="header"/> (24 bytes) is filled in and must be stored.</summary>
        public static SecretStream ForPush(byte[] key, byte[] header)
        {
            var s = new SecretStream();
            if (InitPush(s._state, header, key) != 0) throw new InvalidOperationException("secretstream init_push failed.");
            return s;
        }

        public static SecretStream ForPull(byte[] key, byte[] header)
        {
            var s = new SecretStream();
            if (InitPull(s._state, header, key) != 0) throw new InvalidDataException("This isn't a valid backup header.");
            return s;
        }

        public byte[] Seal(byte[] message, int length, byte[] ad, byte tag)
        {
            var m = length == message.Length ? message : message[..length];
            var c = new byte[length + ABytes];
            if (Push(_state, c, out var written, m, (ulong)length, ad, (ulong)ad.Length, tag) != 0)
                throw new InvalidOperationException("secretstream push failed.");
            return written == (ulong)c.Length ? c : c[..(int)written];
        }

        /// <summary>Null when the chunk doesn't authenticate (wrong key, or the file was changed).</summary>
        public byte[]? Open(byte[] chunk, byte[] ad, out byte tag)
        {
            tag = 0;
            if (chunk.Length < ABytes) return null;
            var m = new byte[chunk.Length - ABytes];
            if (Pull(_state, m, out var length, out tag, chunk, (ulong)chunk.Length, ad, (ulong)ad.Length) != 0) return null;
            return length == (ulong)m.Length ? m : m[..(int)length];
        }
    }
}
