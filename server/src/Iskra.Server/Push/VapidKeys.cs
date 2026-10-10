using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Storage;

namespace Iskra.Server.Push;

/// <summary>
/// This server's VAPID key pair (P-256), in vapid.json in the world folder. Browsers tie each push subscription
/// to the public key, and push services only accept messages signed with the matching private key.
/// </summary>
public sealed record VapidKeys(string PublicKey, string PrivateKey)
{
    public const string FileName = "vapid.json";

    public static VapidKeys LoadOrCreate(string worldPath)
    {
        var path = Path.Combine(worldPath, FileName);
        if (File.Exists(path))
        {
            var keys = JsonSerializer.Deserialize<VapidKeys>(File.ReadAllText(path))
                ?? throw new InvalidDataException($"{path} is empty.");
            if (!Ed25519.TryFromB64u(keys.PublicKey, out var pub) || pub.Length != 65 || pub[0] != 4
                || !Ed25519.TryFromB64u(keys.PrivateKey, out var priv) || priv.Length != 32)
                throw new InvalidDataException($"{path} doesn't hold a valid VAPID key pair.");
            return keys;
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var p = key.ExportParameters(includePrivateParameters: true);
        var created = new VapidKeys(Ed25519.ToB64u([4, .. p.Q.X!, .. p.Q.Y!]), Ed25519.ToB64u(p.D!));
        AtomicFile.WriteAllText(path, JsonSerializer.Serialize(created, new JsonSerializerOptions { WriteIndented = true }));
        return created;
    }
}
