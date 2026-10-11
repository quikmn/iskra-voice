using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Push registration for this device (browsers, or the phone apps through the push relay), and whether the user is looking at Iskra on it right now.</summary>
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
        var kind = endpoint is null ? null : s.Push.IsNative(endpoint) ? PushService.NativeKind : PushService.WebKind;
        return new { publicKey = s.Push.Keys.PublicKey, endpoint, kind };
    }

    private static object? Subscribe(Session s, Member me, Body body)
    {
        var endpoint = body.String("endpoint", PushService.MaxEndpointLength);
        // "native": a phone app's endpoint at the Iskra push relay (APNs/FCM); "web" (default): a browser's push service.
        var kind = body.OptionalString("kind", 10) ?? PushService.WebKind;
        if (kind is not (PushService.WebKind or PushService.NativeKind)) throw RequestException.BadRequest("'kind' must be web or native.");
        if (s.Push.CheckEndpoint(endpoint, kind) is { } problem) throw RequestException.BadRequest(problem);
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
