using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>Pinned messages: up to <see cref="MaxPins"/> per channel or thread, pinned by trusted+ writers.</summary>
public static class PinFeature
{
    public const int MaxPins = 50;

    public static void Register(Router router)
    {
        router.Add("chat.pin", SetPin);
        router.Add("pin.list", List);
    }

    private static object? SetPin(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        var channel = ChatFeature.ReadableChannel(s, me, message.ChannelId);
        if (!Permissions.CanPin(me, channel)) throw RequestException.Forbidden("Only trusted members who can write here can pin messages.");
        var on = body.OptionalBool("on") ?? true;

        bool changed;
        if (on)
        {
            if (!s.World.Store.IsPinned(message.Id) && s.World.Store.PinCount(channel.Id) >= MaxPins)
                throw RequestException.BadRequest($"This channel already has {MaxPins} pins. Unpin one first.");
            changed = s.World.Store.AddPin(message.Id, channel.Id, me.AccountKey, s.Now);
        }
        else
        {
            changed = s.World.Store.RemovePin(message.Id);
        }
        if (changed)
        {
            s.Hub.BroadcastToReaders(channel, Frames.Event("chat.pinned",
                new { id = message.Id, channelId = channel.Id, on, by = me.AccountKey, at = s.Now }));
        }
        return null;
    }

    private static object List(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        var pins = s.World.Store.Pins(channel.Id)
            .Select(p => (Pin: p, Message: s.World.Store.GetMessage(p.MessageId)))
            .Where(x => x.Message is not null)
            .Select(x => new { message = MessageViews.Public(s.World.Store, x.Message!), pinnedBy = x.Pin.PinnedBy, pinnedAt = x.Pin.PinnedAt });
        return new { pins };
    }
}
