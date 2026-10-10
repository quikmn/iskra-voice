using System.Text.Json;
using System.Text.Json.Nodes;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class BotTests
{
    private static async Task<string> BotInvite(User admin, string? role = null)
    {
        var result = await admin.RequestAsync("bot.invite", role is null ? new { } : new { role });
        Assert.Equal("result", result.Type());
        return result.Body().GetProperty("invite").GetProperty("code").GetString()!;
    }

    /// <summary>Connects and authenticates, optionally saying it's a bot. Returns the reply to auth.</summary>
    private static async Task<(TestClient Client, TestIdentity Identity, JsonElement Reply)> Connect(IskraServer server, string? invite, bool bot, string name = "Dice")
    {
        var identity = new TestIdentity();
        var client = await server.ConnectAsync();
        var hello = await client.ReceiveAsync();
        var frame = identity.AuthFrame(hello, name, invite: invite);
        if (bot) ((JsonObject)frame["body"]!["profile"]!)["bot"] = true;
        await client.SendAsync(frame);
        return (client, identity, await client.ReceiveAsync());
    }

    [Fact]
    public async Task Only_admins_make_bot_invites_and_bots_stay_below_admin()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");

        Assert.Equal("forbidden", (await alice.RequestAsync("bot.invite")).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("bot.invite", new { role = "admin" })).ErrorCode());
        var invite = (await admin.RequestAsync("bot.invite", new { role = "trusted" })).Body().GetProperty("invite");
        Assert.Equal("trusted", invite.GetProperty("role").GetString());
        Assert.Equal(1, invite.GetProperty("maxUses").GetInt32());
    }

    [Fact]
    public async Task A_bot_joins_with_a_bot_invite_and_everyone_sees_the_flag()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var code = await BotInvite(admin);

        var (client, identity, welcome) = await Connect(server, code, bot: true);
        using var _ = client;
        using var __ = identity;
        Assert.Equal("welcome", welcome.Type());
        Assert.True(welcome.Body().GetProperty("you").GetProperty("bot").GetBoolean());
        Assert.False(admin.Welcome.Body().GetProperty("you").GetProperty("bot").GetBoolean());

        var joined = await admin.EventAsync("member.joined");
        Assert.True(joined.Body().GetProperty("member").GetProperty("bot").GetBoolean());

        // Bots chat like anyone else.
        var sent = await client.RequestAsync("chat.send", new { channelId = server.General, text = "🎲 4" });
        Assert.Equal("result", sent.Type());

        // Still a bot after reconnecting, whatever the profile says.
        client.Dispose();
        using var again = await server.ConnectAsync();
        var welcomeAgain = await again.LoginAsync(identity, "Dice");
        Assert.True(welcomeAgain.Body().GetProperty("you").GetProperty("bot").GetBoolean());
    }

    [Fact]
    public async Task Bot_and_human_invites_do_not_mix()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var botCode = await BotInvite(admin);

        // A bot with a normal invite is turned away (and the invite isn't used up).
        var normal = server.Invite();
        var (c1, i1, r1) = await Connect(server, normal, bot: true);
        using (c1) using (i1) Assert.Equal("invite_required", r1.ErrorCode());

        // A person can't use a bot invite either; the bot still can afterwards.
        var (c2, i2, r2) = await Connect(server, botCode, bot: false, "Mallory");
        using (c2) using (i2) Assert.Equal("invite_required", r2.ErrorCode());
        var (c3, i3, r3) = await Connect(server, botCode, bot: true);
        using (c3) using (i3) Assert.Equal("welcome", r3.Type());

        // Single use.
        var (c4, i4, r4) = await Connect(server, botCode, bot: true, "Dice 2");
        using (c4) using (i4) Assert.Equal("invite_required", r4.ErrorCode());
    }

    [Fact]
    public async Task Bots_cannot_join_voice_invite_people_or_be_promoted_to_admin()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        var voice = (await owner.RequestAsync("channel.create", new { name = "Lounge", kind = "voice" })).Body().GetProperty("channel").GetProperty("id").GetInt64();
        var (client, identity, welcome) = await Connect(server, await BotInvite(owner), bot: true);
        using var _ = client;
        using var __ = identity;
        Assert.Equal("welcome", welcome.Type());

        Assert.Equal("forbidden", (await client.RequestAsync("voice.join", new { channelId = voice })).ErrorCode());
        Assert.Equal("forbidden", (await client.RequestAsync("invite.create", new { })).ErrorCode());
        Assert.Equal("forbidden", (await client.RequestAsync("bot.invite", new { })).ErrorCode());
        Assert.Equal("forbidden", (await client.RequestAsync("webhook.list")).ErrorCode());

        Assert.Equal("bad_request", (await owner.RequestAsync("member.setRole", new { accountKey = identity.AccountKey, role = "admin" })).ErrorCode());
        Assert.Equal("result", (await owner.RequestAsync("member.setRole", new { accountKey = identity.AccountKey, role = "trusted" })).Type());
    }

    [Fact]
    public async Task Bots_have_the_same_rate_limits()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        var (client, identity, _) = await Connect(server, await BotInvite(admin), bot: true);
        using var _c = client;
        using var _i = identity;

        var limited = false;
        for (var i = 0; i < 15 && !limited; i++)
            limited = (await client.RequestAsync("chat.send", new { channelId = server.General, text = $"spam {i}" })).ErrorCode() == "rate_limited";
        Assert.True(limited);
    }
}
