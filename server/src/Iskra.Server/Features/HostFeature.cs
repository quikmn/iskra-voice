using Iskra.Server.Hosting;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>"Open to the internet": admins can see how hosting is going; only the owner can switch it.</summary>
public static class HostFeature
{
    public static void Register(Router router, InternetHost internet)
    {
        router.Add("host.status", (s, me, body) => Status(internet, me));
        router.Add("host.internet.set", (s, me, body) => SetInternet(s, internet, me, body));
    }

    private static object Status(InternetHost internet, Member me)
    {
        if (!Permissions.IsAdmin(me)) throw RequestException.Forbidden();
        return new { status = internet.Status() };
    }

    private static object SetInternet(Session s, InternetHost internet, Member me, Body body)
    {
        if (me.Role != Roles.Owner) throw RequestException.Forbidden("Only the owner can open the server to the internet.");
        var enabled = body.OptionalBool("enabled") ?? throw RequestException.BadRequest("'enabled' must be true or false.");
        internet.SetEnabled(enabled);
        Audit.Record(s, "server.internet", details: new { enabled });
        return new { status = internet.Status() };
    }
}
