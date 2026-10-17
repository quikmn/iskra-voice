using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;
using static Iskra.Server.Tests.OutgoingWebhookTests;

namespace Iskra.Server.Tests;

/// <summary>The second set of outgoing webhook events: voice, threads, edits and deletions, members, roles and channels.</summary>
public class OutgoingWebhookEventTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>The next <paramref name="count"/> deliveries (they aren't ordered), as (type, data).</summary>
    private static async Task<List<(string Type, JsonElement Data)>> Take(Receiver receiver, int count, string? secret = null)
    {
        var list = new List<(string, JsonElement)>();
        for (var i = 0; i < count; i++)
        {
            var request = await receiver.NextAsync();
            if (secret is not null) AssertSigned(request, secret);
            var root = JsonDocument.Parse(request.Body).RootElement.Clone();
            Assert.Equal(root.GetProperty("type").GetString(), request.Headers["Iskra-Webhook-Event"]);
            list.Add((root.GetProperty("type").GetString()!, root.GetProperty("data")));
        }
        return list;
    }

    private static async Task<long> Channel(User owner, object body) =>
        (await owner.RequestAsync("channel.create", body)).Body().GetProperty("channel").GetProperty("id").GetInt64();

    [Fact]
    public async Task Channel_events_need_channels()
    {
        using var server = OutgoingWebhookTests.Server();
        using var owner = await server.JoinAsync("Owner", "owner");
        foreach (var e in new[] { "voice.joined", "voice.left", "thread.created", "message.updated", "message.deleted" })
        {
            var refused = await owner.RequestAsync("outhook.create", new { name = "x", url = "https://203.0.113.10/", events = new[] { e } });
            Assert.Equal("outhook_channels", refused.Body().GetProperty("key").GetString());
        }
        Assert.Equal("bad_request", (await owner.RequestAsync("outhook.create",
            new { name = "x", url = "https://203.0.113.10/", events = new[] { "voice.started" } })).ErrorCode());
    }

    [Fact]
    public async Task Voice_joins_and_leaves_in_chosen_channels_without_audio_details()
    {
        using var server = OutgoingWebhookTests.Server();
        using var receiver = new Receiver();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        var lounge = await Channel(owner, new { name = "Lounge", kind = "voice" });
        var other = await Channel(owner, new { name = "Other", kind = "voice" });
        var (_, secret) = await Create(owner, receiver.Url, ["voice.joined", "voice.left"], [lounge]);
        var voice = server.Services.GetRequiredService<VoiceRegistry>();

        voice.Joined(other, alice.Key, Now);
        voice.Joined(lounge, alice.Key, Now);
        var joined = Assert.Single(await Take(receiver, 1, secret));
        Assert.Equal("voice.joined", joined.Type);
        Assert.Equal(lounge, joined.Data.GetProperty("channel").GetProperty("id").GetInt64());
        Assert.Equal("lounge", joined.Data.GetProperty("channel").GetProperty("name").GetString());
        Assert.Equal(alice.Key, joined.Data.GetProperty("member").GetProperty("accountKey").GetString());
        Assert.Equal(["channel", "member"], joined.Data.EnumerateObject().Select(p => p.Name).Order());
        Assert.Equal(["accountKey", "bot", "name"], joined.Data.GetProperty("member").EnumerateObject().Select(p => p.Name).Order());

        // Mute changes are no event; leaving is.
        voice.SetFlags(alice.Key, muted: true, deafened: false);
        voice.Left(lounge, alice.Key);
        var left = Assert.Single(await Take(receiver, 1));
        Assert.Equal("voice.left", left.Type);
        Assert.Equal(alice.Key, left.Data.GetProperty("member").GetProperty("accountKey").GetString());
        voice.Left(other, alice.Key);
        await receiver.NothingAsync();
    }

    [Fact]
    public async Task Threads_edits_and_deletions_in_chosen_channels_and_never_encrypted_ones()
    {
        using var server = OutgoingWebhookTests.Server();
        using var receiver = new Receiver();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        var other = await Channel(owner, new { name = "other" });
        var (_, secret) = await Create(owner, receiver.Url, ["thread.created", "message.updated", "message.deleted"], [server.General]);

        var elsewhere = (await alice.RequestAsync("chat.send", new { channelId = other, text = "x" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        await alice.RequestAsync("chat.edit", new { id = elsewhere, text = "y" });
        var id = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "first try" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("result", (await alice.RequestAsync("chat.edit", new { id, text = "second try" })).Type());
        var edited = Assert.Single(await Take(receiver, 1, secret));
        Assert.Equal("message.updated", edited.Type);
        var message = edited.Data.GetProperty("message");
        Assert.Equal(id, message.GetProperty("id").GetInt64());
        Assert.Equal("second try", message.GetProperty("text").GetString());
        Assert.True(message.GetProperty("editedAt").GetInt64() > 0);
        Assert.Equal("general", message.GetProperty("channel").GetProperty("name").GetString());

        var thread = (await alice.RequestAsync("thread.create", new { messageId = id, name = "Plans" })).Body().GetProperty("thread");
        var created = Assert.Single(await Take(receiver, 1));
        Assert.Equal("thread.created", created.Type);
        Assert.Equal(thread.GetProperty("id").GetInt64(), created.Data.GetProperty("thread").GetProperty("id").GetInt64());
        Assert.Equal("Plans", created.Data.GetProperty("thread").GetProperty("name").GetString());
        Assert.Equal(id, created.Data.GetProperty("thread").GetProperty("rootId").GetInt64());
        Assert.Equal(alice.Key, created.Data.GetProperty("thread").GetProperty("createdBy").GetProperty("accountKey").GetString());

        // Deletions: only which message, never its text. Also by a moderator in bulk.
        Assert.Equal("result", (await alice.RequestAsync("chat.delete", new { id })).Type());
        var deleted = Assert.Single(await Take(receiver, 1));
        Assert.Equal("message.deleted", deleted.Type);
        Assert.Equal(id, deleted.Data.GetProperty("messageId").GetInt64());
        Assert.Equal(["channel", "messageId"], deleted.Data.EnumerateObject().Select(p => p.Name).Order());
        Assert.DoesNotContain("second try", deleted.Data.GetRawText());
        var a = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "a" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        var b = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "b" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("result", (await owner.RequestAsync("chat.delete.bulk", new { channelId = server.General, ids = new[] { a, b } })).Type());
        var bulk = await Take(receiver, 2);
        Assert.All(bulk, d => Assert.Equal("message.deleted", d.Type));
        Assert.Equal([a, b], bulk.Select(d => d.Data.GetProperty("messageId").GetInt64()).Order());

        // A channel that became end-to-end encrypted sends nothing more.
        var kept = (await alice.RequestAsync("chat.send", new { channelId = server.General, text = "c" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        server.World.Store.SaveE2eeChange(new E2eeChannel(server.General, "chain", 1, "head", [owner.Key], 1),
            new E2eeChange(1, "{}", "sig", owner.Key, 1), [], fresh: true);
        var hooks = server.Services.GetRequiredService<OutgoingWebhooks>();
        var general = server.World.Store.GetChannel(server.General)!;
        hooks.MessageUpdated(general, server.World.Store.GetMessage(kept)!);
        hooks.MessageDeleted(general, kept);
        hooks.ThreadCreated(general, new ThreadInfo(99, general.Id, kept, "x", alice.Key, Now, 0, null));
        await receiver.NothingAsync();
    }

    [Fact]
    public async Task Member_and_role_changes_without_private_profile_data()
    {
        using var server = OutgoingWebhookTests.Server();
        using var receiver = new Receiver();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        await alice.RequestAsync("profile.update", new { name = "Alice", bio = "my secret bio", pronouns = "she/her" });
        var (_, secret) = await Create(owner, receiver.Url, ["member.updated", "role.created", "role.updated", "role.deleted"]);

        var role = (await owner.RequestAsync("role.create", new { name = "Raiders", color = "#ff0000" })).Body().GetProperty("role");
        var roleId = role.GetProperty("id").GetInt64();
        var created = Assert.Single(await Take(receiver, 1, secret));
        Assert.Equal("role.created", created.Type);
        Assert.Equal("Raiders", created.Data.GetProperty("role").GetProperty("name").GetString());
        Assert.Equal(roleId, created.Data.GetProperty("role").GetProperty("id").GetInt64());

        Assert.Equal("result", (await owner.RequestAsync("role.update", new { id = roleId, name = "Night raiders" })).Type());
        var updated = Assert.Single(await Take(receiver, 1));
        Assert.Equal("role.updated", updated.Type);
        Assert.Equal("Night raiders", updated.Data.GetProperty("role").GetProperty("name").GetString());

        Assert.Equal("result", (await owner.RequestAsync("member.roles.set", new { accountKey = alice.Key, roles = new[] { roleId } })).Type());
        var roles = Assert.Single(await Take(receiver, 1));
        Assert.Equal("member.updated", roles.Type);
        Assert.Equal(["roles"], roles.Data.GetProperty("changes").EnumerateArray().Select(c => c.GetString()));
        var member = roles.Data.GetProperty("member");
        Assert.Equal(alice.Key, member.GetProperty("accountKey").GetString());
        Assert.Equal("Night raiders", member.GetProperty("roles")[0].GetProperty("name").GetString());
        Assert.Equal(["accountKey", "bot", "name", "nick", "role", "roles"], member.EnumerateObject().Select(p => p.Name).Order());
        Assert.DoesNotContain("secret bio", roles.Data.GetRawText());
        Assert.DoesNotContain("she/her", roles.Data.GetRawText());

        Assert.Equal("result", (await owner.RequestAsync("member.setRole", new { accountKey = alice.Key, role = "trusted" })).Type());
        var level = Assert.Single(await Take(receiver, 1));
        Assert.Equal(["role"], level.Data.GetProperty("changes").EnumerateArray().Select(c => c.GetString()));
        Assert.Equal("trusted", level.Data.GetProperty("member").GetProperty("role").GetString());

        Assert.Equal("result", (await alice.RequestAsync("member.nick", new { nick = "Ali" })).Type());
        var nick = Assert.Single(await Take(receiver, 1));
        Assert.Equal(["nick"], nick.Data.GetProperty("changes").EnumerateArray().Select(c => c.GetString()));
        Assert.Equal("Ali", nick.Data.GetProperty("member").GetProperty("nick").GetString());

        // Profile changes (name, bio, avatar) are not member.updated: that's the member's own profile.
        await alice.RequestAsync("profile.update", new { name = "Alicia", bio = "other" });
        await receiver.NothingAsync();

        Assert.Equal("result", (await owner.RequestAsync("role.delete", new { id = roleId })).Type());
        var deleted = Assert.Single(await Take(receiver, 1));
        Assert.Equal("role.deleted", deleted.Type);
        Assert.Equal(["id", "name"], deleted.Data.GetProperty("role").EnumerateObject().Select(p => p.Name).Order());
    }

    [Fact]
    public async Task Channel_changes_only_for_channels_everyone_can_read_or_the_webhook_lists()
    {
        using var server = OutgoingWebhookTests.Server();
        using var receiver = new Receiver();
        using var owner = await server.JoinAsync("Owner", "owner");
        var listed = await Channel(owner, new { name = "listed", readRole = "admin" });
        var (_, secret) = await Create(owner, receiver.Url, ["channel.created", "channel.updated", "channel.deleted"], [listed]);

        var hidden = await Channel(owner, new { name = "staff", readRole = "admin" });
        var open = await Channel(owner, new { name = "games" });
        var created = Assert.Single(await Take(receiver, 1, secret));
        Assert.Equal("channel.created", created.Type);
        Assert.Equal(open, created.Data.GetProperty("channel").GetProperty("id").GetInt64());
        Assert.Equal("games", created.Data.GetProperty("channel").GetProperty("name").GetString());

        Assert.Equal("result", (await owner.RequestAsync("channel.update", new { id = hidden, name = "staff-room" })).Type());
        Assert.Equal("result", (await owner.RequestAsync("channel.update", new { id = open, name = "gaming", topic = "secret topic text" })).Type());
        var updated = Assert.Single(await Take(receiver, 1));
        Assert.Equal("channel.updated", updated.Type);
        Assert.Equal("gaming", updated.Data.GetProperty("channel").GetProperty("name").GetString());
        Assert.Equal(["name", "topic"], updated.Data.GetProperty("changes").EnumerateArray().Select(c => c.GetString()).Order());
        Assert.DoesNotContain("secret topic text", updated.Data.GetRawText());

        // A private channel the webhook lists is sent.
        Assert.Equal("result", (await owner.RequestAsync("channel.update", new { id = listed, name = "listed-2" })).Type());
        Assert.Equal(listed, Assert.Single(await Take(receiver, 1)).Data.GetProperty("channel").GetProperty("id").GetInt64());

        Assert.Equal("result", (await owner.RequestAsync("channel.delete", new { id = hidden })).Type());
        Assert.Equal("result", (await owner.RequestAsync("channel.delete", new { id = open })).Type());
        var deleted = Assert.Single(await Take(receiver, 1));
        Assert.Equal("channel.deleted", deleted.Type);
        Assert.Equal(open, deleted.Data.GetProperty("channel").GetProperty("id").GetInt64());
        await receiver.NothingAsync();
    }
}
