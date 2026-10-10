using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Tests;

public class DeviceTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string DeviceKeyOf(TestIdentity identity) => Ed25519.ToB64u(Ed25519.PublicKeyOf(identity.Device));

    private static object Revocation(Key account, string deviceKey, long at)
    {
        Ed25519.TryFromB64u(deviceKey, out var device);
        var sig = Ed25519.Sign(account, Ed25519.Payload(DeviceFeature.RevokeContext, device, Ed25519.U64BigEndian(at)));
        return new { deviceKey, revokedAt = at, sig = Ed25519.ToB64u(sig) };
    }

    private static object Prekey(Key device, byte[] key, long created) =>
        new
        {
            key = Ed25519.ToB64u(key),
            created,
            sig = Ed25519.ToB64u(Ed25519.Sign(device, Ed25519.Payload(DeviceFeature.PrekeyContext, key, Ed25519.U64BigEndian(created)))),
        };

    private static async Task<(TestIdentity Identity, TestClient Client)> SecondDeviceAsync(IskraServer server, User user)
    {
        var second = new TestIdentity(user.Identity.Account);
        var client = await server.ConnectAsync();
        Assert.Equal("welcome", (await client.LoginAsync(second, "Alice")).Type());
        return (second, client);
    }

    [Fact]
    public async Task A_revoked_device_is_disconnected_refused_and_no_longer_listed()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var (phone, phoneClient) = await SecondDeviceAsync(server, alice);
        using var _ = phone;
        using var __ = phoneClient;
        var phoneKey = DeviceKeyOf(phone);

        var result = await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, phoneKey, Now));
        Assert.Null(result.ErrorCode());

        // The phone hears about it, then gets kicked.
        Assert.Equal(phoneKey, (await phoneClient.EventAsync("device.revoked")).Body().GetProperty("deviceKey").GetString());
        Assert.Equal(4403, await phoneClient.ReceiveCloseAsync());
        await alice.EventAsync("device.revoked"); // the account's other devices refresh their list

        // It can't come back.
        using var retry = await server.ConnectAsync();
        var refused = await retry.LoginAsync(phone, "Alice");
        Assert.Equal("device_revoked", refused.ErrorCode());
        Assert.Equal(4401, await retry.ReceiveCloseAsync());

        // Senders no longer see it, but do see the signed revocation.
        var bundle = (await bob.RequestAsync("dm.devices", new { accountKey = alice.Key })).Body();
        Assert.Single(bundle.GetProperty("devices").EnumerateArray());
        Assert.DoesNotContain(bundle.GetProperty("devices").EnumerateArray(), d => d.GetProperty("deviceKey").GetString() == phoneKey);
        var revoked = bundle.GetProperty("revoked")[0];
        Assert.Equal(phoneKey, revoked.GetProperty("deviceKey").GetString());
        Assert.True(DeviceFeature.VerifyRevocation(alice.Key, phoneKey, revoked.GetProperty("revokedAt").GetInt64(), revoked.GetProperty("sig").GetString()!));

        var list = (await alice.RequestAsync("device.list")).Body();
        Assert.Single(list.GetProperty("devices").EnumerateArray());
        Assert.True(list.GetProperty("devices")[0].GetProperty("current").GetBoolean());
        Assert.Single(list.GetProperty("revoked").EnumerateArray());
    }

    [Fact]
    public async Task Revocations_need_the_accounts_own_signature()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var mallory = await server.JoinAsync("Mallory");
        var aliceDevice = DeviceKeyOf(alice.Identity);

        // Signed by the wrong account.
        Assert.Equal("bad_request", (await alice.RequestAsync("device.revoke", Revocation(mallory.Identity.Account, aliceDevice, Now))).ErrorCode());
        // Mallory's own signature only ever applies to Mallory's account: Alice is unaffected.
        Assert.Null((await mallory.RequestAsync("device.revoke", Revocation(mallory.Identity.Account, aliceDevice, Now))).ErrorCode());
        await alice.NoEventAsync("device.revoked");
        using var again = await server.ConnectAsync();
        Assert.Equal("welcome", (await again.LoginAsync(new TestIdentity(alice.Identity.Account), "Alice")).Type());
        Assert.Equal(2, (await alice.RequestAsync("dm.devices", new { accountKey = alice.Key })).Body().GetProperty("devices").GetArrayLength());

        // Future timestamps and garbage are refused.
        Assert.Equal("bad_request", (await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, aliceDevice, Now + 3_600_000))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("device.revoke", new { deviceKey = aliceDevice, revokedAt = Now, sig = "nope" })).ErrorCode());
    }

    [Fact]
    public async Task A_device_never_seen_here_can_be_revoked_ahead_of_time()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var laptop = new TestIdentity(alice.Identity.Account);

        Assert.Null((await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, DeviceKeyOf(laptop), Now))).ErrorCode());
        using var client = await server.ConnectAsync();
        Assert.Equal("device_revoked", (await client.LoginAsync(laptop, "Alice")).ErrorCode());
    }

    [Fact]
    public async Task One_session_can_only_remove_a_few_devices_an_hour()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        string NewDevice() => Ed25519.ToB64u(Ed25519.PublicKeyOf(Ed25519.KeyFromSeed(Ed25519.NewSeed())));

        var first = NewDevice();
        for (var i = 0; i < 10; i++)
            Assert.Null((await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, i == 0 ? first : NewDevice(), Now))).ErrorCode());
        Assert.Equal("rate_limited", (await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, NewDevice(), Now))).ErrorCode());
        // Handing over one the server already has (as clients do on connect) still works.
        Assert.Null((await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, first, Now))).ErrorCode());
    }

    [Fact]
    public async Task Prekeys_are_signed_by_the_device_and_published_with_its_certificate()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var key = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        var created = Now;

        Assert.Null((await alice.RequestAsync("prekey.publish", Prekey(alice.Identity.Device, key, created))).ErrorCode());
        var prekeys = (await bob.RequestAsync("dm.devices", new { accountKey = alice.Key })).Body().GetProperty("prekeys");
        var published = prekeys[0];
        Assert.Equal(DeviceKeyOf(alice.Identity), published.GetProperty("deviceKey").GetString());
        Assert.Equal(Ed25519.ToB64u(key), published.GetProperty("key").GetString());
        Assert.True(DeviceFeature.VerifyPrekey(DeviceKeyOf(alice.Identity), published.GetProperty("key").GetString()!, created, published.GetProperty("sig").GetString()!));

        // An older prekey never replaces a newer one.
        var older = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        Assert.Null((await alice.RequestAsync("prekey.publish", Prekey(alice.Identity.Device, older, created - 1000))).ErrorCode());
        prekeys = (await bob.RequestAsync("dm.devices", new { accountKey = alice.Key })).Body().GetProperty("prekeys");
        Assert.Equal(Ed25519.ToB64u(key), prekeys[0].GetProperty("key").GetString());

        // Signed by another key (even the account key), stale, from the future, or the wrong size: refused.
        Assert.Equal("bad_request", (await alice.RequestAsync("prekey.publish", Prekey(alice.Identity.Account, key, Now))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("prekey.publish", Prekey(alice.Identity.Device, key, Now - DeviceFeature.MaxPrekeyAge - 60_000))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("prekey.publish", Prekey(alice.Identity.Device, key, Now + 3_600_000))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("prekey.publish", Prekey(alice.Identity.Device, new byte[16], Now))).ErrorCode());
    }

    [Fact]
    public async Task Revoking_a_device_withdraws_its_prekey()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var (phone, phoneClient) = await SecondDeviceAsync(server, alice);
        using var _ = phone;
        using var __ = phoneClient;
        Assert.Null((await phoneClient.RequestAsync("prekey.publish", Prekey(phone.Device, System.Security.Cryptography.RandomNumberGenerator.GetBytes(32), Now))).ErrorCode());
        Assert.Single((await alice.RequestAsync("dm.devices", new { accountKey = alice.Key })).Body().GetProperty("prekeys").EnumerateArray());

        await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, DeviceKeyOf(phone), Now));
        Assert.Empty((await alice.RequestAsync("dm.devices", new { accountKey = alice.Key })).Body().GetProperty("prekeys").EnumerateArray());
    }

    [Fact]
    public async Task Revoking_a_device_removes_its_push_subscription()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var (phone, phoneClient) = await SecondDeviceAsync(server, alice);
        using var _ = phone;
        using var __ = phoneClient;
        using var key = System.Security.Cryptography.ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        var subscription = new
        {
            endpoint = "https://fcm.googleapis.com/fcm/send/phone",
            keys = new { p256dh = Ed25519.ToB64u([0x04, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(new byte[16]) },
        };
        Assert.Equal("result", (await phoneClient.RequestAsync("push.subscribe", subscription)).Type());
        Assert.NotNull(server.World.Store.PushSubscriptionFor(DeviceKeyOf(phone)));

        await alice.RequestAsync("device.revoke", Revocation(alice.Identity.Account, DeviceKeyOf(phone), Now));
        Assert.Null(server.World.Store.PushSubscriptionFor(DeviceKeyOf(phone)));
    }

    [Fact]
    public async Task Devices_describe_themselves_and_only_their_account_renames_them()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        await alice.RequestAsync("device.describe", new { name = "Firefox on Windows", platform = "Firefox on Windows" });
        var device = (await alice.RequestAsync("device.list")).Body().GetProperty("devices")[0];
        Assert.Equal("Firefox on Windows", device.GetProperty("name").GetString());

        Assert.Null((await alice.RequestAsync("device.rename", new { deviceKey = DeviceKeyOf(alice.Identity), name = "Desk PC" })).ErrorCode());
        // Describing again doesn't undo a chosen name.
        await alice.RequestAsync("device.describe", new { name = "Firefox on Windows", platform = "Firefox on Windows" });
        device = (await alice.RequestAsync("device.list")).Body().GetProperty("devices")[0];
        Assert.Equal("Desk PC", device.GetProperty("name").GetString());
        Assert.Equal("Firefox on Windows", device.GetProperty("platform").GetString());

        Assert.Equal("not_found", (await bob.RequestAsync("device.rename", new { deviceKey = DeviceKeyOf(alice.Identity), name = "Pwned" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("device.rename", new { deviceKey = DeviceKeyOf(alice.Identity), name = "bad‮name" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("device.rename", new { deviceKey = DeviceKeyOf(alice.Identity), name = new string('x', 33) })).ErrorCode());

        // Bob's list only has Bob's devices.
        var bobs = (await bob.RequestAsync("device.list")).Body().GetProperty("devices");
        Assert.Single(bobs.EnumerateArray());
        Assert.Equal(DeviceKeyOf(bob.Identity), bobs[0].GetProperty("deviceKey").GetString());
    }
}
