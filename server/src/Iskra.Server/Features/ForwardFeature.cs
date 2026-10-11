using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Forwarding a message (text and attachments) to another channel on this server. The copy says where it came
/// from only when everyone who can read it could also read the source, so a private channel's name never leaks.
/// (Forwards into DMs are re-encrypted by the client like any DM.)
/// </summary>
public static class ForwardFeature
{
    public static void Register(Router router) => router.Add("chat.forward", Forward);

    private static object Forward(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var source = store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Message");
        var from = ChatFeature.ReadableChannel(s, me, source.ChannelId);
        if (store.GetPoll(source.Id) is not null) throw RequestException.BadRequest("Polls can't be forwarded.");
        if (source.Text.Length == 0 && source.Attachments.Length == 0) throw RequestException.BadRequest("There's nothing to forward in that message.");

        var target = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (target.Kind is not ("text" or "thread")) throw RequestException.BadRequest("You can't send messages to that channel.");
        if (!Permissions.CanWrite(me, target)) throw RequestException.Forbidden("You can't send messages in this channel.");

        AutoModFeature.Check(s, me, target, source.Text, "message");
        var message = store.AddMessage(target.Id, me.AccountKey, source.Text, s.Now, source.Attachments);
        // A forward of a forward points at the original.
        var info = store.GetForward(source.Id) ?? new ForwardInfo(from.Id, source.Id, source.CreatedAt);
        store.AddForward(message.Id, info);

        var view = MessageViews.Public(store, message);
        s.Hub.BroadcastToReaders(target, Frames.Event("chat.message", new { message = view }));
        ThreadFeature.Touched(s, target);
        s.Push.ChatMessage(target, message, pings: false); // forwarding doesn't ping the people mentioned in it again
        return new { message = view };
    }

    /// <summary>
    /// The message's "Forwarded from" line, or null. The source is named (and linked) only if its channel still exists
    /// and anyone who can read this message's channel can read it too; otherwise it's just "Forwarded".
    /// </summary>
    public static object? View(Store store, Message m)
    {
        if (store.GetForward(m.Id) is not { } info) return null;
        var source = store.GetChannel(info.SourceChannelId);
        var here = store.GetChannel(m.ChannelId);
        var visible = source is not null && here is not null && Roles.Rank(source.ReadRole) <= Roles.Rank(here.ReadRole);
        if (!visible) return new { channelId = (long?)null, channelName = (string?)null, messageId = (long?)null, createdAt = info.SourceCreatedAt };
        // A thread is named by its channel.
        var named = source!.Kind == "thread" && store.GetThread(source.Id) is { } t ? store.GetChannel(t.ParentId) ?? source : source;
        return new { channelId = (long?)source.Id, channelName = (string?)named.Name, messageId = (long?)info.SourceMessageId, createdAt = info.SourceCreatedAt };
    }
}
