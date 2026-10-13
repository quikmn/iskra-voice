using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Outgoing webhooks, the requests: admins who manage webhooks pick events and an address (see <see cref="OutgoingWebhooks"/>
/// for sending). Only the owner may let a webhook reach their own network. Every member can see where their server sends
/// things (<c>outhook.hosts</c>, for "Who Iskra talks to").
/// </summary>
public static class OutgoingWebhookFeature
{
    public const int MaxHooks = 10;
    public const int MaxChannels = 50;
    public const int MaxUrlLength = 512;

    public static void Register(Router router)
    {
        router.Add("outhook.list", List);
        router.AddAsync("outhook.create", Create);
        router.AddAsync("outhook.update", Update);
        router.Add("outhook.regenerate", Regenerate);
        router.Add("outhook.delete", Delete);
        router.Add("outhook.log", Log);
        router.AddAsync("outhook.test", Test);
        router.Add("outhook.hosts", Hosts);
    }

    public static object View(OutgoingWebhook h) => new
    {
        id = h.Id,
        name = h.Name,
        url = h.Url,
        host = new Uri(h.Url).Host,
        events = h.Events,
        channelIds = h.ChannelIds,
        allowLocal = h.AllowLocal,
        enabled = h.Enabled,
        disabledReason = h.DisabledReason,
        failures = h.Failures,
        createdBy = h.CreatedBy,
        createdAt = h.CreatedAt,
        lastDeliveryAt = h.LastDeliveryAt,
        lastOutcome = h.LastOutcome,
    };

    private static object DeliveryView(OutgoingDelivery d) =>
        new { delivery = d.Delivery, @event = d.Event, attempt = d.Attempt, at = d.At, status = d.Status, outcome = d.Outcome, ms = d.Ms };

    private static void RequireAdmin(Member me)
    {
        if (!Permissions.Has(me, Perm.ManageWebhooks)) throw RequestException.Forbidden("You can't manage webhooks on this server.", "manage_webhooks");
    }

    private static OutgoingWebhooks Sender(Session s) =>
        s.Hub.Outhooks ?? throw new RequestException("unavailable", "Outgoing webhooks aren't running on this server.");

    /// <summary>
    /// A webhook whose channels you can all read; others don't exist for you, so nobody can point a webhook that sends
    /// a channel they can't read at their own address.
    /// </summary>
    private static bool Visible(Session s, Member me, OutgoingWebhook hook) =>
        hook.ChannelIds.Select(s.World.Store.GetChannel).OfType<Channel>().All(c => Permissions.CanRead(me, c));

    private static OutgoingWebhook Find(Session s, Member me, Body body) =>
        s.World.Store.GetOutgoingWebhook(body.String("id", 64)) is { } hook && Visible(s, me, hook) ? hook : throw RequestException.NotFound("Webhook");

    private static string Name(Body body) =>
        Names.Normalize(body.String("name", 256))
        ?? throw RequestException.BadRequest($"Names must be 1–{Names.MaxLength} characters, with no invisible characters.", "name_length", new { max = Names.MaxLength });

    private static string[] Events(Body body)
    {
        var events = body.OptionalStringArray("events", OutgoingWebhooks.EventTypes.Length, 32).Distinct().ToArray();
        if (events.Length == 0 || events.Any(e => !OutgoingWebhooks.EventTypes.Contains(e)))
            throw RequestException.BadRequest("Pick at least one event.", "outhook_events");
        return events;
    }

    /// <summary>Channels you can read, not end-to-end encrypted, where messages are written.</summary>
    private static long[] Channels(Session s, Member me, Body body)
    {
        if (body.OptionalElement("channelIds") is not { } element) return [];
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxChannels)
            throw RequestException.BadRequest($"'channelIds' must be a list of at most {MaxChannels} channel ids.");
        var ids = new List<long>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var id)) throw RequestException.BadRequest("'channelIds' must be channel ids.");
            var channel = ChatFeature.ReadableChannel(s, me, id);
            if (channel.Kind is not ("text" or "voice" or "stage" or "forum"))
                throw RequestException.BadRequest("Pick text, voice, stage or forum channels.", "outhook_channel_kind");
            E2eeChannelFeature.RefusePlaintext(s.World.Store, channel, "Outgoing webhooks");
            if (!ids.Contains(id)) ids.Add(id);
        }
        return [.. ids];
    }

    private static void RequireChannels(string[] events, long[] channels)
    {
        if (channels.Length == 0 && events.Any(e => e is "message.created" or "reaction.added"))
            throw RequestException.BadRequest("Pick the channels to send messages and reactions from.", "outhook_channels");
    }

    /// <summary>Only the owner can let a webhook reach their own network (the server's LAN, loopback, Tailscale).</summary>
    private static void CheckAllowLocal(Member me, bool allowLocal)
    {
        if (allowLocal && me.Role != Roles.Owner)
            throw RequestException.Forbidden("Only the owner can allow addresses on their own network.", "outhook_local_owner");
    }

    private static object List(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        return new { hooks = s.World.Store.OutgoingWebhooks().Where(h => Visible(s, me, h)).Select(View) };
    }

    private static async Task<object?> Create(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var name = Name(body);
        var events = Events(body);
        var channels = Channels(s, me, body);
        RequireChannels(events, channels);
        var allowLocal = body.OptionalBool("allowLocal") ?? false;
        CheckAllowLocal(me, allowLocal);
        var url = body.String("url", MaxUrlLength);
        var sender = Sender(s);
        var uri = await OutgoingWebhooks.CheckUrlAsync(url, allowLocal, CancellationToken.None);
        if (s.World.Store.CountOutgoingWebhooks() >= MaxHooks)
            throw RequestException.BadRequest($"A server can have at most {MaxHooks} outgoing webhooks.", "outhooks_max", new { max = MaxHooks });

        var secret = OutgoingWebhooks.NewSecret();
        var hook = new OutgoingWebhook(Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)), name, uri.AbsoluteUri, events, channels, secret,
            allowLocal, true, 0, null, me.AccountKey, s.Now, null, null);
        s.World.Store.AddOutgoingWebhook(hook);
        sender.Changed();
        Audit.Record(s, "outhook.create", details: new { id = hook.Id, name, host = uri.Host, events, allowLocal });
        return new { hook = View(hook), secret };
    }

    private static async Task<object?> Update(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var hook = Find(s, me, body);
        var sender = Sender(s);
        // Everything from the body before the first await.
        if (body.Has("name")) hook = hook with { Name = Name(body) };
        if (body.Has("events")) hook = hook with { Events = Events(body) };
        if (body.Has("channelIds")) hook = hook with { ChannelIds = Channels(s, me, body) };
        RequireChannels(hook.Events, hook.ChannelIds);
        var allowLocal = body.OptionalBool("allowLocal");
        var url = body.OptionalString("url", MaxUrlLength)?.Trim();
        var enabled = body.OptionalBool("enabled");

        if (allowLocal is { } local)
        {
            if (local != hook.AllowLocal) CheckAllowLocal(me, local);
            hook = hook with { AllowLocal = local };
        }
        if (url is not null && url != hook.Url)
        {
            // A new address loses the owner's permission for the local network, unless the owner sets it.
            if (hook.AllowLocal && me.Role != Roles.Owner) hook = hook with { AllowLocal = false };
            hook = hook with { Url = (await OutgoingWebhooks.CheckUrlAsync(url, hook.AllowLocal, CancellationToken.None)).AbsoluteUri };
        }
        else if (allowLocal is not null) await OutgoingWebhooks.CheckUrlAsync(hook.Url, hook.AllowLocal, CancellationToken.None);
        if (enabled is { } on) hook = hook with { Enabled = on };

        s.World.Store.UpdateOutgoingWebhook(hook);
        sender.Changed();
        hook = s.World.Store.GetOutgoingWebhook(hook.Id)!;
        Audit.Record(s, "outhook.update", details: new
        {
            id = hook.Id, name = hook.Name, host = new Uri(hook.Url).Host, events = hook.Events, allowLocal = hook.AllowLocal, enabled = hook.Enabled,
        });
        return new { hook = View(hook) };
    }

    /// <summary>A new signing secret; the old one stops working at once.</summary>
    private static object Regenerate(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var secret = OutgoingWebhooks.NewSecret();
        var hook = Find(s, me, body) with { Secret = secret };
        s.World.Store.UpdateOutgoingWebhook(hook);
        Sender(s).Changed();
        Audit.Record(s, "outhook.regenerate", details: new { id = hook.Id, name = hook.Name });
        return new { hook = View(hook), secret };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var hook = Find(s, me, body);
        s.World.Store.DeleteOutgoingWebhook(hook.Id);
        Sender(s).Changed();
        Audit.Record(s, "outhook.delete", details: new { id = hook.Id, name = hook.Name, host = new Uri(hook.Url).Host });
        return null;
    }

    private static object Log(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var hook = Find(s, me, body);
        return new { deliveries = s.World.Store.OutgoingLog(hook.Id).Select(DeliveryView) };
    }

    private static async Task<object?> Test(Session s, Member me, Body body)
    {
        RequireAdmin(me);
        var hook = Find(s, me, body);
        return new { delivery = DeliveryView(await Sender(s).TestAsync(hook)) };
    }

    /// <summary>Where this server sends things, for every member: the host and the events, never the full address.</summary>
    private static object Hosts(Session s, Member me, Body body) => new
    {
        hooks = s.World.Store.OutgoingWebhooks().Where(h => h.Enabled)
            .Select(h => new { name = h.Name, host = new Uri(h.Url).Host, events = h.Events }),
    };
}
