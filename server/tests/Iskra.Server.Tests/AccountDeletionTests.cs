using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Protocol;
using Iskra.Server.Tests.Support;
using Key = NSec.Cryptography.Key;

namespace Iskra.Server.Tests;

public class AccountDeletionTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static object Deletion(TestIdentity who, bool messages, long? at = null, Key? signWith = null)
    {
        var deletedAt = at ?? Now;
        var account = Ed25519.PublicKeyOf(who.Account);
        var sig = Ed25519.Sign(signWith ?? who.Account,
            Ed25519.Payload(AccountFeature.DeleteContext, account, Ed25519.U64BigEndian(deletedAt), [(byte)(messages ? 1 : 0)]));
        return new { accountKey = who.AccountKey, deletedAt, messages, sig = Ed25519.ToB64u(sig) };
    }

    private static object Envelope(string marker) => new { v = 1, ct = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(marker)), keys = Array.Empty<object>() };

    [Fact]
    public async Task Deleting_removes_the_account_and_its_data_and_keeps_messages_unless_asked()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var sam = await server.JoinAsync("Sam");
        await sam.RequestAsync("profile.update", new { bio = "Hello there", pronouns = "they/them" });
        var sent = await sam.RequestAsync("chat.send", new { channelId = server.General, text = "a message that stays" });
        var messageId = sent.Body().GetProperty("message").GetProperty("id").GetInt64();
        await sam.RequestAsync("dm.send", new { accountKey = admin.Key, envelope = Envelope("secret") });
        await sam.RequestAsync("block.sync", new { entries = new[] { new { accountKey = admin.Key, blocked = false, at = Now } } });
        var invite = (await sam.RequestAsync("invite.create")).Body().GetProperty("invite").GetProperty("code").GetString()!;

        Assert.Equal("result", (await sam.RequestAsync("account.delete", new { deletion = Deletion(sam.Identity, messages: false) })).Type());
        Assert.Equal(sam.Key, (await sam.EventAsync("account.deleted")).Body().GetProperty("deletion").GetProperty("accountKey").GetString());
        Assert.Equal(CloseCodes.Forbidden, await sam.Client.ReceiveCloseAsync());
        Assert.Equal(sam.Key, (await admin.EventAsync("member.removed")).Body().GetProperty("accountKey").GetString());
        Assert.False((await admin.EventAsync("member.deleted")).Body().GetProperty("messages").GetBoolean());

        var store = server.World.Store;
        Assert.Null(store.GetMember(sam.Key));
        Assert.Empty(store.DeviceInfos(sam.Key));
        Assert.Empty(store.Blocks(sam.Key));
        Assert.Empty(store.DmHistory(admin.Key, sam.Key, null, 50));
        Assert.NotNull(store.GetMessage(messageId)); // kept: they didn't ask
        Assert.Null(store.TryUseInvite(invite, Now)); // their invites stop working
        Assert.NotNull(store.GetDeletion(sam.Key));

        // Every device of the account is refused from now on, and gets the signed deletion to act on.
        using var phone = new TestIdentity(sam.Identity.Account);
        using var again = await server.ConnectAsync();
        var refused = await again.LoginAsync(phone, "Sam");
        Assert.Equal("account_deleted", refused.ErrorCode());
        Assert.Equal(sam.Key, refused.Body().GetProperty("deletion").GetProperty("accountKey").GetString());
        Assert.Equal(CloseCodes.AuthFailed, await again.ReceiveCloseAsync());

        // Not even an invite brings the key back.
        using var third = await server.ConnectAsync();
        Assert.Equal("account_deleted", (await third.LoginAsync(new TestIdentity(sam.Identity.Account), "Sam", server.Invite())).ErrorCode());
    }

    [Fact]
    public async Task Deleting_with_messages_removes_them_too()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var sam = await server.JoinAsync("Sam");
        var id = (await sam.RequestAsync("chat.send", new { channelId = server.General, text = "bye" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        var other = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        await sam.RequestAsync("chat.react", new { id = other, emoji = "👍" });

        Assert.Equal("result", (await sam.RequestAsync("account.delete", new { deletion = Deletion(sam.Identity, messages: true) })).Type());
        Assert.True((await admin.EventAsync("member.deleted")).Body().GetProperty("messages").GetBoolean());
        Assert.Null(server.World.Store.GetMessage(id));
        Assert.NotNull(server.World.Store.GetMessage(other));
        Assert.Empty(server.World.Store.Reactions(other));
    }

    [Fact]
    public async Task Only_the_account_itself_can_delete_it()
    {
        using var server = new IskraServer();
        using var sam = await server.JoinAsync("Sam");
        using var mallory = await server.JoinAsync("Mallory");

        // Someone else's deletion, a bad signature, a changed choice, a time in the future: all refused.
        Assert.Equal("forbidden", (await mallory.RequestAsync("account.delete", new { deletion = Deletion(sam.Identity, false) })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("account.delete", new { deletion = Deletion(sam.Identity, false, signWith: mallory.Identity.Account) })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("account.delete", new { deletion = Deletion(sam.Identity, false, signWith: sam.Identity.Device) })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("account.delete", new { deletion = Deletion(sam.Identity, false, at: Now + 3_600_000) })).ErrorCode());
        Assert.Equal("bad_request", (await sam.RequestAsync("account.delete", new { })).ErrorCode());
        Assert.NotNull(server.World.Store.GetMember(sam.Key));
        Assert.Null(server.World.Store.GetDeletion(sam.Key));
    }

    [Fact]
    public async Task Owners_hand_the_server_over_before_deleting()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var sam = await server.JoinAsync("Sam");

        Assert.Equal("forbidden", (await owner.RequestAsync("account.delete", new { deletion = Deletion(owner.Identity, false) })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("owner.transfer", new { accountKey = sam.Key })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("owner.transfer", new { accountKey = owner.Key })).ErrorCode());
        Assert.Equal("not_found", (await owner.RequestAsync("owner.transfer", new { accountKey = "nobody" })).ErrorCode());

        Assert.Equal("result", (await owner.RequestAsync("owner.transfer", new { accountKey = sam.Key })).Type());
        Assert.Equal("owner", server.World.Store.GetMember(sam.Key)!.Role);
        Assert.Equal("admin", server.World.Store.GetMember(owner.Key)!.Role);
        var audit = await sam.RequestAsync("audit.list", new { action = "owner.transfer" });
        Assert.Single(audit.Body().GetProperty("entries").EnumerateArray());

        Assert.Equal("result", (await owner.RequestAsync("account.delete", new { deletion = Deletion(owner.Identity, false) })).Type());
        Assert.Null(server.World.Store.GetMember(owner.Key));
    }

    [Fact]
    public async Task A_reporter_who_deletes_their_account_disappears_from_reports()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var sam = await server.JoinAsync("Sam");
        using var bob = await server.JoinAsync("Bob");
        await sam.RequestAsync("report.create", new { accountKey = bob.Key, reason = "spam" });
        await sam.RequestAsync("account.delete", new { deletion = Deletion(sam.Identity, false) });

        var report = (await admin.RequestAsync("report.list")).Body().GetProperty("reports")[0];
        Assert.Equal(System.Text.Json.JsonValueKind.Null, report.GetProperty("reporter").ValueKind);
        Assert.Equal("", report.GetProperty("reporterName").GetString());
        Assert.Equal(bob.Key, report.GetProperty("target").GetString());
    }
}
