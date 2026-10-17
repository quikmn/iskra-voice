using System.Globalization;
using System.Text.Json;
using Iskra.Server.Files;
using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Forum channels: posts with a title, a first message and tags, each with a thread of replies.
/// A post is a thread under the forum (so replies, reactions, typing, pins and unread counts work unchanged);
/// its first message is the thread's root, which lives in the forum channel itself.
/// </summary>
public static class ForumFeature
{
    public const int MaxTags = 20;
    public const int MaxTagsPerPost = 5;
    public const int MaxTagName = 20;
    public const int MaxPinnedPosts = 10;
    public const int MaxList = 50;
    public const int ExcerptLength = 300;

    public static void Register(Router router)
    {
        router.Add("forum.posts", List);
        router.Add("forum.post.create", Create);
        router.Add("forum.post.get", Get);
        router.Add("forum.post.update", Update);
        router.Add("forum.post.set", SetState);
        router.Add("forum.tags.set", SetTags);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    public static object TagView(ForumTag t) => new { id = t.Id, name = t.Name, emoji = t.Emoji };

    public static object View(Store store, ForumPost p)
    {
        var root = p.Root;
        var files = root?.Attachments.Select(store.GetFile).OfType<StoredFile>().ToList() ?? [];
        var image = files.FirstOrDefault(f => f.Type.StartsWith("image/", StringComparison.Ordinal) && f.Width is not null);
        return new
        {
            id = p.Id,
            channelId = p.Thread.ParentId,
            rootId = p.Thread.RootId,
            title = p.Thread.Name,
            author = p.Thread.CreatedBy,
            createdAt = p.Thread.CreatedAt,
            replyCount = p.Thread.MessageCount,
            lastMessageAt = p.Thread.LastMessageAt,
            lastActivity = p.LastActivity,
            lastAuthor = p.LastAuthor,
            tags = p.Tags,
            pinned = p.PinnedAt is not null,
            closed = p.Closed,
            locked = p.Locked,
            excerpt = root is null ? null : root.Text.Length <= ExcerptLength ? root.Text : root.Text[..ExcerptLength] + "…",
            image = image is null ? null : Uploads.Public(image),
            attachmentCount = files.Count,
        };
    }

    // ── Hooks from chat and threads ──────────────────────────────────────────

    /// <summary>Before a reply in a thread: closed and locked posts only take replies from moderators.</summary>
    public static void CheckReply(Session s, Member me, Channel channel)
    {
        if (channel.Kind != "thread" || s.World.Store.GetForumPost(channel.Id) is not { } post) return;
        if (!post.Closed && !post.Locked) return;
        var forum = s.World.Store.GetChannel(post.Thread.ParentId);
        if (forum is not null && Permissions.CanModerateForum(me, forum)) return;
        throw RequestException.Forbidden(post.Locked ? "This post is locked." : "This post is closed. Reopen it to reply.");
    }

    /// <summary>After an edit: a post's first message changed its excerpt.</summary>
    public static void Edited(Session s, Channel channel, Message message)
    {
        if (channel.Kind != "forum" || s.World.Store.PostForRoot(message.Id) is not { } id) return;
        if (s.World.Store.GetForumPost(id) is { } post) Broadcast(s, channel, post);
    }

    /// <summary>Deleting a post's first message deletes the post.</summary>
    public static void RootDeleted(Session s, Channel channel, long messageId)
    {
        if (channel.Kind != "forum" || s.World.Store.PostForRoot(messageId) is not { } id) return;
        s.World.Store.DeleteChannel(id);
        s.Hub.BroadcastToReaders(channel, Frames.Event("thread.deleted", new { id, channelId = channel.Id, rootId = messageId }));
    }

    /// <summary>Deleting a post (thread.delete) also deletes its first message.</summary>
    public static void ThreadDeleted(Session s, ThreadInfo thread, Channel? parent)
    {
        if (parent is not { Kind: "forum" } || s.World.Store.GetMessage(thread.RootId) is null) return;
        s.World.Store.DeleteMessage(thread.RootId);
        s.Hub.BroadcastToReaders(parent, Frames.Event("chat.deleted", new { id = thread.RootId, channelId = parent.Id }));
    }

    private static void Broadcast(Session s, Channel forum, ForumPost post) =>
        s.Hub.BroadcastToReaders(forum, Frames.Event("forum.post.updated", new { post = View(s.World.Store, post) }));

    // ── Lookups ──────────────────────────────────────────────────────────────

    private static Channel ReadableForum(Session s, Member me, long id)
    {
        var channel = ChatFeature.ReadableChannel(s, me, id);
        return channel.Kind == "forum" ? channel : throw RequestException.BadRequest("That isn't a forum channel.");
    }

    /// <summary>A post the member can read; anything else is not found.</summary>
    private static (ForumPost Post, Channel Forum) ReadablePost(Session s, Member me, long id)
    {
        var post = s.World.Store.GetForumPost(id) ?? throw RequestException.NotFound("Post");
        var forum = s.World.Store.GetChannel(post.Thread.ParentId);
        if (forum is null || !Permissions.CanRead(me, forum)) throw RequestException.NotFound("Post");
        return (post, forum);
    }

    private static string Title(string raw) =>
        Text.Normalize(raw, ThreadFeature.MaxNameLength, allowNewlines: false)
        ?? throw RequestException.BadRequest($"Titles must be 1–{ThreadFeature.MaxNameLength} characters.", "title_length", new { max = ThreadFeature.MaxNameLength });

    /// <summary>Tag ids for a post: distinct, from this forum, at most <see cref="MaxTagsPerPost"/>.</summary>
    private static long[] PostTags(Store store, Channel forum, Body body)
    {
        var element = body.Element("tags");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxTagsPerPost)
            throw RequestException.BadRequest($"A post can have up to {MaxTagsPerPost} tags.", "post_tags_max", new { max = MaxTagsPerPost });
        var known = store.ForumTags(forum.Id).Select(t => t.Id).ToHashSet();
        var tags = new List<long>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var id) || !known.Contains(id))
                throw RequestException.BadRequest("That tag doesn't exist in this forum.");
            if (!tags.Contains(id)) tags.Add(id);
        }
        return [.. tags];
    }

    /// <summary>Whether the body has a non-null field (for "leave it as it is" vs "set it").</summary>
    internal static bool HasField(Body body, string name)
    {
        try
        {
            body.Element(name);
            return true;
        }
        catch (RequestException)
        {
            return false;
        }
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    private static object List(Session s, Member me, Body body)
    {
        var forum = ReadableForum(s, me, body.Long("channelId"));
        var sort = body.OptionalString("sort", 16) ?? "activity";
        if (sort is not ("activity" or "newest")) throw RequestException.BadRequest("'sort' must be activity or newest.");
        var tag = body.OptionalLong("tag", min: 1);
        var terms = SearchFeature.Terms(body.OptionalString("query", SearchFeature.MaxQueryLength * 2));
        var cursor = Cursor.Parse(body.OptionalString("cursor", 64));
        var limit = (int)(body.OptionalLong("limit", min: 1, max: MaxList) ?? 25);

        var store = s.World.Store;
        IEnumerable<ForumPost> posts = store.ForumPosts(forum.Id);
        if (tag is { } tagId) posts = posts.Where(p => p.Tags.Contains(tagId));
        if (terms.Count > 0)
        {
            var all = posts.ToList();
            var matched = Matching(store, forum, all, terms);
            posts = all.Where(p => matched.Contains(p.Id));
        }
        var ordered = posts
            .Select(p => (Post: p, Key: Cursor.Of(p, sort)))
            .OrderByDescending(x => x.Key)
            .Where(x => cursor is null || x.Key.CompareTo(cursor.Value) < 0)
            .Take(limit + 1)
            .ToList();
        var page = ordered.Take(limit).ToList();
        return new
        {
            posts = page.Select(x => View(store, x.Post)),
            tags = store.ForumTags(forum.Id).Select(TagView),
            hasMore = ordered.Count > limit,
            cursor = page.Count > 0 && ordered.Count > limit ? page[^1].Key.ToString() : null,
        };
    }

    /// <summary>Posts whose title has every word (ignoring case and accents), or with a message that matches (full-text).</summary>
    private static HashSet<long> Matching(Store store, Channel forum, List<ForumPost> posts, List<string> terms)
    {
        var compare = CultureInfo.InvariantCulture.CompareInfo;
        const CompareOptions loose = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace;
        var matched = posts.Where(p => terms.All(t => compare.IndexOf(p.Thread.Name, t, loose) >= 0)).Select(p => p.Id).ToHashSet();
        var byRoot = posts.ToDictionary(p => p.Thread.RootId, p => p.Id);
        var ids = new List<long>(posts.Count + 1) { forum.Id };
        ids.AddRange(posts.Select(p => p.Id));
        var (hits, _) = store.Search(new SearchQuery(terms, ids, null, false, false, null, null, null, 1000));
        foreach (var hit in hits)
        {
            if (hit.Message.ChannelId == forum.Id) { if (byRoot.TryGetValue(hit.Message.Id, out var id)) matched.Add(id); }
            else matched.Add(hit.Message.ChannelId);
        }
        return matched;
    }

    private static object Create(Session s, Member me, Body body)
    {
        var forum = ReadableForum(s, me, body.Long("channelId"));
        if (!Permissions.CanWrite(me, forum)) throw RequestException.Forbidden("You can't post in this forum.", "forum_cant_post");
        var store = s.World.Store;
        var title = Title(body.String("title", ThreadFeature.MaxNameLength * 2));

        var attachments = body.OptionalStringArray("attachments", ChatFeature.MaxAttachments, 64);
        foreach (var id in attachments)
        {
            var file = store.GetFile(id);
            if (file is null || file.Uploader != me.AccountKey) throw RequestException.BadRequest("Unknown attachment.");
        }
        var rawText = body.OptionalString("text", ChatFeature.MaxMessageLength * 2) ?? "";
        var text = rawText.Trim().Length == 0 && attachments.Length > 0
            ? ""
            : Text.Normalize(rawText, ChatFeature.MaxMessageLength, allowNewlines: true)
              ?? throw RequestException.BadRequest($"The first message must be 1–{ChatFeature.MaxMessageLength} characters.", "first_message_length", new { max = ChatFeature.MaxMessageLength });
        var tags = HasField(body, "tags") ? PostTags(store, forum, body) : [];

        if (store.ThreadCount(forum.Id) >= ThreadFeature.MaxThreadsPerChannel)
            throw RequestException.BadRequest("This forum has too many posts. Delete some old ones first.", "forum_full");
        AutoModFeature.Check(s, me, forum, title + "\n" + text, "post");
        ModerationFeature.CheckSlowmode(s, me, forum);
        if (!s.Hub.Limits.TryTake(me.AccountKey, "thread.create")) throw new RequestException("rate_limited", "Too many new posts. Try again in a minute.", "too_many_posts");

        var thread = store.CreateForumPost(forum, me.AccountKey, title, text, attachments, tags, s.Now);
        var root = store.GetMessage(thread.RootId)!;
        var post = store.GetForumPost(thread.Id)!;
        var message = MessageViews.Public(store, root);
        s.Hub.BroadcastToReaders(forum, Frames.Event("chat.message", new { message }));
        s.Hub.BroadcastToReaders(forum, Frames.Event("thread.updated", new { thread = ThreadFeature.View(thread) }));
        Broadcast(s, forum, post);
        s.Push.ChatMessage(forum, root);
        s.Hub.Outhooks?.ThreadCreated(forum, thread);
        return new { post = View(store, post), message };
    }

    private static object Get(Session s, Member me, Body body)
    {
        var (post, _) = ReadablePost(s, me, body.Long("id"));
        return new { post = View(s.World.Store, post), root = post.Root is null ? null : MessageViews.Public(s.World.Store, post.Root) };
    }

    private static object Update(Session s, Member me, Body body)
    {
        var (post, forum) = ReadablePost(s, me, body.Long("id"));
        var store = s.World.Store;
        var isAuthor = Permissions.CanManageThread(me, post.Thread.CreatedBy, store.GetMember(post.Thread.CreatedBy));
        var title = body.OptionalString("title", ThreadFeature.MaxNameLength * 2) is { } raw ? Title(raw) : null;
        var retag = HasField(body, "tags");
        if (title is null && !retag) throw RequestException.BadRequest("Nothing to change.", "nothing_to_change");
        if (title is not null && !isAuthor) throw RequestException.Forbidden("Only whoever posted this, or an admin, can rename it.", "post_rename_owner");
        if (retag && !isAuthor && !Permissions.CanModerateForum(me, forum)) throw RequestException.Forbidden("You can't change this post's tags.", "post_tags");
        var tags = retag ? PostTags(store, forum, body) : null;
        if (title is not null) AutoModFeature.Check(s, me, forum, title, "post");

        if (title is not null) store.RenameThread(post.Id, title);
        if (tags is not null) store.SetPostTags(post.Id, tags);
        var updated = store.GetForumPost(post.Id)!;
        if (title is not null) s.Hub.BroadcastToReaders(forum, Frames.Event("thread.updated", new { thread = ThreadFeature.View(updated.Thread) }));
        Broadcast(s, forum, updated);
        return new { post = View(store, updated) };
    }

    /// <summary>Pin and lock: moderators. Close: the author too, unless a moderator locked the post.</summary>
    private static object SetState(Session s, Member me, Body body)
    {
        var (post, forum) = ReadablePost(s, me, body.Long("id"));
        var store = s.World.Store;
        var mod = Permissions.CanModerateForum(me, forum);
        var pinned = body.OptionalBool("pinned");
        var closed = body.OptionalBool("closed");
        var locked = body.OptionalBool("locked");
        if (pinned is null && closed is null && locked is null) throw RequestException.BadRequest("Nothing to change.", "nothing_to_change");
        if ((pinned is not null || locked is not null) && !mod) throw RequestException.Forbidden("Only moderators can pin or lock posts.", "mods_pin_posts");
        if (closed is not null && !mod && (post.Thread.CreatedBy != me.AccountKey || post.Locked))
            throw RequestException.Forbidden(post.Locked ? "A moderator locked this post." : "Only whoever posted this, or a moderator, can close it.");

        var pinnedAt = pinned switch { true => post.PinnedAt ?? s.Now, false => null, null => post.PinnedAt };
        if (pinnedAt is not null && post.PinnedAt is null && store.PinnedPostCount(forum.Id) >= MaxPinnedPosts)
            throw RequestException.BadRequest($"A forum can have up to {MaxPinnedPosts} pinned posts. Unpin one first.", "forum_pins_max", new { max = MaxPinnedPosts });
        store.SetPostState(post.Id, pinnedAt, closed ?? post.Closed, locked ?? post.Locked);
        var updated = store.GetForumPost(post.Id)!;
        Broadcast(s, forum, updated);
        return new { post = View(store, updated) };
    }

    private static object SetTags(Session s, Member me, Body body)
    {
        var forum = ReadableForum(s, me, body.Long("channelId"));
        if (!BaseRoles.Allows(me, BaseAbility.ForumTags)) throw RequestException.Forbidden("Only admins can change a forum's tags.", "admins_forum_tags");
        var element = body.Element("tags");
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > MaxTags)
            throw RequestException.BadRequest($"A forum can have up to {MaxTags} tags.", "forum_tags_max", new { max = MaxTags });
        var known = s.World.Store.ForumTags(forum.Id).Select(t => t.Id).ToHashSet();
        var tags = new List<(long? Id, string Name, string? Emoji)>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw RequestException.BadRequest("Each tag must be an object.");
            var tag = new Body(item);
            var id = tag.OptionalLong("id", min: 1);
            if (id is { } existing && !known.Contains(existing)) throw RequestException.BadRequest("That tag doesn't exist in this forum.");
            if (id is not null && tags.Any(t => t.Id == id)) throw RequestException.BadRequest("Each tag can only be listed once.");
            var name = Text.Normalize(tag.String("name", MaxTagName * 2), MaxTagName, allowNewlines: false)
                ?? throw RequestException.BadRequest($"Tag names must be 1–{MaxTagName} characters.", "tag_name", new { max = MaxTagName });
            if (tags.Any(t => string.Equals(t.Name, name, StringComparison.OrdinalIgnoreCase)))
                throw RequestException.BadRequest("Tag names must be different from each other.", "forum_tags_unique");
            var emoji = tag.OptionalString("emoji", 64) is { Length: > 0 } rawEmoji
                ? Text.Normalize(rawEmoji, 16, allowNewlines: false) is { } e && !e.Any(char.IsWhiteSpace)
                    ? e
                    : throw RequestException.BadRequest("That isn't a valid emoji.")
                : null;
            tags.Add((id, name, emoji));
        }
        var saved = s.World.Store.SetForumTags(forum.Id, tags).Select(TagView).ToList();
        s.Hub.BroadcastToReaders(forum, Frames.Event("forum.tags", new { channelId = forum.Id, tags = saved }));
        return new { tags = saved };
    }

    /// <summary>Where a post sits in the list: pinned first, then by the sort key, newest first. Also the paging cursor.</summary>
    internal readonly record struct Cursor(int Pinned, long Key, long Id) : IComparable<Cursor>
    {
        public static Cursor Of(ForumPost p, string sort) => p.PinnedAt is { } at
            ? new(1, at, p.Id)
            : new(0, sort == "newest" ? p.Thread.CreatedAt : p.LastActivity, p.Id);

        public int CompareTo(Cursor other) =>
            Pinned != other.Pinned ? Pinned.CompareTo(other.Pinned) : Key != other.Key ? Key.CompareTo(other.Key) : Id.CompareTo(other.Id);

        public override string ToString() => $"{Pinned}.{Key}.{Id}";

        public static Cursor? Parse(string? text)
        {
            if (text is null) return null;
            var parts = text.Split('.');
            if (parts.Length == 3 && int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var pinned) && pinned is 0 or 1
                && long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var key)
                && long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var id))
                return new Cursor(pinned, key, id);
            throw RequestException.BadRequest("That isn't a valid cursor.");
        }
    }
}
