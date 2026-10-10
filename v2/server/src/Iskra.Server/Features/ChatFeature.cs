using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

public static class ChatFeature
{
    public const int MaxMessageLength = 4000;
    public const int MaxHistory = 100;

    public static void Register(Router router)
    {
        router.Add("chat.send", Send);
        router.Add("chat.edit", Edit);
        router.Add("chat.delete", Delete);
        router.Add("chat.history", History);
        router.Add("chat.typing", Typing);
    }

    /// <summary>
    /// Channels the member can't read are reported as not found, so their existence doesn't leak.
    /// </summary>
    internal static Channel ReadableChannel(Session s, Member me, long id)
    {
        var channel = s.World.Store.GetChannel(id);
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Channel");
        return channel;
    }

    private static string MessageText(Body body) =>
        Text.Normalize(body.String("text", MaxMessageLength * 2), MaxMessageLength, allowNewlines: true)
        ?? throw RequestException.BadRequest($"Messages must be 1–{MaxMessageLength} characters.");

    private static object Send(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind != "text") throw RequestException.BadRequest("You can't send messages to that channel.");
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can't send messages in this channel.");

        var message = s.World.Store.AddMessage(channel.Id, me.AccountKey, MessageText(body), s.Now);
        var publicMessage = Hub.PublicMessage(message);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = publicMessage }));
        return new { message = publicMessage };
    }

    private static object Edit(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        var channel = ReadableChannel(s, me, message.ChannelId);
        if (message.AuthorKey != me.AccountKey) throw RequestException.Forbidden("You can only edit your own messages.");

        var text = MessageText(body);
        s.World.Store.EditMessage(message.Id, text, s.Now);
        var edited = Hub.PublicMessage(message with { Text = text, EditedAt = s.Now });
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.edited", new { message = edited }));
        return new { message = edited };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        var message = s.World.Store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        var channel = ReadableChannel(s, me, message.ChannelId);
        var author = s.World.Store.GetMember(message.AuthorKey);
        if (!Permissions.CanDeleteMessage(me, message, author)) throw RequestException.Forbidden();

        s.World.Store.DeleteMessage(message.Id);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.deleted", new { id = message.Id, channelId = channel.Id }));
        return null;
    }

    private static object History(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        var before = body.OptionalLong("before", min: 0);
        var after = body.OptionalLong("after", min: 0);
        if (before is not null && after is not null) throw RequestException.BadRequest("Use 'before' or 'after', not both.");
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxHistory) ?? 50);

        var messages = s.World.Store.History(channel.Id, before, after, limit);
        return new { messages = messages.Select(Hub.PublicMessage), hasMore = messages.Count == limit };
    }

    private static object? Typing(Session s, Member me, Body body)
    {
        var channel = ReadableChannel(s, me, body.Long("channelId"));
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden();

        var frame = Frames.Event("chat.typing", new { channelId = channel.Id, accountKey = me.AccountKey });
        foreach (var other in s.Hub.Sessions.Where(o => o.AccountKey != me.AccountKey))
        {
            var member = other.CurrentMember();
            if (member is not null && Permissions.CanRead(member, channel)) other.Send(frame);
        }
        return null;
    }
}
