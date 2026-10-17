namespace Iskra.Server.Storage;

/// <summary>Messages sent with /tts: only the flag; the text is the message's own.</summary>
public sealed partial class Store
{
    private const string TtsMigration = """
        CREATE TABLE tts_messages (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
        );
        """;

    public void SetTtsMessage(long messageId) =>
        Exec("INSERT OR IGNORE INTO tts_messages (message_id) VALUES ($m);", ("$m", messageId));

    public bool IsTtsMessage(long messageId) =>
        Scalar("SELECT 1 FROM tts_messages WHERE message_id = $m;", ("$m", messageId)) is not null;
}
