using System.Security.Cryptography;
using System.Text;
using Iskra.Server.Crypto;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// A new world has no owner. On startup we make a single-use owner invite and write it to owner-invite.txt,
/// so whoever started the server (and can read its folder) becomes the owner. No race, no "first to connect wins".
///
/// A rented server set up by the app ("Rent a small server") brings a one-time owner claim instead (server.json
/// "OwnerClaim", 32 random bytes made by the app). The owner invite's code is derived from it, so only that app can
/// use it, and the app checks it found the right server through <see cref="ClaimProof"/>. The claim is moved out of
/// server.json into owner-claim (owner-only) on first start and deleted once the owner has joined. It's never logged.
/// </summary>
public static class OwnerSetup
{
    public const string FileName = "owner-invite.txt";
    public const string ClaimFile = "owner-claim";
    private const string InviteContext = "iskra-owner-invite-v1";
    private const string ProofContext = "iskra-owner-proof-v1";

    public static string InviteLink(World world, string code) =>
        $"{world.Settings.AppUrl.TrimEnd('/')}/#/join/" +
        $"{Ed25519.ToB64u(Encoding.UTF8.GetBytes(world.Settings.EffectivePublicUrl))}.{Ed25519.ToB64u(world.ServerPublicKey)}.{code}";

    /// <summary>The owner invite code a claim stands for (HMAC-SHA-256 with a context string, first 16 bytes).</summary>
    public static string ClaimCode(byte[] claim) =>
        Ed25519.ToB64u(HMACSHA256.HashData(claim, Encoding.UTF8.GetBytes(InviteContext)).AsSpan(0, 16));

    /// <summary>Proves to the app that this server holds its claim, binding the server's key and the app's nonce.</summary>
    public static byte[] ClaimProof(byte[] claim, string serverKey, string nonce) =>
        HMACSHA256.HashData(claim, Encoding.UTF8.GetBytes($"{ProofContext}\n{serverKey}\n{nonce}"));

    /// <summary>The pending claim, while nobody owns the server yet.</summary>
    public static byte[]? PendingClaim(World world)
    {
        var path = Path.Combine(world.Path, ClaimFile);
        if (!File.Exists(path) || world.Store.HasOwner()) return null;
        return Ed25519.TryFromB64u(File.ReadAllText(path).Trim(), out var claim) && claim.Length == 32 ? claim : null;
    }

    /// <summary>
    /// Returns the owner invite link if the world still needs an owner, otherwise null. <paramref name="claimed"/>
    /// is true when the invite comes from an owner claim: then the link must not be printed anywhere.
    /// </summary>
    public static string? EnsureOwnerInvite(World world, long now, out bool claimed)
    {
        var path = Path.Combine(world.Path, FileName);
        var claimPath = Path.Combine(world.Path, ClaimFile);
        claimed = false;
        if (world.Settings.OwnerClaim is { } raw)
        {
            // Consumed once: out of server.json, into its own owner-only file (only while there's no owner).
            if (!world.Store.HasOwner() && Ed25519.TryFromB64u(raw.Trim(), out var fresh) && fresh.Length == 32)
                AtomicFile.WriteAllText(claimPath, Ed25519.ToB64u(fresh) + "\n");
            world.UpdateSettings(s => s with { OwnerClaim = null });
        }
        if (world.Store.HasOwner())
        {
            File.Delete(path);
            File.Delete(claimPath);
            return null;
        }

        var active = world.Store.ActiveInvites(now).Where(i => i.Role == Roles.Owner).ToList();
        if (PendingClaim(world) is { } claim)
        {
            claimed = true;
            var code = ClaimCode(claim);
            var invite = active.FirstOrDefault(i => i.Code == code)
                ?? world.Store.CreateInvite(code, "server", Roles.Owner, now, expiresAt: null, maxUses: 1);
            var claimLink = InviteLink(world, invite.Code);
            AtomicFile.WriteAllText(path, claimLink + "\n");
            return claimLink;
        }

        var owner = active.FirstOrDefault()
            ?? world.Store.CreateInvite(InviteFeature.NewCode(), "server", Roles.Owner, now, expiresAt: null, maxUses: 1);
        var link = InviteLink(world, owner.Code);
        AtomicFile.WriteAllText(path, link + "\n");
        return link;
    }

    public static string? EnsureOwnerInvite(World world, long now) => EnsureOwnerInvite(world, now, out _);

    public static void OwnerJoined(World world)
    {
        File.Delete(Path.Combine(world.Path, FileName));
        File.Delete(Path.Combine(world.Path, ClaimFile));
    }

    /// <summary>
    /// GET /.well-known/iskra-claim?nonce=…: while a claim is pending, the server's key and a proof that this server
    /// holds the claim. The app that made the claim checks the proof before it trusts the key (no trust on first use).
    /// </summary>
    public static IResult ClaimEndpoint(HttpContext context, World world)
    {
        context.Response.Headers.AccessControlAllowOrigin = "*";
        context.Response.Headers.CacheControl = "no-store";
        var nonce = context.Request.Query["nonce"].ToString();
        if (nonce.Length is < 16 or > 64 || !nonce.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return Results.BadRequest();
        if (PendingClaim(world) is not { } claim) return Results.NotFound();
        var key = Ed25519.ToB64u(world.ServerPublicKey);
        return Results.Json(new { iskra = 1, key, proof = Ed25519.ToB64u(ClaimProof(claim, key, nonce)) });
    }
}
