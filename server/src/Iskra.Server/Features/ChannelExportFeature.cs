using System.Text.Json;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Channel export (admins, the <c>exportChannels</c> permission): a zip of readable HTML, JSON and attachments for
/// channels you can read, made in the background (ChannelExports). Never encrypted channels or DMs.
/// </summary>
public static class ChannelExportFeature
{
    private static readonly string[] Kinds = ["text", "voice", "stage", "forum", "docs"];

    public static void Register(Router router)
    {
        // 3 at once, then one every 10 minutes, whatever the number of connections.
        AccountLimits.Limits.TryAdd("channel.export", (3, 1 / 600.0));
        router.Add("channel.export", Start);
        router.Add("channel.export.status", Status);
        router.Add("channel.export.cancel", Cancel);
    }

    public static void MapEndpoints(WebApplication app)
    {
        ChannelExports.For(app.Services.GetRequiredService<World>()).Log = app.Services.GetRequiredService<ILogger<ChannelExports>>();
        app.MapGet("/channel-export/{token}", (HttpContext context, string token, World world) => ChannelExports.For(world).Serve(context, token));
    }

    private static void Require(Session s, Member me)
    {
        if (s.World.Store.IsBot(me.AccountKey)) throw RequestException.Forbidden("Bots can't export channels.", "export_bot");
        if (!Permissions.Has(me, Perm.ExportChannels)) throw RequestException.Forbidden("You can't export channels on this server.", "export_forbidden");
    }

    private static object Start(Session s, Member me, Body body)
    {
        Require(s, me);
        var store = s.World.Store;
        if (body.OptionalElement("channelIds") is not { ValueKind: JsonValueKind.Array } list || list.GetArrayLength() is 0 or > ChannelExports.MaxChannels)
            throw RequestException.BadRequest($"'channelIds' must list 1–{ChannelExports.MaxChannels} channels.");
        var ids = list.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var id) ? id
            : throw RequestException.BadRequest("'channelIds' must be a list of channel ids.")).ToList();
        if (ids.Distinct().Count() != ids.Count) throw RequestException.BadRequest("'channelIds' lists a channel twice.");
        var from = body.OptionalLong("from", min: 0);
        var to = body.OptionalLong("to", min: 0);
        if (from is not null && to is not null && from > to)
            throw RequestException.BadRequest("The start of the range is after its end.", "export_range");
        var attachments = body.OptionalBool("attachments") ?? true;
        var threads = body.OptionalBool("threads") ?? true;
        var zone = Zone(body.OptionalString("timeZone", 64));
        var lang = body.OptionalString("lang", 8) ?? "en";
        if (!ExportPage.Words.ContainsKey(lang)) lang = "en";

        var channels = new List<Channel>();
        foreach (var id in ids)
        {
            // Channels you can't read (or threads, which come with their channel) don't exist for you.
            var channel = store.GetChannel(id);
            if (channel is null || channel.Kind == "thread" || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
            if (E2eeChannelFeature.IsEncrypted(store, channel))
                throw RequestException.BadRequest("Encrypted channels can only be exported from a member's device.", "export_encrypted", new { channelId = id });
            if (!Kinds.Contains(channel.Kind))
                throw RequestException.BadRequest("This kind of channel can't be exported.", "export_kind", new { channelId = id });
            channels.Add(channel);
        }

        var exports = ChannelExports.For(s.World);
        if (!s.Hub.Limits.TryTake(me.AccountKey, "channel.export"))
            throw new RequestException("rate_limited", "You've made several exports just now. Try again in a few minutes.", "channel_export_slow");
        var request = new ExportRequest(me.AccountKey, store.DisplayName(me), s.World.Settings.Name, channels, from, to, attachments, threads, zone, lang);
        var hub = s.Hub;
        var job = exports.Start(request, s.Uploads, j => hub.SendToAccount(j.Request.Requester, Frames.Event("channel.export.progress", new { job = ChannelExports.View(j) })))
            ?? throw new RequestException("rate_limited", "An export is being made right now. Try again when it's done.", "channel_export_busy");

        // What was exported and by whom: never any content.
        var details = new { channelIds = ids, from, to, attachments, threads };
        Audit.Record(s, "channel.export", details: details);
        SecurityLog.Record(s, "channel.export", details: details);
        return new { job = ChannelExports.View(job) };
    }

    private static object Status(Session s, Member me, Body body)
    {
        Require(s, me);
        return new { jobs = ChannelExports.For(s.World).JobsOf(me.AccountKey).Select(ChannelExports.View) };
    }

    private static object Cancel(Session s, Member me, Body body)
    {
        Require(s, me);
        var job = ChannelExports.For(s.World).Find(me.AccountKey, body.String("id", 32)) ?? throw RequestException.NotFound("Export");
        if (job.State == "running") job.Cancel.Cancel();
        return new { job = ChannelExports.View(job) };
    }

    /// <summary>An IANA (or Windows) time zone; UTC when unknown.</summary>
    public static TimeZoneInfo Zone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException or ArgumentException) { return TimeZoneInfo.Utc; }
    }
}
