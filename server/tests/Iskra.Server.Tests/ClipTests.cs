using System.Text.Json;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Text chat in voice and stage channels, and the consent side of clips (the "clips on" flag and the notice).</summary>
public class ClipTests
{
    private static long Channel(IskraServer server, string kind = "voice", string read = "member", string write = "member") =>
        server.World.Store.CreateChannel(kind == "voice" ? "lounge" : "town-hall", kind, read, write, 0).Id;

    private static void InVoice(IskraServer server, long channelId, User user) =>
        server.Services.GetRequiredService<VoiceRegistry>().Joined(channelId, user.Key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    [Theory]
    [InlineData("voice")]
    [InlineData("stage")]
    public async Task Voice_and_stage_channels_have_their_own_text_chat(string kind)
    {
        using var server = new IskraServer();
        var channel = Channel(server, kind);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        var sent = await alice.RequestAsync("chat.send", new { channelId = channel, text = "can you hear me?" });
        var message = sent.Body().GetProperty("message");
        Assert.Equal(channel, message.GetProperty("channelId").GetInt64());
        Assert.Equal(JsonValueKind.Null, message.GetProperty("clip").ValueKind);
        var seen = (await bob.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal("can you hear me?", seen.GetProperty("text").GetString());

        var id = message.GetProperty("id").GetInt64();
        Assert.Equal("result", (await bob.RequestAsync("chat.send", new { channelId = channel, text = "yes", replyTo = id })).Type());
        Assert.Equal("result", (await bob.RequestAsync("chat.react", new { id, emoji = "👍" })).Type());
        Assert.Equal("result", (await alice.RequestAsync("chat.edit", new { id, text = "can you hear me now?" })).Type());
        Assert.Equal("result", (await alice.RequestAsync("chat.typing", new { channelId = channel })).Type());
        var history = (await bob.RequestAsync("chat.history", new { channelId = channel })).Body().GetProperty("messages");
        Assert.Equal(2, history.GetArrayLength());

        // Search finds it like any other message.
        var found = (await bob.RequestAsync("search", new { query = "hear" })).Body();
        Assert.Contains(found.GetProperty("results").EnumerateArray(), r => r.GetProperty("message").GetProperty("id").GetInt64() == id);
    }

    [Fact]
    public async Task Who_may_post_follows_the_voice_channels_permissions()
    {
        using var server = new IskraServer();
        var listenOnly = Channel(server, write: "trusted");
        var hidden = server.World.Store.CreateChannel("staff-voice", "voice", "admin", "admin", 0).Id;
        using var member = await server.JoinAsync("Member");
        using var trusted = await server.JoinAsync("Trusted", "trusted");

        Assert.Equal("forbidden", (await member.RequestAsync("chat.send", new { channelId = listenOnly, text = "hi" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("chat.typing", new { channelId = listenOnly })).ErrorCode());
        Assert.Equal("result", (await member.RequestAsync("chat.history", new { channelId = listenOnly })).Type());
        Assert.Equal("result", (await trusted.RequestAsync("chat.send", new { channelId = listenOnly, text = "hi" })).Type());
        Assert.Equal("not_found", (await member.RequestAsync("chat.send", new { channelId = hidden, text = "hi" })).ErrorCode());
        Assert.Equal("not_found", (await member.RequestAsync("chat.history", new { channelId = hidden })).ErrorCode());

        // Polls and threads stay in text channels.
        var voice = Channel(server);
        var id = (await member.RequestAsync("chat.send", new { channelId = voice, text = "a" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await member.RequestAsync("thread.create", new { messageId = id, name = "t" })).ErrorCode());
    }

    [Fact]
    public async Task Slowmode_applies_in_voice_chat()
    {
        using var server = new IskraServer();
        var voice = Channel(server);
        server.World.Store.SetSlowmode(voice, 30);
        using var member = await server.JoinAsync("Member");
        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = voice, text = "one" })).Type());
        Assert.Equal("rate_limited", (await member.RequestAsync("chat.send", new { channelId = voice, text = "two" })).ErrorCode());
    }

    [Fact]
    public async Task Clips_on_is_shown_to_everyone_in_the_call()
    {
        using var server = new IskraServer();
        var voice = Channel(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        InVoice(server, voice, alice);
        InVoice(server, voice, bob);

        await alice.RequestAsync("voice.state", new { muted = false, deafened = false, clips = true });
        JsonElement state;
        do state = (await bob.EventAsync("voice.state")).Body();
        while (!state.GetProperty("participants").EnumerateArray().Any(p => p.GetProperty("clips").GetBoolean()));
        var flags = state.GetProperty("participants").EnumerateArray().ToDictionary(p => p.GetProperty("accountKey").GetString()!, p => p.GetProperty("clips").GetBoolean());
        Assert.True(flags[alice.Key]);
        Assert.False(flags[bob.Key]);

        // Mute changes without "clips" keep it on.
        await alice.RequestAsync("voice.state", new { muted = true, deafened = false });
        Assert.True(server.Services.GetRequiredService<VoiceRegistry>().Participant(voice, alice.Key)!.Clips);
        await alice.RequestAsync("voice.state", new { muted = true, deafened = false, clips = false });
        Assert.False(server.Services.GetRequiredService<VoiceRegistry>().Participant(voice, alice.Key)!.Clips);
    }

    [Fact]
    public async Task Saving_a_clip_posts_a_notice_the_saver_cant_hide()
    {
        using var server = new IskraServer();
        var voice = Channel(server);
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var admin = await server.JoinAsync("Admin", "admin");

        // Only from inside the call, and only with clips turned on beforehand.
        Assert.Equal("forbidden", (await alice.RequestAsync("voice.clip", new { channelId = voice })).ErrorCode());
        InVoice(server, voice, alice);
        Assert.Equal("bad_request", (await alice.RequestAsync("voice.clip", new { channelId = voice })).ErrorCode());
        await alice.RequestAsync("voice.state", new { muted = false, deafened = false, clips = true });

        var saved = (await alice.RequestAsync("voice.clip", new { channelId = voice })).Body().GetProperty("message");
        Assert.Equal(alice.Key, saved.GetProperty("author").GetString());
        Assert.Equal("", saved.GetProperty("text").GetString());
        Assert.Equal(JsonValueKind.Object, saved.GetProperty("clip").ValueKind);
        var seen = (await bob.EventAsync("chat.message")).Body().GetProperty("message");
        Assert.Equal(saved.GetProperty("id").GetInt64(), seen.GetProperty("id").GetInt64());
        Assert.Equal(JsonValueKind.Object, seen.GetProperty("clip").ValueKind);

        var id = saved.GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await alice.RequestAsync("chat.edit", new { id, text = "nothing to see" })).ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("chat.delete", new { id })).ErrorCode());
        Assert.Equal(JsonValueKind.Object, (await bob.RequestAsync("chat.history", new { channelId = voice })).Body()
            .GetProperty("messages")[0].GetProperty("clip").ValueKind);
        Assert.Equal("result", (await admin.RequestAsync("chat.delete", new { id })).Type());
    }

    [Fact]
    public async Task Clip_notices_are_rate_limited_and_hidden_from_non_readers()
    {
        using var server = new IskraServer();
        var voice = server.World.Store.CreateChannel("staff", "voice", "trusted", "trusted", 0).Id;
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var member = await server.JoinAsync("Member");
        InVoice(server, voice, trusted);
        await trusted.RequestAsync("voice.state", new { muted = false, deafened = false, clips = true });

        for (var i = 0; i < 3; i++) Assert.Equal("result", (await trusted.RequestAsync("voice.clip", new { channelId = voice })).Type());
        Assert.Equal("rate_limited", (await trusted.RequestAsync("voice.clip", new { channelId = voice })).ErrorCode());
        await member.NoEventAsync("chat.message");
        Assert.Equal("not_found", (await member.RequestAsync("voice.clip", new { channelId = voice })).ErrorCode());
        Assert.Equal("bad_request", (await member.RequestAsync("voice.clip", new { channelId = server.General })).ErrorCode());
    }
}
