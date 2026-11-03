using Iskra.Server.Features;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Iskra.Server.Tests;

/// <summary>
/// Timeouts and required rules refuse every request except an allowlist (<see cref="Participation"/>), so a new
/// request that writes something can't forget the gate.
/// </summary>
public class ParticipationGateTests
{
    /// <summary>Requests that once slipped past the old lists of what to refuse.</summary>
    public static readonly TheoryData<string> Missed = new()
    {
        "lfg.create", "lfg.join", "suggestion.create", "suggestion.vote", "giveaway.enter", "room.update", "room.invite",
        "voice.status.set", "whisper.start", "act.start", "act.send", "chat.forward", "invite.create", "stage.hand",
    };

    [Fact]
    public void Every_allowed_request_exists_and_new_requests_are_refused_by_default()
    {
        using var server = new IskraServer();
        var types = server.Services.GetRequiredService<Router>().Types.ToHashSet();
        Assert.True(types.Count > 300);
        // A typo or a removed request in the allowlist would go unnoticed otherwise.
        Assert.All(Participation.StillAllowed, t => Assert.Contains(t, types));
        Assert.True(Participation.Restricted("some.future.request"));
        foreach (var type in new[] { "chat.send", "chat.react", "voice.join", "poll.create", "wb.update", "channel.create" })
            Assert.True(Participation.Restricted(type), type);
        foreach (var type in new[] { "rules.accept", "member.leave", "report.create", "chat.history", "dm.send", "account.delete" })
            Assert.False(Participation.Restricted(type), type);
    }

    [Theory]
    [MemberData(nameof(Missed))]
    public async Task A_timed_out_member_is_refused(string type)
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mallory = await server.JoinAsync("Mallory");
        await owner.RequestAsync("member.timeout", new { accountKey = mallory.Key, durationMs = 60_000 });

        var refused = (await mallory.RequestAsync(type, new { })).Body();
        Assert.Equal("forbidden", refused.GetProperty("code").GetString());
        Assert.Equal("timed_out", refused.GetProperty("key").GetString());
    }

    [Theory]
    [MemberData(nameof(Missed))]
    public async Task A_member_who_hasnt_agreed_to_the_rules_is_refused(string type)
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mallory = await server.JoinAsync("Mallory");
        Assert.Equal("result", (await owner.RequestAsync("rules.update", new { text = "Be kind.", required = true, reaccept = true })).Type());

        Assert.Equal("rules_required", (await mallory.RequestAsync(type, new { })).ErrorCode());
    }

    private static void Ok(System.Text.Json.JsonElement reply) => Assert.True(reply.Type() == "result", reply.ToString());

    [Fact]
    public async Task Timed_out_members_can_still_read_report_agree_and_leave()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mallory = await server.JoinAsync("Mallory");
        using var bob = await server.JoinAsync("Bob");
        await owner.RequestAsync("member.timeout", new { accountKey = mallory.Key, durationMs = 60_000 });

        Ok(await mallory.RequestAsync("chat.history", new { channelId = server.General }));
        Ok(await mallory.RequestAsync("rules.get"));
        Ok(await mallory.RequestAsync("role.list"));
        Ok(await mallory.RequestAsync("report.create", new { accountKey = bob.Key, reason = "other" }));
        // Unknown requests still say so.
        Assert.Equal("unknown_type", (await mallory.RequestAsync("no.such.request")).ErrorCode());
        Ok(await mallory.RequestAsync("member.leave"));
    }
}
