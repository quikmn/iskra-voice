using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The owner's security log and retention settings, and "Download my data" (see DataExports). Moderation and admin actions
/// stay in the audit log (ModerationFeature); the security log holds what the audit log doesn't: sign-in failures, rate
/// limits, new members and devices, key rotations, account deletions, backups, moves, retention changes and data exports.
/// </summary>
public static class ComplianceFeature
{
    public const int MaxLogPage = 500;
    /// <summary>Longest retention the app offers (100 years); 0 means keep.</summary>
    public const int MaxRetentionDays = 36500;

    public static void Register(Router router, DataExports exports)
    {
        router.Add("security.log.list", ListLog);
        router.Add("retention.get", (s, me, _) => { RequireOwner(me, "read"); return View(s.World.Settings.Retention); });
        router.Add("retention.update", UpdateRetention);
        router.AddAsync("data.export", (s, me, body) => Export(exports, s, me, body));
    }

    public static void MapEndpoints(WebApplication app) =>
        app.MapGet("/export/{token}", (HttpContext context, string token, DataExports exports) => exports.Serve(context, token));

    private static void RequireOwner(Member me, string what)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden($"Only the owner can {what} this server's security settings.", $"owner_security_{what}");
    }

    private static object ListLog(Session s, Member me, Body body)
    {
        RequireOwner(me, "read");
        var evt = body.OptionalString("event", 40);
        var account = body.OptionalString("account", 64);
        var before = body.OptionalLong("before", min: 1);
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxLogPage) ?? 100);
        if (body.OptionalBool("export") == true && before is null) SecurityLog.Record(s, "security.log.export");
        var entries = s.World.Store.SecurityEvents(evt, account, before, limit);
        return new
        {
            entries = entries.Select(e => new
            {
                id = e.Id, at = e.At, @event = e.Event, account = e.Account,
                accountName = e.Account is null ? null : s.World.Store.GetMember(e.Account)?.Name,
                ip = e.Ip,
                details = e.Details is null ? (JsonElement?)null : JsonDocument.Parse(e.Details).RootElement.Clone(),
            }),
            hasMore = entries.Count == limit,
        };
    }

    public static object View(RetentionSettings r) => new
    {
        messagesDays = r.MessagesDays, uploadsDays = r.UploadsDays, auditDays = r.AuditDays, securityLogDays = r.SecurityLogDays,
        securityLogIps = r.SecurityLogIps,
    };

    private static object UpdateRetention(Session s, Member me, Body body)
    {
        RequireOwner(me, "change");
        int? Days(string key) => (int?)body.OptionalLong(key, min: 0, max: MaxRetentionDays);
        var messages = Days("messagesDays");
        var uploads = Days("uploadsDays");
        var audit = Days("auditDays");
        var security = Days("securityLogDays");
        var ips = body.OptionalBool("securityLogIps");
        var before = s.World.Settings.Retention;
        s.World.UpdateSettings(w => w with
        {
            Retention = w.Retention with
            {
                MessagesDays = messages ?? w.Retention.MessagesDays,
                UploadsDays = uploads ?? w.Retention.UploadsDays,
                AuditDays = audit ?? w.Retention.AuditDays,
                SecurityLogDays = security ?? w.Retention.SecurityLogDays,
                SecurityLogIps = ips ?? w.Retention.SecurityLogIps,
            },
        });
        var after = s.World.Settings.Retention;
        if (after != before) SecurityLog.Record(s, "retention.update", details: new { from = View(before), to = View(after) });
        return View(after);
    }

    private static async Task<object?> Export(DataExports exports, Session s, Member me, Body body)
    {
        var subject = body.OptionalString("accountKey", 64) ?? me.AccountKey;
        if (subject != me.AccountKey)
        {
            if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can export someone else's data.", "owner_export");
            if (!s.World.Store.KnowsAccount(subject)) throw RequestException.NotFound("Account");
        }
        var made = await exports.CreateAsync(s.World, subject, me.AccountKey, s.Now)
            ?? throw new RequestException("rate_limited", "An export is being made right now. Try again in a moment.", "export_busy");
        SecurityLog.Record(s, "data.export", subject, subject == me.AccountKey ? null : new { by = me.AccountKey });
        return new { url = $"/export/{made.Token}", name = made.FileName, size = made.Size, expiresAt = made.ExpiresAt };
    }
}

/// <summary>
/// Writes security events (see ComplianceFeature). A burst of the same event from the same address or account is capped
/// (<see cref="MaxPerMinute"/> a minute); the next entry after a burst says how many were left out.
/// </summary>
public static class SecurityLog
{
    public const int MaxPerMinute = 10;
    private const long WindowMs = 60_000;

    private sealed class Window
    {
        public long Start;
        public int Count;
        public int Suppressed;
    }

    private static readonly ConditionalWeakTable<Store, ConcurrentDictionary<(string, string), Window>> Windows = new();

    public static void Record(Session s, string evt, string? account = null, object? details = null) =>
        Record(s.World.Store, s.Now, evt, account ?? s.AccountKey, s.LoggedIp, details, source: s.RemoteIp);

    /// <param name="ip">Recorded (only when the owner turned on Retention.SecurityLogIps).</param>
    /// <param name="source">Where it came from, for limiting bursts only (never stored); defaults to <paramref name="ip"/>.</param>
    public static void Record(Store store, long now, string evt, string? account = null, string? ip = null, object? details = null, string? source = null)
    {
        var windows = Windows.GetOrCreateValue(store);
        var window = windows.GetOrAdd((evt, source ?? ip ?? account ?? ""), _ => new Window { Start = now });
        int suppressed;
        lock (window)
        {
            if (now - window.Start >= WindowMs)
            {
                suppressed = window.Suppressed;
                window.Start = now;
                window.Count = 0;
                window.Suppressed = 0;
            }
            else suppressed = 0;
            if (++window.Count > MaxPerMinute)
            {
                window.Suppressed++;
                return;
            }
        }
        if (windows.Count > 10_000)
            foreach (var (key, w) in windows)
                if (now - w.Start > WindowMs && w.Suppressed == 0) windows.TryRemove(key, out _);

        var json = details is null ? null : JsonSerializer.SerializeToNode(details, Json.Options) as JsonObject;
        if (suppressed > 0) (json ??= [])["suppressedBefore"] = suppressed;
        store.AddSecurityEvent(now, evt, account, ip, json?.ToJsonString());
    }
}
