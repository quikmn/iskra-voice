# Iskra wire protocol

Version 1. This is the reference that the server (`server/`) and the client (`client/`) both implement.
`vectors.json` holds fixed test vectors that both test suites check, so the two sides can't drift apart.

## Encoding

- Keys, nonces and signatures are **base64url without padding**.
- Every key is Ed25519 (32-byte public key, 64-byte signature).
- Timestamps are Unix **milliseconds** (integers).
- Strings are UTF-8. The server rejects names containing control characters, and anything longer than the documented limits.

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

Every signed payload starts with a context string followed by a zero byte, so a signature made for one purpose can never be reused as a valid signature for another.

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
3. **Server checks:**
   - the certificate signature
   - the auth signature
   - the profile name (1–32 characters, no control characters)
   - that the account isn't banned
   - membership: accounts that aren't members yet need a valid `invite`, which also sets their role
4. **Server sends `welcome`:**
   ```jsonc
   { "type": "welcome", "body": {
       "you": Member, "server": { "name": "Gaming", "key": "<b64u>" },
       "channels": [Channel...],   // only the ones you can read
       "members": [Member...] } }
   ```

If a check fails, the server sends `error` and closes:

| code | close | when |
|---|---|---|
| `auth_failed` | 4401 | Bad certificate, signature or name, or timeout (same message whatever the reason) |
| `invite_required` | 4401 | Valid identity, not a member, no usable invite |
| `banned` | 4403 | The account is banned |
| `device_revoked` | 4401 | Valid identity, but the account revoked this device (see "Devices") |

### Limits

| Limit | Value |
|---|---|
| Frame size before auth | 4 KB |
| Frame size after auth | 64 KB (uploads use HTTPS, not the socket) |
| Auth timeout | 5 s |
| Unknown `type` | `error` with `code: "unknown_type"`. The session stays open. |
| Malformed JSON or envelope | `error` with `code: "bad_request"`. The session stays open; after 10 bad frames in a row the server closes with 4400. |

### Close codes

| Code | Meaning |
|---|---|
| 4400 | Bad requests |
| 4401 | Auth failed or timed out |
| 4403 | Banned or kicked |
| 4413 | Frame too large |

## Objects

```jsonc
Member  { "accountKey": "<b64u>", "name": "Viktor", "role": "member", "online": true }
Channel { "id": 1, "name": "general", "kind": "text" | "voice", "position": 0, "readRole": "member", "writeRole": "member" }
Message { "id": 42, "channelId": 1, "author": "<accountKey>", "text": "hi", "createdAt": 1760000000000, "editedAt": null }
Invite  { "code": "<b64u 16>", "role": "member", "createdBy": "<accountKey>", "createdAt": 0, "expiresAt": 0, "maxUses": null, "uses": 0 }
```

Roles, lowest to highest: `guest < member < trusted < admin < owner`.

## Requests

Every request gets a `result` (body as listed, `{}` if none) or an `error` with one of these codes: `bad_request`, `forbidden`, `not_found`, `rate_limited`, `unknown_type`, `internal`.
Channels you can't read are reported as `not_found`, never `forbidden`, so their existence doesn't leak.

| type | body | result | who |
|---|---|---|---|
| `ping` | | | anyone |
| `chat.send` | `channelId, text` (1–4000 chars, newlines allowed) | `{ message }` | channel writers |
| `chat.edit` | `id, text` | `{ message }` | the author |
| `chat.delete` | `id` | | the author, or an admin who outranks the author |
| `chat.history` | `channelId, before? \| after?, limit? (1–100, default 50)` | `{ messages (oldest first), hasMore }` | channel readers |
| `chat.typing` | `channelId` | | channel writers |
| `channel.create` | `name, kind? (text\|voice), readRole?, writeRole?` | `{ channel }` | admin+ |
| `channel.update` | `id, name?, readRole?, writeRole?` | `{ channel }` | admin+ |
| `channel.delete` | `id` | | admin+ |
| `profile.update` | `name` | `{ member }` | anyone |
| `member.setRole` | `accountKey, role` | `{ member }` | admin+, target ranked below you, role below yours |
| `member.kick` | `accountKey` | | same as above |
| `member.ban` | `accountKey, reason?` | | same as above |
| `member.unban` | `accountKey` | | admin+ |
| `member.bans` | | `{ bans }` | admin+ |
| `invite.create` | `role? (default member), maxUses? (1–1000), expiresInMs? (1 min – 30 days, default 7 days)` | `{ invite }` | member+ for guest/member invites; higher roles need the right to grant them |
| `invite.list` | | `{ invites }` | admins see all, others their own |
| `invite.revoke` | `code` | | the creator or admin+ |

Rate limits per connection: 10 requests/s sustained (burst 40), `chat.send` 2/s (burst 10), `chat.typing` 1 every 2 s (burst 3).
Writing in a channel requires being able to read it (`writeRole` ≥ `readRole`).

## Events

| type | body | sent to |
|---|---|---|
| `chat.message` | `{ message }` | channel readers |
| `chat.edited` | `{ message }` | channel readers |
| `chat.deleted` | `{ id, channelId }` | channel readers |
| `chat.typing` | `{ channelId, accountKey }` | channel readers except the typist |
| `channels` | `{ channels }` | a member whose visible channels changed (role change, channel created/updated/deleted) |
| `member.joined` | `{ member }` | everyone |
| `member.updated` | `{ member }` | everyone (name, role or online status changed) |
| `member.removed` | `{ accountKey }` | everyone (kicked or banned) |
| `kicked` | `{ reason }` | the removed member, right before the socket closes with 4403 |

## Invite links

`<appUrl>/#/join/<b64u(serverUrl)>.<serverKey>.<code>`. The client connects to `serverUrl`, checks that `hello.serverKey` equals the key in the link, and only then sends `auth` with the code.

A new world has no owner. On startup the server writes a single-use owner invite link to `owner-invite.txt` in the world folder (and logs it); the file is deleted once the owner joins.

## Voice

Voice runs on a LiveKit server that `iskra-server` starts next to itself (config generated from `server.json` → `Voice`, keys in `livekit.key` in the world folder). Iskra never carries audio; it only decides who may join.

| type | body | result | who |
|---|---|---|---|
| `voice.join` | `channelId` (a `voice` channel) | `{ url, token, room, canSpeak }` | channel readers; `canSpeak` = channel writers |
| `voice.state` | `muted, deafened` (booleans) | | anyone in voice (cosmetic flags shown to others) |

- `token` is a LiveKit JWT for exactly one room (`voice-<channelId>`) with `canPublish = canSpeak`. The client connects to `url` with it.
- LiveKit's signaling is proxied by iskra-server at `/livekit` (WebSocket and HTTP), so `url` is `ws(s)://<server>/livekit` and clients only need the server's web port plus LiveKit's media ports (UDP 7882, TCP 7881 fallback).
- **Who is in voice comes only from LiveKit's signed webhooks** (`POST /internal/livekit-webhook`, loopback only, HS256 JWT whose `sha256` claim matches the body), never from clients. Anyone LiveKit reports who isn't allowed in the room is removed from it.
- Kicks, bans, demotions and channel permission changes remove people from rooms they can no longer read.
- `welcome` also carries `voice: [VoiceState...]` (non-empty voice channels you can read) and `voiceAvailable`.
- Error `voice_unavailable`: LiveKit isn't running on this server.

| event | body | sent to |
|---|---|---|
| `voice.state` | `{ channelId, participants: [{ accountKey, muted, deafened }] }` | readers of that voice channel |
| `voice.available` | `{ available }` | everyone, when LiveKit comes up or goes down |

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

### Envelope v1 (built and checked only by clients)

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
- Safety number: `crypto_generichash(60, sort(accountA, accountB))` shown as 12 groups of 5 digits.
- Envelope v2 (below, "Forward secrecy") is what clients send now; v1 envelopes are still accepted and decrypted.
- Not yet: DMs between people who share no server.

## Hosting (server.json)

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

## Files, replies and reactions

| type | body | result | who |
|---|---|---|---|
| `upload.begin` | `name, size` (bytes, ≤ `MaxUploadMb`, default 100) | `{ url: "/upload/<ticket>", maxBytes }` | anyone |
| `chat.send` | adds `attachments?: [fileId...]` (≤ 10, your own uploads; text may then be empty) and `replyTo?: messageId` (same channel) | | |
| `chat.react` | `id, emoji` (≤ 16 chars, no spaces), `on?` (default true) | | channel readers; ≤ 20 different emoji per message |

- Upload: `PUT <server>/upload/<ticket>` with the raw bytes (single use, 10 minutes, must not exceed the announced size) → `{ file }`.
- File: `{ id, name, size, type, width?, height?, url: "/files/<id>/<name>" }`. `type` comes from the file's first bytes, never the name: PNG, JPEG, GIF, WebP, MP4, WebM, Ogg and MP3 are served inline, anything else as a download. Every file response has `nosniff` and a sandboxing CSP. Identical content is stored once (`uploads/ab/<sha256>`).
- Message gains `attachments: [File]`, `replyTo: { id, author, text, hasAttachments } | { id, deleted: true } | null` and `reactions: [{ emoji, accounts: [accountKey] }]`.
- Event `chat.reactions` `{ id, channelId, reactions }` to channel readers.

## Link previews

| type | body | result |
|---|---|---|
| `link.preview` | `url` (http/https, no credentials) | `{ preview: { url, siteName, title, description } \| null }` |

The server fetches the page (so viewers' IPs aren't sent to every site): ≤ 512 KB of HTML, 6 s, ≤ 3 redirects, cached for an hour. It only connects to public addresses: each connection's IP is checked after DNS resolution, so private ranges, loopback, link-local/cloud metadata and redirects into them are refused. No images are fetched or shown. Runs off the read loop; rate-limited to 1/s (burst 10).

## Devices, forward secrecy and device linking

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
- Revocation: `sig = Ed25519.sign(accountSecret, "iskra/device-revoke/v1" || 0x00 || deviceKey(32) || u64be(revokedAt))`. `revokedAt` may be at most 10 minutes in the future. A revocation only ever applies to devices of the account that signed it. At most 100 per account; idempotent.
- Once a server has a revocation: the device's auth fails with `device_revoked`; its open sessions get `device.revoked` and are kicked (4403); it disappears from `dm.devices` and `device.list`; its prekey is dropped. The revocation can arrive before the device ever connects there.
- Every session of the account gets `device.revoked { deviceKey }`. Clients keep the revocations they know (their own, and verified ones from any server) and hand missing ones to each server on connect, so a revocation reaches every server the account is on.
- Prekey: `sig = Ed25519.sign(deviceSecret, "iskra/prekey/v1" || 0x00 || key(32) || u64be(created))`, signed by the **device** key, so the account-signed certificate vouches for it. The server keeps the newest per device and refuses keys older than 60 days or more than 10 minutes in the future.

| event | body | sent to |
|---|---|---|
| `device.revoked` | `{ deviceKey }` | every session of the account (the revoked device's own sessions, then kicked) |

### Forward secrecy (DM envelope v2)

Each device has an X25519 **prekey** (`crypto_box_keypair`), rotated every 7 days and published to every server it connects to. A replaced prekey's secret is kept for 30 days (for messages still on their way), then deleted.

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
- Safety numbers are unchanged (they cover account keys).

### Device linking

Moves an account to a new device without the recovery key. The existing device (signed in) talks to one of its servers over its WebSocket; the new device (no account yet) uses a small HTTP relay on the same server.

The **link code**: `<server url without "https://">/<base32(token(10) || secret(16))>` (Crockford base32, groups of 4), e.g. `chat.example.com/QHN8-BTHD-…`. The QR code holds `<appUrl>/#/link/<urlencoded code>`, so a phone camera opens the web app straight into linking; the part after `#` never reaches a server. The server sees the token, never the secret.

| type | body | result | who |
|---|---|---|---|
| `link.create` | | `{ token, putKey, expiresAt }` | members; ≤ 3 open links per account (`rate_limited`), rate limit 3 burst / 1 per 10 s |
| `link.respond` | `token, epk, mac` (32 bytes each) | | the account that created the link, after a `link.request` |
| `link.cancel` | `token` | | the account that created the link |

| HTTP (CORS open, no auth) | body | answer |
|---|---|---|
| `POST /link/<token>` | `{ epk, mac, info? }` (≤ 1 KB; `info` ≤ 64 chars, a device description) | `{ key, expiresAt }` (the read key). 404 unknown/expired, 409 already used, 413 too big |
| `GET /link/<token>?key=<read key>` | | `{ state: "waiting" }`, `{ state: "answered", epk, mac }` or `{ state: "done", payload }` (b64u, handed out once, then the link is gone). 403 wrong key, 429 after 600 polls |
| `PUT /link/<token>?key=<putKey>` | the sealed payload (≤ 1 MB) | only once answered. 403 wrong key, 409 wrong state, 413 too big |

Event `link.request { token, epk, mac, info }` goes to the session that created the link. Links live 5 minutes and are kept in memory only (≤ 100 per server).

The handshake (libsodium):
1. `master = crypto_generichash(32, token || secret, key = "iskra/link/v1")`; `crypto_kdf_derive_from_key` with context `isklink1`: id 1 = new device's MAC key, 2 = existing device's MAC key, 3 = confirmation key.
2. New device: ephemeral `crypto_box_keypair` `N`; posts `epk = N.pk`, `mac = crypto_auth(N.pk, k1)`.
3. Existing device checks the MAC (a wrong one ends the link: nothing is sent), makes `E`, answers `epk = E.pk`, `mac = crypto_auth(E.pk, k2)`. The new device checks that MAC.
4. Both show `crypto_generichash(8, E.pk || N.pk, key = k3)` as 6 digits (first 4 bytes, big-endian, mod 10⁶). The person confirms on the existing device that both match.
5. Only then: `payload = nonce(24) || crypto_box(JSON, nonce, N.pk, E.sk)`, uploaded with `PUT`.

Payload: `{ v: 1, seed, name, recoverySaved, servers: [{ url, serverKey, name }], friends, history? }` — the 32-byte account seed (the new device makes its own device key and certificate from it), profile, server list, friends and optionally recent decrypted DM history (≤ 200 messages per conversation, ≤ ~600 KB). A server without the secret can't produce a valid MAC, so it can't put its own key in the middle; the confirmation code also catches someone who saw the code racing the real device.
