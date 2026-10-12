using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Incoming webhooks: admins make a secret URL for a text channel, and anything that can POST JSON to it can post
/// messages there (see <see cref="WebhookIngress"/>). The secret is shown once and only its hash is stored.
/// </summary>
public static class WebhookFeature
{
    public const int MaxPerChannel = 15;
    /// <summary>Webhook messages have this author prefix, which can never be an account key (no ':' in base64url).</summary>
    public const string AuthorPrefix = "webhook:";

    public static void Register(Router router)
    {
        router.Add("webhook.list", List);
        router.Add("webhook.create", Create);
        router.Add("webhook.update", Update);
        router.Add("webhook.regenerate", Regenerate);
        router.Add("webhook.delete", Delete);
    }

    public static string HashSecret(string secret) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret)));

    /// <summary>Constant-time check of a presented secret against the stored hash.</summary>
    public static bool SecretMatches(Webhook hook, string secret) =>
        secret.Length <= 128 && CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(HashSecret(secret)), Encoding.ASCII.GetBytes(hook.SecretHash));

    public static string PathFor(Webhook hook, string secret) => $"/hooks/{hook.Id}/{secret}";

    public static object View(Store store, Webhook w) => new
    {
        id = w.Id,
        channelId = w.ChannelId,
        name = w.Name,
        avatar = w.Avatar is null ? null : store.GetFile(w.Avatar) is { } f ? Uploads.Public(f) : null,
        mentions = w.Mentions,
        createdBy = w.CreatedBy,
        createdAt = w.CreatedAt,
        lastUsedAt = w.LastUsedAt,
    };

    /// <summary>The <c>webhook</c> part of a message: who posted it and its embeds. Null for everyone else's messages.</summary>
    public static object? MessageView(Store store, Message m)
    {
        if (!m.AuthorKey.StartsWith(AuthorPrefix, StringComparison.Ordinal)) return null;
        var post = store.GetWebhookPost(m.Id);
        if (post is null) return null;
        var avatar = post.Avatar is null ? null : store.GetFile(post.Avatar);
        JsonElement embeds;
        using (var doc = JsonDocument.Parse(post.Embeds ?? "[]")) embeds = doc.RootElement.Clone();
        return new { id = post.WebhookId, name = post.Name, avatar = avatar is null ? null : Uploads.Public(avatar), embeds };
    }

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageWebhooks)) throw RequestException.Forbidden("You can't manage webhooks on this server.");
    }

    private static Channel TextChannel(Session s, Member me, long id)
    {
        var channel = ChatFeature.ReadableChannel(s, me, id);
        if (channel.Kind != "text") throw RequestException.BadRequest("Webhooks can only post in text channels.");
        E2eeChannelFeature.RefusePlaintext(s.World.Store, channel, "Webhooks");
        return channel;
    }

    /// <summary>The webhook, if it's in a channel you can read (otherwise it doesn't exist for you).</summary>
    private static Webhook Find(Session s, Member me, Body body)
    {
        var hook = s.World.Store.GetWebhook(body.String("id", 64)) ?? throw RequestException.NotFound("Webhook");
        var channel = s.World.Store.GetChannel(hook.ChannelId);
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Webhook");
        return hook;
    }

    private static string Name(Body body) =>
        Names.Normalize(body.String("name", 256))
        ?? throw RequestException.BadRequest($"Names must be 1–{Names.MaxLength} characters, with no invisible characters.");

    /// <summary>An avatar must be an image you uploaded yourself. Empty string means none.</summary>
    private static string? Avatar(Session s, Member me, string fileId)
    {
        if (fileId.Length == 0) return null;
        var file = s.World.Store.GetFile(fileId);
        if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown avatar file.");
        ProfileFeature.CheckAvatarImage(file);
        return file.Id;
    }

    private static (string Secret, string Hash) NewSecret()
    {
        var secret = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32));
        return (secret, HashSecret(secret));
    }

    private static object List(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var channelId = body.OptionalLong("channelId");
        if (channelId is { } id) TextChannel(s, me, id);
        var readable = s.World.Store.AllChannels().Where(c => Permissions.CanRead(me, c)).Select(c => c.Id).ToHashSet();
        var hooks = s.World.Store.Webhooks(channelId).Where(w => readable.Contains(w.ChannelId));
        return new { webhooks = hooks.Select(w => View(s.World.Store, w)) };
    }

    private static object Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var channel = TextChannel(s, me, body.Long("channelId"));
        var name = Name(body);
        var avatar = body.OptionalString("avatar", 64) is { } fileId ? Avatar(s, me, fileId) : null;
        if (s.World.Store.CountWebhooks(channel.Id) >= MaxPerChannel)
            throw RequestException.BadRequest($"A channel can have at most {MaxPerChannel} webhooks.");

        var (secret, hash) = NewSecret();
        var hook = new Webhook(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), channel.Id, name, avatar, hash,
            body.OptionalBool("mentions") ?? false, me.AccountKey, s.Now, null);
        s.World.Store.AddWebhook(hook);
        Audit.Record(s, "webhook.create", details: new { id = hook.Id, name = hook.Name, channelId = hook.ChannelId });
        return new { webhook = View(s.World.Store, hook), secret, path = PathFor(hook, secret) };
    }

    private static object Update(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var hook = Find(s, me, body);
        if (body.OptionalString("name", 256) is not null) hook = hook with { Name = Name(body) };
        if (body.OptionalString("avatar", 64) is { } fileId) hook = hook with { Avatar = Avatar(s, me, fileId) };
        if (body.OptionalBool("mentions") is { } mentions) hook = hook with { Mentions = mentions };
        if (body.OptionalLong("channelId") is { } channelId)
        {
            var channel = TextChannel(s, me, channelId);
            if (channel.Id != hook.ChannelId && s.World.Store.CountWebhooks(channel.Id) >= MaxPerChannel)
                throw RequestException.BadRequest($"A channel can have at most {MaxPerChannel} webhooks.");
            hook = hook with { ChannelId = channel.Id };
        }
        s.World.Store.UpdateWebhook(hook);
        Audit.Record(s, "webhook.update", details: new { id = hook.Id, name = hook.Name, channelId = hook.ChannelId, mentions = hook.Mentions });
        return new { webhook = View(s.World.Store, hook) };
    }

    /// <summary>A new secret; the old URL stops working at once.</summary>
    private static object Regenerate(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var (secret, hash) = NewSecret();
        var hook = Find(s, me, body) with { SecretHash = hash };
        s.World.Store.UpdateWebhook(hook);
        Audit.Record(s, "webhook.regenerate", details: new { id = hook.Id, name = hook.Name, channelId = hook.ChannelId });
        return new { webhook = View(s.World.Store, hook), secret, path = PathFor(hook, secret) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var hook = Find(s, me, body);
        s.World.Store.DeleteWebhook(hook.Id);
        Audit.Record(s, "webhook.delete", details: new { id = hook.Id, name = hook.Name, channelId = hook.ChannelId });
        return null;
    }
}
