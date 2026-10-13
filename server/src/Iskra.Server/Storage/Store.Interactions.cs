namespace Iskra.Server.Storage;

/// <summary>A bot's public answer to an interaction: who asked, and which command (null for clicks and forms).</summary>
public sealed record InteractionStamp(string Id, string UserKey, string? Command);

public sealed partial class Store
{
    private const string InteractionsMigration = """
        ALTER TABLE bots ADD COLUMN read_all INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE bot_invites ADD COLUMN read_all INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE bot_commands ADD COLUMN interactions INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE bot_components (
            message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            components  TEXT NOT NULL
        );
        CREATE TABLE bot_interaction_messages (
            message_id     INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            interaction_id TEXT NOT NULL,
            user_key       TEXT NOT NULL,
            command        TEXT
        );
        """;

    /// <summary>Sets (or with null removes) the buttons and select menus on a bot's message.</summary>
    public void SetMessageComponents(long messageId, string? components)
    {
        if (components is null) Exec("DELETE FROM bot_components WHERE message_id = $m;", ("$m", messageId));
        else
            Exec("""
                INSERT INTO bot_components (message_id, components) VALUES ($m, $c)
                ON CONFLICT(message_id) DO UPDATE SET components = excluded.components;
                """, ("$m", messageId), ("$c", components));
    }

    public string? GetMessageComponents(long messageId) =>
        Scalar("SELECT components FROM bot_components WHERE message_id = $m;", ("$m", messageId)) as string;

    public void SetInteractionStamp(long messageId, InteractionStamp stamp) =>
        Exec("INSERT OR REPLACE INTO bot_interaction_messages (message_id, interaction_id, user_key, command) VALUES ($m, $id, $user, $command);",
            ("$m", messageId), ("$id", stamp.Id), ("$user", stamp.UserKey), ("$command", stamp.Command));

    public InteractionStamp? GetInteractionStamp(long messageId) =>
        Query("SELECT interaction_id, user_key, command FROM bot_interaction_messages WHERE message_id = $m;",
            r => new InteractionStamp(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)), ("$m", messageId)).FirstOrDefault();
}
