namespace Iskra.Server.Storage;

/// <summary>A temporary voice room made by joining a lobby: the lobby it came from, who hosts it, and whether it's locked.</summary>
public sealed record VoiceRoom(long ChannelId, long LobbyId, string HostKey, bool Locked, long CreatedAt);

public sealed partial class Store
{
    // The lobby has no foreign key: a room outlives its lobby until it's empty. Rooms and their invites go with the channel.
    private const string RoomsMigration = """
        CREATE TABLE voice_lobbies (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE
        );
        CREATE TABLE voice_rooms (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            lobby_id    INTEGER NOT NULL,
            host_key    TEXT NOT NULL,
            locked      INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE voice_room_invites (
            channel_id  INTEGER NOT NULL REFERENCES voice_rooms(channel_id) ON DELETE CASCADE,
            account_key TEXT NOT NULL,
            PRIMARY KEY (channel_id, account_key)
        );
        """;

    private const string RoomColumns = "channel_id, lobby_id, host_key, locked, created_at";

    private static VoiceRoom ReadRoom(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetInt64(3) != 0, r.GetInt64(4));

    // ── Lobbies (join to create a room) ──────────────────────────────────────

    public bool IsLobby(long channelId) =>
        Scalar("SELECT 1 FROM voice_lobbies WHERE channel_id = $c;", ("$c", channelId)) is not null;

    public HashSet<long> AllLobbies() =>
        Query("SELECT channel_id FROM voice_lobbies;", r => r.GetInt64(0)).ToHashSet();

    public void SetLobby(long channelId, bool on)
    {
        if (on) Exec("INSERT INTO voice_lobbies (channel_id) VALUES ($c) ON CONFLICT(channel_id) DO NOTHING;", ("$c", channelId));
        else Exec("DELETE FROM voice_lobbies WHERE channel_id = $c;", ("$c", channelId));
    }

    // ── Rooms ────────────────────────────────────────────────────────────────

    public VoiceRoom AddRoom(long channelId, long lobbyId, string hostKey, long now)
    {
        Exec("INSERT INTO voice_rooms (channel_id, lobby_id, host_key, locked, created_at) VALUES ($c, $l, $h, 0, $now);",
            ("$c", channelId), ("$l", lobbyId), ("$h", hostKey), ("$now", now));
        return new VoiceRoom(channelId, lobbyId, hostKey, false, now);
    }

    public VoiceRoom? GetRoom(long channelId) =>
        Query($"SELECT {RoomColumns} FROM voice_rooms WHERE channel_id = $c;", ReadRoom, ("$c", channelId)).FirstOrDefault();

    public List<VoiceRoom> AllRooms() => Query($"SELECT {RoomColumns} FROM voice_rooms ORDER BY created_at, channel_id;", ReadRoom);

    public void SetRoomHost(long channelId, string hostKey) =>
        Exec("UPDATE voice_rooms SET host_key = $h WHERE channel_id = $c;", ("$c", channelId), ("$h", hostKey));

    public void SetRoomLocked(long channelId, bool locked) =>
        Exec("UPDATE voice_rooms SET locked = $l WHERE channel_id = $c;", ("$c", channelId), ("$l", locked ? 1 : 0));

    /// <summary>Who may join the room while it's locked (besides the host), in invite order.</summary>
    public List<string> RoomInvites(long channelId) =>
        Query("SELECT account_key FROM voice_room_invites WHERE channel_id = $c ORDER BY rowid;", r => r.GetString(0), ("$c", channelId));

    public Dictionary<long, List<string>> AllRoomInvites() =>
        Query("SELECT channel_id, account_key FROM voice_room_invites ORDER BY rowid;", r => (r.GetInt64(0), r.GetString(1)))
            .GroupBy(x => x.Item1).ToDictionary(g => g.Key, g => g.Select(x => x.Item2).ToList());

    public bool IsRoomInvited(long channelId, string accountKey) =>
        Scalar("SELECT 1 FROM voice_room_invites WHERE channel_id = $c AND account_key = $a;", ("$c", channelId), ("$a", accountKey)) is not null;

    public void SetRoomInvite(long channelId, string accountKey, bool on)
    {
        if (on) Exec("INSERT INTO voice_room_invites (channel_id, account_key) VALUES ($c, $a) ON CONFLICT DO NOTHING;", ("$c", channelId), ("$a", accountKey));
        else Exec("DELETE FROM voice_room_invites WHERE channel_id = $c AND account_key = $a;", ("$c", channelId), ("$a", accountKey));
    }
}
