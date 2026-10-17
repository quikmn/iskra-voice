using System.Text.Json;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>/tts messages: a flag on a normal message, sent only with the sendTts permission, relayed and stored as is.</summary>
public class TtsTests
{
    private static JsonElement Message(JsonElement frame) => frame.Body().GetProperty("message");

    private static bool Tts(JsonElement message) =>
        message.TryGetProperty("tts", out var tts) && tts.ValueKind == JsonValueKind.True;

    [Fact]
    public async Task Admins_send_tts_messages_and_everyone_gets_the_flag()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var bob = await server.JoinAsync("Bob");

        var sent = await admin.RequestAsync("chat.send", new { channelId = server.General, text = "GG everyone", tts = true });
        Assert.Equal("result", sent.Type());
        Assert.True(Tts(Message(sent)));
        Assert.True(Tts(Message(await bob.EventAsync("chat.message"))));

        // A plain message has no flag; the flag survives an edit and is in the history.
        var plain = await admin.RequestAsync("chat.send", new { channelId = server.General, text = "quiet one" });
        Assert.False(Tts(Message(plain)));
        var id = Message(sent).GetProperty("id").GetInt64();
        Assert.Equal("result", (await admin.RequestAsync("chat.edit", new { id, text = "GG all" })).Type());
        var history = (await bob.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        var stored = history.EnumerateArray().First(m => m.GetProperty("id").GetInt64() == id);
        Assert.True(Tts(stored));
        Assert.False(Tts(history.EnumerateArray().First(m => m.GetProperty("text").GetString() == "quiet one")));
    }

    [Fact]
    public async Task Members_need_the_sendTts_permission()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var bob = await server.JoinAsync("Bob");

        var refused = (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "hello", tts = true })).Body();
        Assert.Equal("forbidden", refused.GetProperty("code").GetString());
        Assert.Equal("tts_forbidden", refused.GetProperty("key").GetString());
        // Nothing was stored.
        var history = (await owner.RequestAsync("chat.history", new { channelId = server.General })).Body().GetProperty("messages");
        Assert.Equal(0, history.GetArrayLength());

        // tts: false is just a message; a flag that isn't a boolean is refused.
        Assert.False(Tts(Message(await bob.RequestAsync("chat.send", new { channelId = server.General, text = "hi", tts = false }))));
        Assert.Equal("bad_request", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "hi", tts = "yes" })).ErrorCode());

        // A custom role with the permission lets them; taking it away stops them again.
        var role = (await owner.RequestAsync("role.create", new { name = "Announcer", permissions = new[] { "sendTts" } })).Body().GetProperty("role");
        Assert.Contains("sendTts", role.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()));
        var roleId = role.GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = bob.Key, roles = new[] { roleId } });
        Assert.True(Tts(Message(await bob.RequestAsync("chat.send", new { channelId = server.General, text = "now I can", tts = true }))));
        await owner.RequestAsync("member.roles.set", new { accountKey = bob.Key, roles = Array.Empty<long>() });
        Assert.Equal("tts_forbidden", (await bob.RequestAsync("chat.send", new { channelId = server.General, text = "again", tts = true })).Body().GetProperty("key").GetString());
    }

    [Fact]
    public async Task A_tts_message_needs_text()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var ticket = (await admin.RequestAsync("upload.begin", new { name = "note.txt", size = 5 })).Body();
        using var response = await server.CreateClient().PutAsync(ticket.GetProperty("url").GetString(), new ByteArrayContent("hello"u8.ToArray()));
        var file = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("file").GetProperty("id").GetString();
        var refused = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "", attachments = new[] { file }, tts = true })).Body();
        Assert.Equal("tts_needs_text", refused.GetProperty("key").GetString());
    }
}
