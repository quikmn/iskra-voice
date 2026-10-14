using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Server images ("OwnerClaim": "generate"): the server makes its own claim code for whoever opens its console.</summary>
public class GeneratedClaimTests : IDisposable
{
    private readonly IskraServer _server = new();

    public GeneratedClaimTests()
    {
        Directory.CreateDirectory(_server.WorldPath);
        File.WriteAllText(Path.Combine(_server.WorldPath, "server.json"), JsonSerializer.Serialize(new { Name = "Droplet", OwnerClaim = "generate" }));
    }

    public void Dispose() => _server.Dispose();

    private string CodePath => Path.Combine(_server.WorldPath, OwnerSetup.CodeFile);
    private string ClaimPath => Path.Combine(_server.WorldPath, OwnerSetup.ClaimFile);
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>The code from owner-claim-code.txt, as the console shows it.</summary>
    private string Code()
    {
        var line = File.ReadAllLines(CodePath).Single(l => l.StartsWith("code=", StringComparison.Ordinal));
        return line["code=".Length..];
    }

    private static string InviteFor(string code) => OwnerSetup.ClaimCode(OwnerSetup.ClaimFromCode(code));

    [Fact]
    public async Task The_console_code_makes_you_the_owner_once()
    {
        var http = _server.CreateClient();
        var code = Code();
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$", code);
        Assert.Contains($"address={_server.World.Settings.EffectivePublicUrl}", File.ReadAllText(CodePath));
        Assert.Matches(@"expires=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", File.ReadAllText(CodePath));
        // Kept until the owner has joined, so a restart after it expired makes a new one.
        Assert.Equal("generate", JsonNode.Parse(File.ReadAllText(Path.Combine(_server.WorldPath, "server.json")))!["OwnerClaim"]!.GetValue<string>());

        // The app derives the claim from the typed code and checks the server's proof, as for a rented server.
        const string nonce = "abcdefghijklmnop0123";
        var answer = await http.GetFromJsonAsync<JsonElement>($"/.well-known/iskra-claim?nonce={nonce}", TestContext.Current.CancellationToken);
        var key = answer.GetProperty("key").GetString()!;
        var typed = code.ToLowerInvariant().Replace("-", " ");
        Assert.Equal(Ed25519.ToB64u(OwnerSetup.ClaimProof(OwnerSetup.ClaimFromCode(typed), key, nonce)), answer.GetProperty("proof").GetString());

        using var client = await _server.ConnectAsync();
        var welcome = await client.LoginAsync(new TestIdentity(), "Ada", InviteFor(typed));
        Assert.Equal("welcome", welcome.GetProperty("type").GetString());
        Assert.True(_server.World.Store.HasOwner());

        // Gone: the files, the setting, the endpoint and the invite.
        Assert.False(File.Exists(CodePath));
        Assert.False(File.Exists(ClaimPath));
        Assert.Null(_server.World.Settings.OwnerClaim);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/.well-known/iskra-claim?nonce={nonce}", TestContext.Current.CancellationToken)).StatusCode);
        using var again = await _server.ConnectAsync();
        Assert.Equal("error", (await again.LoginAsync(new TestIdentity(), "Mallory", InviteFor(code))).GetProperty("type").GetString());

        // A restart now does nothing: no new code for a server that has an owner.
        Assert.Null(OwnerSetup.EnsureOwnerInvite(_server.World, Now, out _));
        Assert.False(File.Exists(CodePath));

        // The security log says a code was made, never which.
        var entries = _server.World.Store.SecurityEvents(null, null, null, 1000);
        Assert.Contains(entries, e => e.Event == "owner.claim.created");
        foreach (var entry in entries)
        {
            Assert.DoesNotContain(code, entry.Details ?? "");
            Assert.DoesNotContain(code.Replace("-", ""), entry.Details ?? "");
            Assert.DoesNotContain(InviteFor(code), entry.Details ?? "");
        }
    }

    [Fact]
    public async Task A_wrong_code_proves_nothing_and_joins_nobody()
    {
        var http = _server.CreateClient();
        var code = Code();
        var wrong = code[..^1] + (code[^1] == '0' ? '1' : '0');
        const string nonce = "abcdefghijklmnop0123";
        var answer = await http.GetFromJsonAsync<JsonElement>($"/.well-known/iskra-claim?nonce={nonce}", TestContext.Current.CancellationToken);
        Assert.NotEqual(Ed25519.ToB64u(OwnerSetup.ClaimProof(OwnerSetup.ClaimFromCode(wrong), answer.GetProperty("key").GetString()!, nonce)),
            answer.GetProperty("proof").GetString());

        using var client = await _server.ConnectAsync();
        var reply = await client.LoginAsync(new TestIdentity(), "Mallory", InviteFor(wrong));
        Assert.Equal("invite_required", reply.ErrorCode());
        Assert.False(_server.World.Store.HasOwner());
        Assert.True(File.Exists(CodePath)); // the real code still works
    }

    [Fact]
    public void A_restart_keeps_a_valid_code_and_replaces_an_expired_one()
    {
        _ = _server.CreateClient();
        var code = Code();
        Assert.NotNull(OwnerSetup.EnsureOwnerInvite(_server.World, Now + 60 * 60_000, out var claimed));
        Assert.True(claimed);
        Assert.Equal(code, Code());

        // 24 hours on: the old claim is dead, its invite too, and a restart makes a fresh code.
        var later = Now + OwnerSetup.CodeLifetimeMs + 60_000;
        Assert.Null(OwnerSetup.PendingClaim(_server.World, later));
        Assert.NotNull(OwnerSetup.EnsureOwnerInvite(_server.World, later, out claimed));
        Assert.True(claimed);
        var fresh = Code();
        Assert.NotEqual(code, fresh);
        Assert.NotNull(OwnerSetup.PendingClaim(_server.World, later));
        var owners = _server.World.Store.ActiveInvites(later).Where(i => i.Role == "owner").ToList();
        Assert.Equal([InviteFor(fresh)], owners.Select(i => i.Code));
        Assert.Equal(later + OwnerSetup.CodeLifetimeMs, owners[0].ExpiresAt);
        Assert.Contains(_server.World.Store.SecurityEvents(null, null, null, 100), e => e.Event == "owner.claim.created" && (e.Details ?? "").Contains("\"renewed\":true"));
    }

    [Fact]
    public async Task An_expired_code_is_not_offered()
    {
        var http = _server.CreateClient();
        var lines = File.ReadAllLines(ClaimPath);
        File.WriteAllText(ClaimPath, $"{lines[0]}\n{Now - 1000}\n");
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/.well-known/iskra-claim?nonce=abcdefghijklmnop", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task The_claim_endpoint_is_rate_limited_per_address()
    {
        var http = _server.CreateClient();
        for (var i = 0; i < OwnerSetup.ClaimBurst; i++)
            Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/.well-known/iskra-claim?nonce=abcdefghijklmnop", TestContext.Current.CancellationToken)).StatusCode);
        var limited = await http.GetAsync("/.well-known/iskra-claim?nonce=abcdefghijklmnop", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.NotNull(limited.Headers.RetryAfter);
    }

    [Fact]
    public void Codes_are_read_the_way_people_type_them()
    {
        Assert.Equal("0123456789ABCDEF", OwnerSetup.NormalizeCode("0123-4567-89AB-CDEF"));
        Assert.Equal("0123456789ABCDEF", OwnerSetup.NormalizeCode(" o123 4567 89ab cdef "));
        Assert.Equal("0113456789ABCDEF", OwnerSetup.NormalizeCode("0iL3-4567-89AB-CDEF"));
        Assert.Null(OwnerSetup.NormalizeCode("0123-4567-89AB-CDE"));
        Assert.Null(OwnerSetup.NormalizeCode("0123-4567-89AB-CDEU"));
        Assert.Null(OwnerSetup.NormalizeCode(null));
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$", OwnerSetup.NewCode());
        // Same vectors as client/src/state/claimServer.test.ts.
        Assert.Equal("DkY0DuPWq38gVMWGJNOYG24iiiCETvISXm8_Mu5dRik", Ed25519.ToB64u(OwnerSetup.ClaimFromCode("0123-4567-89ab-cdef")));
        Assert.Equal("1GMYZK7-J2ZlvmWMqMZ2CQ", InviteFor("0123456789ABCDEF"));
    }
}
