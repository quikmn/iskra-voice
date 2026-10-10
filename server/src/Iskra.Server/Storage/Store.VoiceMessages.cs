namespace Iskra.Server.Storage;

public sealed partial class Store
{
    private const string VoiceMessagesMigration = """
        CREATE TABLE voice_messages (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            duration_ms INTEGER NOT NULL,
            waveform    BLOB NOT NULL
        );
        """;

    public void SetVoiceMessage(long messageId, int durationMs, byte[] waveform) =>
        Exec("INSERT OR REPLACE INTO voice_messages (message_id, duration_ms, waveform) VALUES ($m, $d, $w);",
            ("$m", messageId), ("$d", durationMs), ("$w", waveform));

    public (int DurationMs, byte[] Waveform)? GetVoiceMessage(long messageId) =>
        Query("SELECT duration_ms, waveform FROM voice_messages WHERE message_id = $m;",
            r => ((int, byte[])?)(r.GetInt32(0), (byte[])r.GetValue(1)), ("$m", messageId)).FirstOrDefault();
}
