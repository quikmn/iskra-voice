# Iskra push relay

A small Cloudflare Worker at **https://push.iskra.foo** that gets push notifications from Iskra servers to the phone
apps. Iskra servers are self-hosted, so they can't hold Apple's (APNs) or Google's (FCM) push credentials for the
app; the relay holds them and forwards pushes it can't read. The design follows Signal's and Matrix's push gateways
(sygnal): the app registers its device token with the relay and gets an opaque handle back; servers only ever see the
handle.

```
 phone app ──(1) POST /v1/register {platform, token, voip?, vapidKey}──► relay ──► { endpoint: …/v1/push/<handle> }
 phone app ──(2) push.subscribe {kind: "native", endpoint, keys}──────► Iskra server
 Iskra server ──(3) Web Push (RFC 8030/8291, VAPID-signed, body encrypted to the phone)──► relay /v1/push/<handle>
 relay ──(4) opens the handle → device token, checks the VAPID signature ──► APNs / FCM ──► phone decrypts and shows it
```

- **Handles** are the device token(s) plus the server's VAPID public key, sealed with AES-256-GCM (WebCrypto) under
  `HANDLE_KEYS`. Nothing is stored: no device database, no logs of tokens or bodies (Workers observability is off).
- **One handle per server.** The relay accepts a push only when it's VAPID-signed (RFC 8292) by the key sealed in the
  handle, with `aud` = the relay's origin and `exp` within 24 hours. A leaked handle can't be used by anyone else.
- **Payloads** stay end-to-end encrypted from the Iskra server to the phone (the server encrypts exactly as it does
  for a browser). Apple and Google get `{ e: <base64 ciphertext>, k: "note"|"call" }`; the iOS Notification Service
  Extension and the Android app decrypt it and show "Alex in #general: …" locally.
- **Calls**: `/v1/call/<handle>` (the server uses it for ringing calls). iOS gets a VoIP push (PushKit → CallKit's
  incoming call screen) when the app registered a VoIP token; Android gets a high-priority data message and shows a
  full-screen call notification.
- **Abuse limits**: 20 registrations/min per IP, 600 pushes/min per sending IP, 60 pushes/min per device (Cloudflare's
  rate limiting binding, per location); bodies ≤ 3 KB; only aes128gcm; unknown or forged handles get 404.
- Dead tokens (APNs 410/BadDeviceToken, FCM UNREGISTERED) answer **410**, so the server deletes the subscription.

Full protocol: [PROTOCOL.md "Native push"](../protocol/PROTOCOL.md#native-push-phone-apps).

## What each party sees

| Party | Sees | Doesn't see |
|---|---|---|
| Iskra server | the handle (and the app's public push key) | the device token |
| Relay | device token, sending server's IP, time, ciphertext size | content, who the message is from |
| Apple / Google | device token, time, ciphertext size, `note` or `call` | content (DMs and group messages never carry content in the first place) |

The trade-off against a generic "New notification": the phone shows real text, at the cost of trusting the Iskra
server with what it already knows (channel mentions it stores anyway; DMs only say "New message from Alex").

## Why a Worker

Free at this scale (100k requests/day), no server to patch, outside the droplet's failure domain, deployed by the
existing Cloudflare token, secrets kept as Worker secrets. Workers talk HTTP/2 to APNs in production (`wrangler dev`
on a desktop may not: test against the deployed relay). The alternative, a mode of iskra-server on the droplet, would
put Apple's key on a box that also runs a chat server and couple push to its uptime.

## Develop

```
cd relay
npm ci
npm test            # vitest: handles, VAPID, JWTs, APNs/FCM requests (faked), routes, limits
npm run typecheck
npx wrangler@4.136.3 deploy --dry-run --outdir dist   # bundle check, no account needed
```

## Configuration

| Name | Kind | What |
|---|---|---|
| `HANDLE_KEYS` | secret (required) | `1:<base64 32 random bytes>`; rotate by prepending a new id: `2:<new>,1:<old>` (new handles use the first; old ones keep working until you drop the old key) |
| `APNS_KEY` | secret | the APNs auth key (.p8 file contents, PEM) |
| `APNS_KEY_ID` | secret | its Key ID (10 characters) |
| `FCM_SERVICE_ACCOUNT` | secret | the Firebase service account JSON |
| `APNS_TEAM_ID`, `APNS_TOPIC` | vars (wrangler.toml) | `BWX2M8XSNZ`, `foo.iskra.app` |

In GitHub they're `release` environment secrets (`RELAY_HANDLE_KEYS`, `APNS_KEY_P8`, `APNS_KEY_ID`,
`FCM_SERVICE_ACCOUNT_JSON`); `deploy.yml` with `relay=true` deploys the Worker and sets them. Setup and renewal:
[docs/ci-cd.md "Push relay"](../docs/ci-cd.md#push-relay).
