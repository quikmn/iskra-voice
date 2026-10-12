using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Presence: online, idle, do not disturb or invisible, plus a custom status (emoji and text, optionally expiring).
/// The app keeps your choice and sends it to every server you're on. Idle is also automatic, per session: an account
/// whose every session reports idle shows as idle. Invisible accounts look offline to everyone else.
/// </summary>
public static class PresenceFeature
{
    public const int MaxTextLength = 128;
    public const int MaxEmojiLength = 16;
    public const long MaxLifetimeMs = 31L * 24 * 3600 * 1000;
    public const long MaxClockAheadMs = 10 * 60 * 1000;

    public static readonly string[] Statuses = ["online", "idle", "dnd", "invisible"];

    /// <summary>How an account looks to others right now. <see cref="Status"/> is online, idle, dnd or offline.</summary>
    public sealed record View(bool Online, string Status, object? Custom);

    public static void Register(Router router)
    {
        router.Add("presence.set", Set);
        router.Add("presence.idle", Idle);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    public static View Of(Store store, Hub hub, string accountKey, long now)
    {
        var sessions = hub.Sessions.Where(s => s.AccountKey == accountKey).ToList();
        return sessions.Count == 0 ? new(false, "offline", null) : Of(store.GetPresence(accountKey), sessions, now);
    }

    /// <summary>The same from what's already loaded: the stored choice and the account's sessions (none: offline).</summary>
    public static View Of(PresenceRecord? presence, IReadOnlyCollection<Session>? sessions, long now)
    {
        if (sessions is null || sessions.Count == 0) return new(false, "offline", null);
        var chosen = presence?.Status ?? "online";
        if (chosen == "invisible") return new(false, "offline", null);
        var status = chosen is "dnd" or "idle" ? chosen : sessions.All(s => s.Idle) ? "idle" : "online";
        return new(true, status, Custom(presence, now));
    }

    private static object? Custom(PresenceRecord? p, long now) =>
        p is null || (p.Emoji is null && p.Text is null) || (p.ExpiresAt is { } x && x <= now)
            ? null
            : new { emoji = p.Emoji, text = p.Text, expiresAt = p.ExpiresAt };

    /// <summary>Your own stored choice, as your devices see it (welcome and presence.self).</summary>
    public static object? Mine(Store store, string accountKey, long now) =>
        store.GetPresence(accountKey) is { } p ? Wire(p, now) : null;

    private static object Wire(PresenceRecord p, long now) => new { status = p.Status, custom = Custom(p, now), updatedAt = p.UpdatedAt };

    /// <summary>Do not disturb holds back Web Push for the account, whether or not it's connected.</summary>
    public static bool DoNotDisturb(Store store, string accountKey) => store.GetPresence(accountKey)?.Status == "dnd";

    /// <summary>Invisible members don't show up as typing, and @here (members online now) doesn't count them.</summary>
    public static bool Invisible(Store store, string accountKey) => store.GetPresence(accountKey)?.Status == "invisible";

    // ── Parsing ──────────────────────────────────────────────────────────────

    /// <summary><c>{ status, custom: { emoji?, text?, expiresAt? } | null, updatedAt }</c>.</summary>
    public static PresenceRecord Parse(Body body, long now)
    {
        var status = body.String("status", 16);
        if (!Statuses.Contains(status)) throw RequestException.BadRequest("'status' must be online, idle, dnd or invisible.");
        var updatedAt = body.OptionalLong("updatedAt", min: 1) ?? throw RequestException.BadRequest("'updatedAt' is required.");
        if (updatedAt > now + MaxClockAheadMs) throw RequestException.BadRequest("'updatedAt' is in the future.");

        string? emoji = null, text = null;
        long? expiresAt = null;
        if (body.OptionalElement("custom") is { } customElement)
        {
            if (customElement.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'custom' must be an object or null.");
            var custom = new Body(customElement);
            var rawEmoji = custom.OptionalString("emoji", MaxEmojiLength * 2);
            if (!string.IsNullOrWhiteSpace(rawEmoji))
            {
                emoji = Text.Normalize(rawEmoji, MaxEmojiLength, allowNewlines: false);
                if (emoji is null || emoji.Any(char.IsWhiteSpace) || emoji.Contains('<'))
                    throw RequestException.BadRequest("The status emoji must be a single emoji.", "status_emoji");
            }
            var rawText = custom.OptionalString("text", MaxTextLength * 2);
            if (!string.IsNullOrWhiteSpace(rawText))
                text = Text.Normalize(rawText, MaxTextLength, allowNewlines: false)
                    ?? throw RequestException.BadRequest($"Custom statuses can be up to {MaxTextLength} characters, on one line.", "status_length", new { max = MaxTextLength });
            expiresAt = custom.OptionalLong("expiresAt", min: 1);
            if (expiresAt > now + MaxLifetimeMs) throw RequestException.BadRequest("Custom statuses can last at most 31 days.", "status_31_days");
            if (emoji is null && text is null) expiresAt = null;
        }
        return new PresenceRecord(status, emoji, text, expiresAt, updatedAt);
    }

    /// <summary>The optional <c>presence</c> sent with auth, so you never flash online when you chose invisible. Invalid ones are ignored.</summary>
    public static void ApplyFromAuth(Store store, string accountKey, JsonElement auth, long now)
    {
        if (auth.ValueKind != JsonValueKind.Object || !auth.TryGetProperty("presence", out var element) || element.ValueKind != JsonValueKind.Object) return;
        try
        {
            store.SetPresence(accountKey, Parse(new Body(element), now));
        }
        catch (RequestException) { }
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object Set(Session s, Member me, Body body)
    {
        var wanted = Parse(body, s.Now);
        var before = Of(s.World.Store, s.Hub, me.AccountKey, s.Now);
        var stored = s.World.Store.SetPresence(me.AccountKey, wanted);
        var presence = Wire(stored, s.Now);
        if (stored == wanted)
        {
            BroadcastIfChanged(s, me.AccountKey, before);
            var self = Frames.Event("presence.self", new { presence });
            foreach (var other in s.Hub.Sessions.Where(o => o.AccountKey == me.AccountKey && o != s)) other.Send(self);
        }
        return new { presence };
    }

    private static object? Idle(Session s, Member me, Body body)
    {
        var idle = body.OptionalBool("idle") ?? throw RequestException.BadRequest("'idle' is required.");
        if (s.Idle == idle) return null;
        var before = Of(s.World.Store, s.Hub, me.AccountKey, s.Now);
        s.Idle = idle;
        BroadcastIfChanged(s, me.AccountKey, before);
        return null;
    }

    private static void BroadcastIfChanged(Session s, string accountKey, View before)
    {
        var after = Of(s.World.Store, s.Hub, accountKey, s.Now);
        if (after.Online == before.Online && after.Status == before.Status && Equals(Json(after.Custom), Json(before.Custom))) return;
        var member = s.World.Store.GetMember(accountKey);
        if (member is not null) s.Hub.Broadcast(Frames.Event("member.updated", new { member = s.Hub.PublicMember(member) }));
    }

    private static string Json(object? value) => JsonSerializer.Serialize(value);
}
