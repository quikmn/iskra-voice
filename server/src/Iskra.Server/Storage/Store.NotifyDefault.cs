namespace Iskra.Server.Storage;

/// <summary>The server's default notification level for people who chose none ("auto" when unset: by the server's size).</summary>
public sealed partial class Store
{
    private const string NotifyDefaultMigration = """
        CREATE TABLE notify_default (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            level       TEXT NOT NULL
        );
        """;

    /// <summary>"all", "mentions", or null for automatic.</summary>
    public string? NotifyDefault() => Scalar("SELECT level FROM notify_default WHERE id = 1;") as string;

    /// <summary>null goes back to automatic.</summary>
    public void SetNotifyDefault(string? level)
    {
        if (level is null) Exec("DELETE FROM notify_default WHERE id = 1;");
        else Exec("INSERT OR REPLACE INTO notify_default (id, level) VALUES (1, $l);", ("$l", level));
    }
}
