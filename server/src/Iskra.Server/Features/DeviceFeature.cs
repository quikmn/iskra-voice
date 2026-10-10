using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Your devices as this server knows them: names, revocations and signed prekeys (for forward-secret DMs).
/// Revocations and prekeys are signed by the client; the server checks the signatures and only stores and serves them.
/// </summary>
public static class DeviceFeature
{
    public const string RevokeContext = "iskra/device-revoke/v1";
    public const string PrekeyContext = "iskra/prekey/v1";
    public const int MaxRevocations = 100;
    public const int DeviceNameMax = 32;
    private const long Day = 24 * 60 * 60 * 1000;
    /// <summary>A prekey older than this is refused (clients rotate weekly).</summary>
    public const long MaxPrekeyAge = 60 * Day;
    private const long ClockSkew = 10 * 60 * 1000;

    public static void Register(Router router)
    {
        router.Add("device.list", List);
        router.Add("device.describe", Describe);
        router.Add("device.rename", Rename);
        router.Add("device.revoke", Revoke);
        router.Add("prekey.publish", PublishPrekey);
    }

    public static object PublicPrekey(SignedPrekey p) => new { deviceKey = p.DeviceKey, key = p.Prekey, created = p.Created, sig = p.Sig };

    public static object PublicRevocation(DeviceRevocation r) => new { deviceKey = r.DeviceKey, revokedAt = r.RevokedAt, sig = r.Sig };

    private static object List(Session s, Member me, Body body) =>
        new
        {
            devices = s.World.Store.DeviceInfos(me.AccountKey).Select(d => new
            {
                deviceKey = d.DeviceKey, created = d.Created, name = d.Name, platform = d.Platform, lastSeen = d.LastSeen,
                current = d.DeviceKey == s.DeviceKey,
            }),
            revoked = s.World.Store.Revocations(me.AccountKey).Select(PublicRevocation),
        };

    private static string? DeviceText(Body body, string field)
    {
        var raw = body.OptionalString(field, 256);
        if (raw is null) return null;
        return Names.Normalize(raw) ?? throw RequestException.BadRequest($"'{field}' must be 1–{DeviceNameMax} characters.");
    }

    /// <summary>The connected device describes itself. Its name only sticks if none was chosen yet.</summary>
    private static object Describe(Session s, Member me, Body body)
    {
        var name = DeviceText(body, "name");
        var platform = DeviceText(body, "platform");
        s.World.Store.DescribeDevice(s.DeviceKey!, name, platform);
        return new { };
    }

    private static object Rename(Session s, Member me, Body body)
    {
        var deviceKey = body.String("deviceKey", 64);
        var name = DeviceText(body, "name") ?? throw RequestException.BadRequest("'name' is required.");
        if (!s.World.Store.RenameDevice(me.AccountKey, deviceKey, name)) throw RequestException.NotFound("Device");
        return new { };
    }

    /// <summary>
    /// Stores an account-signed revocation. From then on the device can't connect, its live sessions are closed,
    /// and it's no longer listed for DMs. Works for devices this server has never seen (they're refused when they show up).
    /// </summary>
    private static object Revoke(Session s, Member me, Body body)
    {
        var deviceKey = body.String("deviceKey", 64);
        var revokedAt = body.OptionalLong("revokedAt", 0, s.Now + ClockSkew) ?? throw RequestException.BadRequest("'revokedAt' is required.");
        var sig = body.String("sig", 128);
        if (!VerifyRevocation(me.AccountKey, deviceKey, revokedAt, sig)) throw RequestException.BadRequest("Invalid revocation signature.");

        if (!s.World.Store.IsDeviceRevoked(me.AccountKey, deviceKey))
        {
            if (s.World.Store.CountRevocations(me.AccountKey) >= MaxRevocations) throw RequestException.BadRequest("Too many revoked devices.");
            s.World.Store.AddRevocation(new DeviceRevocation(me.AccountKey, deviceKey, revokedAt, sig));
        }

        var notice = Frames.Event("device.revoked", new { deviceKey });
        foreach (var session in s.Hub.Sessions.Where(x => x.AccountKey == me.AccountKey))
        {
            session.Send(notice);
            if (session.DeviceKey == deviceKey) session.Kick(CloseCodes.Forbidden, "This device was removed from its account.");
        }
        return new { };
    }

    public static bool VerifyRevocation(string accountKey, string deviceKey, long revokedAt, string sig)
    {
        if (revokedAt < 0) return false;
        if (!Ed25519.TryFromB64u(accountKey, out var account)) return false;
        if (!Ed25519.TryFromB64u(deviceKey, out var device) || device.Length != Ed25519.PublicKeySize) return false;
        if (!Ed25519.TryFromB64u(sig, out var signature)) return false;
        return Ed25519.Verify(account, Ed25519.Payload(RevokeContext, device, Ed25519.U64BigEndian(revokedAt)), signature);
    }

    /// <summary>The connected device publishes its current X25519 prekey, signed with its device key.</summary>
    private static object PublishPrekey(Session s, Member me, Body body)
    {
        var key = body.String("key", 64);
        var created = body.OptionalLong("created", 0, long.MaxValue) ?? throw RequestException.BadRequest("'created' is required.");
        var sig = body.String("sig", 128);
        if (created > s.Now + ClockSkew || created < s.Now - MaxPrekeyAge) throw RequestException.BadRequest("Prekey is too old or from the future.");
        if (!VerifyPrekey(s.DeviceKey!, key, created, sig)) throw RequestException.BadRequest("Invalid prekey signature.");
        s.World.Store.SavePrekey(new SignedPrekey(s.DeviceKey!, key, created, sig));
        return new { };
    }

    public static bool VerifyPrekey(string deviceKey, string prekey, long created, string sig)
    {
        if (created < 0) return false;
        if (!Ed25519.TryFromB64u(deviceKey, out var device)) return false;
        if (!Ed25519.TryFromB64u(prekey, out var key) || key.Length != 32) return false;
        if (!Ed25519.TryFromB64u(sig, out var signature)) return false;
        return Ed25519.Verify(device, Ed25519.Payload(PrekeyContext, key, Ed25519.U64BigEndian(created)), signature);
    }
}
