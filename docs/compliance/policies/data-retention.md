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
| Keys protecting DM envelopes (prekeys) | Replaced weekly, deleted 30 days later (≈5 weeks); afterwards old envelopes can't be decrypted | Client and server prekey rotation | No |
| Earlier versions of edited messages (edit history) | Up to 20 per message; go with the message | `RetentionSweeper` and message deletion | `Retention.MessagesDays` |
| Docs pages and their revisions | Pages until deleted; the last 50 revisions per page, older revisions also by the retention period | Docs edits; `RetentionSweeper` | `Retention.MessagesDays` |
| Reminders (due time; channel and message for server channels; what it's about and the note sealed) | Until 30 days after they fire, or until cancelled | `ProductivityScheduler` (hourly) | No |
| Scheduled messages | Until sent (then deleted) or deleted by the author; failed ones stay until the author edits or deletes them | `ScheduledFeature` | No |
| Inbox items (mentions and replies) | 60 days, at most 500 per account | `ProductivityScheduler` (hourly) | No |
| Key log (account keys shown, salted name hashes, key changes; key transparency) | Entries as long as the server: append-only and hash-chained by design, so members' apps can check it. The names beside them (and their salts) until the account is deleted; then only the key and an unopenable salted hash stay. Entries logged before name hashes (until 2026-10-13) keep the name inside the hashed entry | Account deletion (names) | No |
| Uploaded files still in use | Until their message/avatar/etc. is deleted, or the retention period (files used by avatars, emoji, stickers, sounds, events and webhooks are kept) | `RetentionSweeper` | `Retention.UploadsDays` (0 = keep) |
| Uploads nothing uses | 24 hours | `UploadSweeper` | No |
| Unfinished uploads in parts (part of a file, often encrypted DM ciphertext) | 10 minutes after the last part arrived, deleted with the next upload or the hourly sweep | `Uploads`, `UploadSweeper` | No |
| Audit log (moderation and admin actions) | 90 days | `ModerationSweeper` | `Retention.AuditDays` (0 = keep) |
| Security log (auth failures, rate-limit hits, joins, sign-ins from new devices, key rotations, deletions, backups, moves, exports, settings changes) | 365 days | `RetentionSweeper` | `Retention.SecurityLogDays` |
| Resolved reports | 90 days after resolution | Report sweep (`ReportFeature`) | No |
| Ended or cancelled events | 30 days | `EventScheduler` | No |
| Daily backups (`backups/auto-*.zip`) | Last 7 | `BackupService` | `Backups.Keep` (1–30) |
| Downloaded encrypted backups | Wherever the owner keeps them | The owner | — |
| Data exports (`/export/{token}`) | 10 minutes (the link; files in `world/exports`, never in backups) | Export cleanup | No |
| Presence, voice state, IP addresses of connected clients | In memory while connected (stored in the security log only if the owner turns on `Retention.SecurityLogIps`, off by default) | Process memory | No |
| Profiles (and the stamp of the newest profile edit, `profile_stamps`), memberships, roles, devices, push subscriptions | While the person is a member | Leaving, kick/ban, account deletion, device revocation | — |
| Captions model (`models/`; no personal data) | Until the owner deletes it | The owner | `Captions.ModelDownload` (off: not fetched or served) |
| Owner claim of a rented server (`owner-claim`) | Until the owner joins | `OwnerSetup` | — |

Account deletion (Settings → Account → Delete my account; `account.delete`) removes the profile, roles, settings,
devices, push subscriptions and server copies of DMs and group chats on every reachable server, and optionally all
messages ([site/delete-account.html](../../../site/delete-account.html)). Audit and report entries keep the action
with the name removed until they expire.

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
- Apps keep keys, decrypted DMs, settings and the server list on the device until the user signs out, deletes the
  account or removes the app. "Download data on this device" (Settings → Privacy & data) exports it.
- Live captions and camera background effects run on the device only: audio, video and caption text are never sent
  or stored; captions are dropped from memory seconds after they're shown. The speech model is downloaded once from
  the member's own Iskra server (which fetched it once from Hugging Face) and kept with the settings on the device
  (Cache Storage or IndexedDB) until the app or site data is removed ([voice-processing.md](../../voice-processing.md)).
- iskra.foo and app.iskra.foo store nothing about visitors; Cloudflare's short-lived request logs follow
  Cloudflare's retention.
- Emails to spark@iskra.foo (support, safety, security, data requests): kept as long as needed to handle them, and
  reviewed yearly; data-request emails and the response: 2 years as evidence of handling.
- Incident records: 5 years.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
| 2026-10-11 | Encrypted channel envelopes, membership changes and key envelopes |
| 2026-10-12 | Live captions and camera effects on the device; the captions model from the member's own server |
| 2026-10-12 | Edit history, docs revisions, reminders, scheduled messages, inbox, key log, captions model folder, owner claim, clips |
| 2026-10-13 | Key log: names are logged as salted hashes and erased on account deletion |
