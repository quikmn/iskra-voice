using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Small per-account settings that follow you across devices (like the server rail's order and folders). The client
/// encrypts them with a key only the account has, so this server can't read which other servers you're on.
/// </summary>
public static partial class PrefsFeature
{
    public const int MaxDataLength = 16 * 1024 * 4 / 3 + 4; // 16 KB of ciphertext, base64url
    public const int MaxPrefsPerAccount = 16;

    [GeneratedRegex("^[a-z][a-z0-9-]{0,31}$")]
    private static partial Regex NamePattern();

    public static void Register(Router router)
    {
        router.Add("prefs.get", Get);
        router.Add("prefs.set", Set);
    }

    private static string Name(Body body)
    {
        var name = body.String("name", 32);
        return NamePattern().IsMatch(name) ? name : throw RequestException.BadRequest("'name' must be lowercase letters, digits and dashes.");
    }

    /// <summary>base64url of at least a nonce and a tag (40 bytes).</summary>
    private static bool IsCiphertext(string data)
    {
        try
        {
            return System.Buffers.Text.Base64Url.DecodeFromChars(data).Length >= 40;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static object Get(Session s, Member me, Body body)
    {
        var pref = s.World.Store.GetPref(me.AccountKey, Name(body));
        return new { data = pref?.Data, updatedAt = pref?.UpdatedAt };
    }

    private static object? Set(Session s, Member me, Body body)
    {
        var name = Name(body);
        var data = body.String("data", MaxDataLength);
        if (!IsCiphertext(data)) throw RequestException.BadRequest("'data' must be base64url ciphertext.");
        var updatedAt = body.OptionalLong("updatedAt", 0, 1L << 53) ?? throw RequestException.BadRequest("'updatedAt' is required.");
        var store = s.World.Store;
        var existing = store.GetPref(me.AccountKey, name);
        if (existing is null && store.CountPrefs(me.AccountKey) >= MaxPrefsPerAccount) throw RequestException.BadRequest("Too many settings.");
        // Last writer wins by the client's timestamp; an older copy never replaces a newer one.
        if (existing is { } e && e.UpdatedAt > updatedAt) return null;
        store.SetPref(me.AccountKey, name, data, updatedAt);
        var frame = Frames.Event("prefs.updated", new { name, updatedAt });
        foreach (var session in s.Hub.Sessions.Where(x => x.AccountKey == me.AccountKey && x != s)) session.Send(frame);
        return null;
    }
}
