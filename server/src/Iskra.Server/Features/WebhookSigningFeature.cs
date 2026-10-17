using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The signing secret of an incoming webhook: the shared secret GitHub, Gitea or GitLab sign their posts with, so a
/// leaked URL alone can't post through the vendor formats (see <see cref="WebhookIngress"/>). Set by an admin who
/// manages the webhook; never shown again.
/// </summary>
public static class WebhookSigningFeature
{
    public const int MinLength = 16, MaxLength = 256;

    public static void Register(Router router) => router.Add("webhook.signing.set", Set);

    private static object Set(Session s, Member me, Body body)
    {
        WebhookFeature.RequireAdmin(me);
        var hook = WebhookFeature.Find(s, me, body);
        var raw = body.OptionalString("secret", MaxLength * 2) ?? "";
        string? secret = null;
        if (raw.Length > 0)
        {
            // Printable ASCII (GitHub's own example has spaces), not starting or ending with a space.
            if (raw.Length is < MinLength or > MaxLength || raw.Any(c => c is < ' ' or > '~') || raw.Trim().Length != raw.Length)
                throw RequestException.BadRequest($"A signing secret is {MinLength}–{MaxLength} letters, digits, symbols or spaces (not at the start or end).",
                    "webhook_signing_secret", new { min = MinLength, max = MaxLength });
            secret = raw;
        }
        s.World.Store.SetWebhookSigningSecret(hook.Id, secret);
        Audit.Record(s, "webhook.update", details: new { id = hook.Id, name = hook.Name, channelId = hook.ChannelId, signed = secret is not null });
        return new { webhook = WebhookFeature.View(s.World.Store, hook) };
    }
}
