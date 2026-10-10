using System.Net;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Lib.Net.Http.WebPush;
using Lib.Net.Http.WebPush.Authentication;

namespace Iskra.Server.Push;

public enum PushOutcome { Delivered, Gone, Failed }

/// <summary>One push to one device.</summary>
public sealed record PushDelivery(string Endpoint, string P256dh, string Auth, string Payload, string Topic, bool Urgent, int TtlSeconds);

/// <summary>Delivers an encrypted push. Tests swap in a fake.</summary>
public interface IPushSender
{
    Task<PushOutcome> SendAsync(PushDelivery delivery, CancellationToken cancel);
}

/// <summary>
/// Web Push via Lib.Net.Http.WebPush (RFC 8291 aes128gcm payload encryption, RFC 8292 VAPID). Connections only go to
/// public addresses, with the same guard as link previews, on top of the push-service allowlist checked at subscribe time.
/// </summary>
public sealed class WebPushSender : IPushSender, IDisposable
{
    private readonly HttpClient _http;
    private readonly PushServiceClient _client;

    public WebPushSender(World world, VapidKeys keys, IConfiguration config)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            UseCookies = false,
            ConnectCallback = LinkPreviews.PublicOnlyConnect(config.GetValue<bool>("Push:AllowLoopbackForTests")),
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
        _client = new PushServiceClient(_http)
        {
            DefaultAuthentication = new VapidAuthentication(keys.PublicKey, keys.PrivateKey) { Subject = Subject(world) },
            AutoRetryAfter = false,
        };
    }

    /// <summary>Contact for push service operators: the web app's address (it must be https or mailto).</summary>
    private static string Subject(World world) =>
        world.Settings.AppUrl.StartsWith("https://", StringComparison.Ordinal) ? world.Settings.AppUrl : "https://iskra.foo";

    public async Task<PushOutcome> SendAsync(PushDelivery d, CancellationToken cancel)
    {
        var subscription = new PushSubscription { Endpoint = d.Endpoint };
        subscription.SetKey(PushEncryptionKeyName.P256DH, d.P256dh);
        subscription.SetKey(PushEncryptionKeyName.Auth, d.Auth);
        var message = new PushMessage(d.Payload)
        {
            Topic = d.Topic,
            TimeToLive = d.TtlSeconds,
            Urgency = d.Urgent ? PushMessageUrgency.High : PushMessageUrgency.Normal,
        };
        try
        {
            await _client.RequestPushMessageDeliveryAsync(subscription, message, cancel);
            return PushOutcome.Delivered;
        }
        catch (PushServiceClientException e) when (e.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
        {
            return PushOutcome.Gone;
        }
    }

    public void Dispose() => _http.Dispose();
}
