using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>The public page at the server's address (PROTOCOL.md "Public page").</summary>
public class LandingTests
{
    private const string BrowserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    private static async Task<(HttpResponseMessage Response, string Html)> Page(IskraServer server, string language = "en-US,en;q=0.9")
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/");
        request.Headers.TryAddWithoutValidation("Accept", BrowserAccept);
        request.Headers.TryAddWithoutValidation("Accept-Language", language);
        var response = await server.CreateClient().SendAsync(request);
        return (response, await response.Content.ReadAsStringAsync());
    }

    private static string Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) ? string.Join(",", values)
        : response.Content.Headers.TryGetValues(name, out var content) ? string.Join(",", content) : "";

    private static async Task<JsonElement> Update(User owner, object change)
    {
        var reply = await owner.RequestAsync("landing.update", change);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("settings");
    }

    private static async Task<string> MemberInvite(User by, object? options = null)
    {
        var reply = await by.RequestAsync("invite.create", options ?? new { });
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("invite").GetProperty("code").GetString()!;
    }

    private static string? Key(JsonElement frame) => frame.Body().TryGetProperty("key", out var k) ? k.GetString() : null;

    [Fact]
    public async Task Off_by_default_the_page_only_says_its_an_Iskra_server_and_leaks_nothing()
    {
        using var server = new IskraServer();
        server.World.UpdateSettings(s => s with { Name = "Secret Crew" });
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        await owner.RequestAsync("server.images.set", new { icon = await EmojiTests.Upload(server, owner, ServerImageTests.Png(256, 256), "icon.png") });
        await owner.RequestAsync("rules.update", new { text = "Be kind to the hamsters" });
        var code = await MemberInvite(owner);
        // Everything chosen, but the page itself is off.
        var settings = await Update(owner, new { description = "Hidden words", showRules = true, showCounts = true, invite = code, indexable = true });
        Assert.False(settings.GetProperty("enabled").GetBoolean());

        var (response, html) = await Page(server);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.StartsWith("text/html", response.Content.Headers.ContentType!.ToString());
        Assert.Contains("This is an Iskra server", html);
        Assert.Contains("https://app.iskra.foo", html);
        Assert.Contains(LandingPage.Website + "/#download", html);
        foreach (var leak in new[] { "Secret Crew", "Hidden words", "hamsters", "/icon", "/files/", "#/join/", "iskra://", code, "member", "online" })
            Assert.DoesNotContain(leak, html, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("noindex, nofollow", Header(response, "X-Robots-Tag"));
        Assert.Contains("<meta name=\"robots\" content=\"noindex, nofollow\">", html);

        // The apps still read the JSON (fetch accepts anything).
        using var json = await server.CreateClient().GetAsync("/");
        Assert.Equal("application/json", json.Content.Headers.ContentType!.MediaType);
        Assert.Equal(1, JsonDocument.Parse(await json.Content.ReadAsStringAsync()).RootElement.GetProperty("iskra").GetInt32());
    }

    [Fact]
    public async Task On_it_shows_exactly_the_chosen_fields()
    {
        using var server = new IskraServer();
        server.World.UpdateSettings(s => s with { Name = "Crew" });
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");
        await owner.RequestAsync("rules.update", new { text = "Be kind to the hamsters" });

        await Update(owner, new { enabled = true, description = "Tuesday games and bad jokes" });
        var (response, html) = await Page(server);
        Assert.Contains("<h1>Crew</h1>", html);
        Assert.Contains("Tuesday games and bad jokes", html);
        Assert.DoesNotContain("data-counts", html);
        Assert.DoesNotContain("hamsters", html);
        Assert.DoesNotContain("data-join", html);
        Assert.DoesNotContain("/icon", html); // no icon set
        Assert.Contains("ask someone here for an invite", html);
        Assert.Equal("noindex, nofollow", Header(response, "X-Robots-Tag"));

        var code = await MemberInvite(owner);
        var settings = await Update(owner, new { showRules = true, showCounts = true, invite = code });
        Assert.Equal(code, settings.GetProperty("invite").GetProperty("code").GetString());
        (_, html) = await Page(server);
        Assert.Contains("hamsters", html);
        Assert.Contains("2 members · 2 online", html); // owner and Bob, both connected
        var token = $"{Ed25519.ToB64u(Encoding.UTF8.GetBytes("http://localhost"))}.{Ed25519.ToB64u(server.World.ServerPublicKey)}.{code}";
        Assert.Contains($"href=\"https://app.iskra.foo/#/join/{token}\"", html);
        Assert.Contains($"href=\"iskra://join/{token}\"", html);

        // Search engines only when asked.
        await Update(owner, new { indexable = true });
        (response, html) = await Page(server);
        Assert.Equal("", Header(response, "X-Robots-Tag"));
        Assert.Contains("<meta name=\"robots\" content=\"index, follow\">", html);

        // The icon and banner show once set.
        await owner.RequestAsync("server.images.set", new
        {
            icon = await EmojiTests.Upload(server, owner, ServerImageTests.Png(256, 256), "icon.png"),
            banner = await EmojiTests.Upload(server, owner, ServerImageTests.Png(960, 360), "banner.png"),
        });
        (_, html) = await Page(server);
        Assert.Contains("src=\"/icon?v=", html);
        Assert.Contains("class=\"banner\" src=\"/files/", html);

        // Turned off again: back to the plain page.
        await Update(owner, new { enabled = false });
        (_, html) = await Page(server);
        Assert.DoesNotContain("Crew", html);
        Assert.DoesNotContain("/icon", html);
    }

    [Fact]
    public async Task Hostile_names_descriptions_and_rules_are_html_encoded()
    {
        using var server = new IskraServer();
        server.World.UpdateSettings(s => s with { Name = "<script>alert(1)</script>&\"'" });
        using var owner = await server.JoinAsync("Owner", "owner");
        await owner.RequestAsync("rules.update", new { text = "</details><script>alert(2)</script>" });
        await Update(owner, new { enabled = true, showRules = true, description = "<img src=x onerror=alert(3)>\n\"quoted\" & 'single'" });

        var (_, html) = await Page(server);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<img src=x", html);
        Assert.Contains("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;", html);
        Assert.Contains("&lt;img src=x onerror=alert(3)&gt;", html);
        Assert.Contains("&lt;/details&gt;&lt;script&gt;alert(2)", html);
    }

    [Fact]
    public async Task Paused_invites_say_so_instead_of_offering_join_and_a_gone_invite_hides_the_button()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var code = await MemberInvite(owner, new { approve = true });
        await Update(owner, new { enabled = true, invite = code });
        var (_, html) = await Page(server);
        Assert.Contains("data-join", html);
        Assert.Contains("A moderator lets you in", html);

        await owner.RequestAsync("join.settings.update", new { invitesPaused = true });
        (_, html) = await Page(server);
        Assert.DoesNotContain("data-join", html);
        Assert.DoesNotContain(code, html);
        Assert.Contains("taking new members right now", html);

        await owner.RequestAsync("join.settings.update", new { invitesPaused = false });
        await owner.RequestAsync("invite.revoke", new { code });
        (_, html) = await Page(server);
        Assert.DoesNotContain("data-join", html);
        Assert.Contains("ask someone here for an invite", html);
        var view = (await owner.RequestAsync("landing.get")).Body().GetProperty("settings");
        Assert.Equal(JsonValueKind.Null, view.GetProperty("invite").ValueKind);
        Assert.True(view.GetProperty("inviteGone").GetBoolean());
    }

    [Fact]
    public async Task The_page_runs_no_scripts_and_its_one_stylesheet_matches_the_policy()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        foreach (var enabled in new[] { false, true })
        {
            await Update(owner, new { enabled });
            var (response, html) = await Page(server);
            var csp = Header(response, "Content-Security-Policy");
            Assert.Equal(LandingPage.Policy, csp);
            Assert.StartsWith("default-src 'none'; style-src 'sha256-", csp);
            Assert.Contains("img-src 'self'", csp);
            Assert.Contains("frame-ancestors 'none'", csp);
            Assert.DoesNotContain("unsafe", csp);
            Assert.DoesNotContain("script-src", csp);
            Assert.DoesNotContain("<script", html);
            Assert.Equal("DENY", Header(response, "X-Frame-Options"));
            Assert.Equal("nosniff", Header(response, "X-Content-Type-Options"));
            Assert.Equal("no-store", Header(response, "Cache-Control"));

            var start = html.IndexOf("<style>", StringComparison.Ordinal) + "<style>".Length;
            var css = html[start..html.IndexOf("</style>", start, StringComparison.Ordinal)];
            Assert.False(css.Contains((char)13)); // no CR: browsers hash the stylesheet with CRLF turned into LF
            Assert.Contains($"'sha256-{Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(css)))}'", csp);
            Assert.Equal(1, html.Split("<style").Length - 1);
            Assert.DoesNotContain(" style=", html);
            Assert.DoesNotContain("http://", html.Replace("http://www.w3.org", "")); // nothing loads over plain HTTP from elsewhere
        }
    }

    [Theory]
    [InlineData("sv-SE,sv;q=0.9,en;q=0.8", "sv")]
    [InlineData("sv", "sv")]
    [InlineData("en-GB", "en")]
    [InlineData("de-DE, en;q=0.5", "en")]
    [InlineData("de-DE", "en")]
    [InlineData("en;q=0.4, sv;q=0.8", "sv")]
    [InlineData("sv;q=0, en", "en")]
    [InlineData("", "en")]
    [InlineData("garbage;;q=x,,", "en")]
    public void Accept_language_picks_swedish_or_english(string header, string expected) =>
        Assert.Equal(expected, LandingPage.Language(header));

    [Fact]
    public async Task The_page_speaks_swedish_to_a_swedish_browser()
    {
        using var server = new IskraServer();
        var (response, html) = await Page(server, "sv-SE,sv;q=0.9,en;q=0.5");
        Assert.Contains("<html lang=\"sv\">", html);
        Assert.Contains("Det här är en Iskra-server", html);
        Assert.Equal("sv", Header(response, "Content-Language"));
        Assert.Contains("Accept-Language", Header(response, "Vary"));
        (_, html) = await Page(server, "fr");
        Assert.Contains("<html lang=\"en\">", html);
    }

    [Fact]
    public async Task Only_the_owner_changes_it_and_bad_values_are_refused()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        foreach (var user in new[] { admin, bob })
        {
            Assert.Equal("owner_landing", Key(await user.RequestAsync("landing.get")));
            var refused = await user.RequestAsync("landing.update", new { enabled = true });
            Assert.Equal("forbidden", refused.ErrorCode());
            Assert.Equal("owner_landing", Key(refused));
        }
        Assert.False(server.World.Store.Landing().Enabled);

        var tooLong = await owner.RequestAsync("landing.update", new { description = new string('x', LandingFeature.MaxDescriptionLength + 1) });
        Assert.Equal("landing_description", Key(tooLong));
        Assert.Equal("landing_description", Key(await owner.RequestAsync("landing.update", new { description = "bad‮one" })));

        var adminInvite = (await owner.RequestAsync("invite.create", new { role = "admin" })).Body().GetProperty("invite").GetProperty("code").GetString();
        Assert.Equal("landing_invite_role", Key(await owner.RequestAsync("landing.update", new { invite = adminInvite })));
        Assert.Equal("landing_invite", Key(await owner.RequestAsync("landing.update", new { invite = "nope-not-a-code" })));
        var revoked = await MemberInvite(owner);
        await owner.RequestAsync("invite.revoke", new { code = revoked });
        Assert.Equal("landing_invite", Key(await owner.RequestAsync("landing.update", new { invite = revoked })));

        // A blank description or invite clears it.
        var code = await MemberInvite(owner);
        await Update(owner, new { description = "  hi  ", invite = code });
        var settings = await Update(owner, new { description = "   ", invite = "" });
        Assert.Equal("", settings.GetProperty("description").GetString());
        Assert.Equal(JsonValueKind.Null, settings.GetProperty("invite").ValueKind);
        Assert.False(settings.GetProperty("inviteGone").GetBoolean());
        await Update(owner, new { invite = code });
        var nulled = await owner.RequestAsync("landing.update", JsonDocument.Parse("{\"invite\":null}").RootElement);
        Assert.Equal(JsonValueKind.Null, nulled.Body().GetProperty("settings").GetProperty("invite").ValueKind);
    }

    [Fact]
    public async Task Changes_reach_the_owners_devices_the_activity_log_and_the_security_log()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        await Update(owner, new { enabled = true, description = "Private-ish words" });
        var evt = (await owner.EventAsync("landing.settings")).Body().GetProperty("settings");
        Assert.True(evt.GetProperty("enabled").GetBoolean());

        var logged = Assert.Single(server.World.Store.SecurityEvents("landing.settings", null, null, 10));
        Assert.Equal(owner.Key, logged.Account);
        Assert.Contains("\"enabled\":true", logged.Details);
        Assert.DoesNotContain("Private-ish", logged.Details); // never the text itself

        // Nothing changed: nothing logged.
        await Update(owner, new { enabled = true });
        Assert.Single(server.World.Store.SecurityEvents("landing.settings", null, null, 10));

        var actions = (await owner.RequestAsync("audit.list", new { })).Body().GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("action").GetString());
        Assert.Contains("landing.update", actions);
    }

    [Fact]
    public async Task Browsers_asking_too_often_are_slowed_down()
    {
        using var server = new IskraServer();
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 40; i++) statuses.Add((await Page(server)).Response.StatusCode);
        Assert.Contains(HttpStatusCode.TooManyRequests, statuses);
        Assert.Equal(HttpStatusCode.OK, statuses[0]);
        // The apps' JSON isn't affected.
        using var json = await server.CreateClient().GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, json.StatusCode);
    }

    [Theory]
    [InlineData(0, 0, true)]
    [InlineData(7, 7, true)]
    [InlineData(10, 10, false)]
    [InlineData(47, 45, false)]
    [InlineData(123, 120, false)]
    [InlineData(4567, 4500, false)]
    public void Counts_are_rounded(int n, int shown, bool exact) => Assert.Equal((shown, exact), LandingPage.Approximate(n));

    [Fact]
    public void Long_rules_are_cut_at_a_word()
    {
        var rules = string.Join(' ', Enumerable.Repeat("rule", 400));
        var summary = LandingPage.RulesSummary(rules);
        Assert.True(summary.Length <= LandingPage.RulesSummaryLength + 1);
        Assert.EndsWith("rule…", summary);
        Assert.Equal("Short", LandingPage.RulesSummary("  Short  "));
    }

    [Fact]
    public void Download_links_match_the_apps_links()
    {
        var links = File.ReadAllText(Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Repo.ProtocolFile("PROTOCOL.md")))!, "client", "src", "links.ts"));
        Assert.Contains($"releases: '{LandingPage.Releases}'", links);
        Assert.Contains($"website: '{LandingPage.Website}'", links);
    }
}
