using System.Collections.Concurrent;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// The second set of outgoing webhook events: voice joins and leaves, threads, member and role changes, channels, edits
/// and deletions. Channel-bound events follow the same channel rules as messages (never encrypted channels); channel
/// changes go out only for channels every member can read, or that the webhook lists.
/// </summary>
public sealed partial class OutgoingWebhooks
{
    // ── Voice ────────────────────────────────────────────────────────────────

    /// <summary>Who was in each voice channel when it last changed, to tell joins from leaves.</summary>
    private readonly ConcurrentDictionary<long, HashSet<string>> _voice = new();

    /// <summary>
    /// A voice channel's participants changed (or were published again): <c>voice.joined</c> for the new ones,
    /// <c>voice.left</c> for the ones gone. Only who and where; nothing about audio, mute or video.
    /// </summary>
    public void VoicePresence(long channelId, Channel? channel, IEnumerable<string> present)
    {
        var now = present.ToHashSet();
        var before = _voice.TryGetValue(channelId, out var b) ? b : [];
        if (now.Count == 0) _voice.TryRemove(channelId, out _);
        else _voice[channelId] = now;
        if (channel is null) return;
        var joined = now.Except(before).ToList();
        var left = before.Except(now).ToList();
        if (joined.Count + left.Count == 0 || !Hooks().Any(h => h.Events.Contains("voice.joined") || h.Events.Contains("voice.left"))) return;
        foreach (var key in joined) Emit("voice.joined", h => Watches(h, channel), () => new { channel = ChannelView(channel), member = Person(key) });
        foreach (var key in left) Emit("voice.left", h => Watches(h, channel), () => new { channel = ChannelView(channel), member = Person(key) });
    }

    // ── Threads and messages ─────────────────────────────────────────────────

    /// <summary>A thread started from a message, or a forum post.</summary>
    public void ThreadCreated(Channel parent, ThreadInfo thread) =>
        Emit("thread.created", h => Watches(h, parent), () => new
        {
            thread = new
            {
                id = thread.Id, name = thread.Name, rootId = thread.RootId, channel = ChannelView(parent),
                createdBy = Person(thread.CreatedBy), createdAt = thread.CreatedAt,
            },
        });

    public void MessageUpdated(Channel channel, Message message)
    {
        if (!Hooks().Any(h => h.Events.Contains("message.updated"))) return;
        Emit("message.updated", h => Watches(h, channel), () => new
        {
            message = new
            {
                id = message.Id, channel = ChannelView(channel), author = Person(message.AuthorKey), text = message.Text,
                createdAt = message.CreatedAt, editedAt = message.EditedAt,
            },
        });
    }

    /// <summary>Only which message was deleted, never what it said.</summary>
    public void MessageDeleted(Channel channel, long messageId) =>
        Emit("message.deleted", h => Watches(h, channel), () => new { messageId, channel = ChannelView(channel) });

    // ── Members and roles ────────────────────────────────────────────────────

    /// <param name="changes">What changed: <c>role</c> (built-in level), <c>roles</c> (custom roles) or <c>nick</c>.</param>
    public void MemberUpdated(string accountKey, params string[] changes)
    {
        if (!Hooks().Any(h => h.Events.Contains("member.updated"))) return;
        var store = _world.Store;
        if (store.GetMember(accountKey) is not { } m) return;
        Emit("member.updated", _ => true, () =>
        {
            var roles = store.AllRoles().ToDictionary(r => r.Id);
            return new
            {
                member = new
                {
                    accountKey, name = m.Name, nick = store.GetNickname(accountKey), role = m.Role, bot = store.IsBot(accountKey),
                    roles = m.RoleIds.Where(roles.ContainsKey).Select(id => new { id, name = roles[id].Name }),
                },
                changes,
            };
        });
    }

    /// <param name="type"><c>role.created</c>, <c>role.updated</c> or <c>role.deleted</c> (then only id and name).</param>
    public void RoleChanged(string type, CustomRole role) =>
        Emit(type, _ => true, () => new { role = type == "role.deleted" ? new { id = role.Id, name = role.Name } : RoleFeature.Public(role) });

    // ── Channels ─────────────────────────────────────────────────────────────

    /// <summary>Someone with the plain member level and no custom roles: what everyone on the server can see.</summary>
    private static readonly Member Everyone = new("", "", Roles.Member, 0);

    /// <summary>
    /// Channel changes reach a webhook for channels every member can read (or that it lists); never encrypted ones, so a
    /// manager can't learn about channels they couldn't otherwise send to an address.
    /// </summary>
    private bool SeesChannel(OutgoingWebhook hook, Channel channel) =>
        channel.Kind != "thread" && !E2eeChannelFeature.IsEncrypted(_world.Store, channel)
        && (hook.ChannelIds.Contains(channel.Id) || Permissions.CanRead(Everyone, channel));

    /// <param name="type"><c>channel.created</c>, <c>channel.updated</c> or <c>channel.deleted</c>. Call before a deletion.</param>
    /// <param name="changes">For updates: which fields changed (names only; a topic's text isn't sent).</param>
    public void ChannelChanged(string type, Channel channel, IEnumerable<string>? changes = null)
    {
        if (!Hooks().Any(h => h.Events.Contains(type))) return;
        var changed = changes?.ToArray();
        Emit(type, h => SeesChannel(h, channel), () => new
        {
            channel = new
            {
                id = channel.Id, name = channel.Name, kind = channel.Kind, categoryId = channel.CategoryId,
                readRole = channel.ReadRole, writeRole = channel.WriteRole,
            },
            changes = changed,
        });
    }
}
