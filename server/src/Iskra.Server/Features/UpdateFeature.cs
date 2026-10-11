using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Updates;

namespace Iskra.Server.Features;

/// <summary>Server updates (Settings → Updates): only the owner sees and changes them.</summary>
public static class UpdateFeature
{
    public static void Register(Router router, UpdateService updates)
    {
        router.Add("update.status", (s, me, _) => Status(updates, me));
        router.Add("update.settings", (s, me, body) => Settings(s, updates, me, body));
        router.AddAsync("update.check", async (s, me, _) =>
        {
            OwnerOnly(me);
            await updates.CheckAsync(manual: true, CancellationToken.None);
            var status = updates.Status();
            SecurityLog.Record(s, "update.check", details: new { latest = status.Latest?.Version });
            return new { status };
        });
        router.Add("update.install", (s, me, _) =>
        {
            OwnerOnly(me);
            if (updates.TryStartInstall(manual: true) is { } refused) throw new RequestException(refused.Code, refused.Message);
            var status = updates.Status();
            SecurityLog.Record(s, "update.install", details: new { from = status.Current, to = status.Latest?.Version });
            return new { status };
        });
    }

    private static void OwnerOnly(Member me)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can manage updates.");
    }

    private static object Status(UpdateService updates, Member me)
    {
        OwnerOnly(me);
        return new { status = updates.Status() };
    }

    private static object Settings(Session s, UpdateService updates, Member me, Body body)
    {
        OwnerOnly(me);
        var before = s.World.Settings.Updates;
        var error = updates.ChangeSettings(
            body.OptionalString("mode", 16), body.OptionalString("channel", 16), body.OptionalString("window", 5), body.OptionalBool("requireAttestation"));
        if (error is not null) throw RequestException.BadRequest(error);
        if (s.World.Settings.Updates != before) SecurityLog.Record(s, "update.settings", details: new { from = before, to = s.World.Settings.Updates });
        return new { status = updates.Status() };
    }
}
