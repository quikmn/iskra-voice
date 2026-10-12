using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>"Rent a small server": the one-time owner claim the app puts into the server's setup.</summary>
public class OwnerClaimTests : IDisposable
{
    private readonly byte[] _claim = RandomNumberGenerator.GetBytes(32);
    private readonly IskraServer _server = new();

    public OwnerClaimTests()
    {
        Directory.CreateDirectory(_server.WorldPath);
        File.WriteAllText(Path.Combine(_server.WorldPath, "server.json"), JsonSerializer.Serialize(new { Name = "Rented", OwnerClaim = Ed25519.ToB64u(_claim) }));
    }

    public void Dispose() => _server.Dispose();

    private string ClaimFile => Path.Combine(_server.WorldPath, OwnerSetup.ClaimFile);

    [Fact]
    public async Task The_claim_makes_the_app_the_owner_once_and_is_gone_afterwards()
    {
        var http = _server.CreateClient();
        // Consumed: out of server.json, into an owner-only file.
        var settings = JsonNode.Parse(File.ReadAllText(Path.Combine(_server.WorldPath, "server.json")))!;
        Assert.Null(settings["OwnerClaim"]?.GetValue<string>());
        Assert.Equal("Rented", settings["Name"]!.GetValue<string>());
        Assert.True(File.Exists(ClaimFile));

        // The app checks it found its own server: the key comes with a proof only the claim's holder can make.
        const string nonce = "abcdefghijklmnop0123";
        var answer = await http.GetFromJsonAsync<JsonElement>($"/.well-known/iskra-claim?nonce={nonce}", TestContext.Current.CancellationToken);
        var key = answer.GetProperty("key").GetString()!;
        Assert.Equal(Ed25519.ToB64u(_server.World.ServerPublicKey), key);
        Assert.Equal(Ed25519.ToB64u(OwnerSetup.ClaimProof(_claim, key, nonce)), answer.GetProperty("proof").GetString());
        Assert.NotEqual(Ed25519.ToB64u(OwnerSetup.ClaimProof(RandomNumberGenerator.GetBytes(32), key, nonce)), answer.GetProperty("proof").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await http.GetAsync("/.well-known/iskra-claim?nonce=short", TestContext.Current.CancellationToken)).StatusCode);

        // The owner invite's code comes from the claim: the app joins as owner with it.
        var code = OwnerSetup.ClaimCode(_claim);
        var identity = new TestIdentity();
        using var client = await _server.ConnectAsync();
        var welcome = await client.LoginAsync(identity, "Ada", code);
        Assert.Equal("welcome", welcome.GetProperty("type").GetString());
        Assert.True(_server.World.Store.HasOwner());

        // Gone: the file, the endpoint, and the code (single use).
        Assert.False(File.Exists(ClaimFile));
        Assert.False(File.Exists(Path.Combine(_server.WorldPath, OwnerSetup.FileName)));
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/.well-known/iskra-claim?nonce={nonce}", TestContext.Current.CancellationToken)).StatusCode);
        using var again = await _server.ConnectAsync();
        var second = await again.LoginAsync(new TestIdentity(), "Mallory", code);
        Assert.Equal("error", second.GetProperty("type").GetString());

        // Never in the security log.
        var claimText = Ed25519.ToB64u(_claim);
        foreach (var entry in _server.World.Store.SecurityEvents(null, null, null, 1000))
        {
            Assert.DoesNotContain(claimText, entry.Details ?? "");
            Assert.DoesNotContain(code, entry.Details ?? "");
        }
    }

    [Fact]
    public void The_app_and_the_server_derive_the_same_code_and_proof()
    {
        // Same vector as client/src/state/rentServer.test.ts.
        var claim = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        Assert.Equal("TZ9bbtMv6iMikMJTX8_QOQ", OwnerSetup.ClaimCode(claim));
        Assert.Equal("A8ULBj4p678ZDj9e_x-eIr1eOXIkjW_2rRmzmRyZXeM",
            Ed25519.ToB64u(OwnerSetup.ClaimProof(claim, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc", "nonce-nonce-nonce")));
    }

    [Fact]
    public async Task A_server_that_already_has_an_owner_ignores_a_claim()
    {
        using var owner = await _server.JoinAsync("Owner", "owner");
        // A claim added later (a leftover, or someone editing server.json) is dropped, never turned into an invite.
        _server.World.UpdateSettings(s => s with { OwnerClaim = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32)) });
        Assert.Null(OwnerSetup.EnsureOwnerInvite(_server.World, 0, out var claimed));
        Assert.False(claimed);
        Assert.Null(_server.World.Settings.OwnerClaim);
        Assert.False(File.Exists(ClaimFile));
        Assert.Equal(HttpStatusCode.NotFound, (await _server.CreateClient().GetAsync("/.well-known/iskra-claim?nonce=abcdefghijklmnop", TestContext.Current.CancellationToken)).StatusCode);
    }
}
