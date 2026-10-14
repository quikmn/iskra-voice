namespace Iskra.Server.Storage;

public sealed partial class Store
{
    // bot_dm_prefs: a person's "DMs from bots" choice (no row: allowed). Last writer wins by the client's time.
    // bot_dm_peers: who a bot has a conversation with, and whether the person wrote first (then the bot may answer even
    // if the person turned bot DMs off). Kept apart from the envelopes, which retention may delete.
    private const string BotDmsMigration = """
        CREATE TABLE bot_dm_prefs (
            account_key TEXT PRIMARY KEY,
            allow INTEGER NOT NULL,
            at INTEGER NOT NULL
        );
        CREATE TABLE bot_dm_peers (
            bot_key TEXT NOT NULL,
            account_key TEXT NOT NULL,
            person_wrote INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER NOT NULL,
            PRIMARY KEY (bot_key, account_key)
        );
        """;

    /// <summary>The person's choice and when it was made; (true, 0) when they never chose.</summary>
    public (bool Allow, long At) BotDmPref(string accountKey) =>
        Query("SELECT allow, at FROM bot_dm_prefs WHERE account_key = $k;", r => (r.GetInt64(0) != 0, r.GetInt64(1)), ("$k", accountKey))
            .DefaultIfEmpty((true, 0L)).First();

    /// <summary>Stores the choice if it's newer than the stored one. Returns what is stored afterwards.</summary>
    public (bool Allow, long At) SetBotDmPref(string accountKey, bool allow, long at)
    {
        lock (_gate)
        {
            Exec("""
                INSERT INTO bot_dm_prefs (account_key, allow, at) VALUES ($k, $allow, $at)
                ON CONFLICT(account_key) DO UPDATE SET allow = excluded.allow, at = excluded.at WHERE excluded.at > bot_dm_prefs.at;
                """, ("$k", accountKey), ("$allow", allow ? 1 : 0), ("$at", at));
            return BotDmPref(accountKey);
        }
    }

    /// <summary>The conversation between a bot and a person: null if there's none yet.</summary>
    public (bool PersonWrote, long StartedAt)? BotDmPeer(string botKey, string accountKey) =>
        Query("SELECT person_wrote, started_at FROM bot_dm_peers WHERE bot_key = $b AND account_key = $k;",
            r => ((bool PersonWrote, long StartedAt)?)(r.GetInt64(0) != 0, r.GetInt64(1)), ("$b", botKey), ("$k", accountKey)).FirstOrDefault();

    /// <summary>Notes a conversation (the person wrote to the bot, or the bot started it).</summary>
    public void NoteBotDmPeer(string botKey, string accountKey, bool personWrote, long now) =>
        Exec("""
            INSERT INTO bot_dm_peers (bot_key, account_key, person_wrote, started_at) VALUES ($b, $k, $w, $now)
            ON CONFLICT(bot_key, account_key) DO UPDATE SET person_wrote = MAX(person_wrote, excluded.person_wrote);
            """, ("$b", botKey), ("$k", accountKey), ("$w", personWrote ? 1 : 0), ("$now", now));
}
