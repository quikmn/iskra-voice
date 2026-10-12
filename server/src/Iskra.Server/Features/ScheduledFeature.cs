using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// "Send later". Channel messages are kept as text and sent at their time as you, through the same checks as
/// <c>chat.send</c> then (permissions, timeouts, rules, slowmode, AutoMod). DMs and groups stay end-to-end encrypted:
/// your app encrypts when you schedule and the server stores only the envelope, delivering it at the time with the
/// checks of <c>dm.send</c> / <c>group.send</c>. If a send is refused, the message stays listed as failed and you're told.
/// </summary>
public static class ScheduledFeature
{
    public const int MaxPerAccount = 50;
    public const long MaxAheadMs = 90L * 24 * 3600 * 1000;
    /// <summary>Encrypted envelopes use prekeys that are kept for at least 30 days after they're replaced.</summary>
    public const long MaxAheadEncryptedMs = 30L * 24 * 3600 * 1000;
    public const long PastSlackMs = 60_000;

    public static void Register(Router router)
    {
        router.Add("scheduled.create", Create);
        router.Add("scheduled.list", (s, me, _) => new { scheduled = s.World.Store.ScheduledOf(me.AccountKey).Select(View) });
        router.Add("scheduled.update", Update);
        router.Add("scheduled.delete", Delete);
        router.Add("scheduled.send", SendNow);
    }

    public static object View(ScheduledMessage m) => new
    {
        id = m.Id,
        kind = m.Kind,
        channelId = m.ChannelId,
        accountKey = m.PeerKey,
        groupId = m.GroupId,
        version = m.GroupVersion,
        text = m.Text,
        replyTo = m.ReplyTo,
        envelope = m.Envelope is null ? (JsonElement?)null : JsonDocument.Parse(m.Envelope).RootElement.Clone(),
        sendAt = m.SendAt,
        createdAt = m.CreatedAt,
        status = m.Status,
        error = m.Error,
    };

    private static long SendAt(Session s, Body body, string kind, long createdAt)
    {
        var at = body.OptionalLong("sendAt", 0, 1L << 53) ?? throw RequestException.BadRequest("'sendAt' is required.");
        var max = kind == "channel" ? MaxAheadMs : MaxAheadEncryptedMs;
        // Encrypted ones count from when they were encrypted (their prekeys age from then).
        var limit = (kind == "channel" ? s.Now : createdAt) + max;
        if (at < s.Now - PastSlackMs || at > limit)
            throw RequestException.BadRequest(kind == "channel"
                ? "Messages can be scheduled up to 90 days ahead."
                : "Encrypted messages can be scheduled up to 30 days ahead.");
        return at;
    }

    private static string ChannelText(Body body) =>
        Text.Normalize(body.String("text", ChatFeature.MaxMessageLength * 2), ChatFeature.MaxMessageLength, allowNewlines: true)
        ?? throw RequestException.BadRequest($"Messages must be 1–{ChatFeature.MaxMessageLength} characters.", "message_length", new { max = ChatFeature.MaxMessageLength });

    private static string Envelope(Body body, int max)
    {
        var envelope = body.Element("envelope");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        return raw.Length <= max ? raw : throw RequestException.BadRequest("Message is too large.", "message_too_large");
    }

    private static ScheduledMessage Mine(Session s, Member me, Body body) =>
        s.World.Store.GetScheduled(body.Long("id")) is { } m && m.AccountKey == me.AccountKey ? m : throw RequestException.NotFound("Scheduled message");

    private static void Tell(Hub hub, string accountKey, string frame, Session? except = null)
    {
        foreach (var other in hub.Sessions.Where(o => o.AccountKey == accountKey && o != except)) other.Send(frame);
    }

    private static object Create(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        if (store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't schedule messages.");
        ScheduledMessage m;
        if (body.OptionalLong("channelId") is { } channelId)
        {
            var channel = ChatFeature.ReadableChannel(s, me, channelId);
            if (channel.Kind is not ("text" or "thread")) throw RequestException.BadRequest("You can't send messages to that channel.", "cant_send_there");
            E2eeChannelFeature.RefusePlaintext(store, channel, "Scheduled messages");
            if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can't send messages in this channel.", "cant_send_here");
            var replyTo = body.OptionalLong("replyTo", min: 1);
            if (replyTo is { } r && store.GetMessage(r)?.ChannelId != channel.Id)
                throw RequestException.BadRequest("You can only reply to messages in the same channel.");
            m = new ScheduledMessage(0, me.AccountKey, "channel", channel.Id, null, null, null, ChannelText(body), replyTo, null,
                SendAt(s, body, "channel", s.Now), s.Now, "pending", null);
        }
        else if (body.OptionalString("accountKey", 64) is { } peerKey)
        {
            var peer = (peerKey == me.AccountKey ? me : store.GetMember(peerKey)) ?? throw RequestException.NotFound("Member");
            ModerationFeature.CheckNotBlocked(s, me, peer, "message");
            m = new ScheduledMessage(0, me.AccountKey, "dm", null, peer.AccountKey, null, null, null, null,
                Envelope(body, DmFeature.MaxEnvelopeBytes), SendAt(s, body, "dm", s.Now), s.Now, "pending", null);
        }
        else if (body.OptionalString("groupId", GroupChain.IdLength) is { } groupId)
        {
            var group = GroupFeature.Mine(s, me, groupId);
            var version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
            if (version != group.Version) throw new RequestException("conflict", "The group changed in the meantime. Refresh and try again.", "group_changed");
            m = new ScheduledMessage(0, me.AccountKey, "group", null, null, group.Id, version, null, null,
                Envelope(body, GroupFeature.MaxEnvelopeBytes), SendAt(s, body, "group", s.Now), s.Now, "pending", null);
        }
        else throw RequestException.BadRequest("Give a 'channelId', an 'accountKey' or a 'groupId'.");

        if (store.CountScheduled(me.AccountKey) >= MaxPerAccount)
            throw RequestException.BadRequest($"You can have up to {MaxPerAccount} scheduled messages here.", "scheduled_max", new { max = MaxPerAccount });
        var stored = store.AddScheduled(m);
        Tell(s.Hub, me.AccountKey, Frames.Event("scheduled.updated", new { scheduled = View(stored) }), s);
        return new { scheduled = View(stored) };
    }

    /// <summary>A new time and/or content. Encrypted ones get a new envelope from the app (the server can't change them).</summary>
    private static object Update(Session s, Member me, Body body)
    {
        var m = Mine(s, me, body);
        if (m.Status == "sending") throw new RequestException("conflict", "This message is being sent right now.", "scheduled_sending");
        var sendAt = body.Has("sendAt") ? SendAt(s, body, m.Kind, body.Has("envelope") ? s.Now : m.CreatedAt) : m.SendAt;
        string? text = null, envelope = null;
        long? version = null;
        if (m.Kind == "channel" && body.Has("text")) text = ChannelText(body);
        if (m.Kind != "channel" && body.Has("envelope"))
        {
            envelope = Envelope(body, m.Kind == "dm" ? DmFeature.MaxEnvelopeBytes : GroupFeature.MaxEnvelopeBytes);
            if (m.Kind == "group")
            {
                var group = GroupFeature.Mine(s, me, m.GroupId!);
                version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
                if (version != group.Version) throw new RequestException("conflict", "The group changed in the meantime. Refresh and try again.", "group_changed");
            }
        }
        s.World.Store.UpdateScheduled(m.Id, sendAt, text, envelope, version, s.Now);
        var updated = s.World.Store.GetScheduled(m.Id)!;
        Tell(s.Hub, me.AccountKey, Frames.Event("scheduled.updated", new { scheduled = View(updated) }), s);
        return new { scheduled = View(updated) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        var m = Mine(s, me, body);
        if (m.Status == "sending") throw new RequestException("conflict", "This message is being sent right now.", "scheduled_sending");
        s.World.Store.DeleteScheduled(m.Id);
        Tell(s.Hub, me.AccountKey, Frames.Event("scheduled.deleted", new { id = m.Id, sent = false }), s);
        return null;
    }

    /// <summary>"Send now": the same send the scheduler would do, right away. Refused sends stay listed as failed.</summary>
    private static object? SendNow(Session s, Member me, Body body)
    {
        var m = Mine(s, me, body);
        if (!s.World.Store.ClaimScheduled(m.Id, m.SendAt))
        {
            // Failed ones can be retried: back to pending first.
            if (m.Status != "failed") throw new RequestException("conflict", "This message is being sent right now.", "scheduled_sending");
            s.World.Store.UpdateScheduled(m.Id, m.SendAt, null, null, null, s.Now);
            if (!s.World.Store.ClaimScheduled(m.Id, m.SendAt)) throw new RequestException("conflict", "This message is being sent right now.", "scheduled_sending");
        }
        return Deliver(s, me, m, notify: false) ?? throw new RequestException("bad_request", s.World.Store.GetScheduled(m.Id)?.Error ?? "Couldn't send.");
    }

    /// <summary>
    /// Sends a claimed message as its author through <paramref name="s"/> (the author's live session, or a detached one).
    /// Returns the send's result, or null if it was refused (then it's marked failed and the author is told).
    /// </summary>
    internal static object? Deliver(Session s, Member me, ScheduledMessage m, bool notify)
    {
        var store = s.World.Store;
        var (type, request) = m.Kind switch
        {
            "channel" => ("chat.send", new JsonObject
            {
                ["channelId"] = m.ChannelId, ["text"] = m.Text, ["replyTo"] = m.ReplyTo,
                ["nonce"] = $"scheduled-{m.Id}", // a send retried after a restart never posts twice
            }),
            "dm" => ("dm.send", new JsonObject { ["accountKey"] = m.PeerKey, ["envelope"] = JsonNode.Parse(m.Envelope!) }),
            _ => ("group.send", new JsonObject { ["groupId"] = m.GroupId, ["version"] = m.GroupVersion, ["envelope"] = JsonNode.Parse(m.Envelope!) }),
        };
        try
        {
            using var doc = JsonDocument.Parse(request.ToJsonString());
            var result = s.Router.Invoke(s, me, type, doc.RootElement);
            store.DeleteScheduled(m.Id);
            Tell(s.Hub, me.AccountKey, Frames.Event("scheduled.deleted", new { id = m.Id, sent = true }));
            return result;
        }
        catch (RequestException ex)
        {
            var reason = ex.Code switch
            {
                "not_found" when m.Kind == "channel" => "The channel is gone, or you can't see it any more.",
                "not_found" => "You're not in that conversation any more.",
                "conflict" => "The group changed since you scheduled this. Open it and send again.",
                _ => ex.Message,
            };
            store.FailScheduled(m.Id, reason);
            var failed = store.GetScheduled(m.Id);
            if (failed is not null) Tell(s.Hub, me.AccountKey, Frames.Event("scheduled.updated", new { scheduled = View(failed) }));
            if (notify)
                s.Push.Notify(me.AccountKey, new PushNote("scheduled", $"scheduled:{m.Id}", "Your scheduled message wasn't sent", reason, "Iskra",
                    ChannelId: m.ChannelId, Peer: m.PeerKey, Group: m.GroupId, Coalesce: false));
            return null;
        }
    }
}
