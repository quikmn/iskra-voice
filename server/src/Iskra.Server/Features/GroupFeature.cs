using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Group DMs of 3–10 members of this server. Messages are end-to-end encrypted envelopes, like DMs. Membership is a chain of
/// changes, each signed by the member who made it; the server checks the rules, stores the chain and routes by it, and
/// clients check it again, so the server can't add anyone on its own.
/// </summary>
public static class GroupFeature
{
    /// <summary>Bigger than a DM's: a group envelope has a key slot for every device of up to 10 people.</summary>
    public const int MaxEnvelopeBytes = 56 * 1024;
    public const int MaxGroupsPerAccount = 100;
    private static readonly Lock Gate = new(); // one membership change at a time, so versions never fork

    public static void Register(Router router)
    {
        router.Add("group.create", Create);
        router.Add("group.change", Change);
        router.Add("group.list", List);
        router.Add("group.get", Get);
        router.Add("group.send", Send);
        router.Add("group.history", History);
    }

    public static object Public(GroupRecord g) =>
        new { id = g.Id, version = g.Version, head = g.Head, members = g.Members, createdAt = g.CreatedAt };

    private static object PublicChange(GroupChangeRecord c) => new { version = c.Version, payload = c.Payload, sig = c.Sig };

    private static object PublicMessage(GroupMessage m) =>
        new { id = m.Id, group = m.GroupId, from = m.From, version = m.Version, envelope = JsonDocument.Parse(m.Envelope).RootElement.Clone(), createdAt = m.CreatedAt, expiresAt = m.ExpiresAt };

    /// <summary>A group <paramref name="me"/> is in right now. Anyone else (former members, admins) gets "not found".</summary>
    public static GroupRecord Mine(Session s, Member me, string id) =>
        GroupChain.IsId(id) && s.World.Store.GetGroup(id) is { } g && g.Members.Contains(me.AccountKey) ? g : throw RequestException.NotFound("Group");

    /// <summary>Group members who are still members of this server (kicked or banned people get nothing).</summary>
    public static IEnumerable<string> Reachable(Session s, GroupRecord g) => g.Members.Where(k => s.World.Store.GetMember(k) is not null);

    private static void NotABot(Session s, Member me)
    {
        // Group messages are end-to-end encrypted between people's devices; bots can't read them.
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't be in group DMs.");
    }

    private static object Create(Session s, Member me, Body body) => Apply(s, me, body, creating: true);

    private static object Change(Session s, Member me, Body body) => Apply(s, me, body, creating: false);

    private static object Apply(Session s, Member me, Body body, bool creating)
    {
        NotABot(s, me);
        var wire = body.Element("change");
        if (wire.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'change' must be an object.");
        var changeBody = new Body(wire);
        var payloadText = changeBody.String("payload", GroupChain.MaxPayloadChars);
        var sig = changeBody.String("sig", 128);
        var (change, payload) = GroupChain.Parse(payloadText, sig);
        if (change.By != me.AccountKey) throw RequestException.BadRequest("Sign changes with your own account.");
        if (creating != (change.Action == "create")) throw RequestException.BadRequest(creating ? "Use a 'create' change." : "Use group.create for a new group.");
        if (Math.Abs(change.At - s.Now) > GroupChain.MaxClockSkew.TotalMilliseconds) throw RequestException.BadRequest("The change's time is off. Check your clock.", "clock_off");
        if (change.Action is "create" or "add")
            foreach (var target in change.Targets)
                if (s.World.Store.GetMember(target) is null || s.World.Store.IsBot(target))
                    throw RequestException.BadRequest("Everyone in a group must be a person on this server.", "group_members_here");
        if (!s.Hub.Limits.TryTake(me.AccountKey, "group.change"))
            throw new RequestException("rate_limited", "Too many group changes in a short time. Try again in a minute.", "too_many_group_changes");

        GroupRecord? before;
        GroupRecord after;
        lock (Gate)
        {
            before = s.World.Store.GetGroup(change.Group);
            if (creating && s.World.Store.GroupCount(me.AccountKey) >= MaxGroupsPerAccount)
                throw RequestException.BadRequest($"You can be in at most {MaxGroupsPerAccount} groups on a server.", "groups_max", new { max = MaxGroupsPerAccount });
            var members = GroupChain.Apply(before, change);
            after = new GroupRecord(change.Group, before?.CreatedBy ?? me.AccountKey, before?.CreatedAt ?? s.Now, change.Version,
                GroupChain.Head(payload), members);
            s.World.Store.SaveGroupChange(after, new GroupChangeRecord(change.Version, payloadText, sig, s.Now));
        }

        // Everyone before and after the change hears about it, so someone removed learns that they were.
        var frame = Frames.Event("group.changed", new { group = Public(after), change = new { version = change.Version, payload = payloadText, sig } });
        foreach (var account in (before?.Members ?? []).Union(after.Members)) s.Hub.SendToAccount(account, frame);
        s.Voice.GroupCalls.MembershipChanged(after);
        return new { group = Public(after) };
    }

    private static object List(Session s, Member me, Body body) =>
        new
        {
            groups = s.World.Store.GroupsOf(me.AccountKey).Select(g => new { group = Public(g.Group), lastId = g.LastId, lastAt = g.LastAt }),
        };

    /// <summary>The group and its signed chain after <c>since</c> (0: all of it), so clients can check every change themselves.</summary>
    private static object Get(Session s, Member me, Body body)
    {
        var group = Mine(s, me, body.String("groupId", GroupChain.IdLength));
        var since = body.OptionalLong("since", 0, group.Version) ?? 0;
        return new { group = Public(group), changes = s.World.Store.GroupChanges(group.Id, since).Select(PublicChange) };
    }

    private static object Send(Session s, Member me, Body body)
    {
        NotABot(s, me);
        var group = Mine(s, me, body.String("groupId", GroupChain.IdLength));
        // A nonce makes a retried send (or a scheduled one after a restart) return the stored message instead of a second
        // one, even if the group changed in between.
        var nonce = ChatFeature.Nonce(body);
        if (nonce is not null && s.World.Store.EnvelopeForNonce(me.AccountKey, "group", nonce) is (true, var earlier))
            return Repeat(earlier as GroupMessage);
        // Senders encrypt to the member list of a version; only the current one is accepted, so nobody keeps writing to people who left.
        var version = body.OptionalLong("version", 1) ?? throw RequestException.BadRequest("'version' is required.");
        if (version != group.Version) throw new RequestException("conflict", "The group changed in the meantime. Refresh and try again.", "group_changed");
        var envelope = body.Element("envelope");
        if (envelope.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'envelope' must be an object.");
        var raw = envelope.GetRawText();
        if (raw.Length > MaxEnvelopeBytes) throw RequestException.BadRequest("Message is too large.", "message_too_large");
        DisappearFeature.EnvelopeExpires(envelope);
        var files = DmFileFeature.CheckGroupAttachments(s, me, group.Members, body);

        GroupMessage message;
        if (nonce is null) message = s.World.Store.AddGroupMessage(group.Id, me.AccountKey, version, raw, s.Now);
        else
        {
            var (stored, created) = s.World.Store.AddGroupMessageOnce(nonce, group.Id, me.AccountKey, version, raw, s.Now);
            if (!created) return Repeat(stored);
            message = stored!;
        }
        if (files.Length > 0) s.World.Store.LinkDmFiles(message.Id, files);
        message = DisappearFeature.Stamp(s.World.Store, message, files);
        var frame = Frames.Event("group.message", new { message = PublicMessage(message) });
        foreach (var account in group.Members) s.Hub.SendToAccount(account, frame);
        s.Push.GroupMessage(me, group.Id, Reachable(s, group));
        return new { message = PublicMessage(message) };
    }

    private static object Repeat(GroupMessage? earlier) =>
        earlier is not null ? new { message = PublicMessage(earlier) } : throw RequestException.NotFound("Message"); // sent, then deleted

    private static object History(Session s, Member me, Body body)
    {
        var group = Mine(s, me, body.String("groupId", GroupChain.IdLength));
        var limit = (int)(body.OptionalLong("limit", 1, 100) ?? 50);
        var messages = s.World.Store.GroupHistory(group.Id, body.OptionalLong("before", 0), limit);
        return new { messages = messages.Select(PublicMessage), hasMore = messages.Count == limit };
    }
}
