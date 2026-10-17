using Iskra.Server.Protocol;

namespace Iskra.Server.Storage;

/// <summary>
/// What a member asked this server to keep for notifications while their apps are closed: alert words and follows
/// (only if they opted in) and their quiet hours (only where push decisions are made). All as JSON, as the member sent them.
/// </summary>
public sealed record AlertSettingsRecord(string AccountKey, string[] Words, FollowRule[] Follows, string? Quiet, long UpdatedAt);

/// <summary>"Alert me when this person (or anyone with this role) posts", in one channel or anywhere on this server.</summary>
public sealed record FollowRule(string? Member, long? Role, long? ChannelId);

public sealed partial class Store
{
    private const string AlertsMigration = """
        CREATE TABLE alert_settings (
            account_key TEXT PRIMARY KEY,
            words       TEXT NOT NULL,
            quiet       TEXT,
            updated_at  INTEGER NOT NULL
        );
        """;

    /// <summary>Follows (alerts-2): people and roles to hear about, per channel or anywhere.</summary>
    private const string Alerts2Migration = "ALTER TABLE alert_settings ADD COLUMN follows TEXT NOT NULL DEFAULT '[]';";

    private const string AlertColumns = "account_key, words, follows, quiet, updated_at";

    private static AlertSettingsRecord ReadAlerts(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), System.Text.Json.JsonSerializer.Deserialize<string[]>(r.GetString(1)) ?? [],
            System.Text.Json.JsonSerializer.Deserialize<FollowRule[]>(r.GetString(2), Json.Options) ?? [],
            r.IsDBNull(3) ? null : r.GetString(3), r.GetInt64(4));

    public AlertSettingsRecord? GetAlerts(string accountKey) =>
        Query($"SELECT {AlertColumns} FROM alert_settings WHERE account_key = $k;", ReadAlerts, ("$k", accountKey)).FirstOrDefault();

    /// <summary>Saves the settings; with no words, no follows and no quiet hours nothing is kept at all.</summary>
    public void SaveAlerts(string accountKey, string[] words, FollowRule[] follows, string? quiet, long now)
    {
        if (words.Length == 0 && follows.Length == 0 && quiet is null)
        {
            DeleteAlerts(accountKey);
            return;
        }
        Exec("""
            INSERT INTO alert_settings (account_key, words, follows, quiet, updated_at) VALUES ($k, $words, $follows, $quiet, $now)
            ON CONFLICT(account_key) DO UPDATE SET words = excluded.words, follows = excluded.follows, quiet = excluded.quiet, updated_at = excluded.updated_at;
            """, ("$k", accountKey), ("$words", System.Text.Json.JsonSerializer.Serialize(words)),
            ("$follows", System.Text.Json.JsonSerializer.Serialize(follows, Json.Options)), ("$quiet", quiet), ("$now", now));
    }

    public void DeleteAlerts(string accountKey) => Exec("DELETE FROM alert_settings WHERE account_key = $k;", ("$k", accountKey));

    /// <summary>Everyone with alert words here (for matching new messages).</summary>
    public List<AlertSettingsRecord> AllAlertWords() =>
        Query($"SELECT {AlertColumns} FROM alert_settings WHERE words <> '[]';", ReadAlerts);

    /// <summary>Everyone following someone or some role here.</summary>
    public List<AlertSettingsRecord> AllAlertFollows() =>
        Query($"SELECT {AlertColumns} FROM alert_settings WHERE follows <> '[]';", ReadAlerts);
}
