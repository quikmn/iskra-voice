# Iskra

A self-hosted voice and text app for friend groups: like Discord, but free, easy, and yours.

## Repo

| Path | What it is |
|---|---|
| `protocol/`, `server/`, `client/`, `desktop/`, `mobile/`, `bots/`, `scripts/` | The app (see below) |
| `docs/` | Public docs: `hosting.md` (the app links to it), `security.md`, `voice-processing.md` (on-device audio, video and captions, third-party notices), `bots.md`, `development.md`, `ci-cd.md` + `ci-cd-playbook.md` (releases and deploys), `releases/` (release notes), `compliance/` (controls matrix, ASVS self-assessment, policies, owner actions) |
| `site/` | The iskra.foo website (Cloudflare Pages project `iskra-hero-page`). Keep it in sync with what the app actually does. |

An older, retired codebase lives on the `v1` branch (tag `v1-final`); don't add features to it. **In anything public the product is just "Iskra"**: never "Iskra 2", no "rebuilt", no mention of v1.

Private design notes live in `design/` (local only, ignored). If it exists, read `design/ISKRA_2_DESIGN.md` before making architectural changes; `protocol/PROTOCOL.md` is the public reference.

## Layout

- `protocol/`: `PROTOCOL.md` (the wire protocol, the source of truth) and `vectors.json` (shared crypto test vectors; regenerate with `node scripts/gen-vectors.mjs` from `client/`, only when the protocol changes).
- `server/`: C# / .NET 10 / ASP.NET Core.
  - `Sessions/`: one connection per session. One reader and one writer, with outbound messages going through a channel. Never send on a socket from anywhere else. Per-type rate limits in `RateLimiter.cs`.
  - `Features/`: one `<Feature>Feature.cs` per area (chat, pins, threads, search, polls, emoji, stickers, GIFs, soundboard, voice messages, voice channel chat and clips, forwarding, forums, events, docs channels, stages, watch parties, calls, group DMs and group calls, DM files, E2EE channels, hi-fi channels, devices, link relay, keys (account key rotation), key log (key transparency), webhooks, bots, push, profiles, presence, activity, prefs, organize (categories, nicknames, notification levels), productivity (saved, reminders, scheduled messages, inbox, edit history), roles, moderation, AutoMod, rules, voice limits, reports, account deletion, compliance (security log, `DataExports`), backups, server moves, Discord import, internet hosting, updates, health), each registered with one line in `Router.cs`. Background work: `EventScheduler`, `PollCloser`, `ModerationSweeper`, `RetentionSweeper`, `ProductivityScheduler`. `OwnerSetup.cs`: the first owner invite, and the owner claim of a rented server.
  - `Storage/`: a world is a folder (`server.json`, `server.key`, `iskra.db`, `uploads/`, `livekit.key`, `vapid.json`, `certs/`, `backups/`, `models/` (captions model), `owner-claim` while a rented server waits for its owner). SQLite, with all writes behind one lock; files are written atomically. Store methods live in partial files `Store.<Feature>.cs`.
  - `Crypto/`: Ed25519 via NSec (libsodium).
  - `Hosting/`: automatic HTTPS (`Certificates`, Let's Encrypt via Certes 3.0.4), internet hosting (`InternetHost`, UPnP/NAT-PMP in `Upnp`/`NatPmp`, router choice and NAT kind (public, CGNAT, double NAT) in `PortMapping`, a fake router for tests in `TestRouter`, Tailscale detected from local interfaces in `Tailscale`, HTTP+HTTPS on one port in `DualProtocol`), response headers (`SecurityHeaders`), `install-autostart` (`Autostart`: Windows scheduled task, systemd user service, launchd agent), child-process lifetime (`ChildProcesses`).
  - `Push/`: Web Push for browsers (VAPID keys, sender, who gets notified). The phone apps have no push; they notify while open.
  - `Voice/`: `LiveKitHost` (in `VoiceBackend.cs`) starts and supervises livekit-server (pinned v1.13.7; get it with `scripts/get-livekit.ps1`/`.sh` into `.tools`). `VoiceRegistry` tracks who's in voice from LiveKit's signed webhooks only (and server mutes); `CallRegistry` handles DM calls, `GroupCallRegistry` group calls, `StageRegistry` who may speak on stages (through LiveKit's RoomService), `WatchRegistry` watch-party clocks.
  - `Files/`: uploads (typed by content, retention, imports) and `UploadSweeper`.
  - `Captions/`: the live-captions model (Whisper base), fetched once from Hugging Face at a pinned commit, checked against `client/src/state/captions/model.json` and served to members' apps at `/models/...` (`Captions.ModelDownload`).
  - `Templates/`: starter templates (`gaming`, `friends`, `tabletop`, `empty`, or a JSON file), applied once to a new server.
  - `Updates/`: server auto-update from GitHub releases (feed, SHA-256 checks, install, rollback via `iskra-update-guard`).
  - `Backups/` (encrypted backup files, daily backups, restore), `Import/` (DiscordChatExporter imports), `Gifs/` (KLIPY, direct or proxied). `Cli.cs`: `restore`, `backup`, `move`, `import-discord`, `templates`, `install-autostart`, `remove-autostart`, `version`.
- `client/`: TypeScript, React, Vite, zustand.
  - `src/core/`: protocol types, crypto (libsodium-wrappers-sumo), identity, DM envelopes, group chains (`group.ts`), encrypted channel chains (`channelChain.ts`), key log checks (`keylog.ts`), sealed records (`sealed.ts`), encrypted DM files, account key rotation, synced prefs, devices/prekeys, device linking, invite links, `Connection` (handshake, requests, reconnect with backoff), IndexedDB storage (secrets encrypted at rest). Also used by the bot SDK, so no DOM or React here.
  - `src/state/`: `store.ts` holds app state and core server actions; features keep their state in their own files (`calls.ts`, `pins.ts`, `push.ts`, ...) using the hooks in store.ts (`onServerEvent`, `onWelcomeHook`, `connectionFor`). Components never talk to the socket directly. On the device: `audio/` (DeepFilterNet3, RNNoise, Silero VAD, leveling), `video/` (camera background blur and replace, in a worker), `captions/` (Whisper in a worker), `clips/`, `models.ts` (model files and their hashes). Hosting: `hosting.ts` (Open to the internet, reachability), `rentServer.ts` (VPS setup text and owner claim).
  - `src/theme/`: built-in themes and the theme-JSON validator.
  - `src/ui/`: React components, grouped by area. User text is rendered by React only. Hosting UI: `dialogs/CreateServerDialog.tsx` (setup wizard), `dialogs/ReachabilityHelp.tsx` (port forwarding, AI prompt, CGNAT), `dialogs/RentServerDialog.tsx`.
  - `src/i18n/`: English (`en/`, the source of truth) and Swedish (`sv/`), same keys.
  - `src/platform/`: the desktop bridge, the phone apps (`native.ts`), passkeys, updates.
  - `vendor/`: DeepFilterNet3 (WebAssembly, rebuilt bit for bit by `scripts/build-deepfilter.sh`), Silero VAD and the MediaPipe selfie segmenter, bundled. `scripts/`: benchmarks (`bench-audio.mjs`, `bench-captions.mjs`), icons, test vectors.
  - `public/`: PWA manifest, `push-sw.js` (push only, no caching), `service-worker.js` (only removes an old caching worker) and `page-preview.html` (profile page editor sandbox).
- `bots/`: Node bot SDK (`sdk/src`, reuses `client/src/core`) and the Dice example; `npm run dice`, `npm run typecheck`. See `docs/bots.md`.
- `desktop/`: Electron 44 shell (`src/main.ts`, `preload.ts`, `ptt.ts` + `hotkeys.ts`, `host.ts` (hosted servers, templates, Keep my server running), `updates.ts`, `passkeys.ts` (WebAuthn in a small app.iskra.foo window), `i18n.ts`; per-OS decisions in `platform.ts`, unit-tested with `npm test`). Windows, Linux and macOS. "Create a server" runs the bundled iskra-server + LiveKit on world folders in Documents/Iskra/Servers (Application Support/Iskra/Servers on macOS; `ISKRA_HOST_ROOT` overrides, tests use it); servers stop cleanly with the app (closing their stdin, `ISKRA_STOP_ON_STDIN_CLOSE`; force-killed after 5 s; parent-PID watch as backup; LiveKit is bound to a Windows job object). Serves the built client on `app://iskra/`, sandboxed renderer, IPC only from the app page, global push-to-talk via uiohook-napi (macOS: Accessibility permission), screen/window picker (Windows loopback audio without the app's own), tray, OS keychain for the keys (`safeStorage`), `iskra://join/` invite links, desktop settings (`settings.ts`), profile pages in a walled `<webview>` session where nothing reaches the network (`pages.ts`, rules in `pageRules.ts`), opt-in game activity (`activity.ts`, `games.ts`), backup restore (`restore.ts`), electron-updater from GitHub releases. `npm run dist` publishes a self-contained server into `build/server-win-x64`, then builds `release/Iskra-Setup-x.y.z.exe` + portable exe + `latest.yml`, signed with the Certum certificate in the CurrentUser store via `win.signtoolOptions` (and `desktop/scripts/sign.ps1` for the standalone server); `npm run dist:unsigned` never touches the token. Linux (AppImage/deb/rpm) and macOS (dmg/zip, Developer ID signed and notarized; ad-hoc signed without the Apple secrets) are built by `.github/workflows/release.yml` on tag push. `desktop/README.md` lists the release assets. Electron's binary download may need `node node_modules/electron/install.js` after `npm install`.
- `mobile/`: the phone apps, one Capacitor 8 shell around the built client (bundled; `capacitor://localhost` on iOS, `http://localhost` on Android). `mobile/ios/` is the Xcode project (bundle id `foo.iskra.app`), built, cloud-signed and uploaded to TestFlight by `.github/workflows/mobile-ios.yml` (no Mac needed). `mobile/android/` (package `foo.iskra.app`, same key as the old TWA) is built and signed on the Windows PC by `mobile/scripts/build-android.ps1`. Native code: the `IskraNative` plugin (voice in the background: the audio session and CallKit for the call you're in on iOS, a voice foreground service on Android). No native push: notifications arrive while the app is open. The client's side is `client/src/platform/native.ts`, `state/nativeShell.ts`, `state/nativeVoice.ts`. See `mobile/README.md`.
- `android/`: only a README pointing to `mobile/` (the old Trusted Web Activity is in git history).
- `scripts/`: `get-livekit.*`, `get-pebble.ps1` (pinned tools into `.tools`, checksums checked), `get-models.mjs` (the captions model into `client/.models/`; big models never go into git), `build-deepfilter.sh`, the release scripts (`release-all.ps1` (the whole release), `release-notes.mjs`, `release.mjs`, `release-windows.ps1`, `ci-gate.mjs`, `release-lib.mjs`, `release-assets.json`), `uptime-check.sh`, `dev-firewall.ps1` (adds inbound *block* rules for dev/test binaries so Windows never asks; elevated shell).
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

CI (`.github/workflows/ci.yml`): server and client tests on Windows and Linux, desktop unit tests on Windows and Linux (macOS on PRs and nightly), interop and e2e (four shards balanced by `scripts/e2e-shards.mjs`, summed up by the `end-to-end` job) on Linux, a backup restore drill with the release-script tests, and an Android build; a newer push cancels a branch's older run (never a "Version X" commit's). `mobile-ios.yml` builds the iPhone app; `secrets.yml`, `scorecard.yml` and `uptime.yml` run too. `release.yml` builds the Linux and macOS apps (Mac x64 and arm64 in parallel) on a `v*` tag without waiting for CI; `release-finalize.yml` publishes and deploys, and refuses unless CI passed on the tagged commit; `deploy.yml` redeploys; CodeQL and Scorecard run on PRs and weekly, Dependabot weekly.

**Releasing, deploying, credentials:** read [docs/ci-cd.md](docs/ci-cd.md) (reference: pipeline, secrets, expiry and renewal, troubleshooting) and follow [docs/ci-cd-playbook.md](docs/ci-cd-playbook.md) (step by step). **A release is one command:** `pwsh scripts/release-all.ps1 <version>` (`-DryRun` first; `-Resume` after a stop), notes from `docs/releases/NEXT.md`. The `release-runner` agent (`/release`) is for when it stops, deploys and finalize only. Pin new actions to a full commit SHA with a version comment.

## Rules

- **The server trusts nothing the client says about itself.** Identity comes only from the signed handshake. Permissions are checked on the server for every request and every broadcast.
- Every new protocol message goes in `PROTOCOL.md` first, with size limits, and gets a server test. Bugs get a regression test.
- Database changes: never bump `user_version`/`SchemaVersion`. Append a named entry to `FeatureMigrations` in `Storage/Store.cs` (`("<feature>-<n>", "SQL")`); never edit one that has shipped.
- **Never trigger Windows Firewall prompts.** Any server, LiveKit or Electron started for development or tests listens on localhost only: `"LocalOnly": true` in server.json (test helpers already do this), `ISKRA_LOCAL_ONLY=1` for the desktop app's "Create a server". Don't copy executables to new paths. If prompts appear anyway, run `scripts/dev-firewall.ps1`.
- Worktrees: never use `git stash` (the stash is shared by every worktree of the repo).
- No hand-rolled crypto. Use libsodium primitives, put a context string on every signed payload, and never fall back to plaintext.
- Don't put user content into HTML strings in the client; let React render it. Never use `dangerouslySetInnerHTML` on user content.
- Never commit secrets, world folders, `design/`, or deploy scripts that contain keys.
- Live infrastructure: only the static sites (iskra.foo, app.iskra.foo on Cloudflare Pages). We host nothing for other people's servers (no push relay); testing is local.
- Compliance: [docs/compliance](docs/compliance/README.md) maps controls to code. Security events go in the security log (`SecurityLog.Record`, never message text, codes or secrets; IPs only via `LoggedIp`); new personal data gets a section in `DataExports` and a line in `docs/compliance/policies/data-retention.md`; keep `SECURITY.md`, `security.txt` (Expires, yearly) and the controls matrix in step.
- Releases: GitHub releases built from `desktop` (`npm run dist`) plus server zips. Keep `client/src/links.ts` (download links in the app) and the site's download section in step with the latest release.
- Default server port is 47070 (7070 clashes with AnyDesk). Test tools live in `.tools` (`scripts/get-livekit.*`, `scripts/get-pebble.ps1`).
