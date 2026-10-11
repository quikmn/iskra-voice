using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

public class RoleTests
{
    private static readonly string[] ModeratorPerms =
    [
        "manageMessages", "timeoutMembers", "kickMembers", "banMembers", "manageChannels", "manageRoles", "viewAuditLog",
        "manageExpressions", "manageWebhooks", "mentionEveryone", "moveMembers", "muteMembers",
    ];

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task<long> CreateRole(User by, string name, string[]? permissions = null, string? color = null)
    {
        var result = await by.RequestAsync("role.create", new { name, permissions = permissions ?? [], color });
        Assert.Equal("result", result.Type());
        return result.Body().GetProperty("role").GetProperty("id").GetInt64();
    }

    private static async Task Give(User by, User to, params long[] roles) =>
        Assert.Equal("result", (await by.RequestAsync("member.roles.set", new { accountKey = to.Key, roles })).Type());

    private static long[] Ids(JsonElement roles) => roles.EnumerateArray().Select(r => r.GetProperty("id").GetInt64()).ToArray();

    [Fact]
    public void The_hierarchy_is_owner_then_admins_then_custom_roles_then_levels()
    {
        Iskra.Server.Storage.Member M(string level, int top = 0, Iskra.Server.Storage.Perm perms = 0) =>
            new("k" + level + top, level, level, 0) { TopPosition = top, Perms = perms, RoleIds = top > 0 ? [top] : [] };
        var owner = M("owner");
        var admin = M("admin");
        var high = M("member", 5);
        var low = M("guest", 2);
        var trusted = M("trusted");
        var member = M("member");
        var outranks = Iskra.Server.Sessions.Permissions.Outranks;
        Assert.True(outranks(owner, admin));
        Assert.True(outranks(admin, high));
        Assert.True(outranks(high, low));
        Assert.True(outranks(low, trusted)); // any custom role sits above the plain levels
        Assert.True(outranks(trusted, member));
        Assert.False(outranks(high, M("trusted", 5)));  // same highest role: equals
        Assert.False(outranks(admin, M("admin", 9)));   // roles don't lift an admin above another admin
        Assert.False(outranks(high, admin));
        var has = Iskra.Server.Sessions.Permissions.Has;
        Assert.True(has(admin, Iskra.Server.Storage.Perm.BanMembers));
        Assert.False(has(trusted, Iskra.Server.Storage.Perm.BanMembers));
        Assert.True(has(M("member", 1, Iskra.Server.Storage.Perm.BanMembers | Iskra.Server.Storage.Perm.KickMembers), Iskra.Server.Storage.Perm.KickMembers));
        Assert.True(Iskra.Server.Sessions.Permissions.IsAbove(high, 4));
        Assert.False(Iskra.Server.Sessions.Permissions.IsAbove(high, 5));
        Assert.True(Iskra.Server.Sessions.Permissions.IsAbove(admin, 99));
    }

    // ── Managing roles ───────────────────────────────────────────────────────

    [Fact]
    public async Task Roles_are_created_at_the_bottom_validated_and_announced()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await member.RequestAsync("role.create", new { name = "Cool" })).ErrorCode());
        var first = await CreateRole(owner, "Moderator", ModeratorPerms, "#3BA55C");
        var roles = (await member.EventAsync("roles")).Body().GetProperty("roles");
        Assert.Equal("#3ba55c", roles[0].GetProperty("color").GetString());
        Assert.Equal(ModeratorPerms.Order(), roles[0].GetProperty("permissions").EnumerateArray().Select(p => p.GetString()!).Order());
        var second = await CreateRole(owner, "Supporter");
        roles = (await member.RequestAsync("role.list")).Body().GetProperty("roles");
        Assert.Equal([first, second], Ids(roles)); // highest first; new ones go to the bottom
        Assert.Equal(1, roles[1].GetProperty("position").GetInt32());

        Assert.Equal("bad_request", (await owner.RequestAsync("role.create", new { name = "" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.create", new { name = "x", color = "red" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.create", new { name = "x", icon = "two words" })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.create", new { name = "x", permissions = new[] { "administrator" } })).ErrorCode());

        var updated = (await owner.RequestAsync("role.update", new { id = second, icon = "⭐", hoist = true, color = "" })).Body().GetProperty("role");
        Assert.Equal("⭐", updated.GetProperty("icon").GetString());
        Assert.True(updated.GetProperty("hoist").GetBoolean());
        Assert.Equal(JsonValueKind.Null, updated.GetProperty("color").ValueKind);
    }

    [Fact]
    public async Task Members_hold_several_roles_and_everyone_sees_them()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var a = await CreateRole(owner, "A");
        var b = await CreateRole(owner, "B");

        await Give(owner, member, a, b);
        var updated = (await member.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.Equal([a, b], updated.GetProperty("roles").EnumerateArray().Select(r => r.GetInt64()).ToArray()); // highest first
        Assert.Equal("bad_request", (await owner.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { 999 } })).ErrorCode());

        // Deleting a role takes it off everyone.
        await owner.RequestAsync("role.delete", new { id = a });
        Assert.Equal([b], server.World.Store.GetMember(member.Key)!.RoleIds);
        Assert.Equal(1, server.World.Store.GetRole(b)!.Position);
    }

    // ── The hierarchy ────────────────────────────────────────────────────────

    [Fact]
    public async Task Role_managers_only_touch_roles_and_people_below_their_highest_role()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await server.JoinAsync("Mod");
        using var peer = await server.JoinAsync("Peer mod");
        using var member = await server.JoinAsync("Member");
        var helper = await CreateRole(owner, "Helper");
        var moderator = await CreateRole(owner, "Moderator", ["manageRoles", "kickMembers"]);
        var senior = await CreateRole(owner, "Senior");
        // Order, highest first: Moderator, Helper, Senior... then put Senior on top.
        await owner.RequestAsync("role.reorder", new { ids = new[] { senior, moderator, helper } });
        await Give(owner, mod, moderator);
        await Give(owner, peer, moderator);

        // Below: fine. Their own role or above: no.
        await Give(mod, member, helper);
        Assert.Equal("forbidden", (await mod.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { helper, moderator } })).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { helper, senior } })).ErrorCode());
        // Can't strip an equal (same role) or give themselves more; can give themselves something below.
        Assert.Equal("forbidden", (await mod.RequestAsync("member.roles.set", new { accountKey = peer.Key, roles = Array.Empty<long>() })).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { moderator, senior } })).ErrorCode());
        await Give(mod, mod, moderator, helper);
        // Kicking follows the same line.
        Assert.Equal("forbidden", (await mod.RequestAsync("member.kick", new { accountKey = peer.Key })).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("member.kick", new { accountKey = owner.Key })).ErrorCode());

        // Editing, deleting and moving roles: only below their own.
        Assert.Equal("forbidden", (await mod.RequestAsync("role.update", new { id = moderator, name = "Boss" })).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("role.delete", new { id = senior })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("role.update", new { id = helper, name = "Helpers" })).Type());
        Assert.Equal("forbidden", (await mod.RequestAsync("role.reorder", new { ids = new[] { senior, helper, moderator } })).ErrorCode());
        Assert.Equal("bad_request", (await mod.RequestAsync("role.reorder", new { ids = new[] { senior, moderator } })).ErrorCode());
        var below = await CreateRole(mod, "Newbie"); // at the bottom
        Assert.Equal("result", (await mod.RequestAsync("role.reorder", new { ids = new[] { senior, moderator, below, helper } })).Type());

        // Only permissions they have themselves.
        Assert.Equal("forbidden", (await mod.RequestAsync("role.update", new { id = helper, permissions = new[] { "banMembers" } })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("role.update", new { id = helper, permissions = new[] { "kickMembers" } })).Type());
        Assert.Equal("forbidden", (await mod.RequestAsync("role.create", new { name = "x", permissions = new[] { "viewAuditLog" } })).ErrorCode());
    }

    [Fact]
    public async Task Moderators_moderate_without_being_admins()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var mod = await server.JoinAsync("Mod");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var member = await server.JoinAsync("Member");
        using var other = await server.JoinAsync("Other");
        var moderator = await CreateRole(owner, "Moderator", ModeratorPerms);
        await Give(owner, mod, moderator);

        // Before: a member who can't do any of it.
        Assert.Equal("forbidden", (await member.RequestAsync("member.timeout", new { accountKey = other.Key, durationMs = 60_000 })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("audit.list")).ErrorCode());

        Assert.Equal("result", (await mod.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 60_000 })).Type());
        Assert.Equal("result", (await mod.RequestAsync("member.timeout", new { accountKey = trusted.Key, durationMs = 60_000 })).Type());
        Assert.Equal("forbidden", (await mod.RequestAsync("member.timeout", new { accountKey = admin.Key, durationMs = 60_000 })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("audit.list")).Type());
        var channel = (await mod.RequestAsync("channel.create", new { name = "mods" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        Assert.Equal("result", (await mod.RequestAsync("channel.update", new { id = channel, slowmode = 5 })).Type());
        var theirs = server.World.Store.AddMessage(server.General, other.Key, "rude", Now).Id;
        Assert.Equal("result", (await mod.RequestAsync("chat.delete", new { id = theirs })).Type());
        var adminsMessage = server.World.Store.AddMessage(server.General, admin.Key, "hi", Now).Id;
        Assert.Equal("forbidden", (await mod.RequestAsync("chat.delete", new { id = adminsMessage })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("chat.pin", new { id = adminsMessage })).Type());
        Assert.Equal("result", (await mod.RequestAsync("webhook.list")).Type());
        Assert.Equal("result", (await mod.RequestAsync("member.bans")).Type());
        Assert.Equal("result", (await mod.RequestAsync("member.ban", new { accountKey = other.Key, reason = "spam" })).Type());
        Assert.Equal("result", (await mod.RequestAsync("member.kick", new { accountKey = trusted.Key })).Type());
        // Levels stay admin business; bots too.
        Assert.Equal("forbidden", (await mod.RequestAsync("member.setRole", new { accountKey = member.Key, role = "trusted" })).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("bot.invite")).ErrorCode());

        // Taking the role away takes the powers with it.
        await Give(owner, mod);
        Assert.Equal("forbidden", (await mod.RequestAsync("audit.list")).ErrorCode());
        Assert.Equal("forbidden", (await mod.RequestAsync("member.kick", new { accountKey = member.Key })).ErrorCode());

        var actions = (await admin.RequestAsync("audit.list", new { person = mod.Key })).Body().GetProperty("entries")
            .EnumerateArray().Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("member.kick", actions);
        Assert.Contains("member.roles", actions);
    }

    // ── Channel overrides ────────────────────────────────────────────────────

    [Fact]
    public async Task Overrides_hide_and_reveal_channels_everywhere_including_threads_and_search()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await server.JoinAsync("Mod");
        using var muted = await server.JoinAsync("Muted");
        var moderator = await CreateRole(owner, "Moderator");
        var quiet = await CreateRole(owner, "Quiet");
        await Give(owner, mod, moderator);
        await Give(owner, muted, quiet);
        var staff = (await owner.RequestAsync("channel.create", new { name = "staff", readRole = "admin" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var staffMessage = (await owner.RequestAsync("chat.send", new { channelId = staff, text = "secret plan" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        var thread = (await owner.RequestAsync("thread.create", new { messageId = staffMessage, name = "plans" })).Body().GetProperty("thread").GetProperty("id").GetInt64();
        await owner.RequestAsync("chat.send", new { channelId = thread, text = "secret detail" });

        Assert.Equal("not_found", (await mod.RequestAsync("chat.history", new { channelId = staff })).ErrorCode());
        // Allow view for moderators: they see the channel and its thread, but writing still follows the write level.
        var result = await owner.RequestAsync("channel.overrides.set", new { id = staff, roleId = moderator, allow = new[] { "view" } });
        Assert.Equal("view", result.Body().GetProperty("channel").GetProperty("overrides")[0].GetProperty("allow")[0].GetString());
        var seen = false;
        for (var i = 0; i < 5 && !seen; i++)
            seen = (await mod.EventAsync("channels")).Body().GetProperty("channels").EnumerateArray().Any(c => c.GetProperty("id").GetInt64() == staff);
        Assert.True(seen);
        Assert.Equal("result", (await mod.RequestAsync("chat.history", new { channelId = thread })).Type());
        Assert.Equal(2, (await mod.RequestAsync("search", new { query = "secret" })).Body().GetProperty("results").GetArrayLength());
        Assert.Equal("forbidden", (await mod.RequestAsync("chat.send", new { channelId = staff, text = "hi" })).ErrorCode());
        await owner.RequestAsync("chat.send", new { channelId = staff, text = "for mods" });
        await mod.EventAsync("chat.message");
        await muted.NoEventAsync("chat.message");

        // Deny send in #general for the Quiet role; deny view hides it.
        await owner.RequestAsync("channel.overrides.set", new { id = server.General, roleId = quiet, deny = new[] { "send" } });
        Assert.Equal("forbidden", (await muted.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).ErrorCode());
        Assert.Equal("result", (await muted.RequestAsync("chat.history", new { channelId = server.General })).Type());
        await owner.RequestAsync("channel.overrides.set", new { id = server.General, roleId = quiet, deny = new[] { "view" } });
        Assert.Equal("not_found", (await muted.RequestAsync("chat.history", new { channelId = server.General })).ErrorCode());
        Assert.Equal(0, (await muted.RequestAsync("search", new { query = "secret" })).Body().GetProperty("results").GetArrayLength());
        // An allow from another role wins over a deny.
        await Give(owner, muted, quiet, moderator);
        await owner.RequestAsync("channel.overrides.set", new { id = server.General, roleId = moderator, allow = new[] { "view", "send" } });
        Assert.Equal("result", (await muted.RequestAsync("chat.send", new { channelId = server.General, text = "back" })).Type());

        Assert.Equal("bad_request", (await owner.RequestAsync("channel.overrides.set", new { id = staff, roleId = quiet, allow = new[] { "view" }, deny = new[] { "view" } })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("channel.overrides.set", new { id = staff, roleId = quiet, allow = new[] { "fly" } })).ErrorCode());
        // Removing it (both empty).
        await owner.RequestAsync("channel.overrides.set", new { id = staff, roleId = moderator });
        Assert.Equal("not_found", (await mod.RequestAsync("chat.history", new { channelId = staff })).ErrorCode());
    }

    [Fact]
    public async Task Overrides_need_manage_channels_and_a_role_below_yours()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await server.JoinAsync("Mod");
        var moderator = await CreateRole(owner, "Moderator", ["manageChannels"]);
        var low = await CreateRole(owner, "Low"); // new roles go to the bottom
        await Give(owner, mod, moderator);
        var staff = (await owner.RequestAsync("channel.create", new { name = "staff", readRole = "admin" })).Body().GetProperty("channel").GetProperty("id").GetInt64();

        // Their own role can't let them into a channel they can't see.
        Assert.Equal("forbidden", (await mod.RequestAsync("channel.overrides.set", new { id = server.General, roleId = moderator, allow = new[] { "send" } })).ErrorCode());
        Assert.Equal("not_found", (await mod.RequestAsync("channel.overrides.set", new { id = staff, roleId = low, allow = new[] { "view" } })).ErrorCode());
        Assert.Equal("not_found", (await mod.RequestAsync("channel.update", new { id = staff, readRole = "member" })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("channel.overrides.set", new { id = server.General, roleId = low, deny = new[] { "send" } })).Type());
    }

    [Fact]
    public async Task Voice_overrides_decide_who_connects_and_who_speaks()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var listener = await server.JoinAsync("Listener");
        var stage = server.World.Store.CreateChannel("stage", "voice", "member", "member", 0).Id;
        var audience = await CreateRole(owner, "Audience");
        await Give(owner, listener, audience);

        await owner.RequestAsync("channel.overrides.set", new { id = stage, roleId = audience, deny = new[] { "speak" } });
        Assert.False((await listener.RequestAsync("voice.join", new { channelId = stage })).Body().GetProperty("canSpeak").GetBoolean());
        await owner.RequestAsync("channel.overrides.set", new { id = stage, roleId = audience, deny = new[] { "connect" } });
        Assert.Equal("forbidden", (await listener.RequestAsync("voice.join", new { channelId = stage })).ErrorCode());

        // Someone already in the room who loses connect is removed.
        await owner.RequestAsync("channel.overrides.set", new { id = stage, roleId = audience });
        server.Services.GetRequiredService<VoiceRegistry>().Joined(stage, listener.Key, Now);
        await owner.RequestAsync("channel.overrides.set", new { id = stage, roleId = audience, deny = new[] { "connect" } });
        Assert.Contains(($"voice-{stage}", listener.Key), server.Voice.Removed);
    }

    // ── Voice moderation ─────────────────────────────────────────────────────

    [Fact]
    public async Task Moderators_mute_and_move_people_in_voice()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await server.JoinAsync("Mod");
        using var member = await server.JoinAsync("Member");
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        var games = server.World.Store.CreateChannel("games", "voice", "member", "member", 0).Id;
        var secret = server.World.Store.CreateChannel("secret", "voice", "admin", "admin", 0).Id;
        var moderator = await CreateRole(owner, "Moderator", ["muteMembers", "moveMembers"]);
        var voice = server.Services.GetRequiredService<VoiceRegistry>();

        Assert.Equal("forbidden", (await mod.RequestAsync("voice.mute", new { accountKey = member.Key, muted = true })).ErrorCode());
        await Give(owner, mod, moderator);
        Assert.Equal("bad_request", (await mod.RequestAsync("voice.mute", new { accountKey = member.Key, muted = true })).ErrorCode()); // not in voice
        voice.Joined(lounge, member.Key, Now);

        Assert.Equal("result", (await mod.RequestAsync("voice.mute", new { accountKey = member.Key, muted = true })).Type());
        Assert.Contains(($"voice-{lounge}", member.Key, false), server.Voice.Updated);
        var state = (await member.EventAsync("voice.state")).Body();
        while (!state.GetProperty("participants")[0].GetProperty("serverMuted").GetBoolean()) state = (await member.EventAsync("voice.state")).Body();
        Assert.False((await member.RequestAsync("voice.join", new { channelId = games })).Body().GetProperty("canSpeak").GetBoolean());
        await mod.RequestAsync("voice.mute", new { accountKey = member.Key, muted = false });
        Assert.Contains(($"voice-{lounge}", member.Key, true), server.Voice.Updated);
        Assert.Equal("forbidden", (await mod.RequestAsync("voice.mute", new { accountKey = owner.Key, muted = true })).ErrorCode());

        Assert.Equal("not_found", (await mod.RequestAsync("voice.move", new { accountKey = member.Key, channelId = secret })).ErrorCode());
        Assert.Equal("result", (await mod.RequestAsync("voice.move", new { accountKey = member.Key, channelId = games })).Type());
        Assert.Equal(games, (await member.EventAsync("voice.moved")).Body().GetProperty("channelId").GetInt64());
        Assert.Contains(($"voice-{lounge}", member.Key), server.Voice.Removed);
        Assert.Null(voice.ChannelOfMember(member.Key));
    }

    // ── Mentions and pushes ──────────────────────────────────────────────────

    [Fact]
    public async Task Mention_everyone_comes_from_trusted_or_a_role_and_blocked_senders_never_push()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        using var reader = await server.JoinAsync("Reader");
        var endpoint = $"https://fcm.googleapis.com/fcm/send/reader-{Guid.NewGuid():N}";
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            var q = key.ExportParameters(false).Q;
            await reader.RequestAsync("push.subscribe", new
            {
                endpoint, keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
            });
        }

        await member.RequestAsync("chat.send", new { channelId = server.General, text = "@everyone hello" });
        await server.Push.NoneAsync(endpoint);
        var announcer = await CreateRole(owner, "Announcer", ["mentionEveryone"]);
        await Give(owner, member, announcer);
        await member.RequestAsync("chat.send", new { channelId = server.General, text = "@everyone hello again" });
        await server.Push.WaitForAsync(endpoint);

        // The reader blocks the member: even a direct mention doesn't push.
        await reader.RequestAsync("block.sync", new { entries = new[] { new { accountKey = member.Key, blocked = true, at = Now } } });
        var already = server.Push.SentTo(endpoint).Count;
        await Task.Delay(700); // past the push coalescing window
        await member.RequestAsync("chat.send", new { channelId = server.General, text = $"<@{reader.Key}> hey" });
        await server.Push.NoneAsync(endpoint, already);
    }
}
