using Iskra.Server.Protocol;
using Iskra.Server.Push;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;

namespace Iskra.Server.Features;

/// <summary>
/// Looking for group: a message saying who's wanted for what game, when and where, with slots people fill by joining.
/// The poster hears about each join; when it fills up everyone in it gets a ping. Posts close two hours after their
/// time, or a day after posting without one. Members can opt in to hear about every new post.
/// </summary>
public static class LfgFeature
{
    public const int MaxGame = 100;
    public const int MaxNote = 200;
    public const int MinSlots = 1;
    public const int MaxSlots = 20;
    public const long PastSlackMs = 5 * 60_000;
    public const long MaxAheadMs = 7L * 24 * 3600 * 1000;
    public const long AfterStartMs = 2 * 3600 * 1000;
    public const long WithoutTimeMs = 24 * 3600 * 1000;

    public static void Register(Router router)
    {
        router.Add("lfg.create", Create);
        router.Add("lfg.join", Join);
        router.Add("lfg.leave", Leave);
        router.Add("lfg.close", Close);
        router.Add("lfg.notify.get", (s, me, _) => new { on = s.World.Store.LfgNotifyOn(me.AccountKey) });
        router.Add("lfg.notify.set", SetNotify);
    }

    /// <summary>The <c>lfg</c> part of a message (null for every other message).</summary>
    public static object? View(Store store, long messageId) =>
        store.GetLfg(messageId) is { } post ? View(store, post) : null;

    private static object View(Store store, LfgPost post) => new
    {
        game = post.Game,
        slots = post.Slots,
        startAt = post.StartAt,
        voiceChannelId = post.VoiceChannelId,
        note = post.Note,
        joined = store.LfgMembers(post.MessageId),
        expiresAt = post.ExpiresAt,
        closedAt = post.ClosedAt,
    };

    public static bool IsLfg(Store store, long messageId) => store.GetLfg(messageId) is not null;

    /// <summary>"Looking for 3 for Valheim": the message text, for apps that don't know LFG posts.</summary>
    internal static string Summary(string game, int slots) => $"Looking for {slots} for {game}";

    private static object Create(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        if (channel.Kind != "text") throw RequestException.BadRequest("Looking-for-group posts go in text channels.", "lfg_channel");
        E2eeChannelFeature.RefusePlaintext(store, channel, "Looking-for-group posts");
        if (!Permissions.CanSend(me, channel)) throw RequestException.Forbidden("You can't send messages in this channel.", "cant_send_here");

        var game = Text.Normalize(body.String("game", MaxGame * 2), MaxGame, allowNewlines: false)
            ?? throw RequestException.BadRequest($"The game must be 1–{MaxGame} characters.", "lfg_game", new { max = MaxGame });
        var slots = body.OptionalLong("slots") is { } n && n is >= MinSlots and <= MaxSlots
            ? (int)n
            : throw RequestException.BadRequest($"Look for {MinSlots}–{MaxSlots} people.", "lfg_slots", new { min = MinSlots, max = MaxSlots });
        var startAt = body.OptionalLong("startAt");
        if (startAt is { } at && (at < s.Now - PastSlackMs || at > s.Now + MaxAheadMs))
            throw RequestException.BadRequest("Pick a time from now up to a week ahead.", "lfg_time");
        long? voiceId = null;
        if (body.OptionalLong("voiceChannelId") is { } vid)
        {
            if (store.GetChannel(vid) is not { Kind: "voice" or "stage" } voice || !Permissions.CanRead(me, voice))
                throw RequestException.BadRequest("Pick a voice channel you can see.", "lfg_voice");
            voiceId = voice.Id;
        }
        string? note = null;
        if (body.OptionalString("note", MaxNote * 2) is { } rawNote && rawNote.Trim().Length > 0)
            note = Text.Normalize(rawNote, MaxNote, allowNewlines: false)
                ?? throw RequestException.BadRequest($"The note can be up to {MaxNote} characters.", "lfg_note", new { max = MaxNote });

        AutoModFeature.Check(s, me, channel, note is null ? game : game + "\n" + note, "post");
        if (!s.TryTakeLimit("lfg.created")) throw new RequestException("rate_limited", "Slow down a little.");
        ModerationFeature.CheckSlowmode(s, me, channel);
        var expires = startAt is { } start ? start + AfterStartMs : s.Now + WithoutTimeMs;
        var (message, post) = store.AddLfg(channel.Id, me.AccountKey, Summary(game, slots),
            new LfgPost(0, game, slots, startAt, voiceId, note, expires, null, null), s.Now);

        var view = MessageViews.Public(store, message);
        s.Hub.BroadcastToReaders(channel, Frames.Event("chat.message", new { message = view }));
        s.Push.ChatMessage(channel, message, pings: false);
        NotifyFollowers(s, me, channel, post);
        return new { message = view };
    }

    /// <summary>"Notify me for LFG": everyone who opted in, can read the channel, and hasn't blocked the poster (or been blocked).</summary>
    private static void NotifyFollowers(Session s, Member me, Channel channel, LfgPost post)
    {
        var store = s.World.Store;
        var name = store.DisplayName(me);
        var frame = Frames.Event("lfg.posted", new { id = post.MessageId, channelId = channel.Id, author = me.AccountKey, game = post.Game });
        foreach (var key in store.LfgNotifyAccounts())
        {
            if (key == me.AccountKey || store.GetMember(key) is not { } member || !Permissions.CanRead(member, channel)) continue;
            if (store.EitherBlocked(key, me.AccountKey)) continue;
            s.Hub.SendToAccount(key, frame);
            s.Push.Notify(key, new PushNote("lfg", $"lfg:{post.MessageId}", $"{name} is looking for {post.Slots} for {post.Game}", $"In #{channel.Name}", name,
                ChannelId: channel.Id, MessageId: post.MessageId, Coalesce: false, Text: new PushText("lfgPosted", null, new { name, game = post.Game, slots = post.Slots })));
        }
    }

    private static (Message Message, Channel Channel, LfgPost Post) Find(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var message = store.GetMessage(body.Long("id")) ?? throw RequestException.NotFound("Post");
        var channel = ChatFeature.ReadableChannel(s, me, message.ChannelId);
        var post = store.GetLfg(message.Id) ?? throw RequestException.NotFound("Post");
        return (message, channel, post);
    }

    private static object Join(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (message, channel, post) = Find(s, me, body);
        if (message.AuthorKey == me.AccountKey) throw RequestException.BadRequest("That's your own post.", "lfg_own");
        if (post.IsClosed(s.Now)) throw RequestException.BadRequest("This post has closed.", "lfg_closed");
        var already = store.LfgMembers(post.MessageId).Contains(me.AccountKey);
        var (joined, firstFull) = store.JoinLfg(post.MessageId, me.AccountKey, post.Slots, s.Now);
        if (!joined) throw RequestException.BadRequest("Every slot is taken.", "lfg_full");
        var lfg = View(store, post.MessageId)!;
        if (already) return new { lfg };

        Publish(s.Hub, channel, post.MessageId, lfg);
        var name = store.DisplayName(me);
        s.Hub.SendToAccount(message.AuthorKey, Frames.Event("lfg.joined", new { id = post.MessageId, channelId = channel.Id, accountKey = me.AccountKey, lfg }));
        s.Push.Notify(message.AuthorKey, new PushNote("lfg", $"lfg:{post.MessageId}", $"{name} joined your group for {post.Game}", $"In #{channel.Name}", name,
            ChannelId: channel.Id, MessageId: post.MessageId, Text: new PushText("lfgJoined", null, new { name, game = post.Game })));
        if (firstFull) Full(s, message, channel, post, lfg);
        return new { lfg };
    }

    /// <summary>The first time a post fills up: the poster and everyone in it get a ping (with the voice channel to join).</summary>
    private static void Full(Session s, Message message, Channel channel, LfgPost post, object lfg)
    {
        var store = s.World.Store;
        var frame = Frames.Event("lfg.full", new { id = post.MessageId, channelId = channel.Id, lfg });
        var poster = store.GetMember(message.AuthorKey) is { } p ? store.DisplayName(p) : "Someone";
        foreach (var key in store.LfgMembers(post.MessageId).Prepend(message.AuthorKey).Distinct())
        {
            s.Hub.SendToAccount(key, frame);
            s.Push.Notify(key, new PushNote("lfg", $"lfg:{post.MessageId}:full", $"Your group for {post.Game} is full", "Time to play!", poster,
                ChannelId: channel.Id, MessageId: post.MessageId, Coalesce: false, Text: new PushText("lfgFull", null, new { name = poster, game = post.Game })));
        }
    }

    private static object Leave(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (_, channel, post) = Find(s, me, body);
        if (post.IsClosed(s.Now)) throw RequestException.BadRequest("This post has closed.", "lfg_closed");
        var left = store.LeaveLfg(post.MessageId, me.AccountKey);
        var lfg = View(store, post.MessageId)!;
        if (left) Publish(s.Hub, channel, post.MessageId, lfg);
        return new { lfg };
    }

    private static object? Close(Session s, Member me, Body body)
    {
        var store = s.World.Store;
        var (message, channel, post) = Find(s, me, body);
        if (!Permissions.CanDeleteMessage(me, message, store.GetMember(message.AuthorKey)))
            throw RequestException.Forbidden("Only the poster or a moderator can close this post.", "lfg_close_author");
        if (!post.IsClosed(s.Now) && store.CloseLfg(post.MessageId, s.Now)) Publish(s.Hub, channel, post.MessageId, View(store, post.MessageId)!);
        return null;
    }

    private static object SetNotify(Session s, Member me, Body body)
    {
        var on = body.OptionalBool("on") ?? throw RequestException.BadRequest("'on' is required.");
        s.World.Store.SetLfgNotify(me.AccountKey, on, s.Now);
        return new { on };
    }

    internal static void Publish(Hub hub, Channel channel, long messageId, object lfg) =>
        hub.BroadcastToReaders(channel, Frames.Event("lfg.updated", new { id = messageId, channelId = channel.Id, lfg }));
}

/// <summary>Closes LFG posts when their time is up, so everyone sees they're over.</summary>
public sealed class LfgCloser(World world, Hub hub, TimeProvider time, ILogger<LfgCloser> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping)) CloseExpired(time.GetUtcNow().ToUnixTimeMilliseconds());
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Returns how many closed. Tests call it with their own clock.</summary>
    internal int CloseExpired(long now)
    {
        var closed = 0;
        try
        {
            var store = world.Store;
            foreach (var post in store.ExpiredLfg(now))
            {
                if (!store.CloseLfg(post.MessageId, post.ExpiresAt)) continue;
                closed++;
                if (store.GetMessage(post.MessageId)?.ChannelId is { } id && store.GetChannel(id) is { } channel)
                    LfgFeature.Publish(hub, channel, post.MessageId, LfgFeature.View(store, post.MessageId)!);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Closing expired LFG posts failed");
        }
        return closed;
    }
}
