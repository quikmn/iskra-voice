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
        router.Add("update.settings", (s, me, body) => Settings(updates, me, body));
        router.AddAsync("update.check", async (s, me, _) =>
        {
            OwnerOnly(me);
            await updates.CheckAsync(manual: true, CancellationToken.None);
            return new { status = updates.Status() };
        });
        router.Add("update.install", (s, me, _) =>
        {
            OwnerOnly(me);
            if (updates.TryStartInstall(manual: true) is { } refused) throw new RequestException(refused.Code, refused.Message);
            return new { status = updates.Status() };
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

    private static object Settings(UpdateService updates, Member me, Body body)
    {
        OwnerOnly(me);
        var error = updates.ChangeSettings(
            body.OptionalString("mode", 16), body.OptionalString("channel", 16), body.OptionalString("window", 5), body.OptionalBool("requireAttestation"));
        if (error is not null) throw RequestException.BadRequest(error);
        return new { status = updates.Status() };
    }
}
