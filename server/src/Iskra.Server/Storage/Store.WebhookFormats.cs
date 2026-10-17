namespace Iskra.Server.Storage;

public sealed partial class Store
{
    /// <summary>
    /// The secret an admin shares with GitHub, Gitea or GitLab so the server can check their signatures. Kept as given:
    /// an HMAC needs the secret itself. Goes with its webhook.
    /// </summary>
    private const string WebhookFormatsMigration = """
        CREATE TABLE webhook_signing (
            webhook_id TEXT PRIMARY KEY REFERENCES webhooks(id) ON DELETE CASCADE,
            secret     TEXT NOT NULL
        );
        """;

    public string? WebhookSigningSecret(string webhookId) =>
        Scalar("SELECT secret FROM webhook_signing WHERE webhook_id = $id;", ("$id", webhookId)) as string;

    public void SetWebhookSigningSecret(string webhookId, string? secret)
    {
        if (secret is null) Exec("DELETE FROM webhook_signing WHERE webhook_id = $id;", ("$id", webhookId));
        else Exec("""
            INSERT INTO webhook_signing (webhook_id, secret) VALUES ($id, $s)
            ON CONFLICT(webhook_id) DO UPDATE SET secret = excluded.secret;
            """, ("$id", webhookId), ("$s", secret));
    }
}
