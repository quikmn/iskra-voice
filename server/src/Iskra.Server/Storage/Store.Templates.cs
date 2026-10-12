namespace Iskra.Server.Storage;

/// <summary>Starter templates: which one set this server up (applied once, see Templates/ServerTemplates.cs).</summary>
public sealed partial class Store
{
    private const string TemplatesMigration = """
        CREATE TABLE template_applied (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            name        TEXT NOT NULL,
            applied_at  INTEGER NOT NULL
        );
        """;

    /// <summary>The template this server was set up from, if any.</summary>
    public (string Name, long AppliedAt)? AppliedTemplate() =>
        Query("SELECT name, applied_at FROM template_applied WHERE id = 1;", r => (r.GetString(0), r.GetInt64(1)))
            .Select(x => ((string, long)?)x).FirstOrDefault();

    public void MarkTemplateApplied(string name, long now) =>
        Exec("INSERT OR REPLACE INTO template_applied (id, name, applied_at) VALUES (1, $n, $t);", ("$n", name), ("$t", now));

    /// <summary>Nobody has joined and nothing has been set up: just the starting #general, with no messages.</summary>
    public bool IsNewServer() =>
        Convert.ToInt64(Scalar("""
            SELECT (SELECT COUNT(*) FROM members) + (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM categories)
                 + (SELECT COUNT(*) FROM roles) + (SELECT COUNT(*) FROM server_rules)
                 + MAX((SELECT COUNT(*) FROM channels) - 1, 0);
            """)) == 0;
}
