using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Direct messages between members of this server. The server only ever sees encrypted envelopes:
/// it stores them, relays them, and knows who talks to whom and when (metadata), never what is said.
/// </summary>
public static class DmFeature
{
    public const int MaxEnvelopeBytes = 32 * 1024;

    public static void Register(Router router)
    {
        router.Add("dm.devices", Devices);
        router.Add("dm.send", Send);
        router.Add("dm.history", History);
        router.Add("dm.conversations", Conversations);
    }

    private static Member Peer(Session s, Member me, Body body)
    {
        var key = body.String("accountKey", 64);
        // You can always reach yourself (your other devices); otherwise both of you must be members here.
        return (key == me.AccountKey ? me : s.World.Store.GetMember(key)) ?? throw RequestException.NotFound("Member");
    }

    public static object PublicDm(DirectMessage m) =>
        new { id = m.Id, from = m.From, to = m.To, envelope = JsonDocument.Parse(m.Envelope).RootElement.Clone(), createdAt = m.CreatedAt };

    /// <summary>The signed device certificates (and prekeys, revocations) for a member, so the sender can encrypt to each device.</summary>
    private static object Devices(Session s, Member me, Body body)
    {
        var peer = Peer(s, me, body);
        return new
        {
            devices = s.World.Store.Devices(peer.AccountKey)
                .Select(d => new { accountKey = d.AccountKey, deviceKey = d.DeviceKey, created = d.Created, sig = d.Sig }),
            prekeys = s.World.Store.Prekeys(peer.AccountKey).Select(DeviceFeature.PublicPrekey),
            revoked = s.World.Store.Revocations(peer.AccountKey).Select(DeviceFeature.PublicRevocation),
        };
    }

    private static object Send(Session s, Member me, Body body)
    {
        // DMs are end-to-end encrypted between people's devices; a bot can't read them, so it doesn't send them either.
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't send direct messages.");
        var peer = Peer(s, me, body);
        ModerationFeature.CheckNotBlocked(s, me, peer, "message");
        var envelope = body.Element("envelope");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        if (raw.Length > MaxEnvelopeBytes) throw RequestException.BadRequest("Message is too large.", "message_too_large");

        var silent = body.OptionalBool("silent") == true;
        var files = DmFileFeature.CheckAttachments(s, me, peer, body);
        var message = s.World.Store.AddDm(me.AccountKey, peer.AccountKey, raw, s.Now);
        s.World.Store.LinkDmFiles(message.Id, files);
        var frame = Frames.Event("dm.message", new { message = PublicDm(message) });
        s.Hub.SendToAccount(peer.AccountKey, frame);
        if (peer.AccountKey != me.AccountKey) s.Hub.SendToAccount(me.AccountKey, frame); // your other devices
        // Quiet sends (a cancelled friend request and the like) don't push a "new message" notification.
        if (!silent) s.Push.DirectMessage(me, peer);
        return new { message = PublicDm(message) };
    }

    private static object History(Session s, Member me, Body body)
    {
        var peer = Peer(s, me, body);
        var limit = (int)(body.OptionalLong("limit", 1, 100) ?? 50);
        var messages = s.World.Store.DmHistory(me.AccountKey, peer.AccountKey, body.OptionalLong("before", 0), limit);
        return new { messages = messages.Select(PublicDm), hasMore = messages.Count == limit };
    }

    private static object Conversations(Session s, Member me, Body body) =>
        new
        {
            conversations = s.World.Store.DmConversations(me.AccountKey)
                .Select(c => new { accountKey = c.With, lastId = c.LastId, lastAt = c.LastAt }),
        };
}
