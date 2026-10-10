namespace Iskra.Server.Crypto;

public sealed record DeviceCert(string AccountKey, string DeviceKey, long Created, string Sig);

/// <summary>Verification of client identities. Mirrors client/src/core/identity.ts.</summary>
public static class Identity
{
    public const string DeviceCertContext = "iskra/device-cert/v1";
    public const string AuthContext = "iskra/auth/v1";

    public static bool VerifyDeviceCert(DeviceCert cert)
    {
        if (cert.Created < 0) return false;
        if (!Ed25519.TryFromB64u(cert.AccountKey, out var accountKey)) return false;
        if (!Ed25519.TryFromB64u(cert.DeviceKey, out var deviceKey) || deviceKey.Length != Ed25519.PublicKeySize) return false;
        if (!Ed25519.TryFromB64u(cert.Sig, out var sig)) return false;
        var payload = Ed25519.Payload(DeviceCertContext, deviceKey, Ed25519.U64BigEndian(cert.Created));
        return Ed25519.Verify(accountKey, payload, sig);
    }

    public static bool VerifyAuth(DeviceCert cert, byte[] serverKey, byte[] nonce, string? signature)
    {
        if (!Ed25519.TryFromB64u(cert.DeviceKey, out var deviceKey)) return false;
        if (!Ed25519.TryFromB64u(signature, out var sig)) return false;
        return Ed25519.Verify(deviceKey, Ed25519.Payload(AuthContext, serverKey, nonce), sig);
    }
}
