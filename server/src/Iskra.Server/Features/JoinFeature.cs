using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Join gating and raid controls: invites that need a moderator's approval (the joiner waits outside until someone says
/// yes), pausing every invite at once (by hand, or by AutoMod's join-flood rule), and a slowmode for newcomers.
/// The handshake (Session.Authenticate) applies all three; this is the moderators' side.
/// </summary>
public static class JoinFeature
{
    public const int MaxNewcomerHours = 24 * 30;
    /// <summary>Who AutoMod pauses invites as (never an account key).</summary>
    public const string AutoModBy = AutoModFeature.Author;

    public static void Register(Router router)
    {
        router.Add("join.list", List);
        router.Add("join.count", (s, me, _) => new { pending = ReportFeature.IsModerator(me) ? s.World.Store.CountPendingJoins() : 0 });
        router.Add("join.approve", Approve);
        router.Add("join.decline", Decline);
        router.Add("join.settings.get", (s, me, _) => new { settings = SettingsView(s, me) });
        router.Add("join.settings.update", UpdateSettings);
    }

    // ── The queue ────────────────────────────────────────────────────────────

    private static void RequireModerator(Member me)
    {
        if (!ReportFeature.IsModerator(me)) throw RequestException.Forbidden("Only moderators can let people in.", "mods_joins");
    }

    /// <summary>Which invite they came through: its tail and who made it, never the whole code (a moderator may not be its owner).</summary>
    private static object View(Store store, JoinRequest r)
    {
        var invite = store.GetInvite(r.InviteCode);
        return new
        {
            accountKey = r.AccountKey, name = r.Name, requestedAt = r.RequestedAt, role = r.Role,
            invite = new { tail = r.InviteCode.Length > 6 ? r.InviteCode[^6..] : r.InviteCode, createdBy = invite?.CreatedBy },
        };
    }

    private static object List(Session s, Member me, Body body)
    {
        RequireModerator(me);
        return new { requests = s.World.Store.PendingJoinRequests().Select(r => View(s.World.Store, r)) };
    }

    /// <summary>Tells every online moderator how many people are waiting.</summary>
    public static void QueueChanged(Store store, Hub hub)
    {
        var pending = store.CountPendingJoins();
        var frame = Frames.Event("join.count", new { pending });
        foreach (var session in hub.Sessions)
            if (session.CurrentMember() is { } m && ReportFeature.IsModerator(m)) session.Send(frame);
    }

    private static JoinRequest Pending(Session s, Body body)
    {
        var request = s.World.Store.GetJoinRequest(body.String("accountKey", 64));
        return request is { DeclinedAt: null } ? request : throw RequestException.NotFound("Join request");
    }

    /// <summary>Lets them in with the role their invite carried. Their app is retrying the handshake and gets its welcome next time.</summary>
    private static object Approve(Session s, Member me, Body body)
    {
        RequireModerator(me);
        var store = s.World.Store;
        var request = Pending(s, body);
        if (store.IsBanned(request.AccountKey)) throw RequestException.BadRequest("They were banned meanwhile.", "join_banned");
        store.RemoveJoinRequest(request.AccountKey);
        var member = store.AddMember(request.AccountKey, request.Name, request.Role, s.Now);
        SecurityLog.Record(s, "join.approved", request.AccountKey, new { role = request.Role });
        Audit.Record(s, "join.approve", request.AccountKey, details: new { role = request.Role });
        s.Hub.Broadcast(Frames.Event("member.joined", new { member = s.Hub.PublicMember(member) }));
        s.Hub.Outhooks?.MemberJoined(member);
        s.Hub.BuiltinBots?.Joined(member);
        QueueChanged(store, s.Hub);
        return new { member = s.Hub.PublicMember(member) };
    }

    /// <summary>Turns them away: the invite's use stays spent, and their app is told no the next time it asks.</summary>
    private static object? Decline(Session s, Member me, Body body)
    {
        RequireModerator(me);
        var request = Pending(s, body);
        s.World.Store.DeclineJoinRequest(request.AccountKey, s.Now);
        SecurityLog.Record(s, "join.declined", request.AccountKey);
        Audit.Record(s, "join.decline", details: new { accountKey = request.AccountKey, name = request.Name });
        QueueChanged(s.World.Store, s.Hub);
        return null;
    }

    // ── Pausing invites and newcomer slowmode ────────────────────────────────

    private static object SettingsView(Session s, Member me)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can change how people join.", "admins_joins");
        return SettingsView(s.World.Store.JoinSettings());
    }

    public static object SettingsView(JoinSettings j) => new
    {
        invitesPaused = j.InvitesPaused, pausedAt = j.PausedAt, pausedBy = j.PausedBy,
        newcomerHours = j.NewcomerHours, newcomerSlowmode = j.NewcomerSlowmode,
    };

    private static object UpdateSettings(Session s, Member me, Body body)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can change how people join.", "admins_joins");
        var store = s.World.Store;
        var before = store.JoinSettings();
        var hours = (int)(body.OptionalLong("newcomerHours", min: 0, max: MaxNewcomerHours) ?? before.NewcomerHours);
        var slowmode = before.NewcomerSlowmode;
        if (body.OptionalLong("newcomerSlowmode", min: 0, max: ModerationFeature.SlowmodeSteps[^1]) is { } seconds)
        {
            if (!ModerationFeature.SlowmodeSteps.Contains((int)seconds)) throw RequestException.BadRequest("'newcomerSlowmode' must be off or one of the offered steps (5 s to 6 h).");
            slowmode = (int)seconds;
        }
        var paused = body.OptionalBool("invitesPaused") ?? before.InvitesPaused;
        var after = before with
        {
            NewcomerHours = hours, NewcomerSlowmode = slowmode, InvitesPaused = paused,
            PausedAt = paused ? (before.InvitesPaused ? before.PausedAt : s.Now) : null,
            PausedBy = paused ? (before.InvitesPaused ? before.PausedBy : me.AccountKey) : null,
        };
        if (after == before) return new { settings = SettingsView(after) };
        store.SaveJoinSettings(after);
        if (after.InvitesPaused != before.InvitesPaused)
        {
            Audit.Record(s, after.InvitesPaused ? "invites.pause" : "invites.resume");
            SecurityLog.Record(s, after.InvitesPaused ? "invites.paused" : "invites.resumed");
            PausedChanged(s.Hub, after.InvitesPaused);
        }
        if (after.NewcomerHours != before.NewcomerHours || after.NewcomerSlowmode != before.NewcomerSlowmode)
            Audit.Record(s, "join.newcomers", details: new { hours = after.NewcomerHours, slowmode = after.NewcomerSlowmode });
        SettingsChanged(s.Hub, after);
        return new { settings = SettingsView(after) };
    }

    /// <summary>Everyone hears when invites stop or start working (their invite dialogs say so); admins get the whole settings.</summary>
    public static void PausedChanged(Hub hub, bool paused) => hub.Broadcast(Frames.Event("invites.paused", new { paused }));

    private static void SettingsChanged(Hub hub, JoinSettings settings)
    {
        var frame = Frames.Event("join.settings", new { settings = SettingsView(settings) });
        foreach (var session in hub.Sessions)
            if (session.CurrentMember() is { } m && Permissions.IsAdmin(m)) session.Send(frame);
    }

    /// <summary>AutoMod's join-flood rule paused invites: recorded as AutoMod, and admins resume by hand.</summary>
    public static void PausedByAutoMod(Store store, Hub hub, long now, int joins, int minutes)
    {
        var settings = store.JoinSettings();
        if (settings.InvitesPaused) return;
        var after = settings with { InvitesPaused = true, PausedAt = now, PausedBy = AutoModBy };
        store.SaveJoinSettings(after);
        store.AddAudit(now, "invites.pause", AutoModBy, "AutoMod", null, null, "join flood", System.Text.Json.JsonSerializer.Serialize(new { joins, minutes }, Json.Options));
        SecurityLog.Record(store, now, "invites.paused", null, null, new { by = "automod", joins, minutes });
        PausedChanged(hub, true);
        SettingsChanged(hub, after);
    }

    /// <summary>The slowmode a newcomer gets everywhere (0 = none): members younger than the set hours.</summary>
    public static int NewcomerSlowmode(Store store, Member me, long now)
    {
        var settings = store.JoinSettings();
        if (settings.NewcomerHours <= 0 || settings.NewcomerSlowmode <= 0) return 0;
        return now - me.JoinedAt < settings.NewcomerHours * 3_600_000L ? settings.NewcomerSlowmode : 0;
    }
}
