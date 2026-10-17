using System.Text.RegularExpressions;
using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The mention inbox: every channel message that pinged you (a mention, a reply to you, one of your roles, @everyone or
/// @here, or one of the alert words you asked this server to watch for), kept for a while so apps can list them across reconnects. Only what you can still read is listed.
/// </summary>
public static partial class InboxFeature
{
    public const int MaxPage = 50;
    /// <summary>Items kept per account (the oldest go first) and for how long.</summary>
    public const int MaxItems = 500;
    public static readonly TimeSpan Retention = TimeSpan.FromDays(60);

    /// <summary>Kinds, strongest first: a message that both mentions and replies to you is a mention.</summary>
    public static readonly string[] Kinds = ["mention", "reply", "role", "everyone", "keyword", "follow"];

    [GeneratedRegex("<@([A-Za-z0-9_-]{43})>")]
    private static partial Regex MentionToken();

    [GeneratedRegex("<@&([0-9]{1,12})>")]
    private static partial Regex RoleMention();

    [GeneratedRegex(@"(^|\s)@(everyone|here)\b")]
    private static partial Regex GroupMention();

    public static void Register(Router router) => router.Add("inbox.list", List);

    public static object View(Store store, InboxItem item, Message message) =>
        new { kind = item.Kind, channelId = item.ChannelId, at = item.CreatedAt, message = MessageViews.Public(store, message) };

    /// <summary>
    /// After a new message is stored: who it pings, by the same rules as push notifications (@everyone, @here and roles
    /// only count from people allowed to ping them). Each gets an item and an <c>inbox.new</c> event.
    /// </summary>
    public static void Record(Session s, Channel channel, Message message)
    {
        var store = s.World.Store;
        if (store.GetMember(message.AuthorKey) is not { } author) return;
        var kinds = new Dictionary<string, string>(StringComparer.Ordinal);
        void Add(string key, string kind)
        {
            if (!kinds.TryGetValue(key, out var current) || Array.IndexOf(Kinds, kind) < Array.IndexOf(Kinds, current)) kinds[key] = kind;
        }

        var groups = GroupMention().Matches(message.Text).Select(m => m.Groups[2].Value).ToHashSet();
        if (groups.Count > 0 && PushService.CanPingGroups(author))
            foreach (var member in store.AllMembers())
                if (groups.Contains("everyone") || PresenceFeature.Of(store, s.Hub, member.AccountKey, s.Now).Online) Add(member.AccountKey, "everyone");
        foreach (Match m in RoleMention().Matches(message.Text))
        {
            if (!long.TryParse(m.Groups[1].Value, out var roleId) || store.GetRole(roleId) is not { } role) continue;
            if (!role.Mentionable && !PushService.CanPingGroups(author)) continue;
            foreach (var key in store.MembersWithRole(roleId)) Add(key, "role");
        }
        if (message.ReplyTo is { } replyId && store.GetMessage(replyId) is { } original) Add(original.AuthorKey, "reply");
        foreach (Match m in MentionToken().Matches(message.Text)) Add(m.Groups[1].Value, "mention");
        foreach (var key in AlertFeature.KeywordTargets(store, channel, message)) Add(key, "keyword"); // alert words stored here
        foreach (var key in AlertFeature.FollowTargets(store, channel, message)) Add(key, "follow");
        kinds.Remove(message.AuthorKey);

        var targets = kinds.Where(k => store.GetMember(k.Key) is { } target && Permissions.CanRead(target, channel)
            && !store.IsBot(k.Key) && !store.EitherBlocked(k.Key, author.AccountKey)).Select(k => (k.Key, k.Value)).ToList();
        if (targets.Count == 0) return;
        store.AddInboxItems(message.Id, channel.Id, s.Now, targets);
        var view = MessageViews.Public(store, message);
        foreach (var (key, kind) in targets)
            s.Hub.SendToAccount(key, Frames.Event("inbox.new", new { item = new { kind, channelId = channel.Id, at = s.Now, message = view } }));
    }

    private static object List(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var limit = (int)(body.OptionalLong("limit", 1, MaxPage) ?? 30);
        var items = store.InboxItems(me.AccountKey, body.OptionalLong("before", 1), limit);
        var visible = new List<object>();
        foreach (var item in items)
        {
            if (store.GetMessage(item.MessageId) is not { } message || store.GetChannel(message.ChannelId) is not { } channel) continue;
            if (!Permissions.CanRead(me, channel) || store.EitherBlocked(me.AccountKey, message.AuthorKey)) continue;
            visible.Add(View(store, item, message));
        }
        return new { items = visible, hasMore = items.Count == limit, next = items.Count > 0 ? items[^1].MessageId : (long?)null };
    }
}
