using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Forwarding messages between channels, and per-account synced preferences.</summary>
public class ForwardTests
{
    private static async Task<JsonElement> Say(User user, long channelId, string text, string[]? attachments = null) =>
        (await user.RequestAsync("chat.send", new { channelId, text, attachments })).Body().GetProperty("message");

    private static string FileFor(IskraServer server, User user)
    {
        var id = Guid.NewGuid().ToString("N")[..16];
        server.World.Store.AddFile(new Storage.StoredFile(id, new string('a', 64), "photo.png", 10, "image/png", 1, 1, user.Key, 1));
        return id;
    }

    [Fact]
    public async Task Forwards_copy_text_and_attachments_and_say_where_from()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var games = server.World.Store.CreateChannel("games", "text", "member", "member", 0).Id;
        var file = FileFor(server, alice);
        var original = await Say(alice, server.General, $"look <@{bob.Key}>", [file]);

        var reply = await bob.RequestAsync("chat.forward", new { id = original.GetProperty("id").GetInt64(), channelId = games });
        var copy = reply.Body().GetProperty("message");
        Assert.Equal(bob.Key, copy.GetProperty("author").GetString());
        Assert.Equal($"look <@{bob.Key}>", copy.GetProperty("text").GetString());
        Assert.Equal(file, copy.GetProperty("attachments")[0].GetProperty("id").GetString());
        var from = copy.GetProperty("forwarded");
        Assert.Equal(server.General, from.GetProperty("channelId").GetInt64());
        Assert.Equal("general", from.GetProperty("channelName").GetString());
        Assert.Equal(original.GetProperty("id").GetInt64(), from.GetProperty("messageId").GetInt64());

        // Everyone in #games sees it (with the same line), and history keeps it.
        var seen = (await alice.EventAsync("chat.message")).Body().GetProperty("message");
        while (seen.GetProperty("channelId").GetInt64() != games) seen = (await alice.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("general", seen.GetProperty("forwarded").GetProperty("channelName").GetString());
        var history = (await alice.RequestAsync("chat.history", new { channelId = games })).Body().GetProperty("messages");
        Assert.Equal("general", history[0].GetProperty("forwarded").GetProperty("channelName").GetString());
        Assert.Equal(JsonValueKind.Null, original.GetProperty("forwarded").ValueKind);

        // A forward of a forward points at the original.
        var again = (await alice.RequestAsync("chat.forward", new { id = copy.GetProperty("id").GetInt64(), channelId = server.General })).Body().GetProperty("message");
        Assert.Equal(original.GetProperty("id").GetInt64(), again.GetProperty("forwarded").GetProperty("messageId").GetInt64());
    }

    [Fact]
    public async Task You_can_only_forward_what_you_can_read_to_where_you_can_write()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var staff = server.World.Store.CreateChannel("staff", "text", "admin", "admin", 0).Id;
        var news = server.World.Store.CreateChannel("news", "text", "member", "admin", 0).Id;
        var secret = await Say(admin, staff, "secret plans");
        var hello = await Say(admin, server.General, "hello");

        Assert.Equal("not_found", (await member.RequestAsync("chat.forward", new { id = secret.GetProperty("id").GetInt64(), channelId = server.General })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.forward", new { id = hello.GetProperty("id").GetInt64(), channelId = staff })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("chat.forward", new { id = hello.GetProperty("id").GetInt64(), channelId = news })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.forward", new { id = 99999, channelId = server.General })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("chat.forward", new { id = hello.GetProperty("id").GetInt64() })).ErrorCode());

        var poll = (await admin.RequestAsync("poll.create", new { channelId = server.General, question = "pizza?", options = new[] { "yes", "no" } })).Body().GetProperty("message");
        Assert.Equal("bad_request", (await member.RequestAsync("chat.forward", new { id = poll.GetProperty("id").GetInt64(), channelId = server.General })).ErrorCode());
    }

    [Fact]
    public async Task A_private_channels_name_never_reaches_people_who_cannot_read_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var staff = server.World.Store.CreateChannel("staff-room", "text", "admin", "admin", 0).Id;
        var secret = await Say(admin, staff, "the party is on friday");

        var copy = (await admin.RequestAsync("chat.forward", new { id = secret.GetProperty("id").GetInt64(), channelId = server.General })).Body().GetProperty("message");
        var from = copy.GetProperty("forwarded");
        Assert.Equal(JsonValueKind.Null, from.GetProperty("channelName").ValueKind);
        Assert.Equal(JsonValueKind.Null, from.GetProperty("channelId").ValueKind);
        Assert.Equal(JsonValueKind.Null, from.GetProperty("messageId").ValueKind);

        JsonElement seen;
        do seen = await member.EventAsync("chat.message");
        while (seen.Body().GetProperty("message").GetProperty("id").GetInt64() != copy.GetProperty("id").GetInt64());
        Assert.DoesNotContain("staff-room", seen.GetRawText());
        var history = (await member.RequestAsync("chat.history", new { channelId = server.General })).GetRawText();
        Assert.DoesNotContain("staff-room", history);

        // Into another admin-only channel the name is fine: everyone there can read the source.
        var other = server.World.Store.CreateChannel("mods", "text", "admin", "admin", 0).Id;
        var inside = (await admin.RequestAsync("chat.forward", new { id = secret.GetProperty("id").GetInt64(), channelId = other })).Body().GetProperty("message");
        Assert.Equal("staff-room", inside.GetProperty("forwarded").GetProperty("channelName").GetString());

        // If the source channel later becomes stricter, older forwards stop naming it.
        var open = server.World.Store.CreateChannel("open", "text", "member", "member", 0).Id;
        var post = await Say(admin, open, "public note");
        var fwd = (await admin.RequestAsync("chat.forward", new { id = post.GetProperty("id").GetInt64(), channelId = server.General })).Body().GetProperty("message");
        Assert.Equal("open", fwd.GetProperty("forwarded").GetProperty("channelName").GetString());
        await admin.RequestAsync("channel.update", new { id = open, readRole = "admin", writeRole = "admin" });
        var later = (await member.RequestAsync("chat.history", new { channelId = server.General })).GetRawText();
        Assert.DoesNotContain("\"open\"", later);
    }

    [Fact]
    public async Task Forwards_do_not_ping_again()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var endpoint = "https://fcm.googleapis.com/fcm/send/" + Guid.NewGuid().ToString("N");
        using (var key = System.Security.Cryptography.ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256))
        {
            var q = key.ExportParameters(false).Q;
            await bob.RequestAsync("push.subscribe", new
            {
                endpoint,
                keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(new byte[16]) },
            });
        }
        var games = server.World.Store.CreateChannel("games", "text", "member", "member", 0).Id;
        var original = await Say(alice, games, $"<@{bob.Key}> hi");
        await server.Push.WaitForAsync(endpoint);
        await Task.Delay(700);
        await alice.RequestAsync("chat.forward", new { id = original.GetProperty("id").GetInt64(), channelId = server.General });
        await server.Push.NoneAsync(endpoint, already: 1);
    }

    // ── Synced preferences ──────────────────────────────────────────────────

    private static string Blob(int bytes = 64) => Ed25519.ToB64u(System.Security.Cryptography.RandomNumberGenerator.GetBytes(bytes));

    [Fact]
    public async Task Prefs_are_per_account_and_the_newest_wins()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var phone = await server.ConnectAsync();
        await phone.LoginAsync(alice.Identity, "Alice");

        var empty = (await alice.RequestAsync("prefs.get", new { name = "rail" })).Body();
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("data").ValueKind);

        var data = Blob(8000); // a big rail
        Assert.Equal("result", (await alice.RequestAsync("prefs.set", new { name = "rail", data, updatedAt = 1000 })).Type());
        Assert.Equal(1000, (await phone.EventAsync("prefs.updated")).Body().GetProperty("updatedAt").GetInt64());
        await alice.NoEventAsync("prefs.updated");
        Assert.Equal(data, (await phone.RequestAsync("prefs.get", new { name = "rail" })).Body().GetProperty("data").GetString());
        Assert.Equal(JsonValueKind.Null, (await bob.RequestAsync("prefs.get", new { name = "rail" })).Body().GetProperty("data").ValueKind);

        // An older write is ignored.
        await phone.RequestAsync("prefs.set", new { name = "rail", data = Blob(), updatedAt = 500 });
        Assert.Equal(data, (await alice.RequestAsync("prefs.get", new { name = "rail" })).Body().GetProperty("data").GetString());
        phone.Dispose();
    }

    [Fact]
    public async Task Prefs_are_checked()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        Assert.Equal("bad_request", (await alice.RequestAsync("prefs.set", new { name = "Rail!", data = Blob(), updatedAt = 1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("prefs.set", new { name = "rail", data = "not base64 !", updatedAt = 1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("prefs.set", new { name = "rail", data = Blob(8), updatedAt = 1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("prefs.set", new { name = "rail", data = Blob(20_000), updatedAt = 1 })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("prefs.set", new { name = "rail", data = Blob() })).ErrorCode());
        for (var i = 0; i < 16; i++) server.World.Store.SetPref(alice.Key, $"p{i}", Blob(), 1); // (prefs.set is rate limited)
        Assert.Equal("bad_request", (await alice.RequestAsync("prefs.set", new { name = "one-more", data = Blob(), updatedAt = 1 })).ErrorCode());
    }
}
