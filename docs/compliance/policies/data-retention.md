# Data retention

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10 |
| Applies to | Data held by Iskra servers (defaults, and what the owner configures for chat.iskra.foo), the apps, and the owner's other services |

Principle: keep data only as long as it's needed for the service the person asked for, for security, or by law;
then delete it automatically. Every Iskra server owner can tighten the defaults.

## Server data (defaults in the software)

| Data | Kept | Deleted by | Configurable |
|---|---|---|---|
| Server channel messages (with reactions, pins, threads' messages) | Until deleted by the author, a moderator, account deletion, or the retention period | `RetentionSweeper` (hourly) | `server.json` → `Retention.MessagesDays` (0 = keep), Settings → Security log → Data retention (owner) |
| DM and group chat envelopes (end-to-end encrypted) | Same as messages; deleted with the account | `RetentionSweeper`; account deletion | `Retention.MessagesDays` |
| Encrypted channel envelopes, signed membership changes and channel key envelopes (end-to-end encrypted) | Envelopes: same as the message they belong to; membership changes and key envelopes: as long as the channel | `RetentionSweeper` and message deletion (envelopes go with their message); channel deletion | `Retention.MessagesDays` |
| Disappearing messages (channel messages, DM and group envelopes, encrypted channel envelopes, with their reactions, pins, threads, search entries and files) | Until their expiry: the conversation's timer when sent (5 minutes to 4 weeks), or sooner if the sender's signed envelope says so. Never in any backup | `DisappearSweeper` (every 5 s, rows overwritten on disk); apps delete their copies on their own clocks; backups leave them out | Per conversation: people who manage channels (channels), either person (DMs), any member (groups) |
| Disappearing message timers (which conversation, seconds, who set it and when) | Until changed; channel and group timers go with the channel or group | Channel or group deletion | — |
| Keys protecting DM envelopes (prekeys) | Replaced weekly, deleted 30 days later (≈5 weeks); afterwards old envelopes can't be decrypted | Client and server prekey rotation | No |
| Which messages were sent with /tts (a flag per message, no other data) | Same as the message | `RetentionSweeper` and message deletion | `Retention.MessagesDays` |
| Earlier versions of edited messages (edit history) | Up to 20 per message; go with the message | `RetentionSweeper` and message deletion | `Retention.MessagesDays` |
| Docs pages and their revisions | Pages until deleted; the last 50 revisions per page, older revisions also by the retention period | Docs edits; `RetentionSweeper` | `Retention.MessagesDays` |
| Whiteboards (objects drawn; batches of changes with their author until folded into the board's snapshot, encrypted boards as ciphertext; pictures from uploads) | Until the board is cleared or its channel deleted; batches lose their author when folded (plain boards: by the server once 500 batches or 512 KB pile up; encrypted: when a member's app uploads a snapshot); live cursors are never stored | `wb.clear`, channel deletion, compaction; account deletion with messages removes authorship | No |
| Reminders (due time; channel and message for server channels; what it's about and the note sealed) | Until 30 days after they fire, or until cancelled | `ProductivityScheduler` (hourly) | No |
| Built-in bots' answers (Dice rolls, Polls and Reminders replies: the bot, who asked, what it meant) and their reminders (set with /remind: the note readable by the server, as the command was) | Answers: same as messages; reminders: as other reminders | `RetentionSweeper` and message deletion (answers go with their message); `ProductivityScheduler` | `Retention.MessagesDays` |
| Birthdays bot: the day and month a member shared (never a year) and the year it was last announced; Starboard cards (the starred message's author, excerpt, first picture link and star count); members waiting to be welcomed until they agree to the rules; Welcome bot's private welcome (in memory, 15 minutes at most) | Birthday: until the member removes it, leaves, is removed or deletes their account; cards: as messages, and gone with the starred message; waiting welcomes: until they agree or leave | `birthday.remove`, member removal and account deletion; message deletion and `RetentionSweeper`; `BuiltinBotRuntime` | `Retention.MessagesDays` (cards) |
| Scheduled messages | Until sent (then deleted) or deleted by the author; failed ones stay until the author edits or deletes them | `ScheduledFeature` | No |
| Bot commands you used (who asked, on the bot's public answer) | With the answer message | `RetentionSweeper` and message deletion | `Retention.MessagesDays` |
| DMs from bots: your setting (allowed or not, and when you changed it) and which bots you have a conversation with (who wrote first, when it started) | Until the account is deleted | Account deletion | No |
| Bot interactions in progress, private bot answers and open bot forms | 15 minutes, in memory only (never stored; gone with a restart) | `InteractionRegistry` | No |
| Inbox items (mentions and replies) | 60 days, at most 500 per account | `ProductivityScheduler` (hourly) | No |
| Key log (account keys shown, salted name hashes, key changes; key transparency) | Entries as long as the server: append-only and hash-chained by design, so members' apps can check it. The names beside them (and their salts) until the account is deleted; then only the key and an unopenable salted hash stay. Entries logged before name hashes (until 2026-10-13) keep the name inside the hashed entry | Account deletion (names) | No |
| Uploaded files still in use | Until their message/avatar/etc. is deleted, or the retention period (files used by avatars, emoji, stickers, sounds, events and webhooks are kept) | `RetentionSweeper` | `Retention.UploadsDays` (0 = keep) |
| Server icon and banner (the pictures, without their metadata, and which admin set each one and when) | The picture until an admin changes or removes it (the old file then goes with the 24-hour sweep); who set it until that account is deleted | `ServerImageFeature`; account deletion | No |
| Emoji and stickers members bring over from their other servers (the picture, its name, who brought it, when, and the SHA-256 of the bytes, so the same picture is stored once) | Until an admin deletes them, or until newer ones push the oldest out (300 emoji, 100 stickers per server); their files then go with the 24-hour sweep | Admins (`emoji.delete`, `sticker.delete`); `emoji.import` / `sticker.import` trimming; `UploadSweeper` | No |
| Public page settings (on or off, the owner's description of the server, which parts to show, which invite) | Until the owner changes them. Server data, not personal data: no account keys are kept with them (the activity log says who changed what) | `LandingFeature` | No |
| Uploads nothing uses | 24 hours | `UploadSweeper` | No |
| Unfinished uploads in parts (part of a file, often encrypted DM ciphertext) | 10 minutes after the last part arrived, deleted with the next upload or the hourly sweep | `Uploads`, `UploadSweeper` | No |
| Audit log (moderation and admin actions) | 90 days | `ModerationSweeper` | `Retention.AuditDays` (0 = keep) |
| Security log (auth failures, rate-limit hits, joins, sign-ins from new devices, key rotations, deletions, backups, moves, exports, settings changes) | 365 days | `RetentionSweeper` | `Retention.SecurityLogDays` |
| Resolved reports | 90 days after resolution | Report sweep (`ReportFeature`) | No |
| Moderator notes about a person (text, who wrote it, when). Moderators only: never shown to the person and not in their data export (like reports about them); a note is in its author's export | Until a moderator deletes the note, or the person's account is deleted | Moderators; account deletion | No |
| People who left (account key, last name here, how they went, who removed them, when) | Kept 90 days (the audit log's horizon, `Retention.AuditDays`), name removed earlier if the account is deleted; someone who comes back is just a member again | `ModerationSweeper` (hourly); account deletion; rejoining | `Retention.AuditDays` (0 = keep) |
| Which invite a member joined with (moderators only: the invite's public id, never its code; its label, maker and role; who approved them; when). In the member's data export (`joinedVia`) and the join's audit entry | While they're a member: deleted when they leave, are kicked or banned, or delete their account (the audit entry follows the audit log's 90 days) | Database trigger on leaving; account deletion | No |
| Join requests (approval invites: the joiner's name and account key, which invite, when; a refusal's time) | Until a moderator decides: approved ones become memberships; refusals are kept a day (so the person is told no, not "need an invite") and unanswered requests 7 days | `ModerationSweeper` (hourly) | No |
| Bug reports (bug inbox, when the owner turns it on: what the reporter wrote, screenshots without their metadata, logs from the app, an optional contact email; anonymous, never the sender's IP address) | 365 days at most (sooner with a shorter `Retention.MessagesDays`); their files a day later | `RetentionSweeper`; admins can delete one earlier | No (the year); the owner turns the inbox off |
| Outgoing webhooks (name, address, events, who made it) and their delivery log (time, event, attempt, HTTP status, outcome; never the payload) | Webhooks until an admin deletes them; the last 50 log entries per webhook, deleted with it | Admins; each new log entry | No |
| Ended or cancelled events | 30 days | `EventScheduler` | No |
| Looking-for-group posts (game, slots, time, voice channel, note; who joined) and the "Notify me for LFG" setting | Posts: same as messages (they go with their message), closed 2 hours after their time or after 24 hours; who joined: with the post, or until the account is deleted; the setting: until turned off or the account is deleted | `RetentionSweeper` and message deletion; `LfgCloser` (closing); account deletion | `Retention.MessagesDays` |
| Team splits (who started one, the voice channel, the game, its temporary team channels) | Until the split ends: team channels are deleted after 5 minutes empty, or when everyone is brought back | `TeamSweeper`; `teams.end` | No |
| Join-to-create voice rooms (a temporary voice channel named after its host; the host, whether it's locked, who's invited) | About 30 seconds after the room is empty (checked every 10 s); invites go with the room | `RoomSweeper` | No |
| Watch party queue (what plays next, who added each item and when; the audio-only switch) | In memory while the party runs; queued uploads count as in use until the party ends, then the 24-hour sweep | Process memory; `UploadSweeper` | No |
| Activities added to a server (the zip's files, name, who added it and when) and activity settings | Until an admin removes the activity (they're in `iskra.db`, so backups have them); deleting an account clears who added it | `act.remove`, account deletion | No |
| Running activities (who's playing, the messages since the last snapshot, the snapshot) | In memory while the activity runs: gone when it ends (the call empties, its last player leaves, or someone ends it) | Process memory | No |
| Voice channel status (its text, who set it and when) | In memory while the call lasts: cleared when the call empties, someone clears it, or the server restarts | Process memory | No |
| Daily backups (`backups/auto-*.zip`) | Last 7 (disappearing messages and their files are never in them) | `BackupService` | `Backups.Keep` (1–30) |
| Encrypted copies of daily backups on another disk (`Backups.CopyTo`, off by default; `.iskrabackup` with the owner's copy passphrase) | Same as daily backups: the newest `Keep` there | `BackupService` | `Backups.CopyTo`, `Backups.Keep` |
| Encrypted copies of daily backups at backup buddies (friends' servers the owner paired with; encrypted with the recovery code, which only the source server and its owner have) | The newest copies that fit the space the friend gave (`keep` 1–30, default 3), plus always one older protected copy (the newest at least 48 hours old, or else the oldest); after either side stops, the friend's grace period (0–90 days, default 7; at least 1 day when the source stops), then deleted | The holder's `BuddyHolder` sweep (hourly) | Holder: Settings → Backup & move → Keep backups for a friend; source: Backup buddies |
| Backup buddies we send to (address, server key, name, quota, last copy and problem) and the recovery code | Until the owner removes the buddy; the code as long as the server (it's in its backups) | The owner (`buddy.remove`) | — |
| Spots we keep for friends' servers (label, the friend's server key, name and restore key, sizes and times of the copies) and the copies (`buddy-held/`, never in our own backups) | Until removed, plus the spot's grace period; unused pairing codes 24 hours; unfinished uploads 24 hours | `BuddyHolder` sweep (hourly) | Settings → Backup & move → Keep backups for a friend |
| Downloaded encrypted backups | Wherever the owner keeps them | The owner | — |
| Data exports (`/export/{token}`) | 10 minutes (the link; files in `world/exports`, never in backups) | Export cleanup | No |
| Presence, voice state, IP addresses of connected clients | In memory while connected (stored in the security log only if the owner turns on `Retention.SecurityLogIps`, off by default) | Process memory | No |
| Per-server avatar (the picture, without its metadata, and when it was set) | While the person is a member (goes with their nickname when they leave, and with their account) | Leaving, kick/ban, account deletion; `member.avatar` with `""` | — |
| Profiles (and the stamp of the newest profile edit, `profile_stamps`), memberships, roles, devices, push subscriptions | While the person is a member | Leaving, kick/ban, account deletion, device revocation | — |
| Alert words, follows (people and roles followed, per channel) and quiet hours (`alert_settings`): words and follows only if the member turned on "Also when Iskra is closed", the schedule (days, times, time zone) only where their push is on | Until they change or turn them off, or stop being a member | The member's app (`alerts.set`), leaving, kick/ban, account deletion | — |
| When the member's current quiet stretch began (`alert_settings.quiet_since`), for the summary push when quiet hours end; whether they want that summary (`digest` in the schedule) | Until the stretch ends (cleared then), or with the rest of the alert settings | The scheduler when quiet hours end, the member's app (`alerts.set`), leaving, kick/ban, account deletion | — |
| Captions model (`models/`; no personal data) | Until the owner deletes it | The owner | `Captions.ModelDownload` (off: not fetched or served) |
| Translation models (`models/translate/`; no personal data) | Until the owner deletes them | The owner | Server settings → Translation (off: not fetched or served) |
| Owner claim of a rented server (`owner-claim`), or a server image's claim code (`owner-claim`, `owner-claim-code.txt`) | Until the owner joins; a claim code also stops working after 24 hours and is replaced on the next start | `OwnerSetup` | — |

Account deletion (Settings → Account → Delete my account; `account.delete`) removes the profile, per-server picture,
roles, settings, devices, push subscriptions, moderators' notes about the person and server copies of DMs and group
chats on every reachable server, and optionally all messages ([site/delete-account.html](../../../site/delete-account.html)).
Audit and report entries, and the "people who left" record, keep the action with the name removed until they expire.

## chat.iskra.foo (owner's settings)

The owner records the chosen `Retention` and `Backups` values here at each yearly review:

| Setting | Value | Reason |
|---|---|---|
| `Retention.MessagesDays` | 0 (keep) | Friend server; members expect history |
| `Retention.UploadsDays` | 0 (keep) | Same |
| `Retention.AuditDays` | 90 | Moderation context |
| `Retention.SecurityLogDays` | 365 | Investigating incidents |
| `Backups.Keep` | 7 | Undo mistakes |

## Apps and websites

- Clips are recorded on the device and kept only if the person saves or shares them; Catch up summaries are worked out
  on the device and not stored.
- Streamer mode is a synced setting; the desktop app's "Turn on by itself" looks at the programs running on that
  computer for the ones the person listed and keeps nothing but the switch. "Search everywhere" keeps no index: direct
  messages and groups are searched in what the device already holds.
- Notification sound choices are a synced setting (sealed like the others); an uploaded notification sound is decoded
  and kept only on that device (as short mono audio, not the original file) until removed, and never sent anywhere.
- Apps keep keys, decrypted DMs, settings and the server list on the device until the user signs out, deletes the
  account or removes the app. Disappearing messages are deleted from the device (screen, storage, notifications) when
  their time is up, also if the app was closed then (on its next start). "Download data on this device" (Settings → Privacy & data) exports it.
- What an app keeps for a server channel (messages, its threads, drafts, read state, decrypted messages of an
  encrypted channel, docs, boards, forum markers) is dropped from the device as soon as the channel is deleted or the
  member can no longer read it, at the latest on the next connection. An encrypted channel's signed history and keys
  (no message text) stay up to 30 days in case access comes back, then go; at once if another channel takes the id.
  Servers never reuse a channel's id, so nothing of a deleted channel can show up in a later one.
- Live captions and camera background effects run on the device only: audio, video and caption text are never sent
  or stored; captions are dropped from memory seconds after they're shown. The speech model is downloaded once from
  the member's own Iskra server (which fetched it once from Hugging Face) and kept with the settings on the device
  (Cache Storage or IndexedDB) until the app or site data is removed ([voice-processing.md](../../voice-processing.md)).
- Voice message transcripts are made on the device and never sent: channel ones are kept in the app's IndexedDB (at
  most 2000, oldest dropped first) until sign-out or the app's data is removed; transcripts of end-to-end encrypted
  voice messages only in memory. Read aloud uses the device's speech engine; nothing is stored or sent.
- iskra.foo and app.iskra.foo store nothing about visitors; Cloudflare's short-lived request logs follow
  Cloudflare's retention.
- Emails to spark@iskra.foo (support, safety, security, data requests): kept as long as needed to handle them, and
  reviewed yearly; data-request emails and the response: 2 years as evidence of handling.
- Incident records: 5 years.
- Bug reports sent from the apps ("Report a bug") go to the bug inbox on chat.iskra.foo: a private channel only the
  Iskra team reads, deleted after 365 days at the latest. The optional contact email is personal data; reports aren't
  linked to an account, so it's found and deleted on request by searching the channel. The sender's IP address is used
  in memory for rate limits only. Reports saved as a file and emailed instead follow the email rule above.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
| 2026-10-11 | Encrypted channel envelopes, membership changes and key envelopes |
| 2026-10-12 | Live captions and camera effects on the device; the captions model from the member's own server |
| 2026-10-12 | Edit history, docs revisions, reminders, scheduled messages, inbox, key log, captions model folder, owner claim, clips |
| 2026-10-13 | Key log: names are logged as salted hashes and erased on account deletion |
| 2026-10-13 | Built-in bots (Dice, Polls, Reminders): their answers and /remind reminders |
| 2026-10-14 | Bug reports (bug inbox) |
| 2026-10-14 | Claim codes of server images (DigitalOcean Marketplace) |
| 2026-10-15 | Apps drop what they keep for a channel once it's deleted or unreadable; deleting a channel also removes its pending scheduled messages and its place in webhooks and AutoMod settings |
| 2026-10-15 | Looking-for-group posts and team splits |
| 2026-10-15 | Message translation on the device (texts never leave it); translation models folder on the server |
| 2026-10-15 | Whiteboards: board objects, unfolded batches and their authors, pictures on boards |
| 2026-10-17 | Public page settings (server data, no account keys); follows in alert settings; emoji and stickers brought over from other servers; join-to-create voice rooms; watch party queues; account deletion covers the per-server picture and moderators' notes; streamer mode and search everywhere stay on the device |
| 2026-10-17 | Quiet hours digest: when the current quiet stretch began, cleared when it ends |
| 2026-10-17 | Activities: bundles admins add (in `iskra.db`), running activities only in memory |
| 2026-10-17 | Built-in bots Starboard, Birthdays and Welcome: birthdays, starboard cards, waiting welcomes |
| 2026-10-17 | Voice channel status in memory only; notification sounds (synced choices, your own sound stays on the device) |
