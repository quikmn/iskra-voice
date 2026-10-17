using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Backups;

/// <summary>What a pairing code carries: the holder's address and key, and a one-time token.</summary>
public sealed record BuddyPairingCode(string Url, byte[] HolderKey, byte[] Token);

/// <summary>A parsed <c>Authorization: IskraBuddy ...</c> header.</summary>
public sealed record BuddyAuth(byte[] Key, long At, byte[] Nonce, byte[] Sig);

/// <summary>
/// The keys and signed payloads of backup buddies (PROTOCOL.md → Backup buddies): the recovery code, the restore key
/// derived from it, pairing codes, and the signature on every request between servers.
/// </summary>
public static class BuddyCrypto
{
    public const string PairContext = "iskra/buddy-pair/v1";
    public const string PairedContext = "iskra/buddy-paired/v1";
    public const string RequestContext = "iskra/buddy-request/v1";
    public const string RestoreKeyContext = "iskra/buddy-restore-key/v1";
    public const string CodePrefix = "iskra-buddy:";
    public const int MaxCodeLength = 1024;
    public const int RecoveryCodeLength = 25;
    public const string Scheme = "IskraBuddy";

    /// <summary>Argon2id cost for the copies: the recovery code is random, so a modest cost is plenty.</summary>
    public const long KdfOps = Sodium.OpsInteractive;
    public const long KdfMem = Sodium.MemInteractive;

    // ── The recovery code ────────────────────────────────────────────────────

    /// <summary>A new recovery code (125 random bits), normalized (no dashes).</summary>
    public static string NewRecoveryCode() => RandomNumberGenerator.GetString(Features.OwnerSetup.CodeAlphabet, RecoveryCodeLength);

    /// <summary>XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.</summary>
    public static string FormatRecoveryCode(string normalized) =>
        string.Join('-', Enumerable.Range(0, RecoveryCodeLength / 5).Select(i => normalized.Substring(i * 5, 5)));

    /// <summary>A recovery code as typed (case, spaces and dashes don't matter; O, I, L read as 0, 1, 1), or null.</summary>
    public static string? NormalizeRecoveryCode(string? typed)
    {
        if (typed is null || typed.Length > 100) return null;
        var chars = typed.Trim().ToUpperInvariant().Where(c => c is not (' ' or '-')).Select(c => c switch { 'O' => '0', 'I' or 'L' => '1', _ => c }).ToArray();
        return chars.Length == RecoveryCodeLength && chars.All(c => Features.OwnerSetup.CodeAlphabet.Contains(c)) ? new string(chars) : null;
    }

    /// <summary>The restore key: an Ed25519 key from BLAKE2b-256(context || 0x00 || code).</summary>
    public static Key RestoreKey(string normalizedCode)
    {
        var seed = NSec.Cryptography.HashAlgorithm.Blake2b_256.Hash(Ed25519.Payload(RestoreKeyContext, Encoding.UTF8.GetBytes(normalizedCode)));
        try { return Ed25519.KeyFromSeed(seed); }
        finally { CryptographicOperations.ZeroMemory(seed); }
    }

    // ── Pairing codes ────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private sealed record CodeJson(int V, string Url, string Key, string Token);

    public static string EncodePairingCode(string url, byte[] holderKey, byte[] token) =>
        CodePrefix + Base64Url.EncodeToString(JsonSerializer.SerializeToUtf8Bytes(new CodeJson(1, url, Ed25519.ToB64u(holderKey), Ed25519.ToB64u(token)), Json));

    public static BuddyPairingCode? DecodePairingCode(string? text)
    {
        text = text?.Trim();
        if (text is null || text.Length > MaxCodeLength || !text.StartsWith(CodePrefix, StringComparison.Ordinal)) return null;
        try
        {
            var json = Base64Url.DecodeFromChars(text.AsSpan(CodePrefix.Length));
            var code = JsonSerializer.Deserialize<CodeJson>(json, Json);
            if (code is null || code.V != 1 || string.IsNullOrEmpty(code.Url) || code.Url.Length > 512) return null;
            if (!Ed25519.TryFromB64u(code.Key, out var key) || key.Length != Ed25519.PublicKeySize) return null;
            if (!Ed25519.TryFromB64u(code.Token, out var token) || token.Length != 32) return null;
            return new BuddyPairingCode(code.Url.TrimEnd('/'), key, token);
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return null;
        }
    }

    public static string TokenHash(byte[] token) => Convert.ToHexStringLower(SHA256.HashData(token));

    public static byte[] PairPayload(byte[] holderKey, byte[] token, byte[] restoreKey, long at, string name) =>
        Ed25519.Payload(PairContext, holderKey, token, restoreKey, Ed25519.U64BigEndian(at), Encoding.UTF8.GetBytes(name));

    public static byte[] PairedPayload(byte[] sourceKey, byte[] token, long at, string spotId) =>
        Ed25519.Payload(PairedContext, sourceKey, token, Ed25519.U64BigEndian(at), Encoding.UTF8.GetBytes(spotId));

    // ── Signed requests ──────────────────────────────────────────────────────

    public static byte[] RequestPayload(byte[] holderKey, long at, byte[] nonce, string method, string pathAndQuery, ReadOnlySpan<byte> body) =>
        Ed25519.Payload(RequestContext, holderKey, Ed25519.U64BigEndian(at), nonce,
            SHA256.HashData(Encoding.UTF8.GetBytes($"{method.ToUpperInvariant()} {pathAndQuery}")), SHA256.HashData(body));

    /// <summary>The Authorization header value for one request.</summary>
    public static string Authorization(Key key, byte[] holderKey, long at, string method, string pathAndQuery, ReadOnlySpan<byte> body)
    {
        var nonce = RandomNumberGenerator.GetBytes(16);
        var sig = Ed25519.Sign(key, RequestPayload(holderKey, at, nonce, method, pathAndQuery, body));
        return $"{Scheme} key={Ed25519.ToB64u(Ed25519.PublicKeyOf(key))}, at={at}, nonce={Ed25519.ToB64u(nonce)}, sig={Ed25519.ToB64u(sig)}";
    }

    public static BuddyAuth? ParseAuthorization(string? header)
    {
        if (header is null || header.Length > 400 || !header.StartsWith(Scheme + " ", StringComparison.Ordinal)) return null;
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in header[(Scheme.Length + 1)..].Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0 || !fields.TryAdd(part[..eq], part[(eq + 1)..])) return null;
        }
        if (!fields.TryGetValue("key", out var keyText) || !Ed25519.TryFromB64u(keyText, out var key) || key.Length != Ed25519.PublicKeySize) return null;
        if (!fields.TryGetValue("at", out var atText) || !long.TryParse(atText, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var at)) return null;
        if (!fields.TryGetValue("nonce", out var nonceText) || !Ed25519.TryFromB64u(nonceText, out var nonce) || nonce.Length != 16) return null;
        if (!fields.TryGetValue("sig", out var sigText) || !Ed25519.TryFromB64u(sigText, out var sig) || sig.Length != Ed25519.SignatureSize) return null;
        return new BuddyAuth(key, at, nonce, sig);
    }
}
