using System.Security.Cryptography;
using System.Text.Json;
using Iskra.Server.Crypto;
using Iskra.Server.Tests.Support;

namespace Iskra.Server.Tests;

public class EventTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private const long Hour = 3_600_000;

    private static object Plan(string title = "Game night", long? start = null, long? end = null, object? location = null, string zone = "Europe/Stockholm")
    {
        var s = start ?? Now + Hour;
        return new { title, description = "Bring snacks", startAt = s, endAt = end ?? s + 2 * Hour, timeZone = zone, location = location ?? new { text = "Viktor's place" } };
    }

    private static async Task<JsonElement> Create(User user, object plan)
    {
        var reply = await user.RequestAsync("event.create", plan);
        Assert.Equal("result", reply.Type());
        return reply.Body().GetProperty("event");
    }

    [Fact]
    public async Task Members_schedule_events_and_others_mark_interest()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var e = await Create(alice, Plan());
        var id = e.GetProperty("id").GetInt64();
        Assert.Equal("Game night", e.GetProperty("title").GetString());
        Assert.Equal("Europe/Stockholm", e.GetProperty("timeZone").GetString());
        Assert.Equal("scheduled", e.GetProperty("status").GetString());
        Assert.Equal("place", e.GetProperty("location").GetProperty("kind").GetString());
        Assert.Equal([alice.Key], e.GetProperty("interested").EnumerateArray().Select(k => k.GetString()));
        Assert.Equal(id, (await bob.EventAsync("event.updated")).Body().GetProperty("event").GetProperty("id").GetInt64());

        var marked = (await bob.RequestAsync("event.interest", new { id, on = true })).Body().GetProperty("event");
        Assert.Equal(2, marked.GetProperty("interested").GetArrayLength());
        await alice.EventAsync("event.updated"); // created
        Assert.Equal(2, (await alice.EventAsync("event.updated")).Body().GetProperty("event").GetProperty("interested").GetArrayLength());
        await bob.RequestAsync("event.interest", new { id, on = false });
        var list = (await bob.RequestAsync("event.list")).Body().GetProperty("events");
        Assert.Equal([alice.Key], list.EnumerateArray().Single().GetProperty("interested").EnumerateArray().Select(k => k.GetString()));
    }

    [Fact]
    public async Task Bad_times_places_and_zones_are_refused()
    {
        using var server = new IskraServer();
        var text = server.World.Store.CreateChannel("chat", "text", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var guest = await server.JoinAsync("Guest", "guest");

        Assert.Equal("forbidden", (await guest.RequestAsync("event.create", Plan())).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(start: Now - Hour))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(start: Now + Hour, end: Now + Hour))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(start: Now + Hour, end: Now + 8 * 24 * Hour))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(start: Now + 400L * 24 * Hour))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(zone: "Mars/Olympus_Mons"))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(zone: "../etc/passwd"))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(title: ""))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(location: new { text = "" }))).ErrorCode());
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", Plan(location: new { channelId = text }))).ErrorCode());
        Assert.Equal("result", (await alice.RequestAsync("event.create", Plan(zone: "America/New_York"))).Type());
        Assert.Equal("result", (await alice.RequestAsync("event.create", Plan(zone: "UTC"))).Type());

        // A cover image must be your own image upload.
        Assert.Equal("bad_request", (await alice.RequestAsync("event.create", new
        {
            title = "x", startAt = Now + Hour, endAt = Now + 2 * Hour, timeZone = "UTC", location = new { text = "here" }, image = "nope",
        })).ErrorCode());
    }

    [Fact]
    public async Task Events_in_a_voice_channel_are_only_seen_by_its_readers()
    {
        using var server = new IskraServer();
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        var staff = server.World.Store.CreateChannel("staff-voice", "voice", "trusted", "trusted", 0).Id;
        using var admin = await server.JoinAsync("Admin", "admin");
        using var member = await server.JoinAsync("Member");

        Assert.Equal("not_found", (await member.RequestAsync("event.create", Plan(location: new { channelId = staff }))).ErrorCode());
        var secret = (await Create(admin, Plan("Staff meeting", location: new { channelId = staff }))).GetProperty("id").GetInt64();
        await member.NoEventAsync("event.updated");
        Assert.Empty((await member.RequestAsync("event.list")).Body().GetProperty("events").EnumerateArray());
        Assert.Equal("not_found", (await member.RequestAsync("event.interest", new { id = secret })).ErrorCode());

        // Moving it to an open channel shows it; moving it back hides it again.
        var open = (await Create(admin, Plan("Movie", location: new { channelId = lounge }))).GetProperty("id").GetInt64();
        Assert.Equal(open, (await member.EventAsync("event.updated")).Body().GetProperty("event").GetProperty("id").GetInt64());
        await admin.RequestAsync("event.update", new { id = open, location = new { channelId = staff } });
        Assert.Equal(open, (await member.EventAsync("event.removed")).Body().GetProperty("id").GetInt64());
        await admin.RequestAsync("event.update", new { id = secret, location = new { text = "the office" } });
        Assert.Equal(secret, (await member.EventAsync("event.updated")).Body().GetProperty("event").GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task Only_the_creator_or_an_admin_who_outranks_them_edits_and_cancels()
    {
        using var server = new IskraServer();
        using var owner = await server.JoinAsync("Owner", "owner");
        using var admin = await server.JoinAsync("Admin", "admin");
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        var id = (await Create(alice, Plan())).GetProperty("id").GetInt64();
        var ownerEvent = (await Create(owner, Plan("Owner's"))).GetProperty("id").GetInt64();

        Assert.Equal("forbidden", (await bob.RequestAsync("event.update", new { id, title = "mine" })).ErrorCode());
        Assert.Equal("forbidden", (await bob.RequestAsync("event.cancel", new { id })).ErrorCode());
        Assert.Equal("forbidden", (await admin.RequestAsync("event.cancel", new { id = ownerEvent })).ErrorCode());

        var start = Now + 3 * Hour;
        var edited = (await alice.RequestAsync("event.update", new { id, title = "Board games", startAt = start, endAt = start + Hour, description = "" })).Body().GetProperty("event");
        Assert.Equal("Board games", edited.GetProperty("title").GetString());
        Assert.Equal(start, edited.GetProperty("startAt").GetInt64());
        Assert.Equal(JsonValueKind.Null, edited.GetProperty("description").ValueKind);
        Assert.Equal("bad_request", (await alice.RequestAsync("event.update", new { id, endAt = start - 1 })).ErrorCode());

        Assert.Equal("result", (await admin.RequestAsync("event.cancel", new { id })).Type());
        JsonElement cancelled;
        do cancelled = (await bob.EventAsync("event.updated")).Body().GetProperty("event");
        while (cancelled.GetProperty("id").GetInt64() != id || cancelled.GetProperty("status").GetString() != "cancelled");
        Assert.DoesNotContain((await bob.RequestAsync("event.list")).Body().GetProperty("events").EnumerateArray(), e => e.GetProperty("id").GetInt64() == id);
        Assert.Equal("bad_request", (await alice.RequestAsync("event.update", new { id, title = "back?" })).ErrorCode());
        Assert.Equal("bad_request", (await bob.RequestAsync("event.interest", new { id })).ErrorCode());
    }

    [Fact]
    public async Task Reminders_then_live_then_ended_with_pushes_to_interested_members()
    {
        using var server = new IskraServer { Settings = { ["Events:ReminderLeadMs"] = "2000" } };
        var lounge = server.World.Store.CreateChannel("lounge", "voice", "member", "member", 0).Id;
        using var alice = await server.JoinAsync("Alice");
        using var bob = await server.JoinAsync("Bob");
        using var carol = await server.JoinAsync("Carol");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var q = key.ExportParameters(false).Q;
        var endpoint = $"https://fcm.googleapis.com/fcm/send/bob-{Guid.NewGuid():N}";
        Assert.Equal("result", (await bob.RequestAsync("push.subscribe", new
        {
            endpoint, keys = new { p256dh = Ed25519.ToB64u([4, .. q.X!, .. q.Y!]), auth = Ed25519.ToB64u(RandomNumberGenerator.GetBytes(16)) },
        })).Type());

        var start = Now + 3500;
        var id = (await Create(alice, Plan("Quick game", start, start + 2000, new { channelId = lounge }))).GetProperty("id").GetInt64();
        await bob.RequestAsync("event.interest", new { id });

        var soon = (await bob.EventAsync("event.reminder")).Body();
        Assert.Equal("soon", soon.GetProperty("kind").GetString());
        Assert.Equal(id, soon.GetProperty("event").GetProperty("id").GetInt64());
        var push = (await server.Push.WaitForAsync(endpoint))[0];
        Assert.Equal("event", push.GetProperty("kind").GetString());
        Assert.Contains("Quick game", push.GetProperty("title").GetString());
        Assert.Equal(JsonValueKind.Null, push.GetProperty("channelId").ValueKind);

        var live = (await bob.EventAsync("event.reminder")).Body();
        Assert.Equal("live", live.GetProperty("kind").GetString());
        Assert.Equal("live", live.GetProperty("event").GetProperty("status").GetString());
        await server.Push.WaitForAsync(endpoint, 2);
        await carol.NoEventAsync("event.reminder");

        // It ends on its own and drops out of the list.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while ((await carol.RequestAsync("event.list")).Body().GetProperty("events").GetArrayLength() > 0)
        {
            Assert.True(DateTime.UtcNow < deadline, "the event never ended");
            await Task.Delay(100);
        }
        Assert.Equal("ended", server.World.Store.GetEvent(id)!.Status);
        Assert.Equal("bad_request", (await alice.RequestAsync("event.cancel", new { id })).ErrorCode());
    }

    [Fact]
    public async Task Interest_toggling_is_rate_limited()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var id = (await Create(alice, Plan())).GetProperty("id").GetInt64();
        var codes = new List<string?>();
        for (var i = 0; i < 8; i++) codes.Add((await alice.RequestAsync("event.interest", new { id, on = i % 2 == 0 })).ErrorCode());
        Assert.Contains("rate_limited", codes);
    }

    [Fact]
    public async Task Event_cover_images_survive_the_upload_sweep()
    {
        using var server = new IskraServer();
        using var alice = await server.JoinAsync("Alice");
        var file = new Iskra.Server.Storage.StoredFile("cover-file-0000001", new string('a', 64), "cover.png", 100, "image/png", 64, 32, alice.Key, 0);
        server.World.Store.AddFile(file);
        var e = await Create(alice, new
        {
            title = "With a cover", startAt = Now + Hour, endAt = Now + 2 * Hour, timeZone = "UTC", location = new { text = "here" }, image = file.Id,
        });
        Assert.Equal(file.Id, e.GetProperty("image").GetProperty("id").GetString());
        server.World.Store.DeleteUnreferencedFiles(Now, []);
        Assert.NotNull(server.World.Store.GetFile(file.Id));
    }
}
