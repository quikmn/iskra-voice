# Iskra

A self-hosted voice and text app for friend groups: like Discord, but free, easy, and yours.

## Repo

| Path | What it is |
|---|---|
| `protocol/`, `server/`, `client/`, `desktop/`, `scripts/` | The app (see below) |
| `docs/` | Public docs: `hosting.md` (the app links to it), `security.md`, `development.md` |
| `site/` | The iskra.foo website (Cloudflare Pages project `iskra-hero-page`). Keep it in sync with what the app actually does. |

An older, retired codebase lives on the `v1` branch (tag `v1-final`); don't add features to it. **In anything public the product is just "Iskra"**: never "Iskra 2", no "rebuilt", no mention of v1.

Private design notes live in `design/` (local only, ignored). If it exists, read `design/ISKRA_2_DESIGN.md` before making architectural changes; `protocol/PROTOCOL.md` is the public reference.

## Layout

- `protocol/`: `PROTOCOL.md` (the wire protocol, the source of truth) and `vectors.json` (shared crypto test vectors; regenerate with `node scripts/gen-vectors.mjs` from `client/`, only when the protocol changes).
- `server/`: C# / .NET 10 / ASP.NET Core.
  - `Sessions/`: one connection per session. One reader and one writer, with outbound messages going through a channel. Never send on a socket from anywhere else.
  - `Storage/`: a world is a folder (`server.json`, `server.key`, `iskra.db`, `uploads/`). SQLite, with all writes behind one lock; files are written atomically.
  - `Crypto/`: Ed25519 via NSec (libsodium).
  - `Hosting/`: automatic HTTPS (`Certificates`, Let's Encrypt via Certes 3.0.4), child-process lifetime (`ChildProcesses`).
  - `Voice/`: `LiveKitHost` starts and supervises livekit-server (pinned v1.13.7; get it with `scripts/get-livekit.ps1`/`.sh` into `.tools`). `VoiceRegistry` tracks who's in voice from LiveKit's signed webhooks only.
- `client/`: TypeScript, React, Vite, zustand.
  - `src/core/`: protocol types, crypto (libsodium-wrappers-sumo), identity, invite links, `Connection` (handshake, requests, reconnect with backoff), IndexedDB storage.
  - `src/state/store.ts`: app state and every server action. Components never talk to the socket directly.
  - `src/ui/`: React components. User text is rendered by React only.
- `desktop/`: Electron 44 shell (`src/main.ts`, `preload.ts`, `ptt.ts`, `host.ts`). "Create a server" runs the bundled iskra-server + LiveKit on world folders in Documents\Iskra\Servers (`ISKRA_HOST_ROOT` overrides, tests use it); servers stop with the app (parent-PID watch + tree kill; LiveKit is bound to a Windows job object). Serves the built client on `app://iskra/`, sandboxed renderer, IPC only from the app page, global push-to-talk via uiohook-napi, screen/window picker, tray. `npm run dist` publishes a self-contained server into `build/server`, then builds `release/Iskra Setup x.y.z.exe` + portable exe (~150 MB), signed with the Certum certificate in the CurrentUser store via `win.signtoolOptions` (and `scripts/sign.ps1` for the standalone server); unsigned if the certificate isn't present. Electron's binary download may need `node node_modules/electron/install.js` after `npm install`.
- `dev.ps1`: starts the server on `.dev/<world>` plus the Vite dev server. On a new world the server prints a one-time owner invite link (also in `owner-invite.txt`): open it to become the owner.

## Commands

```powershell
cd server;   dotnet test          # server tests (real server + WebSocket clients)
cd client;   npm test             # client tests (vitest)
cd client;   npm run build        # type-check + build
cd client;   npm run test:interop # TS client against the real .NET server
cd client;   npm run test:e2e     # Playwright: browsers + the Electron app against real servers (screenshots in e2e/screenshots)
cd desktop;  npm start           # run the desktop app against the built client
.\dev.ps1                          # run everything locally
```

CI (`.github/workflows/ci.yml`) runs everything on Windows and Linux.

## Rules

- **The server trusts nothing the client says about itself.** Identity comes only from the signed handshake. Permissions are checked on the server for every request and every broadcast.
- Every new protocol message goes in `PROTOCOL.md` first, with size limits, and gets a server test. Bugs get a regression test.
- No hand-rolled crypto. Use libsodium primitives, put a context string on every signed payload, and never fall back to plaintext.
- Don't put user content into HTML strings in the client; let React render it. Never use `dangerouslySetInnerHTML` on user content.
- Never commit secrets, world folders, `design/`, or deploy scripts that contain keys.
- Live infrastructure: only the static sites (iskra.foo, app.iskra.foo on Cloudflare Pages). No hosted servers; testing is local.
- Releases: GitHub releases built from `desktop` (`npm run dist`) plus server zips. Keep `client/src/links.ts` (download links in the app) and the site's download section in step with the latest release.
- Default server port is 47070 (7070 clashes with AnyDesk). Test tools live in `.tools` (`scripts/get-livekit.*`, `scripts/get-pebble.ps1`).
