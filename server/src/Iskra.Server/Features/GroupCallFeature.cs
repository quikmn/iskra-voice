using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Voice and video calls in a group DM. Like DM calls, the server rings, hands out LiveKit tickets (to current group
/// members only) and relays the media key inside encrypted group envelopes it can't read.
/// </summary>
public static class GroupCallFeature
{
    public static void Register(Router router)
    {
        router.Add("gcall.start", Start);
        router.Add("gcall.join", Join);
        router.Add("gcall.decline", Decline);
        router.Add("gcall.leave", Leave);
        router.Add("gcall.key", Key);
        router.Add("gcall.list", List);
    }

    private static string CallId(Body body)
    {
        var id = body.String("callId", CallRegistry.IdLength);
        if (id.Length != CallRegistry.IdLength || !Ed25519.TryFromB64u(id, out var bytes) || bytes.Length != 16)
            throw RequestException.BadRequest("'callId' must be 16 random bytes (base64url).");
        return id;
    }

    private static string Envelope(Body body)
    {
        var envelope = body.Element("envelope");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        return raw.Length <= GroupFeature.MaxEnvelopeBytes ? raw : throw RequestException.BadRequest("'envelope' is too large.");
    }

    private static void Ready(Session s, Member me)
    {
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't make or answer calls.");
        if (!s.Voice.Backend.Available) throw new RequestException("voice_unavailable", "Calls aren't available on this server right now.");
    }

    private static object Ticket(Session s, Member me, GroupCall call)
    {
        var backend = s.Voice.Backend;
        var token = LiveKitTokens.ForRoom(backend.ApiKey, backend.ApiSecret, me.AccountKey, me.Name, call.Room, canPublish: true, s.Time.GetUtcNow());
        return new { url = LiveKitHost.ClientUrlFor(s.Origin, backend, s.World.Settings.Voice.ClientUrl), token, room = call.Room };
    }

    private static object Start(Session s, Member me, Body body)
    {
        Ready(s, me);
        var group = GroupFeature.Mine(s, me, body.String("groupId", GroupChain.IdLength));
        var id = CallId(body);
        var video = body.OptionalBool("video") ?? false;
        var version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
        if (version != group.Version) throw new RequestException("conflict", "The group changed in the meantime. Refresh and try again.");
        var envelope = Envelope(body);
        if (!s.Hub.Limits.TryTake(me.AccountKey, "call.start.callee", group.Id) || !s.Hub.Limits.TryTake(me.AccountKey, "call.start"))
            throw new RequestException("rate_limited", "Too many calls in a short time. Try again in a minute.");

        var call = s.Voice.GroupCalls.Start(group, me.AccountKey, id, video, envelope);
        foreach (var member in call.Ringing) s.Push.IncomingGroupCall(me, group.Id, member);
        return new { call = GroupCallRegistry.Public(call), ticket = Ticket(s, me, call) };
    }

    private static object Join(Session s, Member me, Body body)
    {
        Ready(s, me);
        var call = s.Voice.GroupCalls.Join(CallId(body), me.AccountKey, s);
        return new { ring = s.Voice.GroupCalls.WithKey(call), ticket = Ticket(s, me, call) };
    }

    private static object? Decline(Session s, Member me, Body body)
    {
        s.Voice.GroupCalls.Decline(CallId(body), me.AccountKey, s);
        return null;
    }

    private static object? Leave(Session s, Member me, Body body)
    {
        s.Voice.GroupCalls.Leave(CallId(body), me.AccountKey);
        return null;
    }

    private static object? Key(Session s, Member me, Body body)
    {
        var id = CallId(body);
        var version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
        s.Voice.GroupCalls.Rekey(id, me.AccountKey, version, Envelope(body));
        return null;
    }

    private static object List(Session s, Member me, Body body) => new { calls = s.Voice.GroupCalls.ForAccount(me.AccountKey) };
}
