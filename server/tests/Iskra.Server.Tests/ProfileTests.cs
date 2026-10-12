using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class ProfileTests
{
    // A real 3×2 PNG.
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=");

    private const string Page = "<!doctype html><html><body><h1>Hi</h1><script>document.title = 'mine'</script></body></html>";

    private static async Task<string> Upload(IskraServer server, User user, byte[] content, string name)
    {
        var ticket = (await user.RequestAsync("upload.begin", new { name, size = content.Length })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent(content));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
    }

    private static async Task<JsonElement> Publish(IskraServer server, User user, string html) =>
        await user.RequestAsync("profile.page.set", new { file = await Upload(server, user, Encoding.UTF8.GetBytes(html), "page.html") });

    [Fact]
    public async Task Bio_pronouns_and_accent_are_validated_and_broadcast()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var result = await alice.RequestAsync("profile.update", new { bio = "Hi, I **build** things.", pronouns = "she/her", accent = "#FF8800" });
        var member = result.Body().GetProperty("member");
        Assert.Equal("Hi, I **build** things.", member.GetProperty("bio").GetString());
        Assert.Equal("she/her", member.GetProperty("pronouns").GetString());
        Assert.Equal("#ff8800", member.GetProperty("accent").GetString());
        Assert.Equal("Alice", member.GetProperty("name").GetString());

        var seen = (await bob.EventAsync("member.updated")).Body().GetProperty("member");
        while (seen.GetProperty("accountKey").GetString() != alice.Key || seen.GetProperty("bio").ValueKind == JsonValueKind.Null)
            seen = (await bob.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.Equal("she/her", seen.GetProperty("pronouns").GetString());

        Assert.Equal("bad_request", (await alice.RequestAsync("profile.update", new { bio = new string('a', 191) })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("profile.update", new { bio = "hi\u202Ethere" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("profile.update", new { accent = "red; background: url(x)" })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("profile.update", new { pronouns = new string('x', 41) })).ErrorCode());

        // "" clears a field and leaves the others alone.
        member = (await alice.RequestAsync("profile.update", new { bio = "" })).Body().GetProperty("member");
        Assert.Equal(JsonValueKind.Null, member.GetProperty("bio").ValueKind);
        Assert.Equal("she/her", member.GetProperty("pronouns").GetString());

        // A rename still works the old way.
        member = (await alice.RequestAsync("profile.update", new { name = "Alicia" })).Body().GetProperty("member");
        Assert.Equal("Alicia", member.GetProperty("name").GetString());
        Assert.Equal("#ff8800", member.GetProperty("accent").GetString());
    }

    [Fact]
    public async Task Profile_fields_in_auth_are_applied_and_bad_ones_ignored()
    {
        using var server = new IskraServer();
        using var identity = new TestIdentity();
        using var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, "Carol", invite: server.Invite());
        var profile = frame["body"]!["profile"]!.AsObject();
        profile["bio"] = "Plays bass.";
        profile["pronouns"] = "they/them";
        profile["accent"] = "javascript:alert(1)";
        await client.SendAsync(frame);
        var welcome = await client.ReceiveAsync();
        Assert.Equal("welcome", welcome.Type());
        var you = welcome.Body().GetProperty("you");
        Assert.Equal("Plays bass.", you.GetProperty("bio").GetString());
        Assert.Equal("they/them", you.GetProperty("pronouns").GetString());
        Assert.Equal(JsonValueKind.Null, you.GetProperty("accent").ValueKind);
        Assert.True(welcome.Body().GetProperty("server").GetProperty("profilePages").GetBoolean());
    }

    [Fact]
    public async Task Avatars_must_be_your_own_small_images()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var image = await Upload(server, alice, Png, "me.png");
        var member = (await alice.RequestAsync("profile.update", new { avatar = image })).Body().GetProperty("member");
        Assert.StartsWith($"/files/{image}/", member.GetProperty("avatar").GetString());
        Assert.Equal(Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Png)), member.GetProperty("avatarHash").GetString());

        // Someone else's upload, a non-image, a made-up id.
        Assert.Equal("bad_request", (await bob.RequestAsync("profile.update", new { avatar = image })).ErrorCode());
        var text = await Upload(server, bob, Encoding.UTF8.GetBytes("<svg onload=alert(1)>"), "x.png");
        Assert.Equal("bad_request", (await bob.RequestAsync("profile.update", new { avatar = text })).ErrorCode());
        // An image whose size can't be read (here a JPEG with no frame header) isn't accepted either.
        var sizeless = await Upload(server, bob, [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xD9], "x.jpg");
        Assert.Equal("bad_request", (await bob.RequestAsync("profile.update", new { avatar = sizeless })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("profile.update", new { avatar = "nope" })).ErrorCode());

        member = (await alice.RequestAsync("profile.update", new { avatar = "" })).Body().GetProperty("member");
        Assert.Equal(JsonValueKind.Null, member.GetProperty("avatar").ValueKind);
    }

    [Fact]
    public async Task Pages_are_served_in_a_locked_sandbox()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");

        var member = (await Publish(server, alice, Page)).Body().GetProperty("member");
        var url = member.GetProperty("page").GetString()!;
        Assert.Matches("^/pages/[A-Za-z0-9_-]{22}$", url);
        Assert.Equal(Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(Page))),
            member.GetProperty("pageHash").GetString());

        using var response = await server.CreateClient().GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType!.MediaType);
        var csp = response.Headers.GetValues("Content-Security-Policy").Single();
        // Scripts are off unless the viewer turns them on.
        Assert.StartsWith("sandbox; ", csp);
        Assert.DoesNotContain("allow-scripts", csp);
        Assert.Contains("script-src 'none'", csp);
        Assert.DoesNotContain("allow-same-origin", csp);
        Assert.DoesNotContain("allow-top-navigation", csp);
        Assert.DoesNotContain("allow-popups", csp);
        foreach (var directive in new[] { "default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "base-uri 'none'", "object-src 'none'" })
            Assert.Contains(directive, csp);
        Assert.Contains("img-src data: blob: http://localhost/files/;", csp);
        Assert.Contains("frame-ancestors 'self' https://app.iskra.foo app://iskra", csp);
        Assert.Contains(" capacitor://localhost ", csp); // the iPhone/iPad app (mobile/)
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("no-referrer", response.Headers.GetValues("Referrer-Policy").Single());
        Assert.Contains("camera=()", response.Headers.GetValues("Permissions-Policy").Single());
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString());

        Assert.Equal(Page, await response.Content.ReadAsStringAsync());

        // With scripts on: allow-scripts, and the WebRTC and frame lock right after the doctype.
        using var withScripts = await server.CreateClient().GetAsync(url + "?scripts=1");
        var scriptPolicy = withScripts.Headers.GetValues("Content-Security-Policy").Single();
        Assert.StartsWith("sandbox allow-scripts;", scriptPolicy);
        Assert.Contains("script-src 'unsafe-inline'", scriptPolicy);
        foreach (var directive in new[] { "frame-src 'none'", "child-src 'none'", "connect-src 'none'", "worker-src 'none'" })
            Assert.Contains(directive, scriptPolicy);
        Assert.DoesNotContain("allow-same-origin", scriptPolicy);
        var body = await withScripts.Content.ReadAsStringAsync();
        Assert.StartsWith("<!doctype html><script>", body);
        foreach (var locked in new[] { "RTCPeerConnection", "contentWindow", "contentDocument", "createElement", "\"frames\"" })
            Assert.Contains(locked, body);
        Assert.EndsWith(Page["<!doctype html>".Length..], body);

        // Republishing changes the address; the old one is gone.
        var next = (await Publish(server, alice, "<p>v2</p>")).Body().GetProperty("member").GetProperty("page").GetString();
        Assert.NotEqual(url, next);
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync("/pages/..%2F..%2Fiskra.db")).StatusCode);
    }

    [Fact]
    public async Task Page_policy_follows_the_address_the_viewer_used()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var url = (await Publish(server, alice, Page)).Body().GetProperty("member").GetProperty("page").GetString();

        // E.g. the public HTTPS address from internet hosting.
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Host = "203-0-113-7.sslip.io:47070";
        using var response = await server.CreateClient().SendAsync(request);
        var csp = response.Headers.GetValues("Content-Security-Policy").Single();
        Assert.Contains("img-src data: blob: http://203-0-113-7.sslip.io:47070/files/;", csp);

        // A forged Host header can't smuggle anything into the policy.
        using var forged = new HttpRequestMessage(HttpMethod.Get, url);
        forged.Headers.TryAddWithoutValidation("Host", "evil.example; script-src *");
        using var bad = await server.CreateClient().SendAsync(forged);
        if (bad.StatusCode == HttpStatusCode.OK)
            Assert.DoesNotContain("evil", bad.Headers.GetValues("Content-Security-Policy").Single());
    }

    [Fact]
    public async Task Page_size_and_encoding_limits()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var exactly = "<p>" + new string('a', 512 * 1024 - 7) + "</p>";
        Assert.Equal(512 * 1024, Encoding.UTF8.GetByteCount(exactly));
        Assert.Equal("result", (await Publish(server, alice, exactly)).Type());
        Assert.Equal("bad_request", (await Publish(server, alice, exactly + " ")).ErrorCode());

        var notText = await Upload(server, alice, [0x3C, 0x70, 0xFF, 0xFE, 0x3E], "page.html");
        Assert.Equal("bad_request", (await alice.RequestAsync("profile.page.set", new { file = notText })).ErrorCode());

        var bobsFile = await Upload(server, bob, Encoding.UTF8.GetBytes(Page), "page.html");
        Assert.Equal("bad_request", (await alice.RequestAsync("profile.page.set", new { file = bobsFile })).ErrorCode());
    }

    [Fact]
    public async Task Admins_remove_pages_of_members_below_them()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var url = (await Publish(server, alice, Page)).Body().GetProperty("member").GetProperty("page").GetString();
        var adminPage = (await Publish(server, admin, Page)).Body().GetProperty("member").GetProperty("page").GetString();

        Assert.Equal("forbidden", (await bob.RequestAsync("profile.page.remove", new { accountKey = alice.Key })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("profile.page.remove", new { accountKey = admin.Key })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("profile.page.remove", new { accountKey = alice.Key })).Type());
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync(url)).StatusCode);
        Assert.Equal("not_found", (await admin.RequestAsync("profile.page.remove", new { accountKey = alice.Key })).ErrorCode());

        // Everyone hears that Alice's page is gone.
        JsonElement update;
        do update = (await bob.EventAsync("member.updated")).Body().GetProperty("member");
        while (update.GetProperty("accountKey").GetString() != alice.Key || update.GetProperty("page").ValueKind != JsonValueKind.Null);

        // Your own page you can always remove.
        Assert.Equal("result", (await admin.RequestAsync("profile.page.remove")).Type());
        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync(adminPage)).StatusCode);
    }

    [Fact]
    public async Task Admins_can_turn_pages_off_and_back_on()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var url = (await Publish(server, alice, Page)).Body().GetProperty("member").GetProperty("page").GetString();

        Assert.Equal("forbidden", (await alice.RequestAsync("profile.pages.configure", new { enabled = false })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("profile.pages.configure", new { })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("profile.pages.configure", new { enabled = false })).Type());
        Assert.False((await alice.EventAsync("profile.pages")).Body().GetProperty("enabled").GetBoolean());

        Assert.Equal(HttpStatusCode.NotFound, (await server.CreateClient().GetAsync(url)).StatusCode);
        Assert.Equal("forbidden", (await Publish(server, alice, Page)).ErrorCode());
        using (var carol = await server.JoinAsync("Carol"))
        {
            Assert.False(carol.Welcome.Body().GetProperty("server").GetProperty("profilePages").GetBoolean());
            var listed = carol.Welcome.Body().GetProperty("members").EnumerateArray().Single(m => m.GetProperty("accountKey").GetString() == alice.Key);
            Assert.Equal(JsonValueKind.Null, listed.GetProperty("page").ValueKind);
        }

        // Turning them back on restores existing pages.
        Assert.Equal("result", (await admin.RequestAsync("profile.pages.configure", new { enabled = true })).Type());
        Assert.Equal(HttpStatusCode.OK, (await server.CreateClient().GetAsync(url)).StatusCode);
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
    public async Task A_name_sent_on_connect_reaches_everyone_even_while_another_device_is_online()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        // Another of Alice's sessions (a server that was offline when she renamed, or her other device) connects
        // with her new name while she's still online here.
        using var again = await server.ConnectAsync();
        Assert.Equal("welcome", (await again.LoginAsync(alice.Identity, "Alicia")).Type());
        Assert.Equal("Alicia", (await UpdateOf(bob, alice.Key)).GetProperty("name").GetString());
        Assert.Equal("Alicia", (await UpdateOf(alice, alice.Key)).GetProperty("name").GetString());

        // Nothing new: no event.
        using var third = await server.ConnectAsync();
        Assert.Equal("welcome", (await third.LoginAsync(alice.Identity, "Alicia")).Type());
        await bob.NoEventAsync("member.updated");

        // With a server nickname the nickname stays the name here, and the new name comes along as profileName.
        Assert.Equal("result", (await alice.RequestAsync("member.nick", new { nick = "Al" })).Type());
        Assert.Equal("Al", (await UpdateOf(bob, alice.Key)).GetProperty("name").GetString());
        using var fourth = await server.ConnectAsync();
        Assert.Equal("welcome", (await fourth.LoginAsync(alice.Identity, "Ally")).Type());
        var seen = await UpdateOf(bob, alice.Key);
        Assert.Equal("Al", seen.GetProperty("name").GetString());
        Assert.Equal("Ally", seen.GetProperty("profileName").GetString());
    }
}
