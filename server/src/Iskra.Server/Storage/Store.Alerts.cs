namespace Iskra.Server.Storage;

/// <summary>
/// What a member asked this server to keep for notifications while their apps are closed: alert words (only if they
/// opted in) and their quiet hours (only where push decisions are made). Both as JSON, as the member sent them.
/// </summary>
public sealed record AlertSettingsRecord(string AccountKey, string[] Words, string? Quiet, long UpdatedAt);

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

    private static AlertSettingsRecord ReadAlerts(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetString(0), System.Text.Json.JsonSerializer.Deserialize<string[]>(r.GetString(1)) ?? [], r.IsDBNull(2) ? null : r.GetString(2), r.GetInt64(3));

    public AlertSettingsRecord? GetAlerts(string accountKey) =>
        Query("SELECT account_key, words, quiet, updated_at FROM alert_settings WHERE account_key = $k;", ReadAlerts, ("$k", accountKey)).FirstOrDefault();

    /// <summary>Saves the settings; with no words and no quiet hours nothing is kept at all.</summary>
    public void SaveAlerts(string accountKey, string[] words, string? quiet, long now)
    {
        if (words.Length == 0 && quiet is null)
        {
            DeleteAlerts(accountKey);
            return;
        }
        Exec("""
            INSERT INTO alert_settings (account_key, words, quiet, updated_at) VALUES ($k, $words, $quiet, $now)
            ON CONFLICT(account_key) DO UPDATE SET words = excluded.words, quiet = excluded.quiet, updated_at = excluded.updated_at;
            """, ("$k", accountKey), ("$words", System.Text.Json.JsonSerializer.Serialize(words)), ("$quiet", quiet), ("$now", now));
    }

    public void DeleteAlerts(string accountKey) => Exec("DELETE FROM alert_settings WHERE account_key = $k;", ("$k", accountKey));

    /// <summary>Everyone with alert words here (for matching new messages).</summary>
    public List<AlertSettingsRecord> AllAlertWords() =>
        Query("SELECT account_key, words, quiet, updated_at FROM alert_settings WHERE words <> '[]';", ReadAlerts);
}
