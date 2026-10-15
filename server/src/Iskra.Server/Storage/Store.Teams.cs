namespace Iskra.Server.Storage;

/// <summary>A team split: the voice channel everyone came from, and a temporary voice channel per team.</summary>
public sealed record TeamSplit(long Id, long ChannelId, string? Game, string CreatedBy, long CreatedAt);

/// <summary>One team's temporary voice channel.</summary>
public sealed record TeamChannel(long ChannelId, long SplitId, int Team, string Name, long CreatedAt);

public sealed partial class Store
{
    // The origin channel has no foreign key: the split outlives it until its team channels are gone.
    // Team channels go with their channel (an admin deleting one by hand).
    private const string TeamsMigration = """
        CREATE TABLE team_splits (
            id          INTEGER PRIMARY KEY,
            channel_id  INTEGER NOT NULL,
            game        TEXT,
            created_by  TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE team_channels (
            channel_id  INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            split_id    INTEGER NOT NULL REFERENCES team_splits(id) ON DELETE CASCADE,
            team        INTEGER NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX team_channels_split ON team_channels(split_id);
        """;

    private static TeamSplit ReadSplit(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetInt64(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.GetInt64(4));

    /// <summary>The split and its team channels (already created), written together.</summary>
    public TeamSplit AddTeamSplit(long channelId, string? game, string createdBy, IReadOnlyList<long> teamChannels, long now)
    {
        lock (_gate)
        {
            using var tx = _db.BeginTransaction();
            long id;
            using (var insert = Command("""
                       INSERT INTO team_splits (channel_id, game, created_by, created_at) VALUES ($ch, $game, $by, $now) RETURNING id;
                       """, [("$ch", channelId), ("$game", game), ("$by", createdBy), ("$now", now)]))
            {
                insert.Transaction = tx;
                id = Convert.ToInt64(insert.ExecuteScalar());
            }
            for (var i = 0; i < teamChannels.Count; i++)
            {
                using var cmd = Command("INSERT INTO team_channels (channel_id, split_id, team, created_at) VALUES ($c, $s, $t, $now);",
                    [("$c", teamChannels[i]), ("$s", id), ("$t", i), ("$now", now)]);
                cmd.Transaction = tx;
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            return new TeamSplit(id, channelId, game, createdBy, now);
        }
    }

    public TeamSplit? GetTeamSplit(long id) =>
        Query("SELECT id, channel_id, game, created_by, created_at FROM team_splits WHERE id = $id;", ReadSplit, ("$id", id)).FirstOrDefault();

    public List<TeamSplit> TeamSplits() =>
        Query("SELECT id, channel_id, game, created_by, created_at FROM team_splits ORDER BY id;", ReadSplit);

    /// <summary>The split's team channels that still exist, in team order.</summary>
    public List<TeamChannel> TeamChannels(long splitId) =>
        Query("""
            SELECT t.channel_id, t.split_id, t.team, c.name, t.created_at FROM team_channels t JOIN channels c ON c.id = t.channel_id
            WHERE t.split_id = $s ORDER BY t.team;
            """, r => new TeamChannel(r.GetInt64(0), r.GetInt64(1), r.GetInt32(2), r.GetString(3), r.GetInt64(4)), ("$s", splitId));

    /// <summary>The split a team channel belongs to, if it is one.</summary>
    public long? TeamSplitOf(long channelId) =>
        Scalar("SELECT split_id FROM team_channels WHERE channel_id = $c;", ("$c", channelId)) is long id ? id : null;

    public void DeleteTeamSplit(long id) => Exec("DELETE FROM team_splits WHERE id = $id;", ("$id", id));
}
