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
   { "type": "auth", "body": { "cert": DeviceCert, "sig": "<b64u 64>", "profile": { "name": "Viktor" } } }
   ```
   `sig = Ed25519.sign(deviceSecret, "iskra/auth/v1" || 0x00 || serverKey(32) || nonce(32))`

   Because the signature covers the server's key and a fresh nonce, it can't be replayed, either against this server or against a different one.
3. **Server checks:**
   - the certificate signature
   - the auth signature
   - the profile name (1–32 characters, no control characters)
   - that the account isn't banned
   - membership (from M1 onward: an invite is required for accounts that aren't members yet)
4. **Server sends `welcome`:**
   ```jsonc
   { "type": "welcome", "body": { "you": { "accountKey": "...", "name": "Viktor", "role": "member" }, "server": { "name": "Gaming" } } }
   ```

If any check fails, the server sends `error` (`code: "auth_failed"`, with the same message whatever the reason) and closes with WebSocket close code 4401.

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
