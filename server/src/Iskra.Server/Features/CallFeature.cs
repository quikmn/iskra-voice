using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Voice and video calls between two members (from a DM). The server rings, connects and hangs up; media goes
/// through LiveKit, end-to-end encrypted with a key the caller sends inside an encrypted DM envelope.
/// </summary>
public static class CallFeature
{
    public static void Register(Router router)
    {
        router.Add("call.start", Start);
        router.Add("call.accept", Accept);
        router.Add("call.decline", Decline);
        router.Add("call.end", End);
        router.Add("call.pending", Pending);
    }

    private static object Media(Session s, Member me, Call call)
    {
        var backend = s.Voice.Backend;
        var token = LiveKitTokens.ForRoom(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, call.Room, canPublish: true, s.Time.GetUtcNow());
        return new { call = CallRegistry.Public(call), url = LiveKitHost.ClientUrlFor(s.Origin, backend, s.World.Settings.Voice.ClientUrl, s.Tunnelled), token, room = call.Room };
    }

    private static string CallId(Body body)
    {
        var id = body.String("callId", CallRegistry.IdLength);
        if (id.Length != CallRegistry.IdLength || !Ed25519.TryFromB64u(id, out var bytes) || bytes.Length != 16)
            throw RequestException.BadRequest("'callId' must be 16 random bytes (base64url).");
        return id;
    }

    /// <summary>Bots can't decrypt the media key (it travels in a DM envelope), so they can't take part in calls.</summary>
    private static void NotABot(Session s, Member me)
    {
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't make or answer calls.");
    }

    private static object Start(Session s, Member me, Body body)
    {
        NotABot(s, me);
        var peerKey = body.String("accountKey", 64);
        if (peerKey == me.AccountKey) throw RequestException.BadRequest("You can't call yourself.", "call_self");
        var peer = s.World.Store.GetMember(peerKey) ?? throw RequestException.NotFound("Member");
        if (s.World.Store.IsBot(peer.AccountKey)) throw RequestException.BadRequest("Bots can't take calls.");
        ModerationFeature.CheckNotBlocked(s, me, peer, "call");
        if (ModerationFeature.IsTimedOut(s.World.Store, peer.AccountKey, s.Now))
            throw RequestException.Forbidden("They can't take calls on this server right now.", "they_cant_call");
        var id = CallId(body);
        var video = body.OptionalBool("video") ?? false;
        var envelope = body.Element("envelope");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        if (raw.Length > DmFeature.MaxEnvelopeBytes) throw RequestException.BadRequest("'envelope' is too large.");
        if (!s.Voice.Backend.Available) throw new RequestException("voice_unavailable", "Calls aren't available on this server right now.");
        // Per account, so more connections don't mean more ringing: 10 calls a minute, 3 to the same person.
        if (!s.Hub.Limits.TryTake(me.AccountKey, "call.start.callee", peer.AccountKey) || !s.Hub.Limits.TryTake(me.AccountKey, "call.start"))
            throw new RequestException("rate_limited", "Too many calls in a short time. Try again in a minute.", "too_many_calls");

        var call = s.Voice.Calls.Start(me.AccountKey, peer.AccountKey, id, video, raw);
        s.Push.IncomingCall(me, peer.AccountKey);
        return Media(s, me, call);
    }

    private static object Accept(Session s, Member me, Body body)
    {
        NotABot(s, me);
        if (!s.Voice.Backend.Available) throw new RequestException("voice_unavailable", "Calls aren't available on this server right now.");
        var call = s.Voice.Calls.Accept(CallId(body), me.AccountKey, s);
        return Media(s, me, call);
    }

    private static object? Decline(Session s, Member me, Body body)
    {
        var reason = body.OptionalString("reason", 16) ?? "declined";
        if (reason is not ("declined" or "busy")) throw RequestException.BadRequest("'reason' must be 'declined' or 'busy'.");
        s.Voice.Calls.Decline(CallId(body), me.AccountKey, reason);
        return null;
    }

    private static object? End(Session s, Member me, Body body)
    {
        s.Voice.Calls.Hangup(CallId(body), me.AccountKey);
        return null;
    }

    private static object Pending(Session s, Member me, Body body) => new { calls = s.Voice.Calls.Pending(me.AccountKey) };
}
