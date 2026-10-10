using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>What one signed membership change says (the decoded payload).</summary>
public sealed record GroupChange(string Group, long Version, string Prev, string By, string Action, string[] Targets, string[] Members, long At);

/// <summary>
/// The rules of a group's membership chain. Every change is signed by the member who made it, names the change before it
/// (by hash) and the full member list after it. Clients check the same rules (client/src/core/group.ts), so a server
/// can't add anyone on its own: it would need a member's signature.
/// </summary>
public static class GroupChain
{
    public const string Context = "iskra/group-change/v1";
    public const int MaxMembers = 10;
    public const int MinCreateMembers = 3;
    public const int MaxPayloadChars = 4096;
    public const int IdLength = 22; // 16 random bytes, base64url
    public static readonly TimeSpan MaxClockSkew = TimeSpan.FromMinutes(10);

    public static string Head(byte[] payload) => Ed25519.ToB64u(SHA256.HashData(payload));

    public static bool IsId(string? id) => id is { Length: IdLength } && Ed25519.TryFromB64u(id, out var bytes) && bytes.Length == 16;

    private static bool IsAccountKey(string? key) => key is { Length: 43 } && Ed25519.TryFromB64u(key, out var bytes) && bytes.Length == 32;

    /// <summary>Decodes and checks a change's format and signature (by its own <c>by</c>). Throws bad_request.</summary>
    public static (GroupChange Change, byte[] Payload) Parse(string payload, string sig)
    {
        if (payload.Length > MaxPayloadChars) throw RequestException.BadRequest("'change' is too large.");
        byte[] bytes;
        try
        {
            bytes = System.Buffers.Text.Base64Url.DecodeFromChars(payload);
        }
        catch (FormatException)
        {
            throw RequestException.BadRequest("'change.payload' must be base64url.");
        }
        GroupChange change;
        try
        {
            using var doc = JsonDocument.Parse(bytes);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || v.GetInt32() != 1)
                throw RequestException.BadRequest("Unsupported group change.");
            string Str(string name, int max) =>
                root.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.String && e.GetString() is { } s && s.Length <= max
                    ? s : throw RequestException.BadRequest($"'change.{name}' is missing or invalid.");
            long Num(string name) =>
                root.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var n) && n >= 0
                    ? n : throw RequestException.BadRequest($"'change.{name}' is missing or invalid.");
            string[] Keys(string name) =>
                root.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.Array && e.GetArrayLength() <= MaxMembers
                    ? e.EnumerateArray().Select(k => k.ValueKind == JsonValueKind.String && IsAccountKey(k.GetString()) ? k.GetString()!
                        : throw RequestException.BadRequest($"'change.{name}' must be a list of account keys.")).ToArray()
                    : throw RequestException.BadRequest($"'change.{name}' is missing or invalid.");
            change = new GroupChange(Str("group", IdLength), Num("version"), Str("prev", 43), Str("by", 43), Str("action", 8),
                Keys("targets"), Keys("members"), Num("at"));
        }
        catch (JsonException)
        {
            throw RequestException.BadRequest("'change.payload' isn't JSON.");
        }
        catch (InvalidOperationException)
        {
            throw RequestException.BadRequest("'change.payload' isn't a valid change.");
        }
        catch (FormatException)
        {
            throw RequestException.BadRequest("'change.payload' isn't a valid change.");
        }
        if (!IsId(change.Group)) throw RequestException.BadRequest("'change.group' must be 16 random bytes (base64url).");
        if (!IsAccountKey(change.By)) throw RequestException.BadRequest("'change.by' must be an account key.");
        if (!Ed25519.TryFromB64u(sig, out var sigBytes) || !Ed25519.TryFromB64u(change.By, out var byKey)
            || !Ed25519.Verify(byKey, Ed25519.Payload(Context, bytes), sigBytes))
            throw RequestException.BadRequest("The change's signature doesn't check out.");
        return (change, bytes);
    }

    /// <summary>
    /// The member list a change must produce from <paramref name="current"/> (null for a new group). Checks the version,
    /// the link to the previous change, and who may do what: anyone in the group adds people and leaves; the longest-standing
    /// member (the first in the list: the creator, until they leave) removes people.
    /// </summary>
    public static string[] Apply(GroupRecord? current, GroupChange c)
    {
        static bool Distinct(string[] keys) => keys.Distinct(StringComparer.Ordinal).Count() == keys.Length;
        string[] expected;
        switch (c.Action)
        {
            case "create":
                if (current is not null) throw RequestException.BadRequest("That group already exists.");
                if (c.Version != 1 || c.Prev != "") throw RequestException.BadRequest("A new group starts at version 1.");
                if (c.Targets.Length + 1 < MinCreateMembers || !Distinct([c.By, .. c.Targets]))
                    throw RequestException.BadRequest($"A group needs {MinCreateMembers}–{MaxMembers} different people.");
                expected = [c.By, .. c.Targets];
                break;
            case "add" or "remove" or "leave":
                if (current is null) throw RequestException.NotFound("Group");
                if (c.Version != current.Version + 1 || c.Prev != current.Head)
                    throw new RequestException("conflict", "The group changed in the meantime. Refresh and try again.");
                if (!current.Members.Contains(c.By)) throw RequestException.NotFound("Group");
                if (c.Action == "add")
                {
                    if (c.Targets.Length == 0 || !Distinct(c.Targets) || c.Targets.Any(current.Members.Contains))
                        throw RequestException.BadRequest("Add people who aren't in the group yet.");
                    expected = [.. current.Members, .. c.Targets];
                }
                else
                {
                    if (c.Targets.Length != 1 || !current.Members.Contains(c.Targets[0]))
                        throw RequestException.BadRequest("Name one person in the group.");
                    var target = c.Targets[0];
                    if (c.Action == "leave" && target != c.By) throw RequestException.BadRequest("You can only leave for yourself.");
                    if (c.Action == "remove" && (target == c.By || current.Members[0] != c.By))
                        throw RequestException.Forbidden("Only the group's owner can remove people.");
                    expected = current.Members.Where(m => m != target).ToArray();
                }
                break;
            default:
                throw RequestException.BadRequest("Unknown group change.");
        }
        if (expected.Length > MaxMembers) throw RequestException.BadRequest($"A group can have at most {MaxMembers} people.");
        if (!expected.SequenceEqual(c.Members, StringComparer.Ordinal))
            throw RequestException.BadRequest("The change's member list doesn't match.");
        return expected;
    }
}
