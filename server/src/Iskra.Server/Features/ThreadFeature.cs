using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Threads: side conversations started from a message. A thread is a channel of kind "thread" under its parent,
/// so chat.send/history/edit/delete/react/typing/pin all take a thread id as their channelId.
/// Who can read and write always follows the parent channel.
/// </summary>
public static class ThreadFeature
{
    public const int MaxNameLength = 100;
    public const int MaxThreadsPerChannel = 1000;
    public const int MaxList = 100;

    public static void Register(Router router)
    {
        router.Add("thread.create", Create);
        router.Add("thread.get", Get);
        router.Add("thread.list", List);
        router.Add("thread.update", Update);
        router.Add("thread.delete", Delete);
    }

    public static object View(ThreadInfo t) => new
    {
        id = t.Id,
        channelId = t.ParentId,
        rootId = t.RootId,
        name = t.Name,
        createdBy = t.CreatedBy,
        createdAt = t.CreatedAt,
        messageCount = t.MessageCount,
        lastMessageAt = t.LastMessageAt,
    };

    /// <summary>The thread started from this message, for the "N replies" line under it.</summary>
    public static object? Summary(Store store, long messageId) => store.ThreadForRoot(messageId) is { } t ? View(t) : null;

    /// <summary>After a message is posted or deleted in a thread: its counts changed.</summary>
    public static void Touched(Session s, Channel channel)
    {
        if (channel.Kind != "thread" || s.World.Store.GetThread(channel.Id) is not { } thread) return;
        Broadcast(s, thread);
    }

    private static void Broadcast(Session s, ThreadInfo thread)
    {
        if (s.World.Store.GetChannel(thread.ParentId) is { } parent)
            s.Hub.BroadcastToReaders(parent, Frames.Event("thread.updated", new { thread = View(thread) }));
    }

    private static string ThreadName(Body body) =>
        Text.Normalize(body.String("name", MaxNameLength * 2), MaxNameLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Thread names must be 1–{MaxNameLength} characters.");

    /// <summary>A thread the member can read; anything else is not found.</summary>
    private static (ThreadInfo Thread, Channel Channel) ReadableThread(Session s, Member me, long id)
    {
        var thread = s.World.Store.GetThread(id) ?? throw RequestException.NotFound("Thread");
        var channel = s.World.Store.GetChannel(id);
        if (channel is null || !Permissions.CanRead(me, channel)) throw RequestException.NotFound("Thread");
        return (thread, channel);
    }

    private static object Create(Session s, Member me, Body body)
    {
        var root = s.World.Store.GetMessage(body.Long("messageId")) ?? throw RequestException.NotFound("Message");
        var channel = ChatFeature.ReadableChannel(s, me, root.ChannelId);
        if (channel.Kind != "text") throw RequestException.BadRequest("Threads can only be started from messages in a text channel.");
        if (!Permissions.CanWrite(me, channel)) throw RequestException.Forbidden("You can't start threads in this channel.");
        var name = ThreadName(body);
        if (s.World.Store.ThreadForRoot(root.Id) is not null) throw RequestException.BadRequest("That message already has a thread.");
        if (s.World.Store.ThreadCount(channel.Id) >= MaxThreadsPerChannel)
            throw RequestException.BadRequest("This channel has too many threads. Delete some old ones first.");
        if (!s.Hub.Limits.TryTake(me.AccountKey, "thread.create")) throw new RequestException("rate_limited", "Too many new threads. Try again in a minute.");

        var thread = s.World.Store.CreateThread(channel, root.Id, name, me.AccountKey, s.Now);
        Broadcast(s, thread);
        return new { thread = View(thread) };
    }

    private static object Get(Session s, Member me, Body body)
    {
        var (thread, _) = ReadableThread(s, me, body.Long("id"));
        var root = s.World.Store.GetMessage(thread.RootId);
        return new { thread = View(thread), root = root is null ? null : MessageViews.Public(s.World.Store, root) };
    }

    private static object List(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind != "text") return new { threads = Array.Empty<object>() };
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxList) ?? MaxList);
        return new { threads = s.World.Store.Threads(channel.Id, limit).Select(View) };
    }

    private static void RequireManager(Session s, Member me, ThreadInfo thread)
    {
        if (!Permissions.CanManageThread(me, thread.CreatedBy, s.World.Store.GetMember(thread.CreatedBy)))
            throw RequestException.Forbidden("Only whoever started this thread, or an admin, can change it.");
    }

    private static object Update(Session s, Member me, Body body)
    {
        var (thread, _) = ReadableThread(s, me, body.Long("id"));
        RequireManager(s, me, thread);
        var name = ThreadName(body);
        s.World.Store.RenameThread(thread.Id, name);
        var updated = thread with { Name = name };
        Broadcast(s, updated);
        return new { thread = View(updated) };
    }

    private static object? Delete(Session s, Member me, Body body)
    {
        var (thread, _) = ReadableThread(s, me, body.Long("id"));
        RequireManager(s, me, thread);
        var parent = s.World.Store.GetChannel(thread.ParentId);
        if (thread.CreatedBy != me.AccountKey)
            Audit.Record(s, "thread.delete", thread.CreatedBy,
                details: new { channelId = thread.ParentId, channelName = parent?.Name, threadId = thread.Id, name = thread.Name });
        s.World.Store.DeleteChannel(thread.Id);
        if (parent is not null)
        {
            s.Hub.BroadcastToReaders(parent, Frames.Event("thread.deleted",
                new { id = thread.Id, channelId = thread.ParentId, rootId = thread.RootId }));
        }
        return null;
    }
}
