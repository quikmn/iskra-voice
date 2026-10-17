using System.Text.Json;
using Iskra.Server.Features;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

/// <summary>Which invite someone joined with: recorded, shown only to moderators, exported, and gone with the member.</summary>
public class InviteTrackTests
{
    private static async Task<JsonElement> CreateInvite(User by, object body)
    {
        var reply = await by.RequestAsync("invite.create", body);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("invite");
    }

    private static async Task<User> JoinWith(IskraServer server, string name, string code)
    {
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var welcome = await client.LoginAsync(identity, name, code);
        Assert.Equal("welcome", welcome.Type());
        return new User(identity, client, welcome);
    }

    private static JsonElement[] Joins(JsonElement reply) => [.. reply.Body().GetProperty("joins").EnumerateArray()];

    [Fact]
    public async Task The_invite_a_member_joined_with_is_recorded_for_moderators_only()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var mod = await server.JoinAsync("Mod", "admin");
        using var anna = await server.JoinAsync("Anna");

        // Labels: optional, one line, ≤ 40 characters; the invite gets a public id that isn't its code.
        var reddit = await CreateInvite(anna, new { label = "  Reddit post  " });
        Assert.Equal("Reddit post", reddit.GetProperty("label").GetString());
        var code = reddit.GetProperty("code").GetString()!;
        var id = reddit.GetProperty("id").GetString()!;
        Assert.Equal(InviteTrackFeature.PublicId(code), id);
        Assert.Equal(11, id.Length);
        Assert.DoesNotContain(id, code);
        Assert.Equal("bad_request", (await anna.RequestAsync("invite.create", new { label = new string('x', 41) })).ErrorCode());
        Assert.Equal("bad_request", (await anna.RequestAsync("invite.create", new { label = "two\nlines" })).ErrorCode());
        Assert.Equal(JsonValueKind.Null, (await CreateInvite(anna, new { label = " " })).GetProperty("label").ValueKind);
        var listed = (await anna.RequestAsync("invite.list")).Body().GetProperty("invites").EnumerateArray().Single(i => i.GetProperty("code").GetString() == code);
        Assert.Equal("Reddit post", listed.GetProperty("label").GetString());

        using var sam = await JoinWith(server, "Sam", code);

        // Moderators see it; members (even the invite's maker) don't.
        Assert.Equal("forbidden", (await anna.RequestAsync("invite.joins")).ErrorCode());
        Assert.Equal("forbidden", (await sam.RequestAsync("invite.joins", new { accountKey = sam.Key })).ErrorCode());
        var join = Assert.Single(Joins(await mod.RequestAsync("invite.joins", new { accountKey = sam.Key })));
        Assert.Equal(sam.Key, join.GetProperty("accountKey").GetString());
        var invite = join.GetProperty("invite");
        Assert.Equal(id, invite.GetProperty("id").GetString());
        Assert.Equal("Reddit post", invite.GetProperty("label").GetString());
        Assert.Equal(anna.Key, invite.GetProperty("createdBy").GetString());
        Assert.Equal("Anna", invite.GetProperty("createdByName").GetString());
        Assert.Equal("member", invite.GetProperty("role").GetString());
        Assert.Equal(JsonValueKind.Null, join.GetProperty("approvedBy").ValueKind);
        Assert.DoesNotContain(code, (await mod.RequestAsync("invite.joins")).GetRawText());

        // A filter by invite, and everyone (newest first).
        var byInvite = Joins(await mod.RequestAsync("invite.joins", new { inviteId = id }));
        Assert.Equal([sam.Key], byInvite.Select(j => j.GetProperty("accountKey").GetString()));
        var all = Joins(await mod.RequestAsync("invite.joins"));
        Assert.Equal(sam.Key, all[0].GetProperty("accountKey").GetString());
        Assert.Contains(all, j => j.GetProperty("accountKey").GetString() == anna.Key);

        // The join's audit entry names the invite (not its code), and it's in Sam's moderation history.
        var history = (await mod.RequestAsync("member.history", new { accountKey = sam.Key })).Body().GetProperty("entries");
        var entry = history.EnumerateArray().Single(e => e.GetProperty("action").GetString() == "member.join");
        Assert.Equal(sam.Key, entry.GetProperty("target").GetString());
        Assert.Equal(id, entry.GetProperty("details").GetProperty("invite").GetProperty("id").GetString());
        Assert.Equal("Reddit post", entry.GetProperty("details").GetProperty("invite").GetProperty("label").GetString());
        Assert.DoesNotContain(code, history.GetRawText());
        var audit = (await owner.RequestAsync("audit.list")).GetRawText();
        Assert.DoesNotContain(code, audit);
    }

    [Fact]
    public async Task Approved_joins_record_who_let_them_in()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var code = (await CreateInvite(owner, new { approve = true, label = "Forum" })).GetProperty("code").GetString()!;
        using var sam = new TestIdentity();
        using (var client = await server.ConnectAsync())
            Assert.Equal("join_pending", (await client.LoginAsync(sam, "Sam", code)).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("join.approve", new { accountKey = sam.AccountKey })).Type());

        var join = Assert.Single(Joins(await owner.RequestAsync("invite.joins", new { accountKey = sam.AccountKey })));
        Assert.Equal(owner.Key, join.GetProperty("approvedBy").GetString());
        Assert.Equal("Owner", join.GetProperty("approvedByName").GetString());
        Assert.Equal("Forum", join.GetProperty("invite").GetProperty("label").GetString());
        var approve = (await owner.RequestAsync("member.history", new { accountKey = sam.AccountKey })).Body().GetProperty("entries")
            .EnumerateArray().Single(e => e.GetProperty("action").GetString() == "join.approve");
        Assert.Equal("Forum", approve.GetProperty("details").GetProperty("invite").GetProperty("label").GetString());
    }

    [Fact]
    public async Task Members_export_it_and_it_goes_when_they_leave_or_delete_their_account()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var invite = await CreateInvite(owner, new { label = "Friends", maxUses = 5 });
        var code = invite.GetProperty("code").GetString()!;
        using var sam = await JoinWith(server, "Sam", code);
        using var kim = await JoinWith(server, "Kim", code);

        // Sam's own data has it (the id, never the link's code).
        var data = await ComplianceTests.Download(server, (await sam.RequestAsync("data.export")).Body());
        var row = Assert.Single(data.GetProperty("joinedVia").EnumerateArray());
        Assert.Equal(invite.GetProperty("id").GetString(), row.GetProperty("invite_id").GetString());
        Assert.Equal("Friends", row.GetProperty("label").GetString());
        Assert.DoesNotContain(code, data.GetRawText());
        // The maker's invitesCreated includes the label.
        var ownerData = await ComplianceTests.Download(server, (await owner.RequestAsync("data.export")).Body());
        Assert.Contains(ownerData.GetProperty("invitesCreated").EnumerateArray(), i => i.GetProperty("label").GetString() == "Friends");

        // Leaving and kicks forget it.
        Assert.Equal("result", (await sam.RequestAsync("member.leave")).Type());
        Assert.Empty(Joins(await owner.RequestAsync("invite.joins", new { accountKey = sam.Key })));
        Assert.Empty(server.World.Store.JoinsVia(sam.Key, null, 10));
        Assert.Equal("result", (await owner.RequestAsync("member.kick", new { accountKey = kim.Key })).Type());
        Assert.Empty(server.World.Store.JoinsVia(kim.Key, null, 10));

        // So does deleting the account.
        using var lee = await JoinWith(server, "Lee", code);
        Assert.Single(server.World.Store.JoinsVia(lee.Key, null, 10));
        Assert.Equal("result", (await lee.RequestAsync("account.delete", new { deletion = AccountDeletionTests.Deletion(lee.Identity, messages: false) })).Type());
        Assert.Empty(server.World.Store.JoinsVia(lee.Key, null, 10));
    }
}
