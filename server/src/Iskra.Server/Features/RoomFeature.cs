using Iskra.Server.Protocol;
using Iskra.Server.Sessions;
using Iskra.Server.Storage;
using Iskra.Server.Voice;

namespace Iskra.Server.Features;

/// <summary>
/// Join-to-create voice rooms: an admin flags a voice channel as a lobby; joining it makes a temporary voice channel
/// ("alice's-room", right under the lobby, with its permissions) and puts you in it as its host. The host renames it,
/// sets a user limit and locks it (then only people they invite, or a moderator moves in, can join). Rooms are
/// deleted once they've been empty for a while, like team channels; the host passes to whoever has been there longest.
/// </summary>
public static class RoomFeature
{
    public const int MaxNameLength = 60;
    public const int MaxRooms = 100;
    public const int MaxInvites = 50;
    public const long EmptyMs = 30_000;

    public static void Register(Router router)
    {
        router.Add("room.update", Update);
        router.Add("room.invite", (s, me, body) => Invite(s, me, body, on: true));
        router.Add("room.uninvite", (s, me, body) => Invite(s, me, body, on: false));
    }

    /// <summary>`lobby` on channel.create / channel.update: voice channels only, never a room, the AFK channel or an encrypted channel.</summary>
    internal static bool? Field(Session s, Body body, string kind, long? channelId)
    {
        if (body.OptionalBool("lobby") is not { } value) return null;
        if (kind != "voice") throw RequestException.BadRequest("Only voice channels can be lobbies.", "lobby_voice_only");
        if (value && channelId is { } id && s.World.Store.GetRoom(id) is not null)
            throw RequestException.BadRequest("A room can't be a lobby itself.", "lobby_room");
        if (value && channelId is { } afkId && s.World.Store.Afk().ChannelId == afkId)
            throw RequestException.BadRequest("The AFK channel can't be a lobby.", "lobby_afk");
        return value;
    }

    public static bool IsLobby(Store store, long channelId) => store.IsLobby(channelId);

    public static object? View(VoiceRoom? room, IReadOnlyList<string> invited) =>
        room is null ? null : new { lobbyId = room.LobbyId, host = room.HostKey, locked = room.Locked, invited };

    public static object? View(Store store, long channelId) =>
        store.GetRoom(channelId) is { } room ? View(room, store.RoomInvites(channelId)) : null;

    /// <summary>Someone joined a lobby: makes their room (the lobby's category, roles, overrides, hi-fi and user limit) and tells everyone.</summary>
    internal static Channel Create(Session s, Member me, Channel lobby)
    {
        var store = s.World.Store;
        if (store.IsBot(me.AccountKey)) throw RequestException.BadRequest("Bots can't make rooms. Join a room someone made.", "lobby_bot");
        if (store.AllRooms().Count >= MaxRooms)
            throw RequestException.BadRequest($"A server can have up to {MaxRooms} rooms at once.", "rooms_max", new { max = MaxRooms });
        if (!s.TryTakeLimit("rooms.created")) throw new RequestException("rate_limited", "Slow down a little.");

        var name = RoomName($"{store.DisplayName(me)}'s room");
        var room = store.CreateChannel(name, "voice", lobby.ReadRole, lobby.WriteRole, s.Now);
        foreach (var o in lobby.Overrides) store.SetOverride(room.Id, o.RoleId, o.Allow, o.Deny);
        if (store.IsHifi(lobby.Id)) store.SetHifi(room.Id, true);
        if (store.UserLimit(lobby.Id) is var limit and > 0) store.SetUserLimit(room.Id, limit);
        // Right after the lobby and the rooms it already has, in its category.
        var ordered = store.AllChannels();
        var at = ordered.FindIndex(c => c.Id == lobby.Id);
        var rooms = store.AllRooms().Where(r => r.LobbyId == lobby.Id).Select(r => r.ChannelId).ToHashSet();
        var anchor = ordered.Skip(at + 1).FirstOrDefault(c => c.CategoryId == lobby.CategoryId && !rooms.Contains(c.Id))?.Id;
        store.MoveChannel(room.Id, lobby.CategoryId, anchor);
        store.AddRoom(room.Id, lobby.Id, me.AccountKey, s.Now);
        ChannelFeature.BroadcastChannels(s);
        return room with { CategoryId = lobby.CategoryId };
    }

    /// <summary>Room names follow channel name rules but may be longer (a display name plus "'s room").</summary>
    private static string RoomName(string raw)
    {
        var name = Text.Normalize(raw, MaxNameLength, allowNewlines: false)
            ?? throw RequestException.BadRequest($"A room's name must be 1–{MaxNameLength} characters.", "room_name", new { max = MaxNameLength });
        return ChannelFeature.Slug(name);
    }

    /// <summary>True unless the room is locked against this member: the host, invited people, someone a moderator moved in and movers get in.</summary>
    internal static bool MayEnter(Store store, VoiceRegistry voice, Member member, Channel channel, long now)
    {
        if (store.GetRoom(channel.Id) is not { Locked: true } room) return true;
        return room.HostKey == member.AccountKey || store.IsRoomInvited(channel.Id, member.AccountKey)
            || voice.HasMovePass(member.AccountKey, channel.Id, now) || VoiceLimitFeature.Bypasses(member);
    }

    internal static void CheckJoin(Session s, Member me, Channel channel)
    {
        if (MayEnter(s.World.Store, s.Voice, me, channel, s.Now)) return;
        var host = s.World.Store.GetRoom(channel.Id) is { } room && s.World.Store.GetMember(room.HostKey) is { } m ? s.World.Store.DisplayName(m) : "the host";
        throw new RequestException("room_locked", $"{channel.Name} is locked. Ask {host} to invite you.", "room_locked", new { name = channel.Name, host });
    }

    /// <summary>The room, which you must be able to see, and only if you host it or manage channels.</summary>
    private static (Channel Channel, VoiceRoom Room) Hosted(Session s, Member me, Body body)
    {
        var channel = ChatFeature.ReadableChannel(s, me, body.Long("channelId"));
        var room = s.World.Store.GetRoom(channel.Id) ?? throw RequestException.BadRequest("That isn't a room made from a lobby.", "room_only");
        if (room.HostKey != me.AccountKey && !Permissions.Has(me, Perm.ManageChannels))
            throw RequestException.Forbidden("Only the room's host can change it.", "room_host_only");
        return (channel, room);
    }

    private static object ChannelView(Session s, Channel channel)
    {
        var store = s.World.Store;
        return new
        {
            channel = Hub.PublicChannel(channel, store.Slowmode(channel.Id), store.UserLimit(channel.Id), E2eeChannelFeature.Info(store, channel.Id),
                store.IsHifi(channel.Id), store.Topic(channel.Id), store.IsLobby(channel.Id), View(store, channel.Id)),
        };
    }

    /// <summary>Rename, set a user limit, lock or unlock. Missing fields keep their value; nobody already inside is removed.</summary>
    private static object Update(Session s, Member me, Body body)
    {
        var (channel, room) = Hosted(s, me, body);
        var store = s.World.Store;
        var name = body.OptionalString("name", MaxNameLength * 4) is { } raw ? RoomName(raw) : channel.Name;
        var userLimit = VoiceLimitFeature.Field(body, channel.Kind);
        var locked = body.OptionalBool("locked");
        if (name != channel.Name) store.UpdateChannel(channel = channel with { Name = name });
        if (userLimit is { } limit && limit != store.UserLimit(channel.Id)) store.SetUserLimit(channel.Id, limit);
        if (locked is { } l && l != room.Locked) store.SetRoomLocked(channel.Id, l);
        ChannelFeature.BroadcastChannels(s);
        return ChannelView(s, channel);
    }

    /// <summary>Lets someone into a locked room (or takes that back). They still need to be able to see the channel.</summary>
    private static object Invite(Session s, Member me, Body body, bool on)
    {
        var (channel, _) = Hosted(s, me, body);
        var store = s.World.Store;
        var target = store.GetMember(body.String("accountKey", 64)) ?? throw RequestException.NotFound("Member");
        if (on && !Permissions.CanConnect(target, channel)) throw RequestException.Forbidden("They can't join that channel.", "they_cant_join");
        if (on && !store.IsRoomInvited(channel.Id, target.AccountKey) && store.RoomInvites(channel.Id).Count >= MaxInvites)
            throw RequestException.BadRequest($"A room can invite up to {MaxInvites} people.", "room_invites_max", new { max = MaxInvites });
        store.SetRoomInvite(channel.Id, target.AccountKey, on);
        ChannelFeature.BroadcastChannels(s);
        return ChannelView(s, channel);
    }

    /// <summary>
    /// After people join or leave: when the host is gone, the room passes to whoever has been there longest (not a bot).
    /// Called by the voice registry whenever a channel's voice state changes.
    /// </summary>
    internal static void Sync(Store store, Hub hub, VoiceRegistry voice, long channelId)
    {
        if (store.GetRoom(channelId) is not { } room) return;
        var present = voice.Participants(channelId);
        if (present.Count == 0 || present.Any(p => p.AccountKey == room.HostKey)) return;
        var next = present.Select(p => p.AccountKey).FirstOrDefault(key => !store.IsBot(key));
        if (next is null) return;
        store.SetRoomHost(channelId, next);
        TeamsFeature.BroadcastChannels(hub);
    }
}

/// <summary>Deletes rooms that have been empty for 30 seconds, every 10 seconds (also rooms left over from before a restart).</summary>
public sealed class RoomSweeper(World world, Hub hub, VoiceRegistry voice, TimeProvider time, ILogger<RoomSweeper> log) : BackgroundService
{
    private readonly long _startedAt = time.GetUtcNow().ToUnixTimeMilliseconds();
    private readonly Dictionary<long, long> _busyAt = [];

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping))
            {
                try
                {
                    Sweep(time.GetUtcNow().ToUnixTimeMilliseconds());
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.Warn(ex, "SCH-110", "sched", "failed", ("what", "rooms"));
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Deletes what's due; returns how many rooms went. Tests call it with their own clock.</summary>
    internal int Sweep(long now)
    {
        lock (_busyAt)
        {
            var store = world.Store;
            var deleted = 0;
            var live = new HashSet<long>();
            foreach (var room in store.AllRooms())
            {
                live.Add(room.ChannelId);
                // Someone inside, or on their way in after a move: the room stays.
                if (voice.Participants(room.ChannelId).Count > 0 || voice.MovedInto(room.ChannelId, now).Count > 0)
                {
                    _busyAt[room.ChannelId] = now;
                    continue;
                }
                var since = Math.Max(_busyAt.GetValueOrDefault(room.ChannelId, room.CreatedAt), _startedAt);
                if (now - since < RoomFeature.EmptyMs || !TeamsFeature.DeleteChannel(store, room.ChannelId)) continue;
                deleted++;
            }
            foreach (var id in _busyAt.Keys.Where(id => !live.Contains(id)).ToList()) _busyAt.Remove(id);
            if (deleted > 0) TeamsFeature.BroadcastChannels(hub);
            return deleted;
        }
    }
}
