using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Who may start a DM with you, and message requests. Each person picks who may write first (anyone, anyone as a
/// request, people they've talked to and staff, or only people they've talked to); the server enforces it on every
/// <c>dm.send</c>, call and group add. A first DM someone may only send as a request is stored and relayed like any
/// DM, but the recipient's copy is marked as a request and never pushed. The sender sees exactly what they'd see for
/// any DM, so they can't tell a waiting request from an ignored one (or from one that was read).
/// </summary>
public static class DmPrivacyFeature
{
    /// <summary>How far ahead of the server's clock a setting's time may be.</summary>
    private const long MaxClockSkewMs = 10 * 60 * 1000;
    public const int MaxRequests = 200;

    public const string Anyone = "anyone", Requests = "requests", Known = "known", Nobody = "nobody";
    private static readonly HashSet<string> Levels = [Anyone, Requests, Known, Nobody];

    /// <summary>What a DM is to its recipient.</summary>
    public enum Delivery { Normal, Request, Ignored }

    public static void Register(Router router)
    {
        router.Add("dm.privacy.get", (s, me, _) => View(s.World.Store.DmPrivacy(me.AccountKey), s.Now));
        router.Add("dm.privacy.set", Set);
        router.Add("dm.requests.list", List);
        router.Add("dm.requests.accept", (s, me, body) => Decide(s, me, body, DmContactState.Accepted));
        router.Add("dm.requests.ignore", (s, me, body) => Decide(s, me, body, DmContactState.Ignored));
    }

    /// <summary><c>now</c>: the server's clock, so apps with a clock that's off can still stamp a change it takes.</summary>
    private static object View((string Who, long At) pref, long now) => new { who = pref.Who, at = pref.At, now };

    private static object Set(Session s, Member me, Body body)
    {
        var who = body.String("who", 16);
        if (!Levels.Contains(who)) throw RequestException.BadRequest("'who' must be anyone, requests, known or nobody.");
        var at = body.OptionalLong("at", min: 1) ?? throw RequestException.BadRequest("'at' is required.");
        if (at > s.Now + MaxClockSkewMs) throw RequestException.BadRequest("The change's time is off. Check your clock.", "clock_off");
        var before = s.World.Store.DmPrivacy(me.AccountKey);
        var after = s.World.Store.SetDmPrivacy(me.AccountKey, who, at);
        if (after != before) ToOtherSessions(s, me, Frames.Event("dm.privacy", View(after, s.Now)));
        return View(after, s.Now);
    }

    public static string StateName(DmContactState state) => state switch
    {
        DmContactState.Request => "request",
        DmContactState.Ignored => "ignored",
        _ => "accepted",
    };

    private static object List(Session s, Member me, Body body) =>
        new
        {
            requests = s.World.Store.DmRequests(me.AccountKey, MaxRequests)
                .Select(r => new { accountKey = r.Peer, state = StateName(r.State), at = r.At, lastId = r.LastId, lastAt = r.LastAt }),
        };

    /// <summary>Accept or ignore someone's DMs. Only your own inbox changes; the other person is never told.</summary>
    private static object Decide(Session s, Member me, Body body, DmContactState state)
    {
        var key = body.String("accountKey", 64);
        if (key == me.AccountKey) throw RequestException.BadRequest("That's you.");
        var peer = s.World.Store.GetMember(key) ?? throw RequestException.NotFound("Member");
        if (s.World.Store.SetDmContact(me.AccountKey, peer.AccountKey, state, s.Now))
            ToOtherSessions(s, me, Frames.Event("dm.requests.changed", new { accountKey = peer.AccountKey, state = StateName(state) }));
        return new { accountKey = peer.AccountKey, state = StateName(state) };
    }

    private static void ToOtherSessions(Session s, Member me, string frame)
    {
        foreach (var other in s.Hub.Sessions.Where(o => o.AccountKey == me.AccountKey && o != s)) other.Send(frame);
    }

    /// <summary>
    /// Checked by <c>dm.send</c> before storing (after the block and bot checks): whether <paramref name="me"/> may write
    /// to <paramref name="peer"/>, and what the DM is to them. Throws <c>forbidden</c> (<c>dm_closed</c>) if they take no
    /// DMs from <paramref name="me"/>, and <c>rate_limited</c> (<c>dm_new_limit</c>) for too many new conversations.
    /// </summary>
    public static Delivery CheckSend(Session s, Member me, Member peer)
    {
        if (peer.AccountKey == me.AccountKey) return Delivery.Normal;
        var store = s.World.Store;
        var delivery = Decision(s, me, peer) ?? throw Closed("message");
        // New, from what the two of them did (never from the recipient's accept or ignore, which the sender can't know).
        var fresh = !store.DmWrote(me.AccountKey, peer.AccountKey) && !store.DmWrote(peer.AccountKey, me.AccountKey);
        // Bots have their own limit for new conversations (BotDmFeature); people get this one, staff aside.
        if (fresh && !store.IsBot(me.AccountKey) && !IsStaff(store, me) && !s.Hub.Limits.TryTake(me.AccountKey, "dm.new"))
            throw new RequestException("rate_limited", "You started a lot of new conversations just now. Try again later.", "dm_new_limit");
        return delivery;
    }

    /// <summary>
    /// After a DM was stored: notes that <paramref name="me"/> wrote (a request stays one until answered), and that
    /// writing to someone accepts their DMs. Only your own acts accept: a DM that went straight in because of the
    /// recipient's setting, a staff or bot exemption never makes its sender "talked to".
    /// </summary>
    public static void Sent(Session s, Member me, Member peer, Delivery delivery, bool silent)
    {
        if (peer.AccountKey == me.AccountKey) return;
        var store = s.World.Store;
        store.NoteDmWritten(me.AccountKey, peer.AccountKey, request: delivery == Delivery.Request, s.Now);
        // Quiet sends (declining a friend request and the like) aren't an answer to the conversation: they don't accept.
        if (!silent && store.SetDmContact(me.AccountKey, peer.AccountKey, DmContactState.Accepted, s.Now))
            ToAccount(s, me, Frames.Event("dm.requests.changed", new { accountKey = peer.AccountKey, state = "accepted" }));
    }

    private static void ToAccount(Session s, Member me, string frame) => s.Hub.SendToAccount(me.AccountKey, frame);

    /// <summary>
    /// Calls, disappearing-message timers and group adds: allowed only if <paramref name="peer"/> would take a DM from
    /// <paramref name="me"/> straight into their list (accepted, or allowed by their setting); never for a request or an
    /// ignored one (the same answer for both).
    /// </summary>
    public static void CheckContact(Session s, Member me, Member peer, string what)
    {
        if (peer.AccountKey == me.AccountKey) return;
        if (Decision(s, me, peer) != Delivery.Normal) throw Closed(what, peer);
    }

    /// <summary>
    /// What a DM from <paramref name="me"/> is to <paramref name="peer"/> right now: null if refused. Decided afresh each
    /// time from the recipient's own decision, their current setting and live exemptions (staff now; a bot whose
    /// command they used in the last 15 minutes), none of which is ever stored as "talked to".
    /// </summary>
    private static Delivery? Decision(Session s, Member me, Member peer)
    {
        var store = s.World.Store;
        if (store.IsBot(peer.AccountKey)) return Delivery.Normal; // anyone may write to a bot (BotDmFeature)
        var state = store.DmContact(peer.AccountKey, me.AccountKey);
        if (state == DmContactState.Accepted) return Delivery.Normal;
        var who = store.DmPrivacy(peer.AccountKey).Who;
        // A bot answering a command the person just used isn't writing out of the blue (even at "nobody"); staff reach
        // people at "requests" and "known".
        var exempt = (store.IsBot(me.AccountKey) && s.Hub.Interactions.Invoked(me.AccountKey, peer.AccountKey))
            || (who is Requests or Known && IsStaff(store, me));
        if (state == DmContactState.Ignored) return who is Known or Nobody && !exempt ? null : Delivery.Ignored;
        if (exempt) return Delivery.Normal;
        return who switch
        {
            Requests => Delivery.Request,
            Known or Nobody => null,
            _ => state == DmContactState.Request ? Delivery.Request : Delivery.Normal, // anyone: a waiting request stays one
        };
    }

    /// <summary>Server staff (moderators and admins, never bots) reach people who take DMs from "people I've talked to and staff".</summary>
    private static bool IsStaff(Store store, Member m) => !store.IsBot(m.AccountKey) && ReportFeature.IsModerator(m);

    /// <summary>The same answer whatever the reason (their setting, a request not accepted yet, or an ignored one).</summary>
    private static RequestException Closed(string what, Member? peer = null) => what switch
    {
        "call" => RequestException.Forbidden("This person isn't taking calls from you right now.", "call_closed"),
        "group" => RequestException.Forbidden($"{peer?.Name} isn't taking group DMs from you right now.", "group_closed", new { name = peer?.Name }),
        _ => RequestException.Forbidden("This person isn't taking new direct messages right now.", "dm_closed"),
    };
}
