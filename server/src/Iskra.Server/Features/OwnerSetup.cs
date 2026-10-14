using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Runtime.CompilerServices;
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
///
/// A server image (the DigitalOcean Marketplace droplet) can't get a claim from an app, so its server.json says
/// "OwnerClaim": "generate": the server makes a short claim code itself and writes it to owner-claim-code.txt, for
/// whoever can open the machine's console. The claim is derived from the code, so the app's "Claim a server" uses
/// the same proof and owner invite. Single use, valid for 24 hours; a restart after that makes a fresh one.
/// </summary>
public static class OwnerSetup
{
    public const string FileName = "owner-invite.txt";
    public const string ClaimFile = "owner-claim";
    public const string CodeFile = "owner-claim-code.txt";
    /// <summary>server.json "OwnerClaim" value that asks the server to make its own claim code.</summary>
    public const string Generate = "generate";
    public const long CodeLifetimeMs = 24 * 60 * 60 * 1000;
    /// <summary>Crockford's base32 letters: no I, L, O or U, so nothing looks like something else.</summary>
    public const string CodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    /// <summary>16 letters of 5 bits: 80 bits.</summary>
    public const int CodeLength = 16;
    private const string InviteContext = "iskra-owner-invite-v1";
    private const string ProofContext = "iskra-owner-proof-v1";
    private const string CodeContext = "iskra-claim-code-v1";

    public static string InviteLink(World world, string code) =>
        $"{world.Settings.AppUrl.TrimEnd('/')}/#/join/" +
        $"{Ed25519.ToB64u(Encoding.UTF8.GetBytes(world.Settings.EffectivePublicUrl))}.{Ed25519.ToB64u(world.ServerPublicKey)}.{code}";

    /// <summary>The owner invite code a claim stands for (HMAC-SHA-256 with a context string, first 16 bytes).</summary>
    public static string ClaimCode(byte[] claim) =>
        Ed25519.ToB64u(HMACSHA256.HashData(claim, Encoding.UTF8.GetBytes(InviteContext)).AsSpan(0, 16));

    /// <summary>Proves to the app that this server holds its claim, binding the server's key and the app's nonce.</summary>
    public static byte[] ClaimProof(byte[] claim, string serverKey, string nonce) =>
        HMACSHA256.HashData(claim, Encoding.UTF8.GetBytes($"{ProofContext}\n{serverKey}\n{nonce}"));

    /// <summary>A new claim code, shown as XXXX-XXXX-XXXX-XXXX.</summary>
    public static string NewCode()
    {
        var code = RandomNumberGenerator.GetString(CodeAlphabet, CodeLength);
        return string.Join('-', Enumerable.Range(0, CodeLength / 4).Select(i => code.Substring(i * 4, 4)));
    }

    /// <summary>
    /// A claim code as typed: case, spaces and dashes don't matter, and O, I and L read as 0, 1 and 1.
    /// Null unless it's 16 letters of the alphabet.
    /// </summary>
    public static string? NormalizeCode(string? typed)
    {
        if (typed is null || typed.Length > 64) return null;
        var chars = typed.ToUpperInvariant().Where(c => c is not (' ' or '-')).Select(c => c switch { 'O' => '0', 'I' or 'L' => '1', _ => c }).ToArray();
        return chars.Length == CodeLength && chars.All(c => CodeAlphabet.Contains(c)) ? new string(chars) : null;
    }

    /// <summary>The 32-byte owner claim a claim code stands for: SHA-256 of the context string and the normalized code.</summary>
    public static byte[] ClaimFromCode(string code) =>
        SHA256.HashData(Encoding.UTF8.GetBytes($"{CodeContext}\n{NormalizeCode(code) ?? throw new ArgumentException("Not a claim code.", nameof(code))}"));

    private sealed record Pending(byte[] Claim, long? ExpiresAt);

    /// <summary>owner-claim: the claim (base64url), and for a generated one the time it expires (ms) on the next line.</summary>
    private static Pending? ReadClaimFile(World world)
    {
        var path = Path.Combine(world.Path, ClaimFile);
        if (!File.Exists(path)) return null;
        var lines = File.ReadAllLines(path).Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
        if (lines.Length is < 1 or > 2 || !Ed25519.TryFromB64u(lines[0], out var claim) || claim.Length != 32) return null;
        if (lines.Length == 1) return new(claim, null);
        return long.TryParse(lines[1], NumberStyles.None, CultureInfo.InvariantCulture, out var expires) ? new(claim, expires) : null;
    }

    /// <summary>The pending claim, while nobody owns the server yet (and a generated one hasn't expired).</summary>
    public static byte[]? PendingClaim(World world, long now)
    {
        if (world.Store.HasOwner() || ReadClaimFile(world) is not { } pending) return null;
        return pending.ExpiresAt is { } expires && expires <= now ? null : pending.Claim;
    }

    public static byte[]? PendingClaim(World world) => PendingClaim(world, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    /// <summary>
    /// "OwnerClaim": "generate": keeps a claim code that's still valid, or makes a fresh one (first start, or the last
    /// one expired). Only owner-claim and owner-claim-code.txt hold it; the security log notes when, never the code.
    /// </summary>
    private static void EnsureGeneratedClaim(World world, long now)
    {
        var codePath = Path.Combine(world.Path, CodeFile);
        if (ReadClaimFile(world) is { ExpiresAt: { } still } && still > now && File.Exists(codePath)) return;
        var renewed = File.Exists(codePath);
        // Only one way in at a time: whatever owner invite was left over goes.
        foreach (var old in world.Store.ActiveInvites(now).Where(i => i.Role == Roles.Owner)) world.Store.RevokeInvite(old.Code);
        var code = NewCode();
        var expires = now + CodeLifetimeMs;
        AtomicFile.WriteAllText(Path.Combine(world.Path, ClaimFile), $"{Ed25519.ToB64u(ClaimFromCode(code))}\n{expires}\n");
        var until = DateTimeOffset.FromUnixTimeMilliseconds(expires).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
        AtomicFile.WriteAllText(codePath, $"code={code}\nexpires={until}\naddress={world.Settings.EffectivePublicUrl}\n");
        SecurityLog.Record(world.Store, now, "owner.claim.created", details: new { expiresAt = expires, renewed });
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
        if (world.Settings.OwnerClaim == Generate)
        {
            // Kept in server.json until the owner has joined, so a restart after the code expired makes a new one.
            if (world.Store.HasOwner()) world.UpdateSettings(s => s with { OwnerClaim = null });
            else EnsureGeneratedClaim(world, now);
        }
        else if (world.Settings.OwnerClaim is { } raw)
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
            File.Delete(Path.Combine(world.Path, CodeFile));
            return null;
        }

        var active = world.Store.ActiveInvites(now).Where(i => i.Role == Roles.Owner).ToList();
        if (ReadClaimFile(world) is { } pending && PendingClaim(world, now) is { } claim)
        {
            claimed = true;
            var code = ClaimCode(claim);
            var invite = active.FirstOrDefault(i => i.Code == code)
                ?? world.Store.CreateInvite(code, "server", Roles.Owner, now, expiresAt: pending.ExpiresAt, maxUses: 1);
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
        File.Delete(Path.Combine(world.Path, CodeFile));
        if (world.Settings.OwnerClaim == Generate) world.UpdateSettings(s => s with { OwnerClaim = null });
    }

    /// <summary>Requests to the claim endpoint per client address: a burst of 30, then one every 2 seconds.</summary>
    private static readonly ConditionalWeakTable<World, ConcurrentDictionary<IPAddress, WebhookIngress.TokenBucket>> Limits = new();
    public const int ClaimBurst = 30;

    /// <summary>
    /// GET /.well-known/iskra-claim?nonce=…: while a claim is pending, the server's key and a proof that this server
    /// holds the claim. The app that made the claim checks the proof before it trusts the key (no trust on first use).
    /// </summary>
    public static IResult ClaimEndpoint(HttpContext context, World world)
    {
        context.Response.Headers.AccessControlAllowOrigin = "*";
        context.Response.Headers.CacheControl = "no-store";
        var time = context.RequestServices.GetRequiredService<TimeProvider>();
        var buckets = Limits.GetOrCreateValue(world);
        if (buckets.Count > 10_000) buckets.Clear(); // memory only; a flood of addresses just starts them over
        var bucket = buckets.GetOrAdd(BugInbox.LimitKey(context.Connection.RemoteIpAddress), _ => new WebhookIngress.TokenBucket(ClaimBurst, 0.5, time));
        if (!bucket.TryTake(out var wait))
        {
            context.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(wait.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
            return Results.StatusCode(StatusCodes.Status429TooManyRequests);
        }
        var nonce = context.Request.Query["nonce"].ToString();
        if (nonce.Length is < 16 or > 64 || !nonce.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return Results.BadRequest();
        if (PendingClaim(world, time.GetUtcNow().ToUnixTimeMilliseconds()) is not { } claim) return Results.NotFound();
        var key = Ed25519.ToB64u(world.ServerPublicKey);
        return Results.Json(new { iskra = 1, key, proof = Ed25519.ToB64u(ClaimProof(claim, key, nonce)) });
    }
}
