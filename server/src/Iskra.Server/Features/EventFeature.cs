using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Scheduled events: a title, a time (stored in UTC, with the creator's time zone for display), a place (a voice channel
/// here or free text) and who is interested. <see cref="EventScheduler"/> reminds interested members and moves events
/// to live and ended. An event in a voice channel is only visible to people who can see that channel.
/// A repeating event is a series: one occurrence at a time, the next one made when the current one ends (or is
/// cancelled on its own), at the same wall-clock time in the creator's zone; interest is per occurrence.
/// </summary>
public static partial class EventFeature
{
    public const int MaxTitle = 100;
    public const int MaxDescription = 1000;
    public const int MaxLocation = 100;
    public const int MaxOpenEvents = 100;
    public const int MaxImageBytes = 5 * 1024 * 1024;
    public const long MaxDurationMs = 7L * 24 * 60 * 60 * 1000;
    public const long MaxAheadMs = 366L * 24 * 60 * 60 * 1000;
    /// <summary>How far ahead a series may run (<c>until</c>).</summary>
    public const long MaxUntilAheadMs = 2 * MaxAheadMs;
    /// <summary>Clock slack for a start time "right now".</summary>
    public const long StartSlackMs = 60_000;
    private static readonly string[] ImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    public static readonly string[] Repeats = ["none", "daily", "weekly", "biweekly", "monthly"];

    public static void Register(Router router)
    {
        router.Add("event.list", List);
        router.Add("event.create", Create);
        router.Add("event.update", Update);
        router.Add("event.cancel", Cancel);
        router.Add("event.interest", Interest);
    }

    public static object View(Store store, ServerEvent e)
    {
        var image = e.ImageFile is null ? null : store.GetFile(e.ImageFile);
        return new
        {
            id = e.Id,
            title = e.Title,
            description = e.Description,
            startAt = e.StartAt,
            endAt = e.EndAt,
            timeZone = e.TimeZone,
            location = e.LocationKind == "voice"
                ? (object)new { kind = "voice", channelId = e.ChannelId }
                : new { kind = "place", text = e.Location },
            image = image is null ? null : Uploads.Public(image),
            createdBy = e.CreatedBy,
            createdAt = e.CreatedAt,
            status = e.Status,
            interested = store.Interested(e.Id),
            repeat = e.Repeat,
            until = e.Repeats ? e.Until : null,
            seriesId = e.Repeats ? e.SeriesId : null,
        };
    }

    /// <summary>An event in a voice channel is only visible to that channel's readers (a deleted channel hides nothing).</summary>
    public static bool CanSee(Store store, Member member, ServerEvent e) =>
        e.LocationKind != "voice" || e.ChannelId is not { } id || store.GetChannel(id) is not { } channel || Permissions.CanRead(member, channel);

    /// <summary>
    /// Sends the event to everyone who can see it now; anyone who could see <paramref name="before"/> but not this
    /// version (it moved to a channel they can't read) gets <c>event.removed</c>.
    /// </summary>
    internal static void Broadcast(Hub hub, Store store, ServerEvent e, ServerEvent? before = null)
    {
        var updated = Frames.Event("event.updated", new { @event = View(store, e) });
        var removed = Frames.Event("event.removed", new { id = e.Id });
        foreach (var session in hub.Sessions)
        {
            var member = session.CurrentMember();
            if (member is null) continue;
            if (CanSee(store, member, e)) session.Send(updated);
            else if (before is not null && CanSee(store, member, before)) session.Send(removed);
        }
    }

    private static ServerEvent VisibleEvent(Session s, Member me, long id)
    {
        var e = s.World.Store.GetEvent(id);
        if (e is null || !CanSee(s.World.Store, me, e)) throw RequestException.NotFound("Event");
        return e;
    }

    // ── Field rules ──────────────────────────────────────────────────────────

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+)*$")]
    private static partial Regex ZonePattern();

    /// <summary>An IANA time zone this server knows (e.g. "Europe/Stockholm"), or "UTC".</summary>
    internal static string TimeZone(string raw)
    {
        if (raw.Length > 64 || !ZonePattern().IsMatch(raw) || !TimeZoneInfo.TryFindSystemTimeZoneById(raw, out _))
            throw RequestException.BadRequest("That isn't a time zone this server knows.", "time_zone");
        return raw;
    }

    private static string Title(string raw) =>
        Text.Normalize(raw, MaxTitle, allowNewlines: false) ?? throw RequestException.BadRequest($"Titles must be 1–{MaxTitle} characters.", "title_length", new { max = MaxTitle });

    /// <summary>Empty clears it.</summary>
    private static string? Description(string raw)
    {
        if (raw.Trim().Length == 0) return null;
        return Text.Normalize(raw, MaxDescription, allowNewlines: true)
            ?? throw RequestException.BadRequest($"Descriptions can be up to {MaxDescription} characters.", "description_length", new { max = MaxDescription });
    }

    /// <summary>{ channelId } for a voice channel you can see, or { text } for anywhere else.</summary>
    private static (string Kind, long? ChannelId, string? Text) Location(Session s, Member me, JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'location' must be an object.");
        var location = new Body(element);
        if (location.OptionalLong("channelId", min: 1) is { } channelId)
        {
            var channel = ChatFeature.ReadableChannel(s, me, channelId);
            if (channel.Kind is not ("voice" or "stage")) throw RequestException.BadRequest("Events can only be in a voice or stage channel.", "event_channel");
            return ("voice", channel.Id, null);
        }
        var text = Text.Normalize(location.OptionalString("text", MaxLocation * 2), MaxLocation, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Say where it is: a voice channel, or a place (1–{MaxLocation} characters).", "event_location", new { max = MaxLocation });
        return ("place", null, text);
    }

    /// <summary>A cover image: your own upload, an image the server could read. Empty string: none.</summary>
    private static string? Image(Session s, Member me, string fileId, string? current)
    {
        if (fileId.Length == 0) return null;
        if (fileId == current) return current;
        var file = s.World.Store.GetFile(fileId);
        if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown image file.");
        if (!ImageTypes.Contains(file.Type) || file.Width is not > 0 || file.Height is not > 0)
            throw RequestException.BadRequest("Cover images must be PNG, JPEG, WebP or GIF.", "cover_type");
        if (file.Size > MaxImageBytes) throw RequestException.BadRequest($"Cover images can be up to {MaxImageBytes / 1024 / 1024} MB.", "cover_size", new { mb = MaxImageBytes / 1024 / 1024 });
        return file.Id;
    }

    private static void CheckTimes(long start, long end, long now, bool startChanged)
    {
        if (startChanged && start < now - StartSlackMs) throw RequestException.BadRequest("Events have to start in the future.", "event_future");
        if (start > now + MaxAheadMs) throw RequestException.BadRequest("Events can be scheduled up to a year ahead.", "event_year");
        if (end <= start) throw RequestException.BadRequest("The end has to be after the start.", "event_end_after_start");
        if (end - start > MaxDurationMs) throw RequestException.BadRequest("Events can last up to 7 days.", "event_7_days");
    }

    // ── Repeating ────────────────────────────────────────────────────────────

    /// <summary>`repeat` and `until` from the body, on top of what the event has. `until: 0` clears it.</summary>
    private static (string Repeat, long? Until) RepeatRule(Body body, string currentRepeat, long? currentUntil, long start, long now)
    {
        var repeat = body.OptionalString("repeat", 16) ?? currentRepeat;
        if (!Repeats.Contains(repeat)) throw RequestException.BadRequest("Events can repeat daily, weekly, biweekly or monthly.", "event_repeat");
        var until = body.OptionalLong("until", min: 0) is { } raw ? raw == 0 ? null : (long?)raw : currentUntil;
        if (repeat == "none")
        {
            if (until is not null && body.Has("until")) throw RequestException.BadRequest("An end date only goes with a repeat.", "event_until_repeat");
            return ("none", null);
        }
        if (until is { } u)
        {
            if (u < start) throw RequestException.BadRequest("The series has to end after the first event.", "event_until");
            if (u > now + MaxUntilAheadMs) throw RequestException.BadRequest("A series can run up to 2 years ahead.", "event_until_2_years");
        }
        return (repeat, until);
    }

    /// <summary>
    /// The start of the occurrence after one at <paramref name="startUtc"/>: the same wall-clock time in <paramref name="zone"/>
    /// a day, a week, two weeks or a month later (the 31st becomes the 30th in a short month, as calendars do).
    /// A time that doesn't exist that day (clocks going forward) moves an hour on.
    /// </summary>
    internal static long NextStart(long startUtc, string repeat, string zone)
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(zone);
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTimeOffset.FromUnixTimeMilliseconds(startUtc).UtcDateTime, tz);
        var next = repeat switch
        {
            "daily" => local.AddDays(1),
            "weekly" => local.AddDays(7),
            "biweekly" => local.AddDays(14),
            "monthly" => local.AddMonths(1),
            _ => throw new ArgumentOutOfRangeException(nameof(repeat)),
        };
        next = DateTime.SpecifyKind(next, DateTimeKind.Unspecified);
        if (tz.IsInvalidTime(next)) next = next.AddHours(1);
        return new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(next, tz)).ToUnixTimeMilliseconds();
    }

    /// <summary>
    /// Makes the next occurrence of a series after <paramref name="ending"/> (skipping any the server slept through),
    /// unless the series is over (<c>until</c> passed) or already has one. The creator is interested, as for a new event.
    /// </summary>
    internal static ServerEvent? Materialise(Hub hub, Store store, ServerEvent ending, long now)
    {
        if (!ending.Repeats || ending.SeriesId is not { } seriesId || store.SeriesHasOpenOccurrence(seriesId)) return null;
        var start = ending.StartAt;
        var guard = 0;
        do
        {
            start = NextStart(start, ending.Repeat, ending.TimeZone);
            if (ending.Until is { } until && start > until) return null;
        } while (start < now && ++guard < 2000);
        if (start < now) return null;
        var next = store.AddEvent(ending with
        {
            StartAt = start, EndAt = start + (ending.EndAt - ending.StartAt), CreatedAt = now, Status = "scheduled", RemindedAt = null,
        });
        store.SetInterest(next.Id, next.CreatedBy, true, now);
        Broadcast(hub, store, next);
        return next;
    }

    /// <summary>`scope`: "series" (default) or "one" (this occurrence only; nothing for an event that doesn't repeat).</summary>
    private static bool WholeSeries(Body body) =>
        (body.OptionalString("scope", 16) ?? "series") switch
        {
            "series" => true,
            "one" => false,
            _ => throw RequestException.BadRequest("'scope' must be \"one\" or \"series\"."),
        };

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object List(Session s, Member me, Body body) =>
        new { events = s.World.Store.OpenEvents().Where(e => CanSee(s.World.Store, me, e)).Select(e => View(s.World.Store, e)) };

    private static object Create(Session s, Member me, Body body)
    {
        if (!Permissions.CanCreateEvent(me)) throw RequestException.Forbidden("Guests can't schedule events.", "guests_no_events");
        var store = s.World.Store;
        var title = Title(body.String("title", MaxTitle * 2));
        var description = body.OptionalString("description", MaxDescription * 2) is { } rawDescription ? Description(rawDescription) : null;
        var start = body.Long("startAt");
        var end = body.Long("endAt");
        CheckTimes(start, end, s.Now, startChanged: true);
        var zone = TimeZone(body.String("timeZone", 64));
        var (kind, channelId, place) = Location(s, me, body.Element("location"));
        var image = body.OptionalString("image", 64) is { } fileId ? Image(s, me, fileId, null) : null;
        var (repeat, until) = RepeatRule(body, "none", null, start, s.Now);
        AutoModFeature.Check(s, me, null, title + "\n" + description, "event");
        if (store.OpenEventCount() >= MaxOpenEvents) throw RequestException.BadRequest($"This server already has {MaxOpenEvents} upcoming events.", "events_max", new { max = MaxOpenEvents });
        if (!s.Hub.Limits.TryTake(me.AccountKey, "event.create")) throw new RequestException("rate_limited", "Too many new events. Try again in a few minutes.", "too_many_events");

        var e = store.AddEvent(new ServerEvent(0, title, description, start, end, zone, kind, channelId, place, image, me.AccountKey, s.Now, "scheduled", null, repeat, until));
        store.SetInterest(e.Id, me.AccountKey, true, s.Now); // whoever plans it is going
        Broadcast(s.Hub, store, e);
        return new { @event = View(store, e) };
    }

    private static ServerEvent Managed(Session s, Member me, Body body)
    {
        var e = VisibleEvent(s, me, body.Long("id"));
        if (!Permissions.CanManageEvent(me, e.CreatedBy, s.World.Store.GetMember(e.CreatedBy)))
            throw RequestException.Forbidden("Only whoever created this event, or an admin, can change it.", "event_change_owner");
        if (!e.IsOpen) throw RequestException.BadRequest("This event is over.", "event_over");
        return e;
    }

    private static object Update(Session s, Member me, Body body)
    {
        var before = Managed(s, me, body);
        var e = before;
        if (body.OptionalString("title", MaxTitle * 2) is { } title) e = e with { Title = Title(title) };
        if (body.OptionalString("description", MaxDescription * 2) is { } description) e = e with { Description = Description(description) };
        if (body.OptionalString("timeZone", 64) is { } zone) e = e with { TimeZone = TimeZone(zone) };
        var start = body.OptionalLong("startAt") ?? e.StartAt;
        var end = body.OptionalLong("endAt") ?? e.EndAt;
        if (start != e.StartAt && e.Status == "live") throw RequestException.BadRequest("This event has already started.", "event_started");
        CheckTimes(start, end, s.Now, startChanged: start != e.StartAt);
        // A new start time gets a new reminder.
        e = e with { StartAt = start, EndAt = end, RemindedAt = start != before.StartAt ? null : e.RemindedAt };
        if (ForumFeature.HasField(body, "location"))
        {
            var (kind, channelId, place) = Location(s, me, body.Element("location"));
            e = e with { LocationKind = kind, ChannelId = channelId, Location = place };
        }
        if (body.OptionalString("image", 64) is { } fileId) e = e with { ImageFile = Image(s, me, fileId, e.ImageFile) };
        if (e.Title != before.Title || e.Description != before.Description) AutoModFeature.Check(s, me, null, e.Title + "\n" + e.Description, "event");

        var store = s.World.Store;
        var wholeSeries = WholeSeries(body);
        if (wholeSeries || !before.Repeats)
        {
            var (repeat, until) = RepeatRule(body, e.Repeat, e.Until, e.StartAt, s.Now);
            // Starting to repeat makes this the first of a new series; stopping leaves a one-off.
            e = e with { Repeat = repeat, Until = until, SeriesId = repeat == "none" ? null : e.SeriesId ?? e.Id };
        }
        else
        {
            // This occurrence only: it leaves the series, which carries on from the unchanged one.
            if (body.Has("repeat") || body.Has("until")) throw RequestException.BadRequest("Change the whole series to change how it repeats.", "event_scope_repeat");
            if (store.OpenEventCount() >= MaxOpenEvents) throw RequestException.BadRequest($"This server already has {MaxOpenEvents} upcoming events.", "events_max", new { max = MaxOpenEvents });
            e = e with { Repeat = "none", Until = null, SeriesId = null };
        }

        store.UpdateEvent(e);
        Broadcast(s.Hub, store, e, before);
        if (before.Repeats && !wholeSeries) Materialise(s.Hub, store, before, s.Now);
        return new { @event = View(store, e) };
    }

    private static object? Cancel(Session s, Member me, Body body)
    {
        var e = Managed(s, me, body);
        var wholeSeries = WholeSeries(body);
        if (s.World.Store.SetEventStatus(e.Id, ["scheduled", "live"], "cancelled"))
        {
            Broadcast(s.Hub, s.World.Store, e with { Status = "cancelled" });
            // Skipping one occurrence brings the next one forward now; cancelling the series ends it.
            if (!wholeSeries) Materialise(s.Hub, s.World.Store, e, s.Now);
        }
        return null;
    }

    private static object Interest(Session s, Member me, Body body)
    {
        var e = VisibleEvent(s, me, body.Long("id"));
        if (!e.IsOpen) throw RequestException.BadRequest("This event is over.", "event_over");
        var on = body.OptionalBool("on") ?? true;
        var was = s.World.Store.Interested(e.Id).Contains(me.AccountKey);
        if (was != on)
        {
            s.World.Store.SetInterest(e.Id, me.AccountKey, on, s.Now);
            Broadcast(s.Hub, s.World.Store, e);
        }
        return new { @event = View(s.World.Store, e) };
    }
}

/// <summary>
/// Moves events to live at their start and ended at their end, and reminds interested members (in the app and by
/// Web Push) a little before the start and when it goes live.
/// </summary>
public sealed class EventScheduler(World world, Hub hub, PushService push, TimeProvider time, IConfiguration config, ILogger<EventScheduler> log)
    : BackgroundService
{
    /// <summary>How long before the start the reminder goes out (15 minutes; tests shorten it).</summary>
    private readonly long _lead = config.GetValue("Events:ReminderLeadMs", 15 * 60_000L);
    private long _lastCleanup;

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping)) Tick();
        }
        catch (OperationCanceledException) { }
    }

    internal void Tick()
    {
        try
        {
            var now = time.GetUtcNow().ToUnixTimeMilliseconds();
            var store = world.Store;
            foreach (var e in store.OpenEvents())
            {
                if (now >= e.EndAt)
                {
                    if (!store.SetEventStatus(e.Id, ["scheduled", "live"], "ended")) continue;
                    EventFeature.Broadcast(hub, store, e with { Status = "ended" });
                    EventFeature.Materialise(hub, store, e, now); // a series carries on with its next occurrence
                }
                else if (e.Status == "scheduled" && now >= e.StartAt)
                {
                    if (!store.SetEventStatus(e.Id, ["scheduled"], "live")) continue;
                    var live = e with { Status = "live" };
                    EventFeature.Broadcast(hub, store, live);
                    hub.Outhooks?.EventStarted(live);
                    Remind(live, "live", now);
                }
                // Reminders only for events planned further ahead than the lead (otherwise "live" is the reminder).
                else if (e.Status == "scheduled" && e.RemindedAt is null && now >= e.StartAt - _lead && e.CreatedAt < e.StartAt - _lead)
                {
                    if (store.MarkReminded(e.Id, now)) Remind(e, "soon", now);
                }
            }
            if (now - _lastCleanup > 3_600_000)
            {
                _lastCleanup = now;
                store.DeleteOldEvents(now - 30L * 24 * 3_600_000);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not ObjectDisposedException)
        {
            log.Warn(ex, "SCH-110", "sched", "failed", ("what", "events"));
        }
    }

    /// <summary>Interested members who can still see the event: an in-app reminder on their sessions, and a push.</summary>
    private void Remind(ServerEvent e, string kind, long now)
    {
        var store = world.Store;
        var view = EventFeature.View(store, e);
        var frame = Frames.Event("event.reminder", new { @event = view, kind });
        var place = e.LocationKind == "voice"
            ? e.ChannelId is { } id && store.GetChannel(id) is { } channel ? $"in {channel.Name}" : "in voice"
            : e.Location ?? "";
        var minutes = Math.Max(1, (int)Math.Round((e.StartAt - now) / 60_000.0));
        var (title, body) = kind == "live"
            ? ($"{e.Title} is starting now", place.Length > 0 ? $"Happening {place}" : "Happening now")
            : ($"Starting soon: {e.Title}", place.Length > 0 ? $"In {minutes} min, {place}" : $"In {minutes} min");
        var channelName = e.LocationKind == "voice" && e.ChannelId is { } cid ? store.GetChannel(cid)?.Name : null;
        var where = e.LocationKind == "voice" ? channelName is null ? "Voice" : "Channel" : place.Length > 0 ? "At" : "";
        var text = new PushText(kind == "live" ? "eventLive" : "eventSoon", (kind == "live" ? "happening" : "inMinutes") + where,
            new { title = e.Title, minutes, channel = channelName, place = e.LocationKind == "voice" ? null : e.Location });
        var creator = store.GetMember(e.CreatedBy)?.Name ?? "Iskra";
        foreach (var accountKey in store.Interested(e.Id))
        {
            if (store.GetMember(accountKey) is not { } member || !EventFeature.CanSee(store, member, e)) continue;
            hub.SendToAccount(accountKey, frame);
            // No channelId: a click opens the server (a voice channel isn't somewhere to land).
            push.Notify(accountKey, new PushNote("event", $"event:{e.Id}", title, body, creator, Coalesce: false,
                TtlSeconds: kind == "live" ? 3600 : (int)Math.Clamp((e.StartAt - now) / 1000, 60, 3600), Text: text));
        }
    }
}
