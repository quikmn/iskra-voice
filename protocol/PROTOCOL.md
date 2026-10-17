# Iskra wire protocol

Version 1. This is the reference that the server (`server/`), the client (`client/`) and the bot SDK (`bots/`) implement.
`vectors.json` holds fixed test vectors that both test suites check, so the two sides can't drift apart.

## Contents

- **Basics:** [Encoding](#encoding) · [Identity](#identity) · [Connection](#connection) (handshake, errors and close codes, limits, [restarts](#restarts-and-reconnecting)) · [Objects](#objects)
- **Servers and channels:** [Requests and events](#requests-and-events) · [Invite links](#invite-links) · [Server icon and banner](#server-icon-and-banner) · [Organizing a server](#organizing-a-server)
- **Messages:** [Files, replies and reactions](#files-replies-and-reactions) · [Link previews](#link-previews) · [Pins, search and threads](#pins-search-and-threads) · [Polls](#polls) · [Custom emoji](#custom-emoji) · [Stickers](#stickers) · [GIFs](#gifs) · [Saved messages, reminders, scheduled messages and the inbox](#saved-messages-reminders-scheduled-messages-and-the-inbox) · [Disappearing messages](#disappearing-messages) · [Text to speech](#text-to-speech-tts)
- **Voice:** [Voice channels](#voice) · [Soundboard](#soundboard) · [Stage channels](#stage-channels) · [Watch parties](#watch-parties) · [Voice channel chat and clips](#voice-channel-chat-and-clips) · [Hi-fi voice channels](#hi-fi-voice-channels) · [Voice bots](#voice-bots) · [AFK channel](#afk-channel) · [Whisper and priority speakers](#whisper-and-priority-speakers) · [Encrypted voice channels](#encrypted-voice-channels) · [Activities](#activities)
- **Private:** [Direct messages](#direct-messages-end-to-end-encrypted) · [Devices and device linking](#devices-and-device-linking) · [Calls](#calls-voice-and-video-in-dms-end-to-end-encrypted) · [Group DMs and group calls](#group-dms-and-group-calls-end-to-end-encrypted) · [Encrypted channels](#end-to-end-encrypted-channels) · [Friends](#friends)
- **People and integrations:** [Profiles](#profiles) · [Profile sync](#profile-sync) · [Activity status](#activity-status) · [Push notifications](#push-notifications-web-push) · [Bots and webhooks](#bots-and-webhooks) · [Bot interactions](#bot-interactions) · [Bot DMs](#bot-dms) · [Presence and voice messages](#presence-and-voice-messages) · [Quiet hours digest](#quiet-hours-digest)
- **Community:** [Forum channels](#forum-channels) · [Scheduled events](#scheduled-events) · [Voice user limits and server rules](#voice-user-limits-and-server-rules) · [Docs channels](#docs-channels) · [Teams and looking for group](#game-nights-teams-and-looking-for-group) · [Whiteboards](#whiteboards)
- **Running a server:** [Hosting](#hosting) (HTTPS, internet hosting) · [HTTP endpoints](#http-endpoints) · [Public page](#public-page) · [Live captions model](#live-captions-model) · [Translation models](#translation-models) · [Owner claim (rented servers)](#owner-claim-rented-servers) · [Server updates and health](#server-updates-and-health) · [Backups, moving and imports](#backups-moving-and-imports)

- **Running a server:** [Hosting](#hosting) (HTTPS, internet hosting) · [HTTP endpoints](#http-endpoints) · [Live captions model](#live-captions-model) · [Translation models](#translation-models) · [Owner claim (rented servers)](#owner-claim-rented-servers) · [Server updates and health](#server-updates-and-health) · [Backups, moving and imports](#backups-moving-and-imports) · [Backup buddies](#backup-buddies)
- **Safety:** [Blocking, timeouts, slowmode and the audit log](#safety-and-moderation) · [Roles and permissions](#roles-and-permissions) · [Built-in roles](#built-in-roles) · [Reliable sends](#reliable-sends) · [AutoMod](#automod) · [Security log, retention and your data](#security-log-retention-and-your-data)
- **Keys:** [Account key rotation](#account-key-rotation) · [Keys on the device](#keys-on-the-device) · [Leaving a server and signing out](#leaving-a-server-and-signing-out) · [Reports, deleting an account and handing over a server](#reports-deleting-an-account-and-handing-over-a-server) · [Passkeys and key transparency](#passkeys-and-key-transparency)

---

## Encoding

- Keys, nonces and signatures are **base64url without padding**.
- Identity keys are Ed25519 (32-byte public key, 64-byte signature).
- Timestamps are Unix **milliseconds** (integers).
- Strings are UTF-8. The server rejects names containing control characters, and anything longer than the documented limits.
- Every signed payload starts with a context string followed by a zero byte (`"iskra/<purpose>/v1" || 0x00 || ...`), so a signature made for one purpose can never be reused for another.

## Identity

| Thing | What it is |
|---|---|
| **Account key** | Ed25519 key pair. The public key *is* the user's identity (`accountKey`). |
| **Device key** | Ed25519 key pair, one per device. Only this key signs handshakes. |
| **Device certificate** | Proof that a device belongs to an account. |

```jsonc
// DeviceCert
{ "accountKey": "<b64u 32>", "deviceKey": "<b64u 32>", "created": 1760000000000, "sig": "<b64u 64>" }
```
`sig = Ed25519.sign(accountSecret, "iskra/device-cert/v1" || 0x00 || deviceKey(32) || u64be(created))`

Devices can be listed, renamed and revoked; see [Devices and device linking](#devices-and-device-linking). The account key itself can be replaced; see [Account key rotation](#account-key-rotation).

## Connection

The connection is one WebSocket per server at `wss://<host>/ws`. It uses text frames, and every frame is a JSON envelope:

```jsonc
{ "type": "chat.send", "id": "c1", "body": { ... } }   // a client request (id is client-chosen, max 32 chars)
{ "type": "result", "id": "c1", "body": { ... } }      // the reply to a request
{ "type": "error",  "id": "c1", "body": { "code": "forbidden", "message": "..." } }
{ "type": "chat.message", "seq": 41, "body": { ... } } // a server event (seq increases per connection)
```

### Handshake

1. **Server sends `hello`** as soon as the socket opens:
   ```jsonc
   { "type": "hello", "body": { "v": 1, "serverKey": "<b64u>", "nonce": "<b64u 32>", "name": "Gaming" } }
   ```
2. **Client sends `auth`** within 5 seconds:
   ```jsonc
   { "type": "auth", "body": { "cert": DeviceCert, "sig": "<b64u 64>", "profile": { "name": "Viktor" }, "invite": "<code, only when joining>" } }
   ```
   `sig = Ed25519.sign(deviceSecret, "iskra/auth/v1" || 0x00 || serverKey(32) || nonce(32))`

   Because the signature covers the server's key and a fresh nonce, it can't be replayed, either against this server or against a different one.
   `profile` may also carry `bio`, `pronouns` and `accent` ([Profiles](#profiles)) and `bot: true` ([Bots](#bot-accounts)).
   `rotations` (optional, ≤ 4 `Rotation`s) brings an account key rotation to a server that missed it ([Account key rotation](#account-key-rotation)).
3. **Server checks:**
   - the certificate signature
   - the auth signature
   - the profile name (1–32 characters, no control characters). A device that doesn't know the account's name yet (restored from the recovery key) leaves `name` out: a member keeps their name and profile (nothing else in `profile` is applied), an account that isn't a member yet is refused with `name_required` (its invite isn't used)
   - that the account isn't banned and the device isn't revoked
   - membership: accounts that aren't members yet need a valid `invite`, which also sets their role
4. **Server sends `welcome`:**
   ```jsonc
   { "type": "welcome", "body": {
       "you": Member,
       "server": { "name": "Gaming", "key": "<b64u>", "appUrl": "https://app.iskra.foo",
                   "publicUrl": "https://..." | null,   // see Internet hosting
                   "profilePages": true,                // see Profiles
                   "images": { "icon": File | null, "banner": File | null } },  // see Server icon and banner
       "channels": [Channel...],   // only the ones you can read
       "members": [Member...],
       "voice": [VoiceState...],   // non-empty voice channels you can read (see Voice)
       "voiceAvailable": true,
       "stages": [StageState...],      // stage channels you can read (see Stage channels)
       "watch": [WatchParty...],       // watch parties in channels you can read (see Watch parties)
       "rotations": [AppliedRotation...] } }  // the 200 most recent key rotations here (see Account key rotation)
   ```

Events from other sessions that happen before `welcome` is sent are queued and delivered right after it, in order.

### Errors and close codes

If a handshake check fails, the server sends `error` and closes:

| code | close | when |
|---|---|---|
| `auth_failed` | 4401 | Bad certificate, signature or name, or timeout (same message whatever the reason) |
| `invite_required` | 4401 | Valid identity, not a member, no usable invite (also: a bot invite used by a person, or a person's invite used by a bot) |
| `device_revoked` | 4401 | Valid identity, but the account revoked this device |
| `account_rotated` | 4401 | Valid identity, but this account key was rotated away. The body adds `rotations` and `handover` ([Account key rotation](#account-key-rotation)) |
| `account_disputed` | 4401 | Your rotation lost to an earlier one and is now a dispute for the admins |
| `account_deleted` | 4401 | The account was deleted. The body adds `deletion` ([Deleting an account](#deleting-an-account)) |
| `banned` | 4403 | The account is banned |

After the handshake, every request gets a `result` (body as listed, `{}` if none) or an `error` with one of these codes:

| code | when |
|---|---|
| `bad_request` | Invalid body, out-of-range value, or malformed frame |
| `forbidden` | Not allowed for your role (or your account type, e.g. bots in voice) |
| `not_found` | Doesn't exist, **or you can't see it**: channels, threads and calls you can't read are `not_found`, never `forbidden`, so their existence doesn't leak |
| `rate_limited` | Too fast or over a quota (see [Limits](#limits)), or too many open device links |
| `unknown_type` | No such request type. The session stays open. |
| `internal` | A bug on the server. The session stays open. |
| `voice_unavailable` | `voice.join`, `call.start`, `call.accept`, `stage.start`, `stage.invite`, `gcall.*`: LiveKit isn't running (or can't be reached) on this server |
| `busy` | `call.start`: the person is already in another call on this server; `gcall.start`: the group already has a call |
| `conflict` | `group.change`, `group.send`, `gcall.start`, `gcall.key`: the group changed in the meantime ([Group DMs](#group-dms-and-group-calls-end-to-end-encrypted)) |
| `rotation_conflict` | `account.rotate`: this account key was already rotated to a different key here |
| `channel_full` | `voice.join`: the voice channel is at its [user limit](#voice-user-limits) |
| `rules_required` | You haven't agreed to the [server rules](#server-rules) yet (writing, reacting, voice) |
| `automod` | [AutoMod](#automod) blocked the message (or title, name, poll); `message` says why. Nothing was stored or sent |

`message` is English, for bots, logs and as the fallback. Most messages a person can run into also carry `key` (`[a-z0-9_]`, ≤ 64 chars), a stable name for that text, and `args` (an object of strings and numbers) with the values in it: `{ "code": "bad_request", "message": "Channel names must be 1–32 characters.", "key": "channel_name", "args": { "max": 32 } }`. Apps show their own translation of `key` (with `args`) and fall back to a text for the `code`, then to `message`. A key keeps its meaning across versions (a new meaning gets a new key); messages about a malformed request carry none. AutoMod's keys are `automod_words`, `automod_mentions`, `automod_invites`, `automod_links`, `automod_flood` and `automod_duplicates`, with `args: { max, timeoutMs }` (the mention limit, and the timeout it gave, 0 if none); slowmode's is `slowmode` with `args: { seconds }`.

Close codes:

| Code | Meaning |
|---|---|
| 4400 | 10 malformed frames in a row |
| 4401 | Auth failed, timed out, invite required, or device revoked (during the handshake) |
| 4403 | Banned, kicked, no longer a member, or this device was revoked while connected (preceded by a `kicked` event) |
| 4409 | The account moved to a new key (preceded by `account.rotated`) |
| 4413 | Frame too large |
| 1001 | The server stopped and doesn't expect to be back soon (reason `{"v":1,"reason":"stop"}`); see [Restarts and reconnecting](#restarts-and-reconnecting) |
| 1012 | The server is restarting (an update, the desktop app restarting). The reason is JSON; see [Restarts and reconnecting](#restarts-and-reconnecting) |

### Limits

| Limit | Value |
|---|---|
| Frame size before auth | 4 KB |
| Frame size after auth | 64 KB (uploads and profile pages use HTTPS, not the socket) |
| Auth timeout | 5 s |
| Request `id` | ≤ 32 characters |
| Malformed JSON or envelope | `error` with `code: "bad_request"`; after 10 bad frames in a row the server closes with 4400 |

Rate limits are token buckets per connection. Every request takes from the general bucket; some types also have their own:

| Requests | Sustained | Burst |
|---|---|---|
| everything (general bucket) | 10/s | 40 |
| `chat.send`, `dm.send`, `upload.begin` | 2/s | 10 |
| `chat.react` | 5/s | 20 |
| `chat.typing` | 1 every 2 s | 3 |
| `search`, `poll.vote` | 2/s | 10 |
| `link.preview` | 1/s | 10 |
| `poll.create` | 1 every 5 s | 5 |
| `sound.play` | 1 every 2 s | 3 |
| `stage.hand` | 1 every 2 s | 5 |
| `watch.start` | 1 every 2 s | 8 |
| `watch.control` | 4/s | 10 |
| `watch.chat` | 1/s | 5 |
| `watch.clock` | 2/s | 10 |
| `link.create` | 1 every 10 s | 3 |
| `account.rotate` | 1 every 5 s | 10 |
| `voice.idle` | 1 every 2 s | 10 |

Some limits are per account, shared by all of its sessions, so opening more connections doesn't buy more:

| Limit | Value |
|---|---|
| `upload.begin` | 1/s, burst 20 |
| Upload quota (bytes uploaded, plus announced but unfinished, over any 24 hours) | `UploadQuota.MemberMbPerDay` (members and trusted, default 2048) and `UploadQuota.GuestMbPerDay` (default 200) in server.json; 0 = none. Admins and the owner have no quota |
| `call.start` | 10 a minute, and 3 a minute to the same person |
| `thread.create` | 5 a minute |
| `device.revoke` (new revocations only) | 10 an hour per session |

Over the limit: `error` with `code: "rate_limited"`; the session stays open. HTTP endpoints have their own limits ([webhooks](#webhooks), [device linking](#device-linking)).

## Objects

```jsonc
Member  { "accountKey": "<b64u>", "name": "Viktor", "role": "member", "online": true, "bot": false,
          ...profile fields (see Profiles) }
Channel { "id": 1, "name": "general", "kind": "text" | "voice" | "forum" | "stage" | "docs" | "whiteboard", "position": 0, "readRole": "member", "writeRole": "member",
          "createdAt": 1760000000000 }                                  // ms; 0 for the first #general
Message { "id": 42, "channelId": 1, "author": "<accountKey>", "text": "hi", "createdAt": 1760000000000, "editedAt": null,
          "attachments": [File], "replyTo": ..., "reactions": [...],   // Files, replies and reactions
          "pinned": false, "thread": Thread | null,                     // Pins, search and threads
          "poll": Poll | null,                                          // Polls
          "webhook": WebhookInfo | null,                                // Webhooks
          "cards": [Card] | null }                                      // Bot commands and cards
Invite  { "code": "<b64u 16>", "role": "member", "createdBy": "<accountKey>", "createdAt": 0, "expiresAt": 0 | null, "maxUses": null, "uses": 0 }
```

Roles, lowest to highest: `guest < member < trusted < admin < owner`.

**Ids are never reused.** A channel (or thread), category, docs page, event, forum tag or team split that is deleted
keeps its id forever: the next one always gets a higher id, also across restarts. Clients may key what they keep on the
device by channel id. A channel missing from `channels` is either deleted or no longer readable, and a client can't
tell which, so:

- **Missing from the list:** drop all plaintext kept for it at once (messages and their threads, decrypted messages,
  drafts, read state, docs, boards, forum markers, unsent messages). For an encrypted channel, keep only its chain,
  keys, older chains and what was seen of each message (no text) as a tombstone with the time it went missing.
- **Listed again with the same `createdAt`:** lift the tombstone and use the chain and keys again (messages are fetched
  and decrypted anew). The pinned chain still refuses a substitute.
- **Listed with a different `createdAt`** (another channel under that id): wipe the tombstone at once, and never use
  anything kept for the old channel.
- **Tombstones older than 30 days:** wipe them.

Servers before this rule may send no `createdAt`; then only a missing channel counts.

## Requests and events

| type | body | result | who |
|---|---|---|---|
| `ping` | | | anyone |
| `chat.send` | `channelId, text` (1–4000 chars, newlines allowed) | `{ message }` | channel writers |
| `chat.edit` | `id, text` | `{ message }` | the author |
| `chat.delete` | `id` | | the author, or an admin who outranks the author |
| `chat.history` | `channelId, before? \| after? \| around?, limit? (1–100, default 50)` | `{ messages (oldest first), hasMore }` | channel readers |
| `chat.typing` | `channelId` | | channel writers |
| `channel.create` | `name, kind? (text\|voice\|forum\|stage\|docs\|whiteboard), readRole?, writeRole?` | `{ channel }` | admin+ |
| `channel.update` | `id, name?, readRole?, writeRole?` | `{ channel }` | admin+ |
| `channel.delete` | `id` | | admin+ |
| `profile.update` | `name` and the fields in [Profiles](#profiles) | `{ member }` | anyone |
| `member.setRole` | `accountKey, role` | `{ member }` | admin+, target ranked below you, role below yours |
| `member.kick` | `accountKey` | | same as above |
| `member.ban` | `accountKey, reason?` | | same as above |
| `member.unban` | `accountKey` | | admin+ |
| `member.bans` | | `{ bans }` | admin+ |
| `invite.create` | `role? (default member), maxUses? (1–1000), expiresInMs? (1 min – 30 days, default 7 days), neverExpires? (true: no expiry, can't be combined with expiresInMs), approve? (joiners wait for a moderator, see [Join gating](#join-gating-and-raid-controls))` | `{ invite }` | member+ for guest/member invites; higher roles need the right to grant them; `neverExpires` admin+ (`forbidden`, key `invite_never`) |
| `invite.list` | | `{ invites }` | admins see all, others their own |
| `invite.revoke` | `code` | | the creator or admin+ |

An invite with `expiresAt: null` never expires (Discord's "Never"): it works until it's revoked or its `maxUses` run out. Only admins and owners can create one, and `invite.list` shows it like any other. Invite links carry no expiry, so the link format doesn't change. A server from before `neverExpires` ignores the field and returns a 7-day invite; clients show the `expiresAt` they got back, not the option they asked for.

Writing in a channel requires being able to read it (`writeRole` ≥ `readRole`). `chat.history` with `around` is described under [Jumping to a message](#jumping-to-a-message).

| event | body | sent to |
|---|---|---|
| `chat.message` | `{ message }` | channel readers |
| `chat.edited` | `{ message }` | channel readers |
| `chat.deleted` | `{ id, channelId }` | channel readers |
| `chat.typing` | `{ channelId, accountKey }` | channel readers except the typist |
| `channels` | `{ channels }` | a member whose visible channels changed (role change, channel created/updated/deleted) |
| `member.joined` | `{ member }` | everyone |
| `member.updated` | `{ member }` | everyone (name, role, profile or online status changed) |
| `member.removed` | `{ accountKey }` | everyone (kicked or banned) |
| `kicked` | `{ reason }` | the removed member (or revoked device), right before the socket closes with 4403 |

## Invite links

`<appUrl>/#/join/<b64u(serverUrl)>.<serverKey>.<code>`. The client connects to `serverUrl`, checks that `hello.serverKey` equals the key in the link, and only then sends `auth` with the code. Clients use `welcome.server.publicUrl` as `serverUrl` when it's set ([Internet hosting](#internet-hosting)), else the URL they connected to.

A new world has no owner. On startup the server writes a single-use owner invite link to `owner-invite.txt` in the world folder (and logs it); the file is deleted once the owner joins.

## Files, replies and reactions

| type | body | result | who |
|---|---|---|---|
| `upload.begin` | `name, size` (bytes, ≤ `MaxUploadMb`, default 100) | `{ url: "/upload/<ticket>", maxBytes, partBytes }` | anyone |
| `chat.send` | adds `attachments?: [fileId...]` (≤ 10, your own uploads; text may then be empty) and `replyTo?: messageId` (same channel) | | |
| `chat.react` | `id, emoji` (≤ 16 chars, no spaces, or a [custom emoji](#custom-emoji)), `on?` (default true) | | channel readers; ≤ 20 different emoji per message |

- Upload: `PUT <server>/upload/<ticket>` with the raw bytes (single use, 10 minutes, must not exceed the announced size) → `{ file }`.
- **Upload in parts** (big files, so an app never holds the whole file in memory): `PUT <server>/upload/<ticket>?offset=<n>` with the next part, where `n` is the number of bytes the server already has (0 for the first part). Each part is 1 byte to `partBytes` (16 MiB, given by `upload.begin` and `dm.upload.begin`); parts come one at a time and in order; the first must start within 10 minutes of `upload.begin`, each later one within 10 minutes of the previous. The answer is `{ received }` until the server has exactly the announced `size`, then `{ file }` as above. A part that doesn't start at the server's count answers `409 { received }` (an app whose connection broke mid-part asks again from there; a part that was cut off is dropped whole). A part past the announced size or over `partBytes` is `413` and ends the upload. A ticket used for a plain `PUT` can't take parts and the other way round (`403`). An unfinished upload is dropped when its ticket expires.
- Per-account rate limit and daily quota: see [Limits](#limits). Over the quota, `upload.begin` answers `rate_limited`.
- Uploads nothing refers to after 24 hours (no message attachment, avatar, emoji, sound, webhook or webhook post avatar, server icon or banner, nor a `/files/<id>` link in a profile page) are deleted by an hourly sweep.
- `File { id, name, size, type, width?, height?, url: "/files/<id>/<name>" }`. `type` comes from the file's first bytes, never the name: PNG, JPEG, GIF, WebP, MP4, WebM, Ogg, MP3 and WAV are served inline, anything else as a download. Every file response has `nosniff` and a sandboxing CSP. Identical content is stored once (`uploads/ab/<sha256>`).
- Message gains `attachments: [File]`, `replyTo: { id, author, text, hasAttachments } | { id, deleted: true } | null` and `reactions: [{ emoji, accounts: [accountKey] }]`.
- Event `chat.reactions` `{ id, channelId, reactions }` to channel readers.

## Link previews

| type | body | result | who |
|---|---|---|---|
| `link.preview` | `url` (http/https, no credentials) | `{ preview: { url, siteName, title, description } \| null }` | anyone |

The server fetches the page (so viewers' IPs aren't sent to every site): ≤ 512 KB of HTML, 6 s for the headers and 8 s in all including the body (a page that trickles is cut off), ≤ 3 redirects, cached for an hour. It only connects to public addresses: each connection's IP is checked after DNS resolution, so private ranges, loopback, link-local/cloud metadata and redirects into them are refused. IPv6 addresses that carry an IPv4 one (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, `::a.b.c.d`, `::ffff:…`) get the IPv4 rules; Teredo, local NAT64 and documentation ranges are refused. Push deliveries use the same check. No images are fetched or shown. Runs off the read loop.

## Pins, search and threads

### Pins

| type | body | result | who |
|---|---|---|---|
| `chat.pin` | `id, on?` (default true) | | trusted+ who can write in the message's channel; ≤ 50 pins per channel or thread |
| `pin.list` | `channelId` | `{ pins: [{ message, pinnedBy, pinnedAt }] }` (most recently pinned first) | channel readers |

- Message gains `pinned: boolean`. Deleting a message unpins it.
- Event `chat.pinned` `{ id, channelId, on, by, at }` to channel readers (clients show "X pinned a message"; nothing is stored as a message).

### Jumping to a message

`chat.history` also takes `around: messageId` (instead of `before`/`after`): up to `limit` messages around it (it included), oldest first, with `hasMore` (older ones exist) and `hasNewer`. `not_found` if the message isn't in that channel. Used for search results, pins, reply quotes and notifications.

### Search

| type | body | result | who |
|---|---|---|---|
| `search` | `query?` (≤ 200 chars, ≤ 10 words), `channelId?`, `author?` (accountKey), `has?: ["file" \| "link"]`, `before?`, `after?` (ms, on `createdAt`), `cursor?` (message id), `limit?` (1–50, default 25) | `{ results: [{ message, matches: [[start, length]...] }], total, totalCapped, hasMore, threads: [Thread] }` | anyone |

- Searches only channels and threads the requester can read at that moment; `channelId` (which includes its threads) must be one of them, else `not_found`.
- Each word is matched as a word prefix, case- and accent-insensitive (SQLite FTS5, `unicode61 remove_diacritics 2`); search operators in the query are treated as plain text. At least one of `query`, `author`, `has`, `before`, `after` is required.
- Results are newest first. `matches` are UTF-16 offsets into `message.text`, so clients highlight without parsing HTML. `cursor` = the last result's id for the next page. `threads` describes any threads the results come from.
- `total` counts matches up to 1000; `totalCapped: true` means there are more (show "1000+"). Searches run on a separate read-only database connection, so they never hold up writes.

### Threads

A thread is a side conversation started from a message in a text channel. It has its own id, used as the `channelId` for `chat.send`, `chat.history`, `chat.typing`, `chat.pin` and in message events, so replies, reactions, files, mentions and edits work the same way. Who can read and write a thread always follows its parent channel, including later changes. Threads aren't listed in `channels`, and `channel.update`/`channel.delete` don't apply to them. Deleting the parent channel deletes its threads.

```jsonc
Thread { "id": 9, "channelId": 1, "rootId": 42, "name": "Game night", "createdBy": "<accountKey>", "createdAt": 0, "messageCount": 3, "lastMessageAt": 0 | null }
```

| type | body | result | who |
|---|---|---|---|
| `thread.create` | `messageId, name` (1–100 chars) | `{ thread }` | writers of the message's channel; one thread per message; not inside threads; ≤ 1000 per channel; rate limited per account ([Limits](#limits)) |
| `thread.get` | `id` | `{ thread, root: Message \| null }` | readers |
| `thread.list` | `channelId, limit? (1–100)` | `{ threads }` (most recently active first) | readers |
| `thread.update` | `id, name` | `{ thread }` | whoever started it, or an admin who outranks them |
| `thread.delete` | `id` | | same as above (deletes its messages too) |

- Message gains `thread: Thread | null` (the thread started from it).
- Event `thread.updated` `{ thread }` to readers when a thread is created or renamed, or a message in it is posted or deleted.
- Event `thread.deleted` `{ id, channelId, rootId }` to readers.

## Polls

A poll is a message whose `text` is the question, plus a `poll` field. Polls aren't anonymous: results list who voted.

| type | body | result | who |
|---|---|---|---|
| `poll.create` | `channelId, question` (1–300 chars), `options` (2–10 answers, 1–55 chars each, no duplicates ignoring case), `multi?` (default false), `durationMs?` (1 min – 14 days; omitted = no end) | `{ message }` | channel writers |
| `poll.vote` | `id` (the message), `options: [index...]` (replaces your vote; `[]` removes it; one index unless `multi`) | | channel readers, while the poll is open |
| `poll.end` | `id` | | the author, or an admin who outranks the author |

- Message gains `poll: { question, options: [{ text, votes: [accountKey] }], multi, expiresAt, closedAt } | null`.
- Votes are per account (all your devices share one vote). A poll is closed once `closedAt` is set or `expiresAt` has passed; the server refuses votes after that and sets `closedAt = expiresAt` within about a second of expiry.
- Poll messages can't be edited; deleting the message deletes the poll.
- Event `poll.updated` `{ id, channelId, poll }` to channel readers after every vote and when the poll closes.

## Custom emoji

Server emoji are written in message text and reactions as `<:name:id>` (`name`: 2–32 of `a–z 0–9 _`; `id`: 12 base64url chars). Clients turn a typed `:name:` into that form before sending and render it as the image; an id the server no longer has is shown as `:name:`.

| type | body | result | who |
|---|---|---|---|
| `emoji.list` | | `{ emojis: [Emoji], external: [Emoji] }` | anyone |
| `emoji.create` | `name, fileId` (your own upload: PNG, GIF or WebP by content, ≤ 256 KB, ≤ 128×128) | `{ emoji }` | admin+ |
| `emoji.import` | `name, fileId` (the same rules; the picture of an emoji from another server, uploaded here by your app) | `{ emoji }` (`external: true`, or the emoji this server already had with the same bytes) | the `externalEmoji` [ability](#built-in-roles) (member+ by default) |
| `emoji.rename` | `id, name` | `{ emoji }` | admin+; not external ones |
| `emoji.delete` | `id` | | admin+ (external ones too) |

- `Emoji { id, name, url: "/files/<fileId>/<name>", animated, createdBy, external }`. Names are unique; up to 200 per server.
- `chat.react` also accepts `<:name:id>` for an emoji on this server (stored under its current name), external ones included.
- **Emoji from other servers:** apps show every joined server's emoji in the picker; sending one elsewhere means the app
  downloads the picture from its home server and uploads it to the destination (the normal upload path, the
  destination's upload rules), then `emoji.import` turns it into an external emoji there and the message or reaction
  uses `<:name:id>` as usual. A server never fetches anything from another server. The same bytes (SHA-256) are kept
  once: importing them again answers with the existing emoji, own or external, and names needn't be unique among
  external ones. A server keeps at most 300 external emoji (the oldest are forgotten, their messages then show
  `:name:`). External emoji are in `external`, not `emojis`, so pickers skip them while messages still render.
- Event `emoji.updated` `{ emojis, external }` to everyone after any change, imports included.

## Voice

Voice runs on a LiveKit server that `iskra-server` starts next to itself (config generated from `server.json` → `Voice`, keys in `livekit.key` in the world folder). Iskra never carries audio; it only decides who may join.

| type | body | result | who |
|---|---|---|---|
| `voice.join` | `channelId` (a `voice` or `stage` channel) | `{ url, token, room, channelId, canSpeak }` (`channelId`: the channel the token is for, which differs from the one asked for only for a [lobby](#join-to-create-voice-rooms)) | channel readers ([bots](#voice-bots) only when allowed); `canSpeak` = channel writers |
| `voice.state` | `muted, deafened` (booleans) | | anyone in voice (cosmetic flags shown to others) |

- `token` is a LiveKit JWT for exactly one room (`voice-<channelId>`) with `canPublish = canSpeak`. The client connects to `url` with it.
- LiveKit's signaling is proxied by iskra-server at `/livekit` (WebSocket and HTTP), so `url` is `ws(s)://<server>/livekit` and clients only need the server's web port plus LiveKit's media ports (UDP 7882, TCP 7881 fallback).
- **Who is in voice comes only from LiveKit's signed webhooks** (`POST /internal/livekit-webhook`, loopback only, HS256 JWT whose `sha256` claim matches the body), never from clients. Anyone LiveKit reports who isn't allowed in the room is removed from it.
- Kicks, bans, demotions and channel permission changes remove people from rooms they can no longer read.
- `welcome` carries `voice: [VoiceState...]` and `voiceAvailable`. Without LiveKit, `voice.join` fails with `voice_unavailable`.

| event | body | sent to |
|---|---|---|
| `voice.state` | `{ channelId, participants: [{ accountKey, muted, deafened }] }` | readers of that voice channel |
| `voice.available` | `{ available }` | everyone, when LiveKit comes up or goes down |

### Soundboard

| type | body | result | who |
|---|---|---|---|
| `sound.list` | | `{ sounds: [Sound] }` | anyone |
| `sound.create` | `name` (1–32 chars), `emoji?` (≤ 16 chars, no spaces), `fileId` (your own upload: MP3, Ogg or WAV by content, any length; the upload limit applies) | `{ sound }` | trusted+ |
| `sound.update` | `id, name, emoji?` | `{ sound }` | whoever added it, or admin+ |
| `sound.delete` | `id` | | whoever added it, or admin+ |
| `sound.play` | `id` | | someone in a voice channel who can speak there |

- `Sound { id, name, emoji, url, durationMs, createdBy }`. Up to 100 per server. The server measures the length from the file itself (WAV header, MP3 frames, Ogg granule positions: every page is walked, one stream, back to back to the end of the file, granules never going backwards), with 0.15 s of slack for encoder padding. Clients stop playback at `durationMs` (at most 5 s) whatever the file holds.
- `sound.play`: being in voice comes from LiveKit's webhooks only; you need the channel's write role.
- Event `sound.played` `{ channelId, accountKey, sound }` only to the people in that voice channel. Each client plays it locally, with its own soundboard volume and mute setting.
- Event `sounds.updated` `{ sounds }` to everyone after any change.

## Direct messages (end-to-end encrypted)

The server stores and relays opaque envelopes between members. It knows who talks to whom and when, never what is said.

| type | body | result | who |
|---|---|---|---|
| `dm.devices` | `accountKey` | `{ devices: [DeviceCert...], prekeys: [SignedPrekey...], revoked: [Revocation...] }` (up to 20 devices, most recently seen first; revoked devices left out) | anyone; the target must be a member (or yourself) |
| `dm.send` | `accountKey, envelope` (JSON object, ≤ 32 KB), `silent?` (bool: no [push](#push-notifications-web-push); for quiet [friend actions](#friends)) | `{ message }` | members, to members or yourself |
| `dm.history` | `accountKey, before?, limit? (1–100)` | `{ messages (oldest first), hasMore }` | only your own conversations |
| `dm.conversations` | | `{ conversations: [{ accountKey, lastId, lastAt }] }` | yourself |

Event `dm.message` `{ message: { id, from, to, envelope, createdAt } }` goes to every connected device of both people.
Device certificates are stored when a device authenticates, so the server can publish them but not forge them.

Clients send envelope v2 ([forward secrecy](#forward-secrecy-envelope-v2)); v1 envelopes are still accepted and decrypted. Not yet supported: DMs between people who share no server. Group DMs have [their own section](#group-dms-and-group-calls-end-to-end-encrypted).

### Envelope v1

Built and checked only by clients.

```jsonc
{
  "v": 1,
  "header": { "from": "<accountKey>", "to": "<accountKey>", "sentAt": 1760000000000, "id": "<b64u 12>" },
  "sender": DeviceCert,                     // the sending device, signed by header.from
  "nonce": "<b64u 24>", "ct": "<b64u>",     // XChaCha20-Poly1305 of {"text": ...}
  "keys": [{ "device": "<deviceKey>", "nonce": "<b64u 24>", "box": "<b64u>" }]
}
```

- Associated data: `JSON.stringify(["iskra/dm/v1", from, to, sentAt, id])`, so the header can't be altered or moved to another conversation.
- The 32-byte message key is wrapped per device with `crypto_box` (X25519 + XSalsa20-Poly1305) from the sender device's key to each recipient device's key. X25519 keys come from the Ed25519 device keys (`crypto_sign_ed25519_*_to_curve25519`), so the account-signed device certificates vouch for them.
- Recipients: every valid device of the recipient, plus the sender's own devices (including the sending one) so history stays readable.
- Receivers check: header from/to equal the server's routing fields; the sender certificate is valid and belongs to `header.from`; there is a slot for this device. Anything else is shown as "couldn't be read", never as text. No devices means no message; there is no plaintext fallback.
- Safety number: `crypto_generichash(60, sort(accountA, accountB))` shown as 12 groups of 5 digits. It covers account keys, so it doesn't change when devices or prekeys do.

### Forward secrecy (envelope v2)

Each device has an X25519 **prekey** (`crypto_box_keypair`), rotated every 7 days and published to every server it connects to (`prekey.publish`, see [Devices](#devices)). A replaced prekey's secret is kept for 30 days (for messages still on their way), then deleted.

```jsonc
{
  "v": 2,
  "header": { ... }, "sender": DeviceCert, "nonce": "<b64u 24>", "ct": "<b64u>",   // as in v1
  "keys": [
    { "device": "<deviceKey>", "prekey": "<b64u 32>", "seal": "<b64u>" },          // forward secret
    { "device": "<deviceKey>", "nonce": "<b64u 24>", "box": "<b64u>" }              // device without a usable prekey (as v1)
  ]
}
```

- Associated data: `JSON.stringify(["iskra/dm/v2", from, to, sentAt, id])`.
- `seal = crypto_box_seal(innerNonce(24) || crypto_box(messageKey, innerNonce, prekey, senderDeviceX25519Secret), prekey)`. The inner `crypto_box` authenticates the sending device (only it, or the recipient, could have made it, as in v1); the outer sealed box uses a fresh ephemeral key per message. Opening needs the prekey's secret, so once that is deleted the slot can't be opened again, even by someone who later steals both devices' long-term keys and has every envelope the server stored.
- Senders use the newest prekey per device whose signature checks out against that device's certificate and that is at most 60 days old; anything else falls back to a static slot. Revoked devices (verified revocations from `dm.devices`, plus the sender's own) get no slot.
- Receivers find their slot, then the prekey secret by `prekey`. Clients keep decrypted messages locally; that local copy, not the server's envelopes, is the long-term history.
- Why not a double ratchet: a conversation runs over any shared server, on several devices per person, often offline for days and with history merged from several servers. Per-device-pair ratchet state would have to survive all of that; signed prekeys give forward secrecy (within the rotation + grace window) without shared state that can break. There's no post-compromise security: a stolen device keeps reading new messages until it's revoked.

## Devices and device linking

### Devices

| type | body | result | who |
|---|---|---|---|
| `device.list` | | `{ devices: [{ deviceKey, created, name, platform, lastSeen, current }], revoked: [Revocation...] }` | yourself (your account's devices on this server, revoked ones left out) |
| `device.describe` | `name?, platform?` (1–32 chars each, no control characters) | | the connected device, about itself. `platform` always updates; `name` only if none is set yet |
| `device.rename` | `deviceKey, name` (1–32 chars) | | any device of the same account; `not_found` if this server never saw that device |
| `device.revoke` | `Revocation` | | the account itself (the signature is checked against your account key) |
| `prekey.publish` | `key, created, sig` (a `SignedPrekey` for the connected device) | | the connected device |

```jsonc
Revocation   { "deviceKey": "<b64u 32>", "revokedAt": 1760000000000, "sig": "<b64u 64>" }
SignedPrekey { "deviceKey": "<b64u 32>", "key": "<b64u 32, X25519>", "created": 1760000000000, "sig": "<b64u 64>" }
```

- Revocation: `sig = Ed25519.sign(accountSecret, "iskra/device-revoke/v1" || 0x00 || deviceKey(32) || u64be(revokedAt))`. `revokedAt` may be at most 10 minutes in the future. A revocation only ever applies to devices of the account that signed it. At most 100 per account; idempotent. A session can add at most 10 new ones per hour (`rate_limited`; handing over known ones doesn't count).
- What revocation does not do: every device holds the account secret, so whoever copied a device's storage can sign new device certificates. Revocation stops a device key, not the account key; to shut out a copied account key, [rotate it](#account-key-rotation).
- Once a server has a revocation: the device's auth fails with `device_revoked`; its open sessions get `device.revoked` and are kicked (4403); it disappears from `dm.devices` and `device.list`; its prekey and push subscription are dropped. The revocation can arrive before the device ever connects there.
- Clients keep the revocations they know (their own, and verified ones from any server) and hand missing ones to each server on connect, so a revocation reaches every server the account is on.
- Prekey: `sig = Ed25519.sign(deviceSecret, "iskra/prekey/v1" || 0x00 || key(32) || u64be(created))`, signed by the **device** key, so the account-signed certificate vouches for it. The server keeps the newest per device and refuses keys older than 60 days or more than 10 minutes in the future.

| event | body | sent to |
|---|---|---|
| `device.revoked` | `{ deviceKey }` | every session of the account (the revoked device's own sessions are then kicked) |

### Device linking

Moves an account to a new device without the recovery key. The existing device (signed in) talks to one of its servers over its WebSocket; the new device (no account yet) uses a small HTTP relay on the same server.

The **link code**: `<server url without "https://">/<base32(token(10) || secret(16))>` (Crockford base32, groups of 4), e.g. `chat.example.com/QHN8-BTHD-…`. The QR code holds `<appUrl>/#/link/<urlencoded code>`, so a phone camera opens the web app straight into linking; the part after `#` never reaches a server. The server sees the token, never the secret.

| type | body | result | who |
|---|---|---|---|
| `link.create` | | `{ token, putKey, expiresAt }` | members; ≤ 3 open links per account (`rate_limited`) |
| `link.respond` | `token, epk, mac` (32 bytes each) | | the account that created the link, after a `link.request` |
| `link.cancel` | `token` | | the account that created the link |

| HTTP (CORS open, no auth) | body | answer |
|---|---|---|
| `POST /link/<token>` | `{ epk, mac, info? }` (≤ 1 KB; `info` ≤ 64 chars, a device description) | `{ key, expiresAt }` (the read key). 404 unknown/expired, 409 already used, 413 too big |
| `GET /link/<token>?key=<read key>` | | `{ state: "waiting" }`, `{ state: "answered", epk, mac }` or `{ state: "done", payload }` (b64u, handed out once, then the link is gone). 403 wrong key, 429 after 600 polls |
| `PUT /link/<token>?key=<putKey>` | the sealed payload (≤ 1 MB) | only once answered. 403 wrong key, 409 wrong state (both checked before the body is read), 413 too big |

The relay's HTTP endpoints are rate limited per client address (2/s, burst 60; `429`).

**Message history** follows the payload in parts when the person chooses "Bring my message history":

| HTTP | body | answer |
|---|---|---|
| `PUT /link/<token>?key=<putKey>&parts=<n>` | the sealed payload, as above; `n` (0–256) history parts will follow | as above. With `n > 0` the link stays alive while parts move (2 minutes after the last one) |
| `PUT /link/<token>/part/<i>?key=<putKey>` | sealed part `i` (≤ 1 MB), strictly in order | `200`; `429` while 4 parts (or 64 MB across all links) wait to be read: try again shortly; `409` out of order |
| `GET /link/<token>/part/<i>?key=<read key>` | | the part's bytes (handed out once, in order), or `204` if it hasn't arrived within 15 s. `409` before the payload was read. After the last part the link is gone |

Part endpoints need one of the link's keys and have their own per-address limit (20/s, burst 300). A part is `nonce(24) || crypto_box(u32be(i) || u32be(n) || bytes, nonce, N.pk, E.sk)`; the payload's sealed `historyParts` says how many to expect, so the relay can't reorder, swap or drop parts unnoticed. The parts joined together are the UTF-8 JSON `{ v: 1, dms: { <peer>: [StoredDm...] }, groups: [{ serverKey, id, chain: [GroupChange...], name, nameAt, messages }] }`: every DM and group DM kept on the device (the newest messages of each conversation if it would pass ~48 MB). The new device verifies every group chain again before using it. Older apps put recent DMs in the payload's `history` field instead; new devices still accept it.

Event `link.request { token, epk, mac, info }` goes to the session that created the link. Links live 5 minutes and are kept in memory only (≤ 100 per server).

The handshake (libsodium):
1. `master = crypto_generichash(32, token || secret, key = "iskra/link/v1")`; `crypto_kdf_derive_from_key` with context `isklink1`: id 1 = new device's MAC key, 2 = existing device's MAC key, 3 = confirmation key.
2. New device: ephemeral `crypto_box_keypair` `N`; posts `epk = N.pk`, `mac = crypto_auth(N.pk, k1)`.
3. Existing device checks the MAC (a wrong one ends the link: nothing is sent), makes `E`, answers `epk = E.pk`, `mac = crypto_auth(E.pk, k2)`. The new device checks that MAC.
4. Both show `crypto_generichash(8, E.pk || N.pk, key = k3)` as 6 digits (first 4 bytes, big-endian, mod 10⁶). The new device shows them and the person types them into the existing device, which only continues if they match (a wrong number cancels the link). A new device whose `POST` gets `409` (someone else used the token first) warns the person not to confirm anything on the other device.
5. Only then: `payload = nonce(24) || crypto_box(JSON, nonce, N.pk, E.sk)`, uploaded with `PUT`.

Payload: `{ v: 1, seed, name, recoverySaved, servers: [{ url, serverKey, name }], friends, history?, profile?, rotations? }`: the 32-byte account seed (the new device makes its own device key and certificate from it), name, server list, friends, optionally recent decrypted DM history (≤ 200 messages per conversation, ≤ ~600 KB), the profile ([below](#device-linking-carries-the-profile)) and the account key rotations that led to this key (≤ 16, so the new device can bring them to servers that missed them; it keeps only ones that check out). A server without the secret can't produce a valid MAC, so it can't put its own key in the middle; the confirmation code also catches someone who saw the code racing the real device.

## Calls (voice and video in DMs, end-to-end encrypted)

A call between two members runs on a server they both belong to, through its LiveKit. The server rings, connects and hangs up; it never has the media key. Calls are one-to-one.

| type | body | result | who |
|---|---|---|---|
| `call.start` | `accountKey, callId` (16 random bytes, b64u, single use), `video?` (bool), `envelope` (DM envelope, ≤ 32 KB) | `{ call, url, token, room }` | members (not bots), to another member (not a bot: `bad_request`); `busy` if they're in another call here, `voice_unavailable` without LiveKit; rate limited per account ([Limits](#limits)) |
| `call.accept` | `callId` | `{ call, url, token, room }` | the callee, while it rings (not bots: `forbidden`) |
| `call.decline` | `callId, reason? ("declined" \| "busy")` | | the callee, while it rings |
| `call.end` | `callId` | | either person (the caller cancels a ringing call this way) |
| `call.pending` | | `{ calls: [{ call, envelope }] }` (calls ringing for you) | yourself |

`Call { id, from, to, video, state: "ringing" | "active", createdAt }`. A call someone isn't part of is `not_found` for them, admins included.

| event | body | sent to |
|---|---|---|
| `call.ring` | `{ call, envelope }` | every session of the callee (plus a [push](#push-notifications-web-push) of kind `call`) |
| `call.accepted` | `{ callId }` | the caller's sessions and the callee's other sessions (they stop ringing) |
| `call.ended` | `{ callId, reason: "ended" \| "cancelled" \| "declined" \| "busy" \| "no_answer" }` | both people's sessions |
| `call.state` | `{ callId, participants: [accountKey] }` (who is in the room, from LiveKit's webhooks) | both people's sessions |

- The LiveKit room is `call-` + the first 16 bytes (hex) of `SHA-256("iskra/call-room/v1" 0x00 accountA 0x00 accountB 0x00 callId)` (accounts sorted). Tokens for it are only issued to those two accounts; anyone else LiveKit reports in a call room (or anyone in a room that is no longer a call) is removed.
- Ringing times out after 45 s (`no_answer`). Starting a call ends any call the caller was still in. A party leaving the room ends an answered call (`ended`); the caller leaving a ringing call cancels it. Kicks, bans and LiveKit going down end calls too.
- **Media key:** the caller makes a random 32-byte key per call and sends it in `envelope`, an ordinary DM envelope (v2, see above) whose content is `{ "text": "…", "call": { "kind": "invite", "id": callId, "key": "<b64u 32>", "video": bool } }`. The server relays it in `call.ring` and doesn't store it. The callee checks that the envelope is from the caller, to them, for this `callId`, and recent. Both sides give the key to LiveKit's end-to-end encryption (`ExternalE2EEKeyProvider`, HKDF from the raw key; frames are AES-GCM encrypted in a worker), so the SFU only forwards ciphertext.
- **Call log:** when a call ends, the caller's app sends a normal DM whose content is `{ "text": "<fallback>", "call": { "kind": "log", "id", "video", "outcome": "missed" | "declined" | "ended", "duration"? (ms) } }`. Apps that don't know calls show the fallback text.

## Profiles

A profile lives on the user's device and is sent to every server they're on, so one edit updates them all. It also follows the account to its other devices, newest edit first ([Profile sync](#profile-sync)). Every `Member` gains:

```jsonc
{ "avatar": "/files/<id>/avatar.webp" | null, "avatarHash": "<sha256 hex>" | null,
  "bio": "≤ 190 chars" | null, "pronouns": "≤ 40 chars" | null, "accent": "#rrggbb" | null,
  "page": "/pages/<id>" | null, "pageHash": "<sha256 hex>" | null }
```

- `auth.profile` may also carry `bio`, `pronouns` and `accent` (same rules as below). Invalid ones are ignored, never fatal.
- The hashes let a client see whether a server's copy of its avatar or page is current, and upload only when it isn't.
- `welcome.server.profilePages` says whether this server allows pages.

| type | body | result | who |
|---|---|---|---|
| `profile.update` | any of `name`, `bio` (≤ 190, newlines allowed), `pronouns` (≤ 40), `accent` (`#rrggbb`), `avatar` (id of your own upload: PNG, JPEG, WebP or GIF, ≤ 1 MB, ≤ 4096 px, with a size the server could read). `""` clears a field. | `{ member }` | anyone |
| `profile.page.set` | `file` (id of your own upload: UTF-8 HTML, ≤ 512 KB) | `{ member }` | anyone, if pages are on (`forbidden` otherwise) |
| `profile.page.remove` | `accountKey?` (default: yourself) | | yourself, or an admin who outranks the owner |
| `profile.pages.configure` | `enabled` | | admin+ |

Text rules are the same as names: trimmed, NFC, no control or invisible formatting characters. Each change is broadcast as `member.updated`, including a name or profile fields that change with `auth` (a server that was offline at a rename, or another device) while the member is already online. Event `profile.pages { enabled }` goes to everyone when an admin switches pages on or off; while off, every member's `page` is `null` and pages answer 404 (they're kept, so switching back on restores them). Publishing gives the page a new id. Pages are stored in `iskra.db`.

Themes are client-side only (a JSON file of colours, radius, avatar shape and fonts, validated value by value); nothing about them goes over the wire.

### Profile pages: the safety model

A page is one HTML file the member wrote. Viewers only load it when they click "Open profile page". It must not be able to touch the viewer's account, the app, or the network: the viewer's device contacts nobody but the page's own server because of it.

**Scripts run only where that holds.** `GET /pages/<id>` serves the page as static HTML and CSS: `sandbox` without `allow-scripts` and `script-src 'none'`. `GET /pages/<id>?scripts=1` differs only in `sandbox allow-scripts`, `script-src 'unsafe-inline'` and the prelude below. The desktop app loads `?scripts=1` for every page, inside its walled page view (below). Browsers and the phone apps load other people's pages without scripts, and say that interactive pages run in the desktop app; an author's own page loads with scripts. There is no prompt to turn scripts on.

**Served** (unguessable id, `no-store`) with:

```
Content-Security-Policy: sandbox [allow-scripts]; default-src 'none'; script-src 'none' | 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob: <this server>/files/; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none';
  frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none';
  frame-ancestors 'self' https://app.iskra.foo app://iskra capacitor://localhost http://localhost:* http://127.0.0.1:* <AppUrl>
Permissions-Policy: camera=(), microphone=(), geolocation=(), autoplay=(), display-capture=(), fullscreen=(), payment=(), usb=(), …
X-Content-Type-Options: nosniff · Referrer-Policy: no-referrer · X-DNS-Prefetch-Control: off
Cross-Origin-Opener-Policy: same-origin · Cache-Control: no-store
```

- **Opaque origin** (`sandbox` without `allow-same-origin`): no cookies, storage or IndexedDB, and no access to the app or the server's origin. No `allow-popups`, `allow-top-navigation`, `allow-forms` or `allow-modals`.
- **No network**: no fetch, XHR, WebSocket, EventSource, beacons, workers, frames, forms or external images, fonts or media. Images may be `data:`/`blob:` or files uploaded to the same server; audio and video only `data:`/`blob:`.
- **WebRTC** isn't covered by CSP in today's browsers. With scripts on, the server inserts a small script before the page (right after its doctype) that removes `RTCPeerConnection` and friends, and keeps the page out of child frames (which would have their own copy): `contentWindow`/`contentDocument` of frame elements, `window.frames`/`length`, and `createElement` for `iframe`, `frame`, `object` and `embed`. This is defence in depth only, and can't be made watertight in a browser: `frame-src 'none'` doesn't stop `<iframe srcdoc>`, and a srcdoc frame's own inline script has a fresh `RTCPeerConnection` that reaches any STUN or TURN server (measured in `client/e2e/page-sandbox.spec.ts`). No Permissions-Policy feature or sandbox flag turns WebRTC off. That's why browsers don't run other people's page scripts.
- **No sound or devices**: autoplay, camera, microphone and the rest are denied by Permissions-Policy and by the frame's `allow` attribute.

**Shown in browsers and the phone apps** in a modal, labelled with the author's name, as `<iframe sandbox="" referrerpolicy="no-referrer">` (`sandbox="allow-scripts"` for the author's own page) inside a script-free `srcdoc` wrapper whose own policy is `frame-src <exactly this page's URL>`. Since a parent's `frame-src` governs every navigation of its child frames, the page can't navigate itself (and the viewer's IP) to another site; it can't navigate the wrapper (sandboxed navigation flag) or the app (no top navigation).

**Shown in the desktop app** as an Electron `<webview>` in the in-memory session `iskra-pages`, used for nothing else (`desktop/src/pages.ts`, rules in `pageRules.ts`). The main process checks each view as it attaches: only from the app page, only `http(s)://<host>/pages/<id>?scripts=1` or an editor preview (`data:text/html;charset=utf-8;base64,…`, ≤ 800 000 characters), and it forces the session, no preload, sandbox, context isolation, no Node, no nested webviews, no dialogs. In that session:

- `http`/`https` are handled by the app: the view's own page URL (and its server's `/files/<id>` images) are fetched through the app's session, everything else is a 404; `webRequest` also cancels every other request, WebSockets included;
- the WebRTC IP handling policy is `disable_non_proxied_udp` (no UDP at all), and the session's proxy is `http://127.0.0.1:9` with `<-loopback>` and no direct fallback, so WebRTC over TCP, preconnects and anything else Chromium sends straight to the network go nowhere. Measured: either one alone still leaks (TURN over TCP without the proxy, STUN without the policy);
- every permission is denied, pop-ups, downloads, navigations, redirects and frame navigations (other than `about:blank`/`about:srcdoc`) are refused.

**Editor preview**: in the desktop app, the draft runs in the same walled view, as a data: URL with the page policy and prelude in front. In browsers, `page-preview.html` (a static file in the app with its own no-network policy) is loaded in `<iframe sandbox="allow-scripts">` and puts the draft, received by `postMessage` from its parent only, in a second `sandbox="allow-scripts"` frame; that preview, and an author's own page, can reach the network through WebRTC (the author's own code, on the author's own device).

Known limits: a page can load images from its own server's `/files/`, so that server sees when it's viewed (it's the server the viewer is connected to anyway). Admins can remove any page of a member ranked below them, or turn pages off.

### Device linking carries the profile

The sealed link payload gains `profile: { bio?, pronouns?, accent?, avatar?: { data: b64u, type } | null, page?: { html } | null }`. The new device checks every field against the limits above and recomputes the hashes itself. If the payload would pass ~900 KB (a big page plus DM history), the page is left out; servers keep it.

## Push notifications (Web Push)

Each server sends Web Push messages to its members' devices that aren't looking at Iskra: for @mentions (including `@everyone` and `@here`), replies to your messages, DMs and incoming calls. The server keeps a VAPID key pair (P-256) in `vapid.json` in the world folder; payloads are encrypted per RFC 8291 (`aes128gcm`) and signed per RFC 8292 with [Lib.Net.Http.WebPush](https://github.com/tpeczek/Lib.Net.Http.WebPush).

| type | body | result | who |
|---|---|---|---|
| `push.status` | | `{ publicKey, endpoint }` (VAPID key, b64u 65 bytes; this device's endpoint or null) | anyone |
| `push.subscribe` | `endpoint` (≤ 1024 chars), `keys: { p256dh, auth }` (b64u, 65 and 16 bytes), `kind?` (only `"web"`) | | anyone; replaces this device's subscription |
| `push.unsubscribe` | | | anyone (this device) |
| `push.focus` | `focused` (boolean) | | anyone: is someone looking at Iskra on this device right now |

- Subscriptions belong to the authenticated **device** (the key in the handshake's certificate). An endpoint belongs to one device; an account keeps at most 10 subscriptions (the least recently refreshed go first). Revoking a device deletes its subscription.
- The endpoint is user-supplied, so it must be `https://` on the default port, without credentials, at a known push service: `fcm.googleapis.com`, `android.googleapis.com`, `push.services.mozilla.com`, `notify.windows.com`, `push.apple.com` (or a subdomain). Deliveries also only connect to public addresses (the link preview guard). The push service answering 404 or 410 deletes the subscription.
- `@everyone` (all members) and `@here` (members online now) only ping when the author is trusted or above; from anyone else the text is shown but nobody is pushed, and clients don't count it as a mention either.
- Incoming-call pushes ring at once (no merging) but at most once per caller and callee per 15 s window.
- No pushes to a device whose session reported `focused: true` (a new session starts unfocused), to the author, to people who can't read the channel, or to non-members. Per device and conversation the first push goes out at once; more within 15 s become one follow-up push with a `count`.
- Payload (JSON, after decryption): `{ v: 1, kind: "mention"|"reply"|"dm"|"call"|"event", server, serverName, title, body, tag, from, channelId?, messageId?, peer?, count, at, text? }` (`from`: the sender's display name). Mentions and replies carry a ≤ 140-character excerpt; **DMs never carry content**: "New message from X". Calls say "X is calling". Event reminders ([Scheduled events](#scheduled-events)) say "Starting soon: …" or "… is starting now". The `Topic` header is derived from `tag`, so a push service replaces undelivered pushes about the same conversation.
- `title` and `body` are English. `text: { title, body, args }` names them so the web worker can show them in the app's language (it's registered as `/push-sw.js?lang=<en|sv>`): titles `mention`, `reply`, `encrypted`, `dm`, `calling`, `groupCall`, `reminder`, `scheduledFailed`, `eventLive`, `eventSoon`; bodies `openToRead`, `groupOpenToRead`, `attachment`, `tapToAnswer`, `tapToJoin`, `reminderGeneric`, `happening` / `inMinutes` (each also with `Channel`, `Voice` or `At`); `body: null` means the body is content, shown as is. `args` holds `name`, `channel`, `title`, `minutes`, `place` as the text needs. A worker that doesn't know a name shows `title`/`body`.
- **Phone apps** don't subscribe: they show notifications while the app is open, from the WebSocket. There is no push relay, so `kind: "native"` (sent by older phone apps) is refused with `bad_request`, and subscriptions stored at the old relay (`https://push.iskra.foo/…`) are deleted on upgrade.
- Web client: one service worker registration of `/push-sw.js` per server (scope `/push/<serverKey>/`), since every server has its own VAPID key and a registration holds one subscription. A notification click focuses the app (message `{ type: "iskra.open", route }`) or opens `/#/open/<serverKey>/c/<channelId>` / `/#/open/<serverKey>/dm/<accountKey>`. The desktop app uses native notifications and doesn't subscribe.

## Bots and webhooks

### Bot accounts

A bot is an ordinary identity (account key, device certificate, signed handshake) that says so in `auth`:
`profile: { name, bot: true }`.

| type | body | result | who |
|---|---|---|---|
| `bot.invite` | `role?` (`guest`/`member`/`trusted`, default member), `expiresInMs?` (1 min – 30 days, default 7 days) | `{ invite }` (single use) | admin+ |

- A bot can only join with a bot invite, and a bot invite only works for a client that says `bot: true`. Anything else gets `invite_required` (and the invite isn't used up).
- The flag is stored by the server and can't be changed afterwards: `Member.bot` (boolean) everywhere members appear.
- Bots can't join voice unless an admin allows it ([Voice bots](#voice-bots); otherwise `voice.join` → `forbidden`), create invites, or have a role above `trusted` (`member.setRole` → `bad_request`). They have the same rate limits as everyone else.
- Bots can send and receive DMs ([Bot DMs](#bot-dms)), but can't take part in calls (`call.start`, `call.accept` → `forbidden`; calling a bot → `bad_request`): call media keys are meant for people's apps.
- Bots can't be in group DMs or group calls, schedule messages (`scheduled.create` → `forbidden`), speak or moderate on stages, take part in [encrypted channels](#end-to-end-encrypted-channels), or leave on their own (`member.leave` → `forbidden`; an admin removes them). They can hold [roles](#roles-and-permissions) with permissions like anyone else.
- Commands: a message starting with `/name args` (or `/name@BotName args` to pick one bot) is a command by convention. Bots can describe their commands so apps suggest them ([Bot commands and cards](#bot-commands-and-cards)), and take them as [interactions](#bot-interactions) instead of messages. See `docs/bots.md`.

### Webhooks

An incoming webhook is a secret URL that posts into one text channel. Requests over the WebSocket, all admin+ and only for channels the admin can read (others are `not_found`):

| type | body | result |
|---|---|---|
| `webhook.list` | `channelId?` | `{ webhooks: [Webhook] }` |
| `webhook.create` | `channelId` (a text channel), `name` (1–32), `avatar?` (file id: an image you uploaded, same rules as a profile avatar), `mentions?` (default false) | `{ webhook, secret, path }` |
| `webhook.update` | `id`, `name?`, `avatar?` (`""` removes it), `mentions?`, `channelId?` | `{ webhook }` |
| `webhook.regenerate` | `id` | `{ webhook, secret, path }`; the old URL stops working |
| `webhook.delete` | `id` | |

```jsonc
Webhook { "id": "<b64u 16>", "channelId": 1, "name": "GitHub", "avatar": File | null, "mentions": false,
          "createdBy": "<accountKey>", "createdAt": 0, "lastUsedAt": 0 | null }
```

- `secret` is 32 random bytes (base64url). It is returned only by `create` and `regenerate`; the server stores its SHA-256 and compares in constant time. `path` is `/hooks/<id>/<secret>` on the server's address.
- At most 15 webhooks per channel. Deleting the channel deletes its webhooks.

**Posting**: `POST <server>/hooks/<id>/<secret>` with a Discord-style JSON body (also `application/x-www-form-urlencoded` or `multipart/form-data` with `payload_json`, or plain `content`/`username` fields; files are ignored):

| field | rules |
|---|---|
| `content` | same rules as `chat.send` text (≤ 4000 characters, no invisible control characters). May be empty when there are embeds. |
| `username` | overrides the name for this message (cut to 32 characters, same rules as names) |
| `embeds` | ≤ 10, ≤ 6000 characters in total. Kept: `title` (256), `description` (4096), `url` (http/https), `color`, `timestamp` (ISO 8601, stored as ms), `author.name` (256) and `author.url`, `footer.text` (2048), `fields` (≤ 25: `name` 256, `value` 1024, `inline`). Images, thumbnails and icons are dropped. |
| `allowed_mentions` | `{ parse: ["users", "everyone"], users: [accountKey...] }`; can only narrow what the webhook may do |
| `avatar_url`, `tts`, `thread_id`, ... | accepted and ignored (third-party images would reveal viewers' IP addresses) |

- Zero-width spaces (U+200B, U+2060, U+FEFF), which Discord tools use as blank filler, are removed before validation.
- Mentions: unless an admin turned on `mentions` for the webhook, `<@accountKey>` becomes plain `@Name` and `@everyone`/`@here` get a zero-width joiner, so nobody is pinged.
- Body ≤ 64 KB (`413`). Rate limit per webhook: 5 at once, then one every 2 s (`429` with `Retry-After` and `{ message, retry_after, global: false }`). Wrong ids or secrets count against the caller's address (20 at once, then 1/s).
- Answers: `204` (posted), `200` with a Discord-style message for `?wait=true`, `400 { message, code }` for invalid payloads, `404` for an unknown webhook or wrong secret (indistinguishable). `GET` on the URL returns `{ type: 1, id, name, channel_id }`.
- `POST <server>/hooks/<id>/<secret>/github` accepts GitHub's own webhook format (JSON, or form with `payload`) and posts a short embed for `ping`, `push`, `issues`, `pull_request`, `issue_comment`, `release` and `star`; other actions are answered `204` without a message. Body ≤ 1 MB.

The message is a normal `chat.message` to channel readers, with `author: "webhook:<id>"` (never an account key) and:

```jsonc
"webhook": { "id": "<webhook id>", "name": "GitHub", "avatar": File | null,
             "embeds": [{ "title"?, "description"?, "url"?, "color"?, "timestamp"?, "author"?: { "name", "url"? },
                          "footer"?: { "text" }, "fields"?: [{ "name", "value", "inline" }] }] }
```

`webhook` is `null` on every other message. Nobody can edit a webhook's message; admins can delete it.

## Hosting

### HTTPS (server.json)

```jsonc
"Https": {
  "Mode": "acme",              // "off" (default) | "acme" (Let's Encrypt) | "files" (your own PEM files)
  "Domain": "chat.example.com",
  "Email": "you@example.com",  // optional, for expiry notices
  "Port": 443, "HttpPort": 80, // HttpPort answers the ACME challenge and redirects to HTTPS
  "CertFile": null, "KeyFile": null
}
```

- With HTTPS on, `PublicUrl` defaults to `https://<Domain>` and voice becomes `wss://<Domain>/livekit`.
- Certificates live in `certs/` in the world folder (`fullchain.pem`, `key.pem`, `acme-account.pem`) and renew 30 days before expiry, without a restart.
- The plain `Port` then listens on localhost only (LiveKit webhooks, local tools).
- `"LocalOnly": true` (top level of `server.json`) makes the server and its LiveKit listen on localhost only. Tests and local tools use it; nothing on the network can connect.

### Internet hosting

"Open to the internet" lets the owner make a home server reachable from anywhere with one switch. The server asks the router to forward its ports (UPnP IGD, or NAT-PMP; the default gateway is preferred: its UPnP answer, else NAT-PMP, and only then a UPnP answer from another device on the network), gets a public address (`Internet.Domain`, or `<ip-with-dashes>.sslip.io` by default), and an HTTPS certificate for it from Let's Encrypt.

| type | body | result | who |
|---|---|---|---|
| `host.status` | | `{ status: HostStatus }` | admin+ |
| `host.internet.set` | `enabled` (boolean) | `{ status: HostStatus }` | owner. Setting `true` while already on checks everything again right away. |

```jsonc
HostStatus {
  "enabled": true,
  "lanUrl": "http://192.168.1.20:47070",          // null with your own HTTPS setup
  "router": { "state": "off" | "searching" | "found" | "not_found" | "disabled", "kind": "UPnP" | "NAT-PMP" | null,
              "model": "AVM FRITZ!Box 7590" },     // make and model from the router's UPnP description (≤ 80 printable chars), or null
  "publicIp": "203.0.113.7",                       // the router's internet-side address, or null
  "cgnat": false,                                  // that address is private/shared (100.64.0.0/10 etc.): ports can't help
  "nat": "public" | "cgnat" | "private" | null,    // public; cgnat = 100.64.0.0/10 (shared by the provider); private = another
                                                   // private range (a second router in front, or the provider's NAT); null = unknown
  "lanIp": "192.168.1.20",                         // this computer on the home network (where forwarded ports point), or null
  "gateway": "192.168.1.1",                        // the router on the home network, or null
  "os": "windows" | "macos" | "linux",             // the server computer's system (for port-forwarding and firewall help)
  "tailscaleUrl": "http://100.101.102.103:47070",  // how friends reach this server over Tailscale (see below), or null
  "ports": [{ "name": "acme" | "web" | "voice-tcp" | "voice-udp", "protocol": "tcp" | "udp",
              "internal": 47070, "external": 80, "state": "open" | "failed" | "manual" | "skipped", "error": null }],
  "address": "203-0-113-7.sslip.io", "autoAddress": true,
  "https": { "state": "off" | "waiting" | "needs_port_80" | "requesting" | "valid" | "failed", "domain": "...", "expiresAt": 0, "error": null },
  "reachable": "verified" | "router" | "unknown",  // verified: Let's Encrypt reached us from the internet; router: our own probe came back through the router
  "publicUrl": "https://203-0-113-7.sslip.io",     // null until something works
  "checkedAt": 1760000000000
}
```

| event | body | sent to |
|---|---|---|
| `host.status` | `{ status }` | admins, whenever the status changes |
| `server.address` | `{ publicUrl }` | everyone, when the public address changes (invite links use it) |

- Everything in `HostStatus` is found locally (the router's own UPnP / NAT-PMP answers and this computer's interfaces); no outside service is asked. It's only sent to admins.
- `welcome.server` carries `publicUrl` (string or null).
- Ports: outside TCP 80 (Let's Encrypt's HTTP-01 check) and 443 both lead to the server's one port, which speaks plain HTTP and HTTPS (TLS is detected from the first byte). If the router refuses 443, the server's own port is used outside too. Voice maps LiveKit's RTC TCP and UDP ports straight through. Leases are 1 hour, renewed at half-life and re-checked every 5 minutes (router restarts, new IPs); mappings are removed on shutdown.
- Without a certificate (e.g. port 80 refused) `publicUrl` stays null: a plain HTTP address is never advertised or put in invites. The only exception is a `PublicUrl` the owner set by hand in server.json, which is then used as is (the panel warns when it's plain HTTP).
- With a certificate, plain HTTP from public addresses is redirected to `publicUrl` (except `/.well-known/`); LAN and localhost are served as before. Webhooks (`/hooks/…`) that would be redirected (plain HTTP to the HTTPS-only port from anywhere but loopback, or from the internet) get `403` "use https" instead: their secret has already crossed the network in the clear, and a redirect would hide that. Clients that connected over HTTPS get `wss://<that host>/livekit` from `voice.join`.
- LiveKit advertises the public IP (`node_ip`) and keeps the LAN one (`advertise_internal_ip`), restarting when it changes.
- Tailscale (the recommended "gaming VPN" behind CGNAT): `tailscaleUrl` is `http://<this computer's Tailscale address>:<Port>`, found from the local network interfaces only (an address in `100.64.0.0/10` on an interface without a default gateway, named like Tailscale's adapter: `Tailscale` on Windows, `tailscale0` on Linux, `utunN` on macOS). Never on a `LocalOnly` server or with your own HTTPS setup. Iskra never asks Tailscale's API or daemon. A `PublicUrl` on a `100.64.0.0/10` address or a `.ts.net` name counts as local for LiveKit (it advertises its interface addresses, not the home's shared address), and clients that connected over such an address get `ws://<that host>/livekit` from `voice.join`, `call.*` and group calls.
- `GET /.well-known/acme-challenge/<token>` answers Let's Encrypt; `GET /.well-known/iskra-probe/<token>` answers only the server's own random token (for the through-the-router check).

```jsonc
"Internet": {
  "Enabled": false,
  "Domain": null,           // your own domain pointing here (stable links); default <ip>.sslip.io
  "DnsSuffix": "sslip.io",
  "PortMapping": true       // false if you forward the ports by hand
}
```

## HTTP endpoints

Everything else a server answers over HTTP(S), on the same port as `/ws`:

| Endpoint | What it is |
|---|---|
| `GET /` | `{ iskra: 1, name, icon }`: identifies an Iskra server (a browser asking for `text/html` gets the [public page](#public-page) instead). Any origin may read it (`Access-Control-Allow-Origin: *`): invite landings show the name. `icon`: a stamp of the server icon (16 hex characters) or `null` ([Server icon and banner](#server-icon-and-banner)) |
| `GET /icon` | The server icon alone, for invite landings before joining; `404` without one ([Server icon and banner](#server-icon-and-banner)) |
| `GET /health` | Version, uptime and voice status for uptime monitors ([Health](#health)) |
| `GET /ws` | The WebSocket ([Connection](#connection)) |
| `PUT /upload/<ticket>` | Upload bytes for an `upload.begin` ticket ([Files](#files-replies-and-reactions)) |
| `GET /files/<id>/<name>` | Uploaded files, sniffed type, `nosniff` and a sandboxing CSP |
| `GET /dmfiles/<id>` | Encrypted DM and group files ([Encrypted DM attachments](#encrypted-dm-attachments)) |
| `GET /gifs/media` | GIF media in proxied mode ([GIFs](#gifs)) |
| `GET /pages/<id>` | Profile pages, in a sandbox ([Profile pages](#profile-pages-the-safety-model)) |
| `POST`, `GET /hooks/<id>/<secret>`, `POST .../github` | Incoming webhooks ([Webhooks](#webhooks)) |
| `POST`, `GET`, `PUT /link/<token>` | The device-linking relay ([Device linking](#device-linking)) |
| `GET /backup/<token>`, `PUT /import/<ticket>`, `GET /.well-known/iskra-moved` | Backup downloads, Discord imports and the move notice ([Backups, moving and imports](#backups-moving-and-imports)) |
| `GET /export/<token>` | Download my data, for 10 minutes ([Download my data](#download-my-data)) |
| `/livekit` | LiveKit signaling, proxied ([Voice](#voice)) |
| `POST /internal/livekit-webhook` | LiveKit's signed webhooks, loopback only |
| `GET /.well-known/acme-challenge/<token>`, `GET /.well-known/iskra-probe/<token>` | Let's Encrypt and the reachability probe ([Internet hosting](#internet-hosting)) |
| `GET /.well-known/iskra-claim` | Proof of a pending owner claim ([Owner claim](#owner-claim-rented-servers)) |
| `GET`, `HEAD /models/<dir>/<part>` | The live-captions model ([Live captions model](#live-captions-model)) |
| `GET`, `HEAD /models/translate/<dir>/<part>` | Translation models ([Translation models](#translation-models)) |

## Forum channels

A forum is a channel of kind `forum` (`channel.create` with `kind: "forum"`; listed in `channels` like any channel, same `readRole`/`writeRole`). It holds **posts** instead of a stream of messages. A post is a [thread](#threads) under the forum: its id is the thread id (use it as the `channelId` for `chat.send`, `chat.history`, `chat.typing`, `chat.pin`), its title is the thread name, and its first message is the thread's root, stored in the forum channel itself. `chat.send`, `poll.create` and `thread.create` don't work in a forum directly (`bad_request`).

```jsonc
Post { "id": 9, "channelId": 3, "rootId": 42, "title": "How do I mute?", "author": "<accountKey>", "createdAt": 0,
       "replyCount": 4, "lastMessageAt": 0 | null, "lastActivity": 0, "lastAuthor": "<accountKey>" | null,
       "tags": [tagId], "pinned": false, "closed": false, "locked": false,
       "excerpt": "first message, ≤ 300 chars" | null, "image": File | null, "attachmentCount": 0 }
Tag  { "id": 1, "name": "Bug", "emoji": "🐛" | null }
```

| type | body | result | who |
|---|---|---|---|
| `forum.posts` | `channelId, sort? ("activity" \| "newest", default activity), tag?, query? (as for search), cursor?, limit? (1–50, default 25)` | `{ posts, tags, hasMore, cursor }` | forum readers |
| `forum.post.create` | `channelId, title` (1–100), `text` (as `chat.send`; may be empty with attachments), `attachments?`, `tags?` (≤ 5 of the forum's tag ids) | `{ post, message }` | forum writers; ≤ 1000 posts per forum; shares the `thread.create` limit |
| `forum.post.get` | `id` | `{ post, root: Message \| null }` | forum readers |
| `forum.post.update` | `id, title?, tags?` | `{ post }` | title: whoever posted it, or an admin who outranks them; tags: the same, or a moderator |
| `forum.post.set` | `id, pinned?, closed?, locked?` | `{ post }` | pinned, locked: moderators; closed: moderators, or whoever posted it unless it's locked. ≤ 10 pinned posts per forum |
| `forum.tags.set` | `channelId, tags: [{ id?, name (1–20), emoji? (≤ 16, no spaces) }]` (≤ 20, names unique ignoring case) | `{ tags }` | admin+ |

- **Moderators** are the people who can [pin](#pins) there: trusted+ who can write in the forum.
- The list is pinned posts first (most recently pinned first), then by last activity (the latest reply, else when it was posted) or by when it was posted, newest first. `cursor` is opaque; pass it back for the next page. `tag` keeps posts that have it. `query` matches posts whose title contains every word (ignoring case and accents) or whose first message or a reply matches the words (full-text, as in [search](#search)).
- Closed and locked posts take replies only from moderators (`chat.send` → `forbidden`). Closing is for "this is answered"; locking is a moderator's call that the author can't undo.
- `forum.tags.set` replaces the list: entries with an `id` keep it (and stay on their posts), new names get a new id, and tags left out are removed from every post.
- Deleting a post: `thread.delete` (it also deletes the first message), or `chat.delete` on the first message (it also deletes the post). Deleting the forum deletes everything in it.
- Unread markers are kept by clients (which posts and how many replies they've seen); new posts and replies arrive as `chat.message` events, so unread and mention counts work as for threads.

| event | body | sent to |
|---|---|---|
| `forum.post.updated` | `{ post }` | forum readers, when a post is created, renamed, retagged, pinned, closed or locked, or its first message is edited (reply counts come with `thread.updated`) |
| `forum.tags` | `{ channelId, tags }` | forum readers, after `forum.tags.set` |

## Scheduled events

An event has a time, a place and people who are interested. Times are UTC milliseconds; `timeZone` is the creator's IANA zone (e.g. `Europe/Stockholm`), so clients can show the time as the creator meant it next to the viewer's own. The client converts the creator's wall-clock time to UTC; the server only checks that it knows the zone.

```jsonc
Event { "id": 5, "title": "Game night", "description": "Bring snacks" | null, "startAt": 0, "endAt": 0, "timeZone": "Europe/Stockholm",
        "location": { "kind": "voice", "channelId": 7 | null } | { "kind": "place", "text": "Viktor's place" },
        "image": File | null, "createdBy": "<accountKey>", "createdAt": 0,
        "status": "scheduled" | "live" | "ended" | "cancelled", "interested": [accountKey],
        "repeat": "none" | "daily" | "weekly" | "biweekly" | "monthly", "until": 0 | null, "seriesId": 3 | null }
```

| type | body | result | who |
|---|---|---|---|
| `event.list` | | `{ events }` (scheduled and live, soonest first) | anyone |
| `event.create` | `title` (1–100), `description?` (≤ 1000, newlines allowed), `startAt, endAt` (start from now on, ≤ 1 year ahead; end after start, ≤ 7 days later), `timeZone` (≤ 64), `location: { channelId }` (a voice or stage channel you can see) or `{ text }` (1–100), `image?` (file id: your own PNG, JPEG, WebP or GIF upload, ≤ 5 MB), `repeat?` (default `none`), `until?` (UTC ms, only with a repeat: ≥ `startAt`, ≤ 2 years from now) | `{ event }` | member+ (not guests); ≤ 100 scheduled or live events per server; 5 at once, then 1 every 2 minutes per account |
| `event.update` | `id`, `scope?` (`"series"`, the default, or `"one"`) and any of the fields above (`""` clears `description` and `image`, `until: 0` clears `until`) | `{ event }` | whoever created it, or an admin who outranks them; while scheduled or live (a live event's start can't move) |
| `event.cancel` | `id`, `scope?` (as above) | | same as above |
| `event.interest` | `id, on?` (default true) | `{ event }` | anyone who can see it, while scheduled or live; 1/s, burst 5 per connection |

- The creator is interested from the start. `interested` lists current members only.
- **Visibility:** an event in a voice channel is only visible to people who can read that channel (others get `not_found` and no events). If the channel is deleted, `channelId` becomes `null` and the event is visible to everyone.
- **Timing:** the server moves an event to `live` at `startAt` and to `ended` at `endAt` (within about a second), and forgets ended and cancelled events after 30 days. Moving the start time re-arms the reminder.
- **Reminders:** 15 minutes before the start (only for events created further ahead than that) and again when it goes live, every interested member who can see it gets `event.reminder` on their sessions and a [push](#push-notifications-web-push) of kind `event` (no `channelId`: a click opens the server).
- **Repeating events** are a series of ordinary events (occurrences) sharing `seriesId` (the first one's id). The server keeps one open occurrence per series: when it ends, the next one is created (`event.updated`, a new id, same title, description, place, image, repeat and `until`, the same wall-clock time in `timeZone` a day, a week, two weeks or a month later; occurrences the server slept through are skipped) and the creator is interested in it. Interest, reminders and edits are per occurrence unless `scope` says otherwise: `event.update` with the default `scope: "series"` changes this occurrence and so everything after it (including `repeat` and `until`; `repeat: "none"` ends the series after this one); `scope: "one"` takes this occurrence out of the series (it becomes a one-off, `repeat` and `until` can't be sent) and creates the series' next occurrence right away. `event.cancel` with `scope: "series"` ends the series; `scope: "one"` skips this occurrence and creates the next one now. Nothing is created past `until`.
- "Add to calendar" is client-side: an iCalendar (RFC 5545) file with UTC times, built from the event; a repeating event gets an `RRULE` (with `UNTIL`) and its start in `timeZone`.

| event | body | sent to |
|---|---|---|
| `event.updated` | `{ event }` | everyone who can see it: created, edited, interest changed, live, ended, cancelled |
| `event.removed` | `{ id }` | people who could see it until an edit moved it to a channel they can't read |
| `event.reminder` | `{ event, kind: "soon" \| "live" }` | interested members who can see it |

## Stage channels

A stage is a voice channel (`kind: "stage"`, LiveKit room `voice-<channelId>`) for talks, game nights and listening parties: a few speakers, many listeners. **Who may speak is enforced by LiveKit, set by the server**: `voice.join` on a stage always returns a token with `canPublish = false` (and `canSpeak: false`), whatever your role. Bringing someone up to speak makes the server call LiveKit's `RoomService/UpdateParticipant` (Twirp, signed with a 5-minute room-admin token from the world's LiveKit key) to allow publishing (audio, camera and screen share); moving them back to the audience takes it away again, which also unpublishes their tracks. If LiveKit can't be told, a grant fails with `voice_unavailable` and changes nothing; a failed revocation removes the person from the room instead (fail closed).

Roles on a stage:

- **Moderators**: admins (always, on every stage they can read), plus members an admin picks for that one stage (`stage.moderator`; up to 25 per stage; dropped when they're kicked or banned). Moderators can't act on other moderators, except admins on people ranked below them.
- **Speakers**: allowed to publish right now. At most 16. Only people LiveKit reports in the room (from its signed webhooks), never what a client says.
- **Audience**: everyone else in the room, listen-only. Those who can write in the channel (`writeRole`), and moderators, can raise a hand; others only listen.

| type | body | result | who |
|---|---|---|---|
| `stage.start` | `channelId, topic` (1–120 chars, no newlines) | `StageState` | a moderator in the room; the stage must not be live. You become its first speaker |
| `stage.update` | `channelId, topic` | | moderators, while live |
| `stage.end` | `channelId` | | moderators, while live. Everyone is removed from the room |
| `stage.hand` | `channelId, raised` (bool) | | someone in the room, while live; raising needs the channel's write role (or being a moderator) and not already speaking. Up to 100 hands. Rate limited ([Limits](#limits)) |
| `stage.invite` | `channelId, accountKey` | | moderators, while live; the person must be in the room and allowed to ask (not a bot). Moderators can bring themselves up. Lowers their hand |
| `stage.decline` | `channelId, accountKey` | | moderators: lowers that hand |
| `stage.audience` | `channelId, accountKey?` | | yourself (default, stepping down), or a moderator for someone else |
| `stage.mute` | `channelId, accountKey` | | moderators, on a speaker in the room: LiveKit mutes their microphone (they can unmute while they're still a speaker) |
| `stage.remove` | `channelId, accountKey` | | moderators, on someone else in the room: removes them from the room (they can rejoin; kick or ban to keep them out) |
| `stage.moderator` | `channelId, accountKey, on` (bool) | | admin+; when adding, the person must be a member (not a bot) who can read the stage |

`accountKey` fields are at most 64 characters. Someone not in the room is `not_found`.

```jsonc
StageState { "channelId": 7, "live": true,
             "topic": "Friday game night" | null,      // null when not live
             "startedAt": 1760000000000 | null, "startedBy": "<accountKey>" | null,
             "speakers": ["<accountKey>", ...],        // in the order they were brought up
             "hands": [{ "accountKey": "<accountKey>", "raisedAt": 1760000000000 }],   // oldest first
             "moderators": ["<accountKey>", ...] }     // picked by admins (admins aren't listed)
```

- Leaving the room drops you from the speakers and the hands, so you rejoin as a listener. When the room empties the stage ends.
- Demotions, channel permission changes and losing moderation re-check every speaker: anyone no longer allowed to speak is moved to the audience (through LiveKit, as above).
- Listener count = people in the room (`voice.state`) who aren't speakers.
- Only speakers can `sound.play` on a stage.
- Stage state is kept in memory (LiveKit restarting drops everyone anyway); picked moderators are stored.

| event | body | sent to |
|---|---|---|
| `stage.state` | `StageState` | readers of the stage, after any change |

## Presence and voice messages

### Presence and custom status

You pick a status in the app, which sends it to every server you're on (like the profile). Every `Member` gains:

```jsonc
{ "online": true,                                    // false when offline or invisible
  "status": "online" | "idle" | "dnd" | "offline",   // invisible members show as "offline"
  "customStatus": { "emoji": "🎮" | null, "text": "≤ 128 chars" | null, "expiresAt": 1760000000000 | null } | null }
```

```jsonc
Presence { "status": "online" | "idle" | "dnd" | "invisible",
           "custom": { "emoji"?, "text"?, "expiresAt"? } | null,
           "updatedAt": 1760000000000 }   // when the person chose it (the device's clock)
```

| type | body | result | who |
|---|---|---|---|
| `presence.set` | `Presence` | `{ presence }` (what the server now keeps for you) | anyone |
| `presence.idle` | `idle` (boolean): this session has had no activity for a while | | anyone |

- `auth` may carry `presence` (a `Presence`, beside `profile`), applied before anyone sees you come online, so choosing invisible never flashes you online. Invalid ones are ignored. `welcome.presence` is the `Presence` the server keeps for you (or `null`).
- **Newest wins:** the server keeps one `Presence` per account and only replaces it with one whose `updatedAt` is the same or newer, so a device that was offline can't undo a newer choice. `updatedAt` may be at most 10 minutes in the future. When it changes, `presence.self { presence }` goes to the account's other sessions; apps adopt a newer one and pass it on to their other servers.
- `emoji`: ≤ 16 characters, no spaces, not a server emoji (custom statuses travel between servers). `text`: ≤ 128 characters, one line, the same rules as names. At least one of them, or `custom` counts as `null`. `expiresAt` ≤ 31 days ahead, `null` = until cleared. Expired custom statuses aren't shown (clients also hide them when `expiresAt` passes).
- What others see: no sessions or `invisible` → `offline` (no custom status); `dnd` or a chosen `idle` as is; otherwise `idle` when every session has reported `presence.idle { idle: true }`, else `online`.
- Invisible members aren't given away elsewhere either: their `chat.typing` is accepted but not passed on, and `@here` (members online now) neither pushes them nor counts as a mention in their own app. Voice is the exception: a voice channel shows who is in it ([Voice](#voice)), invisible or not.
- **Do not disturb:** the server sends no [Web Push](#push-notifications-web-push) at all to an account whose status is `dnd`, connected or not (it's kept while offline). Apps also stay quiet: no sounds or notifications.
- Rate limits: `presence.set` 1/s (burst 10), `presence.idle` 1 every 2 s (burst 10).

### Voice messages

A voice message is a channel message with one recorded audio file and no text:

| type | body | result | who |
|---|---|---|---|
| `chat.send` | adds `voice?: { duration (ms, 1–300000), waveform (b64u, 1–128 bytes, 0–255 each) }`, with exactly one attachment and empty `text` | | channel writers |

- The file must be Ogg, WebM or MP4 (what `MediaRecorder` makes: Ogg/WebM Opus, Safari's MP4/AAC) and at most 10 MB. For Ogg the server measures the length itself (and refuses recordings over 5 minutes); WebM and MP4 recordings carry no reliable length, so theirs is only bounded. The waveform is computed by the recording app.
- `Message` gains `voice: { duration, waveform } | null`; the audio is `attachments[0]`. Voice messages can't be edited.
- In DMs, a voice message is an [encrypted DM attachment](#encrypted-dm-attachments) with `voice` set (the server never sees the length or waveform).

### Encrypted DM attachments

Pictures, videos, files and voice messages in DMs and [group DMs](#group-dms-and-group-calls-end-to-end-encrypted) are end-to-end encrypted like the text. The server stores ciphertext it can't read, under the upload quota, and hands it out only to the people in the conversation.

| type | body | result | who |
|---|---|---|---|
| `dm.upload.begin` | `accountKey` (the other person, or yourself) or `groupId` (a group you're in), `size` (ciphertext bytes, ≤ `MaxUploadMb`) | `{ url: "/upload/<ticket>", maxBytes, partBytes }` | members (not bots); counts against the [upload limits](#limits) like `upload.begin` |
| `dm.send` | adds `files?: [fileId...]` (≤ 10): your own DM uploads for this person, each sent once | | |
| `group.send` | adds `files?: [fileId...]` (≤ 10): your own DM uploads that every current member can read, each sent once | | |
| `dm.file.url` | `id` | `{ url: "/dmfiles/<id>?exp=…&sig=…", size }` (valid 10 minutes) | the accounts in the file's access list; anyone else gets `not_found` |

- The upload is `PUT <server>/upload/<ticket>` as usual, [in parts](#files-replies-and-reactions) for anything bigger than one part. DM files may be as big as the server's upload limit (`MaxUploadMb`, counted in ciphertext bytes); apps have no limit of their own. DM uploads are never sniffed (type `application/octet-stream`), never served from `/files/`, and readable only by their **access list**: the uploader and the `accountKey` given to `dm.upload.begin`, or for a group every member at the time of the upload (people added later can't fetch older files; people who left keep access to what was shared while they were in). `GET /dmfiles/<id>` needs the signed link from `dm.file.url` (HMAC-SHA-256 over `"iskra/dm-file-link/v1"`, the id and the expiry, with a key the server makes at startup) and answers the bytes as an opaque `attachment` (`nosniff`, a sandboxing CSP). Uploads no DM refers to are swept after 24 hours like other uploads.
- **Encryption** (client): a random 32-byte key per file; libsodium `crypto_secretstream_xchacha20poly1305` over 64 KiB chunks, additional data `"iskra/dm-file/v1"` on every chunk, the last one tagged `FINAL`. Ciphertext = 24-byte header ‖ chunks (each 17 bytes longer than its plaintext). `hash` = BLAKE2b-256 (`crypto_generichash(32)`) of the ciphertext.
  - The format streams both ways: an app reads the file a slice at a time, encrypts it chunk by chunk, hashes the ciphertext as it goes (`crypto_generichash_init/update/final`) and uploads it in parts; the receiver decrypts chunk by chunk as the download arrives. A chunk is authenticated on its own, so plaintext can be written out as it comes, but a file only counts as received once the `FINAL` chunk has been read, nothing follows it, the plaintext length equals `size` and the whole ciphertext matches `hash`. If any check fails, whatever was written is deleted.
  - Why 64 KiB: the per-chunk overhead is 17 bytes (0.03 %), a damaged download fails within 64 KiB of the damage, and libsodium's WebAssembly heap only ever holds one chunk. Bigger chunks wouldn't make it measurably faster. The chunk size is fixed (not in the header), so every file ever sent opens the same way; test vectors are in `protocol/vectors.json` (`dmFile`).
  - What it authenticates: the key is random per file and travels only in the signed, encrypted envelope, so only the sender (or someone they gave the key) can make chunks that decrypt; `hash` pins the exact ciphertext the envelope refers to; the secretstream state rules out reordered, dropped, repeated or extra chunks, and `FINAL` rules out a cut-off file.
- The DM content (inside the encrypted envelope) gains `files: [DmFile]`, and `text` may then be empty:
  ```jsonc
  DmFile { "server": "<serverKey holding it>", "id": "<fileId>", "key": "<b64u 32>", "hash": "<b64u 32>",
           "name": "≤ 200 chars", "type": "sender's MIME type (a hint)", "size": 12345 /* plaintext bytes */,
           "voice"?: { "duration": 1-300000, "waveform": "<b64u ≤ 128 bytes>" } }
  ```
  The message goes through the server that holds its files.
- **Receiving:** the app checks every field (a malformed list makes the message unreadable), downloads, checks the length and `hash`, decrypts every chunk (failing on any change, truncation or extra bytes), then decides how to show the file from its **decrypted bytes** with the same rules as channel uploads (PNG, JPEG, GIF, WebP, MP4, WebM, Ogg, MP3, WAV inline, from a `blob:` URL); anything else, whatever its claimed type, is only offered as a download under its cleaned name. Saving a big file streams it to disk where the platform can (the desktop app, browsers with `showSaveFilePicker`); elsewhere it is collected in memory first.
- Rate limits: `dm.upload.begin` 2/s (burst 10, plus the per-account `upload.begin` limit), `dm.file.url` 10/s (burst 40).
- What the server learns: who sent how many files to whom, when, and their sizes (padded only by the 17 bytes per chunk). Not their names, types, contents or whether one is a voice message.

## Stickers

Admins upload stickers (bigger pictures than emoji); anyone who can write in a channel sends one as a message of its own.

| type | body | result | who |
|---|---|---|---|
| `sticker.list` | | `{ stickers: [Sticker] }` | anyone |
| `sticker.create` | `name` (1–30 chars, the same rules as names), `fileId` (your own upload: PNG, GIF or WebP, ≤ 512 KB, ≤ 320×320 px) | `{ sticker }` | admin+; ≤ 60 per server |
| `sticker.import` | `name, fileId` (the same rules; a sticker from another server, uploaded here by your app) | `{ sticker }` (`external: true`, or the sticker this server already had with the same bytes) | the `externalEmoji` [ability](#built-in-roles) (member+ by default) |
| `sticker.rename` | `id, name` | `{ sticker }` | admin+; not external ones |
| `sticker.delete` | `id` | | admin+ (external ones too) |
| `chat.send` | adds `sticker?: id` (own or external); `text` must then be empty and there are no `attachments` | | channel writers |

`Sticker { id, name, url: "/files/<id>/<name>", animated, createdBy, external }`. Event `stickers.updated { stickers }` goes to everyone on any change to the server's own stickers (external ones, like [emoji from other servers](#custom-emoji), are brought over by the app and never listed: a sent one carries its `url`; a server keeps at most 100, oldest forgotten). `Message` gains `sticker: { id, name, url, animated } | null`: the name is kept as it was when sent, and `url` is `null` once the sticker is deleted. Sticker messages can't be edited.

Message links (client side, no protocol change): `<appUrl>/#/open/<serverKey>/c/<channelId>/m/<messageId>` opens the app at that message (it extends the push notification routes above). Spoiler attachments are files whose name starts with `SPOILER_`; apps show them covered until clicked. Encrypted DM attachments carry the same prefix inside their (encrypted) name.

## GIFs

The GIF picker uses [KLIPY](https://docs.klipy.com) (Google closed Tenor's API on 30 June 2026). An admin adds a KLIPY API key and picks how apps get GIFs (servers that never stored a choice use the default, through this server):

- **Through this server** (`mode: "proxy"`, the default): the server searches and proxies the files, so members' devices never contact KLIPY and KLIPY sees only the server's address; the key never leaves the server. (KLIPY's standard terms describe requests from users' devices; an owner who wants to follow them to the letter picks Direct, or asks KLIPY for approval at developers@klipy.com.)
- **Direct** (`mode: "direct"`, only when an admin picks it, labelled in the app as "KLIPY sees members' addresses"): members' apps get the key and their own `customerId` in `gif.status`, search KLIPY themselves and load GIFs from KLIPY's media hosts. **KLIPY sees their address and searches.** The key reaches every member's app, which is acceptable for a key made for one server. GIFs in messages are KLIPY addresses (`direct: true`); apps show them only after a click ("Load GIF from KLIPY"), unless the viewer turned on auto-load on their device. Apps load KLIPY images inside a sandboxed frame (`sandbox=""`, no scripts) whose own policy is `img-src https://static.klipy.com https://static1.klipy.com https://static2.klipy.com` and nothing else, after checking the address.

| type | body | result | who |
|---|---|---|---|
| `gif.status` | | `{ enabled, provider: "klipy" \| null, mode: "direct" \| "proxy", key, customerId }` (`key` and `customerId` only in direct mode, else `null`) | anyone |
| `gif.configure` | `key?` (a KLIPY API key, 8–128 of `A–Z a–z 0–9 - _`; `""` turns GIFs off), `mode?` (`direct` \| `proxy`); at least one | | admin+ |
| `gif.trending` | `page?` (1–50) | `{ gifs: [Gif], hasNext }` | anyone; proxy mode only (`unavailable` otherwise) |
| `gif.search` | `q` (1–100 chars, one line), `page?` | `{ gifs: [Gif], hasNext }` | as above |
| `gif.categories` | | `{ categories: [{ name, query, preview \| null }] }` | as above |
| `chat.send` | adds `gif?`: in proxy mode a `token` from a `Gif`; in direct mode `{ id, title, url, preview?, width, height }` as KLIPY gave it (`url`/`preview` must be `https` on KLIPY's media hosts, the default port, no credentials). Then no `text`, `attachments` or `sticker` | | channel writers |

- `Gif { id, title, width, height, url, preview, token }`. Event `gif.status` goes to every session (each with its own `customerId`) when an admin changes the key or mode. Without a key, GIF requests answer `unavailable` (also when KLIPY can't be reached or the server's budget for calls to it is used up). Rate limits: `gif.search` and `gif.trending` 1/s (burst 10), `gif.categories` 1 every 5 s (burst 5).
- **customer_id:** direct mode, a per-member pseudonym (an HMAC of the account key, never the key itself); proxy mode, one pseudonym for the whole server.
- **Proxy mode details:** the server calls `https://api.klipy.com/api/v1/<key>/gifs/{trending|search|categories}` with `content_filter=medium`, caches answers for 5 minutes, and has a shared budget of 60 calls a minute. `url`/`preview` are `/gifs/media?u=<b64u(KLIPY URL)>&s=<HMAC>`: the server only fetches links it signed (key in the world, so old messages keep working), only KLIPY's media hosts over https without credentials, through the link-preview fetcher's rules (public addresses only, checked after DNS; no redirects), and only answers GIF, WebP, PNG or JPEG up to 15 MB, streamed and never stored (`nosniff`, a sandboxing CSP, browser caching only), 20 requests a second per client address (burst 200, `429`). In direct mode `/gifs/media` answers `404`. The token is the item (id, title, the two KLIPY URLs, size) signed by the server, so a proxied message can only carry a GIF the server handed out.
- `Message` gains `gif: { provider, id, title, width, height, url, preview, direct } | null`, shown the way the server is set up when the message is fetched. GIF messages can't be edited.
- **Ads:** KLIPY only returns ad objects when ads are switched on for the key in its Partner Panel (they're optional). Keep them off; any that still arrive are left out, in both modes, as are results whose files aren't on KLIPY's media hosts.
- The app's own `img-src` can't be narrowed to KLIPY (attachments come from each server's own address); the KLIPY frame above is where that restriction lives.

## Safety and moderation

### Blocking

Each account keeps its own block list. Clients keep it on the device and hand it to every server the account is on, so the list follows the account across devices and servers; each server enforces the copy it holds. Entries are last-writer-wins per person, and unblocks are kept as entries, so an unblock made on one device also reaches the others.

```jsonc
BlockEntry { "accountKey": "<b64u 32>", "blocked": true, "at": 1760000000000 }   // at: when this device made the change
```

| type | body | result | who |
|---|---|---|---|
| `block.list` | | `{ blocks: [BlockEntry] }` (oldest change first) | yourself |
| `block.sync` | `entries: [BlockEntry]` (≤ 500) | `{ blocks: [BlockEntry] }` (the merged list) | yourself |

- Merge: per `accountKey` the entry with the larger `at` wins; on a tie a block beats an unblock. `at` may be at most 10 minutes in the future. You can't block yourself. At most 500 entries per account; the oldest unblocks are dropped first, and more than 500 blocks is `bad_request`.
- Event `blocks` `{ blocks }` goes to the account's other sessions on this server after a change.
- If either person has blocked the other, `dm.send` and `call.start` between them answer `forbidden` ("You can't message/call this person"), without saying who blocked whom. Blocking someone ends any call with them on this server. Nothing is sent to the blocked person, and the list is never shown to anyone else.
- Messages in shared channels are still delivered; clients collapse messages from people you blocked ("Blocked message — Show"). They never cause a [push](#push-notifications-web-push) between the two people (mentions, replies or "all messages"), and apps don't notify or play sounds for them.
- Groups: blocking doesn't remove anyone from a [group](#group-dms-and-group-calls-end-to-end-encrypted) or stop its messages, but group messages between the two are never pushed, and a group call started by one of them doesn't ring the other (`gcall.ring` and its push are skipped; they can still join it from the group).
- Do not disturb ([presence](#presence-and-custom-status)) silences group pushes like every other push; [notification levels](#organizing-a-server) apply to channels only, so groups behave like DMs.

### Timeouts

| type | body | result | who |
|---|---|---|---|
| `member.timeout` | `accountKey, durationMs` (60 000, 300 000, 3 600 000, 86 400 000 or 604 800 000), `reason?` (≤ 200 chars) | `{ member }` | admin+, target ranked below you (as `member.kick`) |
| `member.timeout.remove` | `accountKey` | `{ member }` | same; `not_found` if they aren't timed out |
| `member.timeout.status` | | `{ timeout: { until, reason } \| null }` | yourself |

- `Member` gains `timedOutUntil` (ms, or null). Setting a new timeout replaces the old one. The server ends timeouts when they run out (within about a second) and sends `member.updated`; enforcement always compares with the current time.
- While timed out, these requests answer `forbidden`: `chat.send`, `chat.edit`, `chat.react`, `chat.typing`, `chat.pin`, `upload.begin`, `thread.create`, `thread.update`, `poll.create`, `poll.vote`, `poll.end`, `voice.join`, `sound.play`, `call.start`, `call.accept`. Calling someone who is timed out is `forbidden` too. A new timeout takes the member out of voice and ends their calls on this server; LiveKit joins from a timed-out member are removed. Reading, DMs and profile changes keep working.

### Slowmode

`Channel` gains `slowmode` (seconds; 0 = off). `channel.create` and `channel.update` take `slowmode?`: one of 0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600.

- Each member can send one message (`chat.send` or `poll.create`) per interval in that channel; sooner is `rate_limited` ("You can send again in 12 s"). Admins and the owner are exempt. Threads have no slowmode of their own. The server keeps the send times in memory, so a restart forgets them.

### Join gating and raid controls

Three ways to slow a raid or vet newcomers, all applied in the handshake:

- **Approval invites.** `invite.create` takes `approve?` (default false); `Invite` gains `approve`. Joining through one
  spends a use as usual but makes no member: the joiner gets `error` `join_pending` ("Waiting for a moderator to let
  you in", close 4401) and their app retries the handshake now and then (every 15 s or so) until a moderator decides.
  Approved: the next handshake gets its `welcome` (the invite's role). Declined: `join_declined` (close 4403; the use
  stays spent, and after a day the request is forgotten, so a new invite is needed). Requests nobody answers are
  forgotten after 7 days. Bots never wait.
- **Paused invites.** While paused, every invite but the owner's first answers `invites_paused` (close 4401) before a
  use is spent. Admins pause and resume by hand; AutoMod's join-flood rule pauses (never resumes).
- **Newcomer slowmode.** Members younger than `newcomerHours` get at least `newcomerSlowmode` seconds between messages
  in every channel (the channel's own slowmode if longer; the usual exemptions). 0 = off.

```jsonc
JoinRequest  { "accountKey": "<b64u>", "name": "Sam", "role": "member", "requestedAt": 1760000000000,
               "invite": { "tail": "Xy9kQw", "createdBy": "<accountKey>" | null } }   // the invite's last 6 characters, never the whole code
JoinSettings { "invitesPaused": false, "pausedAt": null, "pausedBy": "<accountKey>" | "automod:" | null,
               "newcomerHours": 0, "newcomerSlowmode": 0 }
```

| type | body | result | who |
|---|---|---|---|
| `join.list` | | `{ requests: [JoinRequest] }` (oldest first) | moderators (as [reports](#reports); `forbidden`, key `mods_joins`) |
| `join.count` | | `{ pending }` (0 for everyone else) | anyone |
| `join.approve` | `accountKey` | `{ member }` | moderators; `not_found` unless they're waiting; `bad_request` (key `join_banned`) if banned meanwhile |
| `join.decline` | `accountKey` | | moderators |
| `join.settings.get` | | `{ settings: JoinSettings }` | admin+ (`forbidden`, key `admins_joins`) |
| `join.settings.update` | any of `invitesPaused`, `newcomerHours` (0–720), `newcomerSlowmode` (a slowmode step) | `{ settings }` | admin+. Rate limited (10, then 1 a second) |

- Events: `join.count { pending }` to online moderators whenever the queue changes; `invites.paused { paused }` to
  everyone when invites stop or start working (`welcome.server.invitesPaused` says how it stands); `join.settings
  { settings }` to online admins after a change. Approving sends `member.joined` to everyone like any join.
- [AutoMod](#automod) gains the rule `joins` `{ enabled, count (2–100), minutes (1–60) }`: more than `count` invite
  joins (not bots, not approvals) within `minutes` pauses invites and, with an alert channel, posts an alert with
  `rule: "joins"`, `what: "join"`, `joins` and `minutes` (no member). Its audit entry `invites.pause` is by AutoMod
  with reason "join flood".
- Audit: `join.approve` (target: the newcomer) `{ role }`, `join.decline` `{ accountKey, name }`, `invites.pause`,
  `invites.resume`, `join.newcomers` `{ hours, slowmode }`; `invite.create` details gain `approve`. Security log:
  `join.pending`, `join.approved`, `join.declined`, `invites.paused`, `invites.resumed`. The joiner's address is never
  shown to moderators (it reaches the security log only under the owner's IP setting, like every event).

### Mod pack

Moderators (the [reports](#reports) power) get a few more tools. Everything about a person works on members ranked
below the moderator, and notes, history and bans also on people who left.

```jsonc
ModNote   { "id": 3, "text": "Warned twice about spoilers", "author": "<accountKey>", "authorName": "Mira", "createdAt": 1760000000000 }
Departed  { "accountKey": "<b64u>", "name": "Troll", "reason": "left" | "kicked" | "banned" | "deleted", "at": 1760000000000,
            "by": "<accountKey>" | null, "byName": "Mira" | null, "banned": false }   // name is "" after an account deletion
```

| type | body | result | who |
|---|---|---|---|
| `chat.delete.bulk` | `channelId`, `ids` (1–100 message ids in that channel) | `{ deleted }` | `manageMessages`; every message must be yours or from someone below you (`forbidden`, key `bulk_delete_rank`); ids already gone are skipped. Rate limited (5, then 1 every 5 s) |
| `member.ban` | gains `deleteMessagesMs?` (86 400 000 or 604 800 000: also delete what they wrote in that time, everywhere) and works on someone who left (`accountKey` of a `Departed`) | `{ deletedMessages }` | `banMembers`; a member must rank below you |
| `member.warn` | `accountKey`, `reason` (1–200) | | moderators, target below you. Rate limited (10, then 1 every 2 s) |
| `member.notes.list` | `accountKey` | `{ notes: [ModNote] }` (newest first) | moderators |
| `member.notes.add` | `accountKey`, `text` (1–1000, newlines allowed) | `{ note }` | moderators (a member must rank below you); ≤ 50 notes per person. Rate limited (10, then 1 every 2 s) |
| `member.notes.delete` | `id` | | the note's author, or an admin |
| `member.history` | `accountKey`, `limit?` (1–100, default 50) | `{ entries: [AuditEntry] }` (newest first) | moderators |
| `member.departed` | `limit?` (1–100, default 50) | `{ people: [Departed] }` (newest first; people who came back are left out) | moderators |

- `member.history` is the audit log filtered to the person as the target, for these actions only: `member.warn`,
  `member.timeout`, `member.timeout.remove`, `member.kick`, `member.ban`, `member.unban`, `message.delete`,
  `automod.block`, `report.resolve`, `join.approve`. It needs no `viewAuditLog`.
- A warning sends `member.warned { reason, by, byName, at }` to the person's sessions; apps show it. Notes are never
  sent to the person they're about, nor in their data export (notes you wrote are in yours, under
  `moderatorNotesWritten`, with the author's name blanked once they delete their account); they're deleted with the
  person's account. Departures: `departure` in the export; kept 90 days (`Retention.AuditDays`, the audit log's
  horizon; `ModerationSweeper`), the name removed earlier if the account is deleted.
- End-to-end encrypted channels: deleting there removes the stored envelopes only (apps say so before a bulk delete);
  copies already on other devices stay, as with any encrypted message.
- Audit: `message.delete.bulk` `{ channelId, channelName, count, authors }` (one entry for the lot), `member.warn`
  (reason), `member.note.add` / `member.note.delete` `{ noteId, name }` (never the text), `member.ban` details gain
  `{ name, deletedMessages?, deleteMessagesMs? }`.

### Audit log

| type | body | result | who |
|---|---|---|---|
| `audit.list` | `action?` (≤ 40 chars), `person?` (accountKey: actor or target), `before?` (entry id), `limit?` (1–100, default 50) | `{ entries: [AuditEntry], hasMore }` (newest first) | admin+ |

```jsonc
AuditEntry { "id": 7, "at": 1760000000000, "action": "member.timeout", "actor": "<accountKey>", "actorName": "Viktor",
             "target": "<accountKey>" | null, "targetName": "Sam" | null, "reason": "spam" | null, "details": { ... } | null }
```

- Names are recorded with the entry, so it stays readable after people leave. Entries older than 90 days are deleted.
- Actions and their `details`: `member.kick`, `member.ban`, `member.unban`, `member.role` `{ from, to }`, `member.timeout` `{ durationMs, until }`, `member.timeout.remove`, `channel.create` `{ channelId, name, kind, readRole, writeRole, slowmode }`, `channel.update` `{ channelId, name, changes: { name?, readRole?, writeRole?, slowmode?: { from, to } } }`, `channel.delete` `{ channelId, name, kind }`, `message.delete` (by someone other than the author; the target is the author) `{ channelId, channelName, messageId, author }`, `thread.delete` (by someone other than its creator), `message.pin` / `message.unpin` `{ channelId, channelName, messageId }`, `webhook.create` / `webhook.update` / `webhook.regenerate` / `webhook.delete` `{ id, name, channelId }`, `bot.invite` `{ role, expiresAt, readAll }`, `bot.scope` (target: the bot) `{ readAll }`, `emoji.create` / `emoji.rename` / `emoji.delete`, `sound.create` / `sound.update` / `sound.delete`, `invite.create` `{ role, maxUses, expiresAt }`, `invite.revoke` `{ role, uses }`, `profile.page.remove` (someone else's), `server.pages` `{ enabled }`, `server.internet` `{ enabled }`. Invite codes and message text are never recorded.

## Roles and permissions

Custom roles sit on top of the levels (`guest < member < trusted < admin < owner`), which keep working as before: every member still has exactly one level, channels still have `readRole`/`writeRole` levels, and existing worlds need no data changes (the `roles-1` migration only adds tables). Admins and the owner have every permission below.

```jsonc
Role { "id": 3, "name": "Moderator", "color": "#3ba55c" | null, "icon": "🛡️" | null, "hoist": true, "position": 2,
       "permissions": ["manageMessages", "kickMembers", ...] }
```

- `position`: 1 is the lowest; higher is higher. New roles start at the bottom.
- `hoist`: shown as its own group in the member list. Name colour: the highest role with a colour. Both are client-side choices.
- `Member` gains `roles: [roleId]` (highest first); members can hold several. `Channel` gains `overrides: [{ roleId, allow: [ChannelPerm], deny: [ChannelPerm] }]`.

**Permissions** (`permissions`): `manageMessages` (delete others' messages, pin, end polls, manage threads), `timeoutMembers`, `kickMembers`, `banMembers` (also unban and the ban list), `manageChannels` (create, edit, delete channels they can see, slowmode, overrides), `manageRoles`, `viewAuditLog`, `manageExpressions` (emoji and sounds), `manageWebhooks`, `mentionEveryone` (`@everyone`/`@here` ping; trusted+ still can), `moveMembers`, `muteMembers`, `manageAutoMod` ([AutoMod](#automod) settings), `prioritySpeaker` ([priority speaker](#whisper-and-priority-speakers)), `sendTts` ([/tts messages](#text-to-speech-tts)). Clients offer a "Moderator" preset with all of them. Setting levels (`member.setRole`), bot invites, profile pages and internet hosting stay admin-only. People who manage messages or channels skip slowmode.

**Hierarchy**: the owner, then admins, then members with custom roles by their highest role's position, then trusted, member, guest. Kicking, banning, timing out, deleting someone's message, managing someone's roles, muting and moving work only on people strictly below you. Members holding the same highest role are equal.

| type | body | result | who |
|---|---|---|---|
| `role.list` | | `{ roles: [Role], baseRoles: [BaseRole] }` (highest first; [built-in roles](#built-in-roles)) | anyone |
| `role.create` | `name` (1–32), `color?` (`#rrggbb`), `icon?` (one emoji, ≤ 16 chars), `hoist?`, `permissions?`, `selfAssign?` | `{ role }` | `manageRoles`; ≤ 100 roles |
| `role.update` | `id` and any of the above (`""` clears `color`/`icon`) | `{ role }` | `manageRoles`, the role below your highest |
| `role.delete` | `id` | | same (takes it off everyone and removes its overrides) |
| `role.reorder` | `ids` (every role once, highest first) | `{ roles }` | `manageRoles`; roles at or above your highest can't move, and nothing can move up to them |
| `member.roles.set` | `accountKey, roles: [roleId]` (replaces the list) | `{ member }` | `manageRoles`; yourself or someone below you; every role added or removed must be below your highest |
| `channel.overrides.set` | `id` (a channel you can see), `roleId`, `allow?`, `deny?` (both empty removes it) | `{ channel }` | `manageChannels`, the role below your highest |
| `voice.mute` | `accountKey, muted` | | `muteMembers`, someone below you (or yourself) who is in a voice channel you can see |
| `voice.move` | `accountKey, channelId` (a voice channel you can see and they can join) | | `moveMembers`, same |

- Only permissions you have yourself can be added to a role (admins: any). A permission the role already had can stay.
- Event `roles` `{ roles, baseRoles }` to everyone after any role change (custom or [built-in](#built-in-roles)). Membership and override changes send `member.updated`, a fresh `channels` list to everyone, and take people out of voice rooms they can no longer join.

**Channel overrides** (`ChannelPerm`: `view`, `send`, `connect`, `speak`). The levels give the base: `readRole` grants view and connect, `writeRole` send and speak. Then, over all of the member's roles, denies are removed and allows added (an allow from any role wins over a deny). Without `view` nothing else applies, and `speak` needs `connect`. Threads follow their channel. This decides everything about a channel: the channel list, history, events and broadcasts, search, pushes, voice tokens (`canSpeak`, `voice.join` → `forbidden` without connect) and the LiveKit webhook check.

**Voice moderation**: a server mute tells LiveKit to stop the person's publishing (`UpdateParticipant`), shows `serverMuted: true` in `voice.state`, and lasts until unmuted (also across rejoins; a server restart forgets it). A move sends `voice.moved { channelId }` to the person's sessions, whose app joins that channel, and removes them from the old room.

**Audit log** gains `role.create`, `role.update` (`{ added, removed }` permissions), `role.delete`, `role.reorder`, `member.roles` (`{ added, removed }` role names), `channel.overrides`, `voice.mute`, `voice.unmute`, `voice.move`. Reading it needs `viewAuditLog`.

**Role mentions**: `<@&roleId>` in message text, shown as `@Role`. `Role` gains `mentionable` (default false; set with `role.create`/`role.update`). A role mention notifies (push, and clients count it as a mention) the role's members when the role is mentionable or the author may mention everyone (trusted+ or `mentionEveryone`); otherwise it's just text. Webhook posts never ping roles. Clients autocomplete only roles the author may mention.

**Pushes and blocks**: the server sends no mention or reply push from someone the recipient has blocked. Clients also leave messages from blocked people out of unread and mention counts and notifications.

### Self-assignable roles and pick groups

`Role` gains `selfAssign` (default false; set with `role.create`/`role.update`): members give it to and take it from
themselves. Such a role **never grants anything above the member base role**: it can't carry a permission
(`role.create`/`role.update` with both → `bad_request`, key `role_self_assign_perms`), it doesn't count in the
[hierarchy](#roles-and-permissions) (a member holding only self-assignable roles ranks by their level, as if they held
none), and `roles.self` checks both again on every call. Channel overrides for it still apply, which is how opt-in
channels work ("pick PlayStation to see #playstation").

Admins group them into the questions new members answer (Server settings → Onboarding):

```jsonc
RoleGroup { "id": 1, "title": "Platform", "question": "What do you play on?", "multi": true, "roles": [4, 5, 6] }   // role ids, in the order shown
```

| type | body | result | who |
|---|---|---|---|
| `role.group.create` | `title` (1–60), `question?` (≤ 200; `""` none), `multi?` (default false: picking one drops the group's others), `roles` (1–25 ids of roles with `selfAssign`, in order) | `{ group }` | `manageRoles`; ≤ 20 groups (`bad_request`, key `role_groups_max`) |
| `role.group.update` | `id` and any of the above | `{ group }` | `manageRoles` |
| `role.group.delete` | `id` | | `manageRoles` |
| `roles.self` | `add?: [roleId]`, `remove?: [roleId]` (one of them; ≤ 100 each) | `{ member }` | any member who isn't a bot; every id must be a role with `selfAssign` and no permissions (`forbidden`, key `role_not_self_assign`). Rate limited (10, then 1 a second) |

- `role.list` and the `roles` event gain `groups: [RoleGroup]` (in order). A role that stops being `selfAssign` leaves
  every group; a deleted role too. A group may end up empty; clients skip those.
- `roles.self` with a role from a single-choice group takes the group's other roles off you first. Changes send
  `member.updated` and a fresh `channels` list like `member.roles.set`.
- Audit: `role.create`/`role.update` details gain `selfAssign`; `role.group.create` / `role.group.update`
  `{ id, title, roles }` (names), `role.group.delete` `{ id, title }`. Picking your own roles isn't audited.
- Clients show the groups on the welcome screen after agreeing to the rules, from "Pick your roles" in the server menu,
  and for `/roles`. Templates: `roles[].selfAssign` and `roleGroups` (format 4, see [Starter templates](#starter-templates)).

## Reliable sends

`chat.send` takes `nonce?` (8–64 characters of `A–Z a–z 0–9 - _`, random per message). The server stores at most one message per account and nonce (remembered for a day): a send that repeats a nonce gets `{ message, nonce }` with the message already stored, and nothing is posted or broadcast again (slowmode doesn't count it again; `not_found` if that message was deleted since). The result and the `chat.message` event carry the `nonce` (null without one), so the sender's app can replace its placeholder whichever arrives first.

`dm.send` and `group.send` take the same `nonce?`, remembered per account and kind (DM or group) for a day: a repeat gets `{ message }` with the message already stored and nothing is relayed or pushed again (`not_found` if it was deleted since). For `group.send` the repeat is answered before the `version` check, so a retry still finds its message after the group changed.

Clients make a nonce per message and, when the connection drops before the reply, send the same request again after reconnecting (before catching up on history). A retry from the "Couldn't send" state reuses the nonce too.

## Server icon and banner

A server can have an **icon** (square: the server list, the header, invites) and a **banner** (wide: the top of the
channel list). Both are uploads ([Files](#files-replies-and-reactions)): upload the picture, then name it here.

| type | body | result | who |
|---|---|---|---|
| `server.images.set` | `icon?`, `banner?`: the file id of your own upload (≤ 64 chars) sets it, `""` removes it, left out stays. At least one | `{ icon: File \| null, banner: File \| null }` | the `serverImages` ability ([built-in roles](#built-in-roles); admins by default), else `forbidden` with key `server_images_admins`. Rate limited (10, then 1 every 2 s) |

| event | body | sent to |
|---|---|---|
| `server.images` | `{ icon: File \| null, banner: File \| null }` | everyone, after every change |

`welcome.server.images` carries the same object. Servers from before this have neither (apps show initials).

The server checks the picture by its bytes (never its name or the uploader's claim) and refuses it with `bad_request`:

| | Icon | Banner |
|---|---|---|
| Type | PNG, JPEG or WebP (`server_image_type`); still pictures only (an animated WebP: `server_image_animated`; an animated PNG keeps its first frame) | same |
| Size | ≤ 1 MB (`server_icon_size`, `args: { kb }`) | ≤ 3 MB (`server_banner_size`, `args: { mb }`) |
| Pixels | ≥ 128×128 (`server_icon_small`, `args: { min }`), ≤ 4096 a side (`image_too_large`) | ≥ 480×120 (`server_banner_small`, `args: { width, height }`), ≤ 4096 a side |
| Shape | square, sides within 5% of each other (`server_icon_square`) | 2.5 to 4 times as wide as high (`server_banner_shape`) |

A picture that can't be read is `image_size_unreadable`. Both are checked before either changes.

**Metadata is stripped.** The server keeps an allowlist of what drawing the picture needs, drops everything else, and
stores the result as a new file. The upload with its metadata is deleted once the whole request has succeeded, unless
something else uses it; a refused request deletes nothing. The ICC colour profile is kept on purpose, so colours stay
right. What stays:

- **PNG:** the chunks `IHDR`, `PLTE`, `IDAT`, `IEND`, `tRNS`, `cHRM`, `gAMA`, `iCCP` (the ICC profile), `sBIT`, `sRGB`,
  `cICP`, `bKGD` and `pHYs`. Everything else goes: text, `eXIf`, `tIME`, animation (`acTL`, `fcTL`, `fdAT`: an animated
  PNG keeps its first frame) and unknown chunks.
- **JPEG:** SOI; the frame headers SOF0–SOF15 (`C0`–`CF` except `C4`, `C8` and `CC`); DHT (`C4`), DAC (`CC`), DQT (`DB`),
  DRI (`DD`); SOS (`DA`) with its scan data; RST0–RST7 (`D0`–`D7`); EOI (`D9`); and three application segments: the
  JFIF header in `APP0` (its thumbnail removed), an ICC profile in `APP2` (`ICC_PROFILE`) and Adobe's colour transform in
  `APP14`. Everything else goes: every other `APPn` (EXIF with GPS, XMP, Photoshop), comments (`FE`), JPG and JPGn
  (`C8`, `F0`–`FD`), TEM, DNL and the hierarchical markers, and reserved or unknown markers. A second SOI is refused.
- **WebP:** the chunks `VP8X` (with the EXIF and XMP flags cleared), `VP8 `, `VP8L`, `ALPH` and `ICCP` (the ICC
  profile). `EXIF`, `XMP ` and unknown chunks go; `ANIM` or `ANMF` (animation) is refused.

Nothing is decoded or re-encoded, so the pixels are exactly the uploader's (apps crop and re-encode on the device before
uploading anyway, which also drops everything). EXIF orientation goes with the rest, so apps upload pictures already
upright.

**Invites show the icon before joining.** `GET /` answers `icon`: the first 16 hex characters of the icon's SHA-256
(or `null`), and `GET /icon` serves the icon itself: any origin may show it (`Access-Control-Allow-Origin: *`,
`Cross-Origin-Resource-Policy: cross-origin`), `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
`Cache-Control: public, max-age=300` and an `ETag` (`304` for `If-None-Match`). Nothing else is in either answer: no
banner, no members, no channels. Apps load `<server>/icon?v=<stamp>`, so a new icon is a new address.

The icon and banner are kept by the upload sweep and retention, go into backups with the other uploads, and the
`set_by` account appears in that member's [data export](#download-my-data) (`serverImagesSet`). Changes are in the
[audit log](#audit-log) as `server.images` with `details: { icon, banner }` (`"set"`, `"removed"` or null).

## Organizing a server

### Categories and channel order

Admins group channels into categories and arrange them. Channels without a category are listed first.

```jsonc
Category { "id": 3, "name": "Games", "position": 0 }
// Channel gains: "categoryId": 3 | null
```

| type | body | result | who |
|---|---|---|---|
| `category.create` | `name` (1–32 chars, no control or invisible characters; case kept) | `{ category }` | admin+; ≤ 50 categories |
| `category.update` | `id, name` | `{ category }` | admin+ |
| `category.delete` | `id` | | admin+; its channels become uncategorized |
| `category.move` | `id, before?` (a category id; absent = to the end) | | admin+ |
| `channel.move` | `id, categoryId?` (absent or null = uncategorized), `before?` (a channel in that category; absent = its end) | | admin+; both channels must be ones you can read (`not_found` otherwise); not threads |
| `channel.create` | adds `categoryId?` | | |

- `position` is the order: categories by their `position`, channels by theirs (unique across the server; moves renumber them).
- **Nothing leaks:** `welcome.categories` and the `channels` event's `categories` hold, for admins, every category; for everyone else only categories containing at least one channel they can read, renumbered from 0 so hidden ones leave no gaps.
- The `channels` event gains `categories: [Category]` and is sent to everyone after any category or order change.

### Nicknames

| type | body | result | who |
|---|---|---|---|
| `member.nick` | `nick` (same rules as names: 1–32 chars, trimmed, NFC, no control or invisible characters; `""` resets), `accountKey?` (default: yourself) | `{ member }` | anyone for themselves; admins for members ranked below them |

- `Member.name` is the name to show on this server (the nickname when set). Members gain `nick` (string or null) and `profileName` (their own profile name).
- Broadcast as `member.updated`. Push notifications use nicknames too. A nickname is removed when the member leaves.

### Per-server avatar

| type | body | result | who |
|---|---|---|---|
| `member.avatar` | `file` (an upload of yours: PNG, JPEG or WebP, ≤ 1 MB, ≤ 4096 px a side, not animated; `""` removes), `accountKey?` (default: yourself) | `{ member }` | anyone for themselves; admins for members ranked below them (`forbidden`, key `rank_avatars`). Rate limited (10, then 1 every 2 s) |

- A picture for this server only. `Member.avatar` (and `avatarHash`) then point at it instead of the profile picture;
  `Member.serverAvatar` (URL or null) says whether one is set, so apps can offer to remove it. Removing it shows the
  profile picture again. Apps crop on the device as for the profile picture; the server checks the bytes and stores a
  copy without metadata (EXIF, GPS, text, thumbnails), like the [server icon](#server-icon-and-banner).
- Broadcast as `member.updated`. The picture goes when the member leaves (with their nickname) and with their account;
  it's in the data export (`serverAvatar`) and in backups with the other uploads. Audit `member.avatar` `{ removed }`
  only when an admin changes someone else's.

### Notification levels and mutes

Each account keeps, per server and per channel, a **level** (`all` messages, only `mentions`, `none`) and an optional **mute**. They're stored on the server, so every device and Web Push follow them.

```jsonc
NotifySetting { "channelId": 1 | null /* null = whole server */, "level": "all" | "mentions" | "none" | null /* null = inherit */,
                "mutedUntil": 1760000000000 | -1 /* until turned back on */ | null }
```

| type | body | result | who |
|---|---|---|---|
| `notify.set` | `channelId?` (a channel you can read, not a thread; absent = the server), `level?` (`all` \| `mentions` \| `none` \| `default`), `muteMinutes?` (0 = unmute, −1 = until turned back on, 1–43200) | `{ setting }` | anyone |

- `welcome.notify` lists your settings (expired mutes read as not muted). Event `notify.updated { setting }` goes to all of your sessions.
- **The effective level** for a channel: the channel's level, else the server's, else the default: `all` on a server with fewer than 15 members (bots not counted), `mentions` from 15 on. The default follows the server's size as it changes; any level a member picked wins. A thread follows its channel. While the channel or the server is muted, `all` counts as `mentions`.
- **Push:** `all` pushes every message (`kind: "message"`), `mentions` pushes mentions and replies, `none` pushes nothing from that channel. DMs and calls aren't affected.
- **Clients:** muted channels are dimmed and show no unread marker; mention badges stay unless the level is `none`.

### Forwarding

| type | body | result | who |
|---|---|---|---|
| `chat.forward` | `id` (a message in a channel or thread you can read; not a poll), `channelId` (a text channel or thread on this server you can write in) | `{ message }` | readers of the source who can write in the target; rate limit as `chat.send` |

- The copy is a new message by you with the source's text and attachments. Message gains `forwarded: { channelId, channelName, messageId, createdAt } | null`. A forward of a forward points at the original.
- **No leaks:** `channelId`, `channelName` and `messageId` are only filled in when the source channel still exists and its read role is no higher than that of the channel the copy is in (so everyone who sees the copy could read the source). Otherwise they're `null` and clients show just "Forwarded". This is worked out each time the message is shown, so it follows later role changes.
- Forwards don't ping again: mentions and replies in the copy don't push or count as mentions (people at "All messages" are still notified).
- **Into a DM** the client sends an ordinary end-to-end encrypted DM. Its content gains `forward: { from, files: [{ name, url, size, type }] }`: `from` is `"#channel on Server"` only when the recipient can read that channel on that server, else `null`; files are links to the source server (`http(s)` only), opened on click, never loaded on their own. Receivers check every field and drop a malformed `forward`.

### Synced preferences

Small per-account settings that follow you across devices (today: `rail`, the server rail's order and folders).

| type | body | result | who |
|---|---|---|---|
| `prefs.get` | `name` (`[a-z][a-z0-9-]{0,31}`) | `{ data \| null, updatedAt \| null }` | anyone (their own) |
| `prefs.set` | `name`, `data` (base64url, ≥ 40 bytes, ≤ 16 KB), `updatedAt` (ms) | | anyone; ≤ 16 names per account; 1/s, burst 10. An older `updatedAt` than the stored one is ignored, and so is one more than a day ahead of the server's clock |

- Event `prefs.updated { name, updatedAt }` to the account's other sessions.
- `data` is opaque to the server: clients seal it with XChaCha20-Poly1305 under `crypto_kdf_derive_from_key(32, 1, "iskrapre", accountSeed)`, with `"iskra/prefs/v1" || 0x00 || name` as associated data, as `nonce(24) || ciphertext`. So a server can't see which other servers you're on. Clients write to every connected server and keep the newest copy. Removed with the membership.

## Watch parties

Everyone in a voice channel (or stage) watches the same video in step. The server keeps only a shared clock (play, pause, position, speed) and checks who may change it; each client plays the video itself, straight from its source. Supported sources: an `https://` link to a media file, a file uploaded to this server, or a YouTube video (played with YouTube's official IFrame Player API on `youtube-nocookie.com`; nothing is downloaded or scraped). For anything else, share your screen with audio.

| type | body | result | who |
|---|---|---|---|
| `watch.start` | `channelId, source, title?` (≤ 200 chars) | `{ party }` | someone in the room (LiveKit's webhooks) who may host: in a voice channel its writers, on a stage its speakers and moderators. Replaces a running party only for its host or a moderator (else `bad_request`) |
| `watch.control` | `channelId, partyId, playing? (bool), position? (seconds, 0–172800), rate? (0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75 or 2)` | `{ party }` | in the room and allowed to host, and the party's host, or anyone when `anyoneControls`, or a moderator. A missing `position` carries on from the shared clock |
| `watch.settings` | `channelId, partyId, anyoneControls? (bool), audioOnly? (bool)` (at least one) | | the host or a moderator |
| `watch.stop` | `channelId, partyId` | | the host or a moderator |
| `watch.chat` | `channelId, text` (1–500 chars, one line) | | in the room, while a party is on. Not stored |
| `watch.clock` | | `{ now }` (server time, ms) | anyone (for clock sync) |
| `watch.queue.add` | `channelId, partyId, source, title?` (as for `watch.start`) | `{ party }` | whoever may control the party (as for `watch.control`); ≤ 100 queued (`bad_request`, key `watch_queue_full`, args `{ max }`) |
| `watch.queue.remove` | `channelId, partyId, itemId` | `{ party }` | whoever may control; an unknown item is `not_found` |
| `watch.queue.move` | `channelId, partyId, itemId, before?` (another item's id; left out = to the end) | `{ party }` | whoever may control |
| `watch.next` | `channelId, partyId, playId?` | `{ party }` | whoever may control: the first queued item starts playing from 0 (the speed stays). With `playId` that isn't the party's current one, or with nothing queued, nothing changes and the party comes back as it is |

`source` is one of:
- `{ kind: "url", url }`: `https://` only, absolute, a host, no credentials, no whitespace, ≤ 2048 chars.
- `{ kind: "file", fileId }`: a file uploaded to this server whose sniffed type is video or audio. The party's `source.url` is its `/files/…` path. The unused-upload sweep keeps it while a party plays it.
- `{ kind: "youtube", videoId }`: 11 characters of `A–Z a–z 0–9 _ -`.

Moderators here are admins in voice channels and stage moderators on stages. A `partyId` that isn't the current party's is `not_found`, so a late control can't change a new party.

```jsonc
WatchParty { "id": "<b64u 12>", "channelId": 3,
             "source": { "kind": "url" | "file" | "youtube", "url": "https://…" | "/files/…" | null,
                         "fileId": "…" | null, "videoId": "…" | null, "title": "Movie night" | null },
             "host": "<accountKey>", "anyoneControls": false,
             "playing": true, "position": 61.5, "rate": 1,   // at server time updatedAt playback was at position (seconds)
             "updatedAt": 1760000000000, "startedAt": 1760000000000, "updatedBy": "<accountKey>",
             "queue": [{ "id": "<b64u 12>", "source": { /* as above */ }, "addedBy": "<accountKey>", "addedAt": 0 }],   // what plays next, in order
             "audioOnly": false,                  // a jukebox: apps hide the video for everyone and show a now-playing bar
             "playId": "<b64u 12>" }              // changes whenever the party moves on to another source
```

**Listen together.** The queue (≤ 100 items; titles ≤ 200 characters, key `watch_title`) is kept with the party, in
memory. Anyone who may control the party adds to it, reorders it and removes from it; the `watch.state` event carries
every change. When the item playing ends, apps that may control send `watch.next` with the `playId` they were playing:
the server moves the party on once, and later requests with the old `playId` change nothing, so several apps noticing
the end at the same moment can't skip two items. Nothing queued: the party stays at the end, as before. `audioOnly`
is the host's (or a moderator's) setting for everyone. Uploaded files in the queue are kept by the unused-upload sweep
like the one playing. Rate limits: `watch.queue.add` 10, then 1 a second; `watch.queue.remove` and `watch.queue.move`
20, then 4 a second; `watch.next` 10, then 2 a second.

- **Where playback is now**: `position + (serverNow − updatedAt) / 1000 × rate` while playing, else `position`. Clients estimate the server clock with `watch.clock` (several round trips; the shortest one's midpoint wins) and correct drift: under 0.15 s is left alone, up to 1 s they play 5 % faster or slower, beyond that they jump (YouTube only jumps, from 1.5 s). A late joiner gets the party in `welcome` and starts at the right spot.
- A party starts paused at 0. When its host leaves the room (or may no longer host), it passes to whoever has been in the room longest and may host; when the room empties, or nobody there may host, it ends.
- In-memory only, like voice state.
- No YouTube script runs in the app's page (it could read the app's keys there): the `youtube-nocookie.com` embed (`enablejsapi=1`) runs in a sandboxed iframe (`allow-scripts allow-same-origin allow-presentation`) and the app drives it with the IFrame Player API's postMessage commands (`playVideo`, `pauseVideo`, `seekTo`, `setPlaybackRate`, `setVolume`), reading back only the player's `infoDelivery`/`onStateChange`/`onError` messages from that frame's window and origin. The Content-Security-Policy allows no third-party scripts, and frames from `https://www.youtube-nocookie.com`. The embed iframe sends `strict-origin-when-cross-origin` referrers (YouTube requires one) although the app otherwise sends none. The desktop app's `app://` origin isn't a referrer YouTube accepts ("Error 153"), so its main process sets `Referer: https://app.iskra.foo/` on requests to `https://www.youtube-nocookie.com` made from the app's own window, and on nothing else.

| event | body | sent to |
|---|---|---|
| `watch.state` | `{ channelId, party: WatchParty \| null, serverTime }` | readers of the channel, after any change |
| `watch.chat` | `{ channelId, accountKey, text, at }` | people in the room who can read the channel |

## Group DMs and group calls (end-to-end encrypted)

A group DM is 3–10 members of one server. Messages and calls are end-to-end encrypted like [DMs](#direct-messages-end-to-end-encrypted) and [calls](#calls-voice-and-video-in-dms-end-to-end-encrypted). The server stores the encrypted messages, routes them to the group's members, and knows who is in which group and when they write; it never sees what is said, nor the group's name.

### The membership chain

Membership is a list of **changes**, each signed by the member who made it. Clients verify every change themselves, so a server can't add anyone to a group: it would need a member's signature.

```jsonc
GroupChange { "payload": "<b64u of UTF-8 JSON, ≤ 4096 chars>", "sig": "<b64u 64>" }
// payload:
{ "v": 1, "group": "<b64u 16 random bytes>", "version": 2, "prev": "<head of version 1>", "by": "<accountKey>",
  "action": "create" | "add" | "remove" | "leave", "targets": ["<accountKey>"...], "members": ["<accountKey>"...], "at": 1760000000000 }
```

- `sig = Ed25519.sign(accountSecret of by, "iskra/group-change/v1" || 0x00 || payload bytes)`. The exact payload bytes travel and are stored as they were signed, so nobody has to re-serialize JSON to check a signature.
- `head = b64u(SHA-256(payload bytes))`. Each change names the previous one's head in `prev` (`""` for the first), so the chain can't be reordered, spliced or rewritten.
- `members` is the full member list after the change, in join order, and must be exactly what the action produces:
  - `create`: version 1, `members = [by, ...targets]`, 3–10 different people.
  - `add`: anyone in the group; `members = old members + targets` (1 or more people not already in it, ≤ 10 in total).
  - `remove`: only the **owner**, who is the first in the member list (the creator, until they leave; then the longest-standing member); one target, not themselves.
  - `leave`: anyone in the group, for themselves only.
- `at` is the author's clock; the server refuses changes more than 10 minutes off. Everyone named in `create`/`add` must be a member of this server and not a bot.
- The server applies changes one at a time: `version` must be the current version + 1 and `prev` the current head, else `conflict`. A group nobody is left in is deleted.
- **Account key rotations:** a member who [replaced their account key](#account-key-rotation) stays the same member. The server moves them to the new key in the group's member list; changes already made stay as they were signed. Clients compare member lists under everyone's current key (from rotations they verified), so a change signed by the new key, or listing it, fits a chain that names the old one. A client that doesn't know the rotation yet refuses such a change until it does.

### Requests and events

| type | body | result | who |
|---|---|---|---|
| `group.create` | `change` (a `create` change by you) | `{ group }` | members (not bots: `forbidden`); ≤ 100 groups per account here |
| `group.change` | `change` (`add`, `remove` or `leave`, by you) | `{ group }` | members of the group, by the rules above; `conflict` if it changed meanwhile |
| `group.list` | | `{ groups: [{ group, lastId, lastAt }] }` (≤ 200, most recently active first) | yourself |
| `group.get` | `groupId, since?` (a version; default 0) | `{ group, changes: [GroupChange + version] }` (the changes after `since`, oldest first) | members of the group |
| `group.send` | `groupId, version, envelope` (JSON object, ≤ 56 KB) | `{ message }` | members of the group (not bots); `version` must be the current one (`conflict`) |
| `group.history` | `groupId, before?, limit? (1–100)` | `{ messages (oldest first), hasMore }` | members of the group |

`Group { id, version, head, members, createdAt }`. `GroupMessage { id, group, from, version, envelope, createdAt }`. A group you aren't in (any more) is `not_found`, admins included. `group.create` and `group.change` share a per-account limit of 10 a minute; `group.send` has the `dm.send` limits (2/s, burst 10).

| event | body | sent to |
|---|---|---|
| `group.changed` | `{ group, change }` | everyone in the group before or after the change (so someone removed hears it) |
| `group.message` | `{ message }` | every session of every member |

### Group envelope

A group message is the [envelope v2](#forward-secrecy-envelope-v2) with a group header:

```jsonc
{ "v": 2, "kind": "group",
  "header": { "from": "<accountKey>", "group": "<group id>", "version": 3, "head": "<head of version 3>", "sentAt": 1760000000000, "id": "<b64u 12>" },
  "sender": DeviceCert, "nonce": "<b64u 24>", "ct": "<b64u>", "keys": [ /* as in v2 */ ] }
```

- Associated data: `JSON.stringify(["iskra/group-dm/v1", from, group, version, head, sentAt, id])`. The group id and the exact chain head the sender encrypted for are authenticated, so a message can't be moved to another group or passed off as sent to a different member list.
- Senders encrypt to every valid, unrevoked device of every member **of the chain they verified** (plus their own devices), forward secret through signed prekeys as in v2. They never take a member list from the server. Members whose devices can't be fetched (e.g. kicked from the server) get no slot.
- Receivers check: the header's group, sender and version equal the server's routing fields; the version's head is the one in their verified chain (a newer version means: fetch the chain first); the sender was a member at that version; the sender certificate is valid and belongs to `from`. Anything else is shown as "couldn't be read".
- Content is `{ "text": "…" }`, or with `"group": { "kind": "rename", "name": "≤ 64 chars", "silent"?: true }` to name the group (`""` clears it; the newest rename wins; `silent` is the same name re-sent for people just added, not shown as a line). Call lines: `"call": { "kind": "group-start", "id", "video" }`.
- New members only read messages sent after they joined: older envelopes have no slot for them.

### Group calls

One call per group at a time, in a LiveKit room the server only issues tickets for to the group's current members.

| type | body | result | who |
|---|---|---|---|
| `gcall.start` | `groupId, callId` (16 random bytes, b64u), `version` (current), `video?`, `envelope` (group envelope carrying the key, ≤ 56 KB) | `{ call, ticket: { url, token, room } }` | members of the group (not bots); `busy` if the group already has a call, `voice_unavailable` without LiveKit, `conflict` on an old version; the `call.start` per-account limits |
| `gcall.join` | `callId` | `{ ring: { call, envelope }, ticket }` (the newest key envelope) | members of the group |
| `gcall.decline` | `callId` | | members of the group (stops the ringing on your other devices) |
| `gcall.leave` | `callId` | | members of the group (also removes you from the room) |
| `gcall.key` | `callId, version` (current), `envelope` (≤ 56 KB) | | members of the group who are in the call (`forbidden` otherwise) |
| `gcall.list` | | `{ calls: [{ call, envelope, ringing }] }` (calls in your groups) | yourself |

`GroupCall { id, group, from, video, createdAt, participants: [accountKey] (in the order they joined, from LiveKit's webhooks), keyVersion }`.

| event | body | sent to |
|---|---|---|
| `gcall.ring` | `{ call, envelope }` | every session of the other members (plus a push of kind `call` with `group`) |
| `gcall.state` | `{ call }` | the group's members, whenever who's in the call (or the group) changes |
| `gcall.key` | `{ call, envelope }` | the group's members |
| `gcall.ring.stopped` | `{ callId }` | your other sessions once you joined or declined, and everyone still ringing when the ringing times out |
| `gcall.ended` | `{ callId, group }` | the group's members |

- Room: `gcall-` + the first 16 bytes (hex) of `SHA-256("iskra/group-call-room/v1" 0x00 groupId 0x00 callId)`. Anyone LiveKit reports in it who isn't a current member of the group (and of the server) is removed; so is anyone the group loses while the call goes on.
- Ringing lasts 45 s. A call ends when nobody is in the room and nobody is still being rung (or when LiveKit goes down).
- **Media key:** the starter makes a random 32-byte key and sends it in a group envelope whose content is `{ "text": "…", "call": { "kind": "group-key", "id": callId, "key": "<b64u 32>", "index": 0–15, "video": bool } }`. The server keeps only the newest key envelope, in memory, for people who join later. Clients accept a key only from someone in the group now, for this call, and only if it is newer than the one they have (a higher group version, or the same version sent later), so an old key can't be replayed. Keys go to LiveKit's end-to-end encryption at `index` (16 slots), so frames under the previous key still decrypt during a switch.
- **Rekeying:** when the group changes during a call, `keyVersion` falls behind the group's version. The participant who has been in the room longest and is still in the group then sends a new key (next index) encrypted for the new member list with `gcall.key`. Someone removed is dropped from the room at once, and the new key keeps them out of the media even if they still received packets. Someone added joins without a key and gets the new one the same way.

### Push

Group messages push `{ kind: "group", group, title: "New message from X", body: "In a group. Open Iskra to read it." }`, never content or the group's name (the server doesn't know it). Group calls push `{ kind: "call", group, title: "X started a group call" }`, at most once per group and member per 15 s. A click opens `/#/open/<serverKey>/g/<groupId>`.

### Limitations

- The server sees who is in which group, when people write, and how big messages are. It can't read them, add members, or move messages between groups.
- It can withhold or delay changes: a device that hasn't heard about a removal keeps encrypting to the old list until it does. The server refuses messages for an old version, so this needs a misbehaving server, and only shows the removed person what they would have seen before the removal.
- Clients pin the chain they verified and refuse a chain that contradicts it, but two devices that never compare notes could be shown different (correctly signed) forks if two members changed the group at the same moment and the server accepted both. There's no group-wide safety number; compare each member's DM safety number to be sure of their keys.
- People who leave the call but stay in the group keep the call key (they could rejoin anyway); keys change only when the group does.
- A new device reads group messages from when it was linked, unless the history came along in the link ([history parts](#device-linking)).
- Groups whose server you removed from your list stay on your device, read-only ("archived"), until you remove them; adding the server back makes them active again.

## Backups, moving and imports

### Backups

| type | body | result | who |
|---|---|---|---|
| `backup.create` | `sealedPassphrase` (b64u, ≤ 4096 chars; the passphrase, 8–1024 characters, sealed as below) | `{ url: "/backup/<token>", name, size, expiresAt }` | owner; one backup at a time (`rate_limited` while one is being made) |
| `backup.status` | | `{ auto: { enabled, keep, includeUploads }, local: [{ name, size, createdAt }], folder, copyTo, copyPassphraseSet, copy }` | owner |
| `backup.settings` | `enabled?`, `keep?` (1–30), `includeUploads?`, `copyTo?` (string ≤ 1024 chars, or `""`/null to stop copying), `sealedCopyPassphrase?` (b64u ≤ 4096 chars, sealed like `backup.create`'s) | same as `backup.status` | owner (written to `server.json` → `Backups`) |
| `limits.get` | – | `{ maxUploadMb, memberMbPerDay, guestMbPerDay, soundMaxSeconds, soundMaxMb, emojiMaxKb, stickerMaxKb }` (0 = no limit, except `maxUploadMb`) | any member |
| `limits.update` | any of the `limits.get` fields (whole numbers; `maxUploadMb` ≥ 1) | same as `limits.get` | owner (written to `server.json` → `MaxUploadMb`, `UploadQuota`, `Limits`) |

- **The passphrase never crosses the network in the clear.** The client seals it to the server key it verified in the handshake: `sealedPassphrase = crypto_box_seal("iskra/backup-passphrase/v1" || 0x00 || serverKey(32) || utf8(passphrase), X25519(serverKey))`, where `X25519(serverKey)` is `crypto_sign_ed25519_pk_to_curve25519` of the server's Ed25519 key. The server opens it with its own key converted the same way and checks the context and key prefix. A plain `passphrase` field, or a box that doesn't open or carries another context or key, is `bad_request`.
- While a backup is built, the requesting session gets `backup.progress { done, total }` (bytes, about every 2%).
- `GET /backup/<token>` serves the file (`Content-Disposition: attachment`, `no-store`, CORS open). The token is 24 random bytes and works for 30 minutes; then the file is deleted.
- **What's in it:** a zip of `manifest.json` (`{ iskraBackup: 1, createdAt, serverKey, name, uploads, includesUploads }`), `iskra.db` (a consistent copy made with SQLite's online backup API on a separate read connection, so the server keeps running), `server.json`, `server.key`, `livekit.key`, `vapid.json` and `uploads/ab/<sha256>`. Certificates aren't included (the new machine gets its own), nor are the owner invite or a move notice.
- **Encryption** (a backup holds the server key): `"ISKRABK1"`, `u32be` header length, header JSON `{ v: 1, kdf: "argon2id13", salt (b64u 16), ops, mem, createdAt, serverKey, name }`, the 24-byte `crypto_secretstream_xchacha20poly1305` header, then chunks of `u32be length || ciphertext` (≤ 64 KB plaintext each). Key = `crypto_pwhash` Argon2id13(passphrase in NFC, salt, ops = 3, mem = 256 MB). The first chunk's associated data is the magic plus the header JSON and the last chunk carries `TAG_FINAL`, so a changed header, reordered or cut-off chunks and a wrong passphrase are all detected. Readers refuse `ops` outside 1–10 and `mem` outside 8 MB–1 GB.
- **Automatic daily backups:** `backups/auto-YYYY-MM-DD.zip` in the world folder: the same zip, unencrypted (the folder already holds the keys), files 0600 and the folder 0700 on Linux and macOS. The newest `Keep` are kept. `server.json`: `"Backups": { "Enabled": true, "Keep": 7, "IncludeUploads": false, "CopyTo": null, "CopyPassphrase": null }`; uploads stay in `uploads/` unless `IncludeUploads` is on.
- **Encrypted copies on another disk** (`Backups.CopyTo` and `Backups.CopyPassphrase`; `copyTo` and `sealedCopyPassphrase` in `backup.settings`): after each daily backup, and hourly until it's there, the newest daily backup is also written into that folder as `auto-YYYY-MM-DD.iskrabackup`, encrypted with the copy passphrase in exactly the format of `backup.create` below (header `name` and `createdAt` are the server's and the daily backup's). It's written to `.auto-….tmp` there, flushed, then renamed (0600 on Linux and macOS); a name that's already there isn't written again. Only the newest `Keep` files named exactly `auto-YYYY-MM-DD.iskrabackup` are kept there (nothing else in the folder is touched). Copies are never written unencrypted. The passphrase is sealed exactly like `backup.create`'s (same context; a plain `copyPassphrase` field is `bad_request`, a box that doesn't open is `passphrase_unreadable`), must be 8–1024 characters, and is required whenever `copyTo` or the passphrase changes and a folder is set (`bad_request`, key `backup_copy_passphrase`, `args: { min }`); without `sealedCopyPassphrase` the stored one is kept. The server keeps it in `server.json` and never logs or returns it: `backup.status` only says `copyPassphraseSet`, and the security log's `backup.settings` entry has `copyPassphraseSet` instead. Stopping the copies (`copyTo` empty or null) also forgets the passphrase. The folder must be an absolute path outside the world folder (`bad_request` with key `backup_copy_relative` or `backup_copy_inside_world`; a link into the world counts as inside) and must already exist (`backup_copy_not_found`): the server never creates it, so an unmounted disk can't fill the system disk. Changing `copyTo`, the passphrase or `keep` copies right away, in the background. `backup.status` → `copyTo` is the normalized folder or null; `copy` is null before the first try (or with no folder), else `{ at, ok, name, error }` with `error` null or `{ code, message, key, args }`: `backup_copy_missing` (the folder is gone, e.g. a disk not mounted), `backup_copy_passphrase`, `backup_copy_relative` or `backup_copy_inside_world` (a hand-edited `server.json`), or `backup_copy_failed` (`args: { reason }`). A failed copy is logged once per new problem and never stops the server or the daily backup. A copy restores like any downloaded backup (`iskra-server restore`, asking for its passphrase).
- **Restore:** `iskra-server restore <backup> <world-folder>`. The folder must be new or empty. The passphrase comes from `--passphrase-stdin`, `$ISKRA_BACKUP_PASSPHRASE` or a prompt; `--json` prints `{ ok, name, serverKey, folder, uploads, messages }`. Only the names above are written: anything else in the zip (`../`, absolute paths) is ignored, every upload must match its SHA-256 name, and the key must match the manifest. On any failure the new folder is removed again. `iskra-server backup <world-folder> <file>` makes an encrypted backup from the command line.

### Moving a server

```jsonc
MoveNotice { "serverKey": "<b64u 32>", "url": "https://new.example.com", "movedAt": 1760000000000, "sig": "<b64u 64>" }
```
`sig = Ed25519.sign(serverSecret, "iskra/server-moved/v1" || 0x00 || serverKey(32) || u64be(movedAt) || utf8(url))`

| type | body | result | who |
|---|---|---|---|
| `server.move` | `url` (absolute http(s), no credentials, query or fragment, ≤ 512 chars; not this server's current address) | `{ notice }` | owner |
| `server.move.cancel` | | | owner |

- The notice is kept in `moved.json` in the world folder and checked against the server key when it's loaded. `iskra-server move <world-folder> <url>` writes it with the server stopped; `--cancel` removes it.
- Event `server.moved { notice | null }` to everyone. `welcome.server.moved` carries it too, and `GET /.well-known/iskra-moved` returns it (CORS open, `no-store`, 404 if none) so clients can fetch it from the old address.
- While a notice is up, every request except `ping`, `server.move`, `server.move.cancel`, `backup.create`, `backup.status`, `host.status` and `host.internet.set` gets `error` code `moved`, so nobody keeps writing into the old copy.
- Clients verify the signature against the server key they already trust (from the invite link) and then switch their saved address to `url`. The new address must still answer `hello` with the same key, so a notice can only ever lead to the same server.

### Importing from Discord

The owner can import a Discord server's history from [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) JSON exports: one channel's `.json`, or a `.zip` of several. Exports made with `--media` include files and avatars, in `<export>.json_Files/`.

| type | body | result | who |
|---|---|---|---|
| `import.begin` | `size` (bytes, ≤ `Import.MaxMb`, default 4096), `readOnly?` (imported channels only admins can write in) | `{ url: "/import/<ticket>", maxBytes }` | owner; one import at a time (`rate_limited`) |
| `import.status` | | `{ job: ImportJob \| null, running }` (the latest import) | owner |
| `import.cancel` | | | owner, while one runs (`not_found` otherwise) |

- `PUT /import/<ticket>` with the raw file (single use, 30 minutes; `413` past the size; `415` unless it starts like a zip or a JSON object) answers `202 { started: true }`, and the import runs on the server.
- Event `import.progress { job }` goes to the owner's sessions (≤ 4 a second, plus each phase change): `ImportJob { phase: "reading" | "importing" | "done" | "failed" | "cancelled", channels, channelsDone, messages, messagesDone, files, missingFiles, skipped, current, error, warnings: [string], imported: [{ id, name, category, messages, thread }] }`. When it's done, everyone gets `channels`.
- A failed or cancelled import removes every channel it made.
- Each Discord channel becomes a text channel (lowercase with dashes, `-2` added if the name is taken; read `member`, write `member`, or `admin` when read-only). Its Discord category is kept with it (`imported_channels.category`) for channel categories. A thread export becomes an Iskra thread when the message it started from was imported into its parent channel, and a channel of its own otherwise.
- Messages of type `Default`, `Reply`, `ChatInputCommand` and `ContextMenuCommand` are imported in order (system notices are skipped), with their timestamps and edit times, replies (within the channel), pins (up to 50 per channel), stickers and forwarded text as text, and embed text when a message has nothing else. Text is NFC with control and invisible formatting characters dropped, ≤ 4000 characters.
- Authors aren't accounts here. `author` is `"discord:<user id>"` and the message gains `imported: { source: "discord", name, avatar: File | null, bot, reactions: [{ emoji, count }], missingAttachments: [{ name, size }] } | null` (null on every other message). Clients label these "Imported from Discord". Reply previews gain `importedName` (string or null). Reactions are counts (custom emoji as `:name:`); people can still react to imported messages as usual. Nobody can edit imported messages; admins can delete them.
- Files and avatars come only from the upload itself and are never fetched from Discord. A reference is resolved inside the zip as text (relative to the export, then by file name for absolute paths), so it can't reach anything on disk. Every file is stored like an upload and typed by its content; avatars must be PNG, JPEG, WebP or GIF ≤ 1 MB. Files over `MaxUploadMb`, remote links and files not in the upload are listed in `missingAttachments`.
- Limits: ≤ 2000 exports and 200,000 entries per zip, ≤ 500 channels per import, ≤ 16 MB for any single JSON value (exports are read as a stream, so their size doesn't matter otherwise), ≤ 4× `Import.MaxMb` unpacked in total. Zip entries with unsafe names are skipped.
- Roles and permissions can't be imported: DiscordChatExporter doesn't export them in a usable form. Direct-message exports are skipped.
- From the command line: `iskra-server import-discord <world-folder> <export.zip|.json> [--read-only]`, best with the server stopped (a running server shows the new channels after a restart).

## Account key rotation

An account can replace its account key, for example after its recovery key leaked or a device's storage was copied. The old key signs a hand-over to the new one; servers move the account and keep the history; other people's apps check the signatures themselves and follow.

```jsonc
Rotation        { "oldKey": "<b64u 32>", "newKey": "<b64u 32>", "rotatedAt": 1760000000000, "oldSig": "<b64u 64>", "newSig": "<b64u 64>" }
AppliedRotation { ...Rotation, "appliedAt": 1760000000000,          // when this server applied it
                  "contest": Rotation | null, "disputed": false }   // a second claim on the same old key (below)
```

- `payload = "iskra/account-rotate/v1" || 0x00 || oldKey(32) || newKey(32) || u64be(rotatedAt)`; `oldSig` is the old account key's signature over it, `newSig` the new key's. The new key signing too means nobody can point an account at a key they don't hold (or merge it into someone else's).
- A key is rotated away at most once per server, so the rotations form a chain (`K0 → K1 → K2`, at most 16 links). A retired key can't sign in, revoke devices or rotate again there.
- Device keys stay the same: the rotating device re-certifies the account's devices with the new key (ordinary `DeviceCert`s), so prekeys and push subscriptions carry on. Devices that aren't re-certified are dropped.

| type | body | result | who |
|---|---|---|---|
| `account.rotate` | `rotation`, `certs?` (≤ 20 `DeviceCert`s signed by `newKey`), `handovers?` (≤ 20 `{ device, seal }`, only for re-certified devices) | `{ status: "applied" \| "already" }` | the old key (to rotate) or the new key (to add certificates and hand-overs to a rotation already applied here) |
| `account.rotations` | `accountKey` | `{ rotations: [AppliedRotation] }` (the keys that led to it, oldest first) | anyone |
| `account.dispute.resolve` | `oldKey, keep` (one of the two disputed keys) | | admin+ who outranks the disputed member, not about themselves |

**What a server checks and does** (`account.rotate`, or `auth.rotations`):

- both signatures; `rotatedAt` at most 10 minutes in the future; the old key is a member here (or banned: the ban moves along); the new key was never seen here (no member, ban, device or rotation). Otherwise `bad_request`.
- In one transaction it moves everything kept about the old key to the new one: membership, role, name and profile, profile page, messages, reactions, pins, threads, polls, files, invites, bans, bots, push subscriptions and DMs (envelopes keep their signed headers; only the routing fields change). Revocations stay under the old key, which signed them. Server convention: any table storing account keys keeps them in TEXT columns named `account_key`, `*_key` or `*_by` (or `uploader`), which the move rewrites automatically.
- The old key's live sessions get `account.rotated` and are closed with 4409; everyone gets `member.rotated`; voice and calls the old key was in are ended.
- Later, a sign-in with the old key fails with `account_rotated`, whose body carries `rotations` (where the key went, step by step) and `handover` (this device's sealed hand-over, if there is one, else `null`). Hand-overs are deleted once the device signs in with the new key.

**Catching up a server.** Clients remember their rotations and send them in `auth.rotations` to servers that missed them (offline at the time): a contiguous chain ending at the certificate's account key, starting at a key the server knows. The server applies each link as above before checking membership; a broken or invalid chain is ignored (the device is then a stranger: `invite_required`). Afterwards the client sends `account.rotate` from the new key with the certificates and hand-overs.

**Hand-over to the account's other devices.** Every device holds the account key, so the rotating device gives the new one to each device it carries over: `seal = crypto_box_seal(newSeed(32), X25519(deviceKey))` (the device key converted as for DMs). A device that learns of a rotation opens its seal, derives the key pair from the seed and only accepts it if the public key is that rotation's `newKey`, signed over by its own old key. So a server can't slip in a key of its own. A device without a seal (not carried over, or a restore from the old recovery key) can't follow: the app tells the person their key was replaced.

**Two claims on one key.** Whoever has the old key (the owner, or someone who stole it) can rotate, and a server can't tell them apart. The rule:

1. **The first valid rotation wins** on each server, immediately.
2. Every device of the old account is told (the `account.rotated` event, or `account_rotated` at its next sign-in), so the real owner finds out on every device. A device that wasn't handed the new key says "Your account key was replaced" and offers to **claim it back**: it signs its own rotation from the old key to a fresh key.
3. A second, different rotation of the same old key within **30 days** of the first being applied (`ContestWindowMs`) doesn't win, but makes the account **disputed**: the server records it as `contest`, caps the current holder's role at `member` (so a thief can't keep using admin or owner rights), answers the claimant `account_disputed` and sends `account.disputed` to everyone. Only the first contest is recorded. After 30 days the old key is simply dead.
4. An admin who knows the person settles it with `account.dispute.resolve`: keeping the current key restores its role; keeping the contesting key moves the account there (the other key's sessions get `account.rotated` and close, its devices are dropped) and restores the role. `account.resolved` goes to everyone.

Limits of this: a thief who rotates first on a server where the owner doesn't act holds the account there until an admin decides; a server whose only admin is the disputed account stays disputed. On servers the owner reaches first, the owner's rotation wins.

| event | body | sent to |
|---|---|---|
| `account.rotated` | `{ rotations: [AppliedRotation], handover: seal \| null }` | the old key's sessions, right before 4409 (also the loser of a resolved dispute) |
| `member.rotated` | `{ rotation: AppliedRotation, member }` | everyone |
| `account.disputed` | `{ rotation: AppliedRotation, member }` (the current holder, role capped) | everyone |
| `account.resolved` | `{ rotation: AppliedRotation, previousKey, member }` | everyone |

**What contacts' apps do.** They verify every rotation's two signatures themselves (never trusting the server's word), remember them, and treat the chain as one person: the friend entry, the DM conversation and its local history move to the new key, envelopes whose signed header names an earlier key of the same chain still decrypt, and the conversation shows **"Safety number changed"** (the safety number covers account keys, so it does change). A disputed account gets a warning until it's resolved.

**On the rotating device:** the new key gets a new recovery key, shown right away; the old recovery key stops working on every server that has the rotation.

## Keys on the device

Local storage only; nothing here goes over the wire.

- Secrets (the identity, prekeys, a pending rotation, decrypted DM history) are stored in IndexedDB encrypted with a random 32-byte data key: `XChaCha20-Poly1305(JSON, nonce(24), key, ad = "iskra/local/v1" || 0x00 || storage key)`. The associated data binds each value to its slot, so values can't be swapped.
- The data key is stored wrapped:
  - **desktop app:** with Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret/kwallet). On Linux without a keyring (`basic_text` backend) the app uses the browser wrap below and says so.
  - **browser:** with a non-extractable AES-GCM `CryptoKey` kept in IndexedDB (`wrap = AES-GCM(key, iv(12), dataKey)`).
  - **app lock (optional):** the data key is additionally wrapped with `crypto_pwhash` (Argon2id13, opslimit 3, memlimit 64 MiB, random 16-byte salt) of the passphrase and `crypto_secretbox`, and the app asks for the passphrase at startup.
  - **passkeys (optional):** each passkey's PRF output wraps another copy of the data key; see [Passkeys for the app lock](#passkeys-for-the-app-lock).
- Data stored before this existed is encrypted on first start, after which the app records that it did (`vault-migrated`). From then on a secret slot holding a value that isn't sealed is refused with an error, never returned: only something else writing to the app's storage could have put it there. Device linking and recovery keys work as before (the app has the keys in memory once unlocked).

## Activity status

What someone is doing right now ("Playing Factorio"), shown next to their name. It's opt-in on the client: the desktop app can detect games by matching running program names against a list, on the user's own computer, and sends only the matched game's name. Nothing about how it was detected, and never the list of programs, goes over the wire.

Every `Member` gains `activity: { "name": "Factorio", "since": 1760000000000 } | null`. It lives only in the server's memory and only while the account is online: it's `null` for offline members and cleared when the last connection closes.

| type | body | result | who |
|---|---|---|---|
| `activity.set` | `name` (1–64 chars, same text rules as names; `null` or `""` clears) | `{ activity }` | anyone |

- `since` is set by the server when the name changes; sending the same name again keeps it and broadcasts nothing.
- Real changes are limited to 5 in a burst, then one per 10 seconds per connection (`rate_limited`).
- Each change is broadcast as `member.updated`. `welcome.members` carries current activities.
- `activity` is a separate field next to [presence](#presence-and-custom-status) (`status`, `customStatus`) on the same `Member`, so clients can show both. Members who appear offline (no sessions, or `invisible`) show no activity.

## Voice user limits and server rules

### Voice user limits

`Channel` gains `userLimit` (0 = no limit; always 0 for text, forum and stage channels). `channel.create` and `channel.update` take `userLimit?` (0–99), voice channels only: on a stage it's `bad_request`, since a stage is made for a big audience that mostly listens (LiveKit's own limits still apply).

- `voice.join` on a voice channel with `userLimit` people already in it (from LiveKit's webhooks, not counting yourself) answers `channel_full` ("lounge is full (5/5). …").
- People who can move members (`moveMembers`: admins, the owner and roles with it) join anyway, as on Discord. Someone moved there with `voice.move` may join it for 60 s even when it's full.
- LiveKit joins are checked again: a join that would go over the limit (two tokens handed out at the same moment, an old token) is removed from the room, with the same exceptions.
- Lowering the limit doesn't remove anyone already inside. Clients show "2/5" next to the channel.
- Audit: `channel.create` details gain `userLimit`; `channel.update` changes gain `userLimit: { from, to }`.

### Server rules

Admins write rules (Markdown, rendered like messages) and an optional welcome message. When agreeing is **required**, members who haven't agreed to the current version can read but not take part until they do.

```jsonc
Rules { "text": "1. Be kind …", "welcome": "Welcome!", "required": true,
        "version": 2,                 // goes up when everyone has to agree again
        "updatedAt": 1760000000000 | null,
        "mustAgree": false,           // you, right now
        "agreedVersion": 2,           // the newest version you agreed to (0 = never)
        "agreed": 14 | null, "members": 15 | null }   // admins, in rules.get and rules.update: how many agreed (owner and bots not counted)
```

| type | body | result | who |
|---|---|---|---|
| `rules.get` | | `{ rules }` | anyone |
| `rules.update` | `text?` (≤ 6000 chars, newlines allowed; `""` clears), `welcome?` (≤ 500 chars), `required?` (bool), `reaccept?` (bool) | `{ rules }` | admin+ |
| `rules.accept` | `version` (the version you were shown) | `{ rules }` | anyone, while agreeing is required; another version is `conflict` |

- `welcome` carries `rules` (`Rules`, without the counts). Event `rules` `{ rules }` goes to every session (each its own view) after `rules.update`, and to your own sessions after `rules.accept`.
- `required` needs non-empty `text`. `reaccept: true` (only with `required`) raises `version`, so everyone must agree again. Turning `required` on without `reaccept` counts everyone who is a member right now as having agreed, so only people who join later are asked; with `reaccept`, existing members are asked too. Edits without `reaccept` keep everyone's agreement. Whoever saves required rules has agreed to them.
- Not yet agreed: these answer `rules_required`: `chat.send`, `chat.edit`, `chat.react`, `chat.typing`, `chat.pin`, `chat.forward`, `upload.begin`, `thread.create`, `thread.update`, `poll.create`, `poll.vote`, `poll.end`, `voice.join`, `sound.play`, `call.start`, `call.accept`, `stage.hand`, `stage.start`, `forum.post.create`, `forum.post.update`, `event.create`, `event.update`, `event.interest`, `watch.start`, `watch.control`, `watch.chat`, `invite.create`, and the page changes in [docs channels](#docs-channels). LiveKit joins from them are removed. Reading, DMs, profile changes and settings keep working.
- The owner and bots never need to agree; webhooks don't go through sessions. Agreements are stored per account key and kept if someone leaves and comes back.
- Audit: `rules.update` `{ required, reaccept, version, textChanged }`.

## AutoMod

Server-side rules that stop unwanted messages before they are stored or sent to anyone. Off until an admin turns it on.

```jsonc
AutoMod {
  "enabled": false,
  "words":      { "enabled": false, "blocked": ["bad*", "two words"], "allowed": ["badge"], "action": Action },
  "mentions":   { "enabled": false, "max": 10, "action": Action },             // more than max people/roles in one message
  "flood":      { "enabled": false, "count": 8, "seconds": 10, "action": Action },   // more than count messages within seconds
  "duplicates": { "enabled": false, "count": 3, "seconds": 60, "action": Action },   // the same text more than count times within seconds
  "links":      { "enabled": false, "mode": "invites" | "all", "allowedDomains": ["youtube.com"], "action": Action },
  "joins":      { "enabled": false, "count": 10, "minutes": 10 },     // more than count joins within minutes pauses invites (Join gating)
  "exemptRoles": [roleId], "exemptChannels": [channelId], "alertChannelId": 7 | null
}
Action { "timeoutMs": 0, "alert": false }   // a block always happens; optionally also a timeout and an alert
```

| type | body | result | who |
|---|---|---|---|
| `automod.get` | | `{ automod: AutoMod }` | `manageAutoMod` |
| `automod.update` | `automod: AutoMod` (replaces everything; missing parts take the defaults) | `{ automod: AutoMod }` | `manageAutoMod`; a `timeoutMs` other than 0 also needs `timeoutMembers` |

Limits (`bad_request` beyond them): `blocked` ≤ 500 entries, `allowed` ≤ 100, each 1–50 characters with at least one letter or digit and at most 4 `*` (blank entries are dropped, duplicates merged); `mentions.max` 1–50; `flood.count` 2–50, `flood.seconds` 2–120; `duplicates.count` 1–20, `duplicates.seconds` 5–3600; `allowedDomains` ≤ 50 domains like `example.com` (a scheme, `www.` or `*.` in front is dropped); `exemptRoles` ≤ 100 existing roles; `exemptChannels` ≤ 500 channels you can see (not threads); `alertChannelId` a text channel you can see; `timeoutMs` 0 or a [timeout](#timeouts) length. Deleted roles and channels drop out of the settings.

**Matching.** Text is compared after Unicode compatibility decomposition (fullwidth and styled letters become plain ones), with accents and other combining marks, invisible format characters (zero-width spaces and joiners, …) and case removed. Words are runs of letters and digits. An entry matches whole words: `bad` matches "BÁD!" but not "badge"; `*` stands for any letters within a word (`bad*`, `*bad`, `b*d`) or for any one word in a phrase (`big * cat`); a phrase matches those words in a row, whatever is between them. Three or more single letters in a row are also read as one word ("b a d", "b.a.d"). A match that is exactly an `allowed` entry doesn't count. `mentions` counts distinct `<@accountKey>` and `<@&roleId>` mentions, and `@everyone` and `@here` once each. `links` mode `invites` blocks Discord invites and Iskra invite links; mode `all` blocks every `http(s)://` or `www.` link (and bare invites) unless its host is an allowed domain or under one.

**What is checked:** `chat.send`, `chat.edit`, `chat.forward` (the forwarded text, in the target channel), `poll.create` (question and answers), `thread.create` / `thread.update` (the name), `forum.post.create` (title and first message) / `forum.post.update` (the title), `event.create` / `event.update` (title and description) and `watch.chat`. New messages, polls and forum posts also count towards `flood` and `duplicates` (all channels together, kept in memory: a restart forgets them); edits and names don't. Webhook posts aren't checked. **End-to-end encrypted DMs and groups are never checked**: the server can't read them.

**Who is exempt:** admins and the owner always; members holding an exempt role; anything in an exempt channel (threads and forum posts follow their channel; events have no channel).

**When a rule matches** (the first of words, mentions, links, duplicates, flood): the request answers `error` `automod` with a message for the sender ("Blocked by AutoMod: it contains a word that isn't allowed on this server."), and nothing is stored or broadcast. Then, as the rule's `action` says:

- `timeoutMs`: the sender is [timed out](#timeouts) for that long (unless a longer timeout is already running; the reason is "AutoMod: …"), with `member.updated` as usual, and the message ends with "You're timed out for 5 minutes."
- `alert`: an alert message is posted in `alertChannelId` (if it's still a text channel) and sent as `chat.message` to its readers. Its `author` is `"automod:"` (never an account key), `text` is `""`, and `Message` gains:

  ```jsonc
  "automod": { "rule": "words", "what": "message" | "edit" | "poll" | "post" | "thread" | "event" | "watch",
               "member": "<accountKey>", "memberName": "Sam", "channelId": 1 | null, "channelName": "general" | null,
               "snippet": "you s•••, really" | null, "timeoutMs": 300000 }
  ```

  (`Message.automod` is null on every other message.) `snippet` is the text cut to 120 characters, with blocked words masked to their first letter and `•••`; clients show it hidden until clicked. `channelId`, `channelName` and `snippet` are null unless everyone who can read the alert channel could also read the original channel (by `readRole`). Alerts can't be edited; people who manage messages can delete them.
- Every block is recorded in the [audit log](#audit-log) as `automod.block` (actor `"automod:"`, `actorName` "AutoMod", target the sender, reason the rule) `{ rule, what, channelId, channelName, timeoutMs }`, never with the text. Audit entries and alerts are sent at most once per member and rule every 30 seconds (a timeout is always recorded); requests stay rate limited as usual.
- `automod.update` is recorded as `automod.update` `{ enabled, rules: ["words", ...], blockedWords }`.

## Friends

Friends are mutual: one person sends a request, the other accepts it. There is no account server, so requests and answers are **friend actions** carried inside ordinary end-to-end encrypted DMs (any server both people share can carry them; the server sees only a DM). No new server messages; `dm.send` gains `silent` so quiet actions don't push.

DM content gains `friend`:

```jsonc
{ "text": "<fallback for apps that don't know friends>",
  "friend": { "kind": "request" | "accept" | "cancel" | "decline" | "remove",
              "from": "<accountKey>", "to": "<accountKey>", "at": 1760000000000, "id": "<b64u 12>", "sig": "<b64u 64>" } }
```

- `sig` is Ed25519 by the `from` **account** key over `"iskra/friend/v1" || 0x00 || JSON.stringify([kind, from, to, at, id])`. Receivers check it, that `from`/`to` are the DM's sender and recipient (or earlier keys of the same person, see [account key rotation](#account-key-rotation)), that `at` is at most 10 minutes in the future and `id` ≤ 32 characters. A DM whose `friend` fails any check is shown as unreadable, never as text. So a server, or anyone else, can't forge an accept or replay one person's action into another conversation.
- Each app keeps both sides' actions per person (newest 32, one per sender and `id`) and folds them in `at` order: `request` → pending (two requests that meet make you friends); `accept` answers an open request; `cancel` withdraws your request; `decline` ("Ignore") drops a request on the recipient's side only (the sender still sees it as pending); `remove` ends a friendship (or anything pending) on both sides. Because your own devices get a copy of every DM you send, the friends list follows you to them; device linking also copies it.
- Quiet kinds (`cancel`, `decline`, `remove`) are sent with `silent: true` and never notify or count as unread. `request` and `accept` notify (subject to do not disturb).
- Blocking someone sends the matching quiet action first and ends the relation; actions from people you've blocked are ignored (and `dm.send` between them is `forbidden` anyway, see [Blocking](#blocking)).
- If someone sends a request while you're already friends (they lost their list), your app answers with `accept`.
- Friends lists from before requests existed (kept on one device) become requests, sent once you share a server with that person.

## Leaving a server and signing out

| type | body | result | who |
|---|---|---|---|
| `member.leave` | | | any member except the owner and bots (`forbidden`) |

- Removes your membership (roles, nickname and the like go with it, as with a kick), sends `member.removed { accountKey }` to everyone, and closes all your sessions on this server right after the answer (close code 4403, "You left this server."). Coming back needs a new invite. Messages you wrote stay.
- Apps use it when you sign out of a device and choose to leave your servers too. Signing out itself is local: the app deletes its keys, history and settings from the device (in the desktop app the stored keys are only readable through the OS keychain, and the wrapped key is deleted with the rest). Other devices of the account are not affected; they keep working, and so does the recovery key.


## Reports, deleting an account and handing over a server

### Reports

Anyone can report a message or a person to the server's **moderators**: members who can delete others' messages, time out, kick or ban (`manageMessages`, `timeoutMembers`, `kickMembers` or `banMembers`; admins and the owner always). Moderators handle reports with the usual tools (`chat.delete`, `member.timeout`, `member.kick`, `member.ban`) and then resolve them.

```jsonc
Report { "id": 4, "at": 1760000000000, "kind": "message" | "member" | "dm",
         "reason": "spam" | "harassment" | "hate" | "sexual" | "violence" | "self_harm" | "illegal" | "other",
         "note": "Keeps doing this" | null, "status": "open" | "resolved",
         "reporter": "<accountKey>" | null, "reporterName": "Sam",   // null / "" once the reporter deleted their account
         "target": "<accountKey>", "targetName": "Troll",            // the author of a reported message
         "message": { "id", "channelId", "channelName", "text", "attachments": [File], "createdAt", "deleted": false } | null,  // kind message
         "messages": [{ "author": "<accountKey>", "text": "…", "at": 1760000000000 }] | null,                                   // kind dm
         "resolution": { "by", "byName", "at", "outcome": "dismissed" | "deleted" | "timeout" | "kick" | "ban" | "other", "note" } | null }
```

| type | body | result | who |
|---|---|---|---|
| `report.create` | `reason`, `note?` (≤ 500 chars, newlines allowed) and either `messageId` or `accountKey` (+ `messages?`, 1–20 `{ author, text (1–2000), at }`) | `{ id, already }` | anyone; a message you can read and didn't write, or a member who isn't you |
| `report.list` | `status?` (`open`, default, or `resolved`), `before?` (report id), `limit?` (1–50, default 50) | `{ reports: [Report], hasMore }` (newest first) | moderators |
| `report.resolve` | `id`, `outcome`, `note?` (≤ 200) | `{ report }` | moderators who can see it; an already resolved report is `conflict` |
| `report.count` | | `{ open }` (open reports you can see; 0 for everyone else) | anyone |

- **A copy of the message** is kept with a message report (text and attachments as they were when reported), so editing or deleting the message doesn't hide it; `deleted` tells whether the original is still there. Attached files are kept while the report exists.
- **Who sees a report:** moderators, except the reported person (a report about a moderator is hidden from that moderator). A message report also needs the moderator to be able to read its channel (a deleted channel: admins only). The reporter is shown to moderators but never to the reported person; nothing about a report is sent to them.
- **Encrypted conversations:** the server can't read DMs or groups, so a report about a person may carry `messages`: decrypted messages the reporter chose to share, each written by the reporter or the reported person. The server can't check them, and apps say so to moderators. Apps send this only to a server both people are on, after the reporter saw exactly what will be sent.
- Reporting the same message or person again while your earlier report is open answers `{ id, already: true }`. Limits: 5 reports at once, then one every 2 minutes per account (`rate_limited`); at most 20 open reports per reporter and 2000 open per server. Resolved reports are deleted after 90 days.
- Event `report.count` `{ open }` goes to every online moderator (each their own count) when a report is made or resolved. Apps show it as a badge.
- **Audit:** `report.resolve` (actor the moderator, target the reported person, reason the note) `{ reportId, kind, reason, outcome }`. The reporter is never recorded.

### Deleting an account

There is no central account server, so an account is deleted server by server, with a statement signed by the account key, so nobody else can delete it:

```jsonc
AccountDeletion { "accountKey": "<b64u 32>", "deletedAt": 1760000000000, "messages": false, "sig": "<b64u 64>" }
```
`sig = Ed25519.sign(accountSecret, "iskra/account-delete/v1" || 0x00 || accountKey(32) || u64be(deletedAt) || u8(messages ? 1 : 0))`

| type | body | result | who |
|---|---|---|---|
| `account.delete` | `deletion` (an `AccountDeletion` for your own account; `deletedAt` at most 10 minutes in the future) | | any member except the owner and bots (`forbidden`) |
| `owner.transfer` | `accountKey` (a member who isn't a bot) | | the owner; they become an admin and the member the owner |

**What the server deletes**, in one transaction: membership, roles, nickname, profile, avatar and profile page, presence, synced settings and notification settings, block list, timeouts, rules agreement, event interest, devices, revocations, prekeys and push subscriptions, the account's end-to-end encrypted DMs (sent and received) and group messages, encrypted DM files, and its invites stop working. Names are removed from the audit log, and from reports the account made. With `messages: true` its channel messages, reactions and poll votes go too; otherwise its messages stay, without a name. Bans and reports about the account stay. Group membership is a signed chain, so apps leave their groups (signed `leave` changes) before deleting.

**Afterwards** the server keeps the deletion, so the key can't come back: a handshake with it fails with `account_deleted` (close 4401, even with an invite), and the error body carries `deletion`. The account's sessions get `account.deleted` `{ deletion }` and close (4403); everyone else gets `member.removed` `{ accountKey }` and `member.deleted` `{ accountKey, messages }` (apps drop the person's messages from view when `messages` is true). Voice and calls with the account end.

**Other devices** learn of it when they next connect anywhere it was applied. A device checks the signature against its own account key (so a server can't make it wipe itself), sends the same `account.delete` to its other servers the deleting device couldn't reach, then deletes its keys and data. Messages already on other people's devices (DMs, groups) stay there.

**Owners** can't delete their account on a server they own: they hand it over with `owner.transfer` first, or shut the server down. Audit: `owner.transfer` (target the new owner) `{ from }` (their level before).


## Security log, retention and your data

### Security log

Moderation and admin actions are in the audit log (`audit.list`). The **security log** keeps what the audit log doesn't, for the owner only:

```jsonc
SecurityEvent { "id": 12, "at": 1760000000000, "event": "auth.failed", "account": "<accountKey>" | null, "accountName": "Sam" | null,
                "ip": "203.0.113.7" | null, "details": { ... } | null }
```

| event | account | details |
|---|---|---|
| `auth.failed` | the key, if its signature checked out (else null) | `{ reason }`: the handshake's error code (`auth_failed`, `invite_required`, `banned`, `device_revoked`, `account_deleted`, `account_rotated`, …) |
| `rate_limited` | who | `{ type }` (the request type). At most one entry per connection per minute |
| `member.joined` | who | `{ role, bot }` (never the invite code) |
| `device.new` | who | `{ deviceKey }`: an existing member signed in from a device this server hasn't seen |
| `device.revoke` | who | `{ deviceKey }` |
| `account.rotate`, `account.rotate.disputed` | the new key / the holder | `{ devices }` / none |
| `account.dispute.resolve` | the key that kept the account | `{ kept: "current" \| "contest" }` |
| `keylog.alert` | who reported it | `{ kind, seq, head }`: a member's app found a problem with this server's [key log](#key-transparency) |
| `keylog.reloaded`, `keylog.broken` | none | `{ from, to }`: the key log in the database changed underneath the server (a restored backup, an edit) / `{ seq }`: an entry whose hash doesn't link up |
| `account.delete` | who | `{ messages }` |
| `backup.download`, `backup.settings`, `backup.cli`, `backup.restored` | the owner / none | `{ size }`, `{ from, to }`, none, `{ backupMadeAt, uploads }` |
| `server.move`, `server.move.cancel` | the owner / none | `{ url, cli? }`, `{ cli? }` |
| `retention.update` | the owner | `{ from, to }` (Retention below) |
| `data.export` | whose data | `{ by }` when the owner exported someone else's |
| `security.log.export` | the owner | |
| `owner.claim.created` | none | `{ expiresAt, renewed }`: a server image made its [claim code](#owner-claim-rented-servers) (never the code itself) |
| `captions.model.download`, `captions.model.rejected` | none | `{ model, bytes }`: the server fetched the [captions model](#live-captions-model) / `{ model, file, reason: "hash" }`: what upstream sent wasn't the pinned file, so nothing was kept |
| `translate.model.download`, `translate.model.rejected` | none | The same for a [translation model](#translation-models) (`model` is its `dir`) |
| `translate.settings` | the owner | `{ offer }`: translation models offered to members, or not |

- Never in it: message text, invite codes, passphrases, secrets of any kind.
- **IP addresses** are recorded only if the owner turns on `securityLogIps` (off by default). Without it `ip` is null.
- A burst of the same event from the same address (or account) is capped at 10 entries a minute; the next entry after a burst has `details.suppressedBefore` (how many were left out).
- Entries follow an account through key rotation like everything else. Deleting an account clears `ip` on its entries and keeps the rest (`account.delete` included) for the security log's retention.

| type | body | result | who |
|---|---|---|---|
| `security.log.list` | `event?` (≤ 40), `account?` (≤ 64), `before?` (entry id), `limit?` (1–500, default 100), `export?` (true on the first page of an export: adds `security.log.export`) | `{ entries: [SecurityEvent], hasMore }` (newest first) | the owner |

### Retention

`server.json` → `Retention`, also in Settings → Security log. 0 days keeps forever.

```jsonc
Retention { "messagesDays": 0, "uploadsDays": 0, "auditDays": 90, "securityLogDays": 365, "securityLogIps": false }
```

| type | body | result | who |
|---|---|---|---|
| `retention.get` | | `Retention` | the owner |
| `retention.update` | any of `messagesDays`, `uploadsDays`, `auditDays`, `securityLogDays` (0–36500), `securityLogIps` (bool) | `Retention` | the owner; written to server.json, applies from the next sweep |

A sweep runs at start and every hour:
- `messagesDays`: channel messages older than that are deleted (with their reactions, pins, polls and search entries; a forum post whose first message goes is deleted too), and so are end-to-end encrypted DM and group envelopes. Readers get `chat.deleted` for each message (`thread.deleted` for forum posts) when a sweep deletes 200 or fewer; after a bigger sweep apps see the change when they load history.
- `uploadsDays`: files uploaded before then that only messages or DMs use are deleted (messages keep their text; the attachment is gone). Avatars, emoji, stickers, sounds, event covers, webhook avatars, files shown on profile pages, files in running watch parties and in open reports stay.
- `auditDays`: audit entries; `securityLogDays`: security entries. The unused-upload sweep (a day) and daily backups (`Backups.Keep`) are unchanged.

### Download my data

| type | body | result | who |
|---|---|---|---|
| `data.export` | `accountKey?` (default: you) | `{ url: "/export/<token>", name, size, expiresAt }` | anyone for themselves; the owner for any member or former member this server knows (`not_found` otherwise), to answer a request made to them directly |

- `GET /export/<token>` (relative to the server's URL) returns `iskra-data-YYYY-MM-DD.zip` (`Content-Disposition: attachment`, `no-store`, `nosniff`, a sandbox CSP) for 10 minutes; then the link is gone and the file deleted. Exports are written to `exports/` in the world folder, which backups leave out; leftovers are deleted when the server starts.
- The zip has `README.txt` and `data.json` (`format: "iskra-data-export/v1"`): the account and its earlier keys (after key rotation), the server, and one list of rows per section: `membership`, `nickname`, `customRoles`, `profile`, `profilePage`, `presence`, `syncedSettings`, `notificationSettings`, `rulesAccepted`, `devices`, `removedDevices`, `pushSubscriptions` (no endpoints or keys), `blockList`, `keyRotations`, `accountDeletion`, `messages`, `reactions`, `pollVotes`, `eventInterest`, `uploads` (metadata), `directMessages` and `groupMessagesSent` (who, whom, when: no envelopes), `groups`, `invitesCreated` (no codes), `timeouts`, `bans`, `reportsMade`, `reportsAboutYou` (without the reporter or their note), `auditLog`, `securityLog`. `exportedBy` names the owner when it isn't you.
- Rate limit: two, then one every 10 minutes per connection; one export is made at a time on a server (`rate_limited` while another runs).
- The content of end-to-end encrypted DMs and groups is only on members' devices; apps export it from the device itself (Settings → Privacy & data → Download data on this device).

### HTTP hardening

Every HTTP response gets `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and (except profile pages, which the app frames) `X-Frame-Options: DENY` and a CSP with `frame-ancestors 'none'` (`default-src 'none'` when the handler set none). HTTPS responses for a domain name (not an IP address or localhost) get `Strict-Transport-Security: max-age=31536000`. HTTPS accepts TLS 1.2 and 1.3 only. LiveKit's own API listens on 127.0.0.1 only; clients reach voice through `/livekit` on the server's port.

## Server updates and health

The standalone server can check GitHub releases for new versions, tell the owner, and (on Linux under systemd) install them itself. A server run by the desktop app updates together with the app and never checks. Settings live in `server.json` → `Updates` (`Mode`: `off` | `notify` (default) | `auto`; `Channel`: `stable` | `prerelease`; `Window`: `HH:mm`, local time; `VerifyAttestation`: bool, default `true`. Older versions wrote `RequireAttestation: false` into every server.json; it's no longer read, so those servers verify too, and `VerifyAttestation: false` is the owner's explicit choice).

```jsonc
UpdateStatus {
  "current": "2.0.0-alpha.10",          // "0.0.0-dev" for development builds (they never check)
  "mode": "off" | "notify" | "auto", "channel": "stable" | "prerelease", "window": "04:00", "requireAttestation": true,   // server.json VerifyAttestation
  "managed": "desktop" | null,          // "desktop": updates with the desktop app; mode is "off" and can't change
  "canCheck": true,
  "auto": { "possible": false, "reason": "desktop" | "development" | "platform" | "guard" | "readonly" | null },
  "latest": { "version": "2.0.0-alpha.11", "url": "https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.11",
              "publishedAt": 1760000000000, "prerelease": false, "package": true } | null,   // newest newer release on the channel
  "state": "idle" | "checking" | "downloading" | "verifying" | "installing" | "restarting" | "failed",
  "progress": { "done": 1048576, "total": 66350346 } | null,   // while downloading (bytes)
  "checkedAt": 1760000000000 | null, "error": "Couldn't reach GitHub to check for updates." | null,
  "errorCode": "rate_limited" | "unreachable" | "download" | "install" | "sums" | "size" | "checksum" | "github_checksum"
             | "package" | "wont_run" | "attestation_missing" | "attestation_invalid" | "attestation_unknown" | null,   // apps show their own text for it
  "lastUpdate": { "from": "2.0.0-alpha.10", "to": "2.0.0-alpha.11", "ok": true } | null,  // ok false: it didn't start and was undone
  "attested": true | false | null       // the package being installed: true verified, false missing or not verifying, null GitHub not asked
}
```

| type | body | result | who |
|---|---|---|---|
| `update.status` | | `{ status: UpdateStatus }` | owner |
| `update.check` | | `{ status }` (after asking GitHub; a check within 30 s of the last one reuses it) | owner; limit 3, then one every 20 s |
| `update.settings` | `mode?`, `channel?`, `window?` (`HH:mm`, exactly 5 chars), `requireAttestation?` | `{ status }` | owner; `bad_request` for unknown values, for any change on a desktop-hosted server, and for `auto` when `auto.possible` is false |
| `update.install` | | `{ status }` (installing has started) | owner; `bad_request` when it can't install here or there's nothing newer (or no package for this system), `conflict` while an install runs |

- **Events:** `update.status` `{ status }` goes to the owner's sessions whenever it changes (check results, download progress about every 2%, failures). `server.restarting` `{ reason: "update", version }` goes to every session about 5 seconds before the server restarts into a new version; apps tell members, then reconnect as after any restart ([Restarts and reconnecting](#restarts-and-reconnecting); the close reason says `update` with a downtime hint).
- **Checks:** unauthenticated GitHub API (`GET /repos/quikmn/iskra-voice/releases`, `If-None-Match` with the last ETag), 2 minutes after start and then every 6 hours (not when `Mode` is `off`, except "Check now"). On a rate-limit answer the next check waits until GitHub's reset time. Drafts and tags that aren't `v<version>` are ignored. "stable" means releases GitHub doesn't mark as prerelease (alphas are published as normal releases).
- **Packages:** `iskra-server-<v>-linux-x64.tar.gz`, `-osx-arm64.tar.gz`, `-osx-x64.tar.gz`, `-win-x64.zip`. Downloads only from `https://github.com/quikmn/iskra-voice/releases/download/`, HTTPS only (redirects to GitHub's storage), at most 512 MB.
- **Verification before anything is replaced:** the package's SHA-256 must match its line in the release's `SHA256SUMS.txt` and GitHub's own `digest` for the file (when the API gives one), and its size must match. Then the build-provenance attestations come from `GET /repos/quikmn/iskra-voice/attestations/sha256:<hash>` (at most 4 MB, 20 bundles) and are verified on the server, offline, against Sigstore's public-good trusted root compiled into it (`Updates/sigstore-trusted-root.json`, refreshed for each release): certificate chain to Fulcio, SCT, transparency log entry, DSSE signature (the `Sigstore` NuGet library); a certificate from `https://token.actions.githubusercontent.com` for repository id `1227290412` on a GitHub-hosted runner whose SAN is exactly `https://github.com/quikmn/iskra-voice/.github/workflows/release.yml@refs/tags/v<version>` or `.../release-finalize.yml@refs/heads/main`; and an in-toto statement (`https://slsa.dev/provenance/v1`) whose subjects include the package's file name with its SHA-256. With `VerifyAttestation` (the default) an install fails without one: `attestation_missing` (none, e.g. an old release; install by hand), `attestation_invalid` (none verifies), `attestation_unknown` (GitHub couldn't be asked; auto mode tries again in a later window). Off, the result is still shown (`attested`). The archive may only hold plain files at its top level with plain names (no folders, links, `..` or absolute paths) and must contain `iskra-server`. The unpacked `iskra-server version` must print the new version (so a package that can't run on this machine is never swapped in).
- **Automatic install** (`Mode: "auto"`): only when `auto.possible`: Linux x64, a release build, not desktop-hosted, the folder iskra-server runs from is writable, and `iskra-update-guard` ran just before this start (systemd `ExecStartPre`). It starts in the hour after `Window` when nobody is in a voice channel; a version that failed or was undone isn't retried automatically (except after `attestation_unknown`).
- **Security log** (see "Security log" above): `update.check` (the owner, `{ latest }`), `update.settings` (the owner, `{ from, to }`), `update.install` (the owner `{ from, to }`, or no account with `{ from, to, auto: true }`), and with no account: `update.failed` `{ version, code }`, `update.installed` `{ from, to }` (confirmed), `update.rolledback` `{ from, to }`.
- **Swap and rollback:** files are renamed into place inside the server's folder; the replaced ones go to `.update/previous/`. The server writes `.update/pending` and exits with code 75 (systemd's `Restart=on-failure` starts the new version). The new version confirms itself after running for 60 s. If it fails to start three times before that, `iskra-update-guard` puts the previous files back (`.update/rolled-back`), and the owner sees `lastUpdate.ok: false`.

### Health

`GET /health` → `200 { "iskra": 1, "status": "ok", "version": "2.0.0-alpha.10", "uptimeSeconds": 8123, "voice": "up" | "down" | "off" }`. No names, addresses, member counts or settings. For uptime monitors; `GET /` (`{ iskra: 1, name }`) stays as before.

## Saved messages, reminders, scheduled messages and the inbox

### Saved messages

No new server messages: apps keep the list as a [synced preference](#synced-preferences) named `saved`, sealed like any other, so servers can't see what you saved (DMs included), only the size of the sealed list. The sealed JSON is compact: `{ "v": 1, "keys": [<server, account and group keys>], "items": [[ref, savedAt, removedAt, snap?]] }`, where `ref` is `["c", serverIdx, channelId, messageId]`, `["d", peerIdx, fromIdx, headerId]` or `["g", groupIdx, fromIdx, headerId]` (group = `"<serverKey>/<groupId>"`) and `snap` is `[authorIdx, authorName, preview, sentAt, where]` (a shortened preview, dropped from the oldest entries if needed to stay under the preference size limit). At most 150 saved messages.

- Lists merge entry by entry (the newest save or removal per message wins), so saving on two devices at once loses nothing; apps write the merged list back wherever it differs. A removal is kept 30 days so other devices learn of it, then forgotten.
- Channel messages are opened by id (`chat.history` with `around`); a deleted one shows as gone. DM and group messages open from the device's own history.

### Reminders

```jsonc
Reminder { "id": 4, "dueAt": 1760000000000, "data": "<b64u>", "channelId": 1 | null, "messageId": 42 | null,
           "createdAt": 1760000000000, "firedAt": 1760000000000 | null }
```

| type | body | result | who |
|---|---|---|---|
| `reminder.create` | `dueAt` (now − 1 min … now + 366 days), `data` (sealed, ≤ 2048 chars), `messageId?` (a channel or thread message you can read) | `{ reminder }` | anyone; ≤ 100 reminders per account here; 1/s, burst 10 |
| `reminder.list` | | `{ reminders }` (yours, by time) | anyone |
| `reminder.update` | `id, dueAt, data?` | `{ reminder }` (pending again: a snooze or a new time) | the owner (`not_found` for anyone else) |
| `reminder.delete` | `id` | | the owner (done, or cancelled) |

- `data` is opaque to the server: apps seal `{ ref, snap, note }` (which message, a snapshot of it, a note ≤ 500 chars) with XChaCha20-Poly1305 under `crypto_kdf_derive_from_key(32, 2, "iskrapri", accountSeed)`, with `"iskra/private/v1" || 0x00 || "reminder"` as associated data, as `nonce(24) || ciphertext`. For DMs and groups the server knows only the time; for a channel message it also keeps `messageId`, so the push can say where.
- At `dueAt` (checked every second) the server sets `firedAt`, sends `reminder.due { reminder }` to every session of the account and pushes `{ kind: "reminder", reminder: <id>, title: "Reminder", body }` to its devices (not merged with other pushes; the body quotes the message only if it's a channel message the member can still read). A click opens `/#/open/<serverKey>/r/<id>`: the app opens the sealed data and jumps to the message. Fired reminders stay listed until deleted (30 days at most).
- Events `reminder.updated { reminder }` and `reminder.deleted { id }` go to the account's other sessions. A reminder whose owner left the server is dropped when it's due.
- Apps keep a DM reminder on a server they share with the person (any connected server otherwise), and a group reminder on the group's server.

### Scheduled messages

```jsonc
Scheduled { "id": 7, "kind": "channel" | "dm" | "group", "channelId": 1 | null, "accountKey": "<peer>" | null, "groupId": "<id>" | null,
            "version": 3 | null, "text": "…" | null, "replyTo": 41 | null, "envelope": {...} | null,
            "sendAt": 1760000000000, "createdAt": 1760000000000, "status": "pending" | "sending" | "failed", "error": "…" | null }
```

| type | body | result | who |
|---|---|---|---|
| `scheduled.create` | `sendAt` and one of: `channelId, text (1–4000), replyTo?` · `accountKey, envelope (≤ 32 KB)` · `groupId, version (current), envelope (≤ 56 KB)` | `{ scheduled }` | members, not bots; channel: you can write there now; ≤ 50 per account here; 1/s, burst 10 |
| `scheduled.list` | | `{ scheduled }` (yours, by time) | anyone |
| `scheduled.update` | `id, sendAt?, text?` (channel) or `envelope?` (+ `version` for groups) | `{ scheduled }` (a failed one becomes pending again) | the owner; `conflict` while it's being sent |
| `scheduled.delete` | `id` | | the owner |
| `scheduled.send` | `id` | the send's result (`{ message }`) | the owner: sends it now (a failed one too); a refusal is `bad_request` with the reason, and it stays failed |

- `sendAt`: from now − 1 min to now + 90 days for channel messages; encrypted ones at most 30 days after they were encrypted (prekeys are kept at least that long, see [forward secrecy](#forward-secrecy-envelope-v2)).
- **Sending** happens at `sendAt` (checked every second) exactly as if the author sent it then: the server runs `chat.send`, `dm.send` or `group.send` for the author, through the same gates (timeouts, [rules](#server-rules), a moved server) and checks (permissions, [slowmode](#slowmode), [AutoMod](#automod), blocking, the group's current version). Every send uses the nonce `scheduled-<id>` ([Reliable sends](#reliable-sends)): a message is marked as being sent before it goes out, a restart puts what was mid-send back to pending, and the repeat finds the message already stored, so it never posts twice (DMs and groups included). Each author's sends go out at `chat.send`'s pace (2/s, burst 10, per account, shared with `scheduled.send`): more due at the same moment stay pending and follow over the next seconds; `scheduled.send` beyond that is `rate_limited`. Sent: `scheduled.deleted { id, sent: true }` to the author's sessions. Refused: status `failed` with `error`, `scheduled.updated { scheduled }` to the author's sessions, and a push `{ kind: "scheduled", title: "Your scheduled message wasn't sent", body: <reason> }`. An author who left is dropped silently.
- **End-to-end encryption:** the server can't encrypt for you, so apps encrypt DMs and group messages when they're scheduled, with the send time as the envelope's `sentAt`, and the server stores only the envelope. The trade-offs: devices the recipients add before it's sent can't read it; a group that changed in the meantime refuses it (`conflict`, so it fails; apps encrypt it again for the current members on "Send now"); and it's limited to 30 days ahead. Changing the time or the text means encrypting again. In exchange it goes out while all your apps are closed, and the server never sees the text.
- Events `scheduled.updated { scheduled }` and `scheduled.deleted { id, sent }` go to the author's other sessions. No attachments yet.

### Inbox

| type | body | result | who |
|---|---|---|---|
| `inbox.list` | `before?` (a message id), `limit?` (1–50, default 30) | `{ items: [{ kind, channelId, at, message }], hasMore, next }` (newest first) | anyone |

- When a message is sent, the server records who it pings, by the same rules as [push](#push-notifications-web-push): `mention` (`<@key>`), `reply` (to your message), `role` (a role you have, if it's mentionable or the author may ping groups), `everyone` (`@everyone`, or `@here` for members online then, from people allowed to ping groups) and `keyword` (an alert word the member stored here, see [Keyword alerts and quiet hours](#keyword-alerts-and-quiet-hours)). One item per person and message (the strongest kind), never for the author, bots or two people where one blocked the other, and only for members who can read the channel. Each gets `inbox.new { item }`.
- `inbox.list` leaves out messages you can't read any more (or whose author you blocked); deleting a message removes its items. Items are kept 60 days, at most 500 per account.
- Read or unread isn't stored on the server: apps take it from their own read state, and after reconnecting count items newer than the last one they had seen as unread mentions. The app's inbox also lists unread DMs and groups, friend requests and reminders that are due.

### Edit history

| type | body | result | who |
|---|---|---|---|
| `chat.edits` | `id` | `{ versions: [{ text, at }] }` (earlier versions, oldest first; `at` is when that text was written) | the author, or members who can manage messages; `not_found` if you can't read the channel |

- `chat.edit` keeps the text it replaces (at most 20 earlier versions per message; the oldest go first). Deleting a message deletes its history, and so does deleting the account that wrote it. DMs and groups can't be edited, so there is no history for them.
## Voice channel chat and clips

### Text chat in voice and stage channels

Every `voice` and `stage` channel has its own text chat. It is an ordinary channel conversation: `chat.send`, `chat.edit`, `chat.delete`, `chat.history`, `chat.typing`, `chat.react`, `chat.pin`, `search`, replies, attachments, mentions, AutoMod, slowmode (`channel.update` `slowmode` works on voice and stage channels), rules and timeouts all work as in a text channel, with the voice channel's id as `channelId`.

- **Who:** readers of the channel read it (`view`); posting (`chat.send`, `chat.typing`, pinning) needs `view` and `send`, from the channel's write level and role overrides, as in text channels. Speaking is the separate `speak` permission, so a role can be allowed to talk but not type, or the other way round. Not a reader: `not_found`.
- Polls, threads, webhooks and forwarding stay text-channel only (`bad_request`).
- Unread and mention counts work as for text channels (apps count them on the voice channel's row).

### Clips

A clip is the last few seconds (15–120) of what someone hears in a call, recorded **on their own device** from a rolling buffer. Nothing is recorded by the server or uploaded unless the person shares the file afterwards. The protocol only carries the consent side:

| type | body | result | who |
|---|---|---|---|
| `voice.state` | adds `clips?` (bool): clips are turned on. Left out: unchanged | | anyone in voice |
| `voice.clip` | `channelId` (the voice or stage channel you're in) | `{ message }` | someone LiveKit reports in that channel who has `clips: true` (not in it: `forbidden`; clips off or not a voice channel: `bad_request`); 3 at once, then one per 10 s (`rate_limited`) |

- `voice.state` events list `clips` (bool) for every participant, so everyone in the call (and everyone who can see the channel) can see who has clips on. Joining starts with `clips: false`; apps send it again after joining.
- `voice.clip` posts a **clip notice** to the channel's chat: a message by the person who saved the clip, with empty `text` and `clip: {}` (`clip` is null on other messages). It's sent to readers as `chat.message`. Clip notices can't be edited (`bad_request`), and the person who saved the clip can't delete it (`forbidden`); moderators with `manageMessages` who outrank them can.
- **DM and group calls** have no channel: apps announce clips over the LiveKit room's data channel instead, on topic `iskra.clips`, as JSON `{ "v": 1, "clips": bool }` (sent on joining, on every change, and to each person who joins) and `{ "v": 1, "saved": true }` when a clip is saved. Apps show the same "clips on" mark and a "saved a clip" line in the call. This is a courtesy between honest apps: nothing can stop a modified app from recording what it receives, in any call.
- Apps only offer clips to people who turned them on (off by default), and save a clip only while the notice can be shown (in a channel: after `voice.clip` succeeds).
## Passkeys and key transparency

### Passkeys for the app lock

Local only; nothing goes over the wire. A passkey can open the [app lock](#keys-on-the-device) instead of (or next to) the passphrase. Its **PRF** output (WebAuthn `prf` extension, CTAP2 `hmac-secret`) is the secret, so the passkey actually protects the stored keys rather than gating a screen; the WebAuthn signatures aren't checked, since nothing is proven to a server.

- Each passkey gets a slot in the vault record: `{ id (credential id), name (≤ 64), salt (32 random bytes), box, rpId, created, lastUsed? }`, at most 10.
- `kek = HKDF-SHA256(ikm = PRF(salt), salt = salt, info = "iskra/passkey-kek/v1")` (WebCrypto), 32 bytes. `box = wrap(nonce(24) || crypto_secretbox(dataKey, nonce, kek))`, where `wrap` is the device wrap (OS keychain or the browser's non-extractable key), so a copy of the storage needs both the device and the passkey.
- With only passkeys (no passphrase) the plain wrapped data key is removed (`data = ""`). Removing the last passkey without a passphrase puts the data key back under the device wrap. Adding, removing or changing a lock method first asks for the current passphrase, or (without one) one of the passkeys.
- Creating: `navigator.credentials.create` with `userVerification: "required"`, `residentKey: "preferred"`, `excludeCredentials` (this device's passkeys), a random per-device user handle and `extensions.prf.eval.first = salt`. If the authenticator reports PRF but didn't evaluate it while creating, the app asks once more with `get`. No PRF: the passkey isn't used (the app says so; the passphrase stays available).
- Unlocking: `navigator.credentials.get` with `allowCredentials` = this device's passkeys and `prf.evalByCredential` = each one's salt.
- Relying party: the page's host in a browser; `app.iskra.foo` in the desktop app and the phone app. The desktop app's page is on `app://iskra`, where Chromium refuses WebAuthn, so its main process runs the ceremony in a small window on `https://app.iskra.foo/passkey`, served from memory in an in-memory session that answers nothing else (`desktop/src/passkeys.ts`; requests are checked JSON). The iOS app has `webcredentials:app.iskra.foo` (entitlement + `apple-app-site-association`), the Android app `delegate_permission/common.get_login_creds` in `assetlinks.json`.

### Key transparency

A server can't forge a signature, but it decides which key it shows as which person. Key transparency makes it hard to show different people different keys without being caught: each server keeps an append-only, hash-chained, signed **key log**, and clients check it, compare servers, and compare notes with each other.

```jsonc
KeyLogHead  { "seq": 12, "hash": "<b64u 32>", "at": 1760000000000, "sig": "<b64u 64>" }
KeyLogEntry { "seq": 12, "data": "<JSON text, exactly as hashed>", "name": "Viktor" | null, "nameSalt": "<b64u 16>" | null }
// data is one of:
{ "kind": "join",    "at": 1760000000000, "key": "<accountKey>", "name": "", "nameHash": "<b64u 32>" }   // a key first shown here
{ "kind": "name",    "at": ..., "key": "<accountKey>", "name": "", "nameHash": "<b64u 32>" }              // its name changed
{ "kind": "rotate",  "at": ..., "rotation": Rotation }                                  // applied (Account key rotation)
{ "kind": "contest", "at": ..., "rotation": Rotation }                                  // a second claim: disputed
{ "kind": "resolve", "at": ..., "rotation": Rotation, "previousKey": "<accountKey>" }   // an admin settled it (rotation = the winner)
```

- **Names are committed, not logged.** `nameHash = SHA-256("iskra/keylog-name/v1" || 0x00 || salt(16) || utf8(name))` with a fresh random salt per entry; `data.name` is `""` (older apps read the field). The entry's `name` and `nameSalt` (outside `data`, not hashed) open it: clients check `nameHash` and treat a mismatch as `bad-entry`. When an account is deleted the server erases them for its entries (and the keys it rotated away from), so they come back `null` and apps show "someone (account since deleted)"; the entry, its key and every hash stay, so the log still checks out. Entries written before commitments carry the name in `data` itself (no `nameHash`) and can't be erased without breaking the chain.
- `hash(seq) = SHA-256("iskra/keylog-entry/v1" || 0x00 || hash(seq-1) || u64be(seq) || utf8(data))`, with `hash(0)` = 32 zero bytes. Clients hash the `data` string exactly as received.
- `sig = Ed25519.sign(serverSecret, "iskra/keylog-head/v1" || 0x00 || serverKey(32) || u64be(seq) || hash(seq) || u64be(at))`, with the server key clients pinned when joining. An empty log has `seq: 0`, zero hash, `at: 0`.
- The server brings the log up to date from its members and rotations before it hands out a head (welcome, the requests below) and right after it applies a rotation, contest or resolution, so every key it shows, and every account move, is in the log. Entries never change: account moves rewrite account keys everywhere else, not here (only the names beside them are erased, on account deletion).

| type | body | result | who |
|---|---|---|---|
| `keylog.head` | | `{ head: KeyLogHead }` | anyone |
| `keylog.entries` | `after?` (seq, ≥ 0, default 0), `limit?` (1–100, default 100) | `{ entries: [KeyLogEntry] (oldest first), head: KeyLogHead }` | anyone |
| `keylog.alert` | `kind` (`fork`, `rollback`, `bad-log`, `unlogged-key`, `unlogged-rotation`, `gossip-fork`), `seq?` | | anyone: an app found that about this server's log. Recorded in the owner's [security log](#security-log) as `keylog.alert`, nothing else |

`welcome` gains `keyLog: KeyLogHead` (absent on older servers).

**What clients check** (`client/src/core/keylog.ts`, `state/kt.ts`):

1. **Continuity.** Each device stores the newest verified head per server and its recent hashes. A new head must be signed, never older (`rollback`), the same hash at the same position (`fork`), and reachable from the stored head through the entries (`fork`, `gap`); rotations inside entries must carry valid signatures (`bad-entry`).
2. **The server's own word.** Every member a server shows must be in its log (a `join`, or the new key of a `rotate`/`resolve`); every rotation it announces must be in its log. The client reads the log once more before reporting, in case someone just joined.
3. **Across servers.** Logs from different servers that move the same old key to different new keys are reported (`split`).
4. **Gossip.** A DM to a friend carries, at most every 12 hours per friend (or when a head moved), a signed digest in its content: `kt: { v: 1, from, to, at, heads: [{ server, ...KeyLogHead }] (≤ 16, servers both use), rotations: [Rotation] (≤ 16, people on those servers and the sender), devices: [deviceKey] (≤ 20, the sender's own), sig }`, `sig = Ed25519.sign(fromAccountSecret, "iskra/kt-gossip/v1" || 0x00 || JSON.stringify([from, to, at, heads as [server, seq, hash, at, sig], rotations as [oldKey, newKey, rotatedAt, oldSig, newSig], devices]))`. The receiver checks it like a friend action (signed by the sender, from/to are the DM's, not more than 10 minutes in the future, at most 7 days old) and then: a friend's head at a position it has, with a different hash, is proof the server signed two histories (`gossip-fork`); a head ahead of its own is remembered and checked once its log gets there; a rotation that moves an old key somewhere other than where it follows it is reported (`gossip-conflict`); a device a server lists for the friend that the friend doesn't list (and is over an hour older than the digest) is reported (`device-unknown`). Older apps ignore `kt`.
5. **Lookalikes.** Someone on a server using a friend's name with a different key, while the friend isn't on that server, is shown as a gentle warning.

Findings are shown in Settings → App lock → Key transparency, as a banner above the chat for serious ones, and in the DM with the person concerned. The log can be read entry by entry in the app (an auditor's view), checked from the first entry.

**Limits.** This is detection, not prevention: a server can still show a fake key to someone who has no friend in common to compare with and never compares safety numbers, and it can refuse to answer. Only the first server a person meets someone on vouches for the first key (trust on first use). There's no global log or third-party auditors; gossip only covers servers two friends share. See [security.md](../docs/security.md#key-transparency) for the comparison with CONIKS, Keybase and WhatsApp.

## Docs channels

A docs channel (`channel.create` with `kind: "docs"`) is a small wiki: **pages** with a title and Markdown text (the message syntax, plus tables, `![alt](/files/<id>/<name>)` pictures from this server's uploads, and `---` rules; apps show no pictures from anywhere else). Pages can have **sub-pages**, one level deep. Reading follows the channel's read access; creating, editing, moving and restoring follow its write access. Without a `writeRole`, a docs channel is created with `writeRole: "trusted"` (or the read role, if that is higher): everyone reads, trusted members and above edit. `chat.send` and the other message requests don't work in a docs channel (`bad_request`).

```jsonc
DocPage { "id": 12, "channelId": 7, "parentId": null | 3, "title": "Start here", "position": 0,
          "version": 4,                       // goes up by one on every save
          "createdBy": "<accountKey>", "createdAt": 1760000000000,
          "updatedBy": "<accountKey>", "updatedAt": 1760000000000,
          "size": 1834,                       // text, in UTF-8 bytes
          "text": "# Welcome …" }             // only in docs.page.get / create / save / restore results
Revision { "version": 3, "title": "…", "author": "<accountKey>", "createdAt": 1760000000000, "restoredFrom": null | 1, "size": 1200 }
Home { "pageId": 12, "channelId": 7, "title": "Start here" }   // or null
```

| type | body | result | who |
|---|---|---|---|
| `docs.pages` | `channelId` | `{ pages: [DocPage without text], home: pageId \| null }` (`home` only when you can read that page) | readers |
| `docs.page.get` | `id`, `version?` | `{ page }` with text; with `version`: `{ page (without text), revision: Revision + text }` | readers |
| `docs.page.create` | `channelId, title` (1–100 chars, one line), `parentId?` (a top-level page in this channel), `text?` or `file?` | `{ page }` | writers; ≤ 500 pages per channel |
| `docs.page.save` | `id, baseVersion`, `title?`, `text?` or `file?` (at least one) | `{ page }` | writers |
| `docs.page.move` | `id, parentId?` (null: top level), `before?` (a page at the same level; null: last) | `{ page }` | writers; a page with sub-pages stays at the top level |
| `docs.page.delete` | `id` | | whoever made the page (if they can write there), or a writer who can [pin](#pins) there (trusted+ or `manageMessages`). Its sub-pages go too, so a page holding sub-pages someone else made needs a writer who can pin there (`forbidden` otherwise) |
| `docs.page.history` | `id` | `{ page, revisions: [Revision] }` (newest first) | readers |
| `docs.page.restore` | `id, version, baseVersion` | `{ page }` | writers |
| `docs.home.get` | | `{ home }` | anyone |
| `docs.home.set` | `pageId?` (null clears) | `{ home }` | `manageChannels` |
| `docs.search` | `query` (as for [search](#pins-search-and-threads)), `channelId?`, `limit?` (1–25, default 10) | `{ results: [{ page, snippet, matches: [[start, length]] }] }` (best first; titles weigh more) | readers of each channel searched |

- **Text:** at most **100 KB** of UTF-8. Line endings become `\n`; control characters (other than newline and tab) and invisible formatting characters (bidi overrides, zero-width spaces; not the zero-width joiner) are removed rather than refused, since pasted text often has some; trailing whitespace is trimmed. Text may be empty. A long page doesn't fit in a socket frame (64 KB), so apps upload it as a file (`upload.begin`, `PUT`) and pass `file`: the id of your own upload, UTF-8 text (`bad_request` otherwise). Uploads used this way are swept like any unused upload.
- **Versions (optimistic concurrency):** every save names `baseVersion`, the version it started from. If the page has moved on, nothing is saved and the answer is `conflict`; apps then fetch the current page and offer to compare and merge (they kept the text they started from). Saving the same title and text again answers the page as it is, without a new version.
- **Revisions:** every save keeps the new title and text as a revision. A save by the same person within 10 minutes of their previous one replaces that revision (so a burst of saves is one entry; the first revision of a page is always kept). At most 50 revisions per page; the oldest go first. Restoring saves an old revision's title and text as a new version (`restoredFrom` tells which). Revisions go when their page does.
- **Pictures:** pages show this server's uploads by URL (`/files/<id>/…`); uploads named in any saved version of a page are kept by the upload sweeper while the page exists.
- **Start here:** one page per server, shown at the top of everyone's channel list (when they can read its channel). Event `docs.home` `{ home }` goes to every session, each with its own view, when it's set, cleared, renamed or deleted.
- **Events** to the channel's readers: `docs.page.updated` `{ page }` (without text) after a create, save, restore or move (a move sends one per page whose position changed), and `docs.page.deleted` `{ channelId, ids }`.
- **Search:** SQLite FTS5 over titles and text (accents ignored, prefix matches), only in docs channels the requester can read right now. `snippet` is a piece of the page with the matches at `matches` (UTF-16 offsets).
- **Safety:** AutoMod checks the title and text of every create, save and restore (`automod` with `what: "page"` in the audit entry); timed-out members get `forbidden`, and members who must still agree to the [rules](#server-rules) get `rules_required` for `docs.page.create`, `docs.page.save`, `docs.page.move`, `docs.page.delete` and `docs.page.restore`. Rate limits: `docs.page.create` 0.2/s (burst 5), `docs.page.save` 1/s (burst 10), `docs.page.restore` 0.2/s (burst 5), `docs.page.move` 1/s (burst 10), `docs.search` 2/s (burst 10). A page keeps an upload on the server (past the unused-upload sweep) only if it's the saver's own upload or one docs pages already keep, and only while a kept revision still links to it.
- **Audit:** `docs.page.create`, `docs.page.delete`, `docs.page.restore` `{ channelId, channelName, pageId, title, extra: { version } | null }` and `docs.home.set` (the same, or `{ pageId: null }` when cleared). Page text is never recorded.
- **Your data:** `data.export` includes `docsPages` (pages you made or last edited) and `docsRevisions` (every kept version you wrote, with its text). **Retention:** with `messagesDays` set, revisions older than that go in the hourly sweep, except each page's current version; pages stay. **Deleting an account** keeps its pages and revisions under its key (like its messages); with `messages: true` its revisions go, except a page's current version, which keeps its text with `author` `""`, and `createdBy`/`updatedBy` become `""` (apps show "someone who left").
- **Links:** apps link to a page with `#/open/<serverKey>/c/<channelId>/p/<pageId>` (like message links), which opens the page in the app.

## End-to-end encrypted channels

A text, voice or whiteboard channel can be made **end-to-end encrypted** when it is created (never later, and never undone). It is
meant for small private channels: at most **50** people (not bots) may be able to read it. The server stores only
ciphertext and delivers it only to people who can read the channel; members' apps hold the keys. It reuses the
[group DM](#group-dms-and-group-calls-end-to-end-encrypted) pieces: a signed membership chain, DM envelopes v2 for
handing out keys, encrypted attachments, and LiveKit end-to-end encryption for voice.

`Channel` gains `e2ee: { chain, version } | null`. `Message` gains `e2ee: { version, envelope } | null`; in encrypted
channels `text` is always `""` and `attachments` empty (files travel encrypted inside the envelope).

### The membership chain

The same signed change format as a group's (`payload` + `sig`, `head = b64u(SHA-256(payload))`, `prev`, the full `members`
after each change), with its own context **`iskra/channel-change/v1`**, `group` = the chain id (16 random bytes, made by
the creator), up to 50 members, `payload` ≤ 8192 characters, and these actions:

- `create`: version 1, `members = [by, ...targets]`.
- `add`: by a member; `targets` (≥ 1) not in the chain; `members = old + targets`.
- `remove`: by a member; `targets` (≥ 1) in the chain, not `by`; `members = old − targets` (order kept).
- `rekey`: by a member; no targets; same members.

Clients verify every change (signature, `prev`, version, member list, `by` a member) and never take a member list from
the server. The **server** also checks that changes follow the channel's read permission ([roles and overrides](#roles-and-permissions)):
`add` only people (not bots) who can read the channel now, `remove` only people who can't (or left the server). A `create`
must list exactly the people who can read the channel (creator first), else `conflict`. If nobody left in the chain can
read the channel, someone who can may start a new chain (a `create` with a new id); the old history stays unreadable to them.

### Starting over

No new messages or fields; this is what apps do around the `create` that starts a chain over.

- **Who starts it:** an app whose account can read the channel but isn't in the chain, when `echan.get` shows that nobody in the chain can read it any more (every member is in `want.remove`, the app's own account is in `want.add`, and `full` is false). The first such reader who is online goes (the others wait a few seconds longer each, then find it done); the `create` lists exactly `want.add`. The server still refuses it (`bad_request`) while anyone in the chain can read.
- **Following it:** an app whose account isn't in its verified chain (it was removed, or never in it) takes the new chain at once, verified from its `create`. It keeps the old chain and its epoch keys to decrypt messages whose envelope `header.chain` names it.
- **Inside the chain: never automatic.** An app whose account is still in its verified chain never replaces it on the server's word (the server only restarts a chain when nobody in it can read, so from inside, a new chain is indistinguishable from a server-made one). It keeps the old chain and keys, refuses to send, and, if the new chain verifies from its `create`, offers it: the person sees everyone who signed one of its changes (each change signs `prev`, so the whole chain before it) and whether each key was in their old chain, is a friend's or DM contact's, or is new; a new key carrying the name of someone from the old chain is pointed out. **Start over** is an explicit action; it needs the person's own account in the new chain and no high-severity key-transparency finding about a signer, and a safety-number confirmation when no signer is a key they knew (or a lookalike is listed). Then the app keeps the old chain for old messages, records the start-over with the channel ("You started encryption over on …"), never accepts a chain it left again, and signs a `rekey` in the new chain.
- Not required: a signature on the new chain from someone in the old one. A legitimate restart is usually made by someone who was never in the old chain (nobody in it could read the channel), and a forger would leave old members out; the key checks above are what tell the two apart.

### Epoch keys

Every change starts an **epoch** (its version) with a new random 32-byte key, made by whoever made the change and sent with
it. It is wrapped for every valid, unrevoked device of every member of the new member list (the author's own included) in
**key envelopes**: [envelope v2](#forward-secrecy-envelope-v2) with

```jsonc
{ "v": 2, "kind": "channel-key",
  "header": { "from": "<accountKey>", "chain": "<chain id>", "version": 3, "head": "<head of version 3>", "sentAt": 1760000000000, "id": "<b64u 12>" },
  "sender": DeviceCert, "nonce": "…", "ct": "…", "keys": [ /* slots as in v2, ≤ 150 per envelope */ ] }
```

- Associated data: `JSON.stringify(["iskra/channel-key/v1", from, chain, version, head, sentAt, id])`; content `{ "text": "", "group": { "kind": "channel-key", "key": "<b64u 32>" } }`.
- Receivers accept a key only for a version they verified (with that `head`), only from the member who made that change, with a valid device certificate of theirs.
- More than 150 devices: several envelopes (the first with the change, the rest with `echan.keys.add`).
- Keys of different epochs are independent: someone removed at version n never receives the key of n or later, and nobody can derive one epoch's key from another's.

### Messages

```jsonc
{ "v": 2, "kind": "channel",
  "header": { "from": "<accountKey>", "chain": "<chain id>", "version": 3, "sentAt": 1760000000000, "id": "<b64u 12>",
              "channel": 12, "thread"?: 34, "edit"?: "<id of the message's first envelope, ≤ 32 chars>" },
  "sender": DeviceCert, "nonce": "<b64u 24>", "ct": "<b64u>", "sig": "<b64u 64>" }
```

- `channel` is the encrypted channel's id (a thread's parent), `thread` the thread's id when the message is in one (left out otherwise), `edit` (on `chat.edit` only) the `id` of the message's first envelope.
- `ad = JSON.stringify(["iskra/channel-msg/v2", from, chain, version, head, sentAt, id, channel, thread ?? 0, edit ?? ""])` (`head` of that version, from the verified chain); `ct = XChaCha20-Poly1305(epochKey, nonce, content, ad)`.
- `sig = Ed25519.sign(deviceSecret, "iskra/channel-msg/v2" || 0x00 || u64be(len(ad)) || ad || u64be(24) || nonce || ct)`: every member holds the epoch key, so the device signature is what proves who wrote it.
- Content: `{ "text": "…" (≤ 4000), "files"?: [DmFile], "tts"?: true }` ([encrypted attachments](#encrypted-dm-attachments); a voice note is a file with `voice`; `tts`: sent with [/tts](#text-to-speech-tts)).
- Receivers check: the header's `from` and `version` equal the message's `author` and `e2ee.version`; `channel` and `thread` equal where the message arrived (its `channelId`: the channel itself, or a thread of it); the version is in their verified chain and `from` was a member then; the certificate and signature; then decrypt. A message from before this device had a key shows as unreadable, never as text. A message moved to another channel or thread (or between a parent and its threads) is shown as moved, never as text.
- **The server** checks a v2 envelope's `channel` and `thread` against the send (`bad_request`), like `from`, `chain` and `version`; it reads nothing else.
- **What apps remember.** Each app keeps, per message, the envelope ids it showed (first envelope and edits) and the newest one's `sentAt`. It refuses an envelope whose `id` (or, for v2, whose `edit` or first `id`) belongs to another message (a replay or a moved edit), and an envelope older than the newest it showed for that message (an original after an edit, an edit older than one it showed, by `sentAt`): an edit can't be rolled back on a device that saw it. Copies kept elsewhere (pins, a thread's first message) may lag behind an edit and aren't refused for that.
- **The older format (v1)**, sent before this version: no `channel`, `thread` or `edit`; `ad = JSON.stringify(["iskra/channel-msg/v1", from, chain, version, head, sentAt, id])` and the signature under `iskra/channel-msg/v1`. Apps still open v1 messages and mark them "older format" (a server could have moved them between a channel and its threads), and only send v2. The two contexts differ, so a v2 message can't be passed off as v1 (or back). Test vectors for both (and for v3, [Disappearing messages](#disappearing-messages)): `channel` in [vectors.json](vectors.json).

#### Messages from people who were removed

Someone removed at version n keeps the epoch keys of the versions before n and their device key, so they can still sign a message "at version n − 1", and a server could slip it in. Nothing about the message itself can tell it apart from one they really sent then, so apps judge it by time:

- **When they lost access** comes from the verified chain: the `at` of the first later change whose `members` leave them out. That `at` is signed by the member who made the change, and the server refuses changes more than 10 minutes off its clock, so neither the removed person nor the server can move it. For a chain kept after a [start-over](#starting-over), its end is also bounded by when this device saw it replaced.
- **When the message claims it was sent:** its signed `sentAt` (the sender's clock) and the server's `createdAt`. The server only takes messages for the current version, so an honest message at version n − 1 was stored before change n, at most 10 minutes past its `at`.
- If either time is more than **10 minutes** after they lost access, the app shows the message with a warning ("sent after its writer lost access … may not really be from them") and never notifies for it. Being added back later doesn't help: new messages go to the new epoch, so an old epoch's message after the removal still gets the warning.
- **Limits:** a removed member and the server working together can still backdate a message into the time the member was in (both clocks then lie in step). Neither can make it look sent after anyone else's removal, nor into another channel or thread. A sender whose clock runs more than 10 minutes fast may see a message sent just before their removal flagged.

### Requests and events

| type | body | result | who |
|---|---|---|---|
| `channel.create` | adds `e2ee?: { change, keys: [KeyEnvelope] }` (`kind` text, voice or whiteboard; a `create` change by you; ≥ 1 key envelope for version 1) | | `manageChannels`, and you must be able to read it; > 50 readers: `bad_request`; the readers changed meanwhile: `conflict` |
| `echan.get` | `channelId, since?` | `{ e2ee: { chain, version, head, members }, changes: [GroupChange + version] (after since), want: { add, remove, full } }` | channel readers |
| `echan.change` | `channelId, change, keys` (1–64 key envelopes for the new version, ≤ 52 KB each) | `{ e2ee }` | readers who are in the chain (not bots), by the rules above; `conflict` if it changed meanwhile; shares the 10-a-minute `group.change` limit |
| `echan.keys.add` | `channelId, version` (the current one), `keys` | | whoever made that change; ≤ 64 envelopes per version |
| `echan.keys` | `channelId, since?` (version, default 1) | `{ keys: [{ version, from, envelope }], hasMore }` (≤ 200; only envelopes with a slot for **this session's device**) | channel readers |
| `chat.send` | in an encrypted channel (or a thread of one): `channelId, version` (the current one, else `conflict`), `envelope` (≤ 32 KB), `files?` (≤ 10 encrypted uploads), `replyTo?`, `nonce?`; no `text`, `attachments`, `sticker`, `gif`, `voice` | `{ message, nonce }` | writers who are in the chain (`forbidden` otherwise) |
| `chat.edit` | in an encrypted channel: `id, version, envelope` | `{ message }` | the author |
| `dm.upload.begin` | adds `channelId` (an encrypted channel whose chain you're in): the file's access list is the chain's members now | | |

| event | body | sent to |
|---|---|---|
| `echan.changed` | `{ channelId, e2ee, change }` | the channel's readers |
| `echan.keys` | `{ channelId, version }` (more key envelopes arrived) | the channel's readers |

- `want` is what the server's permissions say: readers missing from the chain (`add`, at most enough to reach 50; `full` if more are waiting) and chain members who can't read it any more (`remove`). Apps of chain members fix it on `channels`, `member.*` and `roles` events and on connect: the first chain member who is online acts at once, the others a few seconds later (and find nothing left to do). Removals come first.
- `channel.update` and `channel.overrides.set` are refused (`bad_request`) if more than 50 people could then read an encrypted channel. New members joining and role changes never are: the extra people wait (`full`).
- A device that has no key for the current version (one linked later, say) makes a `rekey` after a few seconds. When you remove one of your devices, one of your other devices makes a `rekey` in each encrypted channel you're in.

### How other features behave

- **Not available** (refused with `bad_request`, so no plaintext ever reaches the server): webhooks, polls, scheduled messages, forwarding to or from the channel, clips, AutoMod alerts posted there, stickers and GIFs. Bots never count as readers and can't send there (they hold no keys). Docs, forum and stage channels can't be encrypted; whiteboard channels can (see [Whiteboards](#encrypted-boards)).
- **Threads** work, encrypted under the parent channel's chain and epoch keys; their name is always `"thread"` (`thread.update` is refused).
- **Reactions, pins, replies, deletes and read state** work as usual; they are metadata the server sees (which emoji on which message, which message is pinned or replied to).
- **Search:** the server leaves encrypted channels out; apps search the messages they decrypted, on the device.
- **AutoMod and link previews** don't apply: the server can't read the text, and apps never ask for previews of encrypted messages.
- **Push:** `"New message in #channel"` / `"Open Iskra to read it."`, never content. Replies still push; mentions can't (the server can't see them): apps notify for mentions once they decrypt a message that arrives while they're open.
- **Reports:** a message report may carry `messages: [{ author, text, at }]`: the reported message's decrypted text, shared by the reporter. Moderators are told it can't be checked.
- **Edit history** isn't kept for encrypted messages.
- **Voice:** the LiveKit key is `crypto_kdf_derive_from_key(32, 1, "iskra-vc", epochKey)` in key slot `version mod 16`; on a new epoch everyone in the room switches (frames under the previous key still decrypt during the switch). See [Encrypted voice channels](#encrypted-voice-channels).
- **Your data:** `data.export` lists `encryptedChannelMessages` (channel, time, version, envelope size) and `encryptedChannels` (the changes you signed), never content. Retention and message deletion delete the envelopes with the messages.
- **New members** read from the epoch they were added in. Older history isn't shared with them (as in Signal); this version has no way to hand it over.

## Hi-fi voice channels

`Channel` gains `hifi` (bool; always false for text, forum, stage and docs channels). `channel.create` and `channel.update` take `hifi?` (true or false, anything else is `bad_request`), voice channels only: on any other kind it's `bad_request`. Only admins change it (as with every channel setting); an update that leaves it out keeps it.

- In a hi-fi channel, members who turned hi-fi on in their audio settings publish their microphone in stereo at 128 kbps (LiveKit's `musicHighQualityStereo`) with RED, without DTX, and with no echo cancellation, noise suppression or automatic gain. Everyone else, and every other channel, sends voice as usual. DM and group calls are never hi-fi.
- It's a setting clients honour, not something the server can enforce: LiveKit forwards whatever a client publishes within its own limits. The server stores and broadcasts it (`channels` event, `welcome.channels`, the `channel` in each answer).
- Turning it off while people are in the channel makes their clients publish the usual way again.
- Audit: `channel.create` details gain `hifi`; `channel.update` changes gain `hifi: { from, to }`.
- Storage: `voice_hifi(channel_id)` (migration `hifi-1`), dropped with the channel.

Voice resilience (no protocol change, for reference): clients publish the mic with Opus in-band FEC (`useinbandfec=1`, which livekit-client always sets), RED (`audio/red`, redundant audio: each packet also carries the previous ones) and DTX. LiveKit's default codec list, which `livekit.yaml` leaves as is, includes `audio/red`, so rooms negotiate it for every subscriber that supports it and fall back to plain Opus for the rest.

## Live captions model

Live captions run on members' devices (Whisper base, [docs/voice-processing.md](../docs/voice-processing.md)); the
speech model comes from the group's own server, so members' devices never contact anyone else for it, and only
members get it: the app asks for a short-lived link over its session, then downloads over plain HTTP on the server's port.

- **Pins.** `client/src/state/captions/model.json` (compiled into the app and the server): the model `dir`
  (`whisper-base-1846881b`: name and Hugging Face commit), the upstream `source`, and for each file (`encoder.q8.onnx`
  23.2 MB, `decoder.q8.onnx` 53.7 MB, `vocab.json` 1.0 MB) its SHA-256, size and parts (at most 20 MiB each), each
  with its own SHA-256 and size.
- **`captions.model.link`** (request, any member, empty body; limit 10, then one a second) → `{ offered: false }` when the
  owner turned it off, else `{ offered: true, path: "/models/<dir>", query: "a=<accountKey>&exp=<ms>&sig=<b64u>", expires }`.
  `sig` = HMAC-SHA-256 with a random per-process key over `"iskra/captions-model-link/v1\0<dir>\0<accountKey>\0<exp>"`;
  valid for an hour (links stop working on restart; the app asks again for each download).
- **`GET /models/<dir>/<part>?<query>`**, where `part` is `<file>.part<n>.bin`. Anything else (another `dir`, another name,
  encoded slashes, `..`) is `404`, as is everything when the owner turned it off (`Captions.ModelDownload: false` in
  server.json). Without a valid link (missing, wrong signature, expired, another `dir`, or for an account that is no
  longer a member) the answer is `403` and nothing is fetched. The first linked request makes the server fetch the whole model once from `source` (HTTPS, at most the
  pinned size per file, redirects only to HTTPS); concurrent requests wait for that same download. Each file and each
  part must match its SHA-256 before anything is written (atomically, to `models/<dir>/` in the world folder);
  otherwise nothing is kept, the answer is `502`, and a later request tries again. Then `200`,
  `application/octet-stream`, `Cache-Control: private, max-age=31536000, immutable`, byte ranges allowed.
- **`HEAD`** on the same path (with a link): `200` when the server offers the model (without fetching anything), `404` when not.
- `Access-Control-Allow-Origin: *` (the apps' pages are `app://`, `capacitor://` and the web app's own origin; the
  link in the address is the only credential, no cookies), with an `OPTIONS` preflight answer.
- **Limits.** 30 requests at once per client address, then one every 5 seconds (`429`); the whole model is 6 parts.
- **Apps.** They ask for the link when captions start, and download only after the person agreed to the one-time download, check every part's size and SHA-256
  against their own copy of the pins (a mismatch is refused, never used or kept), and keep the parts on the device
  under a key that doesn't depend on the server or the link, so the model is downloaded once per device.
- Security log: `captions.model.download` / `captions.model.rejected` ([Security log](#security-log)).
- `Captions.ModelSource` (server.json, optional): a folder laid out like `scripts/get-models.mjs` writes it, used
  instead of `source` (development and tests; the same checks apply).

## Owner claim (rented servers)

"Rent a small server" sets up a server on a VPS from the app (docs/hosting.md). The app makes a one-time owner claim
`C` (32 random bytes) and puts it in the server's setup as `server.json` `"OwnerClaim": "<C, base64url>"`.

- On start, a server with no owner moves `C` out of server.json into `owner-claim` in its folder (owner-only, like
  `server.key`) and makes the single-use owner invite with code `base64url(HMAC-SHA-256(C, "iskra-owner-invite-v1")[0..16])`.
  A server that already has an owner drops the field. Neither `C` nor the code is ever logged; the owner link is not
  printed (`owner-invite.txt` is still written, for the terminal route).
- `GET /.well-known/iskra-claim?nonce=<16–64 base64url chars>`, while a claim is pending:
  `{ "iskra": 1, "key": "<server public key>", "proof": base64url(HMAC-SHA-256(C, "iskra-owner-proof-v1\n" + key + "\n" + nonce)) }`
  (`Access-Control-Allow-Origin: *`, `Cache-Control: no-store`). `404` once there's an owner or no claim, `400` for a bad nonce.
- The app checks `proof` with its own `C` and a fresh nonce before trusting `key` (no trust on first use), then joins
  with the invite `(https://<server>, key, code)`, the usual owner invite. Joining as owner deletes `owner-claim`.
- The endpoint is limited per client address (IPv6: per /64): a burst of 30 requests, then one every 2 seconds; past
  that `429` with `Retry-After`.

**Generated claim codes (server images).** A server made from an image (the DigitalOcean Marketplace droplet) has no
app to make `C`, so its `server.json` says `"OwnerClaim": "generate"` and the server makes a claim code itself, for
whoever can open the machine's console (proof of owning the cloud account):

- The code is 16 characters from Crockford's base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (80 random bits),
  shown as `XXXX-XXXX-XXXX-XXXX`. Typed codes are normalized: upper case, spaces and `-` removed, `O` → `0`, `I`/`L` → `1`;
  anything else that isn't 16 alphabet characters is not a code.
- `C = SHA-256("iskra-claim-code-v1
" + normalized code)`. From there everything is as above: `owner-claim`, the proof
  endpoint, and the owner invite derived from `C`. The app derives `C` from the typed code; the code itself never goes
  over the network.
- The server writes `owner-claim` as `C` and, on the next line, when it expires (ms), and `owner-claim-code.txt`
  (`code=…`, `expires=<UTC ISO time>`, `address=<public URL>`; owner-only like `server.key`) for the console screen.
  The owner invite expires with it.
- **Single use, 24 hours.** Joining as owner deletes both files and sets `OwnerClaim` back to null. After 24 hours the
  endpoint answers `404` and the invite no longer works; the setting stays `"generate"`, so the next start of the
  server makes a fresh code (revoking any other unused owner invite). A start within the 24 hours keeps the code. A
  server that already has an owner drops the setting and makes nothing.
- The security log records `owner.claim.created` (`{ expiresAt, renewed }`), never the code. Guessing is pointless:
  80 bits online (each guess is a full signed handshake, logged as `auth.failed`), and offline against a proof
  (`HMAC-SHA-256` keyed by `C`) within the code's 24 hours is far out of reach too.

## Profile sync

Your profile (name, bio, pronouns, accent, avatar, page) follows your account across your devices, and a device that
hasn't caught up can't put an old one back on a server.

**Stamps.** Every edit is stamped `updatedAt` (ms) and `by` (the device key of the device that made it, ≤ 64 chars).
Stamps are ordered by `updatedAt`, then by `by` (byte order), so two devices editing in the same millisecond agree on
the winner: last writer wins, deterministically, for the whole profile. A device stamps a new edit
`max(now, newest stamp it knows + 1)` (just `now` if the known one is more than a day ahead of its clock), so an edit
made after catching up wins even when this device's clock is behind.

**On servers.** `auth.profile`, `profile.update`, `profile.page.set` and `profile.page.remove` (your own) may carry
`updatedAt` (1 … 2^53) and `by`. Each server remembers the newest stamp it accepted per member and:

- applies a profile whose stamp is the same or newer, and remembers that stamp;
- ignores an older one: `auth` still succeeds, but the name and profile fields stay as they are and nothing is
  broadcast; the requests answer `{ member, stale: true }` (`{ stale: true }` for `profile.page.remove`) without
  changing anything;
- treats a missing or malformed stamp as the oldest: it applies only while no stamped profile has arrived (bots and
  older apps work as before);
- ignores a stamp more than a day ahead of its own clock, so a device with a wrong clock can't freeze the profile.

The stamp goes with the membership (leaving, kick, ban or account deletion forget it). Since requests come over an
authenticated session of the account, the stamp needs no signature of its own; it only decides which of the account's
own edits is newer.

| type | body | result | who |
|---|---|---|---|
| `profile.page.get` | | `{ html, hash }` (`not_found` if you have none) | anyone, own page only; 1 per 5 s, burst 5 |

**Between devices.** The account's copy is a [synced preference](#synced-preferences) named `profile`, sealed like
the others (so servers can't read it):
`{ "v": 1, "updatedAt", "by", "name", "bio"?, "pronouns"?, "accent"?, "avatar"?: { "hash", "type" } | null, "page"?: { "hash" } | null }`
(a field left out was never set, `null` means removed; the prefs `updatedAt` is the stamp's). Apps:

- after each edit, update every connected server first (the avatar and page are uploaded before the copy changes),
  then write the copy everywhere;
- on `welcome` and on `prefs.updated { name: "profile" }`, read the copy. If it's newer than theirs they take it,
  fetching a changed avatar from `/files/` and a changed page with `profile.page.get` on a server whose `you` shows
  that hash, and checking the bytes against the hash. Then they bring every server they're on up to date (servers
  that were offline at the edit get it here or on their next `auth`) and write the copy to the servers that had an
  older one. If theirs is newer, they write theirs;
- until the bytes can be fetched, they keep their own (older) profile; servers ignore it, so nothing goes back.

A newly linked device gets the profile and its stamp in the link payload ([Device linking carries the
profile](#device-linking-carries-the-profile), which gains `updatedAt` and `by`); a device restored from the recovery
key starts unstamped and without a name: it leaves `name` out of `auth` (see the handshake), takes the account's copy
on its first `welcome`, or else the name in `welcome.you`, and asks the person only when it gets `name_required`.

Limits: ordering trusts the devices' clocks, bounded by the rules above; an edit made on a device that hasn't seen a
newer one (offline) loses to it if its clock is earlier. Fields aren't merged: the newest edit wins as a whole (fields
it never set are kept). A server only knows the stamps it has seen, so a server that missed every edit applies the
first stamped profile that arrives, which is the newest the connecting device knows.

## Restarts and reconnecting

When the server stops it closes every session with a JSON reason of at most 123 bytes:

```jsonc
{ "v": 1, "reason": "stop" | "restart" | "update", "etaMs": 20000 }   // etaMs only when the server can estimate it (0–600000)
```

- **1012 ("Service Restart")**, reason `update` or `restart`, only when the server knows it's coming back: an
  automatic update (`etaMs` 20000), or the desktop app restarting: for a relaunch it writes the line `restart` to the
  server's stdin before closing it (`ISKRA_STOP_ON_STDIN_CLOSE`; `etaMs` 30000); for an update it writes the restart
  marker below (`update`, `etaSeconds` 60) and closes stdin without that line, so the marker's reason is kept (the line
  again if the marker can't be written); or a stop (SIGTERM,
  `systemctl restart`) within 2 minutes of `iskra-server expect-restart <world> [--reason update|restart] [--eta <s>]`
  (the reason and `etaMs` it was given; see below).
- **1001 ("Going Away")**, reason `stop`, for every other stop: Ctrl+C, SIGTERM (including `systemctl restart`, which
  the server can't tell apart without the marker), the desktop host quitting or stopping the server, or the app that
  started it going away.

**The restart marker.** `expect-restart` writes `<world>/restart-expected` atomically:
`{"v":1,"reason":"update"|"restart","etaSeconds"?:0–600,"at":<unix ms>}` (at most 1 KB). The server reads it once as
it stops and deletes it; it's ignored when it's older than 2 minutes or malformed (anything but these fields and
values), and a server that starts deletes any marker it finds. Only the enum and the number reach the close reason.
A restart the server already knows about (its own update) keeps its own reason.

Even 1012 is a hint: the server may not come back. Unknown `reason` values and fields are ignored; a 1012 whose
reason isn't this JSON still counts as a restart, and a 1001 without it (older servers) as an ordinary drop. A server
that crashes or loses the network sends neither (the socket just drops, 1006).

What apps do (the TS client and the bot SDK share it, `client/src/core/connection.ts`):

- **On 1012:** status `restarting` (not `offline`; with `update: true` when the reason is `update`, so apps say "restarting for an update"), and reconnect about every second (0.75–1.25 s, jittered so a crowd
  doesn't arrive at once) for 2 minutes, or `etaMs` plus a minute when that's longer. After that, the usual backoff.
  Failed attempts during that window keep the fast pace.
- **On 1001 `stop`:** status `offline` with `stopped: true` (apps say "<server> went offline"), kept until it's back,
  with the usual backoff.
- **Any other drop:** status `offline` with exponential backoff, 0.5 s doubling to 30 s, ±30% jitter.
- **After every reconnect** (`welcome`), whatever the cause: messages missed in loaded channels are fetched with
  `chat.history` `after` (and count as unread), sends cut off by the drop go again with their nonce ([Reliable sends](#reliable-sends)),
  stages and watch parties are rebuilt from `welcome`, and someone who was in a voice or stage channel joins it again
  with `voice.join` and reports the same `voice.state` flags. They don't rejoin when LiveKit removed them
  (moved, kicked, the channel deleted), when the channel is gone or they can no longer connect to it, or when they
  left meanwhile. On 1012 or 1001 `stop` apps leave the LiveKit room straight away (LiveKit stops with the server),
  so the rejoin is a fresh one. Camera and screen share are never turned back on by themselves. DM and group calls live in the
  server's memory and end with a restart; they aren't rejoined.

## Bot commands and cards

Bots can tell the server which `/commands` they understand, so apps can suggest them as people type, and can attach
cards to their messages. A command is still sent as an ordinary message (`/roll 2d6`, see [Bot accounts](#bot-accounts));
the registry only describes it.

### Command registry

| type | body | result | who |
|---|---|---|---|
| `bot.commands.set` | `commands: [Command]` (replaces the bot's whole list; `[]` clears it) | `{ commands }` (as stored) | bots only (`forbidden` for people) |
| `bot.commands.available` | `channelId` | `{ bots: [accountKey] }` | channel readers |

```jsonc
Command { "name": "roll", "description": "Rolls dice", "usage"?: "2d6+1",
          "options"?: [{ "name": "dice", "description": "Like 2d6", "type": "string", "required"?: true,
                         "choices"?: [{ "name": "Twenty-sided", "value": "d20" }] }] }
```

| field | rules |
|---|---|
| `commands` | ≤ 50; names unique; the stored list (JSON) ≤ 16 KB |
| `name` (command and option) | 1–32 characters of `a–z`, `0–9`, `_`, `-`, starting with a letter or digit |
| `description` | 1–100 characters, one line, no invisible control characters |
| `usage` | optional, ≤ 100 characters, one line: a hint shown after the name (`2d6+1`) |
| `options` | ≤ 25 per command, names unique; `type` is `string`, `integer`, `number`, `boolean`, `user`, `channel` or `role`; required ones come first |
| `choices` | ≤ 25, only for `string`, `integer` and `number`; `name` 1–100; `value` matches the type (string 1–100, a safe integer, a finite number) |

- Rate limit: 5, then one every 5 s.
- `welcome.botCommands: [{ bot: accountKey, commands }]` lists every bot member with a non-empty list. Event
  `bot.commands { bot, commands }` goes to everyone when a bot changes its list.
- `bot.commands.available` answers which of those bots can read **and** post in the channel (threads follow their
  parent), so apps suggest only commands that someone will answer. In [encrypted channels](#end-to-end-encrypted-channels) only bots that take [interactions](#bot-interactions) and can read the channel
  (bots aren't in the chain; see there). Channels the caller can't read are `not_found`.
- A bot's list is deleted when it stops being a member (kicked, banned, removed); apps drop it on `member.removed`.
  A bot registers again each time it starts.

### Cards

`chat.send` from a bot may carry `cards: [Card]`; `text` may then be empty. `chat.edit` of a bot's own message may
carry `cards` too (it replaces them; `[]` removes them; with cards `text` may be empty). People get `forbidden`.
Cards use the [webhook embed](#webhooks) format, validator and limits (≤ 10 per message, ≤ 6000 characters in total,
`title` 256, `description` 4096, `url` http(s), `color` 0–16777215, `timestamp` ISO 8601 → ms, `author`, `footer.text`
2048, ≤ 25 `fields`), plus pictures:

| field | rules |
|---|---|
| `thumbnail`, `image` | `{ "url": ... }`: either this server's own file (`/files/<id>/...`, an image the bot uploaded itself, not SVG), or a `data:image/png\|jpeg\|gif\|webp;base64,...` URL of ≤ 16 KB. Anything else (remote addresses) is `bad_request`: viewers never load third-party content. |

Messages carry `cards: [Card] | null` (`null` for everything except a bot's message with cards). Stored cards keep
only the fields above; a picture from `/files` is returned as that file's URL path, which apps resolve against the
server's address. Card text is rendered as text and markdown by apps, never as HTML.

## Connecting without port forwarding (peer to peer, experimental)

Many home connections share one internet address between customers (carrier-grade NAT), so friends can't reach a
server at home and no port can be forwarded. The owner may let friends connect through a peer-to-peer tunnel instead:
the host's Iskra desktop app (or a standalone server's `iskra-p2p` sidecar) announces a key on the public [HyperDHT](https://github.com/holepunchto/hyperdht) network
and friends' desktop apps find it there, hole-punch a UDP path and carry the server's protocol inside a
Noise-encrypted stream (UDX). Nothing of Iskra's sits on the path. Off by default; an explicit opt-in by the owner.

```jsonc
"P2p": {
  "Enabled": false,
  "TunnelPort": 0,       // the tunnel listener on 127.0.0.1 (0 = any free port; the bound port is written to p2p.port)
  "SidecarPath": null,   // standalone server: the iskra-p2p program (null = next to iskra-server, or ISKRA_P2P_SIDECAR)
  "Bootstrap": null,     // DHT bootstrap nodes "host:port,host:port" (null = HyperDHT's public ones)
  "DhtPort": 0           // the DHT's UDP port (0 = 49737; any port on a LocalOnly server)
}
```

- `p2p.key` in the world folder holds the **p2p secret** (32 random bytes, b64u, owner-only), created when the
  owner turns the feature on and replaced by `p2p.rotate`. Everything else is derived from it, with keyed BLAKE2b and
  a context string per key: the host's DHT key pair from seed `BLAKE2b-256(key = secret, message = "iskra/p2p/v1/host-seed")`
  and the friend key pair from `"iskra/p2p/v1/friend-seed"` (both Ed25519 from the 32-byte seed). The host's public
  key is announced on the DHT, so it isn't secret; the host accepts a connection only from the friend key pair,
  which proves knowledge of the secret, before any byte reaches the server. Iskra's own signed handshake and the
  invite code still decide membership.
- **Invite links** get an optional fourth field: `<appUrl>/#/join/<b64u(serverUrl)>.<serverKey>.<code>.<p2p>`, where
  `p2p` is the secret (43 b64u characters). Three-field links keep working. Apps add the field when the server has
  the feature on; a friend's app tries `serverUrl` first and uses the tunnel when it can't be reached. The server key
  in the link still pins the server end to end, whichever way the bytes travel.
- `welcome.server.p2p` carries the secret (b64u) to every member while the feature is on (members make invites), else
  `null`. Event `server.p2p { p2p }` goes to everyone when it changes (turned on, off, or rotated). Rotating locks out
  people who only had old links; members learn the new secret from the server.

| type | body | result | who |
|---|---|---|---|
| `p2p.status` | | `{ status: P2pStatus }` | owner |
| `p2p.set` | `enabled` (boolean) | `{ status }` | owner. Turning on creates `p2p.key` if needed and restarts voice with its TURN server; turning off keeps the key |
| `p2p.rotate` | | `{ status }` | owner. A new secret; old links stop working |

```jsonc
P2pStatus {
  "enabled": true,
  "hostKey": "<64 hex>",     // the host's DHT public key (what friends look up), or null
  "tunnelPort": 51234,       // the tunnel listener on 127.0.0.1
  "since": 1760000000000,    // when the current secret was made, or null
  "connected": 2,            // sessions online through the tunnel right now
  "tunnel": {                // the standalone server's own tunnel (iskra-p2p); null when the desktop app hosting
                             // the server runs the tunnel (it reports that itself). Absent from older servers.
    "state": "ready",        // off | missing (no iskra-p2p here) | starting | ready | unavailable (LocalOnly without
                             // a testnet) | failed (started again after a pause)
    "nat": { "firewalled": true, "randomized": false, "publicAddress": "203.0.113.5:49737" }, // or null
    "connections": 1,        // tunnel connections open right now
    "error": null            // a short reason (≤ 200 characters) when unavailable or failed
  }
}
```

- **The tunnel listener.** The server always listens on `127.0.0.1:<TunnelPort>` as well. Every connection there must
  start with a [PROXY protocol v2](https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt) header
  (`PROXY`, TCP over IPv4 or IPv6) that names the friend's address as the tunnel saw it: the friend's public UDP
  address after the hole punch (or the relay's, when one carried the connection). A connection without a valid header
  within 10 s is closed. Tunnelled connections count as **remote**, never as localhost: the loopback-only endpoints
  (`/internal/livekit-webhook`) answer 404, plain-HTTP webhooks are refused as from anywhere else, they're never
  redirected to the public HTTPS address (the tunnel is already encrypted end to end), and per-address rate limits
  and the security log (`LoggedIp`, only when the owner records addresses) use the friend's address from the header.
  The listener is local only, so nothing on the network can reach it; the tunnel is the only thing that connects
  to it.
- **Who runs the tunnel.** A server hosted by the desktop app: the app, in its own process (it starts the server
  with `ISKRA_P2P_TUNNEL=app`). A standalone server: its sidecar `iskra-p2p` (shipped next to `iskra-server` in the
  server packages; the same tunnel code as the desktop app, as one Node single executable), which the server starts
  with the world folder as its only argument while the feature is on, restarts after a crash (2 s, doubling up to
  60 s) and stops with itself (its stdin closes; it leaves the DHT and exits; killed after 3 s; on Windows it's also
  bound to the server's job object). The sidecar reads `p2p.key`, `p2p.port` and `server.json` itself, so the secret
  is never on a command line or in the environment. The server writes `sync` to its stdin after `p2p.rotate`; the
  sidecar answers each status change with one stdout line `{"status": {...}}` (the `tunnel` fields above). A
  `LocalOnly` server's sidecar binds 127.0.0.1 and joins only the network named by `P2p.Bootstrap` (tests run a
  private testnet there); without one it stays `unavailable` and never touches the public DHT.
- **Voice.** With the feature on, LiveKit's embedded TURN server listens on UDP `Voice.TurnUdpPort` (default
  `RtcUdpPort + 1`) with relay ports `Voice.TurnRelayStart`–`Voice.TurnRelayEnd` (default 40000–40200), and may relay
  only to this computer's own addresses. The tunnel carries TURN as unreliable datagrams (no head-of-line blocking).
  `voice.join`, `call.*` and group calls answer a tunnelled session with the voice URL through the address it used
  (`ws://127.0.0.1:<its tunnel port>/livekit`); the friend's app points LiveKit's TURN at its local tunnel port and
  sends media relay-only. The same works for every room: voice channels, stages, watch parties, DM and group calls.
- **What the DHT sees.** The nodes near the host's key (anyone can run one) learn the host's public address and key
  and the addresses of friends who look it up, while the feature is on and the secret stays the same; never what the
  server is, who its members are, or anything of the content. Rotating the secret changes the key. The apps say so
  plainly in "Who Iskra talks to" and next to the switch.

## Outgoing webhooks

The server POSTs chosen events as signed JSON to addresses that admins pick (a Minecraft bridge, Home Assistant, IFTTT).
Requests over the WebSocket; managing needs `manageWebhooks` (admins and the owner always); others get `forbidden`.

| type | body | result | who |
|---|---|---|---|
| `outhook.list` | | `{ hooks: [OutHook] }` | managers |
| `outhook.create` | `name` (1–32), `url` (≤ 512), `events: [EventType]` (≥ 1), `channelIds?: [id]` (≤ 50), `allowLocal?` (default false) | `{ hook, secret }` | managers; `allowLocal: true` only the owner |
| `outhook.update` | `id`, any of `name`, `url`, `events`, `channelIds`, `allowLocal`, `enabled` | `{ hook }` | managers |
| `outhook.regenerate` | `id` | `{ hook, secret }`; the old secret stops working at once | managers |
| `outhook.delete` | `id` | | managers |
| `outhook.log` | `id` | `{ deliveries: [Delivery] }` (newest first, the last 50) | managers |
| `outhook.test` | `id` | `{ delivery }`: sends `ping` once, now (no retries; doesn't count towards turning off) | managers |
| `outhook.hosts` | | `{ hooks: [{ name, host, events }] }`, turned-on webhooks only, never the full address | every member |

```jsonc
OutHook { "id": "<b64u 16>", "name": "Minecraft", "url": "https://mc.example.com/iskra", "host": "mc.example.com",
          "events": ["message.created"], "channelIds": [1], "allowLocal": false, "enabled": true,
          "disabledReason": null | "failures", "failures": 0, "createdBy": accountKey, "createdAt": ms,
          "lastDeliveryAt": ms | null, "lastOutcome": Outcome | null }
Delivery { "delivery": "<b64u 16>", "event": "message.created", "attempt": 1, "at": ms, "status": 200 | null,
           "outcome": Outcome, "ms": 120 }
Outcome = "ok" | "http" | "timeout" | "network" | "blocked" | "redirect" | "rate_limited" | "queue_full" | "too_large"
```

**Events** (`EventType`):

| type | `data` | sent for |
|---|---|---|
| `message.created` | `{ message: { id, channel: { id, name, kind, parentId }, author: { accountKey, name, bot }, text, createdAt, replyTo, attachments: [{ name, size, type }] } }` | messages in the chosen channels and their threads (voice and stage channel chat, forum post replies too) |
| `reaction.added` | `{ messageId, channel, emoji, member: { accountKey, name, bot } }` | the same channels; removing a reaction sends nothing |
| `member.joined` | `{ member: { accountKey, name, role, bot } }` | the whole server |
| `member.left` | `{ member: { accountKey, name }, reason: "left" \| "kicked" \| "banned" \| "deleted" }` | the whole server |
| `event.started` | `{ event: { id, title, description, startAt, endAt, channel \| null, location } }` | events without a channel, or in a chosen channel |
| `ping` | `{ hook: { id, name } }` | `outhook.test` only |

- Managers only see (list, update, regenerate, delete, log, test) webhooks whose channels they can all read; others are
  `not_found`, so nobody can point a webhook for a channel they can't read at their own address.
- `channelIds` are text, voice, stage or forum channels you can read, never [end-to-end encrypted](#end-to-end-encrypted-channels)
  ones (`bad_request`). `message.created` and `reaction.added` need at least one. Messages in a channel that becomes
  encrypted are never sent (the server can't read them anyway). Direct messages and group chats never are. Messages
  posted by incoming webhooks aren't sent (no loops).
- At most 10 outgoing webhooks per server. Rate limits: `outhook.create` 10, then one every 2 s; `outhook.update` 10,
  then 1/s; `outhook.test` 3, then one every 5 s; `outhook.hosts` 10, then 1/s.

**Addresses.** `https://` only; no user name or password in the URL. Each connection resolves the name and connects
only to an allowed address (checked after DNS, every time, so a name that later points somewhere private gets
`blocked`): public addresses, the same list as link previews (no loopback, private, link-local, CGNAT, multicast or
cloud metadata ranges). Redirects are never followed (`redirect`), no proxy is used. With `allowLocal` (only the owner can
turn it on; an admin who changes the URL turns it off) the webhook may also reach the server's own network: loopback,
10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale) and IPv6 unique-local, and plain `http://` is then accepted for
those addresses only. Link-local (169.254/16, fe80::/10), unspecified and multicast addresses are never reached. When
the name resolves at create/update time, a URL with no allowed address is refused (`outhook_address_private`,
`outhook_address_reserved`).

**The request.**

```http
POST <url>
Content-Type: application/json; charset=utf-8
User-Agent: Iskra-Webhook/1
Iskra-Webhook-Id: <delivery id, the same on every retry>
Iskra-Webhook-Event: message.created
Iskra-Webhook-Timestamp: <unix seconds, this attempt>
Iskra-Webhook-Signature: v1=<hex HMAC-SHA256(secret, "iskra-webhook-v1\n" + timestamp + "\n" + id + "\n" + body)>

{ "id": "<delivery id>", "type": "message.created", "timestamp": ms, "server": { "name": "..." }, "data": { ... } }
```

- The secret (`whs_` + 43 characters) is per webhook, shown when made or regenerated, and stored on the server to sign
  with. The HMAC key is the secret's UTF-8 bytes. Receivers check the signature in constant time, refuse timestamps
  more than 5 minutes away from their clock, and may drop delivery ids they've already seen (see `docs/bots.md`).
- Body ≤ 64 KB. Each attempt times out after 10 s (connect 5 s); the response body is never read.
- `2xx` is success. `408`, `429`, `5xx`, timeouts and network errors are retried after 5 s, 30 s, 2 min and 10 min
  (`Retry-After` is honoured up to 10 min); other answers, `blocked` and `redirect` are not. Deliveries aren't ordered.
- Per webhook: 30 events at once, then 5/s, and at most 100 waiting or retrying; more are dropped and logged
  (`rate_limited`, `queue_full`).
- A delivery that still fails after its retries counts one failure; a success resets the count. At 10 the webhook is
  turned off (`enabled: false`, `disabledReason: "failures"`) and online managers get the event
  `outhook.disabled { hook: OutHook }`. Turning it on again (`enabled: true`) clears the count.
- The log keeps the last 50 attempts per webhook: time, event, attempt, HTTP status, outcome and duration, never the
  payload. It goes with the webhook.
- Apps list every server's `outhook.hosts` under "Who Iskra talks to", so members see where their server sends things.

## Built-in bots

The server itself can run three small bots, each turned on or off by an admin: **Dice** (`/roll`), **Polls** (`/poll`)
and **Reminders** (`/remind`). While on, each is a bot member like any other (`bot: true`, plus `builtin`): it has a
role (member when turned on; admins can change it, up to trusted), channel permissions decide where it answers, and it
registers its command in the [command registry](#command-registry) so apps suggest it. It never connects: when someone
sends a plain channel message that starts with its command, the server answers right after the sender's own reply. No
external process is involved.

| type | body | result | who |
|---|---|---|---|
| `builtin.bots.set` | `bot: "dice" \| "polls" \| "reminders"` (or one of [these](#starboard-birthdays-and-welcome)), `enabled: bool` | `{ bots: [BuiltinBot] }` | admins (`forbidden`, key `builtin_bots_admin`) |

```jsonc
BuiltinBot { "id": "dice", "accountKey": "<b64u>" | null, "enabled": true }
```

- `welcome.builtinBots: [BuiltinBot]` lists them all, in that order (then Starboard, Birthdays, Welcome). `accountKey` is null until the bot is first turned
  on; from then on it stays the same (turned off and on again, it's the same member, so its old messages keep their
  author). Event `builtin.bots { bots }` goes to everyone on a change, next to the usual `member.joined` and
  `bot.commands` (on) or `member.removed` (off). Turning on a bot that's on (or off one that's off) changes nothing.
- The bot's key is a fresh Ed25519 public key whose private key is never kept, so nobody can sign in as it.
- Members carry `builtin: "dice" | "polls" | "reminders" | "starboard" | "birthdays" | "welcome" | "feeds" | null`; built-in bots always show as online. Kicking one is
  the same as turning it off. Rate limit: 10, then one a second.

### Commands

A command is the message text `/name args` or `/name@Handle args` (the handle is the bot's shown name without spaces;
another handle means another bot). The command name is matched case-insensitively. A bot answers only when all hold:
it's on, the channel is a `text`, `thread`, `voice` or `stage` channel, the bot can read **and** post there (its role
and the channel's overrides; threads follow their parent), it isn't timed out, the channel isn't
[encrypted](#end-to-end-encrypted-channels), and the sender isn't a bot (bots never answer bots). Per sender, answers
are limited (Dice 10 then 1/s, Polls 5 then one per 5 s, Reminders 10 then 1/s) on top of `chat.send`'s own limit;
over it, the bot stays quiet.

| command | does |
|---|---|
| `/roll [dice]` | Dice notation: terms `NdM` (N 1–999, M 2–1000, `d%` = d100, N defaults to 1) and whole numbers ≤ 100000, joined by `+` or `-` (spaces only around them); ≤ 10 terms, ≤ 100 dice in all; empty means `1d6`. Rolled with the system's secure random generator. |
| `/poll Question \| Answer \| Answer ...` | A native [poll](#polls) (also `"Question" "Answer" "Answer"`), made by the Polls bot through `poll.create`, with all its checks and limits: text channels only, 2–10 different answers. Votes and closing work as for any poll (admins and moderators can end it). |
| `/remind [me] [in] <time> [to\|about\|:] [note]` | An ordinary [reminder](#reminders) for the sender about the command message, due after `<time>`: one or more `<number><unit>` (`m`/`min`/`minutes`, `h`/`hours`, `d`/`days`, `w`/`weeks`, also Swedish `minuter`, `timmar`, `dagar`, `veckor`, `mig om`), from 1 minute up to 365 days; the note ≤ 300 characters. It shows in the sender's reminders (`reminder.updated`), fires like any reminder (`reminder.due`, push) and can be snoozed or cancelled there. Its `data` is not sealed (the command was plain text already): `"bot." + base64url(JSON { note, where, at })`, which `reminder.create`/`reminder.update` never accept from apps. Per-person limit as for reminders. |

Each answer is a message from the bot that everyone who can read the channel sees, with plain English `text` for any
app, and `builtin` with what it means, so apps can word it in their own language. Hints and errors (`roll.invalid`,
`poll.usage`, `remind.usage`, `error`) are instead a [private answer](#answering) only the sender sees: event
`interaction.response` with the same `text` and `builtin`, never stored. Built-in bots read nothing but their own
commands (`readsMessages: false`).

```jsonc
// every answer: { "bot": "dice", "kind": "...", "for": "<sender's accountKey>", ... }
{ "kind": "roll", "expression": "2d6+3", "groups": [{ "sign": 1, "count": 2, "sides": 6, "rolls": [4, 2] }], "modifier": 3, "total": 9 }
{ "kind": "roll.invalid", "input": "banana" }      // ≤ 60 characters of what was sent
{ "kind": "poll.usage" }                            // a successful /poll answers with the poll itself (no `builtin`)
{ "kind": "remind", "dueAt": 1760000000000 }
{ "kind": "remind.usage" }
{ "kind": "error", "error": { "code": "bad_request", "message": "...", "key": "poll_channel", "args": null } }
```

Messages carry `builtin: {...} | null` (`null` for everything except a built-in bot's answer). Answers are kept and
deleted like other messages; "Download my data" lists the answers to your own commands (`builtinBotAnswers`).

**Encrypted channels.** The server can't read messages there, so it can't see a command or its arguments: built-in
bots never answer in encrypted channels (or their threads), `bot.commands.available` doesn't list them there, and apps say so
when someone types `/` and no bot can answer (bots that take [interactions](#bot-interactions) can, privately).

## Bot interactions

A registered command can be **invoked**: the app sends it to the bot as an *interaction* (checked by the server
against the command's declared options) instead of posting the text. The bot answers in public (a message in the
channel), in private (only the person who asked sees it, never stored), defers and follows up, shows a form, or
updates the message a button was on. Bot messages can carry **components** (buttons and select menus); clicks are
interactions too. The text convention (`/roll 2d6` as a message) keeps working for bots that don't take interactions.

### What a bot can read

An admin chooses, when inviting a bot, whether it **can read all messages**. By default it can't: it gets only its
interactions and the messages meant for it.

| type | body | result | who |
|---|---|---|---|
| `bot.invite` | gains `readAll?` (bool, default `false`) | | admin+ |
| `bot.scope.set` | `accountKey` (a bot member), `readAll` (bool) | `{ member }` | admin+; `member.updated` goes to everyone |

- `Member.readsMessages`: `true`/`false` for bots, `null` for people. Bots that joined before this existed keep reading
  everything (`true`); `readAll` from the invite is copied to the bot when it joins.
- A bot that can't read all messages gets `chat.message` and `chat.edited` only for messages that: it wrote; mention it
  (`<@key>`); reply to one of its messages; or start with `/name` or `/name@Bot` where `name` is one of its registered
  commands (the text convention). It doesn't get `chat.typing`, `poll.updated` (except for its own polls),
  `docs.page.updated`, `docs.home`, `forum.post.updated` or `watch.chat`. These requests are `forbidden`
  (key `bot_no_read`): `chat.history`, `chat.edits`, `search`, `pin.list`, `thread.get`, `forum.posts`,
  `forum.post.get`, `docs.pages`, `docs.page.get`, `docs.page.history`, `docs.search`, `docs.home.get`, `chat.forward`,
  `inbox.list`, and the ones whose answers carry content: `docs.page.save`, `docs.page.restore`, `docs.home.set`,
  `forum.post.update`, `forum.post.set`, `report.list`, `push.subscribe` (Web Push carries message text; turning
  `readAll` off also deletes the bot's push subscriptions, and channel-message pushes skip such bots). Its `chat.send`
  (and scheduled sends) may only reply to a message meant for it (else `forbidden`, `bot_no_read`), since a reply quotes
  the original. Reply previews in messages it does get still quote the replied-to message (≤ 140 characters).

### Commands that take interactions

`bot.commands.set` gains `interactions?: bool`: the bot answers `interaction` events (the SDK always says `true`).
Lists carry it: `welcome.botCommands: [{ bot, commands, interactions }]`, event `bot.commands { bot, commands, interactions }`.
Apps send a typed command to such a bot as `interaction.invoke`, and post the text as before to bots without it.

`Command` gains two optional fields, enforced by the server on every invocation:

| field | rules |
|---|---|
| `role` | `member`, `trusted` or `admin`: the lowest level that may use the command (default: anyone who can post there) |
| `permission` | a [permission](#roles-and-permissions) name (`manageMessages`, `kickMembers`, ...) the invoker must have (admins have all) |

`bot.commands.available` also lists bots with `interactions` in [encrypted channels](#end-to-end-encrypted-channels)
when they can read the channel (see below). Apps hide commands whose `role`/`permission` the person doesn't have.

### Invoking

| type | body | result | who |
|---|---|---|---|
| `interaction.invoke` | one of the shapes below | `{ id, expiresAt, private }` | people (bots: `forbidden`); see the checks |

```jsonc
// a command
{ "bot": "<accountKey>", "channelId": 1, "command": "roll", "options"?: { "dice": "2d6", "secret": true }, "args"?: "2d6 secret" }
// a component on a bot's message, or on a private answer
{ "messageId": 42, "customId": "roll:2d6", "values"?: ["d20"] }
{ "responseId": "<b64u 16>", "customId": "again" }
// a form (modal) the bot showed you
{ "modalId": "<b64u 16>", "fields": { "title": "Game night", "notes": "Bring snacks" } }
```

Checks (each failure is the error shown):

- The channel (or the message's channel) is one the invoker can read and is a `text`, `thread`, `voice` or `stage`
  channel (`not_found`); they can post there (`forbidden`, key `cant_send_here`); not while timed out (`timed_out`)
  or before agreeing to the [rules](#server-rules).
- The bot is a member and a bot, said `interactions` and has the command in its list (`not_found`); it can post in the
  channel, or in an encrypted channel read it (`bad_request`, key `bot_cant_post`, `args: { name }`); it is connected
  (`bad_request`, key `bot_offline`, `args: { name }`).
- The command's `role` and `permission` (`forbidden`, key `command_not_allowed`).
- `options` (an object, ≤ 25 keys): only declared names; every required one present; values of the declared type:
  `string` 1–1000 characters, one line; `integer` a safe integer; `number` finite; `boolean`; `user` the account key of
  a member; `channel` the id of a channel the invoker can read; `role` the id of a custom role. With `choices`, the value
  must be one of them. Otherwise `bad_request` (key `command_option`, `args: { name }`). `args` (≤ 4000 characters,
  one line) is the text as typed, for bots that read it themselves.
- Components: the message is a bot's message with a component of that `customId` that isn't disabled and isn't a link;
  `values` (select menus only) ≤ 25, each one of the menu's option values, at least `minValues` and at most
  `maxValues`. Private answers: the answer must be yours and not expired (`not_found`).
- Forms: the modal must be yours, unexpired and unused (each is single use); `fields` only its fields, required ones
  non-empty, each ≤ its `maxLength`; `short` fields are one line.
- Rate limit: 5, then 2 a second. A command, a click and a form submit all count.

The bot's sessions get event `interaction`:

```jsonc
{ "id": "<b64u 16>", "kind": "command" | "component" | "modal", "channelId": 1, "user": "<accountKey>",
  "private": false,           // true: every answer will be private (encrypted channels)
  "expiresAt": 0,
  "command"?: "roll", "options"?: { }, "args"?: "2d6",                              // kind command
  "messageId"?: 42, "responseId"?: "...", "customId"?: "...", "values"?: ["..."],   // kind component
  "fields"?: { "title": "..." } }                                                  // kind modal (customId: the modal's)
```

`id` is the interaction token: 16 random bytes, valid for 15 minutes, only for the bot it was sent to, and only for
answering this one interaction (at most 5 answers). Tokens live in the server's memory and end with a restart. A person
has at most 100 interactions open (started in the last 15 minutes); more are `rate_limited`.

### Answering

| type | body | result | who |
|---|---|---|---|
| `interaction.respond` | `id`, `type?` (`reply`, the default, `defer`, `update` or `modal`); `reply`/`update`: `text?`, `cards?`, `components?`, `private?` (bool); `modal`: `modal` | `{ message?, responseId? }` | the bot the interaction went to |

- `reply`: a public reply is posted as the bot's message (the same checks as `chat.send`: posting rights, AutoMod,
  slowmode, cards) with `interaction: { id, user, command }` (`command` null for clicks and forms); apps show
  "Viktor used /roll". A private reply goes only to the invoker's sessions as event `interaction.response` and is never
  stored. In encrypted channels every reply is private.
- `defer`: only as the first answer; the invoker's sessions get `interaction.state { id, bot, state: "deferred" }` and
  apps show "Dice is thinking…" until a reply (or the token expires). Without any answer apps give up after 15 s.
- `update`: only for component interactions; replaces the text, cards and components of the message the component is
  on (the bot's own message, like `chat.edit`; `chat.edited` follows) or of the private answer (a new
  `interaction.response` with the same `responseId` and `updated: true`).
- `modal`: only as the first answer, and not for forms; the invoker's sessions get `interaction.modal`.
- After any answer except `defer`, the invoker's sessions get `interaction.state { id, bot, state: "done" }`.
- Errors: an unknown or expired token, or another bot's: `not_found`; the wrong `type` for this interaction or more
  than 5 answers: `bad_request`. Rate limit: 20, then 5 a second.

```jsonc
// event interaction.response (the invoker's sessions only; kept in the server's memory 15 minutes for clicks)
{ "responseId": "<b64u 16>", "interaction": "<id>", "bot": "<accountKey>", "channelId": 1,
  "text": "...", "cards": [Card], "components": [Row], "createdAt": 0, "updated"?: true }
// event interaction.modal (the invoker's sessions only)
{ "modalId": "<b64u 16>", "interaction": "<id>", "bot": "<accountKey>", "channelId": 1, "modal": Modal }
```

### Components

`chat.send` and `chat.edit` from a bot (and `interaction.respond`) may carry `components: [Row]` (`[]` removes them on
an edit); people get `forbidden`. With components the text may be empty. Messages carry `components: [Row] | null` and
`interaction: { id, user, command } | null`.

```jsonc
Row    { "type": "row", "items": [Button] | [Select] }
Button { "type": "button", "customId": "roll:2d6", "label": "Roll again",
         "style"?: "primary" | "secondary" | "success" | "danger" | "link", "url"?: "https://...", "disabled"?: true }
Select { "type": "select", "customId": "dice", "placeholder"?: "Pick dice",
         "options": [{ "label": "d20", "value": "d20", "description"?: "...", "default"?: true }],
         "minValues"?: 1, "maxValues"?: 1, "disabled"?: true }
Modal  { "customId": "plan", "title": "Plan a game night",
         "fields": [{ "customId": "title", "label": "Title", "style": "short" | "paragraph",
                      "required"?: true, "placeholder"?: "...", "maxLength"?: 200, "value"?: "..." }] }
```

| field | rules |
|---|---|
| rows | ≤ 5; a row has 1–5 buttons or exactly one select menu; the components JSON ≤ 8 KB |
| `customId` | 1–100 characters of printable ASCII, unique in the message or modal (link buttons have none) |
| `label` | 1–80 characters, one line; `placeholder` ≤ 100 |
| link buttons | `style: "link"` and `url` (http/https, ≤ 512); apps show the address and never open it by themselves; clicks don't reach the bot |
| select `options` | 1–25; `label` and `value` 1–100, `description` ≤ 100; values unique; `0 ≤ minValues ≤ maxValues ≤ options`, `maxValues ≥ 1` (defaults 1 and 1) |
| modal | `title` 1–45; 1–5 `fields`; `label` 1–45; `required` defaults to true; `maxLength` `paragraph` 1–4000 (default 4000), `short` 1–1000 (default 200); `value` ≤ `maxLength` |

Labels, options and form text are rendered as text by apps, never as HTML.

### Encrypted channels

The server never sees an [encrypted channel](#end-to-end-encrypted-channels)'s messages, and bots are never in its
chain. A command there still works without leaking the channel:

- The invocation (the command name, its options and `args`) is **not** part of the encrypted stream: it goes from the
  app to the server and the bot in the clear, like any request. Apps say so before sending it ("This command goes to
  Dice unencrypted. Only you will see the answer.").
- The bot must be able to read the channel by its roles (it still can't post there); it never gets the channel's
  messages, keys or chain.
- Every answer is private (`private: true` in the interaction): only the person who asked sees it; it is never stored
  or posted, so nothing unencrypted lands in the channel. Components on those answers work the same way.

## Voice bots

A bot can join a voice channel and play audio into it (music from files, or a stream its operator provides). An admin
decides per bot; by default a bot can't join voice. The server issues the bot's LiveKit token like anyone's, with
tighter grants; the audio itself goes from the bot straight to LiveKit, as for people.

| type | body | result | who |
|---|---|---|---|
| `bot.invite` | gains `voice?` (bool, default `false`): the bot may join voice | | admin+ |
| `bot.voice.set` | `accountKey` (a bot member), `voice` (bool) | `{ member }` | admin+ (others: `forbidden`, key `admins_bot_voice`); built-in bots: `bad_request` (key `bot_builtin_voice`); `member.updated` goes to everyone |
| `voice.join` | as before; bots only with `voice` (see below) | `{ url, token, room, canSpeak }` | |
| `voice.disconnect` | `accountKey` | | `moveMembers`, someone below you (or yourself) who is in a voice channel you can see |

- `Member.joinsVoice`: `true`/`false` for bots, `null` for people. `voice` from the invite is copied to the bot when it
  joins (migration `voicebots-1`: `bots.voice`, `bot_invites.voice`). Built-in bots never join voice.
- `voice.join` by a bot: without `voice`: `forbidden` (key `bot_no_voice`); a stage channel: `bad_request` (key
  `bot_stage`); an [encrypted](#end-to-end-encrypted-channels) voice channel: `bad_request` (key `bot_e2ee_voice`,
  bots are never in the chain, so they couldn't hear or be heard). Everything else is as for people: `connect` on the
  channel, [user limits](#voice-user-limits), timeouts, server mutes; `canSpeak` = channel writers and not server-muted.
- A bot's token grants `canSubscribe: false` (a bot never receives anyone's audio), `canPublishData: false` and
  `canPublishSources: ["microphone"]`: it can publish one kind of track, audio, and no camera or screen share.
  Server mutes keep these grants (`UpdateParticipant` sends the bot's permission, not a person's).
- The LiveKit webhook check also applies these rules: a bot that joins without `voice`, or a stage or encrypted
  channel, is removed. Turning `voice` off (`bot.voice.set`) or removing the bot takes it out of voice at once.
- `voice.disconnect` takes someone out of the voice channel they're in (people and bots): LiveKit removes them and
  their sessions get event `voice.disconnected { channelId }`; apps don't rejoin by themselves. Audit `voice.disconnect`
  (`{ channelId, channelName }`).
- Apps show bots in voice like everyone, with the bot badge. Muting a bot for yourself is the usual per-person volume
  (on your device only); server mute and disconnect are the usual moderation.

## Built-in roles

The levels (`owner`, `admin`, `trusted`, `member`, `guest`) are the **built-in roles**: every server has them, every member
holds exactly one, and channels' `readRole`/`writeRole` pick from them. Apps list them above custom roles, under the same
names the channel "Who can" pickers use. What they can do comes from one table on the server (`Sessions/BaseRoles.cs`),
which the server's own checks use; `role.list` and the `roles` event send it, so the list never drifts from what's
enforced. Their colour and (within the safety rules below) their powers can be changed per server.

```jsonc
BaseRole { "id": "trusted", "color": "#5b9bd5" | null,
           "abilities": ["invite", "events", "pin", "mentionEveryone", "uploadSounds"],   // what it can do on this server
           "permissions": [],                                                           // custom-role permissions it has by itself
           "changed": false,                                                            // differs from the defaults
           "defaults": { "abilities": [...], "permissions": [] },
           "adjustable": { "abilities": [...], "permissions": [...] } }                 // what may be changed for it
```

Abilities and the lowest role that has them **by default**: `invite` (invite guests and members), `events`, `whisper`
([whisper](#whisper-and-priority-speakers)), `externalEmoji` ([emoji and stickers from other servers](#custom-emoji)) (member);
`pin`, `mentionEveryone`, `uploadSounds` (soundboard) (trusted); `giveBaseRoles` (`member.setRole`, invites and bot
invites into roles below your own), `bots` (bot invites, voice bots, built-in bots), `organize` (categories, the
default notification level), `rules`, `stickers`, `gifs`, `stageModerators`, `forumTags`, `profilePages`,
`resolveDisputes`, `serverImages` ([server icon and banner](#server-icon-and-banner)) (admin); `runServer` (limits, updates, backups, moves, imports, security settings, connections,
internet hosting) and `transferOwnership` (owner). Custom roles never grant abilities; they grant the
[permissions](#roles-and-permissions). By default admins have every permission; the owner always has every
permission and ability.

| type | body | result | who |
|---|---|---|---|
| `role.base.update` | `role` (a built-in role); any of `color` (`#rrggbb`; `""` clears), `abilities` (the whole set, ≤ 19 names), `permissions` (the whole set, ≤ 14 names), `reset: true` (back to the default powers; not with `abilities`/`permissions`) | `{ baseRole: BaseRole }` | `manageRoles`. Colour: the owner may change any, everyone else only `trusted`, `member` and `guest` (`forbidden`, key `rank_base_roles`). Powers: see below. Rate limited (30, then 2 a second) |

`role.list` and the `roles` event also carry `groups` ([pick groups](#self-assignable-roles-and-pick-groups)).

Safety rules for powers, all checked on the server before anything changes:

- The owner's role never changes, not even by the owner (`forbidden`, key `base_role_owner`); `runServer` and
  `transferOwnership` always stay the owner's. So the owner can never be locked out, and there is always someone who can
  manage roles.
- Only roles strictly below your own base role (`forbidden`, key `rank_base_roles`): admins change `trusted`, `member`
  and `guest`; only the owner changes `admin`.
- Only powers you have yourself, to give or to take (`forbidden`, key `base_power_not_yours`), so nobody lifts a role
  past their own.
- `guest` and `member` only get everyday powers: `invite`, `events`, `whisper`, `externalEmoji`, `pin`, `mentionEveryone`, `uploadSounds` and the
  permission `mentionEveryone` (`bad_request`, key `base_power_not_allowed`, args `{ role }`). `trusted` and `admin` may
  get any ability but the owner's and any permission.
- Unknown names → `bad_request`.

Changes are stored as additions and removals from the defaults (`base_role_powers`, migration `builtinroles-2`), so a
server that never changes anything behaves exactly as before, and abilities added in later versions follow their
defaults. Effective powers are always clamped to what may be changed, whatever the database says. Audit `role.base`
`{ role, from, to }` (colour) and `role.base.powers` `{ role, reset, added, removed }`.

- Name colour (client-side): an owner's or admin's built-in colour comes first, then the highest custom role with a
  colour, then the built-in colour of `trusted`, `member` or `guest`, following the [hierarchy](#roles-and-permissions).
- Built-in roles can't be created, renamed, deleted or reordered. Custom roles can't take a built-in role's name (or
  `everyone`): `role.create`/`role.update` → `bad_request`, key `role_name_builtin`.
- Starter templates set colours and powers with `builtinRoles` (see [Starter templates](#starter-templates)).
  Colours are stored in `base_role_styles` (migration `builtinroles-1`).

## Bug inbox

A server can take bug reports from Iskra's apps ("Report a bug"): each report becomes one message in a channel the
owner picked, normally a private one. Only a server whose `server.json` has `"BugInbox": { "Accept": true }` has a bug
inbox, and only the server that receives Iskra's own reports should: with it off (the default) `POST /bug-reports` and its
`OPTIONS` answer `404` like an unknown route, `buginbox.get` and `buginbox.set` are refused with `forbidden` (key
`bug_inbox_off`), and `welcome.server.bugInbox` is `false`, so apps hide Server settings → Bug inbox. Iskra's own apps
send to `chat.iskra.foo`; the apps only send to the address built into them.

| type | body | result | who |
|---|---|---|---|
| `buginbox.get` | | `{ enabled, channelId }` (`channelId` null until picked) | owner (others: `forbidden`, key `owner_bug_inbox`) |
| `buginbox.set` | `enabled` (bool), `channelId?` (a text channel; kept when left out) | `{ enabled, channelId }` | owner; turning it on without a channel: `bad_request` (key `bug_inbox_channel`); not a text channel: key `bug_inbox_text_only`; an [encrypted](#end-to-end-encrypted-channels) channel: `bad_request` |

Migration `buginbox-1`: `bug_inbox` (one row: `enabled`, `channel_id`, which goes null when the channel is deleted,
which turns the inbox off). Audit `buginbox.update` (`{ enabled }`).

### `POST /bug-reports`

Anonymous HTTP, no account or secret. CORS: the apps' origins only (`https://app.iskra.foo`, `app://iskra`,
`capacitor://localhost`, `http(s)://localhost`, and `http://localhost:<port>` / `http://127.0.0.1:<port>` for
development); `OPTIONS` answers the preflight. Body: `application/json`, at most 12 MB.

```json
{ "v": 1,
  "what": "The mic button does nothing",          // required, ≤ 1500 characters
  "steps": "1. …\n2. …", "expected": "…",          // optional, ≤ 1400 and ≤ 600
  "email": "me@example.com",                       // optional contact, ≤ 254, email-shaped
  "env": { "version": "2.0.0-alpha.15", "commit": "abc1234" | "dev", "os": "Windows 11",
           "browser"?: "Chrome 140", "device": "desktop" | "web" | "ios" | "android", "language"?: "en" },
  "logs": "…",                                     // optional, ≤ 64 KB of text, attached as a .txt file
  "images": [{ "type": "image/png" | "image/jpeg" | "image/webp", "data": "<base64>" }] }  // ≤ 5, each ≤ 1.5 MB, ≤ 10 MB together
```

- Unknown fields are refused (`400`), not dropped. Text follows chat text rules (no invisible control characters);
  `env` values must match short patterns (letters, digits and a few separators), so nothing free-form hides there.
  An image's bytes must be the type it says.
- Answers: `201 { id: "ABCD-EFGH" }`; `404` while the server doesn't accept bug reports (`BugInbox.Accept` off), the inbox is off or its channel is gone; `400 { error: "invalid",
  message }`; `413`; `415` for anything but JSON; `429` with `Retry-After`.
- Limits: 5 reports an hour per client address (IPv6: per /64), and 60 an hour for everyone. Addresses are used in
  memory for this only: never stored or logged. The server log line has the report id and channel name only.
- The message: author `webhook:bug-inbox`, `webhook.name` "Bug reports", text = the reporter's words under headings
  (What happened, Steps to reproduce, Expected, Contact), mentions turned into plain text; one card (embed) with the
  first line as its title, fields Version, Commit, OS, Browser, Device, Language and footer "Report <id>". Images and
  the logs are stored as uploads (uploader `webhook:bug-inbox`) and attached. Reports are deleted after 365 days at
  the latest (`RetentionSweeper`; sooner if the server's message retention is shorter), their files a day later as
  unused uploads; admins delete one like any webhook message.

## AFK channel

One voice channel can be the server's AFK channel. People who have been idle in another voice channel for a while are
moved there, and in it everyone is muted and deafened by the server, except members with a role picked under
"can talk here".

```jsonc
Afk { "channelId": 7 | null,               // a voice channel (never a stage); null = no AFK channel
      "idleMinutes": 30,                   // 0 (never move anyone), 5, 15, 30 or 60
      "talkLevels": ["owner", "admin"],    // built-in roles that can talk and hear in it
      "talkRoles": [3] }                   // custom roles that can (≤ 100)
```

| type | body | result | who |
|---|---|---|---|
| `afk.get` | | `{ afk: Afk }` | anyone |
| `afk.update` | any of `channelId` (a voice channel id, or `null` to turn it off), `idleMinutes`, `talkLevels`, `talkRoles` | `{ afk: Afk }` | admin+ (others: `forbidden`, key `admins_afk`) |
| `voice.idle` | `idle` (bool), `idleMs?` (0–3 600 000: how long this device has already been idle) | | anyone |

- Without a stored setting, `afk.get` answers `{ channelId: null, idleMinutes: 30, talkLevels: ["owner", "admin"], talkRoles: [] }`.
- `afk.update`: `channelId` must be a `voice` channel (`bad_request`, key `afk_voice_only`) and not a [lobby](#join-to-create-voice-rooms) (`afk_lobby`); `idleMinutes` one of the
  values above (key `afk_minutes`); `talkLevels` built-in roles (key `afk_levels`); `talkRoles` existing roles (key
  `afk_roles`). Event `afk { afk }` to everyone. Deleting the channel turns it off; deleting a role takes it out of
  `talkRoles`. Audit `afk.update` (`{ channelId, idleMinutes }`).
- **Forced mute and deafen.** In the AFK channel, a member who has none of the talk levels or roles gets a LiveKit token
  with `canPublish: false` and `canSubscribe: false`: LiveKit neither takes their audio nor sends them anyone else's,
  whatever their app does. `voice.join` answers `{ ..., canSpeak: false, canHear: false, afk: true }` (elsewhere
  `canHear: true`, `afk: false`). When the setting or someone's roles change while they're in it, the server changes
  their LiveKit permissions (`UpdateParticipant`) to match; apps follow (an app whose subscribe permission changed
  joins again). Server mutes never lift a forced mute. `voice.state` participants gain `afk: true` while forced.
- **Idle.** Each session says when its device goes idle: `voice.idle { idle: true, idleMs }` once there has been no
  input and no speaking for a minute, and `voice.idle { idle: false }` as soon as there is either. The server counts
  someone as idle from `now - idleMs` (and only while every one of their sessions reports idle; a session that never
  reported is active). What counts as input is up to the app:
  the desktop app uses the system's idle time (any keyboard or mouse use on the computer), the browser and phone apps
  input in the app while it's visible; speaking (the app's own voice activity detection) always counts.
- **Moving.** About every 15 s the server moves people in a `voice` channel (not a stage, not the AFK channel itself,
  never bots) who have been idle for `idleMinutes` and may join the AFK channel. A move is the same as a moderator's
  `voice.move` (the move pass for full channels included): their sessions get `voice.moved { channelId, reason: "afk" }`
  (apps show a notice and join it) and they leave the old room. At most 20 moves per sweep and one per person a minute.
  Coming back is a normal `voice.join`.
- Rate limits: `voice.idle` 1 every 2 s (burst 10); `afk.update` the general bucket.
- Storage: `afk_settings` (one row) and `afk_talk_roles` (migration `afk-1`). Templates can set it up (`afk` in the
  template format, see docs/hosting.md).

## Bot DMs

People can message a bot, and a bot can message people, as end-to-end encrypted [direct messages](#direct-messages-end-to-end-encrypted).
A bot is an ordinary DM endpoint: it connects with a device certificate, publishes signed prekeys (`prekey.publish`)
like an app, and encrypts and decrypts envelopes itself. The server relays envelopes as for people and never reads them.
Whoever runs the bot reads what's sent to it: that's the point of writing to a bot, and apps say so.

| type | body | result | who |
|---|---|---|---|
| `dm.bots.get` | | `{ allow, at }` (`at`: 0 if never set) | anyone (their own) |
| `dm.bots.set` | `allow` (bool), `at` (ms; ≥ 1, at most 10 minutes ahead of the server) | `{ allow, at }` (what is stored afterwards) | anyone (their own) |

- **The setting** "DMs from bots" (default: allowed). Last writer wins by `at`, so apps keep it on the device and hand it
  to every server they're on (like the [block list](#blocking)); an older `at` changes nothing. Event `dm.bots { allow, at }`
  goes to the account's other sessions on this server after a change.
- **`dm.send` from a person to a bot**: always allowed (unless one blocked the other), except to [built-in bots](#built-in-bots),
  which run inside the server and have no keys (`bad_request`, key `builtin_bot_dm`). The server notes that the person
  wrote to the bot.
- **`dm.send` from a bot to a person**: only to members of this server (else `not_found`, as for everyone), not if either
  blocked the other (`forbidden`, key `blocked_message`), and only if the person allows DMs from bots or wrote to this bot
  before (else `forbidden`, key `bot_dms_off`). So turning the setting off stops every conversation a bot started, but a
  bot can still answer someone who writes to it.
- **Bots never message bots** (`forbidden`, key `bot_dm_bot`). Bots still can't upload DM files (`dm.upload.begin`),
  call, be called or be in group DMs.
- **Rate limits** on top of `dm.send`'s own (2/s, burst 10 per session): per bot account, 1 DM a second (burst 30) over all
  its connections, and 20 new conversations at once, then 20 an hour (`rate_limited`, key `bot_dm_new_limit`).
- **Commands in DMs** stay end-to-end encrypted: the app sends `/name args` as the DM's text (the app suggests the bot's
  [registered commands](#command-registry) when someone types `/` in a DM with it), and the bot answers with DMs. They
  are not interactions: there are no private answers, forms or buttons in DMs, and a bot checks a command's `role` itself
  (the member's base role, as the bot sees it); commands that need a `permission` work only in channels.
- Storage (migration `botdms-1`): `bot_dm_prefs` (account, allow, at) and `bot_dm_peers` (bot, person, whether the
  person wrote first, when the conversation started). Both are in "Download my data" and are deleted with the account.

## Starter templates

A template (format in `docs/templates.md`) sets up a new server once: channels of every kind (text, voice, forum,
stage, docs; hi-fi, user limits, slowmode, forum tags), who can see and use each (`readRole`/`writeRole` and per-role
overrides for the template's own roles), custom roles, built-in role colours and powers, rules, the AFK channel and
settings (default notifications, limits, built-in bots, bug inbox). `"version": 4` (format 4 adds `roles[].selfAssign`
and `roleGroups`, the pick groups of [self-assignable roles](#self-assignable-roles-and-pick-groups); format 3 added
starting content: see "Channel topics and template content"); formats 3, 2 and 1 (no version) stay valid; a newer
format is refused with a clear message. Unknown fields are an error. Up to 256 KB, 500
channels, 50 categories, 100 roles, 20 pick groups. The server checks every template it reads with the same rules as the requests that
make the same changes (built-in role powers and self-assignable roles included).

| type | body | result | who |
|---|---|---|---|
| `server.template.export` | `{}` | `{ template: object }` (the lowest format that holds everything in it: 4, 3 or 2) | admins (`forbidden`, key `admins_template_export`). Rate limited (3, then 1 every 10 s) |
| `notify.default.set` | `level`: `auto` (all messages under 15 people, only @mentions above), `all` or `mentions` | `{ level }` | the `organize` ability (`forbidden`, key `admins_notify_default`). Rate limited (10, then 1 a second) |

- `server.template.export` ("Save this server as a template") contains only structure and settings: never members,
  messages, files, invites, keys or other secrets. Channels the person saving can't see are left out, and the bug inbox
  unless the owner saves. Encrypted channels come out as ordinary ones (a template can't hold keys). The result is
  checked with the template validator before it's sent (`bad_request`, key `template_export_invalid`, args `{ problem }`).
  Audit `server.template.export`.
- `welcome.notifyDefault` (`auto` | `all` | `mentions`; absent on older servers = `auto`) and the event
  `notify.default { level }` (to everyone) give the server's default notification level for people who chose none; push
  follows it. Stored in `notify_default` (migration `templatesv2-1`). Audit `notify.default` `{ from, to }`.
- `iskra-server templates <file> --json` describes a checked template for the desktop app's preview (`roles` stays a
  list of names; `roleDetails`, `builtinRoles`, `settings` and per-channel `readRole`, `writeRole`, `hifi`, `slowmode`,
  `overrides`, `tags` are new).
- `iskra-server templates apply <world> <file> [--apply]` adds a template to a server already in use, additive only:
  roles and categories it doesn't have (by name), pick groups it doesn't have (by title, when every role in them is one
  members may pick), channels it doesn't have (by name and kind, anywhere on the server),
  and settings still at their defaults. It never deletes, renames or changes existing channels, roles, members or
  messages. Without `--apply` it only prints what it would add. It refuses while the server runs (its port answers on
  localhost). Security log `server.template.merge`.

## Keyword alerts and quiet hours

Alert words ("Alert me for these words"), follows ("alert me when this person, or anyone with this role, posts in
this channel / anywhere on this server") and quiet hours (a do-not-disturb schedule) are the app's settings: the app
keeps them on the device, syncs them across the account's devices sealed in `prefs` (name `alerts`), and matches alert
words and follows itself, in encrypted channels and DMs too. A server only gets a copy when push needs one:

- **Alert words and follows** only if the member turned on "Also when Iskra is closed" (the words then apply to this
  server's channels that aren't encrypted; the server can't read encrypted ones. A follow needs no text, so it works in
  encrypted channels too).
- **Quiet hours** only on servers where one of the member's devices has push on, so pushes follow the schedule.

```jsonc
Alerts { "words": ["pizza", "raid night"],     // ≤ 25, each 1–50 characters after trimming
         "follows": [Follow],                   // ≤ 50
         "quiet": Quiet | null }
Follow { "member": "<accountKey>" | null,       // exactly one of member (43 base64url characters) and role (an id)
         "role": 7 | null,
         "channelId": 12 | null }               // null: any channel on this server
Quiet  { "days": 62,                            // 1–127, bit 0 = Sunday … bit 6 = Saturday
         "from": 1320, "to": 420,               // 0–1439, minutes after midnight, wall clock in timeZone
         "timeZone": "Europe/Stockholm",        // IANA name, ≤ 64 characters, known to the server
         "mentions": true,                      // let mentions, replies, alert words, DMs and calls through, silently
         "digest": true }                       // optional, default true: a summary when they end (see Quiet hours digest)
```

| type | body | result | who |
|---|---|---|---|
| `alerts.get` | | `{ alerts: Alerts }` | anyone (their own) |
| `alerts.set` | `words?` (list, default `[]`), `follows?` (list, default `[]`), `quiet?` (`Quiet` or `null`, default `null`) | `{ alerts: Alerts }` | anyone (their own) |

- `alerts.set` replaces all three. Words are trimmed, runs of spaces become one, empty ones are dropped and duplicates
  (ignoring case) kept once; control characters are refused (`bad_request`, key `alerts_word`). More than 25 words or one
  longer than 50 characters: `bad_request`. Follows: more than 50 (key `alerts_follows`), or one that isn't exactly a
  person or a role (key `alerts_follow`): `bad_request`; the same follow twice is kept once; only the shape is checked
  (a person who left, or a deleted role or channel, just never matches). `quiet` needs `days`, `from`, `to` in range
  (key `alerts_quiet`) and a time zone the server knows (key `alerts_time_zone`). With no words, no follows and no quiet
  hours nothing is stored. Event `alerts.updated { alerts }` to the member's sessions.
- **Matching** (server and apps alike): each word or phrase as a whole, ignoring case: no letter, digit, combining mark
  or `_` right before or after it, and any run of white space between a phrase's words. Words are literal text, never
  patterns. The server matches new messages in channels that aren't encrypted, for members who can read the channel,
  never the author's own messages, forwarded ones, or between people where one blocked the other. A match notifies like a
  mention: push kind `keyword` (unless the member's level there is "nothing"; muting doesn't silence it), and an inbox
  item of kind `keyword` (a weak kind: a message that also mentions you is a `mention`).
- **Follows** (server and apps alike): a new message counts when its author is the followed person, or has the followed
  role, and the message is in the followed channel (or any channel here when `channelId` is null); never the follower's
  own messages, forwarded ones, or between people where one blocked the other; only for members who can read the
  channel. A match gives push kind `follow` (unless the member's level there is "nothing" or they muted the channel or
  the server; quiet hours stop it) and an inbox item of kind `follow` (the weakest kind).
- **Quiet hours**: active on the picked days from `from` to `to` in `timeZone`; a stretch that crosses midnight belongs
  to the day it starts on (Friday 23:00–02:00 runs into Saturday morning); `from` = `to` is the whole day. While active,
  pushes stop, except (with `mentions: true`) kinds `mention`, `reply`, `keyword`, `dm`, `group` and `call`, which are
  delivered with `silent: true` (the service worker shows them without sound or vibration). Inbox items and unread
  counts are unaffected. Do not disturb still stops every push.
- Leaving the server, being removed and deleting the account delete the stored copy. It's in "Download my data"
  (`alertSettings`). Storage: `alert_settings` (migrations `alerts-1`, `alerts-2` for follows).
- Rate limit: the general bucket.

## Whisper and priority speakers

**Whisper** (as in TeamSpeak): while you hold a whisper key, your voice goes only to the people on one of your whisper
lists, or to everyone in another voice channel ("whisper to channel"), instead of to your own channel. Apps keep up to
three lists, each with its own key; the lists are kept on the device.

Each whisper is its **own LiveKit room** (`whisper-<id>`, `id` 16 random base64url characters), so routing is enforced
by LiveKit, not by volume in the apps: the whisperer's token may publish one microphone track there and never
subscribe; listeners' tokens may only subscribe; and the server hands listener tokens only to the people the whisper
reaches right now. Both tokens are valid for joining for 5 minutes. LiveKit's signed webhooks report who joins a whisper
room, and anyone the whisper doesn't reach at that moment (an old token, someone who dropped out) is removed at once.

| type | body | result | who |
|---|---|---|---|
| `whisper.start` | `slot` (1–3, the list), and either `targets` (1–25 account keys, ≤ 64 chars each) or `channelId` (a voice channel) | `{ id, url, token, room, reached: [accountKey] }` | see below. Rate limited (10, then 2 a second) |
| `whisper.join` | `id` (≤ 32 chars) | `{ url, token, room }` (listen-only) | someone the whisper reaches now (else `not_found`). Rate limited (20, then 4 a second) |
| `whisper.stop` | `id` | | the whisperer (else `not_found`) |
| `voice.priority` | `on` (bool) | | turning on: a priority speaker in voice who can talk there. Rate limited (20, then 4 a second) |

**Who may whisper** (checked on every `whisper.start`, and again after every change in voice, roles, mutes or blocks:
a whisperer who no longer qualifies has the room closed, `whisper.ended` to everyone in it):

- the `whisper` ability ([built-in roles](#built-in-roles); on for members and up by default, adjustable, guests can
  be given it). Bots never whisper. Otherwise `forbidden`, key `whisper_not_allowed`.
- in a voice channel right now, per LiveKit's webhooks (`bad_request`, key `whisper_not_in_voice`). Not on a stage
  (`bad_request`, key `whisper_stage`): stages keep their speaker rules. Not in an
  [encrypted](#end-to-end-encrypted-channels) voice channel (`bad_request`, key `whisper_e2ee`): whisper audio isn't
  end-to-end encrypted, so it's off there rather than quietly weaker.
- not server-muted and not forced quiet by the [AFK channel](#afk-channel) (`forbidden`, key `whisper_muted`).
- to a channel: one you can see (else `not_found`), a `voice` channel (a stage: key `whisper_stage`; other kinds:
  key `whisper_voice_only`; encrypted: key `whisper_e2ee`), where you may speak (`speak`: the channel's `writeRole` and
  overrides; else `forbidden`, key `whisper_channel`). So "only leads can whisper to Leads" is the Leads channel's
  speak permission.
- `targets` empty after leaving yourself out: `bad_request`, key `whisper_no_targets`. Both or neither of `targets` and
  `channelId`: `bad_request`.

**Who a whisper reaches**, worked out again after every change: the targets (or everyone in the target channel) who are
in a `voice` channel on this server that the whisperer can see, except the whisperer, bots, people the AFK channel
deafens, and anyone either of the two has [blocked](#blocking). Nobody hears more than 8 whispers at once (further
ones skip them). Someone joining the target channel, or a listed person joining voice, is reached from then on;
someone who leaves, moves where the whisperer can't see, or blocks is removed from the room.

- One whisper per list: `whisper.start` again with the same targets freshens it (same `id` and room, `reached` worked
  out again, a new token); other targets on that list close the old one first. Apps call it on every key press.
- A whisper nobody started again for 10 minutes is closed. Apps stop theirs after 30 s without whispering, and keep
  the room up until then so the next press is instant.
- While whispering, apps stop sending to their own channel and publish the same processed microphone (noise
  suppression, the same settings) into the whisper room. The soundboard isn't part of a whisper (sounds play to the
  channel, as always).
- Whisper rooms are kept in memory only; LiveKit going down ends them all.

| event | body | sent to |
|---|---|---|
| `whisper.incoming` | `{ id, from, channelId }` (`channelId`: the target channel, or null for a list) | each person the whisper now reaches. Their app joins with `whisper.join` and shows "X is whispering to you" while X's track there is live |
| `whisper.ended` | `{ id }` | listeners who are no longer reached, everyone when it closes, and the whisperer when the server closed it |
| `whisper.reach` | `{ id, reached }` | the whisperer, when who it reaches changes |

**Priority speaker**: the permission `prioritySpeaker` ([roles](#roles-and-permissions); admins have it by default,
the starter templates' Moderator roles too, and any custom role or `trusted` can be given it). While a priority
speaker holds their priority key (or always, if they choose that), their app sends `voice.priority { on: true }`, and
`voice.state` participants show `priority: true` (never while they're muted, server-muted or forced quiet by the AFK
channel). Listeners' apps turn everyone else down while a participant with `priority` is speaking (by 12 dB unless the
listener picked another amount) and show a badge. That part is on each device; the server only says who has priority.

- `voice.priority { on: true }`: without the permission `forbidden`, key `priority_not_allowed`; not in voice
  `bad_request`, key `priority_not_in_voice`; where you can't talk (no `speak`, a stage audience, server-muted, the AFK
  channel) `forbidden`, key `priority_cant_talk`. `on: false` always works. Losing the permission turns it off.
- `voice.join` answers gain `whisper` (you may whisper from this channel) and `priority` (you're a priority speaker),
  for what the app offers; every use is checked again.

## Game nights: teams and looking for group

### Team splits

Someone who can move members splits the people in a voice channel into 2–8 teams, each in its own temporary voice
channel. The app makes the teams (random, balanced by a skill number set for that session, or picked by captains) and
shows them for reshuffling; nothing reaches the server until "Go".

```jsonc
TeamSplit { "id": 4, "channelId": 7,              // the voice channel everyone came from
            "game": "Valheim" | null, "createdBy": "<accountKey>", "createdAt": 0,
            "teams": [{ "name": "team-1", "channelId": 12 }] }   // in team order; a team whose channel is gone is left out
```

| type | body | result | who |
|---|---|---|---|
| `teams.start` | `channelId` (a voice channel you can see), `teams` (2–8 lists of account keys, each 1–50 people), `names?` (one per team, 1–32 characters, channel name rules; default `team-1`, `team-2`, …), `game?` (1–50 characters) | `{ split }` | `moveMembers` (`forbidden`, key `teams_move`) |
| `teams.end` | `id` | `{ moved }` (how many were moved back) | `moveMembers` (key `teams_move`), and you can see the split's voice channel, or one of its team channels once that's gone (`not_found` otherwise) |
| `teams.list` | | `{ splits }` | anyone: the splits whose voice channel they can see |

- **Who can be split:** everyone listed must be in that voice channel right now (who is in voice comes from LiveKit's
  webhooks, as always; `bad_request`, key `teams_not_here`, args `{ name }`), be listed once (`teams_twice`), not be a
  bot (`teams_bot`), and be yourself or ranked below you, as for `voice.move` (`forbidden`, key `rank_members`). Other
  checks: a voice channel (`teams_voice_only`), 2–8 teams (`teams_count`, args `{ min, max }`), no empty team and ≤ 50
  per team (`teams_size`, args `{ max }`), a game name of 1–50 characters (`teams_game`, args `{ max }`), one split at a time per voice channel (`teams_active`), ≤ 10 splits per
  server (`teams_max`, args `{ max }`), not a team channel itself (`teams_nested`), and not an
  [encrypted](#end-to-end-encrypted-channels) voice channel (`teams_encrypted`: its team channels couldn't be).
- **The team channels** are ordinary voice channels the server creates, one per team: the voice channel's category,
  read and write roles, role overrides and hi-fi setting (no user limit), placed right after it. So they follow the
  voice channel's permissions; anyone who could join it can join them. Everyone listed is moved like a moderator's
  `voice.move` (a full channel is no obstacle): their sessions get `voice.moved { channelId, reason: "teams" }` and
  they count as gone from the old room at once; LiveKit removes them from it 3 seconds later if their app hasn't left
  by itself (so the removal can't end an app's voice session before the move reaches it).
- **Bring everyone back:** `teams.end` moves everyone in the team channels whom you may move (yourself and people
  below you) back to the voice channel (`voice.moved` with `reason: "teams"`), then deletes the team channels that are
  empty. If the voice channel was deleted meanwhile, nobody is moved.
- **Cleanup:** about every 30 seconds the server deletes team channels that have been empty for 5 minutes (counted
  from their creation, or from the server's start for older ones). A split ends when its last team channel is gone
  (including one an admin deleted).
- Events: `teams.split { split }` to readers of the voice channel when a split starts or loses a team channel;
  `teams.ended { id }` to everyone when it ends. The usual `channels` events announce the team channels coming and going.
- Audit `teams.start` (`{ channelId, name, teams, people }`) and `teams.end` (`{ channelId, name, moved }`).
- Rate limits: splits that go ahead, 3, then 1 every 10 s (refused requests only count towards the general bucket);
  `teams.end` 5, then 1 every 2 s.
- Storage: `team_splits` and `team_channels` (migration `teams-1`).

The app also offers `/teams` in the composer: an app command (listed with the bot commands, never sent) that opens the
splitter for the voice channel you're in on that server.

### Looking for group

An LFG post ("Looking for 3 for Valheim, tonight 20:00, voice: lounge") is a message with an `lfg` field, in a text
channel. People tap Join until the slots are filled.

```jsonc
// Message gains: "lfg": Lfg | null
Lfg { "game": "Valheim", "slots": 3,              // how many more people the poster is looking for
      "startAt": 0 | null, "voiceChannelId": 7 | null, "note": "Chill run" | null,
      "joined": ["<accountKey>"],                 // in join order, current members only
      "expiresAt": 0, "closedAt": 0 | null }
```

| type | body | result | who |
|---|---|---|---|
| `lfg.create` | `channelId` (a text channel), `game` (1–100 characters), `slots` (1–20), `startAt?` (ms, from 5 minutes ago up to 7 days ahead), `voiceChannelId?` (a voice or stage channel you can see), `note?` (≤ 200 characters) | `{ message }` | channel writers |
| `lfg.join` | `id` (the message) | `{ lfg }` | channel readers except the poster, while open and not full |
| `lfg.leave` | `id` | `{ lfg }` | anyone who joined, while open |
| `lfg.close` | `id` | | the poster, or someone who may delete their messages |
| `lfg.notify.get` | | `{ on }` | anyone (their own) |
| `lfg.notify.set` | `on` (bool) | `{ on }` | anyone (their own) |

- The message `text` is plain English for any app ("Looking for 3 for Valheim"); apps show the post from `lfg`. LFG
  posts can't be edited (`bad_request`, key `lfg_no_edit`); deleting the message deletes the post. Not in encrypted
  channels (the server would have to read it). AutoMod checks the game and note; slowmode applies.
- Refusals: `lfg_channel` (not a text channel), `lfg_game` (args `{ max }`), `lfg_slots` (args `{ min, max }`),
  `lfg_time`, `lfg_voice` (not a voice or stage channel you can see), `lfg_note` (args `{ max }`), `lfg_closed`,
  `lfg_full`, `lfg_own` (joining your own post).
- **Expiry:** a post closes 2 hours after `startAt`, or 24 hours after it was posted when it has no time
  (`expiresAt`); the server sets `closedAt` within a few seconds. Joining twice, or leaving when you haven't joined,
  changes nothing.
- **Notifications:** each join sends `lfg.joined { id, channelId, accountKey, lfg }` to the poster's sessions and a
  [push](#push-notifications-web-push) of kind `lfg`. The first time a post fills up, the poster and everyone who
  joined get `lfg.full { id, channelId, lfg }` and a push (apps show it with a "Join voice" button when the post names
  a voice channel). A full post opens again if someone leaves, but doesn't ping again.
- **Notify me for LFG** (per server, off by default): members who turn it on get `lfg.posted { id, channelId, author,
  game }` and a push for new posts in channels they can read (never their own, nor from someone either of them blocked).
- Pushes carry `kind: "lfg"`, `channelId` and `messageId`, with `text` titles `lfgJoined`, `lfgFull` and `lfgPosted`
  and bodies `lfgIn` ("In #channel") and `lfgTime` (args `{ name, game, slots?, channel? }`).
- Event `lfg.updated { id, channelId, lfg }` to channel readers after every join, leave, close and expiry.
- Rate limits: posts that go ahead, 3, then 1 every 30 s; `lfg.join` and `lfg.leave` 10, then 1 a second.
- Storage: `lfg_posts`, `lfg_members` and `lfg_notify` (migration `lfg-1`). Who joined which post and the notify
  setting are in "Download my data" and deleted with the account.

## Join-to-create voice rooms

An admin flags a voice channel as a **lobby**. Nobody stays in a lobby: joining it makes a temporary voice channel of
your own ("alice's-room") right under it, puts you there, and makes you its **host**. The host renames it, sets a user
limit and locks it; rooms are deleted once empty, like [team channels](#team-splits).

```jsonc
// Channel gains:
"lobby": false,                                   // voice channels: joining makes a room instead (always false elsewhere)
"room": null | { "lobbyId": 7,                    // the lobby it was made from (which may be gone by now)
                 "host": "<accountKey>", "locked": false,
                 "invited": ["<accountKey>"] }    // who may join while it's locked, in invite order (≤ 50)
```

| type | body | result | who |
|---|---|---|---|
| `channel.create`, `channel.update` | gain `lobby?` (bool) | | admins (`manageChannels`), voice channels only (`bad_request`, key `lobby_voice_only`); never a room (`lobby_room`), the [AFK channel](#afk-channel) (`lobby_afk`; and `afk.update` refuses a lobby, key `afk_lobby`) or an [encrypted](#end-to-end-encrypted-channels) channel (`lobby_encrypted`) |
| `voice.join` | `channelId` of a lobby | as usual, for the new room; the result gains `channelId` (the channel the token is for: the room here, the channel asked for everywhere else) | anyone who may connect to the lobby; not bots (`lobby_bot`) |
| `room.update` | `channelId` (a room you can see), `name?` (1–60 characters, channel name rules; key `room_name`, args `{ max }`), `userLimit?` (0–99), `locked?` (bool) | `{ channel }` | the host, or `manageChannels` (`forbidden`, key `room_host_only`); not a room: `bad_request`, key `room_only` |
| `room.invite`, `room.uninvite` | `channelId`, `accountKey` (a member; for `room.invite` one who may connect, else `forbidden`, key `they_cant_join`) | `{ channel }` | the host or `manageChannels`; ≤ 50 invites (`room_invites_max`, args `{ max }`) |

- **The room** is an ordinary voice channel the server creates when `voice.join` names a lobby: named `<display
  name>'s room` under channel name rules (`alice's-room`, up to 60 characters), with the lobby's category, read and
  write roles, role overrides, hi-fi setting and user limit, placed right after the lobby and the rooms it already has.
  `voice.join` then hands out the token for the room, and the usual `channels` event (sent to everyone before the
  answer) announces it. A LiveKit join to the lobby itself (an old token) is removed. Up to 100 rooms per server
  (`rooms_max`, args `{ max }`).
- **Locked:** `voice.join` answers `room_locked` (key `room_locked`, args `{ name, host }`) unless you are the host,
  invited, someone a moderator moved there in the last minute (`voice.move` works as for a full channel) or someone who
  can move members (`moveMembers`, as for [user limits](#voice-user-limits)); LiveKit joins are checked again. Locking
  removes nobody already inside. Invites die with the room.
- **Host:** whenever the room's voice state changes, if the host isn't in it the room passes to whoever has been there
  longest (never a bot); an empty room keeps its last host until someone comes in. The `channels` event carries the change.
- **Cleanup:** about every 10 seconds the server deletes rooms that have been empty for 30 seconds (counted from their
  creation, from the server's start for older ones, and not while someone moved there is still on their way in).
  Deleting the lobby, or turning its flag off, leaves its rooms alone until they empty.
- Audit: `channel.create` details gain `lobby`; `channel.update` changes gain `lobby: { from, to }`. Rooms themselves
  (their creation, renames, locks, invites) never reach the audit log.
- Rate limits: rooms that get made, 5, then 1 every 10 s per session (refused joins only count towards the general
  bucket); `room.update` 10, then 1 a second; `room.invite` and `room.uninvite` 20, then 2 a second.
- Storage: `voice_lobbies`, `voice_rooms` and `voice_room_invites` (migration `rooms-1`), dropped with the channel.

## Disappearing messages

A conversation can make its new messages disappear after a set time, as in Signal: **off, 5 minutes, 1 hour, 8 hours,
1 day, 7 days or 4 weeks** (`seconds`: 0, 300, 3600, 28800, 86400, 604800, 2419200; anything else is `bad_request`, key
`disappear_timer`). Each message gets its expiry when it is stored and keeps it; changing the timer only affects messages
sent afterwards. The server deletes expired messages; apps delete their own copies at the same time, even after being
offline (each copy keeps its deadline).

```jsonc
Disappear { "scope": "channel" | "dm" | "group", "channelId" | "accountKey" | "groupId": …, "seconds": 3600,
            "setBy": "<accountKey>", "setAt": 1760000000000 }
```

| type | body | result | who |
|---|---|---|---|
| `disappear.set` | one of `channelId`, `accountKey` (the other person in a DM, or yourself), `groupId`; `seconds` | `{ timer: Disappear }` | channels: `manageChannels` and able to read it (`not_found` otherwise), text, voice and stage channels only (`bad_request`, key `disappear_kind`; threads follow their channel); DMs: either person (not if either blocked the other); groups: any member (`not_found` for anyone else). 1/s, burst 10 |
| `disappear.list` | | `{ timers: [Disappear] }`: channels you can read, your DMs (`accountKey` = the other person) and your groups | anyone |

| event | body | sent to |
|---|---|---|
| `disappear.changed` | `{ timer }` | channels: its readers; DMs: both people (each sees the other as `accountKey`); groups: its members |

- **Messages gain `expiresAt`** (ms, or null): `Message`, `dm.message`/`dm.history` and `GroupMessage`. It is set when the
  message is stored: `createdAt` + the timer then (a thread's message: its channel's), or + the envelope header's
  `expires` if that is sooner (below). Every way into a channel follows the timer (bots, webhooks, polls, clips), except
  imported history. Edits never move it.
- **The change line.** In channels the server adds a message whose `disappear: { seconds }` says what was set (by whom:
  `author`); it never expires itself. Its `text` is an English line for apps from before disappearing messages, and `""`
  in encrypted channels. In DMs and groups the app that changed the timer sends the line itself, encrypted: content
  `{ "text": "<fallback for older apps>", "disappear": { "seconds": n } }` in a normal (v2) envelope that doesn't
  expire. Apps send with the stricter (shorter, not off) of the servers' timer and the newest change line they read,
  so a server can't quietly turn a DM's or group's timer off.
- **Push** leaves the text of a disappearing channel message out ("Open Iskra to read it."), so it doesn't outlive the
  message in a notification centre. Apps close their own notifications when the message goes, and don't offer saving
  or reminders for disappearing messages (both keep a copy).

### End-to-end encrypted messages carry their expiry

An encrypted message names its expiry in its header as `expires` (seconds, one of the timers), bound to the message so a
server can't stretch it. Apps delete their copy at the **sooner** of the server's `expiresAt` and
`min(header.sentAt, createdAt) + expires`, so neither a server nor a sender's clock can make it last longer. These are new
envelope versions, so apps from before disappearing messages can't open them ("couldn't be read") and never keep their
text; messages without a timer keep the older versions everyone reads.

- **DMs: envelope `v: 3`** = v2 with `header.expires`; associated data `JSON.stringify(["iskra/dm/v3", from, to, sentAt, id, expires])`.
- **Group DMs: `v: 3, kind: "group"`** with `header.expires`; associated data `JSON.stringify(["iskra/group-dm/v2", from, group, version, head, sentAt, id, expires])`.
- **Encrypted channels: `v: 3, kind: "channel"`** with `header.expires`; `ad = JSON.stringify(["iskra/channel-msg/v3", from, chain, version, head, sentAt, id, channel, thread ?? 0, edit ?? "", expires])`, signed under `iskra/channel-msg/v3`. An edit of a v3 message is v3 with the same `expires`.
- Receivers refuse a v3 envelope without a valid `expires`, and an older envelope with one. The server reads `expires`
  from the header (`bad_request`, key `disappear_timer`, if it isn't one of the timers) and stores the sooner expiry; it
  never needs to read anything else.

### Deletion

- The server sweeps every 5 seconds. A channel message goes with its reactions, pins, poll, edit history, inbox entries
  and search entry, and a thread started from it goes with the thread (`chat.deleted` and `thread.deleted` to readers).
  DM and group envelopes go too. Files go with their messages, record and stored content, unless something else still
  uses them (another message, an avatar, emoji, a profile page, a docs page, a bot card, an open report); encrypted
  files lose their access list, so `dm.file.url` answers `not_found`. Deleted rows are overwritten in the database
  (`secure_delete`; the search index too where SQLite supports it) and the write-ahead log is checkpointed.
- **Backups never contain disappearing messages:** when a backup is made, messages with an expiry (and their threads and
  files) are taken out of the copy, which is then rebuilt (`VACUUM`), so nothing of them is in it. Restoring or moving a
  server from a backup doesn't bring them back.
- `data.export` adds `disappearingTimers` (timers you set, and those of your DMs and groups). Messages that disappeared
  are gone and not listed.
- What disappearing messages can't do: stop people taking screenshots, copying text or saving files before the time is
  up; delete copies on a device whose app is from before disappearing messages (plain channel messages: those apps drop
  them when the server deletes them while they're open); or take back a reply's quote or a forward someone made.

## Translation models

Members translate messages on their own device (Bergamot with Mozilla's Firefox Translations models,
[docs/voice-processing.md](../docs/voice-processing.md#message-translation)), after decryption, so it works for
end-to-end encrypted messages too; no message text is ever sent for translation. The models come from the group's own
server, the same way as the [captions model](#live-captions-model), except that the owner turns it on, and each model
is fetched only when a member first needs it.

- **Pins.** `client/src/state/translate/models.json` (compiled into the app and the server; written by
  `scripts/translate-pins.mjs`): one entry per model, always to or from English (`en-sv`, `sv-en`, ...; other pairs go
  through English on the device). Each has a `dir` (`translate-<from><to>-<8 hex>`), the upstream `source` (Mozilla's
  model storage) and three files (`model.bin.gz`, `lex.bin.gz`, `vocab.spm.gz`): each `from` (the path of Mozilla's
  pinned training run), SHA-256 and size of the gzip file as served, SHA-256 and size `unpacked`, and parts of at most
  20 MiB, each with its own SHA-256 and size. About 15-26 MB per model.
- **`translate.models.link`** (request, any member, empty body; limit 10, then one a second) → `{ offered: false }`
  unless the owner offers translation, else `{ offered: true, models: ["en-sv", ...], path: "/models/translate",
  query: "a=<accountKey>&exp=<ms>&sig=<b64u>", expires }`. `sig` = HMAC-SHA-256 with a random per-process key over
  `"iskra/translate-models-link/v1\0<accountKey>\0<exp>"`; valid for an hour, for every model.
- **`GET /models/translate/<dir>/<part>?<query>`**, where `part` is `<file>.part<n>.bin`: as for the captions model.
  Anything that isn't a pinned part is `404`, as is everything while the owner doesn't offer translation; without a
  valid link (missing, wrong signature, expired or too far ahead, a captions link, or an account that is no longer a
  member) `403` and nothing is fetched. The first linked request for a model makes the server fetch that model's files
  once from `source` (HTTPS, size-capped), check every file and part against the pins and write them atomically to
  `models/translate/<dir>/`; on a mismatch nothing is kept and the answer is `502`. Then `200`,
  `application/octet-stream`, `Cache-Control: private, max-age=31536000, immutable`, byte ranges allowed. `HEAD`,
  `OPTIONS` and `Access-Control-Allow-Origin: *` as for captions.
- **Limits.** 40 requests at once per client address, then one every 2 seconds (`429`); a model is 3-4 parts.
- **`translate.config`** (request, the owner: `forbidden`, key `owner_translate`; empty body) →
  `{ offer, downloaded: ["en-sv", ...] }` (the models already on the server).
- **`translate.configure`** (request, the owner; `{ offer: boolean }`, required; limit 10, then one a second) → the
  same as `translate.config`. Saved to server.json `Translate.Offer` (default `false`). Security log `translate.settings`.
- **Apps.** They detect a message's language on the device (ELD), ask for the link only when a model isn't on the
  device yet, download only after the person agreed (the size is shown first), check every part, unpack (gzip), check
  the unpacked file, and keep the parts on the device under a key that doesn't depend on the server or the link.
- `Translate.ModelSource` (server.json, optional): a folder laid out like `scripts/get-models.mjs --translate` writes it
  (`<folder>/<dir>/<part>`), used instead of `source` (development and tests; the same checks apply).

## Whiteboards

A shared drawing board with an infinite canvas: pen, highlighter, eraser, lines, arrows, rectangles, ellipses, text,
sticky notes and pictures from this server's uploads. A **whiteboard channel** (`channel.create` with
`kind: "whiteboard"`) has one board that stays. A **voice channel** can have one board too: someone in the call opens
it, and it stays (for this call and the next) until it's cleared. Viewing follows the channel's read access; drawing
follows posting (`send`: a whiteboard channel's `writeRole`, a voice channel's text chat). Bots can't use whiteboards
(`forbidden`). A whiteboard channel can be [end-to-end encrypted](#end-to-end-encrypted-channels) like a text channel,
and a board in an encrypted voice channel is encrypted with that channel's keys.

### The board model

A board is a set of **objects**, each a flat record of fields. Every change is an **op**: an object id and the fields to
set (`null` removes a field). Ops travel in **batches**; the server gives every batch the board's next `seq` and sends it
to everyone viewing the board in that order, so every app applies the same ops in the same order and ends up with the
same board. Each field is a last-writer-wins register (a register CRDT ordered by the server): a field set later wins,
so two people moving and recolouring the same shape at once both take effect. An object is shown while it has a `kind`
and `d` (deleted) isn't `true`. Undo is per person and kept in the app: it sends the fields an object had before (for a
delete: all of them, with `d: false`), and redo sends them back.

```jsonc
Op { "id": "<8–24 chars of A–Z a–z 0–9 _ ->", "p": { "kind": "pen", "x": 10, "y": 20, … } }
```

| field | value |
|---|---|
| `kind` | `pen`, `hl` (highlighter), `line`, `arrow`, `rect`, `ellipse`, `text`, `note` (sticky note) or `image` |
| `x`, `y` | position (a number, \|n\| ≤ 1,000,000) |
| `w`, `h` | size; lines and arrows run from (x, y) to (x + w, y + h), so these may be negative (\|n\| ≤ 1,000,000) |
| `pts` | pen and highlighter: whole numbers in tenths, relative to (x, y): the first point, then the step to each next one (`[x0, y0, dx1, dy1, …]`); 2–4000 numbers, an even count, \|n\| ≤ 10,000,000 |
| `color` | `#rrggbb` (lowercase) |
| `fill` | `#rrggbb` |
| `size` | stroke width or font size, 1–200 |
| `text` | text and notes: up to 2000 characters, newlines allowed |
| `src` | pictures: `/files/<id>/<name>`, an image uploaded to this server |
| `z` | stacking order (a number, \|n\| ≤ 1,000,000,000); ties go by `id` |
| `d` | `true`: deleted |

Unknown fields, wrong types and values out of range are refused (`bad_request`). A batch holds 1–200 ops and is at most
48 KB as JSON. Apps draw text on the canvas (never as HTML).

### Requests and events

```jsonc
Board { "channelId": 7, "id": "<b64u 12>",           // a new id whenever the board is cleared
        "seq": 41,                                    // the newest batch (0: none yet)
        "openedBy": "<accountKey>" | null, "openedAt": 1760000000000,
        "encrypted": false }
Batch { "seq": 41, "by": "<accountKey>", "at": 1760000000000,
        "ops": [Op] }                                 // encrypted boards: "version": 3, "envelope": BoardEnvelope instead
Snapshot { "seq": 40, "at": 1760000000000,
           "objects": { "<id>": { …fields } } }       // encrypted boards: "by", "version", "envelope" instead of "objects"
Live { "x": 120.5, "y": -40, "tool"?: "pen",
       "draft"?: { "id", "kind", "color", "size", "from": 0, "pts": [...] } }   // the stroke being drawn
```

| type | body | result | who |
|---|---|---|---|
| `wb.boards` | | `{ boards: [Board] }` | anyone: the open boards of voice channels you can read |
| `wb.open` | `channelId` (a voice channel) | `{ board }` | someone in the call who can post in its chat; answers the open board if there is one |
| `wb.get` | `channelId, since?` (a `seq`) | `{ board, snapshot, batches, hasMore, viewers, wantSnapshot }` | readers |
| `wb.leave` | `channelId` | | anyone |
| `wb.update` | `channelId, boardId, cid?` (≤ 24 chars), `ops` and `live?`, or (encrypted) `version, envelope` | `{ seq }` | writers |
| `wb.live` | `channelId, boardId, live` (encrypted: `version, envelope`) | | readers viewing the board |
| `wb.snapshot` | `channelId, boardId, seq, version`, `envelope` or `file` | | encrypted boards only: writers in the channel's chain |
| `wb.clear` | `channelId, boardId` | | writers who can [pin](#pins) there (trusted+ or `manageMessages`), or, on a voice channel's board, whoever opened it |

- **Loading:** `wb.get` without `since` answers the latest snapshot (or `null`) and the batches after it, oldest first,
  up to about 1 MB of them (`hasMore`: ask again with `since` = the last `seq`). With `since` it answers only batches
  after it (and the snapshot too when `since` is older than the snapshot). A whiteboard channel always has a board (made
  on the first `wb.get`); a voice channel without an open board answers `board: null`. `wb.get` also makes this session
  a **viewer** of the board until `wb.leave`, a `wb.get` for another channel (one board per session) or disconnecting.
- **Sending:** `wb.update` names the board's `id`; a cleared board's id is `not_found` (the app loads the new board).
  The batch goes to every viewer as `wb.batch` (the sender's own sessions too, with its `cid`, so the app knows its own
  batch arrived), in `seq` order. `live` goes on to the other viewers as a `wb.live`.
- **Live cursors:** `wb.live` (≤ 8 KB) goes to the board's other viewers and isn't stored. `draft` carries the stroke
  being drawn from point index `from` on (the app appends them to what it has). Apps send at most one of `wb.update`
  and `wb.live` every 200 ms.
- **Viewers:** `viewers` (and the event `wb.viewers`) lists the accounts viewing the board now.
- **Compaction:** on a plain board the server folds older batches into the snapshot itself once 500 batches or 512 KB
  have piled up since the last one; deleted objects are dropped then. Encrypted boards: see below.
- **Size:** a board's snapshot plus the batches after it may be at most 6 MB; past that, batches that add anything are
  refused (`bad_request`, key `wb_full`), while batches that only delete objects are taken (encrypted boards: see below). A plain snapshot holds at
  most 20,000 objects and 4 MB; a compaction that would pass that leaves the batches as they are.
- **Pictures:** `src` must name an image uploaded to this server (`bad_request` otherwise). The unused-upload sweep keeps
  files a board refers to.
- **Clearing** deletes the board's batches and snapshot. A whiteboard channel starts a new empty board (a new `id`); a
  voice channel's board closes. Audit `wb.clear` `{ channelId, channelName }`.
- **Safety:** AutoMod checks the `text` of every op on a plain board (`automod` with `what: "whiteboard"`); timed-out
  members get `forbidden` and members who must still agree to the [rules](#server-rules) get `rules_required` for
  `wb.open`, `wb.update`, `wb.live`, `wb.snapshot` and `wb.clear`.
- **Rate limits:** `wb.update` 8/s (burst 20), `wb.live` 8/s (burst 10), `wb.get` 5/s (burst 20), `wb.open` and
  `wb.clear` 1 every 5 s (burst 5), `wb.snapshot` 1 every 10 s (burst 5).

| event | body | sent to |
|---|---|---|
| `wb.batch` | `{ channelId, boardId, batch: Batch, cid?, wantSnapshot? }` | the board's viewers who can read the channel |
| `wb.live` | `{ channelId, boardId, accountKey, live }` (encrypted: `version, envelope` instead of `live`) | the board's other viewers |
| `wb.viewers` | `{ channelId, viewers }` | the board's viewers |
| `wb.snapshot` | `{ channelId, boardId, seq }` | the board's viewers (encrypted boards: a new snapshot arrived) |
| `wb.board` | `{ channelId, board: Board \| null }` | readers of a voice channel (its board was opened or cleared) |
| `wb.cleared` | `{ channelId, boardId }` | readers of the channel |

### Encrypted boards

In an encrypted channel the server never sees the board. Batches, snapshots and live cursors are **board envelopes**,
sealed with the channel's current [epoch key](#epoch-keys) and signed by the sender's device, like channel messages:

```jsonc
BoardEnvelope { "v": 1, "kind": "wb",
  "header": { "from": "<accountKey>", "chain": "<chain id>", "version": 3, "sentAt": 1760000000000, "id": "<b64u 12>",
              "channel": 7, "board": "<board id>", "what": "ops" | "snapshot" | "live", "seq"?: 40 },
  "sender": DeviceCert, "nonce": "<b64u 24>", "ct": "<b64u>", "sig": "<b64u 64>" }
```

- `ad = JSON.stringify(["iskra/wb/v1", from, chain, version, head, sentAt, id, channel, board, what, seq ?? 0])`
  (`head` of that version, from the verified chain); `ct = XChaCha20-Poly1305(epochKey, nonce, content, ad)`;
  `sig = Ed25519.sign(deviceSecret, "iskra/wb/v1" || 0x00 || u64be(len(ad)) || ad || u64be(24) || nonce || ct)`.
- Content: `ops` → `{ "ops": [Op] }` (the same rules as a plain batch, checked by the apps); `snapshot` →
  `{ "objects": { … } }` (the board after batch `seq`); `live` → a `Live`.
- **The server** checks that the header's `from`, `chain`, `version` (the current one, else `conflict`), `channel`,
  `board`, `what` and (snapshots) `seq` match the request, and that the sender is in the chain. An envelope is at most
  48 KB (`ops`), 8 KB (`live`) or 6 MB (`snapshot`: bigger than a frame, so apps upload it with `upload.begin` and pass
  `file`: their own upload, which the server reads; the unused-upload sweep deletes it a day later).
- **Apps** check what they check for channel messages (chain, version, membership at that version, device certificate
  and signature, and that `channel` and `board` are where it arrived), drop an envelope whose `id` they already applied,
  and skip a batch they can't open (the board says some changes couldn't be opened).
- **Snapshots:** the server can't fold encrypted batches, so the apps do. `wantSnapshot` (in `wb.get`, and on
  `wb.batch`) is true once 300 batches or 512 KB have piled up since the last snapshot, or when the snapshot or a batch
  after it is sealed under an older epoch than the current one (someone joined or left since, and newer members can't
  read older epochs). A writer in the chain whose app has the whole board open then uploads a snapshot of it, after a
  short random wait (another app may do it first: the `wb.snapshot` event). The server takes a snapshot only for a
  `seq` newer than the current snapshot's and at most the board's, and deletes the batches up to it. With more than
  4 MB of batches since the snapshot, `wb.update` answers `bad_request` with key `wb_compact` until one arrives (the app
  makes one and sends again); the same goes for a board past 6 MB in all while it has batches since its snapshot (a
  snapshot drops deleted objects), and `wb_full` once it has none. A board that nobody who can read its older epochs opens stays unreadable to newer members
  until someone who can opens it.
- **Not on encrypted boards:** pictures (the server could read them) and AutoMod.
- **Limits:** as with channel messages, a removed member keeps the old epoch keys, and the server could replay an older
  batch of the same board: apps drop envelope ids they've seen and batches signed more than 10 minutes before the
  snapshot they started from.

### Storage, your data and templates

- Migration `whiteboard-1`: `wb_boards` (one per channel: id, seq, snapshot, who opened it), `wb_batches` (seq, author,
  ops or envelope, epoch version) and `wb_files` (uploads a plain board refers to). They go with their channel.
- **Your data:** `data.export` includes `whiteboardBatches`: the batches you sent that aren't folded into a snapshot yet
  (plain ones with their ops, encrypted ones with their size only). Folded batches keep no author. **Deleting an
  account** with `messages: true` removes the authorship of its unfolded batches (`by` becomes `""`); the drawing stays
  on the board, as a docs page's text does. Boards aren't messages: retention doesn't delete them.
- [Starter templates](#starter-templates) can create whiteboard channels (`"kind": "whiteboard"`; no slowmode).
- [Disappearing messages](#disappearing-messages): a whiteboard channel can't have a timer (`bad_request`, key
  `disappear_kind`), and a voice channel's timer applies to its text chat only; its board stays until it's cleared.

## Channel topics and template content

`Channel` gains `topic` (string; `""` = none): one line saying what the channel is for, shown at the top of the channel.
`channel.create` and `channel.update` take `topic?`: up to 300 characters on one line, trimmed and NFC-normalized, no
control or invisible formatting characters (else `bad_request`, key `channel_topic`, args `{ max }`); blank removes it;
an update that leaves it out keeps it. Admins only, as with every channel setting. It's plain text the apps render as
text; like the channel's name it isn't end-to-end encrypted, also in encrypted channels.

- Sent in `welcome.channels`, the `channels` event and the `channel` in each answer. Older apps ignore it.
- Audit: `channel.update` changes gain `topic: true` (never the text).
- Storage: `channel_topics(channel_id, topic)` (migration `topics-1`), dropped with the channel.

Templates (format 3, `docs/templates.md`) can also hold starting content, added once by `templates apply` or on a new
server: a channel's `topic`; `messages` (text channels, up to 10 per channel and 100 in all, each up to 4000
characters) posted as webhook-style messages with the author `webhook:template`, `webhook.name` the server's name and no
embeds, mentions made inert as in the bug inbox, optionally pinned (`pinnedBy` `webhook:template`); `pages` (docs
channels, up to 20 per channel and 50 in all, each up to 100 KB) created with `createdBy` `webhook:template`, one of them
optionally the server's Start here page; `disappear` (a channel's disappearing-messages timer, `set_by`
`webhook:template`); and `settings.translation` (offer translation models). `templates apply` adds each only where
there is none yet (no topic; no message from `webhook:template` in the channel; no page with that title; no timer row;
translation off), never posts into an end-to-end encrypted channel or one with disappearing messages, and leaves the
bug inbox off when the existing channel of that name is readable by more people than the template says.
`iskra-server templates <file> --json` gains per-channel `topic`, `messages` (a count), `pages` (titles), `disappear`
and `settings.translation`. `server.template.export` gains `topic`, `disappear` and `settings.translation` (never
messages or pages); it writes `"version": 3` when it has any of them, else `2`, so older servers can still read it.

## Encrypted voice channels

A voice channel made [end-to-end encrypted](#end-to-end-encrypted-channels) (`channel.create` with `kind: "voice"` and
`e2ee`; at creation only, never later and never undone, as for every encrypted channel) carries its audio, video and
screen shares end-to-end encrypted: LiveKit only forwards ciphertext. There are no new requests or events; this is how
the existing pieces fit together.

- **Key.** Each member's app derives the media key from the channel's current epoch key:
  `crypto_kdf_derive_from_key(32, 1, "iskra-vc", epochKey)`, set as a raw 32-byte key (LiveKit derives the AES-GCM frame
  key from it with HKDF) in LiveKit key slot `version mod 16`. On joining, an app also loads the keys of up to 2 earlier
  epochs it holds into their slots, so people still sending under them are heard; it sends with the current one.
- **Rotation.** Every chain change (someone added or removed, a rekey) is a new epoch with a new random key. Apps in
  the room switch to the new slot as soon as they have its key, without leaving the room (frames under the previous
  slots keep decrypting meanwhile), and only ever forward (a key for an older version never replaces a newer one).
  Someone removed at version n never receives the key of n or later, so they can't decrypt media sent after the switch.
- **Never plaintext.** An app that has no key for the current version doesn't join (it shows why); it never joins
  unencrypted. In an encrypted room apps never play a track LiveKit reports as unencrypted: they unsubscribe from it and
  mark the person in the call. Data messages in the room (clip announcements) are encrypted as well.
- **Who may be in the room** (server): `voice.join` in an encrypted channel needs your account in the channel's current
  chain, besides the usual read and connect checks: otherwise `bad_request`, key `e2ee_voice_waiting` (a member's app
  adds you when they're online), or `e2ee_voice_full` (args `{ max }`, 50 people hold the key already). LiveKit joins by
  anyone not in the chain are removed (the webhook check), and every `echan.change` re-checks who is in the room.
  `voice.move` into an encrypted channel needs the person in its chain (`forbidden`, key `e2ee_voice_they_waiting`). The
  LiveKit token is the usual one; the server stores only that the channel is encrypted, the chain and key envelopes.
- **Bots** never hold the key: `voice.join` by a bot is `bad_request`, key `bot_e2ee_voice` ([Voice bots](#voice-bots)).

How the other voice features behave in an encrypted voice channel:

| Feature | In an encrypted voice channel |
|---|---|
| Voice channel chat, voice messages, files | Encrypted, as in every encrypted channel |
| Captions, noise removal, translation | Work: they run on each device, after decryption |
| Clips | Work: recorded on the device as always; the "saved a clip" notice goes to the room as an (encrypted) data message on topic `iskra.clips` instead of the chat (`voice.clip` is refused), and sharing a clip uploads it encrypted. Who has clips on still shows (`voice.state` `clips`) |
| Soundboard | Works: the server relays which sound was played (`sound.played`, as everywhere); the sounds are the server's own files, not your media |
| Whiteboard in the call | Encrypted ([Encrypted boards](#encrypted-boards)) |
| Pop-outs, phones, the desktop app | Work (the frames are decrypted in the app's own worker) |
| Watch parties and listen together | Off: every `watch.*` request is `bad_request`, key `watch_e2ee` (the server would see what's played, titles and the chat). Apps show the button dimmed; a tap says why |
| Whispers | Off (`whisper_e2ee`); `voice.join` answers `whisper: false` |
| Team splits, join-to-create (lobby) | Off (`teams_encrypted`, `lobby_encrypted`) |
| AFK channel | An encrypted channel can't be the AFK channel (`afk.update`: `bad_request`, key `afk_encrypted`; the server moves people in, key or not). Idle people are never moved into one they have no key for |
| Stage channels | Can't be encrypted |
| Voice bots, music bots | Refused (`bot_e2ee_voice`) |
| [Activities](#activities) | Off: every `act.*` request for the channel is `bad_request`, key `act_e2ee` (the server relays what activities send, unencrypted). Apps show the button dimmed; a tap says why |

What it doesn't hide: the server (and LiveKit) still see who is in the room, when, who speaks and how much (packet
sizes and timing), mute and camera state, and soundboard plays. Everyone holding the key can decrypt everyone's media,
so a member's app could forward or record what it hears, as in any call.

## Quiet hours digest

When quiet hours end, people catch up with one summary instead of a pile of notifications. `Quiet` (see
[Keyword alerts and quiet hours](#keyword-alerts-and-quiet-hours)) gains `digest` (bool, optional, default `true`;
`alerts.get` always returns it; older servers ignore it). No new requests or events.

- **The stretch.** A server that stores a member's quiet hours (only where push is on for one of their devices) notes
  when the current quiet stretch began: at the minute it began by the schedule (at most 7 days back), as soon as it sees
  it running (checked every 30 seconds, and on `alerts.set`). The stretch ends when the schedule ends (in its own time
  zone, across clock changes), or at once when `alerts.set` turns quiet hours off (`quiet: null`) or moves them off
  the present moment.
- **The push.** When a stretch ends, if `digest` isn't `false` (for quiet hours turned off: the value they had), the
  server counts its own items from the stretch, as the member can see them now: pings in its [inbox](#inbox)
  (`mentions`: kinds `mention`, `reply`, `role`, `everyone`; `keywords`: `keyword`; `follows`: `follow`) in channels
  they can still read, DMs and group messages from others (`messages`; never their content: the server can't read
  them), [reminders](#reminders) that came due (`reminders`) and [events](#scheduled-events) they're interested in and can see that
  started or start within an hour after the end (`events`); nothing from or to people either of them blocked. Only if
  anything counted, each device that isn't looking at Iskra gets one push, without a sound:
  `{ kind: "digest", tag: "digest", title: "While it was quiet", body: "2 mentions, 1 message", text: { title: "digest",
  body: "digestBody", args: { mentions, messages, keywords, follows, events, reminders } }, silent: true }` (TTL 12
  hours, never merged). [Do not disturb](#presence-and-custom-status) still stops it. A click opens the server. Each server sums up only
  its own items; the apps show one card across all servers (below).
- **The apps.** Every open device shows a "While it was quiet" card when quiet hours end there (or the next time it
  opens, within a day), gathered on the device across every connected server: mentions and replies, DMs and groups
  (counts and who, never content), alert words, follows, events, due reminders, each opening its place; a server that
  is offline is listed as such. Dismissing it records the stretch as seen in the sealed `alerts` preference
  (`digestSeen`, the end time), so the card closes on the account's other devices too. "Summary when quiet hours end"
  (`digest`) turns off both the card and the push.
- Storage: `alert_settings.quiet_since` (migration `quietdigest-1`), deleted with the rest of the alert settings (leaving,
  removal, deleting the account); in "Download my data" under `alertSettings`.

## Public page

A browser that opens the server's own address gets an HTML page instead of the JSON above: `GET /` with an `Accept`
header that names `text/html` (a navigation). Anything else (the apps' `fetch`, curl, monitors) still gets
`{ iskra: 1, name, icon }`, unchanged. The page is rendered on the server with every user-written string HTML-encoded,
has no scripts, loads nothing from anywhere but this server, and works without JavaScript.

- **Off (the default):** the page says only that this is an Iskra server, with links to download Iskra
  (`https://iskra.foo/#download`, the releases page) and to open the web app (`AppUrl`). No name, icon, banner,
  description, counts or invite.
- **On:** the server's name, icon (`/icon`) and banner (its `/files/` address), the owner's description, and, each only
  when ticked, the start of the rules (up to 800 characters, cut at a word) and an approximate count of members and of
  members online now (people only, invisible members not counted; exact below 10, then rounded down to 5, 10 or 100).
  When the owner picked an invite: "Join in your browser" (`<AppUrl>/#/join/<token>`) and "Open in the Iskra app"
  (`iskra://join/<token>`), the [invite link](#invite-links) token built from the server's public address
  (`InternetUrl`, else `PublicUrl`, else the address the browser used) without a p2p secret. While invites are paused
  the page says so instead; once the invite is expired, used up or revoked the page asks people to get an invite from
  someone. An approval invite adds that a moderator lets them in.
- **Language:** Swedish when `Accept-Language` prefers `sv`, else English (`Content-Language`, `<html lang>`).
- **Headers:** `Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; img-src 'self'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'` (the one inline stylesheet by its hash), `Permissions-Policy` as for
  profile pages, `Cache-Control: no-store`, `Vary: Accept, Accept-Language`, and `X-Robots-Tag: noindex, nofollow`
  (plus `<meta name="robots">`) unless the page is on and the owner ticked "Let search engines list this page".
- **Limits:** 30 page loads at once per client address (IPv6: per /64), then one a second; over that `429` with
  `Retry-After: 10`. Addresses are used in memory for this only.

| type | body | result | who |
|---|---|---|---|
| `landing.get` | | `{ settings }` | owner (others: `forbidden`, key `owner_landing`) |
| `landing.update` | any of `enabled`, `description`, `showRules`, `showCounts`, `indexable` (bools but `description`), `invite` (an invite code; `""` or `null` removes it) | `{ settings }` | owner; rate limit 10, then 1 a second |

`settings`: `{ enabled, description, showRules, showCounts, indexable, invite: Invite | null, inviteGone }`. `invite`
is the chosen invite while it still works; `inviteGone` is true when one was chosen but has expired, been used up or been
revoked. Fields left out keep their value; everything defaults to off and empty.

- `description`: plain text up to 500 characters, newlines allowed, trimmed and NFC-normalized, no control or invisible
  formatting characters (else `bad_request`, key `landing_description`, args `{ max }`); blank removes it. Shown as
  text, never as HTML or Markdown.
- `invite`: must be an invite that still works (else `bad_request`, key `landing_invite`) for the member or guest role
  (else key `landing_invite_role`). The owner sees every invite (`invite.list`).
- Event `landing.settings { settings }` to all of the owner's sessions after every update.
- Audit `landing.update` (`{ enabled }`); security log `landing.settings` (`{ enabled, indexable, showRules,
  showCounts, invite: bool, descriptionChanged }`, never the text) when something changed.
- Storage: `landing_page` (one row: `enabled`, `description`, `show_rules`, `show_counts`, `indexable`,
  `invite_code`), migration `landing-1`. Server data, not personal data: no account keys.

## Backup buddies

A server's [automatic daily backups](#backups) can also go to **a friend's Iskra server** that agreed to keep them.
The friend's server (the **holder**) keeps them in a **spot** its owner made, with a size cap and a number of versions
the holder's owner chose. Every copy is encrypted on the server it came from (the **source**) before it's sent; only
the source's owner has the key (a recovery code). Nothing goes through Iskra or anyone else: the source talks to the
holder directly, over HTTPS (or plain HTTP on a local network). This is the one place where an Iskra server makes
requests to another Iskra server.

### Keys and the recovery code

- **Recovery code.** The first time a source adds a buddy, it makes a recovery code: 25 characters from Crockford's
  base32 alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 125 random bits), shown as five groups of five. Typed codes are
  normalized like [claim codes](#owner-claim-rented-servers) (upper case, spaces and `-` removed, `O` → `0`, `I`/`L` → `1`).
  The source keeps it (in its database) so it can encrypt every day without anyone around. One code covers all of a
  server's buddies, for good: it's never changed (a new one would orphan the copies already out there).
- **Encryption.** Each copy is a daily backup (`backups/auto-YYYY-MM-DD.zip`) encrypted in exactly the
  [`.iskrabackup` format](#backups) with the normalized code as the passphrase (Argon2id `ops` 2, `mem` 64 MB: the code
  is random, so the cost only needs to be modest). Header `name` and `createdAt` are the server's and the daily
  backup's. So a copy from a buddy also restores with plain `iskra-server restore`, using the recovery code as the
  passphrase. The holder never gets the code and never parses, opens or runs what it stores.
- **Restore key.** `seed = BLAKE2b-256("iskra/buddy-restore-key/v1" || 0x00 || utf8(normalized code))`, an Ed25519 key
  pair from that seed. The source registers its public half when it pairs, so whoever has the recovery code (and
  nobody else) can list and download the copies after the source machine is gone.
- **Server keys.** The source signs with its server key, the holder with its own; both are learned at pairing and
  checked on every request after it.

### Pairing

The holder's owner makes a spot (`buddy.spot.create`) and gets a **pairing code**:
`iskra-buddy:` + base64url(UTF-8 JSON `{ "v": 1, "url": "<holder address>", "key": "<holder server key>", "token": "<b64u 32 random bytes>" }`),
at most 1024 characters. It's single use and works for 24 hours; the holder keeps only the token's SHA-256. The
address is the holder's internet address if it has one, else its `PublicUrl` (the owner can give another).

The source's owner pastes it (`buddy.add`). The source then calls the holder:

`POST <url>/buddy/v1/pair` with JSON `{ token, sourceKey, restoreKey, name, at, sig, restoreSig }` (≤ 4 KB):
`sig = Ed25519.sign(sourceSecret, "iskra/buddy-pair/v1" || 0x00 || holderKey(32) || token(32) || restoreKey(32) || u64be(at) || utf8(name))`,
`restoreSig = Ed25519.sign(restoreSecret, "iskra/buddy-pair-restore/v1" || 0x00 || holderKey(32) || token(32) || sourceKey(32) || u64be(at))`
(proof that the restore key is held, so nobody registers someone else's key), `name` the source server's name
(1–100 characters), `at` within 5 minutes of the holder's clock. `sourceKey` and `restoreKey` must differ, and neither
may already be used by any spot on the holder, as a source key or a restore key (`409`): every key means one spot and
one role.

The holder answers `200 { spotId, quotaBytes, keep, graceDays, name, at, sig }`:
`sig = Ed25519.sign(holderSecret, "iskra/buddy-paired/v1" || 0x00 || sourceKey(32) || token(32) || u64be(at) || utf8(spotId))`.
The source checks it against the key in the pairing code before saving anything, so a code can only ever pair with the
server it names. Errors: `404` (no such token, used or expired; one answer for all three), `400` (malformed, a bad
signature or restore signature, clock off, the same key twice), `409` (a key is already used by a spot here), `429`
(see limits).

### Signed requests

Every request after pairing carries
`Authorization: IskraBuddy key=<b64u 32>, at=<ms>, nonce=<b64u 16>, sig=<b64u 64>` with
`sig = Ed25519.sign(secret, "iskra/buddy-request/v1" || 0x00 || holderKey(32) || u64be(at) || nonce(16) || SHA-256(utf8(METHOD + " " + path-and-query)) || SHA-256(body))`.
`key` is the source's server key or its restore key. The holder refuses (`401`, nothing else said) a key it doesn't
know, a bad signature, an `at` more than 5 minutes off, a nonce it has seen from that key in the last 10 minutes, or an
`at` from before the holder started (nonces are remembered in memory only, so nothing replays across a restart). The
key is looked up before the body is read; refused requests count against the client address.

| Request | Who | Body | Answer |
|---|---|---|---|
| `GET /buddy/v1/hello` | anyone (unsigned) | | `{ iskra: 1, key }`: the holder's server key, for a restore that only has the address |
| `GET /buddy/v1/spot` | source, restore key | | `{ spotId, quotaBytes, keep, graceDays, used, removing, deleteAt, versions: [{ id, size, at }] }` (newest first) |
| `POST /buddy/v1/uploads` | source | `{ size }` | `{ id, received, chunkBytes }`; a new upload replaces an unfinished one |
| `GET /buddy/v1/uploads/<id>` | source | | `{ id, size, received }` (to resume) |
| `PUT /buddy/v1/uploads/<id>?offset=<n>` | source | raw bytes, 1 B – 4 MB | `{ received }` (must be exactly `offset` + the part's length, or the source fails the sync); `409 { received }` unless `offset` is exactly what the holder has |
| `POST /buddy/v1/uploads/<id>/finish` | source | `{ sha256 }` (hex) | `{ version: { id, size, at } }`; `409` if incomplete, `422` (upload dropped) if the hash differs |
| `GET /buddy/v1/versions/<id>` | source, restore key | | the stored bytes (`application/octet-stream`) |
| `DELETE /buddy/v1/spot` | source | | `{ deleteAt }`: the source stops; the copies stay for the grace period, at least 1 day |

- `413` when `size` plus the protected copy (below) is over the spot's quota, `507` when the holder's disk would have less than 1 GB left, `410` when
  the spot is being removed (no uploads; listing and downloads still work until `deleteAt`), `429` over a limit.
- Uploads expire after 24 hours unfinished. Answers carry `Cache-Control: no-store` and no CORS headers (browsers never
  call these).

### What the holder keeps, and its limits

- The bytes go to `buddy-held/<spotId>/` in the holder's world folder (owner-only permissions on Linux and macOS),
  never into its database, and never into the holder's own backups. The database has the spot (label, quota, keep,
  grace, the source's key, name and restore key) and each version's id, size, time and SHA-256.
- **The protected copy:** among the copies older than the one arriving, the newest one that is at least 48 hours old,
  or, when none is that old yet, the oldest one. It's never deleted by pruning, whatever `keep` and the quota say, and a
  new upload must fit beside it (`413`). So once a spot has two copies there's always an older one that a source taken
  over by someone else can't flush out with junk. `keep` is at least 3, so daily copies live long enough to become it.
- After each finished upload the holder keeps the newest `keep` versions plus the protected copy, then deletes the
  oldest until the spot fits its quota (never the newest or the protected copy). While an upload runs the spot can
  briefly hold its quota plus that upload.
- At most 3 finished uploads per spot in any 24 hours (`429`). Per spot: 2 requests a second, burst 60. Per client
  address (IPv6 by its /64), for pairing and refused requests: burst 10, then one every 6 seconds; at most 10,000
  addresses are remembered, the oldest forgotten first. At most 20 spots per holder.
- **Removing.** Either owner can stop. The holder's owner removes a spot (`buddy.spot.remove`): uploads stop at once,
  and the copies are deleted after the spot's grace period (`graceDays`, 0–90, default 7), or right away with `now`.
  The source's owner removes a buddy (`buddy.remove`): the source calls `DELETE /buddy/v1/spot` and the holder starts
  the spot's grace period, but at least 1 day even when it's 0, so a source taken over by someone else can't wipe its own
  copies (only the holder's owner can delete at once). During the grace period the
  copies can still be listed and downloaded (a restore still works). Holder spots that were never paired go at once.

### Requests

Owner only (`forbidden`, key `owner_backup`), like the other backup requests.

On the source:

| type | body | result |
|---|---|---|
| `buddy.status` | | `BuddyStatus` |
| `buddy.add` | `code` (≤ 1024 chars) | `BuddyStatus` plus `recoveryCode` (string when this made it, else null) |
| `buddy.remove` | `id` | `BuddyStatus` |
| `buddy.backupNow` | | `BuddyStatus` (makes today's daily backup if there's none yet, then every buddy tries now) |
| `buddy.recoveryCode` | | `{ recoveryCode }` (to write it down again; security log `buddy.recovery.shown`) |

```jsonc
BuddyStatus { "autoEnabled": true, "recoveryCodeSet": true, "buddies": [Buddy] }
Buddy {
  "id": "<16 hex>", "url": "https://friend.example", "holderKey": "<b64u>", "name": "Friend's server",
  "quotaBytes": 2147483648, "keep": 3, "addedAt": 1760000000000,
  "lastOk": { "at": 1760000000000, "name": "auto-2026-10-17.zip", "size": 52428800 } | null,
  "error": { "code": "bad_request", "message": "…", "key": "buddy_unreachable", "args": {} } | null,
  "nextTryAt": 1760000000000 | null, "uploading": { "done": 0, "total": 52428800 } | null,
  "removed": false           // true: the holder stopped holding (410); remove it here
}
```

- `buddy.add` errors (`bad_request` with key): `buddy_code` (not a pairing code), `buddy_address` (not http(s), has a
  user name, plain http to a public address, or a LocalOnly server given a non-loopback address), `buddy_unreachable`
  (`args: { reason }`), `buddy_code_used` (the holder said `404`), `buddy_already` (`409`, or already a buddy here),
  `buddy_wrong_server` (the answer isn't signed by the key in the code), `buddy_self` (your own server),
  `buddy_max` (8 buddies), `buddy_refused` (`args: { status }`, any other answer).
- Problems in `Buddy.error`: `buddy_unreachable`, `buddy_unknown` (`401`/`403`: the holder doesn't know us any more),
  `buddy_too_big` (`args: { size, quota }`), `buddy_full` (the holder's disk), `buddy_limited` (`429`), `buddy_removed`,
  `buddy_failed` (`args: { reason }`), `buddy_backups_off` (daily backups are off: nothing to send).
- Uploads: the newest daily backup, encrypted once to `backups/buddy-<name>.iskrabackup` and sent to every buddy that
  doesn't have it yet, in 4 MB parts, one buddy at a time, at most `BuddyBackups.UploadKbPerSecond` (server.json,
  default 1024; 0 = no limit). A cut-off upload resumes where it stopped. After a failure it tries again after 1, 5, 15,
  60 and 180 minutes, then every 6 hours. Event `buddy.changed {}` goes to the owner's sessions when a buddy's status
  changes (look again with `buddy.status`).
- Connections: only to the pairing code's address, which must be just a server (`http(s)://host[:port]`, no path), no
  redirects, plain http only to private networks, never link-local, and loopback only from a LocalOnly server (which
  connects to nothing else). 60 s per request; answers are buffered up to 1 MiB (downloads stream).
- Uploading: each `PUT` answer must say exactly `offset` + the part's length. A `409` whose `received` is exactly that
  too counts as the part having landed; any other `409` moves the source to the holder's `received`, and more than 3 of
  those in a row fail the sync (`buddy_failed`), as does sending more than twice the copy plus one part in one go. The
  pace limit counts every part sent.

On the holder:

| type | body | result |
|---|---|---|
| `buddy.spots` | | `{ spots: [Spot], address }` (`address`: what a new pairing code would carry, or null) |
| `buddy.spot.create` | `label` (1–64), `quotaMb?` (100–1048576, default 2048), `keep?` (3–30, default 3), `graceDays?` (0–90, default 7), `url?` (http(s) ≤ 512) | `{ spot, code }` |
| `buddy.spot.update` | `id`, any of `label`, `quotaMb`, `keep`, `graceDays` | `{ spot }` |
| `buddy.spot.remove` | `id`, `now?` | `{ spots, address }` |

```jsonc
Spot {
  "id": "<16 hex>", "label": "Anna's server", "state": "waiting" | "active" | "removing",
  "sourceName": "Game Night" | null, "sourceKey": "<b64u>" | null,
  "quotaBytes": 2147483648, "keep": 3, "graceDays": 7, "used": 52428800,
  "versions": [{ "id": "<16 hex>", "size": 52428800, "at": 1760000000000 }],
  "createdAt": 1760000000000, "lastUploadAt": 1760000000000 | null,
  "codeExpiresAt": 1760000000000 | null, "deleteAt": 1760000000000 | null
}
```

`buddy.spot.create` errors: `buddy_spots_full` (20 spots), `buddy_no_address` (no address to put in the code: give
`url`). Event `buddy.changed {}` goes to the holder owner's sessions after pairing, uploads and removals.

### Restoring from a buddy

`iskra-server restore-buddy [--version <id>] [--list] [--json] [--code-stdin] [--] <holder-address> <world-folder>` (after
`--` everything is an address or folder, never a flag; the desktop app always passes it), the recovery code from
`--code-stdin` (one line), `$ISKRA_BUDDY_RECOVERY_CODE` or a prompt. It derives the restore key, lists the spot
(`--list` prints the versions and stops; with `--json`: `{ ok, versions: [{ id, size, at }] }`), downloads the newest
(or the given) version to a private temp file and restores it exactly like `iskra-server restore` (same checks, same
`--json` result), then deletes the temp file. Before downloading it refuses a size over 1 TB (the biggest spot) or
more than this computer has room for (the copy, and as much again for the restored server). The command may reach
loopback addresses (it runs on the person's own computer). A recovery code the holder doesn't know gets `401` ("That recovery code
isn't known there"); a changed or cut-off copy fails the backup's own checks. The desktop app's **Restore from a backup
→ From a buddy's server** runs this.

### Security log

Source: `buddy.added` (`{ url, holderKey }`), `buddy.removed` (`{ url }`), `buddy.upload.failed` (`{ url, error }`,
once per new problem), `buddy.recovery.shown`. Holder: `buddy.spot.created` (`{ quotaMb, keep }`), `buddy.spot.paired`
(`{ sourceKey, name }`), `buddy.spot.removed` (`{ by: "holder" | "source", deleteAt }`), `buddy.spot.deleted`,
`buddy.auth.failed` (refused signed requests, `{ reason }`). Never codes, tokens, secrets or contents.

## Activities

Shared mini-apps people use together in a voice channel: a drawing-and-guessing game, a quiz, a board game, or one the
server's admins added. Each runs in an isolated frame in every player's app and talks to the app over a small,
versioned postMessage SDK ([docs/activities.md](../docs/activities.md)). The server only relays what activities send
to the people playing, in one order, and keeps a small snapshot for late joiners; nothing is stored beyond the session.

**Built-in activities** (`draw`, `trivia`, `four`) are part of the apps: their code ships with the app and runs from it,
so they work everywhere. **Server-added activities** are zip bundles an admin uploads; this server stores and serves
them, and nothing loads from anywhere else.

### The catalog

```jsonc
Activity { "id": "<b64u 16>", "name": "Snake duel", "description": "…", "icon": "/activities/<id>/icon.png" | null,
           "minPlayers": 2, "maxPlayers": 8, "version": "1.2" | "", "size": 81234, "files": 6,
           "enabled": true, "addedBy": "<accountKey>", "addedAt": 1760000000000,
           "entry": "/activities/<id>/index.html" }
```

| type | body | result | who |
|---|---|---|---|
| `act.list` | | `{ activities: [Activity], builtins: [{ id, enabled }], startRole, off: [channelId] }` | anyone (non-admins get enabled activities only) |
| `act.add` | `file` (id of your own upload: a zip, see below) | `{ activity }` | admin+ |
| `act.update` | `id` (a server-added id or a built-in's), `enabled` | | admin+ |
| `act.remove` | `id` (server-added) | | admin+ |
| `act.configure` | `startRole?` (`guest` … `admin`: the lowest level that may start one; default `guest`), `channelId?` with `off` (turn activities off or on in a voice channel) | `{ startRole, off }` | admin+ |

Event `act.catalog {}` goes to everyone after any of these (apps ask `act.list` again when they need it). Turning an
activity off, removing it, or turning a channel off ends the sessions it affects. Audit: `act.add`, `act.update`,
`act.remove`, `act.configure` (names and settings, never file contents). Security log: `activity.added`,
`activity.removed`, `activity.rejected` (`{ reason }`: a bundle refused as unsafe, e.g. a path leaving the bundle).

**Bundles** (`act.add`): the upload must be a zip of at most 5 MB, with at most 200 files and 10 MB unpacked (each file at
most 5 MB; sizes are counted while unpacking, never taken from the zip's headers). A server holds at most 25
(`bad_request`, key `act_limit`, args `{ max }`).

- **Paths:** each part `[A-Za-z0-9_.-]`, 1–64 characters, not starting with `.`; at most 8 parts and 200 characters;
  no two files whose paths differ only in case. Folders, `__MACOSX/…`, `.DS_Store` and `Thumbs.db` are skipped. When
  everything sits in one top-level folder, that folder is the bundle. Anything else (`..`, `/` or `\` at the start,
  drive letters, empty parts) refuses the whole bundle (`bad_request`, key `act_path`, args `{ path }` cut to 100
  characters) and is written to the security log.
- **Types**, by extension only (the server sends this type with `nosniff`): `html htm js mjs css json txt svg png jpg
  jpeg gif webp ico avif woff woff2 ttf otf mp3 ogg oga wav m4a opus` (else key `act_type`, args `{ path }`). Text
  files (`html`, `htm`, `js`, `mjs`, `css`, `json`, `svg`, `txt`) must be UTF-8 (key `act_utf8`, args `{ path }`).
- **Must hold** `index.html` (key `act_index`) and `manifest.json` (≤ 16 KB, key `act_manifest`) at the top:
  `{ "name": 1–40 chars, "description"?: ≤ 200 chars, "icon"?: a png/jpg/webp/gif/svg path in the bundle,
  "minPlayers"?: 1–25 (default 1), "maxPlayers"?: minPlayers–25 (default 25), "version"?: ≤ 20 chars, "sdk"?: 1 }`.
  Text rules as for names (one line); unknown fields are ignored.
- Not a zip, or over a limit: key `act_zip` (args `{ maxMb, maxFiles }`).

Bundles are stored in `iskra.db` (migration `activities-1`: `activities`, `activity_files`, `activity_builtins_off`,
`activity_off`, `activity_settings`), so backups carry them.

### Serving: `GET /activities/<id>/<path>`

Disabled or unknown activities, and paths not in the bundle, are 404. Every file is served like a profile page with
scripts ([the safety model](#profile-pages-the-safety-model)): an opaque origin, no network, no WebRTC on the page:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' <self>/activities/<id>/;
  style-src 'unsafe-inline' <self>/activities/<id>/; img-src data: blob: <self>/activities/<id>/;
  font-src data: <self>/activities/<id>/; media-src data: blob: <self>/activities/<id>/; connect-src 'none';
  form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none';
  base-uri 'none'; frame-ancestors <as for profile pages>
```

with the same `Permissions-Policy`, `nosniff`, `no-referrer`, `Cross-Origin-Opener-Policy` and `no-store`, and no
cookies. HTML files get the profile pages' WebRTC prelude and then the SDK (`protocol/activity-sdk.js`) inserted right
after the doctype, before any of the bundle's own code. Bundles use classic scripts (`<script src>`), not modules.
Every other file (scripts, styles, pictures, sounds, and SVGs opened on their own) gets the same policy without
scripts: `sandbox; default-src 'none'; script-src 'none'; …`. Requests are limited per client address (300, then 30 a
second; over that: `429`).

**Where server-added activities run.** As with profile pages, a browser can't be made watertight (a `srcdoc` child
frame gets a fresh `RTCPeerConnection`), so: the **desktop app** runs them in its walled page view (the `iskra-pages`
session: only `GET` requests for this activity's own files on its own server get through; everything else, WebRTC
included, goes nowhere; see `desktop/src/pages.ts`). **Browsers and the phone apps** list them but don't run them, and
say they run in the desktop app. Built-ins run everywhere: they are the app's own code, in a sandboxed frame
(`sandbox="allow-scripts"`, opaque origin) with its own no-network policy.

### Sessions

One activity runs per voice channel at a time.

```jsonc
ActivitySession { "id": "<b64u 12>", "channelId": 3, "activity": "four" | "<server-added id>", "name": "Snake duel" | null,
                  "startedBy": "<accountKey>", "startedAt": 1760000000000,
                  "players": [{ "id": "<b64u 12>", "accountKey": "<accountKey>" }] }   // in the order they joined
```

`players[].id` is the player's id **inside the activity**: HMAC-SHA256 of the account key under a random key the
server makes for each session (the first 9 bytes, base64url). Apps hand activities these ids and display names, never
account keys; a person keeps their id for the whole session (on another device too, or after leaving and coming back).

| type | body | result | who |
|---|---|---|---|
| `act.start` | `channelId, activity` | `{ session }` | someone in the call (LiveKit's webhooks) who may speak there, at the server's `startRole` or above, while activities are on there and that activity is enabled. This connection joins it at once. One running already: `bad_request`, key `act_running` |
| `act.join` | `channelId, sessionId` | `{ session, me, seq, state, stateSeq, messages, missed }` | someone in the call who can read the channel; at most 25 people, or the manifest's `maxPlayers` if fewer (`bad_request`, key `act_full`, args `{ max }`) |
| `act.leave` | `channelId, sessionId` | | anyone (this connection stops getting the activity's messages) |
| `act.send` | `channelId, sessionId, data` (any JSON, ≤ 8 KB serialized) | `{ seq }` | players (this connection joined) who may speak in the channel; listeners only watch (`forbidden`, key `act_listen_only`) |
| `act.snapshot` | `channelId, sessionId, seq, state` (any JSON, ≤ 48 KB serialized) | | players who may speak there (as for `act.send`) |
| `act.end` | `channelId, sessionId` | | whoever started it, an admin, or any player once the starter has left the call |

- **Relay:** every `act.send` gets the session's next `seq` and goes as `act.msg` to every connection that joined, the
  sender's own included, in `seq` order, so every player applies the same messages in the same order. Messages aren't
  stored: only the ones since the last snapshot are kept, in memory (at most 300 and 256 KB; past that the oldest go,
  and `missed` is true for the next late joiners). A session also has one relay budget, whoever sends: 256 KB a second
  (1 MB burst), counting each message once per connection it goes to; over it, `rate_limited` with key `act_busy`.
  Activity messages are not checked by AutoMod or word filters (they are an app's data, not chat).
- **Late joiners:** `act.join` answers the latest snapshot (`state`, `null` if none, made after message `stateSeq`), the
  messages after it (`messages: [{ seq, from, data }]`, oldest first) and `seq`, the newest message so far.
  `act.snapshot` names the `seq` of the last message the state includes: older than the current snapshot is ignored,
  newer than the newest message is `bad_request` (key `act_seq`).
- **Ending:** a session ends with `act.end`, when the call empties, when its last player leaves it, when the activity is
  turned off or removed, when activities are turned off in the channel, or when LiveKit stops. People who leave the
  call or can no longer read the channel stop being players. Sessions live in memory only, like voice state.
- **Not here:** bots (`forbidden`, key `act_bots`), stage and text channels (`bad_request`, key `act_voice_only`),
  [encrypted voice channels](#encrypted-voice-channels) (`act_e2ee`: the server relays, and could read, activity
  messages), and channels where an admin turned them off (`act_off`). An unknown or disabled activity is `not_found`;
  below `startRole` is `forbidden` (key `act_start_role`). Someone not in the call: `bad_request`, key
  `voice_join_first`; a player request from a connection that didn't join: `bad_request`, key `act_join_first`.
  Starting needs speaking rights (else `forbidden`, key `act_listen_only`); ending someone else's: `forbidden`, key
  `act_end_starter`; catalog changes by non-admins: `forbidden`, key `act_admins`. Too big: `bad_request`, key
  `act_data_size` or `act_state_size` (args `{ kb }`).
- **Rate limits:** `act.send` 20/s (burst 40) and `act.snapshot` 1/s (burst 5), each on a bucket of its own that
  doesn't take from the general one (a busy activity never slows the rest of the connection); `act.start` and
  `act.end` 1 every 2 s (burst 5), `act.join` and `act.leave` 2/s (burst 10), `act.add` 1 every 10 s (burst 3),
  `act.list` 2/s (burst 10). Apps send for an activity at most 10 a second (burst 20).

| event | body | sent to |
|---|---|---|
| `act.session` | `{ channelId, session: ActivitySession \| null }` | readers of the channel, after it starts, ends or its players change |
| `act.msg` | `{ channelId, sessionId, seq, from, data }` (`from`: a player id) | the connections that joined it |
| `act.catalog` | `{}` | everyone |

`welcome.activities` lists the running sessions in channels you can read.

**Your data:** `data.export` gains `activitiesAdded` (the activities you added: id, name, when). What activities send is
never stored, so there is nothing else to export or delete. Deleting an account keeps the activities it added (they
belong to the server) and clears who added them (`addedBy` becomes `""`).

## Text to speech (/tts)

`/tts <text>` in the composer sends a normal message flagged `tts`. Apps read flagged messages aloud with the device's own
speech synthesis, only for people who turned on "Play /tts messages" (off by default), and only in the conversation
they have open, never while it's muted, in quiet hours or with do not disturb on. Speech never touches the server.

| type | body | result | who |
|---|---|---|---|
| `chat.send` | adds `tts?: boolean` (`true` flags it; `false` or absent is a normal message) | | channel writers with `sendTts` |

- **Permission:** `sendTts` (a [role permission](#roles-and-permissions)). Admins and the owner have it; everyone else
  needs a role that gives it. Without it: `forbidden`, key `tts_forbidden`. A flagged message needs text (not only
  files, not a voice message): `bad_request`, key `tts_needs_text`. Not a boolean: `bad_request`.
- **Size:** the flag adds nothing; the text has the usual limit (4000 characters). Apps read at most the first 300
  characters of a message aloud.
- `Message` gains `tts: true` (`null` otherwise). The flag stays through edits and goes with the message. Stored in
  `tts_messages` (migration `tts-1`).
- **Encrypted channels:** the server never sees the flag. It's `tts: true` inside the encrypted content
  (`{ "text", "files"?, "tts"? }`, [Messages](#messages)); a `tts` next to an envelope is ignored. Since the server
  can't check the permission there, receiving apps only read a flagged message aloud when its author has `sendTts`.
- **DMs and group DMs** have no /tts yet (no roles there to give it with).

## Starboard, Birthdays and Welcome

Three more [built-in bots](#built-in-bots) that act on what happens rather than (only) on a command: **Starboard**,
**Birthdays** (`/birthday`) and **Welcome**. They're turned on and off like the others (`builtin.bots.set`, `bot:
"starboard" | "birthdays" | "welcome"`), are bot members like the others (role, channel overrides, `builtin` on the
member) and are listed after them in `welcome.builtinBots`. Each posts in **one text channel an admin picks**, as long
as the bot can see it (its role and the channel's overrides), it isn't [encrypted](#end-to-end-encrypted-channels) and
the bot isn't timed out; otherwise it stays quiet. It needn't be able to write there (a read-only `#starboard` works).
Turned on, Starboard uses a text channel called `starboard` (made if missing: members read, admins write; audit
`channel.create`); Birthdays and Welcome start in the first text channel members can read. Settings stay when a bot is
turned off.

| type | body | result | who |
|---|---|---|---|
| `builtin.bots.config.get` | `bot: "starboard" \| "birthdays" \| "welcome"` | `{ bot, config }` | admins (`forbidden`, key `builtin_bots_config_admin`); other bots: `bad_request`, key `builtin_bot_no_settings` |
| `builtin.bots.config.set` | `bot`, and any of that bot's fields below | `{ bot, config }` | admins; audit `builtin.bot.config` (`{ bot, changed: [field] }`, never the text) |
| `birthday.get` | | `{ birthday: { month, day } \| null }` | anyone (their own) |
| `birthday.set` | `month` (1–12), `day` (1–31, a real date; 29 February allowed) | `{ birthday }` | anyone but bots (`birthday_bot`), while Birthdays is on (`bad_request`, key `birthdays_off`); not a date: `birthday_date` |
| `birthday.remove` | | `{ birthday: null }` | anyone (their own; works while the bot is off too) |

```jsonc
StarboardConfig { "channelId": 12 | null, "emoji": "⭐", "threshold": 3 }              // threshold 1–50; emoji as for chat.react
BirthdayConfig  { "channelId": 3 | null, "time": "09:00", "timeZone": "Europe/Stockholm" | null, "serverTimeZone": "..." }
WelcomeConfig   { "channelId": 3 | null, "message": "", "privateMessage": "" }        // each ≤ 1000 characters, newlines allowed
```

- `channelId` (all three): a text channel the admin can read, not encrypted (`bad_request`, key `builtin_bot_channel`;
  unknown or unreadable: `not_found`); `null` turns posting off. `time`: `HH:MM` (`builtin_bot_time`). `timeZone`: an
  IANA zone (as for events), `null` for the server's own (`serverTimeZone`, read-only). `emoji`: invalid is
  `builtin_bot_emoji`. Templates over 1000 characters: `builtin_bot_template` (args `{ max }`); empty means the default.
- Rate limits: `builtin.bots.config.set` 20 then 2/s, `birthday.set` 5 then one per 2 s, `/birthday` answers 10 then 1/s.

**Starboard.** After every `chat.react` (on or off), `chat.edit` and `chat.delete` of a plain message:
- The count is the number of different people who reacted with the chosen emoji, **not counting the author or bots**.
  Bots' messages (the cards too) never go on the board, nor do messages in the board channel itself.
- At `threshold` the bot posts a card in the board channel, but only when **everyone who can read the board can read
  the source**: the source (a thread: its parent) isn't encrypted, the bot can read it, no override hides it from any
  role, its read level is no higher than the board's, and every role an override lets into the board is let into the
  source too (or the source is open to guests). Otherwise nothing is posted, ever (a private channel never leaks).
- A card stays once made, also when the count drops below the threshold; its count and excerpt are kept current (the
  card message is updated in place: `chat.edited`, no edit mark). An edit of the original updates the excerpt. Deleting
  the original (by hand, retention, disappearing messages or account deletion) deletes the card (`chat.deleted` to the
  board's readers when done by hand). A card a moderator deletes stays gone. If the source later becomes more private
  than the board, the card is no longer updated.
- The card's `builtin`: `{ "bot": "starboard", "kind": "star", "for": "<author>", "emoji", "count", "channelId",
  "channelName", "messageId", "at", "excerpt" (≤ 300 characters, one line), "image": { "url": "/files/…", "width",
  "height" } | null }` (the first image attachment). Its text is plain English: `⭐ 3 · Anna in #general: excerpt`.
  Cards don't push.

**Birthdays.** Only people who opted in are stored: day and month, never a year.
- `/birthday set <date>` (`14 March`, `March 14`, `14th of March`, `14 mars`, `14/3`, `14.3`; English and Swedish month
  names, 3+ letters), `/birthday remove` and `/birthday list` (Swedish `sätt`, `ta bort`, `lista` too). Every answer is
  private: `{ "kind": "birthday.set", "month", "day" }`, `{ "kind": "birthday.removed" }`, `{ "kind": "birthday.list",
  "upcoming": [{ "accountKey", "month", "day" }] }` (the next 60 days, at most 20, today first), `{ "kind":
  "birthday.usage" }`.
- Once the configured time has passed in the configured zone on someone's birthday, the bot posts one greeting for
  everyone celebrating that day who hasn't had one this calendar year (checked every 10 seconds; a server that was off at
  that time catches up later the same day). 29 February is celebrated on the 28th in other years. Changing the date
  doesn't give a second greeting the same year. `builtin`: `{ "kind": "birthday", "for": "<first person>", "people":
  [accountKey] }` (at most 20); text `🎂 It's Anna's birthday today!`. Pushes as an ordinary message (no pings).
- Leaving, being removed or deleting the account deletes the birthday. `data.export` gains `birthday`.

**Welcome.** Greets people when they actually get in: right after joining with an ordinary invite, when a moderator
approves them (`join.approve`), or, when the server asks members to agree to the rules, once they first agree
(`rules.accept`; who's waiting is stored until then). Bots and the owner aren't greeted.
- `message` is a template: `{name}` (becomes a mention of the newcomer, `<@accountKey>`), `{server}` (the server's
  name), `{memberCount}` (people, not bots); markdown like any message. Empty: the default greeting.
- One greeting goes out at once; anyone else getting in within the next minute is gathered, and when the minute is up
  one line greets them all (`welcome.batch`) instead of one post each, so a raid can't flood the channel. Greetings
  don't push.
- `privateMessage` (if set) is also sent to the newcomer alone as a [private answer](#answering) in that channel once
  they're online (within 15 minutes; never stored).

```jsonc
{ "kind": "welcome", "for": "<newcomer>", "memberCount": 12, "text": "Welcome <@…>!" | null }   // null: the default greeting
{ "kind": "welcome.batch", "for": "<first>", "count": 7, "people": ["<accountKey>", ...], "memberCount": 19 }  // people: at most 10
{ "kind": "welcome.private", "for": "<newcomer>", "text": "..." }
```

Migration `builtinbots2-1`: `builtin_bot_config`, `starboard_cards` (with a trigger that deletes a card with its
original), `birthdays` and `welcome_pending` (both deleted with the member).

## Voice channel status

People in a voice channel can give it a short status ("CS2 ranked 🔫"), shown under the channel's name and in the call.
It belongs to the call, not the channel: it goes away by itself when the last person leaves.

| type | body | result | who |
|---|---|---|---|
| `voice.status.set` | `channelId, text` (0–60 characters, counted as user-perceived characters, ≤ 240 UTF-16 units, one line; empty or only spaces clears it) | `{ status: VoiceStatus \| null }` | someone in the call with `setVoiceStatus` in the channel; to clear, also anyone who can read the channel and has `manageChannels`, `muteMembers` or `moveMembers` |

`VoiceStatus = { text, setBy (account key), setAt (ms) }`.

- **Permission:** `setVoiceStatus` is a channel permission (`channel.overrides.set` can allow or deny it per role, like
  `speak`). By default it comes with the channel's write level, so whoever may speak may set the status. Not in the
  call: `bad_request`, key `voice_join_first`. Without the permission: `forbidden`, key `voice_status_denied`. Voice
  channels only (not stages, which have a topic): `bad_request`, key `voice_status_voice_only`.
- **Text:** trimmed and NFC-normalized; control and invisible formatting characters (other than the emoji joiner) are
  `bad_request`, key `voice_status_text`, as is more than 60 characters (args `{ max }`). AutoMod checks it like a
  message (`what: "voicestatus"`): its word, link and mention rules apply (an exempt role or channel skips them).
- **Clearing:** when the call empties (the last person leaves, everyone is moved or removed, or LiveKit stops), the
  status is cleared. A moderator clearing a status through their moderator power (they couldn't set one there) adds an
  audit entry `voice.status.clear` (target: who set it; details: `channelId`, `channelName`; never the text).
- **Where it shows:** `voice.state` events and `welcome.voice` gain `status: VoiceStatus | null`; each change is a new
  `voice.state` for the channel's readers. Kept in memory only, like voice state (a server restart empties every call).
- **Encrypted voice channels:** allowed, but the status is not end-to-end encrypted: the server and everyone who can
  see the channel can read it. Apps say so where it's set.
- **Rate limit:** 5 changes, then one every 10 s, per account (all its connections together): `rate_limited`, key
  `voice_status_slow`.

## Feeds

**Feeds** is another [built-in bot](#built-in-bots) (`builtin.bots.set`, `bot: "feeds"`): it posts new posts from RSS
or Atom feeds, new videos from YouTube channels and "went live" from Twitch channels, each in the text channel an admin
picks. It's the one built-in bot that makes the **server contact other sites**, so it's off until an admin turns it on,
and while it's off nothing is fetched (subscriptions are kept). It's a bot member like the others (role, channel
overrides, `builtin: "feeds"`), listed after Welcome in `welcome.builtinBots`; it has no command and never posts in
[encrypted channels](#end-to-end-encrypted-channels).

| type | body | result | who |
|---|---|---|---|
| `feeds.get` | | `{ subscriptions: [FeedSubscription], twitch: { configured, clientId \| null }, max: 25 }` | admins (`forbidden`, key `feeds_admin`) |
| `feeds.add` | `kind: "rss" \| "youtube" \| "twitch"`, `source` (≤ 512), `channelId`, optional `mention`, `mentionRoleId`, `template`, `intervalMinutes` | `{ subscription }` | admins, while Feeds is on (`bad_request`, key `feeds_off`); audit `feed.add` |
| `feeds.update` | `id`, any of `channelId`, `mention`, `mentionRoleId`, `template`, `intervalMinutes`, `paused` | `{ subscription }` | admins; audit `feed.update` (`{ id, changed: [field] }`) |
| `feeds.remove` | `id` | `{}` | admins; audit `feed.remove` |
| `feeds.check` | `id` | `{ subscription }` (after checking now) | admins; once a minute per subscription (`feeds_check_wait`, args `{ seconds }`) |
| `feeds.twitch.set` | `clientId`, `clientSecret` (both `""` removes them) | `{ twitch: { configured, clientId } }` | the owner (`forbidden`, key `feeds_twitch_owner`); audit `feed.twitch` (never the secret) |

```jsonc
FeedSubscription {
  "id": 3, "kind": "rss" | "youtube" | "twitch",
  "source": "https://blog.example/feed.xml" | "UC…(24)" | "twitch_login",
  "name": "Example blog",                 // the feed's title, the YouTube channel's or the Twitch channel's name (≤ 100)
  "url": "https://…",                     // where people can see it: the feed's address, youtube.com/channel/…, twitch.tv/…
  "channelId": 12, "mention": "everyone" | "here" | "role" | null, "mentionRoleId": 4 | null,
  "template": "",                         // empty: the default post
  "intervalMinutes": 15, "paused": false,
  "createdBy": "<accountKey>", "createdAt": 0,
  "lastCheckAt": 0 | null, "lastOkAt": 0 | null, "lastPostAt": 0 | null, "nextCheckAt": 0,
  "failures": 0, "lastError": null | "unreachable" | "http" | "not_feed" | "too_large" | "rate_limited" | "twitch_setup" | "twitch_auth",
  "canPing": true                         // whether the mention will notify, given the Feeds bot's own permissions
}
```

- **Sources.** `rss`: an `http(s)` address of an RSS (0.9x, 1.0, 2.0) or Atom feed; a web page that names its feed
  (`<link rel="alternate" type="application/rss+xml|atom+xml">`) is replaced by that feed's address when added. `youtube`:
  a channel id (`UC` + 22 characters), a `youtube.com/channel/UC…` address, a channel feed address, or a handle
  (`@name` or `youtube.com/@name`), which the server looks up once on YouTube's public channel page (no API key);
  when that fails: `feeds_youtube_channel` (apps say where to find the channel id). The server reads YouTube's public
  feed `https://www.youtube.com/feeds/videos.xml?channel_id=…`. `twitch`: a login or `twitch.tv/<login>` (1–25 letters,
  digits or `_`, `feeds_twitch_login`), only when the owner has given the server a Twitch app's client id and secret
  (`feeds_twitch_setup` otherwise; made at dev.twitch.tv, free). The server uses Twitch's Helix API with an app token
  (client credentials): `GET /helix/users?login=` when added (unknown: `feeds_twitch_unknown`), then `GET
  /helix/streams?user_login=`. The secret is stored in `iskra.db` and never sent to any app; credentials Twitch refuses
  are `feeds_twitch_credentials`.
- **Adding** fetches the source once: not reachable, refused, timed out or not allowed (a private address) are all
  `feeds_unreachable` (one answer, so it can't be used to probe hosts or ports), not a feed `feeds_not_feed`, too big
  `feeds_too_large`, a bad address `feeds_url` (also any port but 80, 443 or 1024 and up). Everything already in it is marked as seen,
  so nothing old is posted (a Twitch channel that's live right now is posted the next time it goes live). The same
  source twice in one channel: `feeds_duplicate`. At most 25 per server (`feeds_max`, args `{ max }`).
- **Fields.** `channelId`: as for the other built-in bots (`builtin_bot_channel`, unknown or unreadable `not_found`),
  and one the admin can post in (`feeds_channel_send`); the Feeds bot must be able to post there too (unlike
  Starboard's read-only board), else nothing is posted. `intervalMinutes`: RSS and YouTube 5–1440 (default 15), Twitch 2–60
  (default 3) (`feeds_interval`, args `{ min, max }`). `template` ≤ 500 characters, newlines allowed (`feeds_template`,
  args `{ max }`), with `{title}`, `{url}`, `{name}` (the feed's or channel's name); values from the feed are escaped
  for markdown and get a joiner after every `@`, and the whole filled text is defused (`@everyone`, `@here`, `<@`), so
  only `mention` pings. A placeholder right after `@`, `<` or `&` is refused (`feeds_template_placeholder`). The
  filled text is cut to 3000 characters. `mention`: `null`, `"role"` (with `mentionRoleId`), `"everyone"` or `"here"`.
  An admin may only pick `everyone`/`here`, or a role that isn't mentionable, if they may mention everyone themselves
  (`forbidden`, key `feeds_mention_denied`); an unknown role is `not_found`. Whether it notifies then follows the
  usual rules for the Feeds bot as author ([role mentions](#roles-and-permissions), `@everyone`): `canPing` says
  whether it will. The mention goes on at most one post per subscription every 10 minutes.
- **Posting.** Each new item is a message from the Feeds bot (oldest first, at most 5 per check; more are marked as
  seen), plain English `text` with the mention, the title and the link (apps show a link preview by their own rules),
  and `builtin`: `{ "bot": "feeds", "kind": "feed.item", "for": "<the bot's key>", "source": "rss" | "youtube" |
  "twitch", "subscriptionId", "name", "title" (≤ 300, one line), "url" (http(s), ≤ 2048) | null, "mention": "everyone"
  | "here" | "role" | null, "mentionRoleId", "text": "<filled template>" | null }` (`null`: the default post, worded by
  the app). Posts push like any message from the bot. Paused subscriptions, a channel the bot can't see, an encrypted
  channel or a timed-out bot: nothing is posted (items are still marked as seen). The subscription is read again after
  the fetch: one removed meanwhile posts nothing, and changes made meanwhile (channel, mention, text) apply.
- **Fetching.** `GET` with `If-None-Match`/`If-Modified-Since` from the last answer (304: nothing new), user agent
  `Iskra-Feeds/1`, connect timeout 5 s, 20 s in all for the request, its redirects and its whole body (a site that
  trickles bytes is cut off; checks run side by side and never wait for each other's), at most 3 redirects. Like [link previews](#link-previews), only
  public addresses are reached, checked after DNS on every connection (redirects and DNS rebinding included); a
  LocalOnly server reaches only loopback addresses (for tests). Answers: an XML content type (or `text/plain`), at
  most 2 MiB; XML is read without DTDs, entities from them or any external resource. Images are never fetched (not
  even thumbnails). Checks happen every `intervalMinutes` plus up to 10% random delay; after a failure the wait doubles
  each time (at most 6 hours; `Retry-After` is respected). Seen items are kept per subscription (the last 500, by a
  hash of their id or link).
- **Rate limits:** adds that get as far as fetching 10 then one per 5 s (`rate_limited`, key `feeds_slow`), `feeds.update`/`feeds.remove` 20 then 2/s, `feeds.check` 5 then
  one per 5 s, `feeds.twitch.set` 5 then one per 10 s, `feeds.get` 10 then 2/s.

Migration `feeds-1`: `feed_subscriptions` (deleted with their channel), `feed_seen` (deleted with the subscription)
and `feed_settings` (the Twitch credentials).
