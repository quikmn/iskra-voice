using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Read receipts for DMs and group DMs. A receipt is a sealed envelope (encrypted like a message in that conversation)
/// that says how far its sender has read. The server relays it and keeps the newest one per reader and conversation, so
/// the other side gets it when they come online; it never keeps a history of them.
///
/// What the server learns: that this account sends receipts at all, to whom (or in which group), and when: so roughly
/// when the account read that conversation. It does not learn which message was read. Whether receipts are on is the
/// apps' own setting (sealed, PrefsFeature); the "you only see receipts if you send them" rule is kept by the apps.
/// </summary>
public static class ReceiptFeature
{
    /// <summary>How many conversations' receipts <c>dm.receipts</c> returns (the newest).</summary>
    private const int MaxListed = 500;

    public static void Register(Router router)
    {
        router.Add("dm.receipt", Dm);
        router.Add("dm.receipts", (s, me, _) => new { receipts = s.World.Store.DmReceiptsFor(me.AccountKey, MaxListed).Select(PublicDm) });
        router.Add("group.receipt", Group);
        router.Add("group.receipts", GroupList);
    }

    private static object PublicDm(DmReceipt r) =>
        new { from = r.From, to = r.To, envelope = JsonDocument.Parse(r.Envelope).RootElement.Clone(), at = r.At };

    private static object PublicGroup(GroupReceipt r) =>
        new { group = r.GroupId, from = r.From, version = r.Version, envelope = JsonDocument.Parse(r.Envelope).RootElement.Clone(), at = r.At };

    private static string Envelope(Body body, int max)
    {
        var envelope = body.Element("envelope");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        if (raw.Length > max) throw RequestException.BadRequest("That message is too big. Split it into a few.", "message_too_large");
        return raw;
    }

    /// <summary>
    /// "I have read our conversation up to …" for one person. The same people who could send them a message: both
    /// members here, not blocked, and only where a DM from the sender would go straight into the other's list (never
    /// for a request or an ignored conversation, like calls).
    /// </summary>
    private static object? Dm(Session s, Member me, Body body)
    {
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("That's you.");
        var peer = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (s.World.Store.IsBot(me.AccountKey) || s.World.Store.IsBot(peer.AccountKey)) throw RequestException.Forbidden("Bots have no read receipts.");
        ModerationFeature.CheckNotBlocked(s, me, peer, "message");
        DmPrivacyFeature.CheckContact(s, me, peer, "message");
        var raw = Envelope(body, DmFeature.MaxEnvelopeBytes);
        s.World.Store.SaveDmReceipt(me.AccountKey, peer.AccountKey, raw, s.Now);
        s.Hub.SendToAccount(peer.AccountKey, Frames.Event("dm.receipt", PublicDm(new DmReceipt(me.AccountKey, peer.AccountKey, raw, s.Now))));
        return null;
    }

    /// <summary>The same for a group you are in, sealed to the members of the group's current version.</summary>
    private static object? Group(Session s, Member me, Body body)
    {
        var group = GroupFeature.Mine(s, me, body.String("groupId", GroupChain.IdLength));
        var version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
        if (version != group.Version) throw new RequestException("conflict", "The group changed in the meantime. Refresh and try again.", "group_changed");
        var raw = Envelope(body, GroupFeature.MaxEnvelopeBytes);
        s.World.Store.SaveGroupReceipt(group.Id, me.AccountKey, version, raw, s.Now);
        var frame = Frames.Event("group.receipt", PublicGroup(new GroupReceipt(group.Id, me.AccountKey, version, raw, s.Now)));
        foreach (var account in GroupFeature.Reachable(s, group))
            if (account != me.AccountKey) s.Hub.SendToAccount(account, frame);
        return null;
    }

    /// <summary>The newest receipt of each other member of a group you are in (people who left are left out).</summary>
    private static object GroupList(Session s, Member me, Body body)
    {
        var group = GroupFeature.Mine(s, me, body.String("groupId", GroupChain.IdLength));
        return new
        {
            receipts = s.World.Store.GroupReceipts(group.Id)
                .Where(r => r.From != me.AccountKey && group.Members.Contains(r.From))
                .Select(PublicGroup),
        };
    }
}
