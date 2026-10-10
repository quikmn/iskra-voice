using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Features;
using Iskra.Server.Storage;
using Iskra.Server.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Iskra.Server.Tests;

public class SafetyTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static object Envelope() => new { v = 2, ct = "opaque" };
    private static string NewCallId() => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16));

    private static Task<JsonElement> Sync(User user, params object[] entries) => user.RequestAsync("block.sync", new { entries });

    private static Dictionary<string, bool> AsMap(JsonElement blocks) =>
        blocks.EnumerateArray().ToDictionary(b => b.GetProperty("accountKey").GetString()!, b => b.GetProperty("blocked").GetBoolean());

    // ── Blocks ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task Block_lists_merge_newest_change_wins_and_reach_the_accounts_other_sessions()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var phone = new TestIdentity(alice.Identity.Account);
        using var phoneClient = await server.ConnectAsync();
        await phoneClient.LoginAsync(phone, "Alice");

        var t = Now;
        var merged = (await Sync(alice, new { accountKey = bob.Key, blocked = true, at = t }, new { accountKey = carol.Key, blocked = true, at = t }))
            .Body().GetProperty("blocks");
        Assert.Equal(new Dictionary<string, bool> { [bob.Key] = true, [carol.Key] = true }, AsMap(merged));
        Assert.Equal(2, (await phoneClient.EventAsync("blocks")).Body().GetProperty("blocks").GetArrayLength());

        // An older unblock (a device that was offline) loses; a newer one wins; a tie goes to the block.
        merged = (await Sync(alice, new { accountKey = bob.Key, blocked = false, at = t - 1000 },
            new { accountKey = carol.Key, blocked = false, at = t })).Body().GetProperty("blocks");
        Assert.True(AsMap(merged)[bob.Key]);
        Assert.True(AsMap(merged)[carol.Key]);
        await phoneClient.NoEventAsync("blocks"); // nothing changed
        merged = (await Sync(alice, new { accountKey = bob.Key, blocked = false, at = t + 1000 })).Body().GetProperty("blocks");
        Assert.False(AsMap(merged)[bob.Key]);
        Assert.False(AsMap((await phoneClient.EventAsync("blocks")).Body().GetProperty("blocks"))[bob.Key]);

        // Only your own list; nobody else's.
        Assert.False(AsMap((await alice.RequestAsync("block.list")).Body().GetProperty("blocks"))[bob.Key]);
        Assert.Equal(0, (await bob.RequestAsync("block.list")).Body().GetProperty("blocks").GetArrayLength());
        await bob.NoEventAsync("blocks");
    }

    [Fact]
    public async Task Block_entries_are_validated()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        Assert.Equal("bad_request", (await Sync(alice, new { accountKey = alice.Key, blocked = true, at = Now })).ErrorCode());
        Assert.Equal("bad_request", (await Sync(alice, new { accountKey = "not-a-key", blocked = true, at = Now })).ErrorCode());
        Assert.Equal("bad_request", (await Sync(alice, new { accountKey = bob.Key, blocked = true, at = Now + 3_600_000 })).ErrorCode());
        Assert.Equal("bad_request", (await Sync(alice, new { accountKey = bob.Key, at = Now })).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("block.sync", new { entries = "x" })).ErrorCode());
        var tooMany = Enumerable.Range(0, ModerationFeature.MaxBlocks + 1)
            .Select(_ => (object)new { accountKey = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32)), blocked = true, at = Now }).ToArray();
        Assert.Equal("bad_request", (await Sync(alice, tooMany)).ErrorCode());
        Assert.Equal(0, (await alice.RequestAsync("block.list")).Body().GetProperty("blocks").GetArrayLength());
    }

    [Fact]
    public async Task Full_lists_drop_the_oldest_unblocks_first()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var keys = Enumerable.Range(0, ModerationFeature.MaxBlocks).Select(_ => Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32))).ToList();
        server.World.Store.SaveBlocks(alice.Key, keys.Select((k, i) => new BlockEntry(k, i >= 10, 1000 + i)).ToList());

        var merged = (await Sync(alice, new { accountKey = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(32)), blocked = true, at = Now }))
            .Body().GetProperty("blocks");
        Assert.Equal(ModerationFeature.MaxBlocks, merged.GetArrayLength());
        Assert.DoesNotContain(keys[0], AsMap(merged).Keys); // the oldest unblock went
        Assert.Contains(keys[1], AsMap(merged).Keys);
    }

    [Fact]
    public async Task Blocked_people_cant_message_or_call_either_way_until_unblocked()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");

        // A ringing call ends when Alice blocks Bob.
        var ringing = NewCallId();
        Assert.Equal("result", (await bob.RequestAsync("call.start", new { accountKey = alice.Key, callId = ringing, envelope = Envelope() })).Type());
        await alice.EventAsync("call.ring");
        await Sync(alice, new { accountKey = bob.Key, blocked = true, at = Now });
        Assert.Equal(ringing, (await bob.EventAsync("call.ended")).Body().GetProperty("callId").GetString());

        var dm = await bob.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope() });
        Assert.Equal("forbidden", dm.ErrorCode());
        Assert.Equal("forbidden", (await alice.RequestAsync("dm.send", new { accountKey = bob.Key, envelope = Envelope() })).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("call.start", new { accountKey = alice.Key, callId = NewCallId(), envelope = Envelope() })).ErrorCode());
        await alice.NoEventAsync("dm.message");
        await alice.NoEventAsync("call.ring");
        // The refusal doesn't say who blocked whom.
        Assert.DoesNotContain("block", dm.Body().GetProperty("message").GetString()!, StringComparison.OrdinalIgnoreCase);
        // Your own devices still work.
        Assert.Equal("result", (await alice.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope() })).Type());

        await Sync(alice, new { accountKey = bob.Key, blocked = false, at = Now + 1 });
        Assert.Equal("result", (await bob.RequestAsync("dm.send", new { accountKey = alice.Key, envelope = Envelope() })).Type());
        Assert.Equal("result", (await bob.RequestAsync("call.start", new { accountKey = alice.Key, callId = NewCallId(), envelope = Envelope() })).Type());
    }

    // ── Timeouts ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task Only_admins_who_outrank_the_member_can_time_them_out_for_the_offered_lengths()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var other = await server.JoinAsync("Other admin", "admin");
        using var trusted = await server.JoinAsync("Trusted", "trusted");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await trusted.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 60_000 })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("member.timeout", new { accountKey = other.Key, durationMs = 60_000 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("member.timeout", new { accountKey = admin.Key, durationMs = 60_000 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 1234 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("member.timeout", new { accountKey = member.Key })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("member.timeout",
            new { accountKey = member.Key, durationMs = 60_000, reason = new string('x', 201) })).ErrorCode());
        Assert.Equal("not_found", (await admin.RequestAsync("member.timeout.remove", new { accountKey = member.Key })).ErrorCode());
        Assert.Equal("forbidden", (await trusted.RequestAsync("member.timeout.remove", new { accountKey = member.Key })).ErrorCode());
    }

    [Fact]
    public async Task Timed_out_members_cant_write_react_or_use_voice_until_it_ends()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        var message = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "hi" })).Body().GetProperty("message").GetProperty("id").GetInt64();

        var before = Now;
        var result = await admin.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 300_000, reason = "cool off" });
        var until = result.Body().GetProperty("member").GetProperty("timedOutUntil").GetInt64();
        Assert.InRange(until, before + 300_000, Now + 300_000);
        var updated = (await member.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.Equal(until, updated.GetProperty("timedOutUntil").GetInt64());

        // The member sees why; everyone else only when it ends.
        var status = (await member.RequestAsync("member.timeout.status")).Body().GetProperty("timeout");
        Assert.Equal("cool off", status.GetProperty("reason").GetString());
        Assert.Equal(JsonValueKind.Null, (await admin.RequestAsync("member.timeout.status")).Body().GetProperty("timeout").ValueKind);

        Assert.Equal("forbidden", (await member.RequestAsync("chat.send", new { channelId = server.General, text = "spam" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("chat.react", new { id = message, emoji = "👍" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("thread.create", new { messageId = message, name = "t" })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("poll.create",
            new { channelId = server.General, question = "q?", options = new[] { "a", "b" } })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("voice.join", new { channelId = lounge })).ErrorCode());
        Assert.Equal("forbidden", (await member.RequestAsync("call.start",
            new { accountKey = admin.Key, callId = NewCallId(), envelope = Envelope() })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("call.start",
            new { accountKey = member.Key, callId = NewCallId(), envelope = Envelope() })).ErrorCode());
        // Reading still works.
        Assert.Equal("result", (await member.RequestAsync("chat.history", new { channelId = server.General })).Type());

        Assert.Equal("result", (await admin.RequestAsync("member.timeout.remove", new { accountKey = member.Key })).Type());
        Assert.Equal(JsonValueKind.Null, (await member.EventAsync("member.updated")).Body().GetProperty("member").GetProperty("timedOutUntil").ValueKind);
        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = server.General, text = "sorry" })).Type());
    }

    [Fact]
    public async Task Timeouts_end_by_themselves_and_everyone_hears_about_it()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        server.World.Store.SetTimeout(new MemberTimeout(member.Key, Now - 1, "", admin.Key, Now - 60_000));

        // Already over: enforcement uses the clock, not the sweep.
        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = server.General, text = "back" })).Type());

        server.Services.GetServices<IHostedService>().OfType<ModerationSweeper>().Single().Sweep(pruneAudit: false);
        var updated = (await admin.EventAsync("member.updated")).Body().GetProperty("member");
        Assert.Equal(member.Key, updated.GetProperty("accountKey").GetString());
        Assert.Equal(JsonValueKind.Null, updated.GetProperty("timedOutUntil").ValueKind);
        Assert.Null(server.World.Store.GetTimeout(member.Key));
    }

    [Fact]
    public async Task A_timeout_takes_the_member_out_of_voice()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        server.Services.GetRequiredService<Iskra.Server.Voice.VoiceRegistry>().Joined(lounge, member.Key, Now);

        await admin.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 60_000 });
        Assert.Contains(($"voice-{lounge}", member.Key), server.Voice.Removed);
    }

    // ── Slowmode ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task Slowmode_limits_members_but_not_admins()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("forbidden", (await member.RequestAsync("channel.update", new { id = server.General, slowmode = 30 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = server.General, slowmode = 7 })).ErrorCode());
        Assert.Equal("bad_request", (await admin.RequestAsync("channel.update", new { id = server.General, slowmode = -5 })).ErrorCode());
        var channel = (await admin.RequestAsync("channel.update", new { id = server.General, slowmode = 30 })).Body().GetProperty("channel");
        Assert.Equal(30, channel.GetProperty("slowmode").GetInt32());
        var channels = (await member.EventAsync("channels")).Body().GetProperty("channels");
        Assert.Equal(30, channels.EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == server.General).GetProperty("slowmode").GetInt32());

        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = server.General, text = "one" })).Type());
        var second = await member.RequestAsync("chat.send", new { channelId = server.General, text = "two" });
        Assert.Equal("rate_limited", second.ErrorCode());
        Assert.Contains("again in", second.Body().GetProperty("message").GetString());
        Assert.Equal("rate_limited", (await member.RequestAsync("poll.create",
            new { channelId = server.General, question = "q?", options = new[] { "a", "b" } })).ErrorCode());
        // An invalid message doesn't use up the slot.
        using var other = await server.JoinAsync("Other");
        Assert.Equal("bad_request", (await other.RequestAsync("chat.send", new { channelId = server.General, text = "" })).ErrorCode());
        Assert.Equal("result", (await other.RequestAsync("chat.send", new { channelId = server.General, text = "hello" })).Type());

        for (var i = 0; i < 3; i++)
            Assert.Equal("result", (await admin.RequestAsync("chat.send", new { channelId = server.General, text = $"admin {i}" })).Type());

        await admin.RequestAsync("channel.update", new { id = server.General, slowmode = 0 });
        Assert.Equal("result", (await member.RequestAsync("chat.send", new { channelId = server.General, text = "free" })).Type());
    }

    [Fact]
    public void Slowmode_tracker_counts_per_member_and_channel()
    {
        var tracker = new SlowmodeTracker();
        Assert.True(tracker.TryTake(1, "a", 5000, 1000, out _));
        Assert.False(tracker.TryTake(1, "a", 5000, 3000, out var wait));
        Assert.Equal(3000, wait);
        Assert.True(tracker.TryTake(1, "b", 5000, 3000, out _));
        Assert.True(tracker.TryTake(2, "a", 5000, 3000, out _));
        Assert.True(tracker.TryTake(1, "a", 5000, 6000, out _));
    }

    // ── Audit log ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Admin_actions_land_in_the_audit_log_which_only_admins_read()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");
        using var guest = await server.JoinAsync("Guest", "guest");

        await admin.RequestAsync("member.timeout", new { accountKey = member.Key, durationMs = 60_000, reason = "spam" });
        await admin.RequestAsync("member.setRole", new { accountKey = guest.Key, role = "trusted" });
        var created = (await admin.RequestAsync("channel.create", new { name = "news", writeRole = "admin" })).Body().GetProperty("channel");
        await admin.RequestAsync("channel.update", new { id = created.GetProperty("id").GetInt64(), slowmode = 60 });
        var own = (await admin.RequestAsync("chat.send", new { channelId = server.General, text = "mine" })).Body().GetProperty("message").GetProperty("id").GetInt64();
        await admin.RequestAsync("chat.delete", new { id = own }); // your own message: not logged
        var theirs = server.World.Store.AddMessage(server.General, guest.Key, "bad words", Now).Id;
        await admin.RequestAsync("chat.delete", new { id = theirs });
        await admin.RequestAsync("member.kick", new { accountKey = guest.Key });
        await owner.RequestAsync("profile.pages.configure", new { enabled = false });

        Assert.Equal("forbidden", (await member.RequestAsync("audit.list")).ErrorCode());
        var body = (await admin.RequestAsync("audit.list")).Body();
        var entries = body.GetProperty("entries").EnumerateArray().ToList();
        Assert.Equal(["server.pages", "member.kick", "message.delete", "channel.update", "channel.create", "member.role", "member.timeout"],
            entries.Select(e => e.GetProperty("action").GetString()!).ToArray());
        Assert.False(body.GetProperty("hasMore").GetBoolean());

        var timeout = entries.Single(e => e.GetProperty("action").GetString() == "member.timeout");
        Assert.Equal(admin.Key, timeout.GetProperty("actor").GetString());
        Assert.Equal("Admin", timeout.GetProperty("actorName").GetString());
        Assert.Equal(member.Key, timeout.GetProperty("target").GetString());
        Assert.Equal("spam", timeout.GetProperty("reason").GetString());
        Assert.Equal(60_000, timeout.GetProperty("details").GetProperty("durationMs").GetInt64());
        var role = entries.Single(e => e.GetProperty("action").GetString() == "member.role").GetProperty("details");
        Assert.Equal("guest", role.GetProperty("from").GetString());
        Assert.Equal("trusted", role.GetProperty("to").GetString());
        var update = entries.Single(e => e.GetProperty("action").GetString() == "channel.update").GetProperty("details");
        Assert.Equal(60, update.GetProperty("changes").GetProperty("slowmode").GetProperty("to").GetInt32());
        // The kicked member's name stays readable.
        Assert.Equal("Guest", entries.Single(e => e.GetProperty("action").GetString() == "member.kick").GetProperty("targetName").GetString());
        // Message text is never recorded.
        Assert.DoesNotContain("bad words", body.GetRawText());

        // Filters: by action, by person (actor or target), and paging.
        var kicks = (await admin.RequestAsync("audit.list", new { action = "member.kick" })).Body().GetProperty("entries");
        Assert.Equal(1, kicks.GetArrayLength());
        var aboutGuest = (await admin.RequestAsync("audit.list", new { person = guest.Key })).Body().GetProperty("entries");
        Assert.Equal(["member.kick", "message.delete", "member.role"], aboutGuest.EnumerateArray().Select(e => e.GetProperty("action").GetString()!).ToArray());
        var byOwner = (await admin.RequestAsync("audit.list", new { person = owner.Key })).Body().GetProperty("entries");
        Assert.Equal("server.pages", byOwner.EnumerateArray().Single().GetProperty("action").GetString());
        var page = (await admin.RequestAsync("audit.list", new { limit = 2 })).Body();
        Assert.True(page.GetProperty("hasMore").GetBoolean());
        var next = (await admin.RequestAsync("audit.list", new { limit = 2, before = page.GetProperty("entries")[1].GetProperty("id").GetInt64() })).Body();
        Assert.Equal("message.delete", next.GetProperty("entries")[0].GetProperty("action").GetString());
        Assert.Equal("bad_request", (await admin.RequestAsync("audit.list", new { limit = 500 })).ErrorCode());
    }

    [Fact]
    public async Task Audit_entries_older_than_ninety_days_are_dropped()
    {
        using var server = new IskraServer();
        using var admin = await server.JoinAsync("Admin", "admin");
        server.World.Store.AddAudit(Now - (long)TimeSpan.FromDays(91).TotalMilliseconds, "member.kick", admin.Key, "Admin", null, null, null, null);
        server.World.Store.AddAudit(Now - (long)TimeSpan.FromDays(89).TotalMilliseconds, "member.ban", admin.Key, "Admin", null, null, null, null);

        server.Services.GetServices<IHostedService>().OfType<ModerationSweeper>().Single().Sweep(pruneAudit: true);
        var entries = (await admin.RequestAsync("audit.list")).Body().GetProperty("entries");
        Assert.Equal("member.ban", entries.EnumerateArray().Single().GetProperty("action").GetString());
    }
}
