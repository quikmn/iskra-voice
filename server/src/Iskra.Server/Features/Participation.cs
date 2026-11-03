using System.Collections.Frozen;

namespace Iskra.Server.Features;

/// <summary>
/// What a member who is timed out (<see cref="ModerationFeature"/>), or still has to agree to required rules
/// (<see cref="RulesFeature"/>), may still do: read, look after their own account, devices, keys and settings, report,
/// leave, and talk in private (DMs and group DMs). Every other request is refused until the timeout ends or they agree,
/// including any request added later: this is an allowlist, so a new feature can't forget the gate.
/// </summary>
internal static class Participation
{
    internal static readonly FrozenSet<string> StillAllowed = new[]
    {
        "ping",
        // Reading.
        "chat.history", "chat.edits", "pin.list", "search", "thread.get", "thread.list", "forum.posts", "forum.post.get",
        "event.list", "docs.home.get", "docs.page.get", "docs.page.history", "docs.pages", "docs.search", "wb.boards", "wb.get",
        "emoji.list", "sticker.list", "sound.list", "role.list", "tags.list", "teams.list", "act.list", "disappear.list",
        "inbox.list", "rules.get", "member.timeout.status", "stage.audience", "bot.commands.available", "builtin.cards.mine",
        "gif.status", "gif.search", "gif.trending", "gif.categories", "link.preview", "translate.config",
        "translate.models.link", "captions.model.link", "echan.get", "echan.keys", "profile.page.get", "onboarding.mine",
        "keylog.entries", "keylog.head",
        // Reading what staff see (the request itself still checks the right).
        "audit.list", "security.log.list", "member.bans", "member.departed", "member.history", "member.notes.list",
        "invite.list", "invite.joins", "join.count", "join.list", "join.settings.get", "report.count", "report.list",
        "automod.get", "retention.get", "limits.get", "landing.get", "afk.get", "feeds.get", "buginbox.get",
        "builtin.bots.config.get", "suggestion.author", "outhook.list", "outhook.log", "outhook.hosts", "webhook.list",
        "backup.status", "buddy.status", "buddy.spots", "host.status", "p2p.status", "update.status", "import.status",
        "server.template.export",
        // Copies of what they can read.
        "data.export", "channel.export", "channel.export.status", "channel.export.cancel",
        // Their own account, profile, devices, keys and settings.
        "account.delete", "account.rotate", "account.rotations", "prekey.publish", "keylog.alert", "echan.keys.add", "echan.change",
        "device.describe", "device.list", "device.rename", "device.revoke", "link.create", "link.respond", "link.cancel",
        "prefs.get", "prefs.set", "notify.set", "alerts.get", "alerts.set", "lfg.notify.get", "lfg.notify.set",
        "push.focus", "push.status", "push.subscribe", "push.unsubscribe", "block.list", "block.sync",
        "presence.set", "presence.idle", "activity.set", "profile.update", "profile.page.set", "profile.page.remove",
        "member.avatar", "member.nick", "birthday.get", "birthday.set", "birthday.remove", "roles.self", "onboarding.answer",
        "reminder.list", "reminder.create", "reminder.update", "reminder.delete", "scheduled.list", "scheduled.delete",
        // Saying no, stepping back and leaving.
        "rules.accept", "report.create", "member.leave", "chat.delete", "lfg.leave", "lfg.close", "act.leave", "wb.leave",
        "watch.stop", "whisper.stop", "stage.decline", "call.decline", "call.end", "call.pending",
        "gcall.decline", "gcall.leave", "gcall.list", "gcall.key",
        "voice.state", "voice.idle", "voice.priority", "voice.record.consent", "voice.record.optout", "voice.record.stop",
        // Private conversations (DMs and group DMs), as before: their own privacy and block rules apply.
        "dm.conversations", "dm.devices", "dm.history", "dm.send", "dm.upload.begin", "dm.file.url", "dm.privacy.get",
        "dm.privacy.set", "dm.bots.get", "dm.bots.set", "dm.requests.list", "dm.requests.accept", "dm.requests.ignore",
        "group.list", "group.get", "group.history", "group.send", "group.create", "group.change",
    }.ToFrozenSet(StringComparer.Ordinal);

    /// <summary>True when a timed-out or not-yet-agreed member is refused <paramref name="type"/>.</summary>
    internal static bool Restricted(string type) => !StillAllowed.Contains(type);
}
