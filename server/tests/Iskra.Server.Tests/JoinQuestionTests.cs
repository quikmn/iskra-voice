using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Join questions (answers that give self-assignable roles and suggest channels) and roles on join.</summary>
public class JoinQuestionTests
{
    private static async Task<long> CreateRole(User by, string name, bool selfAssign = true, string[]? permissions = null)
    {
        var result = await by.RequestAsync("role.create", new { name, selfAssign, permissions = permissions ?? [] });
        Assert.Equal("result", result.Type());
        return result.Body().GetProperty("role").GetProperty("id").GetInt64();
    }

    private static long[] Ids(JsonElement ids) => ids.EnumerateArray().Select(r => r.GetInt64()).ToArray();

    private static async Task<JsonElement> CreateQuestion(User by, object body)
    {
        var reply = await by.RequestAsync("role.group.create", body);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("group");
    }

    private static long[] AnswerIds(JsonElement group) => group.GetProperty("answers").EnumerateArray().Select(a => a.GetProperty("id").GetInt64()).ToArray();

    private static string? Key(JsonElement reply) => reply.Body().TryGetProperty("key", out var k) ? k.GetString() : null;

    private static long[] RolesOf(IskraServer server, User user) => server.World.Store.GetMember(user.Key)!.RoleIds.Order().ToArray();

    private static async Task<User> JoinBot(IskraServer server, User admin, string name = "Helper")
    {
        var code = (await admin.RequestAsync("bot.invite", new { role = "member" })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, name, invite: code);
        ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        var welcome = await client.ReceiveAsync();
        Assert.Equal("welcome", welcome.Type());
        return new User(identity, client, welcome);
    }

    [Fact]
    public async Task Questions_with_answers_that_give_roles_and_suggest_channels()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var ps = await CreateRole(owner, "PlayStation");
        var news = await CreateRole(owner, "News");

        var group = await CreateQuestion(owner, new
        {
            title = "Platform", question = "What do you play on?", multi = true, required = true,
            answers = new object[]
            {
                new { label = "Computer", emoji = "💻", roles = new[] { pc, news }, channels = new[] { server.General } },
                new { roles = new[] { ps } }, // no label: shows the role's name
                new { label = "Just looking" }, // gives nothing
            },
        });
        Assert.True(group.GetProperty("required").GetBoolean());
        var answers = group.GetProperty("answers");
        Assert.Equal(3, answers.GetArrayLength());
        Assert.Equal("Computer", answers[0].GetProperty("label").GetString());
        Assert.Equal("💻", answers[0].GetProperty("emoji").GetString());
        Assert.Equal([pc, news], Ids(answers[0].GetProperty("roles")));
        Assert.Equal([server.General], Ids(answers[0].GetProperty("channels")));
        Assert.Equal("", answers[1].GetProperty("label").GetString());
        Assert.Equal([pc, news, ps], Ids(group.GetProperty("roles"))); // every role its answers give, for older apps

        // Everyone sees the questions (role.list), including the roles on join.
        var listed = (await member.RequestAsync("role.list")).Body();
        Assert.Equal(3, listed.GetProperty("groups")[0].GetProperty("answers").GetArrayLength());
        Assert.Empty(listed.GetProperty("autoRoles").EnumerateArray());

        // Editing keeps answers listed with their id (and who picked them), drops the rest.
        var ids = AnswerIds(group);
        await member.RequestAsync("onboarding.answer", new { question = group.GetProperty("id").GetInt64(), answers = new[] { ids[0] } });
        var updated = (await owner.RequestAsync("role.group.update", new
        {
            id = group.GetProperty("id").GetInt64(),
            answers = new object[] { new { id = ids[0], label = "PC", roles = new[] { pc } }, new { label = "Console", roles = new[] { ps } } },
        })).Body().GetProperty("group");
        Assert.Equal(ids[0], AnswerIds(updated)[0]);
        Assert.NotEqual(ids[1], AnswerIds(updated)[1]);
        Assert.Equal([ids[0]], Ids((await member.RequestAsync("onboarding.mine")).Body().GetProperty("answers")));
    }

    [Fact]
    public async Task Answers_can_only_ever_give_roles_members_may_pick_themselves()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var manager = await server.JoinAsync("Manager", "admin");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var mod = await CreateRole(owner, "Moderator", selfAssign: false, permissions: ["kickMembers"]);
        var plain = await CreateRole(owner, "Plain", selfAssign: false); // no permissions, but counts as rank

        // Not when creating, not when editing, not hidden among good ones.
        foreach (var bad in new[] { mod, plain, 999L })
        {
            var refused = await owner.RequestAsync("role.group.create", new { title = "Q", answers = new object[] { new { label = "A", roles = new[] { pc, bad } } } });
            Assert.Equal("bad_request", refused.ErrorCode());
        }
        Assert.Equal("role_group_not_self_assign", Key(await owner.RequestAsync("role.group.create", new { title = "Q", answers = new object[] { new { label = "A", roles = new[] { mod } } } })));
        var group = await CreateQuestion(owner, new { title = "Q", answers = new object[] { new { label = "A", roles = new[] { pc } } } });
        var id = group.GetProperty("id").GetInt64();
        Assert.Equal("bad_request", (await owner.RequestAsync("role.group.update", new { id, answers = new object[] { new { label = "A", roles = new[] { mod } } } })).ErrorCode());
        Assert.Equal("bad_request", (await owner.RequestAsync("role.group.update", new { id, roles = new[] { plain } })).ErrorCode());

        // Only role managers write questions.
        Assert.Equal("forbidden", (await member.RequestAsync("role.group.create", new { title = "Q", answers = new object[] { new { label = "A" } } })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("role.group.update", new { id, required = true })).ErrorCode());

        // A role that stops being pickable leaves every answer, and an answer that was only that role goes.
        var second = await CreateQuestion(owner, new { title = "Legacy", roles = new[] { pc } });
        await owner.RequestAsync("role.update", new { id = pc, selfAssign = false });
        Assert.Empty(server.World.Store.GetRoleGroup(id)!.Answers.Single().RoleIds);
        Assert.Empty(server.World.Store.GetRoleGroup(second.GetProperty("id").GetInt64())!.Answers);

        // Even if the database said otherwise, answering never gives a role with permissions or rank.
        var g = server.World.Store.GetRoleGroup(id)!;
        server.World.Store.UpdateRoleGroup(g with { Answers = [new JoinAnswer(g.Answers[0].Id, "A", null, [mod, plain], [])] });
        var answered = await member.RequestAsync("onboarding.answer", new { question = id, answers = new[] { g.Answers[0].Id } });
        Assert.Equal("result", answered.Type());
        Assert.Empty(RolesOf(server, member));
        Assert.Equal(Perm.None, server.World.Store.GetMember(member.Key)!.Perms);
    }

    [Fact]
    public async Task Question_limits_are_enforced()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var roles = new List<long>();
        for (var i = 0; i < 6; i++) roles.Add(await CreateRole(owner, $"R{i}"));
        var secret = (await owner.RequestAsync("channel.create", new { name = "secret", kind = "text", readRole = "owner" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        using var admin = await server.JoinAsync("Admin", "admin");

        async Task<string?> Refused(object answer, User? by = null)
        {
            var reply = await (by ?? owner).RequestAsync("role.group.create", new { title = "Q", answers = new[] { answer } });
            Assert.NotEqual("result", reply.Type());
            return Key(reply);
        }

        Assert.Equal("role_answer_roles_max", await Refused(new { label = "A", roles = roles.ToArray() })); // 6 > 5
        Assert.Equal("role_answer_label", await Refused(new { label = new string('x', 61) }));
        Assert.Equal("role_answer_empty", await Refused(new { label = "  " }));
        Assert.Equal("role_answer_channels_max", await Refused(new { label = "A", channels = new long[] { 1, 2, 3, 4, 5, 6 } }));
        Assert.Null(await Refused(new { label = "A", channels = new[] { 9999L } })); // not_found
        Assert.Null(await Refused(new { label = "A", channels = new[] { secret } }, admin)); // a channel the admin can't see
        Assert.Null(await Refused(new { label = "A", emoji = "two words" }));
        var many = Enumerable.Range(0, 26).Select(i => new { label = $"A{i}" }).ToArray();
        Assert.Equal("role_group_answers_max", Key(await owner.RequestAsync("role.group.create", new { title = "Q", answers = many })));
        Assert.Equal("role_group_no_answers", Key(await owner.RequestAsync("role.group.create", new { title = "Q", answers = Array.Empty<object>() })));
        Assert.Equal("result", (await owner.RequestAsync("role.group.create", new { title = "Q", answers = many[..25] })).Type());

        // An answer id from another question can't be smuggled in when editing.
        var a = await CreateQuestion(owner, new { title = "A", answers = new object[] { new { label = "x" } } });
        var b = await CreateQuestion(owner, new { title = "B", answers = new object[] { new { label = "y" } } });
        var stolen = await owner.RequestAsync("role.group.update", new { id = b.GetProperty("id").GetInt64(), answers = new object[] { new { id = AnswerIds(a)[0], label = "z" } } });
        Assert.Equal("onboarding_unknown_answer", Key(stolen));
    }

    [Fact]
    public async Task Answering_gives_roles_and_changing_answers_takes_back_only_what_answers_gave()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var ps = await CreateRole(owner, "PlayStation");
        var news = await CreateRole(owner, "News");
        var vip = await CreateRole(owner, "VIP", selfAssign: false);
        var platform = await CreateQuestion(owner, new
        {
            title = "Platform", multi = false, required = true,
            answers = new object[] { new { label = "PC", roles = new[] { pc, news } }, new { label = "PS", roles = new[] { ps } } },
        });
        var q = platform.GetProperty("id").GetInt64();
        var (pcAnswer, psAnswer) = (AnswerIds(platform)[0], AnswerIds(platform)[1]);

        // News was given by a moderator before; VIP too.
        await owner.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { news, vip } });

        var first = await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { pcAnswer } });
        Assert.Equal("result", first.Type());
        Assert.Equal(new[] { pc, news, vip }.Order(), Ids(first.Body().GetProperty("member").GetProperty("roles")).Order());
        Assert.Equal([pcAnswer], Ids(first.Body().GetProperty("answers")));

        // Changing to PS: PC goes (an answer gave it), News stays (a moderator gave it), VIP stays.
        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { psAnswer } });
        Assert.Equal(new[] { ps, news, vip }.Order(), RolesOf(server, member));

        // A role picked by hand afterwards isn't the answers' to take back.
        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { pcAnswer } });
        Assert.Contains(pc, RolesOf(server, member));
        Assert.DoesNotContain(ps, RolesOf(server, member));
        await member.RequestAsync("roles.self", new { add = new[] { ps } });
        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { psAnswer } });
        Assert.Equal(new[] { ps, news, vip }.Order(), RolesOf(server, member));

        // Single choice, required, foreign answers.
        Assert.Equal("onboarding_single", Key(await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { pcAnswer, psAnswer } })));
        Assert.Equal("onboarding_required", Key(await member.RequestAsync("onboarding.answer", new { question = q, answers = Array.Empty<long>() })));
        var other = await CreateQuestion(owner, new { title = "Other", multi = true, answers = new object[] { new { label = "x" } } });
        Assert.Equal("onboarding_unknown_answer", Key(await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { AnswerIds(other)[0] } })));
        Assert.Equal("not_found", (await member.RequestAsync("onboarding.answer", new { question = 9999, answers = Array.Empty<long>() })).ErrorCode());
        // An optional question can be cleared.
        var oq = other.GetProperty("id").GetInt64();
        Assert.Equal("result", (await member.RequestAsync("onboarding.answer", new { question = oq, answers = AnswerIds(other) })).Type());
        Assert.Equal("result", (await member.RequestAsync("onboarding.answer", new { question = oq, answers = Array.Empty<long>() })).Type());
        Assert.Equal([psAnswer], Ids((await member.RequestAsync("onboarding.mine")).Body().GetProperty("answers")));

    }

    [Fact]
    public async Task A_role_two_answers_give_stays_while_either_is_picked_and_hand_given_roles_stay()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var ps = await CreateRole(owner, "PlayStation");
        var platform = await CreateQuestion(owner, new { title = "Platform", answers = new object[] { new { label = "PC", roles = new[] { pc } }, new { label = "PS", roles = new[] { ps } } } });
        var pings = await CreateQuestion(owner, new { title = "Pings", multi = true, answers = new object[] { new { label = "Games", roles = new[] { ps } } } });
        var (q, p) = (platform.GetProperty("id").GetInt64(), pings.GetProperty("id").GetInt64());
        var (pcAnswer, psAnswer) = (AnswerIds(platform)[0], AnswerIds(platform)[1]);

        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { psAnswer } });
        await member.RequestAsync("onboarding.answer", new { question = p, answers = AnswerIds(pings) });
        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { pcAnswer } });
        Assert.Equal(new[] { pc, ps }.Order(), RolesOf(server, member));
        await member.RequestAsync("onboarding.answer", new { question = p, answers = Array.Empty<long>() });
        Assert.Equal([pc], RolesOf(server, member));

        // A moderator taking a role by hand and giving it back makes it theirs, not the answers'.
        await owner.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = Array.Empty<long>() });
        await owner.RequestAsync("member.roles.set", new { accountKey = member.Key, roles = new[] { pc } });
        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { psAnswer } });
        Assert.Equal(new[] { pc, ps }.Order(), RolesOf(server, member));
    }

    [Fact]
    public async Task Answering_announces_the_change_and_is_rate_limited()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var group = await CreateQuestion(owner, new { title = "Q", multi = true, answers = new object[] { new { label = "PC", roles = new[] { pc } } } });
        var q = group.GetProperty("id").GetInt64();
        await member.RequestAsync("onboarding.answer", new { question = q, answers = AnswerIds(group) });
        JsonElement updated;
        do updated = (await owner.EventAsync("member.updated")).Body().GetProperty("member");
        while (updated.GetProperty("roles").GetArrayLength() == 0); // earlier updates (joining) come first
        Assert.Equal(member.Key, updated.GetProperty("accountKey").GetString());
        Assert.Equal([pc], Ids(updated.GetProperty("roles")));

        var codes = new List<string?>();
        for (var i = 0; i < 12; i++) codes.Add((await member.RequestAsync("onboarding.answer", new { question = q, answers = AnswerIds(group) })).ErrorCode());
        Assert.Contains("rate_limited", codes);
    }

    [Fact]
    public async Task Bots_get_neither_questions_nor_roles_on_join()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var pc = await CreateRole(owner, "PC");
        var group = await CreateQuestion(owner, new { title = "Q", answers = new object[] { new { label = "PC", roles = new[] { pc } } } });
        Assert.Equal("result", (await owner.RequestAsync("onboarding.autoroles.set", new { roles = new[] { pc } })).Type());

        using var bot = await JoinBot(server, owner);
        Assert.Empty(RolesOf(server, bot));
        var refused = await bot.RequestAsync("onboarding.answer", new { question = group.GetProperty("id").GetInt64(), answers = AnswerIds(group) });
        Assert.Equal("forbidden", refused.ErrorCode());
        Assert.Empty((await bot.RequestAsync("onboarding.mine")).Body().GetProperty("answers").EnumerateArray());
        Assert.Equal(1, (await owner.RequestAsync("onboarding.autoroles.apply")).Body().GetProperty("members").GetInt32()); // the owner, not the bot
        Assert.Empty(RolesOf(server, bot));
    }

    [Fact]
    public async Task Roles_on_join_are_safe_roles_given_to_new_people_only()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var early = await server.JoinAsync("Early");
        var newbie = await CreateRole(owner, "Newcomer");
        var pings = await CreateRole(owner, "Pings");
        var mod = await CreateRole(owner, "Moderator", selfAssign: false, permissions: ["kickMembers"]);
        var plain = await CreateRole(owner, "Plain", selfAssign: false);

        // Only role managers, only roles members could pick themselves, at most 10.
        Assert.Equal("forbidden", (await early.RequestAsync("onboarding.autoroles.set", new { roles = new[] { newbie } })).ErrorCode());
        Assert.Equal("forbidden", (await early.RequestAsync("onboarding.autoroles.apply")).ErrorCode());
        foreach (var bad in new[] { mod, plain })
            Assert.Equal("onboarding_auto_role", Key(await owner.RequestAsync("onboarding.autoroles.set", new { roles = new[] { newbie, bad } })));
        Assert.Equal("bad_request", (await owner.RequestAsync("onboarding.autoroles.set", new { roles = new[] { 999L } })).ErrorCode());
        Assert.Equal("onboarding_auto_roles_max", Key(await owner.RequestAsync("onboarding.autoroles.set", new { roles = Enumerable.Range(1, 11).Select(i => (long)i).ToArray() })));
        var set = await owner.RequestAsync("onboarding.autoroles.set", new { roles = new[] { newbie, pings } });
        Assert.Equal([newbie, pings], Ids(set.Body().GetProperty("autoRoles")));
        Assert.Equal([newbie, pings], Ids((await early.RequestAsync("role.list")).Body().GetProperty("autoRoles")));

        // New people get them (announced with them), whoever was here before doesn't.
        using var late = await server.JoinAsync("Late");
        Assert.Equal(new[] { newbie, pings }.Order(), RolesOf(server, late));
        Assert.Empty(RolesOf(server, early));
        var joined = (await early.EventAsync("member.joined")).Body().GetProperty("member");
        Assert.Equal(2, joined.GetProperty("roles").GetArrayLength());
        Assert.Equal(Perm.None, server.World.Store.GetMember(late.Key)!.Perms);
        Assert.Equal(0, server.World.Store.GetMember(late.Key)!.TopPosition);

        // People let in through an approval invite too.
        var code = (await owner.RequestAsync("invite.create", new { approve = true })).Body().GetProperty("invite").GetProperty("code").GetString()!;
        using var sam = new TestIdentity();
        using (var client = await server.ConnectAsync()) await client.LoginAsync(sam, "Sam", code);
        await owner.RequestAsync("join.approve", new { accountKey = sam.AccountKey });
        Assert.Equal(new[] { newbie, pings }.Order(), server.World.Store.GetMember(sam.AccountKey)!.RoleIds.Order());

        // A role that stops being pickable stops being given.
        await owner.RequestAsync("role.update", new { id = pings, selfAssign = false });
        Assert.Equal([newbie], server.World.Store.AutoRoles());

        // "Give to everyone now": the people who don't have them yet.
        var applied = await owner.RequestAsync("onboarding.autoroles.apply");
        Assert.Equal("result", applied.Type());
        Assert.Equal(2, applied.Body().GetProperty("members").GetInt32()); // the owner and Early
        Assert.Contains(newbie, RolesOf(server, early));
        Assert.Equal(0, (await owner.RequestAsync("onboarding.autoroles.apply")).Body().GetProperty("members").GetInt32());

        var actions = (await owner.RequestAsync("audit.list", new { limit = 100 })).Body().GetProperty("entries").EnumerateArray()
            .Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("onboarding.autoroles", actions);
        Assert.Contains("onboarding.autoroles.apply", actions);
    }

    [Fact]
    public async Task A_role_given_on_join_isnt_taken_back_by_changing_an_answer()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var pc = await CreateRole(owner, "PC");
        var ps = await CreateRole(owner, "PS");
        await owner.RequestAsync("onboarding.autoroles.set", new { roles = new[] { pc } });
        var group = await CreateQuestion(owner, new { title = "Q", answers = new object[] { new { label = "PC", roles = new[] { pc } }, new { label = "PS", roles = new[] { ps } } } });
        using var member = await server.JoinAsync("Member");
        var q = group.GetProperty("id").GetInt64();
        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { AnswerIds(group)[0] } });
        await member.RequestAsync("onboarding.answer", new { question = q, answers = new[] { AnswerIds(group)[1] } });
        Assert.Equal(new[] { pc, ps }.Order(), RolesOf(server, member));
    }

    [Fact]
    public async Task Answers_go_with_the_member_and_with_deleted_questions()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var member = await server.JoinAsync("Member");
        var pc = await CreateRole(owner, "PC");
        var group = await CreateQuestion(owner, new { title = "Q", answers = new object[] { new { label = "PC", roles = new[] { pc } } } });
        await member.RequestAsync("onboarding.answer", new { question = group.GetProperty("id").GetInt64(), answers = AnswerIds(group) });
        Assert.Single(server.World.Store.OnboardingAnswers(member.Key));
        Assert.Single(server.World.Store.OnboardingGrants(member.Key));
        // The member's data export has them.
        var data = await ComplianceTests.Download(server, (await member.RequestAsync("data.export")).Body());
        Assert.Equal("PC", Assert.Single(data.GetProperty("joinAnswers").EnumerateArray()).GetProperty("answer").GetString());
        Assert.Equal(pc, Assert.Single(data.GetProperty("joinAnswerRoles").EnumerateArray()).GetProperty("role_id").GetInt64());
        server.World.Store.RemoveMember(member.Key);
        Assert.Empty(server.World.Store.OnboardingAnswers(member.Key));
        Assert.Empty(server.World.Store.OnboardingGrants(member.Key));

        using var other = await server.JoinAsync("Other");
        await other.RequestAsync("onboarding.answer", new { question = group.GetProperty("id").GetInt64(), answers = AnswerIds(group) });
        await owner.RequestAsync("role.group.delete", new { id = group.GetProperty("id").GetInt64() });
        Assert.Empty(server.World.Store.OnboardingAnswers(other.Key));
        Assert.Contains(pc, RolesOf(server, other)); // deleting a question doesn't take roles from anyone
    }
}
