using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary><c>iskra-server webhooks</c>: making, listing and deleting incoming webhooks while the server runs.</summary>
public class WebhookCliTests
{
    private static (int Code, string Out, string Err) Run(string stdin, params string[] args)
    {
        var flags = args.Where(a => a.StartsWith("--", StringComparison.Ordinal)).ToHashSet(StringComparer.Ordinal);
        var rest = args.Where(a => !a.StartsWith("--", StringComparison.Ordinal)).ToArray();
        var output = new StringWriter();
        var error = new StringWriter();
        var code = Cli.Webhooks(["webhooks", .. rest], flags, new StringReader(stdin), output, error);
        return (code, output.ToString(), error.ToString());
    }

    [Fact]
    public async Task A_webhook_made_from_the_command_line_posts_while_the_server_runs()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");

        var (code, json, err) = Run("", "create", server.WorldPath, "#general", "GitHub", "--json");
        Assert.True(code == 0, err);
        var body = JsonDocument.Parse(json).RootElement;
        var id = body.GetProperty("webhook").GetProperty("id").GetString()!;
        var secret = body.GetProperty("secret").GetString()!;
        Assert.EndsWith($"/hooks/{id}/{secret}", body.GetProperty("url").GetString());
        Assert.Equal(body.GetProperty("url").GetString() + "/github", body.GetProperty("github").GetString());

        var stored = server.World.Store.GetWebhook(id)!;
        Assert.Equal(server.General, stored.ChannelId);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret))), stored.SecretHash);
        Assert.Equal(owner.Key, stored.CreatedBy);
        Assert.Contains(server.World.Store.Audit("webhook.create", null, null, 10), a => a.Actor == owner.Key);

        using (var response = await server.CreateClient().PostAsJsonAsync($"/hooks/{id}/{secret}", new { content = "from the CLI" }))
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var message = (await alice.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("from the CLI", message.GetProperty("text").GetString());
        Assert.Equal("GitHub", message.GetProperty("webhook").GetProperty("name").GetString());

        // The app's list shows it too.
        var list = (await owner.RequestAsync("webhook.list")).Body().GetProperty("webhooks");
        Assert.Equal(id, list[0].GetProperty("id").GetString());

        var (listCode, listed, _) = Run("", server.WorldPath);
        Assert.Equal(0, listCode);
        Assert.Contains(id, listed);
        Assert.DoesNotContain(secret, listed);

        var (deleteCode, _, _) = Run("", "delete", server.WorldPath, id);
        Assert.Equal(0, deleteCode);
        Assert.Null(server.World.Store.GetWebhook(id));
        using (var gone = await server.CreateClient().PostAsJsonAsync($"/hooks/{id}/{secret}", new { content = "again" }))
            Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    [Fact]
    public async Task A_signing_secret_is_read_from_stdin_and_bad_input_changes_nothing()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var voice = (await owner.RequestAsync("channel.create", new { name = "Lounge", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();

        var (code, json, err) = Run("a signing secret 123\n", "create", server.WorldPath, "GENERAL", "CI", "--signing-secret-stdin", "--json");
        Assert.True(code == 0, err);
        var id = JsonDocument.Parse(json).RootElement.GetProperty("webhook").GetProperty("id").GetString()!;
        Assert.Equal("a signing secret 123", server.World.Store.WebhookSigningSecret(id));

        Assert.Equal(1, Run("short\n", "create", server.WorldPath, "general", "CI", "--signing-secret-stdin").Code);
        Assert.Equal(1, Run("", "create", server.WorldPath, "Lounge", "CI").Code);
        Assert.Equal(1, Run("", "create", server.WorldPath, voice.ToString(System.Globalization.CultureInfo.InvariantCulture), "CI").Code);
        Assert.Equal(1, Run("", "create", server.WorldPath, "nowhere", "CI").Code);
        Assert.Equal(1, Run("", "create", server.WorldPath, "general", "bad\u0007").Code);
        Assert.Equal(1, Run("", "delete", server.WorldPath, "no-such-id").Code);
        Assert.Equal(1, Run("", Path.Combine(Path.GetTempPath(), "not-a-world-" + Guid.NewGuid().ToString("N"))).Code);
        Assert.Equal(2, Run("", "create", server.WorldPath).Code);
        Assert.Single(server.World.Store.Webhooks(null));
    }
}
