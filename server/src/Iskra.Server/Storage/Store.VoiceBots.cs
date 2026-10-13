namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string VoiceBotsMigration = """
        ALTER TABLE bots ADD COLUMN voice INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE bot_invites ADD COLUMN voice INTEGER NOT NULL DEFAULT 0;
        """;

    /// <summary>Bots an admin lets join voice; asked on every member broadcast, so cached.</summary>
    private HashSet<string>? _voiceBots;

    public bool BotJoinsVoice(string accountKey)
    {
        lock (_gate)
        {
            _voiceBots ??= Query("SELECT account_key FROM bots WHERE voice != 0;", r => r.GetString(0)).ToHashSet(StringComparer.Ordinal);
            return _voiceBots.Contains(accountKey);
        }
    }

    public void SetBotVoice(string accountKey, bool voice)
    {
        lock (_gate)
        {
            Exec("UPDATE bots SET voice = $voice WHERE account_key = $key;", ("$key", accountKey), ("$voice", voice ? 1 : 0));
            _voiceBots = null;
        }
    }

    public void SetBotInviteVoice(string code, bool voice) =>
        Exec("UPDATE bot_invites SET voice = $voice WHERE code = $code;", ("$code", code), ("$voice", voice ? 1 : 0));

    public bool BotInviteVoice(string code) =>
        Scalar("SELECT voice FROM bot_invites WHERE code = $code;", ("$code", code)) is long voice && voice != 0;
}
