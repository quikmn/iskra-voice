using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class WebhookTests
{
    private static JsonElement Message(JsonElement frame) => frame.Body().GetProperty("message");

    private static async Task<(string Id, string Secret, string Path)> CreateHook(User admin, long channelId, string name = "CI", bool mentions = false)
    {
        var created = await admin.RequestAsync("webhook.create", new { channelId, name, mentions });
        Assert.Equal("result", created.Type());
        var body = created.Body();
        return (body.GetProperty("webhook").GetProperty("id").GetString()!, body.GetProperty("secret").GetString()!, body.GetProperty("path").GetString()!);
    }

    private static Task<HttpResponseMessage> Post(IskraServer server, string path, object payload) =>
        server.CreateClient().PostAsJsonAsync(path, payload);

    private static Task<HttpResponseMessage> PostRaw(IskraServer server, string path, string body, string type = "application/json") =>
        server.CreateClient().PostAsync(path, new StringContent(body, Encoding.UTF8, type));

    [Fact]
    public async Task Only_admins_manage_webhooks_and_the_secret_is_stored_hashed()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        Assert.Equal("forbidden", (await alice.RequestAsync("webhook.create", new { channelId = server.General, name = "x" })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("webhook.list")).ErrorCode());

        var (id, secret, path) = await CreateHook(admin, server.General);
        Assert.Equal($"/hooks/{id}/{secret}", path);
        Assert.True(secret.Length >= 43);

        var stored = server.World.Store.GetWebhook(id)!;
        Assert.NotEqual(secret, stored.SecretHash);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret))), stored.SecretHash);

        var list = (await admin.RequestAsync("webhook.list", new { channelId = server.General })).Body().GetProperty("webhooks");
        Assert.Equal(1, list.GetArrayLength());
        Assert.DoesNotContain(secret, list.GetRawText());
        Assert.False(list[0].TryGetProperty("secret", out _));

        // Only text channels.
        var voice = (await admin.RequestAsync("channel.create", new { name = "voice", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await admin.RequestAsync("webhook.create", new { channelId = voice, name = "x" })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("webhook.create", new { channelId = server.General, name = "bad\u0007" })).ErrorCode());
    }

    [Fact]
    public async Task Posts_reach_channel_readers_with_the_webhook_as_author()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var (id, _, path) = await CreateHook(admin, server.General, "Deploys");

        using var response = await Post(server, path, new { content = "  build **passed**  " });
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        var message = Message(await alice.EventAsync("chat.message"));
        Assert.Equal("build **passed**", message.GetProperty("text").GetString());
        Assert.Equal($"webhook:{id}", message.GetProperty("author").GetString());
        Assert.Equal("Deploys", message.GetProperty("webhook").GetProperty("name").GetString());
        Assert.Equal(id, message.GetProperty("webhook").GetProperty("id").GetString());

        // ?wait=true answers with the message, Discord-style; username overrides the name for this post.
        using var waited = await Post(server, path + "?wait=true", new { content = "hi", username = "Release bot" });
        Assert.Equal(HttpStatusCode.OK, waited.StatusCode);
        var body = JsonDocument.Parse(await waited.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("hi", body.GetProperty("content").GetString());
        Assert.Equal("Release bot", body.GetProperty("author").GetProperty("username").GetString());
        Assert.True(body.GetProperty("author").GetProperty("bot").GetBoolean());

        var history = (await alice.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal("Release bot", history[1].GetProperty("webhook").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "me" }))
            .Body().GetProperty("message").GetProperty("webhook").ValueKind);

        // Nobody can edit a webhook's message; admins can delete it.
        var messageId = message.GetProperty("id").GetInt64();
        Assert.Equal("forbidden", (await alice.RequestAsync("chat.edit", new { id = messageId, text = "x" })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("chat.delete", new { id = messageId })).ErrorCode());
        Assert.Equal("result", (await admin.RequestAsync("chat.delete", new { id = messageId })).Type());
    }

    [Fact]
    public async Task Wrong_secrets_regenerate_and_delete()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var (id, secret, path) = await CreateHook(admin, server.General);

        using (var r = await Post(server, $"/hooks/{id}/{secret[..^1]}x", new { content = "x" })) Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        using (var r = await Post(server, $"/hooks/nope/{secret}", new { content = "x" })) Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        using (var r = await server.CreateClient().GetAsync(path)) Assert.Equal(HttpStatusCode.OK, r.StatusCode);

        var regenerated = (await admin.RequestAsync("webhook.regenerate", new { id })).Body();
        var newPath = regenerated.GetProperty("path").GetString()!;
        Assert.NotEqual(path, newPath);
        using (var r = await Post(server, path, new { content = "old" })) Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        using (var r = await Post(server, newPath, new { content = "new" })) Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);

        Assert.Equal("result", (await admin.RequestAsync("webhook.delete", new { id })).Type());
        using (var r = await Post(server, newPath, new { content = "gone" })) Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Equal("not_found", (await admin.RequestAsync("webhook.delete", new { id })).ErrorCode());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"content\":\"   \"}")]
    [InlineData("{\"content\":\"bell\\u0007\"}")]
    [InlineData("{\"content\":\"hidden\\u202Etext\"}")]
    [InlineData("{\"content\":5}")]
    [InlineData("{\"content\":\"x\",\"username\":\"\\u0007\"}")]
    [InlineData("{\"embeds\":{}}")]
    [InlineData("{\"embeds\":[{\"color\":-1}]}")]
    [InlineData("{\"embeds\":[{\"title\":\"x\",\"url\":\"javascript:alert(1)\"}]}")]
    [InlineData("[1,2]")]
    [InlineData("not json")]
    public async Task Bad_payloads_are_rejected(string payload)
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var (_, _, path) = await CreateHook(admin, server.General);
        using var response = await PostRaw(server, path, payload);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        await admin.NoEventAsync("chat.message");
    }

    [Fact]
    public async Task Size_limits()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var (_, _, path) = await CreateHook(admin, server.General);

        using (var r = await Post(server, path, new { content = new string('a', 4000) })) Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        using (var r = await Post(server, path, new { content = new string('a', 4001) })) Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        using (var r = await Post(server, path, new { content = "x", embeds = Enumerable.Range(0, 11).Select(i => new { title = $"{i}" }) }))
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        using (var r = await Post(server, path, new { embeds = Enumerable.Range(0, 2).Select(_ => new { description = new string('d', 4000) }) }))
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode); // 6000 characters across all embeds
        using (var r = await PostRaw(server, path, "{\"content\":\"" + new string('a', 70_000) + "\"}"))
            Assert.Equal(HttpStatusCode.RequestEntityTooLarge, r.StatusCode);
    }

    [Fact]
    public async Task Each_webhook_is_rate_limited()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var (_, _, path) = await CreateHook(admin, server.General);
        var (_, _, other) = await CreateHook(admin, server.General, "Other");

        for (var i = 0; i < 5; i++)
        {
            using var ok = await Post(server, path, new { content = $"m{i}" });
            Assert.Equal(HttpStatusCode.NoContent, ok.StatusCode);
        }
        using var limited = await Post(server, path, new { content = "too many" });
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.True(limited.Headers.RetryAfter is not null);
        var body = JsonDocument.Parse(await limited.Content.ReadAsStringAsync()).RootElement;
        Assert.True(body.GetProperty("retry_after").GetDouble() > 0);

        // Another webhook has its own budget.
        using var fine = await Post(server, other, new { content = "hello" });
        Assert.Equal(HttpStatusCode.NoContent, fine.StatusCode);
    }

    [Fact]
    public async Task Mentions_are_defused_unless_the_admin_allowed_them()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var (_, _, quiet) = await CreateHook(admin, server.General, "Quiet");
        var (_, _, loud) = await CreateHook(admin, server.General, "Loud", mentions: true);
        var text = $"hey <@{alice.Key}> and @everyone and @here";

        using (await Post(server, quiet, new { content = text })) { }
        Assert.Equal("hey @Alice and @\u200Deveryone and @\u200Dhere", Message(await alice.EventAsync("chat.message")).GetProperty("text").GetString());

        using (await Post(server, loud, new { content = text })) { }
        Assert.Equal(text, Message(await alice.EventAsync("chat.message")).GetProperty("text").GetString());

        // Discord's allowed_mentions can only narrow it down.
        using (await Post(server, loud, new { content = text, allowed_mentions = new { parse = new[] { "users" } } })) { }
        Assert.Equal($"hey <@{alice.Key}> and @\u200Deveryone and @\u200Dhere", Message(await alice.EventAsync("chat.message")).GetProperty("text").GetString());
        using (await Post(server, loud, new { content = text, allowed_mentions = new { parse = Array.Empty<string>() } })) { }
        Assert.Equal("hey @Alice and @\u200Deveryone and @\u200Dhere", Message(await alice.EventAsync("chat.message")).GetProperty("text").GetString());
    }

    [Fact]
    public async Task Embeds_keep_their_text_and_drop_everything_else()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var (_, _, path) = await CreateHook(admin, server.General);
        var payload = """
            {"embeds":[{"title":"Alert firing","url":"https://grafana.example/d/1","description":"CPU > 90%","color":15158332,
              "timestamp":"2026-10-01T12:00:00Z","author":{"name":"Grafana","icon_url":"https://evil.example/a.png"},
              "footer":{"text":"prod"},"image":{"url":"https://evil.example/track.png"},"thumbnail":{"url":"https://evil.example/t.png"},
              "fields":[{"name":"host","value":"web-1","inline":true},{"name":"\u200b","value":"\u200b"}]}]}
            """;
        using (var r = await PostRaw(server, path, payload)) Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);

        var message = Message(await admin.EventAsync("chat.message"));
        Assert.Equal("", message.GetProperty("text").GetString());
        var embed = message.GetProperty("webhook").GetProperty("embeds")[0];
        Assert.Equal("Alert firing", embed.GetProperty("title").GetString());
        Assert.Equal("https://grafana.example/d/1", embed.GetProperty("url").GetString());
        Assert.Equal(15158332, embed.GetProperty("color").GetInt32());
        Assert.Equal(DateTimeOffset.Parse("2026-10-01T12:00:00Z").ToUnixTimeMilliseconds(), embed.GetProperty("timestamp").GetInt64());
        Assert.Equal("Grafana", embed.GetProperty("author").GetProperty("name").GetString());
        Assert.Equal(1, embed.GetProperty("fields").GetArrayLength()); // the blank filler field is dropped
        Assert.DoesNotContain("evil.example", embed.GetRawText());
    }

    [Fact]
    public async Task Form_bodies_and_github_events()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var (_, _, path) = await CreateHook(admin, server.General);
        var http = server.CreateClient();

        using (var r = await http.PostAsync(path, new FormUrlEncodedContent(new Dictionary<string, string> { ["content"] = "from curl -d" })))
            Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        Assert.Equal("from curl -d", Message(await admin.EventAsync("chat.message")).GetProperty("text").GetString());

        using (var multipart = new MultipartFormDataContent { { new StringContent("{\"content\":\"multipart\"}"), "payload_json" } })
        using (var r = await http.PostAsync(path, multipart))
            Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        Assert.Equal("multipart", Message(await admin.EventAsync("chat.message")).GetProperty("text").GetString());

        var push = """
            {"ref":"refs/heads/main","compare":"https://github.com/me/game/compare/a...b","repository":{"full_name":"me/game"},
             "sender":{"login":"octocat"},"commits":[{"id":"0123456789abcdef","message":"Fix the jump\n\nlong text","author":{"name":"Octo"}}]}
            """;
        using var request = new HttpRequestMessage(HttpMethod.Post, path + "/github") { Content = new StringContent(push, Encoding.UTF8, "application/json") };
        request.Headers.Add("X-GitHub-Event", "push");
        using (var r = await http.SendAsync(request)) Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        var embed = Message(await admin.EventAsync("chat.message")).GetProperty("webhook").GetProperty("embeds")[0];
        Assert.Equal("[me/game:main] 1 new commit", embed.GetProperty("title").GetString());
        Assert.Equal("`0123456` Fix the jump - Octo", embed.GetProperty("description").GetString());
        Assert.Equal("octocat", embed.GetProperty("author").GetProperty("name").GetString());
    }

    [Fact]
    public async Task Webhooks_in_private_channels_only_reach_those_readers()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var staff = (await owner.RequestAsync("channel.create", new { name = "staff", readRole = "admin" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var secret = (await owner.RequestAsync("channel.create", new { name = "owner", readRole = "owner" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var (id, _, path) = await CreateHook(admin, staff);

        using (await Post(server, path, new { content = "staff only" })) { }
        await admin.EventAsync("chat.message");
        await alice.NoEventAsync("chat.message");

        // Admins can't see or move webhooks into channels they can't read.
        Assert.Equal("not_found", (await admin.RequestAsync("webhook.create", new { channelId = secret, name = "x" })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("webhook.update", new { id, channelId = secret })).ErrorCode());
        var (ownerHook, _, _) = await CreateHook(owner, secret);
        Assert.Equal("not_found", (await admin.RequestAsync("webhook.delete", new { id = ownerHook })).ErrorCode());
        var list = (await admin.RequestAsync("webhook.list")).Body().GetProperty("webhooks");
        Assert.Equal(1, list.GetArrayLength());

        // Deleting the channel deletes its webhooks.
        await owner.RequestAsync("channel.delete", new { id = staff });
        using (var r = await Post(server, path, new { content = "x" })) Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task Avatars_must_be_your_own_images()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGNgYGD4z4AEMDgAHNoB/zrD+5kAAAAASUVORK5CYII=");

        async Task<string> Upload(User user, byte[] content)
        {
            var ticket = (await user.RequestAsync("upload.begin", new { name = "a.png", size = content.Length })).Body().GetProperty("url").GetString();
            using var response = await server.CreateClient().PutAsync(ticket, new ByteArrayContent(content));
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString()!;
        }

        var mine = await Upload(admin, png);
        var text = await Upload(admin, Encoding.UTF8.GetBytes("not an image"));
        var hers = await Upload(alice, png);
        Assert.Equal("bad_request", (await admin.RequestAsync("webhook.create", new { channelId = server.General, name = "x", avatar = text })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("webhook.create", new { channelId = server.General, name = "x", avatar = hers })).ErrorCode());
        var created = (await admin.RequestAsync("webhook.create", new { channelId = server.General, name = "x", avatar = mine })).Body();
        Assert.Equal(mine, created.GetProperty("webhook").GetProperty("avatar").GetProperty("id").GetString());

        using (await Post(server, created.GetProperty("path").GetString()!, new { content = "hi", avatar_url = "https://evil.example/a.png" })) { }
        var message = Message(await alice.EventAsync("chat.message"));
        Assert.Equal(mine, message.GetProperty("webhook").GetProperty("avatar").GetProperty("id").GetString());

        var id = created.GetProperty("webhook").GetProperty("id").GetString();
        var cleared = (await admin.RequestAsync("webhook.update", new { id, avatar = "", name = "Renamed" })).Body().GetProperty("webhook");
        Assert.Equal(JsonValueKind.Null, cleared.GetProperty("avatar").ValueKind);
        Assert.Equal("Renamed", cleared.GetProperty("name").GetString());
    }
}
