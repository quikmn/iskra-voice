using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Templates;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>The AFK channel: admin-only setting, forced mute and deafen through LiveKit, and moving idle people there.</summary>
public class AfkTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static long Channel(IskraServer server, string name, string kind = "voice") =>
        server.World.Store.CreateChannel(name, kind, "member", "member", 0).Id;

    private static JsonElement Claims(IskraServer server, string token) =>
        LiveKitTokens.Verify(token, server.Voice.ApiKey, server.Voice.ApiSecret, DateTimeOffset.UtcNow)
        ?? throw new Xunit.Sdk.XunitException("token did not verify");

    private static async Task<long> CreateRole(User by, string name)
    {
        var result = await by.RequestAsync("role.create", new { name });
        return result.Body().GetProperty("role").GetProperty("id").GetInt64();
    }

    [Fact]
    public async Task Only_admins_change_the_setting_and_it_is_checked()
    {
        using var server = new IskraServer();
        var afkRoom = Channel(server, "AFK");
        var stage = Channel(server, "talks", "stage");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        var initial = (await member.RequestAsync("afk.get")).Body().GetProperty("afk");
        Assert.Equal(JsonValueKind.Null, initial.GetProperty("channelId").ValueKind);
        Assert.Equal(30, initial.GetProperty("idleMinutes").GetInt32());
        Assert.Equal(["owner", "admin"], initial.GetProperty("talkLevels").EnumerateArray().Select(l => l.GetString()));

        var refused = (await member.RequestAsync("afk.update", new { channelId = afkRoom })).Body();
        Assert.Equal("forbidden", refused.GetProperty("code").GetString());
        Assert.Equal("admins_afk", refused.GetProperty("key").GetString());
        Assert.Null(server.World.Store.Afk().ChannelId);

        async Task<string?> Key(object body) => (await admin.RequestAsync("afk.update", body)).Body().GetProperty("key").GetString();
        Assert.Equal("afk_voice_only", await Key(new { channelId = stage }));
        Assert.Equal("afk_voice_only", await Key(new { channelId = server.General }));
        Assert.Equal("afk_voice_only", await Key(new { channelId = 99999 }));
        Assert.Equal("afk_minutes", await Key(new { idleMinutes = 10 }));
        Assert.Equal("afk_levels", await Key(new { talkLevels = new[] { "boss" } }));
        Assert.Equal("afk_roles", await Key(new { talkRoles = new[] { 12345 } }));

        var mods = await CreateRole(owner, "Mods");
        var saved = (await admin.RequestAsync("afk.update", new { channelId = afkRoom, idleMinutes = 15, talkRoles = new[] { mods } })).Body().GetProperty("afk");
        Assert.Equal(afkRoom, saved.GetProperty("channelId").GetInt64());
        var seen = (await member.EventAsync("afk")).Body().GetProperty("afk");
        Assert.Equal(15, seen.GetProperty("idleMinutes").GetInt32());
        Assert.Equal([mods], server.World.Store.Afk().TalkRoles);
        Assert.Single(server.World.Store.Audit("afk.update", null, null, 50));

        // A deleted role leaves the list; a deleted channel turns it off; null turns it off too.
        await owner.RequestAsync("role.delete", new { id = mods });
        Assert.Empty(server.World.Store.Afk().TalkRoles);
        await admin.RequestAsync("afk.update", new { channelId = (long?)null });
        Assert.Null(server.World.Store.Afk().ChannelId);
        await admin.RequestAsync("afk.update", new { channelId = afkRoom });
        await admin.RequestAsync("channel.delete", new { id = afkRoom });
        Assert.Null(server.World.Store.Afk().ChannelId);
        Assert.Equal(15, server.World.Store.Afk().IdleMinutes);
    }

    [Fact]
    public async Task In_the_AFK_channel_only_talk_roles_can_speak_or_hear()
    {
        using var server = new IskraServer();
        var afkRoom = Channel(server, "AFK");
        var lounge = Channel(server, "lounge");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        using var helper = await server.JoinAsync("Helper");
        var helpers = await CreateRole(owner, "Helpers");
        await owner.RequestAsync("member.roles.set", new { accountKey = helper.Key, roles = new[] { helpers } });
        await owner.RequestAsync("afk.update", new { channelId = afkRoom, talkRoles = new[] { helpers } });

        // Elsewhere nothing changes.
        var normal = (await member.RequestAsync("voice.join", new { channelId = lounge })).Body();
        Assert.True(normal.GetProperty("canSpeak").GetBoolean());
        Assert.True(normal.GetProperty("canHear").GetBoolean());
        Assert.False(normal.GetProperty("afk").GetBoolean());

        // A plain member: no publishing and no subscribing in the token itself, so a modified app can't get around it.
        var forced = (await member.RequestAsync("voice.join", new { channelId = afkRoom })).Body();
        Assert.False(forced.GetProperty("canSpeak").GetBoolean());
        Assert.False(forced.GetProperty("canHear").GetBoolean());
        Assert.True(forced.GetProperty("afk").GetBoolean());
        var grant = Claims(server, forced.GetProperty("token").GetString()!).GetProperty("video");
        Assert.False(grant.GetProperty("canPublish").GetBoolean());
        Assert.False(grant.GetProperty("canSubscribe").GetBoolean());

        // The owner (a talk level) and a member with a talk role can.
        foreach (var user in new[] { owner, helper })
        {
            var allowed = (await user.RequestAsync("voice.join", new { channelId = afkRoom })).Body();
            Assert.True(allowed.GetProperty("canSpeak").GetBoolean());
            Assert.True(allowed.GetProperty("canHear").GetBoolean());
            Assert.True(Claims(server, allowed.GetProperty("token").GetString()!).GetProperty("video").GetProperty("canSubscribe").GetBoolean());
        }

        // In the room: LiveKit is told on joining, others see it, and a server unmute doesn't lift it.
        var voice = server.Services.GetRequiredService<VoiceRegistry>();
        voice.Joined(afkRoom, member.Key, Now);
        voice.Joined(afkRoom, helper.Key, Now);
        Assert.Contains(($"voice-{afkRoom}", member.Key, false, false), server.Voice.FullPermissions);
        Assert.Contains(($"voice-{afkRoom}", helper.Key, true, true), server.Voice.FullPermissions);
        var state = (await owner.EventAsync("voice.state")).Body();
        while (state.GetProperty("participants").GetArrayLength() < 2) state = (await owner.EventAsync("voice.state")).Body();
        var flags = state.GetProperty("participants").EnumerateArray().ToDictionary(p => p.GetProperty("accountKey").GetString()!, p => p.GetProperty("afk").GetBoolean());
        Assert.True(flags[member.Key]);
        Assert.False(flags[helper.Key]);
        await owner.RequestAsync("voice.mute", new { accountKey = member.Key, muted = false });
        Assert.DoesNotContain(server.Voice.Updated, u => u.Identity == member.Key && u.CanPublish);

        // Taking the role away while they're inside mutes and deafens them at once; giving it to the member frees them.
        server.Voice.FullPermissions.Clear();
        await owner.RequestAsync("member.roles.set", new { accountKey = helper.Key, roles = Array.Empty<long>() });
        Assert.Contains(($"voice-{afkRoom}", helper.Key, false, false), server.Voice.FullPermissions);
        await owner.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { helpers } });
        Assert.Contains(($"voice-{afkRoom}", member.Key, true, true), server.Voice.FullPermissions);

        // Turning the AFK channel off frees everyone.
        server.Voice.FullPermissions.Clear();
        await owner.RequestAsync("afk.update", new { channelId = (long?)null });
        Assert.Contains(($"voice-{afkRoom}", helper.Key, true, true), server.Voice.FullPermissions);
    }

    [Fact]
    public async Task Idle_people_are_moved_after_the_timeout_and_never_while_active()
    {
        using var server = new IskraServer();
        var afkRoom = Channel(server, "AFK");
        var lounge = Channel(server, "lounge");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var idler = await server.JoinAsync("Idler");
        using var talker = await server.JoinAsync("Talker");
        using var silent = await server.JoinAsync("Silent"); // never reports: an older app counts as active
        await owner.RequestAsync("afk.update", new { channelId = afkRoom, idleMinutes = 30 });
        var voice = server.Services.GetRequiredService<VoiceRegistry>();
        var sweeper = server.Services.GetRequiredService<AfkSweeper>();
        foreach (var user in new[] { idler, talker, silent }) voice.Joined(lounge, user.Key, Now);

        var start = Now;
        Assert.Equal("result", (await idler.RequestAsync("voice.idle", new { idle = true, idleMs = 60_000 })).Type());
        Assert.Equal("result", (await talker.RequestAsync("voice.idle", new { idle = true, idleMs = 60_000 })).Type());
        Assert.Equal("bad_request", (await talker.RequestAsync("voice.idle", new { idle = true, idleMs = 3_600_001 })).ErrorCode());

        // Speaking or input again: the app says so and the clock starts over.
        Assert.Equal(0, sweeper.Sweep(start + 20 * 60_000));
        await talker.RequestAsync("voice.idle", new { idle = false });

        // Idle since a minute before start: due at start + 29 minutes, not before.
        Assert.Equal(0, sweeper.Sweep(start + 28 * 60_000));
        Assert.Equal(1, sweeper.Sweep(start + 29 * 60_000 + 1_000));
        var moved = (await idler.EventAsync("voice.moved")).Body();
        Assert.Equal(afkRoom, moved.GetProperty("channelId").GetInt64());
        Assert.Equal("afk", moved.GetProperty("reason").GetString());
        Assert.Contains(($"voice-{lounge}", idler.Key), server.Voice.Removed);
        Assert.Null(voice.ChannelOfMember(idler.Key));
        Assert.Equal(lounge, voice.ChannelOfMember(talker.Key));
        Assert.Equal(lounge, voice.ChannelOfMember(silent.Key));

        // Not twice within a minute (back in the lounge, still idle); and nobody is moved out of the AFK channel.
        voice.Joined(lounge, idler.Key, Now);
        Assert.Equal(0, sweeper.Sweep(start + 29 * 60_000 + 30_000));
        Assert.Equal(1, sweeper.Sweep(start + 31 * 60_000));
        voice.Joined(afkRoom, idler.Key, Now);
        Assert.Equal(0, sweeper.Sweep(start + 40 * 60_000));
    }

    [Fact]
    public async Task Every_session_must_be_idle_and_off_means_never()
    {
        using var server = new IskraServer();
        var afkRoom = Channel(server, "AFK");
        var lounge = Channel(server, "lounge");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var alice = await server.JoinAsync("Alice");
        using var phone = await server.ConnectAsync();
        await phone.LoginAsync(new TestIdentity(alice.Identity.Account), "Alice");
        await owner.RequestAsync("afk.update", new { channelId = afkRoom, idleMinutes = 5 });
        var voice = server.Services.GetRequiredService<VoiceRegistry>();
        var sweeper = server.Services.GetRequiredService<AfkSweeper>();
        voice.Joined(lounge, alice.Key, Now);
        var start = Now;

        await alice.RequestAsync("voice.idle", new { idle = true });
        Assert.Equal(0, sweeper.Sweep(start + 10 * 60_000)); // the phone is still active
        await phone.RequestAsync("voice.idle", new { idle = true, idleMs = 0 });

        await owner.RequestAsync("afk.update", new { idleMinutes = 0 });
        Assert.Equal(0, sweeper.Sweep(start + 60 * 60_000));
        await owner.RequestAsync("afk.update", new { idleMinutes = 5 });
        Assert.Equal(1, sweeper.Sweep(start + 6 * 60_000));
    }

    [Fact]
    public async Task Someone_who_cannot_join_the_AFK_channel_is_not_moved()
    {
        using var server = new IskraServer();
        var afkRoom = server.World.Store.CreateChannel("AFK", "voice", "trusted", "trusted", 0).Id;
        var lounge = Channel(server, "lounge");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        await owner.RequestAsync("afk.update", new { channelId = afkRoom, idleMinutes = 5 });
        var voice = server.Services.GetRequiredService<VoiceRegistry>();
        voice.Joined(lounge, member.Key, Now);
        await member.RequestAsync("voice.idle", new { idle = true });
        Assert.Equal(0, server.Services.GetRequiredService<AfkSweeper>().Sweep(Now + 60 * 60_000));
        Assert.Equal(lounge, voice.ChannelOfMember(member.Key));
    }

    [Fact]
    public void The_gaming_and_friends_templates_have_an_AFK_channel()
    {
        foreach (var id in new[] { "gaming", "friends" })
        {
            var afk = ServerTemplates.Load(id).Afk;
            Assert.NotNull(afk);
            Assert.Equal("AFK", afk.Channel);
            Assert.Equal(30, afk.Minutes);
        }
    }
}
