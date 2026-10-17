namespace Iskra.Server.Sessions;

/// <summary>A token bucket per request type, per session. Not thread-safe: only the session's read loop uses it.</summary>
public sealed class RateLimiter(TimeProvider time)
{
    private sealed class Bucket(double capacity, double perSecond, long now)
    {
        public double Tokens = capacity;
        public long Updated = now;
        public readonly double Capacity = capacity;
        public readonly double PerSecond = perSecond;
    }

    private static readonly Dictionary<string, (double Burst, double PerSecond)> Limits = new()
    {
        ["chat.send"] = (10, 2),
        ["dm.send"] = (10, 2),
        ["group.send"] = (10, 2),
        ["chat.forward"] = (10, 2),
        ["prefs.set"] = (10, 1),
        ["upload.begin"] = (10, 2),
        ["chat.react"] = (20, 5),
        ["link.preview"] = (10, 1),
        ["chat.typing"] = (3, 0.5),
        ["search"] = (10, 2),
        ["poll.create"] = (5, 0.2),
        ["poll.vote"] = (10, 2),
        ["sound.play"] = (3, 0.5),
        ["voice.clip"] = (3, 0.1),
        ["stage.hand"] = (5, 0.5),
        ["watch.start"] = (8, 0.5),
        ["watch.control"] = (10, 4),
        ["watch.chat"] = (5, 1),
        ["watch.clock"] = (10, 2),
        ["watch.queue.add"] = (10, 1),
        ["watch.queue.remove"] = (20, 4),
        ["watch.queue.move"] = (20, 4),
        ["watch.next"] = (10, 2),
        ["activity.change"] = (5, 0.1), // checked by ActivityFeature, only on real changes
        ["link.create"] = (3, 0.1),
        ["event.interest"] = (5, 1),
        ["presence.set"] = (10, 1),
        ["dm.upload.begin"] = (10, 2),
        ["dm.file.url"] = (40, 10),
        ["captions.model.link"] = (10, 1),
        ["translate.models.link"] = (10, 1),
        ["translate.configure"] = (10, 1),
        ["gif.search"] = (10, 1),
        ["gif.trending"] = (10, 1),
        ["gif.categories"] = (5, 0.2),
        ["presence.idle"] = (10, 0.5),
        ["voice.idle"] = (10, 0.5),
        ["whisper.start"] = (10, 2), // every press of a whisper key
        ["whisper.join"] = (20, 4),
        ["voice.priority"] = (20, 4), // every press of the priority key
        ["device.revoke.new"] = (10, 10 / 3600.0), // new revocations: 10 an hour, so a thief can't use up the 100 at once
        ["account.rotate"] = (10, 0.2),
        ["update.check"] = (3, 0.05),
        ["reminder.create"] = (10, 1),
        ["scheduled.create"] = (10, 1),
        ["docs.page.create"] = (5, 0.2),
        ["docs.page.save"] = (10, 1),
        ["docs.page.restore"] = (5, 0.2),
        ["disappear.set"] = (10, 1),
        ["docs.page.move"] = (10, 1),
        ["docs.search"] = (10, 2),
        ["wb.update"] = (20, 8),
        ["wb.live"] = (10, 8),
        ["wb.get"] = (20, 5),
        ["wb.open"] = (5, 0.2),
        ["wb.clear"] = (5, 0.2),
        ["wb.snapshot"] = (5, 0.1),
        ["data.export"] = (2, 1 / 600.0), // "Download my data": two, then one every 10 minutes
        ["role.base.update"] = (30, 2), // ticking powers one by one
        ["roles.self"] = (10, 1), // picking your own roles, one tap each
        ["join.settings.update"] = (10, 1),
        ["chat.delete.bulk"] = (5, 0.2), // up to 100 messages each
        ["member.warn"] = (10, 0.5),
        ["member.notes.add"] = (10, 0.5),
        ["member.avatar"] = (10, 0.5), // reads and re-writes up to 1 MB
        ["notify.default.set"] = (10, 1),
        ["server.template.export"] = (3, 0.1), // builds a whole template
        ["outhook.create"] = (10, 0.5),
        ["outhook.update"] = (10, 1),
        ["outhook.test"] = (3, 0.2),
        ["outhook.hosts"] = (10, 1),
        ["security.log.list"] = (20, 2),
        ["profile.page.get"] = (5, 0.2), // up to 512 KB each
        ["bot.commands.set"] = (5, 0.2),
        ["server.images.set"] = (10, 0.5), // reads and re-writes up to 4 MB of pictures
        // Built-in bots (checked by BuiltinBotFeature): answers per sender, on top of chat.send's own limit.
        ["builtin.dice"] = (10, 1),
        ["builtin.polls"] = (5, 0.2),
        ["builtin.reminders"] = (10, 1),
        ["builtin.birthdays"] = (10, 1),
        ["builtin.bots.config.set"] = (20, 2),
        ["birthday.set"] = (5, 0.5),
        ["builtin.bots.set"] = (10, 1),
        ["interaction.invoke"] = (5, 2),
        ["interaction.respond"] = (20, 5),
        ["teams.created"] = (3, 0.1), // checked by TeamsFeature: only splits that go ahead count
        ["teams.end"] = (5, 0.5),
        ["rooms.created"] = (5, 0.1), // checked by RoomFeature: only lobby joins that make a room count
        ["room.update"] = (10, 1),
        ["room.invite"] = (20, 2),
        ["room.uninvite"] = (20, 2),
        ["lfg.created"] = (3, 1 / 30.0), // checked by LfgFeature: only posts that go ahead count
        ["lfg.join"] = (10, 1),
        ["lfg.leave"] = (10, 1),
        ["landing.update"] = (10, 1),
        // Activities (ActivitiesFeature): what activities send, snapshots for late joiners, starting, joining, adding.
        ["act.send"] = (40, 20),
        ["act.snapshot"] = (5, 1),
        ["act.start"] = (5, 0.5),
        ["act.join"] = (10, 2),
        ["act.end"] = (5, 0.5),
        ["act.leave"] = (10, 2),
        ["act.add"] = (3, 0.1),
        ["act.list"] = (10, 2),
        // Every request also takes from this one. The burst covers an app connecting: it asks for its settings, lists and
        // states feature by feature (~90 startup hooks). At 40 the first actions after joining were refused.
        ["*"] = (150, 20),
    };

    private readonly Dictionary<string, Bucket> _buckets = [];

    public bool TryTake(string type)
    {
        var now = time.GetTimestamp();
        // What an activity sends has buckets of its own, so a busy activity can't use up the rest of the connection.
        if (OwnBucketOnly.Contains(type)) return Take(type, now);
        return Take("*", now) && (!Limits.ContainsKey(type) || Take(type, now));
    }

    private static readonly HashSet<string> OwnBucketOnly = ["act.send", "act.snapshot"];

    /// <summary>Takes from one named bucket only (for limits checked inside a handler, e.g. only on real changes).</summary>
    public bool TryTakeOnly(string key) => Take(key, time.GetTimestamp());

    private bool Take(string key, long now)
    {
        if (!_buckets.TryGetValue(key, out var bucket))
        {
            var (burst, perSecond) = Limits[key];
            _buckets[key] = bucket = new Bucket(burst, perSecond, now);
        }
        var elapsed = time.GetElapsedTime(bucket.Updated, now).TotalSeconds;
        bucket.Tokens = Math.Min(bucket.Capacity, bucket.Tokens + elapsed * bucket.PerSecond);
        bucket.Updated = now;
        if (bucket.Tokens < 1) return false;
        bucket.Tokens -= 1;
        return true;
    }
}
