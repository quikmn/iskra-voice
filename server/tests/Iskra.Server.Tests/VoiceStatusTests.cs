using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Voice channel status: who may set and clear it, its text rules, AutoMod, clearing when the call empties, rate limits.</summary>
public class VoiceStatusTests
{
    private static long VoiceChannel(IskraServer server, string name = "lounge", string kind = "voice", string writeRole = "member") =>
        server.World.Store.CreateChannel(name, kind, "member", writeRole, 0).Id;

    private static async Task Webhook(IskraServer server, object evt)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(evt);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit-webhook") { Content = new ByteArrayContent(body) };
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var token = LiveKitTokens.Sign(new JsonObject
        {
            ["iss"] = server.Voice.ApiKey, ["nbf"] = now - 5, ["exp"] = now + 300, ["sha256"] = Convert.ToBase64String(SHA256.HashData(body)),
        }, server.Voice.ApiSecret);
        request.Headers.TryAddWithoutValidation("Authorization", token);
        using var response = await server.CreateClient().SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    private static Task Joined(IskraServer server, long channel, string identity) =>
        Webhook(server, new { @event = "participant_joined", room = new { name = $"voice-{channel}" }, participant = new { identity } });

    private static Task Left(IskraServer server, long channel, string identity) =>
        Webhook(server, new { @event = "participant_left", room = new { name = $"voice-{channel}" }, participant = new { identity } });

    private static Task<JsonElement> SetStatus(User user, long channel, string text) =>
        user.RequestAsync("voice.status.set", new { channelId = channel, text });

    private static string? Key(JsonElement reply) =>
        reply.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    /// <summary>The next voice.state for the channel that carries the status (or null).</summary>
    private static async Task<string?> NextStatus(User user, long channel)
    {
        while (true)
        {
            var state = (await user.EventAsync("voice.state")).Body();
            if (state.GetProperty("channelId").GetInt64() != channel) continue;
            var status = state.GetProperty("status");
            return status.ValueKind == JsonValueKind.Null ? null : status.GetProperty("text").GetString();
        }
    }

    [Fact]
    public async Task People_in_the_call_set_it_everyone_who_can_see_the_channel_sees_it()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        await Joined(server, lounge, alice.Key);
        await NextStatus(bob, lounge);

        var reply = await SetStatus(alice, lounge, "  CS2 ranked 🔫  ");
        Assert.Equal("result", reply.Type());
        var status = reply.Body().GetProperty("status");
        Assert.Equal("CS2 ranked 🔫", status.GetProperty("text").GetString());
        Assert.Equal(alice.Key, status.GetProperty("setBy").GetString());
        Assert.Equal("CS2 ranked 🔫", await NextStatus(bob, lounge));

        // Newcomers get it in the welcome.
        using var carol = await server.JoinAsync("Carol");
        var voice = carol.Welcome.Body().GetProperty("voice").EnumerateArray().Single(v => v.GetProperty("channelId").GetInt64() == lounge);
        Assert.Equal("CS2 ranked 🔫", voice.GetProperty("status").GetProperty("text").GetString());

        // Setting the same text again changes nothing; an empty one clears it.
        Assert.Equal("result", (await SetStatus(alice, lounge, "CS2 ranked 🔫")).Type());
        await bob.NoEventAsync("voice.state");
        Assert.Equal("result", (await SetStatus(alice, lounge, "   ")).Type());
        Assert.Null(await NextStatus(bob, lounge));
    }

    [Fact]
    public async Task Only_people_in_the_call_with_the_permission_may_set_it()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        var listenOnly = VoiceChannel(server, "radio", writeRole: "trusted");
        var stage = VoiceChannel(server, "talks", "stage");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        // Not in the call.
        Assert.Equal("voice_join_first", Key(await SetStatus(alice, lounge, "hi")));
        // Not a voice channel.
        Assert.Equal("voice_status_voice_only", Key(await SetStatus(alice, stage, "hi")));
        Assert.Equal("voice_status_voice_only", Key(await SetStatus(alice, server.General, "hi")));
        // Listeners (no speaking rights) can't, by default.
        await Joined(server, listenOnly, alice.Key);
        var refused = await SetStatus(alice, listenOnly, "hi");
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("voice_status_denied", Key(refused));

        // A role can be denied it in one channel (and allowed it where it couldn't speak).
        var role = (await owner.RequestAsync("role.create", new { name = "Quiet" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = bob.Key, roles = new[] { role } });
        await owner.RequestAsync("member.roles.set", new { accountKey = alice.Key, roles = new[] { role } });
        Assert.Equal("result", (await owner.RequestAsync("channel.overrides.set", new { id = lounge, roleId = role, deny = new[] { "setVoiceStatus" } })).Type());
        Assert.Equal("result", (await owner.RequestAsync("channel.overrides.set", new { id = listenOnly, roleId = role, allow = new[] { "setVoiceStatus" } })).Type());
        await Joined(server, lounge, bob.Key);
        Assert.Equal("voice_status_denied", Key(await SetStatus(bob, lounge, "hi")));
        Assert.Equal("result", (await SetStatus(alice, listenOnly, "hi")).Type());
        var overrides = server.World.Store.GetChannel(lounge)!.Overrides;
        Assert.Contains(overrides, o => o.RoleId == role && o.Deny.HasFlag(Storage.ChannelPerm.SetVoiceStatus));
    }

    [Fact]
    public async Task Text_must_be_one_short_line()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var alice = await server.JoinAsync("Alice");
        await Joined(server, lounge, alice.Key);

        Assert.Equal("voice_status_text", Key(await SetStatus(alice, lounge, new string('a', 61))));
        Assert.Equal("voice_status_text", Key(await SetStatus(alice, lounge, "two\nlines")));
        Assert.Equal("voice_status_text", Key(await SetStatus(alice, lounge, "hidden​text")));
        Assert.Equal("result", (await SetStatus(alice, lounge, new string('a', 60))).Type());
        // Emoji count once each: 60 family emoji (11 UTF-16 units each) is too many units, 20 is fine.
        Assert.Equal("result", (await SetStatus(alice, lounge, string.Concat(Enumerable.Repeat("👨‍👩‍👧‍👦", 20)))).Type());
        Assert.Equal("result", (await SetStatus(alice, lounge, string.Concat(Enumerable.Repeat("🔫", 60)))).Type());
        Assert.Equal("voice_status_text", Key(await SetStatus(alice, lounge, string.Concat(Enumerable.Repeat("🔫", 61)))));
    }

    [Fact]
    public async Task It_clears_when_the_call_empties()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        await Joined(server, lounge, alice.Key);
        await Joined(server, lounge, bob.Key);
        Assert.Equal("result", (await SetStatus(alice, lounge, "movie night")).Type());

        // The one who set it leaves: it stays while anyone is still there.
        await Left(server, lounge, alice.Key);
        Assert.Equal("movie night", server.Services.GetRequiredService<VoiceRegistry>().Statuses.Get(lounge)?.Text);

        // The last one leaves: gone, and readers hear about it.
        await Left(server, lounge, bob.Key);
        Assert.Null(server.Services.GetRequiredService<VoiceRegistry>().Statuses.Get(lounge));
        string? last = "x";
        while (last is not null) last = await NextStatus(carol, lounge);
        await Joined(server, lounge, carol.Key);
        var voice = (await carol.EventAsync("voice.state")).Body();
        Assert.Equal(JsonValueKind.Null, voice.GetProperty("status").ValueKind);

        // LiveKit going away empties every call.
        Assert.Equal("result", (await SetStatus(carol, lounge, "back")).Type());
        server.Voice.Available = false;
        Assert.Null(server.Services.GetRequiredService<VoiceRegistry>().Statuses.Get(lounge));
    }

    [Fact]
    public async Task Moderators_clear_it_from_anywhere_and_that_is_audited()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var mod = await server.JoinAsync("Mod");
        await Joined(server, lounge, alice.Key);
        Assert.Equal("result", (await SetStatus(alice, lounge, "come hang")).Type());

        // Someone outside the call without moderator powers can't touch it.
        Assert.Equal("voice_join_first", Key(await SetStatus(bob, lounge, "")));
        // A moderator outside the call can clear it, but not set one.
        var role = (await owner.RequestAsync("role.create", new { name = "Voice mods", permissions = new[] { "muteMembers" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { role } });
        Assert.Equal("voice_join_first", Key(await SetStatus(mod, lounge, "mine now")));
        Assert.Equal("result", (await SetStatus(mod, lounge, "")).Type());
        Assert.Null(server.Services.GetRequiredService<VoiceRegistry>().Statuses.Get(lounge));

        var entries = (await owner.RequestAsync("audit.list", new { action = "voice.status.clear" })).Body().GetProperty("entries");
        var entry = Assert.Single(entries.EnumerateArray());
        Assert.Equal(alice.Key, entry.GetProperty("target").GetString());
        Assert.DoesNotContain("come hang", entry.GetRawText()); // never the text

        // People in the call clearing their own channel's status aren't audited.
        Assert.Equal("result", (await SetStatus(alice, lounge, "again")).Type());
        Assert.Equal("result", (await SetStatus(alice, lounge, "")).Type());
        entries = (await owner.RequestAsync("audit.list", new { action = "voice.status.clear" })).Body().GetProperty("entries");
        Assert.Single(entries.EnumerateArray());
    }

    [Fact]
    public async Task AutoMod_checks_the_text()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        await Joined(server, lounge, alice.Key);
        await admin.RequestAsync("automod.update", new
        {
            automod = new
            {
                enabled = true, words = new { enabled = true, blocked = new[] { "bad" } }, mentions = new { enabled = false },
                flood = new { enabled = false }, duplicates = new { enabled = false }, links = new { enabled = false },
                exemptRoles = Array.Empty<long>(), exemptChannels = Array.Empty<long>(), alertChannelId = (long?)null,
            },
        });

        var refused = await SetStatus(alice, lounge, "so ＢＡＤ");
        Assert.Equal("automod", refused.ErrorCode());
        Assert.Null(server.Services.GetRequiredService<VoiceRegistry>().Statuses.Get(lounge));
        var audit = (await admin.RequestAsync("audit.list", new { action = "automod.block" })).Body().GetProperty("entries");
        Assert.Contains("voicestatus", Assert.Single(audit.EnumerateArray()).GetProperty("details").GetRawText());
        Assert.Equal("result", (await SetStatus(alice, lounge, "so good")).Type());
    }

    [Fact]
    public async Task Changes_are_rate_limited_per_account()
    {
        using var server = new IskraServer();
        var lounge = VoiceChannel(server);
        using var alice = await server.JoinAsync("Alice");
        await Joined(server, lounge, alice.Key);
        for (var i = 0; i < 5; i++) Assert.Equal("result", (await SetStatus(alice, lounge, $"status {i}")).Type());
        var refused = await SetStatus(alice, lounge, "one more");
        Assert.Equal("rate_limited", refused.ErrorCode());
        Assert.Equal("voice_status_slow", Key(refused));
        // Someone else has their own allowance.
        using var bob = await server.JoinAsync("Bob");
        await Joined(server, lounge, bob.Key);
        Assert.Equal("result", (await SetStatus(bob, lounge, "mine")).Type());
    }
}
