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
- `v2/client/`: TypeScript, React, Vite. The crypto is libsodium-wrappers-sumo, in `src/core/crypto.ts`.
- `v2/dev.ps1`: starts the server on `v2/.dev/<world>` plus the Vite dev server.

## Commands

```powershell
cd v2/server; dotnet test          # server tests (real server + WebSocket clients)
cd v2/client; npm test             # client tests (vitest)
cd v2/client; npm run build        # type-check + build
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
