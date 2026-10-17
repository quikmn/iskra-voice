using System.Reflection;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Activities: shared mini-apps in a voice channel. Built-ins ship with the apps; admins add their own as zip bundles,
/// stored here and served from <c>/activities/&lt;id&gt;/</c> in a sandbox with no network. The server relays what an
/// activity sends to everyone playing (in one order), keeps a snapshot for late joiners, and stores none of it.
/// </summary>
public static partial class ActivitiesFeature
{
    public static readonly string[] Builtins = ["draw", "trivia", "four"];
    public const int MaxActivities = 25;
    public const int MaxPlayers = 25;
    public const int MaxDataBytes = 8 * 1024;
    public const int MaxStateBytes = 48 * 1024;
    /// <summary>Who may start an activity, at the lowest.</summary>
    private static readonly string[] StartRoles = [Roles.Guest, Roles.Member, Roles.Trusted, Roles.Admin];

    private static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    [GeneratedRegex("^[A-Za-z0-9_-]{16,64}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex(@"^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$")]
    private static partial Regex HostPattern();

    [GeneratedRegex(@"^\s*<!doctype[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex Doctype();

    public static void Register(Router router)
    {
        router.Add("act.list", List);
        router.Add("act.add", Add);
        router.Add("act.update", Update);
        router.Add("act.remove", Remove);
        router.Add("act.configure", Configure);
        router.Add("act.start", Start);
        router.Add("act.join", Join);
        router.Add("act.leave", Leave);
        router.Add("act.send", Send);
        router.Add("act.snapshot", SetSnapshot);
        router.Add("act.end", End);
    }

    // ── The catalog ────────────────────────────────────────────────────────────

    public static object View(StoredActivity a) => new
    {
        id = a.Id, name = a.Name, description = a.Description, icon = a.Icon is null ? null : $"/activities/{a.Id}/{a.Icon}",
        minPlayers = a.MinPlayers, maxPlayers = a.MaxPlayers, version = a.Version, size = a.Size, files = a.Files,
        enabled = a.Enabled, addedBy = a.AddedBy, addedAt = a.AddedAt, entry = $"/activities/{a.Id}/index.html",
    };

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden("Only admins can change activities.", "act_admins");
    }

    private static object List(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var admin = Permissions.IsAdmin(me);
        var off = store.BuiltinActivitiesOff();
        return new
        {
            activities = store.Activities().Where(a => admin || a.Enabled).Select(View),
            builtins = Builtins.Where(b => admin || !off.Contains(b)).Select(b => new { id = b, enabled = !off.Contains(b) }),
            startRole = store.ActivityStartRole(),
            off = store.ActivityOffChannels(),
        };
    }

    private static void CatalogChanged(Session s) => s.Hub.Broadcast(Frames.Event("act.catalog", new { }));

    private static object Add(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var file = store.GetFile(body.String("file", 64));
        if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown activity file.");
        if (store.ActivityCount() >= MaxActivities)
            throw RequestException.BadRequest($"A server can have up to {MaxActivities} activities.", "act_limit", new { max = MaxActivities });
        if (file.Size > ActivityBundle.MaxZipBytes)
            throw new BundleException("act_zip", "Activities must be a zip of up to 5 MB.", new { maxMb = ActivityBundle.MaxZipBytes / 1024 / 1024, maxFiles = ActivityBundle.MaxFiles }).ToRequest();

        ActivityManifest manifest;
        List<ActivityFile> files;
        try
        {
            using var zip = File.OpenRead(s.Uploads.PathFor(file.Sha256));
            (manifest, files) = ActivityBundle.Read(zip);
        }
        catch (BundleException e)
        {
            if (e.Hostile) SecurityLog.Record(s, "activity.rejected", details: new { reason = e.Reason });
            throw e.ToRequest();
        }
        catch (IOException)
        {
            throw RequestException.NotFound("Activity file");
        }

        var activity = new StoredActivity(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), manifest.Name, manifest.Description, manifest.Icon,
            manifest.MinPlayers, manifest.MaxPlayers, manifest.Version, files.Sum(f => (long)f.Data.Length), files.Count, true, me.AccountKey, s.Now);
        store.AddActivity(activity, files);
        Audit.Record(s, "act.add", details: new { id = activity.Id, name = activity.Name });
        SecurityLog.Record(s, "activity.added", details: new { id = activity.Id, name = activity.Name, files = activity.Files, size = activity.Size });
        CatalogChanged(s);
        return new { activity = View(activity) };
    }

    private static object? Update(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var id = body.String("id", 64);
        var enabled = body.OptionalBool("enabled") ?? throw RequestException.BadRequest("'enabled' is required.");
        string name;
        if (Builtins.Contains(id))
        {
            store.SetBuiltinActivityEnabled(id, enabled);
            name = id;
        }
        else
        {
            var activity = store.GetActivity(id) ?? throw RequestException.NotFound("Activity");
            store.SetActivityEnabled(id, enabled);
            name = activity.Name;
        }
        if (!enabled) EndWhere(s, (_, activity) => activity == id);
        Audit.Record(s, "act.update", details: new { id, name, enabled, builtin = Builtins.Contains(id) });
        CatalogChanged(s);
        return null;
    }

    private static object? Remove(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var activity = store.GetActivity(body.String("id", 64)) ?? throw RequestException.NotFound("Activity");
        store.RemoveActivity(activity.Id);
        EndWhere(s, (_, a) => a == activity.Id);
        Audit.Record(s, "act.remove", details: new { id = activity.Id, name = activity.Name });
        SecurityLog.Record(s, "activity.removed", details: new { id = activity.Id, name = activity.Name });
        CatalogChanged(s);
        return null;
    }

    private static object Configure(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var store = s.World.Store;
        var startRole = body.OptionalString("startRole", 16);
        var channelId = body.OptionalLong("channelId");
        var off = body.OptionalBool("off");
        if (startRole is null && channelId is null) throw RequestException.BadRequest("'startRole' or 'channelId' is required.");
        if (startRole is not null && !StartRoles.Contains(startRole)) throw RequestException.BadRequest("'startRole' must be guest, member, trusted or admin.");
        Channel? channel = null;
        if (channelId is { } id)
        {
            channel = store.GetChannel(id) ?? throw RequestException.NotFound("Channel");
            if (channel.Kind != "voice") throw RequestException.BadRequest("Activities happen in voice channels.", "act_voice_only");
            if (off is null) throw RequestException.BadRequest("'off' is required with 'channelId'.");
        }

        if (startRole is not null) store.SetActivityStartRole(startRole);
        if (channel is not null)
        {
            store.SetActivitiesOff(channel.Id, off!.Value);
            if (off.Value) s.Hub.ActivityRooms.End(s.Hub, store, channel.Id);
        }
        Audit.Record(s, "act.configure", details: new { startRole, channelId = channel?.Id, channelName = channel?.Name, off });
        CatalogChanged(s);
        return new { startRole = store.ActivityStartRole(), off = store.ActivityOffChannels() };
    }

    /// <summary>Ends running sessions that match (an activity turned off or removed).</summary>
    private static void EndWhere(Session s, Func<long, string, bool> match)
    {
        foreach (var (channelId, activity) in s.Hub.ActivityRooms.Running())
            if (match(channelId, activity)) s.Hub.ActivityRooms.End(s.Hub, s.World.Store, channelId);
    }

    // ── Sessions ───────────────────────────────────────────────────────────────

    /// <summary>The activity's name for a session (server-added only), or not_found when it's unknown or off.</summary>
    private static string? EnabledActivity(Store store, string id)
    {
        if (Builtins.Contains(id)) return store.BuiltinActivitiesOff().Contains(id) ? throw RequestException.NotFound("Activity") : null;
        var activity = store.GetActivity(id);
        return activity is { Enabled: true } ? activity.Name : throw RequestException.NotFound("Activity");
    }

    private static bool Enabled(Store store, string id) =>
        Builtins.Contains(id) ? !store.BuiltinActivitiesOff().Contains(id) : store.GetActivity(id) is { Enabled: true };

    /// <summary>A voice channel you can read where activities may run, and you're in its call.</summary>
    private static Channel RoomChannel(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        if (store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't use activities.", "act_bots");
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind != "voice") throw RequestException.BadRequest("Activities happen in voice channels.", "act_voice_only");
        if (E2eeVoiceFeature.IsEncrypted(store, channel.Id))
            throw RequestException.BadRequest("Activities are off in encrypted voice channels: the server would see what they send.", "act_e2ee");
        if (store.ActivitiesOff(channel.Id)) throw RequestException.BadRequest("Activities are turned off in this channel.", "act_off");
        if (!InRoom(s.Voice, channel.Id, me.AccountKey)) throw RequestException.BadRequest("Join the voice channel first.", "voice_join_first");
        return channel;
    }

    private static bool InRoom(VoiceRegistry voice, long channelId, string accountKey) =>
        voice.Participants(channelId).Any(p => p.AccountKey == accountKey);

    private static object? Start(Session s, Member me, Body body)
    {
        var channel = RoomChannel(s, me, body);
        var store = s.World.Store;
        var activity = body.String("activity", 64);
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can only listen in this channel.", "act_listen_only");
        if (Roles.Rank(me.Role) < Roles.Rank(store.ActivityStartRole()))
            throw RequestException.Forbidden("Your role can't start activities on this server.", "act_start_role");
        var name = EnabledActivity(store, activity);
        var id = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(12));
        return new { session = s.Hub.ActivityRooms.Start(s.Hub, store, s, me.AccountKey, channel.Id, activity, name, id, s.Now) };
    }

    private static object Join(Session s, Member me, Body body)
    {
        var channel = RoomChannel(s, me, body);
        return s.Hub.ActivityRooms.Join(s.Hub, s.World.Store, s, me.AccountKey, channel.Id, body.String("sessionId", 32), MaxPlayers);
    }

    private static object? Leave(Session s, Member me, Body body)
    {
        s.Hub.ActivityRooms.Leave(s.Hub, s.World.Store, s, body.Long("channelId"), body.OptionalString("sessionId", 32));
        return null;
    }

    /// <summary>Any JSON value, compact, and its size in UTF-8 bytes (checked against <paramref name="max"/>).</summary>
    private static (JsonElement Value, int Bytes) Payload(Body body, string field, int max, Func<RequestException> tooBig)
    {
        var element = body.Element(field);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(element, Compact);
        if (bytes.Length > max) throw tooBig();
        return (element.Clone(), bytes.Length);
    }

    private static object Send(Session s, Member me, Body body)
    {
        var channel = RoomChannel(s, me, body);
        var sessionId = body.String("sessionId", 32);
        var (data, bytes) = Payload(body, "data", MaxDataBytes,
            () => RequestException.BadRequest($"Activity messages can be up to {MaxDataBytes / 1024} KB.", "act_data_size", new { kb = MaxDataBytes / 1024 }));
        return new { seq = s.Hub.ActivityRooms.Send(s, channel.Id, sessionId, data, bytes) };
    }

    private static object? SetSnapshot(Session s, Member me, Body body)
    {
        var channel = RoomChannel(s, me, body);
        var sessionId = body.String("sessionId", 32);
        var seq = body.OptionalLong("seq", 0) ?? throw RequestException.BadRequest("'seq' is required.");
        var (state, _) = Payload(body, "state", MaxStateBytes,
            () => RequestException.BadRequest($"Activity snapshots can be up to {MaxStateBytes / 1024} KB.", "act_state_size", new { kb = MaxStateBytes / 1024 }));
        s.Hub.ActivityRooms.SetState(s, channel.Id, sessionId, seq, state);
        return null;
    }

    private static object? End(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        var sessionId = body.String("sessionId", 32);
        var info = s.Hub.ActivityRooms.Info(channel.Id, sessionId) ?? throw RequestException.NotFound("Activity");
        var starterGone = !InRoom(s.Voice, channel.Id, info.StartedBy);
        var allowed = info.StartedBy == me.AccountKey || Permissions.IsAdmin(me)
            || (starterGone && s.Hub.ActivityRooms.IsPlayer(s, channel.Id, sessionId));
        if (!allowed) throw RequestException.Forbidden("Only whoever started the activity can end it.", "act_end_starter");
        s.Hub.ActivityRooms.End(s.Hub, store, channel.Id, sessionId);
        return null;
    }

    // ── Keeping sessions honest ────────────────────────────────────────────────

    private static bool Allowed(Store store, Channel channel, string activity) =>
        channel.Kind == "voice" && !E2eeVoiceFeature.IsEncrypted(store, channel.Id) && !store.ActivitiesOff(channel.Id) && Enabled(store, activity);

    /// <summary>After the call's people change (or roles, channels): players must still be in the call and able to read it.</summary>
    public static void Sync(Hub hub, Store store, VoiceRegistry voice, long channelId)
    {
        var inRoom = voice.Participants(channelId).Select(p => p.AccountKey).ToHashSet();
        hub.ActivityRooms.Sync(hub, store, channelId, inRoom, (channel, run) => Allowed(store, channel, run.Activity));
    }

    public static void SyncAll(Hub hub, Store store, VoiceRegistry voice)
    {
        foreach (var channelId in hub.ActivityRooms.Channels()) Sync(hub, store, voice, channelId);
    }

    // ── Serving bundles ────────────────────────────────────────────────────────

    private static string? sdk;

    /// <summary>The SDK (protocol/activity-sdk.js), as one inline script.</summary>
    public static string SdkScript
    {
        get
        {
            if (sdk is not null) return sdk;
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("activity-sdk.js")
                ?? throw new InvalidOperationException("activity-sdk.js is missing from the build.");
            using var reader = new StreamReader(stream);
            return sdk = "<script>" + reader.ReadToEnd().Replace("</script", "<\\/script", StringComparison.OrdinalIgnoreCase) + "</script>";
        }
    }

    /// <summary>The WebRTC prelude and the SDK go right after a doctype (so the page keeps standards mode), otherwise first.</summary>
    public static string WithPrelude(string html)
    {
        var head = ProfilePages.Prelude + SdkScript;
        var doctype = Doctype().Match(html);
        return doctype.Success ? html[..doctype.Length] + head + html[doctype.Length..] : head + html;
    }

    /// <summary>Like a profile page with scripts: no network, an opaque origin, only this activity's own files.</summary>
    public static string Policy(World world, string? selfOrigin, string id)
    {
        var own = selfOrigin is null ? "" : $" {selfOrigin}/activities/{id}/";
        return "sandbox allow-scripts; default-src 'none'; " +
            $"script-src 'unsafe-inline'{own}; style-src 'unsafe-inline'{own}; img-src data: blob:{own}; font-src data:{own}; media-src data: blob:{own}; " +
            "connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; " +
            $"manifest-src 'none'; base-uri 'none'; frame-ancestors {ProfilePages.FrameAncestors(world)}";
    }

    public static IResult Serve(HttpContext context, World world, string id, string path)
    {
        if (!IdPattern().IsMatch(id) || !ActivityBundle.ValidPath(path)) return Results.NotFound();
        var store = world.Store;
        if (store.GetActivity(id) is not { Enabled: true }) return Results.NotFound();
        var file = store.GetActivityFile(id, path);
        if (file is null) return Results.NotFound();

        var host = context.Request.Host.Value;
        var self = host is not null && HostPattern().IsMatch(host) ? $"{(context.Request.IsHttps ? "https" : "http")}://{host}" : null;
        var headers = context.Response.Headers;
        headers.ContentSecurityPolicy = Policy(world, self, id);
        headers["Permissions-Policy"] = ProfilePages.PermissionsPolicy;
        headers.XContentTypeOptions = "nosniff";
        headers["Referrer-Policy"] = "no-referrer";
        headers["X-DNS-Prefetch-Control"] = "off";
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers.CacheControl = "no-store";
        if (file.Type.StartsWith("text/html", StringComparison.Ordinal))
            return Results.Content(WithPrelude(System.Text.Encoding.UTF8.GetString(file.Data).TrimStart('﻿')), file.Type);
        return Results.File(file.Data, file.Type, enableRangeProcessing: true);
    }
}
