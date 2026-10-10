# Iskra

A self-hosted voice and text app for friend groups: like Discord, but free, easy, and yours.

## The repo is in transition

| Path | What it is |
|---|---|
| `v2/` | **Iskra 2, the rebuild. All new work happens here.** |
| `site/` | The iskra.foo website (Cloudflare, deployed with wrangler). Keep it in sync with what v2 actually does. |
| everything else | Iskra v1. Frozen and unsupported, kept for reference until v2 replaces it. Don't add features to it. |

The design and the v1 audit are in `design/`. That folder is local only and is **excluded from git** through `.git/info/exclude`, because the repo is public and the audit describes exploitable v1 bugs. Read `design/ISKRA_2_DESIGN.md` before making architectural changes.

## v2 layout

- `v2/protocol/`: `PROTOCOL.md` (the wire protocol, the source of truth) and `vectors.json` (shared crypto test vectors; regenerate with `node scripts/gen-vectors.mjs` from `v2/client`, only when the protocol changes).
- `v2/server/`: C# / .NET 10 / ASP.NET Core.
  - `Sessions/`: one connection per session. One reader and one writer, with outbound messages going through a channel. Never send on a socket from anywhere else.
  - `Storage/`: a world is a folder (`server.json`, `server.key`, `iskra.db`, `uploads/`). SQLite, with all writes behind one lock; files are written atomically.
  - `Crypto/`: Ed25519 via NSec (libsodium).
  - `Voice/`: `LiveKitHost` starts and supervises livekit-server (pinned v1.13.7; get it with `v2/scripts/get-livekit.ps1`/`.sh` into `v2/.tools`). `VoiceRegistry` tracks who's in voice from LiveKit's signed webhooks only.
- `v2/client/`: TypeScript, React, Vite, zustand.
  - `src/core/`: protocol types, crypto (libsodium-wrappers-sumo), identity, invite links, `Connection` (handshake, requests, reconnect with backoff), IndexedDB storage.
  - `src/state/store.ts`: app state and every server action. Components never talk to the socket directly.
  - `src/ui/`: React components. User text is rendered by React only.
- `v2/dev.ps1`: starts the server on `v2/.dev/<world>` plus the Vite dev server. On a new world the server prints a one-time owner invite link (also in `owner-invite.txt`): open it to become the owner.

## Commands

```powershell
cd v2/server; dotnet test          # server tests (real server + WebSocket clients)
cd v2/client; npm test             # client tests (vitest)
cd v2/client; npm run build        # type-check + build
cd v2/client; npm run test:interop # TS client against the real .NET server
cd v2/client; npm run test:e2e     # Playwright: two browsers, real app + real server (screenshots in e2e/screenshots)
.\v2\dev.ps1                       # run everything locally
```

CI (`.github/workflows/v2.yml`) runs both on Windows and Linux.

## Rules

- **The server trusts nothing the client says about itself.** Identity comes only from the signed handshake. Permissions are checked on the server for every request and every broadcast.
- Every new protocol message goes in `PROTOCOL.md` first, with size limits, and gets a server test. Bugs get a regression test.
- No hand-rolled crypto. Use libsodium primitives, put a context string on every signed payload, and never fall back to plaintext.
- Don't put user content into HTML strings in the client; let React render it. Never use `dangerouslySetInnerHTML` on user content.
- Never commit secrets, world folders, `design/`, or deploy scripts that contain keys.
- Testing is local only. There is no hosted infrastructure right now.
