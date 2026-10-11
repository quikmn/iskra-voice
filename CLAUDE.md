# Iskra

A self-hosted voice and text app for friend groups: like Discord, but free, easy, and yours.

## Repo

| Path | What it is |
|---|---|
| `protocol/`, `server/`, `client/`, `desktop/`, `bots/`, `scripts/` | The app (see below) |
| `docs/` | Public docs: `hosting.md` (the app links to it), `security.md`, `bots.md`, `development.md`, `ci-cd.md` + `ci-cd-playbook.md` (releases and deploys), `releases/` (release notes) |
| `site/` | The iskra.foo website (Cloudflare Pages project `iskra-hero-page`). Keep it in sync with what the app actually does. |

An older, retired codebase lives on the `v1` branch (tag `v1-final`); don't add features to it. **In anything public the product is just "Iskra"**: never "Iskra 2", no "rebuilt", no mention of v1.

Private design notes live in `design/` (local only, ignored). If it exists, read `design/ISKRA_2_DESIGN.md` before making architectural changes; `protocol/PROTOCOL.md` is the public reference.

## Layout

- `protocol/`: `PROTOCOL.md` (the wire protocol, the source of truth) and `vectors.json` (shared crypto test vectors; regenerate with `node scripts/gen-vectors.mjs` from `client/`, only when the protocol changes).
- `server/`: C# / .NET 10 / ASP.NET Core.
  - `Sessions/`: one connection per session. One reader and one writer, with outbound messages going through a channel. Never send on a socket from anywhere else. Per-type rate limits in `RateLimiter.cs`.
  - `Features/`: one `<Feature>Feature.cs` per area (chat, pins, threads, search, polls, emoji, stickers, GIFs, soundboard, voice messages, forwarding, forums, events, stages, watch parties, calls, group DMs and group calls, DM files, devices, link relay, keys (account key rotation), webhooks, bots, push, profiles, presence, activity, prefs, organize (categories, nicknames, notification levels), roles, moderation, backups, server moves, Discord import, internet hosting), each registered with one line in `Router.cs`. Background work: `EventScheduler`, `PollCloser`, `ModerationSweeper`, `UploadSweeper`.
  - `Storage/`: a world is a folder (`server.json`, `server.key`, `iskra.db`, `uploads/`, `livekit.key`, `vapid.json`, `certs/`). SQLite, with all writes behind one lock; files are written atomically. Store methods live in partial files `Store.<Feature>.cs`.
  - `Crypto/`: Ed25519 via NSec (libsodium).
  - `Hosting/`: automatic HTTPS (`Certificates`, Let's Encrypt via Certes 3.0.4), internet hosting (`InternetHost`, UPnP/NAT-PMP in `Upnp`/`NatPmp`, HTTP+HTTPS on one port in `DualProtocol`), child-process lifetime (`ChildProcesses`).
  - `Push/`: Web Push (VAPID keys, sender, who gets notified).
  - `Voice/`: `LiveKitHost` starts and supervises livekit-server (pinned v1.13.7; get it with `scripts/get-livekit.ps1`/`.sh` into `.tools`). `VoiceRegistry` tracks who's in voice from LiveKit's signed webhooks only (and server mutes); `CallRegistry` handles DM calls, `GroupCallRegistry` group calls, `StageRegistry` who may speak on stages (through LiveKit's RoomService), `WatchRegistry` watch-party clocks.
  - `Backups/` (encrypted backup files, daily backups, restore), `Import/` (DiscordChatExporter imports), `Gifs/` (KLIPY, direct or proxied). `Cli.cs`: `restore`, `backup`, `move`, `import-discord` commands.
- `client/`: TypeScript, React, Vite, zustand.
  - `src/core/`: protocol types, crypto (libsodium-wrappers-sumo), identity, DM envelopes, group chains (`group.ts`), encrypted DM files, account key rotation, synced prefs, devices/prekeys, device linking, invite links, `Connection` (handshake, requests, reconnect with backoff), IndexedDB storage (secrets encrypted at rest). Also used by the bot SDK, so no DOM or React here.
  - `src/state/`: `store.ts` holds app state and core server actions; features keep their state in their own files (`calls.ts`, `pins.ts`, `push.ts`, ...) using the hooks in store.ts (`onServerEvent`, `onWelcomeHook`, `connectionFor`). Components never talk to the socket directly.
  - `src/theme/`: built-in themes and the theme-JSON validator.
  - `src/ui/`: React components. User text is rendered by React only.
  - `public/`: PWA manifest, `push-sw.js` (push only, no caching) and `page-preview.html` (profile page editor sandbox).
- `bots/`: Node bot SDK (`sdk/src`, reuses `client/src/core`) and the Dice example; `npm run dice`, `npm run typecheck`. See `docs/bots.md`.
- `desktop/`: Electron 44 shell (`src/main.ts`, `preload.ts`, `ptt.ts`, `host.ts`, `updates.ts`; per-OS decisions in `platform.ts`, unit-tested with `npm test`). Windows, Linux and macOS. "Create a server" runs the bundled iskra-server + LiveKit on world folders in Documents/Iskra/Servers (Application Support/Iskra/Servers on macOS; `ISKRA_HOST_ROOT` overrides, tests use it); servers stop cleanly with the app (closing their stdin, `ISKRA_STOP_ON_STDIN_CLOSE`; force-killed after 5 s; parent-PID watch as backup; LiveKit is bound to a Windows job object). Serves the built client on `app://iskra/`, sandboxed renderer, IPC only from the app page, global push-to-talk via uiohook-napi (macOS: Accessibility permission), screen/window picker (Windows loopback audio without the app's own), tray, OS keychain for the keys (`safeStorage`), `iskra://join/` invite links, desktop settings (`settings.ts`), opt-in game activity (`activity.ts`, `games.ts`), backup restore (`restore.ts`), electron-updater from GitHub releases. `npm run dist` publishes a self-contained server into `build/server-win-x64`, then builds `release/Iskra-Setup-x.y.z.exe` + portable exe + `latest.yml`, signed with the Certum certificate in the CurrentUser store via `win.signtoolOptions` (and `desktop/scripts/sign.ps1` for the standalone server); `npm run dist:unsigned` never touches the token. Linux (AppImage/deb/rpm) and macOS (dmg/zip, ad-hoc signed) are built by `.github/workflows/release.yml` on tag push. `desktop/README.md` lists the release assets. Electron's binary download may need `node node_modules/electron/install.js` after `npm install`.
- `scripts/`: `get-livekit.*`, `get-pebble.ps1` (pinned tools into `.tools`, checksums checked), `dev-firewall.ps1` (adds inbound *block* rules for dev/test binaries so Windows never asks; elevated shell).
- `dev.ps1`: starts the server on `.dev/<world>` plus the Vite dev server (new dev worlds are `LocalOnly`). On a new world the server prints a one-time owner invite link (also in `owner-invite.txt`): open it to become the owner.

## Commands

```powershell
cd server;   dotnet test          # server tests (real server + WebSocket clients)
cd client;   npm test             # client tests (vitest)
cd client;   npm run build        # type-check + build
cd client;   npm run test:interop # TS client against the real .NET server
cd client;   npm run test:e2e     # Playwright: browsers + the Electron app against real servers (screenshots in e2e/screenshots)
                                   # one spec on its own port: $env:ISKRA_E2E_PORT=5299; npx playwright test e2e/<spec>
cd desktop;  npm test            # desktop unit tests (platform helpers)
cd desktop;  npm start           # run the desktop app against the built client (set ISKRA_LOCAL_ONLY=1 before "Create a server")
cd bots;     npm run typecheck    # bot SDK
.\dev.ps1                          # run everything locally
```

CI (`.github/workflows/ci.yml`): server and client tests on Windows and Linux, desktop unit tests on Windows, Linux and macOS, interop and e2e on Linux, release-script tests. `release.yml` builds the Linux and macOS apps on a `v*` tag; `release-finalize.yml` publishes and deploys; `deploy.yml` redeploys; CodeQL and Dependabot run weekly.

**Releasing, deploying, credentials:** read [docs/ci-cd.md](docs/ci-cd.md) (reference: pipeline, secrets, expiry and renewal, troubleshooting) and follow [docs/ci-cd-playbook.md](docs/ci-cd-playbook.md) (step by step). `/release <version>` runs the playbook with the `release-runner` agent. Pin new actions to a full commit SHA with a version comment.

## Rules

- **The server trusts nothing the client says about itself.** Identity comes only from the signed handshake. Permissions are checked on the server for every request and every broadcast.
- Every new protocol message goes in `PROTOCOL.md` first, with size limits, and gets a server test. Bugs get a regression test.
- Database changes: never bump `user_version`/`SchemaVersion`. Append a named entry to `FeatureMigrations` in `Storage/Store.cs` (`("<feature>-<n>", "SQL")`); never edit one that has shipped.
- **Never trigger Windows Firewall prompts.** Any server, LiveKit or Electron started for development or tests listens on localhost only: `"LocalOnly": true` in server.json (test helpers already do this), `ISKRA_LOCAL_ONLY=1` for the desktop app's "Create a server". Don't copy executables to new paths. If prompts appear anyway, run `scripts/dev-firewall.ps1`.
- Worktrees: never use `git stash` (the stash is shared by every worktree of the repo).
- No hand-rolled crypto. Use libsodium primitives, put a context string on every signed payload, and never fall back to plaintext.
- Don't put user content into HTML strings in the client; let React render it. Never use `dangerouslySetInnerHTML` on user content.
- Never commit secrets, world folders, `design/`, or deploy scripts that contain keys.
- Live infrastructure: only the static sites (iskra.foo, app.iskra.foo on Cloudflare Pages). No hosted servers; testing is local.
- Releases: GitHub releases built from `desktop` (`npm run dist`) plus server zips. Keep `client/src/links.ts` (download links in the app) and the site's download section in step with the latest release.
- Default server port is 47070 (7070 clashes with AnyDesk). Test tools live in `.tools` (`scripts/get-livekit.*`, `scripts/get-pebble.ps1`).
