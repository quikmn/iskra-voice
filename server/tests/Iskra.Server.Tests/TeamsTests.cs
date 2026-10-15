using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Iskra.Server.Voice;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>Team splits: moving people into temporary team channels, bringing them back, and cleaning up.</summary>
public class TeamsTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static VoiceRegistry Voice(IskraServer server) => server.Services.GetRequiredService<VoiceRegistry>();

    private static long Lounge(IskraServer server, string name = "lounge") => server.World.Store.CreateChannel(name, "voice", "member", "member", 0).Id;

    private static string? Key(JsonElement frame) =>
        frame.Body().TryGetProperty("key", out var key) ? key.GetString() : null;

    private static async Task<JsonElement> Split(User by, long channelId, string[][] teams, object? extra = null)
    {
        var body = new Dictionary<string, object?> { ["channelId"] = channelId, ["teams"] = teams };
        if (extra is not null)
            foreach (var p in extra.GetType().GetProperties()) body[p.Name] = p.GetValue(extra);
        return await by.RequestAsync("teams.start", body);
    }

    [Fact]
    public async Task Splitting_makes_team_channels_with_the_parents_permissions_and_moves_everyone()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        using var owner = await server.JoinAsync("Owner", "owner");
        var games = (await owner.RequestAsync("category.create", new { name = "Games" })).Body().GetProperty("category").GetProperty("id").GetInt64();
        var lounge = (await owner.RequestAsync("channel.create", new { name = "lounge", kind = "voice", readRole = "member", writeRole = "trusted", categoryId = games }))
            .Body().GetProperty("channel").GetProperty("id").GetInt64();
        var after = (await owner.RequestAsync("channel.create", new { name = "after", kind = "voice", categoryId = games })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var role = (await owner.RequestAsync("role.create", new { name = "Gamers" })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("channel.overrides.set", new { id = lounge, roleId = role, allow = new[] { "speak" } });
        await owner.RequestAsync("channel.update", new { id = lounge, hifi = true });
        using var a = await server.JoinAsync("Alice");
        using var b = await server.JoinAsync("Bob");
        using var c = await server.JoinAsync("Carol");
        foreach (var user in new[] { owner, a, b, c }) Voice(server).Joined(lounge, user.Key, Now);

        var result = await Split(owner, lounge, [[owner.Key, a.Key], [b.Key, c.Key]], new { game = "Valheim", names = new[] { "Valheim team 1", "Valheim team 2" } });
        var split = result.Body().GetProperty("split");
        Assert.Equal(lounge, split.GetProperty("channelId").GetInt64());
        Assert.Equal("Valheim", split.GetProperty("game").GetString());
        var teams = split.GetProperty("teams").EnumerateArray().ToList();
        Assert.Equal(["valheim-team-1", "valheim-team-2"], teams.Select(t => t.GetProperty("name").GetString()));
        var ids = teams.Select(t => t.GetProperty("channelId").GetInt64()).ToArray();

        // Same category, levels, overrides and hi-fi as the voice channel, right after it.
        foreach (var id in ids)
        {
            var channel = store.GetChannel(id)!;
            Assert.Equal(("voice", "member", "trusted", (long?)games), (channel.Kind, channel.ReadRole, channel.WriteRole, channel.CategoryId));
            Assert.Equal(role, Assert.Single(channel.Overrides).RoleId);
            Assert.True(store.IsHifi(id));
        }
        var order = store.AllChannels().Select(ch => ch.Id).ToList();
        Assert.Equal([lounge, ids[0], ids[1], after], order.Where(id => id == lounge || id == after || ids.Contains(id)));

        // Everyone moved like a moderator move, with the reason.
        var moved = (await b.EventAsync("voice.moved")).Body();
        Assert.Equal(ids[1], moved.GetProperty("channelId").GetInt64());
        Assert.Equal("teams", moved.GetProperty("reason").GetString());
        Assert.Equal(ids[0], (await a.EventAsync("voice.moved")).Body().GetProperty("channelId").GetInt64());
        Assert.Contains(($"voice-{lounge}", c.Key), server.Voice.Removed);
        Assert.Empty(Voice(server).Participants(lounge));
        Assert.Equal(split.GetProperty("id").GetInt64(), (await c.EventAsync("teams.split")).Body().GetProperty("split").GetProperty("id").GetInt64());
        Assert.Single((await c.RequestAsync("teams.list")).Body().GetProperty("splits").EnumerateArray());
        Assert.Single(store.Audit("teams.start", null, null, 10));
    }

    [Fact]
    public async Task Only_movers_split_and_only_people_here_below_them()
    {
        using var server = new IskraServer();
        var lounge = Lounge(server);
        var other = Lounge(server, "other");
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var mod = await server.JoinAsync("Mod");
        using var a = await server.JoinAsync("Alice");
        using var b = await server.JoinAsync("Bob");
        using var away = await server.JoinAsync("Away");
        var mods = (await owner.RequestAsync("role.create", new { name = "Mods", permissions = new[] { "moveMembers" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = mod.Key, roles = new[] { mods } });
        foreach (var user in new[] { owner, admin, mod, a, b }) Voice(server).Joined(lounge, user.Key, Now);
        Voice(server).Joined(other, away.Key, Now);

        // No move power: forbidden.
        var refused = await Split(a, lounge, [[a.Key], [b.Key]]);
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Equal("teams_move", Key(refused));

        // A moderator can split people below them, not the admin above.
        var above = await Split(mod, lounge, [[mod.Key, admin.Key], [b.Key]]);
        Assert.Equal("forbidden", above.ErrorCode());
        Assert.Equal("rank_members", Key(above));
        Assert.Equal("teams_not_here", Key(await Split(mod, lounge, [[a.Key], [away.Key]])));
        Assert.Equal("teams_twice", Key(await Split(mod, lounge, [[a.Key], [a.Key]])));
        Assert.Equal("teams_count", Key(await Split(mod, lounge, [[a.Key, b.Key]])));
        Assert.Equal("teams_count", Key(await Split(mod, lounge, Enumerable.Range(0, 9).Select(_ => new[] { a.Key }).ToArray())));
        Assert.Equal("teams_size", Key(await Split(mod, lounge, [[a.Key], []])));
        Assert.Equal("teams_voice_only", Key(await Split(mod, server.General, [[a.Key], [b.Key]])));
        Assert.Equal("not_found", (await Split(mod, 99999, [[a.Key], [b.Key]])).ErrorCode());
        Assert.Empty(server.World.Store.TeamSplits());
        Assert.Equal(2, server.World.Store.AllChannels().Count(ch => ch.Kind == "voice"));

        // Fine within the rules; then the channel is busy until everyone's back, and team channels can't be split again.
        Assert.Equal("result", (await Split(mod, lounge, [[mod.Key, a.Key], [b.Key]])).Type());
        var split = server.World.Store.TeamSplits().Single();
        var team = server.World.Store.TeamChannels(split.Id)[0].ChannelId;
        Voice(server).Joined(lounge, owner.Key, Now);
        Voice(server).Joined(lounge, admin.Key, Now);
        Assert.Equal("teams_active", Key(await Split(owner, lounge, [[owner.Key], [admin.Key]])));
        Voice(server).Joined(team, owner.Key, Now);
        Voice(server).Joined(team, admin.Key, Now);
        Assert.Equal("teams_nested", Key(await Split(owner, team, [[owner.Key], [admin.Key]])));
    }

    [Fact]
    public async Task Bots_stay_where_they_are()
    {
        using var server = new IskraServer();
        var lounge = Lounge(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var a = await server.JoinAsync("Alice");
        server.World.Store.AddBot(a.Key, owner.Key, Now, readAll: false); // treat Alice as a bot account
        Voice(server).Joined(lounge, owner.Key, Now);
        Voice(server).Joined(lounge, a.Key, Now);
        Assert.Equal("teams_bot", Key(await Split(owner, lounge, [[owner.Key], [a.Key]])));
    }

    [Fact]
    public async Task Bring_everyone_back_moves_them_home_and_deletes_the_team_channels()
    {
        using var server = new IskraServer();
        var lounge = Lounge(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var a = await server.JoinAsync("Alice");
        using var b = await server.JoinAsync("Bob");
        foreach (var user in new[] { owner, a, b }) Voice(server).Joined(lounge, user.Key, Now);
        var split = (await Split(owner, lounge, [[owner.Key], [a.Key, b.Key]])).Body().GetProperty("split");
        var id = split.GetProperty("id").GetInt64();
        var ids = split.GetProperty("teams").EnumerateArray().Select(t => t.GetProperty("channelId").GetInt64()).ToArray();
        // The apps follow the move (LiveKit's webhook says they arrived).
        Voice(server).Joined(ids[0], owner.Key, Now);
        Voice(server).Joined(ids[1], a.Key, Now);
        Voice(server).Joined(ids[1], b.Key, Now);
        await a.EventAsync("voice.moved");

        // Someone without the power can't; a stranger to the channel doesn't even see it.
        Assert.Equal("forbidden", (await a.RequestAsync("teams.end", new { id })).ErrorCode());

        var ended = (await owner.RequestAsync("teams.end", new { id })).Body();
        Assert.Equal(3, ended.GetProperty("moved").GetInt32());
        var back = (await a.EventAsync("voice.moved")).Body();
        Assert.Equal(lounge, back.GetProperty("channelId").GetInt64());
        Assert.Equal("teams", back.GetProperty("reason").GetString());
        Assert.All(ids, team => Assert.Null(server.World.Store.GetChannel(team)));
        Assert.Empty(server.World.Store.TeamSplits());
        Assert.Equal(id, (await b.EventAsync("teams.ended")).Body().GetProperty("id").GetInt64());
        Assert.Empty((await b.RequestAsync("teams.list")).Body().GetProperty("splits").EnumerateArray());
        Assert.Single(server.World.Store.Audit("teams.end", null, null, 10));
        Assert.Equal("not_found", (await owner.RequestAsync("teams.end", new { id })).ErrorCode());
    }

    [Fact]
    public async Task Bring_back_skips_people_above_you_and_keeps_their_channel()
    {
        using var server = new IskraServer();
        var lounge = Lounge(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var a = await server.JoinAsync("Alice");
        foreach (var user in new[] { owner, a }) Voice(server).Joined(lounge, user.Key, Now);
        var split = (await Split(owner, lounge, [[owner.Key], [a.Key]])).Body().GetProperty("split");
        var ids = split.GetProperty("teams").EnumerateArray().Select(t => t.GetProperty("channelId").GetInt64()).ToArray();
        Voice(server).Joined(ids[0], owner.Key, Now);
        Voice(server).Joined(ids[1], a.Key, Now);

        var ended = (await admin.RequestAsync("teams.end", new { id = split.GetProperty("id").GetInt64() })).Body();
        Assert.Equal(1, ended.GetProperty("moved").GetInt32());
        Assert.NotNull(server.World.Store.GetChannel(ids[0])); // the owner is still in it
        Assert.Null(server.World.Store.GetChannel(ids[1]));
        var left = Assert.Single(server.World.Store.TeamSplits());
        Assert.Single(server.World.Store.TeamChannels(left.Id));
    }

    [Fact]
    public async Task Team_channels_go_after_five_empty_minutes_and_the_split_ends()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        var lounge = Lounge(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var a = await server.JoinAsync("Alice");
        using var b = await server.JoinAsync("Bob");
        foreach (var user in new[] { owner, a, b }) Voice(server).Joined(lounge, user.Key, Now);
        var start = Now;
        var split = (await Split(owner, lounge, [[a.Key], [b.Key]])).Body().GetProperty("split");
        var id = split.GetProperty("id").GetInt64();
        var ids = split.GetProperty("teams").EnumerateArray().Select(t => t.GetProperty("channelId").GetInt64()).ToArray();
        var sweeper = server.Services.GetRequiredService<TeamSweeper>();

        // Team 1 is in use; team 2 stays empty.
        Voice(server).Joined(ids[0], a.Key, Now);
        Assert.Equal(0, sweeper.Sweep(start + 4 * 60_000));
        Assert.Equal(1, sweeper.Sweep(start + 5 * 60_000 + 2_000));
        Assert.Null(store.GetChannel(ids[1]));
        Assert.NotNull(store.GetChannel(ids[0]));
        var update = (await owner.EventAsync("teams.split")).Body();
        while (update.GetProperty("split").GetProperty("teams").GetArrayLength() != 1) update = (await owner.EventAsync("teams.split")).Body();

        // Five minutes after the last one leaves, it goes too, and the split with it.
        Assert.Equal(0, sweeper.Sweep(start + 7 * 60_000)); // still in use when last looked
        Voice(server).Left(ids[0], a.Key);
        Assert.Equal(0, sweeper.Sweep(start + 11 * 60_000));
        Assert.Equal(1, sweeper.Sweep(start + 12 * 60_000 + 1_000));
        Assert.Empty(store.TeamSplits());
        Assert.Equal(id, (await owner.EventAsync("teams.ended")).Body().GetProperty("id").GetInt64());
        Assert.NotNull(store.GetChannel(lounge));
    }

    [Fact]
    public async Task A_split_ends_when_an_admin_deletes_its_channels_or_the_parent_is_gone()
    {
        using var server = new IskraServer();
        var store = server.World.Store;
        var lounge = Lounge(server);
        using var owner = await server.JoinAsync("Owner", "owner");
        using var a = await server.JoinAsync("Alice");
        foreach (var user in new[] { owner, a }) Voice(server).Joined(lounge, user.Key, Now);
        var split = (await Split(owner, lounge, [[owner.Key], [a.Key]])).Body().GetProperty("split");
        var ids = split.GetProperty("teams").EnumerateArray().Select(t => t.GetProperty("channelId").GetInt64()).ToArray();

        // The parent goes: nobody can be brought back, but the split still cleans up.
        await owner.RequestAsync("channel.delete", new { id = lounge });
        var ended = await owner.RequestAsync("teams.end", new { id = split.GetProperty("id").GetInt64() });
        Assert.Equal(0, ended.Body().GetProperty("moved").GetInt32());
        Assert.Empty(store.TeamSplits());

        // An admin deleting both team channels by hand ends a split at the next sweep.
        var lounge2 = Lounge(server, "lounge-2");
        foreach (var user in new[] { owner, a }) Voice(server).Joined(lounge2, user.Key, Now);
        var second = (await Split(owner, lounge2, [[owner.Key], [a.Key]])).Body().GetProperty("split");
        foreach (var t in second.GetProperty("teams").EnumerateArray()) await owner.RequestAsync("channel.delete", new { id = t.GetProperty("channelId").GetInt64() });
        server.Services.GetRequiredService<TeamSweeper>().Sweep(Now);
        Assert.Empty(store.TeamSplits());
        Assert.All(ids, id => Assert.Null(store.GetChannel(id)));
    }

    [Fact]
    public async Task Readers_only_see_splits_of_channels_they_can_see()
    {
        using var server = new IskraServer();
        var secret = server.World.Store.CreateChannel("secret", "voice", "trusted", "trusted", 0).Id;
        using var owner = await server.JoinAsync("Owner", "owner");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var member = await server.JoinAsync("Member");
        foreach (var user in new[] { owner, trusted }) Voice(server).Joined(secret, user.Key, Now);
        var id = (await Split(owner, secret, [[owner.Key], [trusted.Key]])).Body().GetProperty("split").GetProperty("id").GetInt64();
        Assert.Empty((await member.RequestAsync("teams.list")).Body().GetProperty("splits").EnumerateArray());
        await member.NoEventAsync("teams.split");
        // Team channels follow the parent: hidden from the member as well.
        Assert.All(server.World.Store.TeamChannels(id), t => Assert.Equal("trusted", server.World.Store.GetChannel(t.ChannelId)!.ReadRole));
        var mods = (await owner.RequestAsync("role.create", new { name = "Movers", permissions = new[] { "moveMembers" } })).Body().GetProperty("role").GetProperty("id").GetInt64();
        await owner.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { mods } });
        Assert.Equal("not_found", (await member.RequestAsync("teams.end", new { id })).ErrorCode());
    }

    [Fact]
    public async Task Splits_that_go_ahead_are_rate_limited()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var a = await server.JoinAsync("Alice");
        var codes = new List<string?>();
        for (var i = 0; i < 4; i++)
        {
            var lounge = Lounge(server, $"lounge-{i}");
            Voice(server).Joined(lounge, owner.Key, Now);
            Voice(server).Joined(lounge, a.Key, Now);
            codes.Add((await Split(owner, lounge, [[owner.Key], [a.Key]])).ErrorCode());
        }
        Assert.Equal([null, null, null, "rate_limited"], codes);
        Assert.Equal(3, server.World.Store.TeamSplits().Count);
    }
}
