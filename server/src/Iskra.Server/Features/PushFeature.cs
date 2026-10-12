using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Push registration for this device (browsers), and whether the user is looking at Iskra on it right now.</summary>
public static class PushFeature
{
    public static void Register(Router router)
    {
        router.Add("push.status", Status);
        router.Add("push.subscribe", Subscribe);
        router.Add("push.unsubscribe", Unsubscribe);
        router.Add("push.focus", Focus);
    }

    private static object Status(Session s, Member me, Body body)
    {
        var sub = s.World.Store.PushSubscriptionFor(s.DeviceKey!);
        var endpoint = sub?.AccountKey == me.AccountKey ? sub.Endpoint : null;
        return new { publicKey = s.Push.Keys.PublicKey, endpoint };
    }

    private static object? Subscribe(Session s, Member me, Body body)
    {
        var endpoint = body.String("endpoint", PushService.MaxEndpointLength);
        // Only browsers' push services. The phone apps notify only while they're open (older ones sent kind "native").
        if (body.OptionalString("kind", 10) is { } kind and not "web")
            throw RequestException.BadRequest("Only web push is supported. On phones, notifications arrive while the app is open.");
        if (s.Push.CheckEndpoint(endpoint) is { } problem) throw RequestException.BadRequest(problem);
        var keys = new Body(body.Element("keys"));
        var p256dh = keys.String("p256dh", 100);
        var auth = keys.String("auth", 40);
        if (!PushService.ValidKeys(p256dh, auth)) throw RequestException.BadRequest("Those aren't valid push keys.");

        s.World.Store.SavePushSubscription(me.AccountKey, s.DeviceKey!, endpoint, p256dh, auth, s.Now, PushService.MaxSubscriptionsPerAccount);
        return null;
    }

    private static object? Unsubscribe(Session s, Member me, Body body)
    {
        s.World.Store.DeletePushSubscription(s.DeviceKey!);
        return null;
    }

    private static object? Focus(Session s, Member me, Body body)
    {
        s.Push.SetFocus(s, body.OptionalBool("focused") ?? throw RequestException.BadRequest("'focused' is required."));
        return null;
    }
}
