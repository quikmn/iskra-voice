using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Crypto;

namespace Iskra.Server.Voice;

/// <summary>
/// LiveKit access tokens and webhook signatures (HS256 JWTs signed with the world's LiveKit secret).
/// Kept tiny and dependency-free; see https://docs.livekit.io/home/get-started/authentication/.
/// </summary>
public static class LiveKitTokens
{
    public static string Create(string apiKey, string apiSecret, string identity, string name, JsonObject videoGrant, TimeSpan ttl, DateTimeOffset now)
    {
        var claims = new JsonObject
        {
            ["iss"] = apiKey,
            ["sub"] = identity,
            ["name"] = name,
            ["nbf"] = now.ToUnixTimeSeconds() - 10,
            ["exp"] = now.Add(ttl).ToUnixTimeSeconds(),
            ["video"] = videoGrant,
        };
        return Sign(claims, apiSecret);
    }

    /// <summary>A token to join one voice room (<paramref name="canSubscribe"/> false: hears no one, the AFK channel).</summary>
    public static string ForRoom(string apiKey, string apiSecret, string identity, string name, string room, bool canPublish, DateTimeOffset now, bool canSubscribe = true) =>
        Create(apiKey, apiSecret, identity, name, new JsonObject
        {
            ["room"] = room,
            ["roomJoin"] = true,
            ["canSubscribe"] = canSubscribe,
            ["canPublish"] = canPublish,
            ["canPublishData"] = canPublish,
        }, TimeSpan.FromHours(6), now);

    /// <summary>
    /// A bot's token for one voice room: it may publish audio only (no camera, screen or data) and never subscribes,
    /// so it can't hear anyone (VoiceBotFeature).
    /// </summary>
    public static string ForBot(string apiKey, string apiSecret, string identity, string name, string room, bool canPublish, DateTimeOffset now) =>
        Create(apiKey, apiSecret, identity, name, new JsonObject
        {
            ["room"] = room,
            ["roomJoin"] = true,
            ["canSubscribe"] = false,
            ["canPublish"] = canPublish,
            ["canPublishData"] = false,
            ["canPublishSources"] = new JsonArray("microphone"),
        }, TimeSpan.FromHours(6), now);

    /// <summary>A short-lived token for server-to-LiveKit API calls on one room.</summary>
    public static string Admin(string apiKey, string apiSecret, string room, DateTimeOffset now) =>
        Create(apiKey, apiSecret, "iskra-server", "Iskra", new JsonObject { ["room"] = room, ["roomAdmin"] = true }, TimeSpan.FromMinutes(5), now);

    internal static string Sign(JsonObject claims, string secret)
    {
        var header = Ed25519.ToB64u("""{"alg":"HS256","typ":"JWT"}"""u8);
        var payload = Ed25519.ToB64u(Encoding.UTF8.GetBytes(claims.ToJsonString()));
        var signature = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.ASCII.GetBytes($"{header}.{payload}"));
        return $"{header}.{payload}.{Ed25519.ToB64u(signature)}";
    }

    /// <summary>Verifies an HS256 JWT and returns its claims, or null.</summary>
    public static JsonElement? Verify(string token, string apiKey, string secret, DateTimeOffset now)
    {
        if (token.Length > 8192) return null;
        var parts = token.Split('.');
        if (parts.Length != 3) return null;
        var expected = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"));
        if (!TryB64u(parts[2], out var actual) || !CryptographicOperations.FixedTimeEquals(expected, actual)) return null;
        if (!TryB64u(parts[0], out var headerBytes) || !TryB64u(parts[1], out var payloadBytes)) return null;
        try
        {
            using var header = JsonDocument.Parse(headerBytes);
            if (header.RootElement.GetProperty("alg").GetString() != "HS256") return null;
            var claims = JsonDocument.Parse(payloadBytes).RootElement.Clone();
            if (!claims.TryGetProperty("iss", out var iss) || iss.GetString() != apiKey) return null;
            if (claims.TryGetProperty("exp", out var exp) && exp.GetInt64() < now.ToUnixTimeSeconds()) return null;
            if (claims.TryGetProperty("nbf", out var nbf) && nbf.GetInt64() > now.ToUnixTimeSeconds() + 60) return null;
            return claims;
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    private static bool TryB64u(string text, out byte[] bytes)
    {
        try
        {
            bytes = System.Buffers.Text.Base64Url.DecodeFromChars(text);
            return true;
        }
        catch (FormatException)
        {
            bytes = [];
            return false;
        }
    }

    /// <summary>
    /// LiveKit webhooks carry "Authorization: &lt;jwt&gt;" whose "sha256" claim is base64(SHA-256(body)).
    /// </summary>
    public static bool VerifyWebhook(string? authorization, byte[] body, string apiKey, string secret, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(authorization)) return false;
        var token = authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? authorization[7..] : authorization;
        if (Verify(token, apiKey, secret, now) is not { } claims) return false;
        if (!claims.TryGetProperty("sha256", out var hash) || hash.GetString() is not { } expected) return false;
        var actual = Convert.ToBase64String(SHA256.HashData(body));
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual));
    }
}
