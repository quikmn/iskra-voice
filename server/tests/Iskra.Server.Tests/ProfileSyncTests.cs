using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Profile sync: the newest stamped profile wins, so a device that hasn't caught up can't put an old one back.</summary>
public class ProfileSyncTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Connects one of the account's devices with a stamped profile.</summary>
    private static async Task<JsonElement> LoginStamped(TestClient client, TestIdentity identity, string name, long? updatedAt, string by = "dev-a",
        string? bio = null)
    {
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, name);
        var profile = frame["body"]!["profile"]!.AsObject();
        if (updatedAt is { } at)
        {
            profile["updatedAt"] = at;
            profile["by"] = by;
        }
        if (bio is not null) profile["bio"] = bio;
        await client.SendAsync(frame);
        return await client.ReceiveAsync();
    }

    private static async Task<JsonElement> UpdateOf(User user, string accountKey)
    {
        while (true)
        {
            var member = (await user.EventAsync("member.updated")).Body().GetProperty("member");
            if (member.GetProperty("accountKey").GetString() == accountKey) return member;
        }
    }

    [Fact]
    public async Task A_device_with_an_older_profile_does_not_put_it_back()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var t = Now;

        // Device A renames (stamped).
        var renamed = await alice.RequestAsync("profile.update", new { name = "Alicia", bio = "new", updatedAt = t, by = "dev-a" });
        Assert.Equal("Alicia", renamed.Body().GetProperty("member").GetProperty("name").GetString());
        Assert.Equal("Alicia", (await UpdateOf(bob, alice.Key)).GetProperty("name").GetString());

        // Device B still has the old profile: older stamp, and no stamp at all. Neither overwrites, nobody hears of it.
        using var phone = new TestIdentity(alice.Identity.Account);
        using var b1 = await server.ConnectAsync();
        var welcome = await LoginStamped(b1, phone, "Alice", t - 60_000, "dev-b", bio: "old");
        Assert.Equal("welcome", welcome.Type());
        Assert.Equal("Alicia", welcome.Body().GetProperty("you").GetProperty("name").GetString());
        Assert.Equal("new", welcome.Body().GetProperty("you").GetProperty("bio").GetString());
        using var b2 = await server.ConnectAsync();
        welcome = await LoginStamped(b2, phone, "Alice", null, bio: "old");
        Assert.Equal("Alicia", welcome.Body().GetProperty("you").GetProperty("name").GetString());
        await bob.NoEventAsync("member.updated");
        Assert.Equal("Alicia", server.World.Store.GetMember(alice.Key)!.Name);

        // A stale request is answered with what the server has.
        var stale = (await b1.RequestAsync("profile.update", new { name = "Alice", updatedAt = t - 1, by = "dev-b" })).Body();
        Assert.True(stale.GetProperty("stale").GetBoolean());
        Assert.Equal("Alicia", stale.GetProperty("member").GetProperty("name").GetString());
        Assert.True((await b1.RequestAsync("profile.update", new { bio = "x" })).Body().GetProperty("stale").GetBoolean());

        // Once B has the newest profile and edits it, its newer stamp wins and reaches everyone.
        using var b3 = await server.ConnectAsync();
        await LoginStamped(b3, phone, "Ally", t + 1, "dev-b");
        Assert.Equal("Ally", (await UpdateOf(bob, alice.Key)).GetProperty("name").GetString());
    }

    [Fact]
    public async Task Equal_times_are_settled_by_the_device_and_far_future_stamps_are_refused()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var t = Now;

        Assert.Equal("A", Name(await alice.RequestAsync("profile.update", new { name = "A", updatedAt = t, by = "dev-a" })));
        // Same ms, a "larger" device: it wins; the smaller one then loses.
        Assert.Equal("B", Name(await alice.RequestAsync("profile.update", new { name = "B", updatedAt = t, by = "dev-b" })));
        var lost = (await alice.RequestAsync("profile.update", new { name = "A2", updatedAt = t, by = "dev-a" })).Body();
        Assert.True(lost.GetProperty("stale").GetBoolean());
        // The same stamp again is the same edit: applied (idempotent).
        Assert.Equal("B", Name(await alice.RequestAsync("profile.update", new { name = "B", updatedAt = t, by = "dev-b" })));

        // A clock more than a day ahead can't freeze the profile.
        var ahead = (await alice.RequestAsync("profile.update", new { name = "Future", updatedAt = t + 2L * 24 * 3600 * 1000, by = "dev-z" })).Body();
        Assert.True(ahead.GetProperty("stale").GetBoolean());
        Assert.Equal("B2", Name(await alice.RequestAsync("profile.update", new { name = "B2", updatedAt = t + 1, by = "dev-a" })));

        // A malformed stamp counts as no stamp, which is older than what's stored.
        var bad = (await alice.RequestAsync("profile.update", new { name = "Bad", updatedAt = "soon" })).Body();
        Assert.True(bad.GetProperty("stale").GetBoolean());
        Assert.Equal("B2", server.World.Store.GetMember(alice.Key)!.Name);

        // Synced prefs refuse a far-future copy too.
        var data = Convert.ToBase64String(new byte[48]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.Equal("result", (await alice.RequestAsync("prefs.set", new { name = "profile", data, updatedAt = t + 2L * 24 * 3600 * 1000 })).Type());
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("prefs.get", new { name = "profile" })).Body().GetProperty("data").ValueKind);
    }

    [Fact]
    public async Task Unstamped_profiles_work_as_before_until_a_stamped_one_arrives()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("Al", Name(await alice.RequestAsync("profile.update", new { name = "Al" })));
        using var again = await server.ConnectAsync();
        Assert.Equal("Ali", (await again.LoginAsync(alice.Identity, "Ali")).Body().GetProperty("you").GetProperty("name").GetString());
        Assert.Null(server.World.Store.GetProfileStamp(alice.Key));
    }

    [Fact]
    public async Task Pages_and_avatars_follow_the_stamp_and_your_page_can_be_read_back()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var t = Now;

        Assert.Equal("not_found", (await alice.RequestAsync("profile.page.get")).ErrorCode());
        const string html = "<!doctype html><p>new page</p>";
        var file = await Upload(server, alice, Encoding.UTF8.GetBytes(html), "page.html");
        var member = (await alice.RequestAsync("profile.page.set", new { file, updatedAt = t, by = "dev-a" })).Body().GetProperty("member");
        var hash = member.GetProperty("pageHash").GetString();

        var own = (await alice.RequestAsync("profile.page.get")).Body();
        Assert.Equal(html, own.GetProperty("html").GetString());
        Assert.Equal(hash, own.GetProperty("hash").GetString());
        // Only your own: there is no way to name someone else's.
        Assert.Equal("not_found", (await bob.RequestAsync("profile.page.get", new { accountKey = alice.Key })).ErrorCode());

        // An older device can't replace or remove it.
        var old = await Upload(server, alice, Encoding.UTF8.GetBytes("<p>old</p>"), "page.html");
        Assert.True((await alice.RequestAsync("profile.page.set", new { file = old, updatedAt = t - 5, by = "dev-b" })).Body().GetProperty("stale").GetBoolean());
        Assert.True((await alice.RequestAsync("profile.page.remove", new { updatedAt = t - 5, by = "dev-b" })).Body().GetProperty("stale").GetBoolean());
        Assert.Equal(html, (await alice.RequestAsync("profile.page.get")).Body().GetProperty("html").GetString());

        // Nor change the avatar.
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=");
        var avatar = await Upload(server, alice, png, "a.png");
        var staleAvatar = (await alice.RequestAsync("profile.update", new { avatar, updatedAt = t - 5, by = "dev-b" })).Body();
        Assert.Equal(JsonValueKind.Null, staleAvatar.GetProperty("member").GetProperty("avatar").ValueKind);
        var fresh = (await alice.RequestAsync("profile.update", new { avatar, updatedAt = t + 5, by = "dev-b" })).Body();
        Assert.NotEqual(JsonValueKind.Null, fresh.GetProperty("member").GetProperty("avatar").ValueKind);

        // A newer one may remove the page.
        Assert.Equal("result", (await alice.RequestAsync("profile.page.remove", new { updatedAt = t + 6, by = "dev-b" })).Type());
        Assert.Equal("not_found", (await alice.RequestAsync("profile.page.get")).ErrorCode());
    }

    [Fact]
    public async Task The_stamp_goes_with_the_membership()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        await alice.RequestAsync("profile.update", new { name = "A", updatedAt = Now, by = "dev-a" });
        Assert.NotNull(server.World.Store.GetProfileStamp(alice.Key));
        Assert.Equal("result", (await alice.RequestAsync("member.leave")).Type());
        Assert.Null(server.World.Store.GetProfileStamp(alice.Key));
    }

    private static string? Name(JsonElement result) => result.Body().GetProperty("member").GetProperty("name").GetString();

    private static async Task<string> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
    }

    [Fact]
    public async Task A_restored_device_that_leaves_the_name_out_keeps_the_members_profile_and_a_new_member_must_name_themselves()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        // Alice's device restored from the recovery key doesn't know her name yet: no name, and nothing changes.
        using var restored = new TestIdentity(alice.Identity.Account);
        using var device = await server.ConnectAsync();
        var hello = await device.ReceiveAsync();
        var frame = restored.AuthFrame(hello);
        frame["body"]!["profile"]!.AsObject().Remove("name");
        await device.SendAsync(frame);
        var welcome = await device.ReceiveAsync();
        Assert.Equal("welcome", welcome.Type());
        Assert.Equal("Alice", welcome.Body().GetProperty("you").GetProperty("name").GetString());
        await bob.NoEventAsync("member.updated");
        Assert.Equal("Alice", server.World.Store.GetMember(alice.Key)!.Name);

        // Someone new without a name is asked for one, and their invite isn't used up.
        var invite = server.World.Store.CreateInvite(InviteFeature.NewCode(), "test", "member", Now, null, 1).Code;
        using var stranger = new TestIdentity();
        using var c1 = await server.ConnectAsync();
        frame = stranger.AuthFrame(await c1.ReceiveAsync(), invite: invite);
        frame["body"]!["profile"]!.AsObject().Remove("name");
        await c1.SendAsync(frame);
        Assert.Equal("name_required", (await c1.ReceiveAsync()).ErrorCode());
        Assert.Equal(0, server.World.Store.GetInvite(invite)!.Uses);
        Assert.Null(server.World.Store.GetMember(stranger.AccountKey));
        using var c2 = await server.ConnectAsync();
        Assert.Equal("welcome", (await c2.LoginAsync(stranger, "Stranger", invite)).Type());

        // A blank name is still refused.
        using var c3 = await server.ConnectAsync();
        await c3.SendAsync(restored.AuthFrame(await c3.ReceiveAsync(), "   "));
        Assert.Equal("auth_failed", (await c3.ReceiveAsync()).ErrorCode());
    }
}
