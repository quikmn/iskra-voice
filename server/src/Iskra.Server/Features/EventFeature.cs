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
    /// <summary>Clock slack for a start time "right now".</summary>
    public const long StartSlackMs = 60_000;
    private static readonly string[] ImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

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
            throw RequestException.BadRequest("That isn't a time zone this server knows.");
        return raw;
    }

    private static string Title(string raw) =>
        Text.Normalize(raw, MaxTitle, allowNewlines: false) ?? throw RequestException.BadRequest($"Titles must be 1–{MaxTitle} characters.");

    /// <summary>Empty clears it.</summary>
    private static string? Description(string raw)
    {
        if (raw.Trim().Length == 0) return null;
        return Text.Normalize(raw, MaxDescription, allowNewlines: true)
            ?? throw RequestException.BadRequest($"Descriptions can be up to {MaxDescription} characters.");
    }

    /// <summary>{ channelId } for a voice channel you can see, or { text } for anywhere else.</summary>
    private static (string Kind, long? ChannelId, string? Text) Location(Session s, Member me, JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("'location' must be an object.");
        var location = new Body(element);
        if (location.OptionalLong("channelId", min: 1) is { } channelId)
        {
            var channel = ChatFeature.ReadableChannel(s, me, channelId);
            if (channel.Kind is not ("voice" or "stage")) throw RequestException.BadRequest("Events can only be in a voice or stage channel.");
            return ("voice", channel.Id, null);
        }
        var text = Text.Normalize(location.OptionalString("text", MaxLocation * 2), MaxLocation, allowNewlines: false)
            ?? throw RequestException.BadRequest($"Say where it is: a voice channel, or a place (1–{MaxLocation} characters).");
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
            throw RequestException.BadRequest("Cover images must be PNG, JPEG, WebP or GIF.");
        if (file.Size > MaxImageBytes) throw RequestException.BadRequest($"Cover images can be up to {MaxImageBytes / 1024 / 1024} MB.");
        return file.Id;
    }

    private static void CheckTimes(long start, long end, long now, bool startChanged)
    {
        if (startChanged && start < now - StartSlackMs) throw RequestException.BadRequest("Events have to start in the future.");
        if (start > now + MaxAheadMs) throw RequestException.BadRequest("Events can be scheduled up to a year ahead.");
        if (end <= start) throw RequestException.BadRequest("The end has to be after the start.");
        if (end - start > MaxDurationMs) throw RequestException.BadRequest("Events can last up to 7 days.");
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object List(Session s, Member me, Body body) =>
        new { events = s.World.Store.OpenEvents().Where(e => CanSee(s.World.Store, me, e)).Select(e => View(s.World.Store, e)) };

    private static object Create(Session s, Member me, Body body)
    {
        if (!Permissions.CanCreateEvent(me)) throw RequestException.Forbidden("Guests can't schedule events.");
        var store = s.World.Store;
        var title = Title(body.String("title", MaxTitle * 2));
        var description = body.OptionalString("description", MaxDescription * 2) is { } rawDescription ? Description(rawDescription) : null;
        var start = body.Long("startAt");
        var end = body.Long("endAt");
        CheckTimes(start, end, s.Now, startChanged: true);
        var zone = TimeZone(body.String("timeZone", 64));
        var (kind, channelId, place) = Location(s, me, body.Element("location"));
        var image = body.OptionalString("image", 64) is { } fileId ? Image(s, me, fileId, null) : null;
        if (store.OpenEventCount() >= MaxOpenEvents) throw RequestException.BadRequest($"This server already has {MaxOpenEvents} upcoming events.");
        if (!s.Hub.Limits.TryTake(me.AccountKey, "event.create")) throw new RequestException("rate_limited", "Too many new events. Try again in a few minutes.");

        var e = store.AddEvent(new ServerEvent(0, title, description, start, end, zone, kind, channelId, place, image, me.AccountKey, s.Now, "scheduled", null));
        store.SetInterest(e.Id, me.AccountKey, true, s.Now); // whoever plans it is going
        Broadcast(s.Hub, store, e);
        return new { @event = View(store, e) };
    }

    private static ServerEvent Managed(Session s, Member me, Body body)
    {
        var e = VisibleEvent(s, me, body.Long("id"));
        if (!Permissions.CanManageEvent(me, e.CreatedBy, s.World.Store.GetMember(e.CreatedBy)))
            throw RequestException.Forbidden("Only whoever created this event, or an admin, can change it.");
        if (!e.IsOpen) throw RequestException.BadRequest("This event is over.");
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
        if (start != e.StartAt && e.Status == "live") throw RequestException.BadRequest("This event has already started.");
        CheckTimes(start, end, s.Now, startChanged: start != e.StartAt);
        // A new start time gets a new reminder.
        e = e with { StartAt = start, EndAt = end, RemindedAt = start != before.StartAt ? null : e.RemindedAt };
        if (ForumFeature.HasField(body, "location"))
        {
            var (kind, channelId, place) = Location(s, me, body.Element("location"));
            e = e with { LocationKind = kind, ChannelId = channelId, Location = place };
        }
        if (body.OptionalString("image", 64) is { } fileId) e = e with { ImageFile = Image(s, me, fileId, e.ImageFile) };

        s.World.Store.UpdateEvent(e);
        Broadcast(s.Hub, s.World.Store, e, before);
        return new { @event = View(s.World.Store, e) };
    }

    private static object? Cancel(Session s, Member me, Body body)
    {
        var e = Managed(s, me, body);
        if (s.World.Store.SetEventStatus(e.Id, ["scheduled", "live"], "cancelled"))
            Broadcast(s.Hub, s.World.Store, e with { Status = "cancelled" });
        return null;
    }

    private static object Interest(Session s, Member me, Body body)
    {
        var e = VisibleEvent(s, me, body.Long("id"));
        if (!e.IsOpen) throw RequestException.BadRequest("This event is over.");
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
                    if (store.SetEventStatus(e.Id, ["scheduled", "live"], "ended")) EventFeature.Broadcast(hub, store, e with { Status = "ended" });
                }
                else if (e.Status == "scheduled" && now >= e.StartAt)
                {
                    if (!store.SetEventStatus(e.Id, ["scheduled"], "live")) continue;
                    var live = e with { Status = "live" };
                    EventFeature.Broadcast(hub, store, live);
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
            log.LogWarning(ex, "Event scheduling failed");
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
        var creator = store.GetMember(e.CreatedBy)?.Name ?? "Iskra";
        foreach (var accountKey in store.Interested(e.Id))
        {
            if (store.GetMember(accountKey) is not { } member || !EventFeature.CanSee(store, member, e)) continue;
            hub.SendToAccount(accountKey, frame);
            // No channelId: a click opens the server (a voice channel isn't somewhere to land).
            push.Notify(accountKey, new PushNote("event", $"event:{e.Id}", title, body, creator, Coalesce: false,
                TtlSeconds: kind == "live" ? 3600 : (int)Math.Clamp((e.StartAt - now) / 1000, 60, 3600)));
        }
    }
}
