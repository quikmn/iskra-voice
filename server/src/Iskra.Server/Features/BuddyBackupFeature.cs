using System.Runtime.CompilerServices;
using Iskra.Server.Backups;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Backup buddies (owner only, PROTOCOL.md → Backup buddies): our backups at friends' servers (buddy.*), and the
/// spots we keep for friends (buddy.spot*). The HTTP side between servers is in Backups/BuddyHolder.
/// </summary>
public static class BuddyBackupFeature
{
    private sealed record Services(BuddyBackupService Source, BuddyHolder Holder);

    // The Router is made before these services; each world finds its own here (tests run several servers at once).
    private static readonly ConditionalWeakTable<World, Services> ByWorld = new();

    public const int MaxLabel = 64;
    public const long MinQuotaMb = 100, MaxQuotaMb = 1024 * 1024, DefaultQuotaMb = 2048;
    public const int DefaultKeep = 3, DefaultGraceDays = 7, MaxGraceDays = 90;

    public static void Register(Router router)
    {
        router.Add("buddy.status", (s, me, _) => Owner(s, me).Source.Status());
        router.AddAsync("buddy.add", Add);
        router.AddAsync("buddy.remove", Remove);
        router.AddAsync("buddy.backupNow", BackupNow);
        router.Add("buddy.recoveryCode", RecoveryCode);
        router.Add("buddy.spots", (s, me, _) => Owner(s, me).Holder.Spots());
        router.Add("buddy.spot.create", CreateSpot);
        router.Add("buddy.spot.update", UpdateSpot);
        router.Add("buddy.spot.remove", RemoveSpot);
    }

    public static void MapEndpoints(WebApplication app)
    {
        var world = app.Services.GetRequiredService<World>();
        ByWorld.AddOrUpdate(world, new Services(app.Services.GetRequiredService<BuddyBackupService>(), app.Services.GetRequiredService<BuddyHolder>()));
        BuddyHolder.MapEndpoints(app);
    }

    private static Services Owner(Session s, Member me)
    {
        if (!BaseRoles.Allows(me, BaseAbility.RunServer)) throw RequestException.Forbidden("Only the owner can back up this server.", "owner_backup");
        return ByWorld.TryGetValue(s.World, out var services) ? services : throw new RequestException("internal", "Backup buddies aren't running.");
    }

    // ── Source ───────────────────────────────────────────────────────────────

    private static async Task<object?> Add(Session s, Member me, Body body)
    {
        var services = Owner(s, me);
        var code = body.String("code", BuddyCrypto.MaxCodeLength);
        if (!s.Hub.Limits.TryTake(me.AccountKey, "buddy.add"))
            throw new RequestException("rate_limited", "Slow down a little and try again.");
        var (added, recovery) = await services.Source.AddAsync(code, CancellationToken.None);
        SecurityLog.Record(s, "buddy.added", details: new { url = added.Url, holderKey = added.HolderKey });
        return Merge(services.Source.Status(), recovery);
    }

    /// <summary>The status with recoveryCode added (null unless this request made it).</summary>
    private static Dictionary<string, object?> Merge(object status, string? recoveryCode)
    {
        var map = System.Text.Json.JsonSerializer.SerializeToElement(status, Json.Options).EnumerateObject()
            .ToDictionary(p => p.Name, p => (object?)p.Value);
        map["recoveryCode"] = recoveryCode;
        return map;
    }

    private static async Task<object?> Remove(Session s, Member me, Body body)
    {
        var services = Owner(s, me);
        var buddy = s.World.Store.GetBuddy(body.String("id", 64)) ?? throw RequestException.NotFound("Backup buddy");
        await services.Source.RemoveAsync(buddy);
        SecurityLog.Record(s, "buddy.removed", details: new { url = buddy.Url });
        return services.Source.Status();
    }

    private static async Task<object?> BackupNow(Session s, Member me, Body body)
    {
        var services = Owner(s, me);
        if (s.World.Store.Buddies().Count == 0) throw RequestException.NotFound("Backup buddy");
        await services.Source.BackupNowAsync();
        return services.Source.Status();
    }

    private static object RecoveryCode(Session s, Member me, Body body)
    {
        var code = Owner(s, me).Source.RecoveryCode();
        SecurityLog.Record(s, "buddy.recovery.shown");
        return new { recoveryCode = code };
    }

    // ── Holder ───────────────────────────────────────────────────────────────

    private static string Label(Body body, string field = "label")
    {
        var label = body.String(field, MaxLabel * 4).Trim();
        if (label.Length is 0 or > MaxLabel || label.Any(char.IsControl))
            throw RequestException.BadRequest($"Give the spot a name of 1–{MaxLabel} characters.", "buddy_label", new { max = MaxLabel });
        return label;
    }

    private static object CreateSpot(Session s, Member me, Body body)
    {
        var holder = Owner(s, me).Holder;
        var label = Label(body);
        var quotaMb = body.OptionalLong("quotaMb", MinQuotaMb, MaxQuotaMb) ?? DefaultQuotaMb;
        var keep = (int)(body.OptionalLong("keep", 1, 30) ?? DefaultKeep);
        var grace = (int)(body.OptionalLong("graceDays", 0, MaxGraceDays) ?? DefaultGraceDays);
        string? address;
        if (body.OptionalString("url", 512) is { } given)
        {
            if (!Uri.TryCreate(given.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.Host.Length == 0
                || !string.IsNullOrEmpty(uri.UserInfo) || uri.Query.Length > 0 || uri.Fragment.Length > 0)
                throw RequestException.BadRequest("That address can't be used for a backup buddy.", "buddy_address");
            address = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        }
        else address = holder.Address();
        if (address is null)
            throw RequestException.BadRequest("Give the address your friend's server can reach this one at.", "buddy_no_address");
        var (spot, code) = holder.CreateSpot(label, quotaMb * 1024 * 1024, keep, grace, address);
        SecurityLog.Record(s, "buddy.spot.created", details: new { quotaMb, keep });
        holder.Changed();
        return new { spot = holder.SpotView(spot), code };
    }

    private static BuddySpotRow Spot(Session s, Body body) =>
        s.World.Store.GetBuddySpot(body.String("id", 64)) ?? throw RequestException.NotFound("Spot");

    private static object UpdateSpot(Session s, Member me, Body body)
    {
        var holder = Owner(s, me).Holder;
        var spot = Spot(s, body);
        var label = body.Has("label") ? Label(body) : spot.Label;
        var quota = body.OptionalLong("quotaMb", MinQuotaMb, MaxQuotaMb) is { } mb ? mb * 1024 * 1024 : spot.QuotaBytes;
        var keep = (int)(body.OptionalLong("keep", 1, 30) ?? spot.Keep);
        var grace = (int)(body.OptionalLong("graceDays", 0, MaxGraceDays) ?? spot.GraceDays);
        s.World.Store.UpdateBuddySpot(spot.Id, label, quota, keep, grace);
        holder.Changed();
        return new { spot = holder.SpotView(s.World.Store.GetBuddySpot(spot.Id)!) };
    }

    private static object RemoveSpot(Session s, Member me, Body body)
    {
        var holder = Owner(s, me).Holder;
        var spot = Spot(s, body);
        holder.RemoveSpot(spot, body.OptionalBool("now") ?? false, "holder");
        return holder.Spots();
    }
}
