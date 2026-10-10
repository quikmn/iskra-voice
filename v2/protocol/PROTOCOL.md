# Iskra 2 wire protocol

Version 1. This is the reference that the server (`v2/server`) and the client (`v2/client`) both implement.
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
- **Who is in voice comes only from LiveKit's signed webhooks** (`POST /livekit/webhook`, loopback only, HS256 JWT whose `sha256` claim matches the body), never from clients. Anyone LiveKit reports who isn't allowed in the room is removed from it.
- Kicks, bans, demotions and channel permission changes remove people from rooms they can no longer read.
- `welcome` also carries `voice: [VoiceState...]` (non-empty voice channels you can read) and `voiceAvailable`.
- Error `voice_unavailable`: LiveKit isn't running on this server.

| event | body | sent to |
|---|---|---|
| `voice.state` | `{ channelId, participants: [{ accountKey, muted, deafened }] }` | readers of that voice channel |
