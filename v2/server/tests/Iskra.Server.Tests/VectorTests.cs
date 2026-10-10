using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>The C# side must agree byte-for-byte with v2/protocol/vectors.json (also checked by the TS client).</summary>
public class VectorTests
{
    private static readonly JsonElement V =
        JsonDocument.Parse(File.ReadAllText(Repo.ProtocolFile("vectors.json"))).RootElement.GetProperty("v1");

    private static byte[] Bytes(string name)
    {
        Assert.True(Ed25519.TryFromB64u(V.GetProperty(name).GetString(), out var bytes));
        return bytes;
    }

    private static DeviceCert Cert() => V.GetProperty("cert").Deserialize<DeviceCert>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    [Fact]
    public void Seeds_derive_the_expected_public_keys()
    {
        using var account = Ed25519.KeyFromSeed(Bytes("accountSeed"));
        using var device = Ed25519.KeyFromSeed(Bytes("deviceSeed"));
        using var server = Ed25519.KeyFromSeed(Bytes("serverSeed"));
        Assert.Equal(V.GetProperty("accountKey").GetString(), Ed25519.ToB64u(Ed25519.PublicKeyOf(account)));
        Assert.Equal(V.GetProperty("deviceKey").GetString(), Ed25519.ToB64u(Ed25519.PublicKeyOf(device)));
        Assert.Equal(V.GetProperty("serverKey").GetString(), Ed25519.ToB64u(Ed25519.PublicKeyOf(server)));
    }

    [Fact]
    public void Device_cert_signature_matches_and_verifies()
    {
        using var account = Ed25519.KeyFromSeed(Bytes("accountSeed"));
        var cert = Cert();
        var payload = Ed25519.Payload(Identity.DeviceCertContext, Bytes("deviceKey"), Ed25519.U64BigEndian(cert.Created));
        Assert.Equal(cert.Sig, Ed25519.ToB64u(Ed25519.Sign(account, payload)));
        Assert.True(Identity.VerifyDeviceCert(cert));
    }

    [Fact]
    public void Auth_signature_matches_and_verifies()
    {
        using var device = Ed25519.KeyFromSeed(Bytes("deviceSeed"));
        var payload = Ed25519.Payload(Identity.AuthContext, Bytes("serverKey"), Bytes("nonce"));
        Assert.Equal(V.GetProperty("authSig").GetString(), Ed25519.ToB64u(Ed25519.Sign(device, payload)));
        Assert.True(Identity.VerifyAuth(Cert(), Bytes("serverKey"), Bytes("nonce"), V.GetProperty("authSig").GetString()));
    }

    [Fact]
    public void Tampered_cert_fails()
    {
        var cert = Cert();
        Assert.False(Identity.VerifyDeviceCert(cert with { Created = cert.Created + 1 }));
        Assert.False(Identity.VerifyDeviceCert(cert with { DeviceKey = cert.AccountKey }));
        Assert.False(Identity.VerifyDeviceCert(cert with { Sig = "not base64!" }));
    }
}
