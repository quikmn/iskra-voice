# Iskra wire protocol

Version 1. This is the reference that the server (`server/`), the client (`client/`) and the bot SDK (`bots/`) implement.
`vectors.json` holds fixed test vectors that both test suites check, so the two sides can't drift apart.

## Contents

- **Basics:** [Encoding](#encoding) · [Identity](#identity) · [Connection](#connection) (handshake, errors and close codes, limits) · [Objects](#objects)
- **Servers and channels:** [Requests and events](#requests-and-events) · [Invite links](#invite-links)
- **Messages:** [Files, replies and reactions](#files-replies-and-reactions) · [Link previews](#link-previews) · [Pins, search and threads](#pins-search-and-threads) · [Polls](#polls) · [Custom emoji](#custom-emoji)
- **Voice:** [Voice channels](#voice) · [Soundboard](#soundboard) · [Stage channels](#stage-channels)
- **Private:** [Direct messages](#direct-messages-end-to-end-encrypted) · [Devices and device linking](#devices-and-device-linking) · [Calls](#calls-voice-and-video-in-dms-end-to-end-encrypted)
- **People and integrations:** [Profiles](#profiles) · [Push notifications](#push-notifications-web-push) · [Bots and webhooks](#bots-and-webhooks) · [Presence and voice messages](#presence-and-voice-messages)
- **Community:** [Forum channels](#forum-channels) · [Scheduled events](#scheduled-events)
- **Running a server:** [Hosting](#hosting) (HTTPS, internet hosting) · [HTTP endpoints](#http-endpoints)

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

Devices can be listed, renamed and revoked; see [Devices and device linking](#devices-and-device-linking).

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
3. **Server checks:**
   - the certificate signature
   - the auth signature
   - the profile name (1–32 characters, no control characters)
   - that the account isn't banned and the device isn't revoked
   - membership: accounts that aren't members yet need a valid `invite`, which also sets their role
4. **Server sends `welcome`:**
   ```jsonc
   { "type": "welcome", "body": {
       "you": Member,
       "server": { "name": "Gaming", "key": "<b64u>", "appUrl": "https://app.iskra.foo",
                   "publicUrl": "https://..." | null,   // see Internet hosting
                   "profilePages": true },              // see Profiles
       "channels": [Channel...],   // only the ones you can read
       "members": [Member...],
       "voice": [VoiceState...],   // non-empty voice channels you can read (see Voice)
       "voiceAvailable": true,
       "stages": [StageState...] } }   // stage channels you can read (see Stage channels)
   ```

Events from other sessions that happen before `welcome` is sent are queued and delivered right after it, in order.

### Errors and close codes

If a handshake check fails, the server sends `error` and closes:

| code | close | when |
|---|---|---|
| `auth_failed` | 4401 | Bad certificate, signature or name, or timeout (same message whatever the reason) |
| `invite_required` | 4401 | Valid identity, not a member, no usable invite (also: a bot invite used by a person, or a person's invite used by a bot) |
| `device_revoked` | 4401 | Valid identity, but the account revoked this device |
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
| `voice_unavailable` | `voice.join`, `call.start`, `call.accept`, `stage.start`, `stage.invite`: LiveKit isn't running (or can't be reached) on this server |
| `busy` | `call.start`: the person is already in another call on this server |

Close codes:

| Code | Meaning |
|---|---|
| 4400 | 10 malformed frames in a row |
| 4401 | Auth failed, timed out, invite required, or device revoked (during the handshake) |
| 4403 | Banned, kicked, no longer a member, or this device was revoked while connected (preceded by a `kicked` event) |
| 4413 | Frame too large |

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
| `link.create` | 1 every 10 s | 3 |

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
Channel { "id": 1, "name": "general", "kind": "text" | "voice" | "stage", "position": 0, "readRole": "member", "writeRole": "member" }
Message { "id": 42, "channelId": 1, "author": "<accountKey>", "text": "hi", "createdAt": 1760000000000, "editedAt": null,
          "attachments": [File], "replyTo": ..., "reactions": [...],   // Files, replies and reactions
          "pinned": false, "thread": Thread | null,                     // Pins, search and threads
          "poll": Poll | null,                                          // Polls
          "webhook": WebhookInfo | null }                               // Webhooks
Invite  { "code": "<b64u 16>", "role": "member", "createdBy": "<accountKey>", "createdAt": 0, "expiresAt": 0, "maxUses": null, "uses": 0 }
```

Roles, lowest to highest: `guest < member < trusted < admin < owner`.

## Requests and events

| type | body | result | who |
|---|---|---|---|
| `ping` | | | anyone |
| `chat.send` | `channelId, text` (1–4000 chars, newlines allowed) | `{ message }` | channel writers |
| `chat.edit` | `id, text` | `{ message }` | the author |
| `chat.delete` | `id` | | the author, or an admin who outranks the author |
| `chat.history` | `channelId, before? \| after? \| around?, limit? (1–100, default 50)` | `{ messages (oldest first), hasMore }` | channel readers |
| `chat.typing` | `channelId` | | channel writers |
| `channel.create` | `name, kind? (text\|voice\|stage), readRole?, writeRole?` | `{ channel }` | admin+ |
| `channel.update` | `id, name?, readRole?, writeRole?` | `{ channel }` | admin+ |
| `channel.delete` | `id` | | admin+ |
| `profile.update` | `name` and the fields in [Profiles](#profiles) | `{ member }` | anyone |
| `member.setRole` | `accountKey, role` | `{ member }` | admin+, target ranked below you, role below yours |
| `member.kick` | `accountKey` | | same as above |
| `member.ban` | `accountKey, reason?` | | same as above |
| `member.unban` | `accountKey` | | admin+ |
| `member.bans` | | `{ bans }` | admin+ |
| `invite.create` | `role? (default member), maxUses? (1–1000), expiresInMs? (1 min – 30 days, default 7 days)` | `{ invite }` | member+ for guest/member invites; higher roles need the right to grant them |
| `invite.list` | | `{ invites }` | admins see all, others their own |
| `invite.revoke` | `code` | | the creator or admin+ |

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
| `upload.begin` | `name, size` (bytes, ≤ `MaxUploadMb`, default 100) | `{ url: "/upload/<ticket>", maxBytes }` | anyone |
| `chat.send` | adds `attachments?: [fileId...]` (≤ 10, your own uploads; text may then be empty) and `replyTo?: messageId` (same channel) | | |
| `chat.react` | `id, emoji` (≤ 16 chars, no spaces, or a [custom emoji](#custom-emoji)), `on?` (default true) | | channel readers; ≤ 20 different emoji per message |

- Upload: `PUT <server>/upload/<ticket>` with the raw bytes (single use, 10 minutes, must not exceed the announced size) → `{ file }`.
- Per-account rate limit and daily quota: see [Limits](#limits). Over the quota, `upload.begin` answers `rate_limited`.
- Uploads nothing refers to after 24 hours (no message attachment, avatar, emoji, sound, webhook or webhook post avatar, nor a `/files/<id>` link in a profile page) are deleted by an hourly sweep.
- `File { id, name, size, type, width?, height?, url: "/files/<id>/<name>" }`. `type` comes from the file's first bytes, never the name: PNG, JPEG, GIF, WebP, MP4, WebM, Ogg, MP3 and WAV are served inline, anything else as a download. Every file response has `nosniff` and a sandboxing CSP. Identical content is stored once (`uploads/ab/<sha256>`).
- Message gains `attachments: [File]`, `replyTo: { id, author, text, hasAttachments } | { id, deleted: true } | null` and `reactions: [{ emoji, accounts: [accountKey] }]`.
- Event `chat.reactions` `{ id, channelId, reactions }` to channel readers.

## Link previews

| type | body | result | who |
|---|---|---|---|
| `link.preview` | `url` (http/https, no credentials) | `{ preview: { url, siteName, title, description } \| null }` | anyone |

The server fetches the page (so viewers' IPs aren't sent to every site): ≤ 512 KB of HTML, 6 s, ≤ 3 redirects, cached for an hour. It only connects to public addresses: each connection's IP is checked after DNS resolution, so private ranges, loopback, link-local/cloud metadata and redirects into them are refused. IPv6 addresses that carry an IPv4 one (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, `::a.b.c.d`, `::ffff:…`) get the IPv4 rules; Teredo, local NAT64 and documentation ranges are refused. Push deliveries use the same check. No images are fetched or shown. Runs off the read loop.

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
| `emoji.list` | | `{ emojis: [Emoji] }` | anyone |
| `emoji.create` | `name, fileId` (your own upload: PNG, GIF or WebP by content, ≤ 256 KB, ≤ 128×128) | `{ emoji }` | admin+ |
| `emoji.rename` | `id, name` | `{ emoji }` | admin+ |
| `emoji.delete` | `id` | | admin+ |

- `Emoji { id, name, url: "/files/<fileId>/<name>", animated, createdBy }`. Names are unique; up to 200 per server.
- `chat.react` also accepts `<:name:id>` for an emoji on this server (stored under its current name).
- Event `emoji.updated` `{ emojis }` to everyone after any change.

## Voice

Voice runs on a LiveKit server that `iskra-server` starts next to itself (config generated from `server.json` → `Voice`, keys in `livekit.key` in the world folder). Iskra never carries audio; it only decides who may join.

| type | body | result | who |
|---|---|---|---|
| `voice.join` | `channelId` (a `voice` or `stage` channel) | `{ url, token, room, canSpeak }` | channel readers (not bots); `canSpeak` = channel writers |
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
| `sound.create` | `name` (1–32 chars), `emoji?` (≤ 16 chars, no spaces), `fileId` (your own upload: MP3, Ogg or WAV by content, ≤ 512 KB, ≤ 5 s) | `{ sound }` | trusted+ |
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
| `dm.send` | `accountKey, envelope` (JSON object, ≤ 32 KB) | `{ message }` | members, to members or yourself |
| `dm.history` | `accountKey, before?, limit? (1–100)` | `{ messages (oldest first), hasMore }` | only your own conversations |
| `dm.conversations` | | `{ conversations: [{ accountKey, lastId, lastAt }] }` | yourself |

Event `dm.message` `{ message: { id, from, to, envelope, createdAt } }` goes to every connected device of both people.
Device certificates are stored when a device authenticates, so the server can publish them but not forge them.

Clients send envelope v2 ([forward secrecy](#forward-secrecy-envelope-v2)); v1 envelopes are still accepted and decrypted. Not yet supported: DMs between people who share no server, and group DMs.

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
- What revocation does not do: every device holds the account secret (unencrypted, in the app's storage), so whoever copied a device's storage can sign new device certificates. Revocation stops a device key, not the account key, and there's no account key rotation yet (future work).
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

Event `link.request { token, epk, mac, info }` goes to the session that created the link. Links live 5 minutes and are kept in memory only (≤ 100 per server).

The handshake (libsodium):
1. `master = crypto_generichash(32, token || secret, key = "iskra/link/v1")`; `crypto_kdf_derive_from_key` with context `isklink1`: id 1 = new device's MAC key, 2 = existing device's MAC key, 3 = confirmation key.
2. New device: ephemeral `crypto_box_keypair` `N`; posts `epk = N.pk`, `mac = crypto_auth(N.pk, k1)`.
3. Existing device checks the MAC (a wrong one ends the link: nothing is sent), makes `E`, answers `epk = E.pk`, `mac = crypto_auth(E.pk, k2)`. The new device checks that MAC.
4. Both show `crypto_generichash(8, E.pk || N.pk, key = k3)` as 6 digits (first 4 bytes, big-endian, mod 10⁶). The new device shows them and the person types them into the existing device, which only continues if they match (a wrong number cancels the link). A new device whose `POST` gets `409` (someone else used the token first) warns the person not to confirm anything on the other device.
5. Only then: `payload = nonce(24) || crypto_box(JSON, nonce, N.pk, E.sk)`, uploaded with `PUT`.

Payload: `{ v: 1, seed, name, recoverySaved, servers: [{ url, serverKey, name }], friends, history?, profile? }`: the 32-byte account seed (the new device makes its own device key and certificate from it), name, server list, friends, optionally recent decrypted DM history (≤ 200 messages per conversation, ≤ ~600 KB) and the profile ([below](#device-linking-carries-the-profile)). A server without the secret can't produce a valid MAC, so it can't put its own key in the middle; the confirmation code also catches someone who saw the code racing the real device.

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

A profile lives on the user's device and is sent to every server they're on, so one edit updates them all. Every `Member` gains:

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

Text rules are the same as names: trimmed, NFC, no control or invisible formatting characters. Each change is broadcast as `member.updated`. Event `profile.pages { enabled }` goes to everyone when an admin switches pages on or off; while off, every member's `page` is `null` and pages answer 404 (they're kept, so switching back on restores them). Publishing gives the page a new id. Pages are stored in `iskra.db`.

Themes are client-side only (a JSON file of colours, radius, avatar shape and fonts, validated value by value); nothing about them goes over the wire.

### Profile pages: the safety model

A page is one HTML file the member wrote. Viewers only load it when they click "Open profile page". It must not be able to touch the viewer's account, the app, or the network.

**Scripts are off by default.** `GET /pages/<id>` serves the page as static HTML and CSS: `sandbox` without `allow-scripts` and `script-src 'none'`. A viewer can turn scripts on for one page ("Run this page's scripts? The author could learn your IP address."); the client remembers that per `pageHash` on the device and then loads `GET /pages/<id>?scripts=1`, which differs only in `sandbox allow-scripts`, `script-src 'unsafe-inline'` and the prelude below.

**Served** (unguessable id, `no-store`) with:

```
Content-Security-Policy: sandbox [allow-scripts]; default-src 'none'; script-src 'none' | 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob: <this server>/files/; font-src data:; media-src 'none'; connect-src 'none'; form-action 'none';
  frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none';
  frame-ancestors 'self' https://app.iskra.foo app://iskra http://localhost:* http://127.0.0.1:* <AppUrl>
Permissions-Policy: camera=(), microphone=(), geolocation=(), autoplay=(), display-capture=(), fullscreen=(), payment=(), usb=(), …
X-Content-Type-Options: nosniff · Referrer-Policy: no-referrer · X-DNS-Prefetch-Control: off
Cross-Origin-Opener-Policy: same-origin · Cache-Control: no-store
```

- **Opaque origin** (`sandbox` without `allow-same-origin`): no cookies, storage or IndexedDB, and no access to the app or the server's origin. No `allow-popups`, `allow-top-navigation`, `allow-forms` or `allow-modals`.
- **No network**: no fetch, XHR, WebSocket, EventSource, beacons, workers, frames, forms or external images, fonts or media. Images may be `data:`/`blob:` or files uploaded to the same server. Audio and video are blocked entirely (`media-src 'none'`).
- **WebRTC** isn't covered by CSP in today's browsers. With scripts on, the server inserts a small script before the page (right after its doctype) that removes `RTCPeerConnection` and friends, and keeps the page out of child frames (which would have their own copy): `contentWindow`/`contentDocument` of frame elements, `window.frames`/`length`, and `createElement` for `iframe`, `frame`, `object` and `embed`. This is best effort: a determined script can still find a way (for example `window[0]` on a frame made from markup), which is why scripts are off by default.
- **No sound or devices**: autoplay, camera, microphone and the rest are denied by Permissions-Policy and by the frame's `allow` attribute.

**Shown** by the client in a modal, labelled with the author's name, as `<iframe sandbox="" referrerpolicy="no-referrer">` (`sandbox="allow-scripts"` once the viewer turned scripts on) inside a script-free `srcdoc` wrapper whose own policy is `frame-src <exactly this page's URL>`. Since a parent's `frame-src` governs every navigation of its child frames, the page can't navigate itself (and the viewer's IP) to another site; it can't navigate the wrapper (sandboxed navigation flag) or the app (no top navigation).

**Editor preview** runs the draft in the same sandbox: `page-preview.html` (a static file in the app with its own no-network policy) is loaded in `<iframe sandbox="allow-scripts">` and puts the draft, received by `postMessage` from its parent only, in a second `sandbox="allow-scripts"` frame.

Known limits: a page can load images from its own server's `/files/`, so that server sees when it's viewed. With scripts on, the author may be able to learn a viewer's IP address through WebRTC despite the prelude. Admins can remove any page of a member ranked below them, or turn pages off.

### Device linking carries the profile

The sealed link payload gains `profile: { bio?, pronouns?, accent?, avatar?: { data: b64u, type } | null, page?: { html } | null }`. The new device checks every field against the limits above and recomputes the hashes itself. If the payload would pass ~900 KB (a big page plus DM history), the page is left out; servers keep it.

## Push notifications (Web Push)

Each server sends Web Push messages to its members' devices that aren't looking at Iskra: for @mentions (including `@everyone` and `@here`), replies to your messages, DMs and incoming calls. The server keeps a VAPID key pair (P-256) in `vapid.json` in the world folder; payloads are encrypted per RFC 8291 (`aes128gcm`) and signed per RFC 8292 with [Lib.Net.Http.WebPush](https://github.com/tpeczek/Lib.Net.Http.WebPush).

| type | body | result | who |
|---|---|---|---|
| `push.status` | | `{ publicKey, endpoint }` (VAPID key, b64u 65 bytes; this device's endpoint or null) | anyone |
| `push.subscribe` | `endpoint` (≤ 1024 chars), `keys: { p256dh, auth }` (b64u, 65 and 16 bytes) | | anyone; replaces this device's subscription |
| `push.unsubscribe` | | | anyone (this device) |
| `push.focus` | `focused` (boolean) | | anyone: is someone looking at Iskra on this device right now |

- Subscriptions belong to the authenticated **device** (the key in the handshake's certificate). An endpoint belongs to one device; an account keeps at most 10 subscriptions (the least recently refreshed go first). Revoking a device deletes its subscription.
- The endpoint is user-supplied, so it must be `https://` on the default port, without credentials, at a known push service: `fcm.googleapis.com`, `android.googleapis.com`, `push.services.mozilla.com`, `notify.windows.com`, `push.apple.com` (or a subdomain). Deliveries also only connect to public addresses (the link preview guard). The push service answering 404 or 410 deletes the subscription.
- `@everyone` (all members) and `@here` (members online now) only ping when the author is trusted or above; from anyone else the text is shown but nobody is pushed, and clients don't count it as a mention either.
- Incoming-call pushes ring at once (no merging) but at most once per caller and callee per 15 s window.
- No pushes to a device whose session reported `focused: true` (a new session starts unfocused), to the author, to people who can't read the channel, or to non-members. Per device and conversation the first push goes out at once; more within 15 s become one follow-up push with a `count`.
- Payload (JSON, after decryption): `{ v: 1, kind: "mention"|"reply"|"dm"|"call"|"event", server, serverName, title, body, tag, channelId?, messageId?, peer?, count, at }`. Mentions and replies carry a ≤ 140-character excerpt; **DMs never carry content**: "New message from X". Calls say "X is calling". Event reminders ([Scheduled events](#scheduled-events)) say "Starting soon: …" or "… is starting now". The `Topic` header is derived from `tag`, so a push service replaces undelivered pushes about the same conversation.
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
- Bots can't join voice (`voice.join` → `forbidden`), create invites, or have a role above `trusted` (`member.setRole` → `bad_request`). They have the same rate limits as everyone else.
- Bots can't send DMs or take part in calls (`dm.send`, `call.start`, `call.accept` → `forbidden`; calling a bot → `bad_request`): DMs and call keys are end-to-end encrypted to people's devices, which a bot can't read.
- Commands are a message convention, not a protocol feature: a message starting with `/name args` (or `/name@BotName args` to pick one bot) is a command. See `docs/bots.md`.

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
  "router": { "state": "off" | "searching" | "found" | "not_found" | "disabled", "kind": "UPnP" | "NAT-PMP" | null },
  "publicIp": "203.0.113.7",                       // the router's internet-side address, or null
  "cgnat": false,                                  // that address is private/shared (100.64.0.0/10 etc.): ports can't help
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

- `welcome.server` carries `publicUrl` (string or null).
- Ports: outside TCP 80 (Let's Encrypt's HTTP-01 check) and 443 both lead to the server's one port, which speaks plain HTTP and HTTPS (TLS is detected from the first byte). If the router refuses 443, the server's own port is used outside too. Voice maps LiveKit's RTC TCP and UDP ports straight through. Leases are 1 hour, renewed at half-life and re-checked every 5 minutes (router restarts, new IPs); mappings are removed on shutdown.
- Without a certificate (e.g. port 80 refused) `publicUrl` stays null: a plain HTTP address is never advertised or put in invites. The only exception is a `PublicUrl` the owner set by hand in server.json, which is then used as is (the panel warns when it's plain HTTP).
- With a certificate, plain HTTP from public addresses is redirected to `publicUrl` (except `/.well-known/`); LAN and localhost are served as before. Webhooks (`/hooks/…`) that would be redirected (plain HTTP to the HTTPS-only port from anywhere but loopback, or from the internet) get `403` "use https" instead: their secret has already crossed the network in the clear, and a redirect would hide that. Clients that connected over HTTPS get `wss://<that host>/livekit` from `voice.join`.
- LiveKit advertises the public IP (`node_ip`) and keeps the LAN one (`advertise_internal_ip`), restarting when it changes.
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
| `GET /` | `{ iskra: 1, name }`: identifies an Iskra server |
| `GET /ws` | The WebSocket ([Connection](#connection)) |
| `PUT /upload/<ticket>` | Upload bytes for an `upload.begin` ticket ([Files](#files-replies-and-reactions)) |
| `GET /files/<id>/<name>` | Uploaded files, sniffed type, `nosniff` and a sandboxing CSP |
| `GET /pages/<id>` | Profile pages, in a sandbox ([Profile pages](#profile-pages-the-safety-model)) |
| `POST`, `GET /hooks/<id>/<secret>`, `POST .../github` | Incoming webhooks ([Webhooks](#webhooks)) |
| `POST`, `GET`, `PUT /link/<token>` | The device-linking relay ([Device linking](#device-linking)) |
| `/livekit` | LiveKit signaling, proxied ([Voice](#voice)) |
| `POST /internal/livekit-webhook` | LiveKit's signed webhooks, loopback only |
| `GET /.well-known/acme-challenge/<token>`, `GET /.well-known/iskra-probe/<token>` | Let's Encrypt and the reachability probe ([Internet hosting](#internet-hosting)) |

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
        "status": "scheduled" | "live" | "ended" | "cancelled", "interested": [accountKey] }
```

| type | body | result | who |
|---|---|---|---|
| `event.list` | | `{ events }` (scheduled and live, soonest first) | anyone |
| `event.create` | `title` (1–100), `description?` (≤ 1000, newlines allowed), `startAt, endAt` (start from now on, ≤ 1 year ahead; end after start, ≤ 7 days later), `timeZone` (≤ 64), `location: { channelId }` (a voice or stage channel you can see) or `{ text }` (1–100), `image?` (file id: your own PNG, JPEG, WebP or GIF upload, ≤ 5 MB) | `{ event }` | member+ (not guests); ≤ 100 scheduled or live events per server; 5 at once, then 1 every 2 minutes per account |
| `event.update` | `id` and any of the fields above (`""` clears `description` and `image`) | `{ event }` | whoever created it, or an admin who outranks them; while scheduled or live (a live event's start can't move) |
| `event.cancel` | `id` | | same as above |
| `event.interest` | `id, on?` (default true) | `{ event }` | anyone who can see it, while scheduled or live; 1/s, burst 5 per connection |

- The creator is interested from the start. `interested` lists current members only.
- **Visibility:** an event in a voice channel is only visible to people who can read that channel (others get `not_found` and no events). If the channel is deleted, `channelId` becomes `null` and the event is visible to everyone.
- **Timing:** the server moves an event to `live` at `startAt` and to `ended` at `endAt` (within about a second), and forgets ended and cancelled events after 30 days. Moving the start time re-arms the reminder.
- **Reminders:** 15 minutes before the start (only for events created further ahead than that) and again when it goes live, every interested member who can see it gets `event.reminder` on their sessions and a [push](#push-notifications-web-push) of kind `event` (no `channelId`: a click opens the server).
- "Add to calendar" is client-side: an iCalendar (RFC 5545) file with UTC times, built from the event.

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
- **Do not disturb:** the server sends no [Web Push](#push-notifications-web-push) at all to an account whose status is `dnd`, connected or not (it's kept while offline). Apps also stay quiet: no sounds or notifications.
- Rate limits: `presence.set` 1/s (burst 10), `presence.idle` 1 every 2 s (burst 10).

### Voice messages

A voice message is a channel message with one recorded audio file and no text:

| type | body | result | who |
|---|---|---|---|
| `chat.send` | adds `voice?: { duration (ms, 1–300000), waveform (b64u, 1–128 bytes, 0–255 each) }`, with exactly one attachment and empty `text` | | channel writers |

- The file must be Ogg, WebM or MP4 (what `MediaRecorder` makes: Ogg/WebM Opus, Safari's MP4/AAC) and at most 10 MB. For Ogg the server measures the length itself (and refuses recordings over 5 minutes); WebM and MP4 recordings carry no reliable length, so theirs is only bounded. The waveform is computed by the recording app.
- `Message` gains `voice: { duration, waveform } | null`; the audio is `attachments[0]`. Voice messages can't be edited.
- Voice messages are for channels only. DMs don't carry files yet, so there is no end-to-end encrypted variant.
