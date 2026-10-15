# Developing Iskra

## Layout

| Folder | What |
|---|---|
| `protocol/` | `PROTOCOL.md`, the wire protocol (source of truth for client and server), and `vectors.json`, shared crypto test vectors both sides check |
| `server/` | C# / .NET 10 server: sessions, roles and permissions, storage (SQLite), voice, stages, watch parties and calls (LiveKit), uploads, HTTPS, internet hosting and reachability, autostart, starter templates, the captions model, self-updates, push, webhooks, backups, Discord import, GIFs |
| `client/` | TypeScript + React + Vite web app (also what the desktop and phone apps run); installable as a PWA. On-device audio, video and captions in `src/state/audio`, `video`, `captions`; bundled models in `vendor/` ([voice-processing.md](voice-processing.md)) |
| `desktop/` | Electron shell for Windows, macOS and Linux: push-to-talk and hotkeys, screen picker, tray, auto-update, one-click hosting (setup wizard, Keep my server running) and restore, keychain, passkeys, `iskra://` links, game activity |
| `mobile/` | The phone apps: one Capacitor shell (iOS and Android) around the built client; see [mobile/README.md](../mobile/README.md) |
| `bots/` | Node SDK for bots (reuses the client's core) and the Dice example bot; see [bots.md](bots.md) |
| `scripts/` | Pinned tools (LiveKit, Pebble) into `.tools/` with checksum checks; `get-models.mjs` (the captions model, never committed); `build-deepfilter.sh`; the release scripts; `dev-firewall.ps1` (see below) |
| `site/` | The iskra.foo website |

Inside the server, each feature lives in `Features/<Feature>Feature.cs` (registered with one line in `Router.cs`) and keeps its store methods in `Storage/Store.<Feature>.cs`. Background work (event reminders, poll expiry, timeouts, retention, reminders and scheduled messages, the upload sweep, daily backups, updates) runs in hosted services next to the features. In the client, `src/core/` holds protocol, crypto and connection code shared with the bot SDK, `src/state/` holds app state, one file per feature (rules that need no React or store are in separate `*Logic.ts`/`*Rules.ts` files with unit tests), and `src/ui/` holds components grouped by area (`forums/`, `events/`, `stage/`, `watch/`, `groups/`, `roles/`, `moderation/`, `organize/`, ...).

## Prerequisites

.NET 10 SDK, Node 24 (bots run on Node 22 or newer), and (for voice) LiveKit: `scripts/get-livekit.ps1` on Windows or `scripts/get-livekit.sh` elsewhere.

## Run it

```powershell
.\dev.ps1          # server on .dev\world (port 47070) + web app on http://localhost:5173
```

On first start the server prints an owner link; open it to become the owner of your dev server.

### Localhost only, no firewall prompts

Anything you start for development or tests should listen on localhost only, so Windows never asks about the firewall:

- Servers: `"LocalOnly": true` in the world's `server.json` (the server and its LiveKit then bind to 127.0.0.1). The test helpers and new `dev.ps1` worlds already do this.
- The desktop app's **Create a server**: set `ISKRA_LOCAL_ONLY=1` first.
- Don't copy `iskra-server`, `livekit-server` or Electron to new paths: each new path asks again.
- If prompts show up anyway, `scripts/dev-firewall.ps1` (elevated) adds inbound *block* rules for every dev and test binary in the repo and its worktrees. Tests only use localhost, which the firewall doesn't filter. Safe to re-run.

## Tests

```powershell
cd server;  dotnet test              # server: real server + WebSocket clients (and real HTTPS issuance if .tools/pebble.exe exists)
cd client;  npm test                 # client unit tests (vitest)
cd client;  npm run build            # type-check + build
cd client;  npm run test:interop     # the TypeScript client and the bot SDK against the real .NET server
cd client;  npm run test:e2e         # Playwright: browsers and the Electron app against real servers, voice via LiveKit
cd desktop; npm test                 # desktop unit tests (per-platform helpers)
cd bots;    npm run typecheck        # bot SDK and examples
```

Run one e2e spec on its own port (useful with several checkouts): `$env:ISKRA_E2E_PORT=5299; npx playwright test e2e/calls.spec.ts`. Screenshots go to `client/e2e/screenshots`. Specs that talk to the internet (YouTube watch parties) only run with `ISKRA_E2E_NETWORK=1`, and `desktop-audio.spec` (it plays test tones through the real speakers and needs a quiet machine) only with `ISKRA_E2E_SPEAKERS=1`; the desktop specs need `npm run build` in `desktop/` and `client/` first. The Whisper unit test and the captions e2e test need the captions model: run `node scripts/get-models.mjs` from the repo root once (it goes into `client/.models/`, ignored by git); without it they're skipped. `node scripts/bench-audio.mjs` and `bench-captions.mjs` in `client/` measure CPU use.

The desktop specs keep the app out of your way: by default every window (splash included) opens far off-screen, still rendering, off the taskbar, and never takes focus. To watch, set `ISKRA_E2E_DISPLAY`: `terminal` (the monitor of the window in front when the run starts, usually your terminal; Windows only, elsewhere the primary monitor), a number (that monitor, 0-based in Windows' order), or `primary` (Electron's normal placement); `offscreen` is the default. `client/e2e/global-setup.ts` works it out once per run and hands it to the app as `ISKRA_E2E_WINDOW_AREA` (`desktop/src/testMode.ts`; a packaged app ignores it). Test runs also never take pictures of your screen: the screen picker gets blank thumbnails, unless a spec opts in to real capture with `ISKRA_E2E_SPEAKERS=1` (`desktop-audio.spec`).

CI (`.github/workflows/ci.yml`):

| Job | Windows | Linux | macOS |
|---|---|---|---|
| Server (`dotnet test`) | ✓ | ✓ | |
| Client (`npm test`, `npm run build`) | ✓ | ✓ | |
| Desktop unit tests | ✓ | ✓ | ✓ |
| Backup restore drill, release-script tests, Android build | | ✓ | |
| Interop and e2e | | ✓ | |

## Database changes

Never bump the schema version. Append a named step to `FeatureMigrations` in `server/src/Iskra.Server/Storage/Store.cs`, e.g. `("pins-1", "CREATE TABLE ...")`. Each name runs once per world, in order; never edit a step that has shipped: add `<feature>-2` instead.

Name columns that hold account keys `account_key`, `*_key`, `*_by` or `uploader` (TEXT): replacing an account key moves every such column automatically. Account keys anywhere else (JSON, other names) need a line in `Rekey` (`Storage/Store.Keys.cs`) and a row in `KeyTests.A_rotation_moves_the_account_in_every_feature`.

## Building releases

```powershell
cd desktop; npm install; npm run dist   # Windows installer + portable exe in desktop/release (bundles the server), signed
cd desktop; npm run dist:unsigned       # the same, unsigned
```

Linux (AppImage, deb, rpm) and macOS (dmg and zip, arm64 and x64) are built by `.github/workflows/release.yml` when a `v*` tag is pushed, together with the server bundles; `npm run dist:linux` and `npm run dist:mac` do the same on a Linux box or a Mac. The tag must match the version in `desktop/package.json`.

Each release carries these files (names exactly as built; the `latest*.yml` files point at them, and the apps update from them):

| From | Files |
|---|---|
| Windows (local `npm run dist`) | `Iskra-Setup-<v>.exe`, `Iskra-Setup-<v>.exe.blockmap`, `latest.yml`, `Iskra-Portable-<v>.exe`, `iskra-server-<v>-win-x64.zip` |
| Linux (CI) | `Iskra-<v>-x86_64.AppImage`, `Iskra-<v>-amd64.deb`, `Iskra-<v>-x86_64.rpm`, `latest-linux.yml`, `iskra-server-<v>-linux-x64.tar.gz` |
| macOS (CI) | `Iskra-<v>-mac-arm64.dmg`, `Iskra-<v>-mac-x64.dmg`, the matching `.zip` files and `.blockmap`s, `latest-mac.yml`, `iskra-server-<v>-osx-arm64.tar.gz`, `iskra-server-<v>-osx-x64.tar.gz` |

More in [desktop/README.md](../desktop/README.md), including first-run steps on macOS. A release (`scripts/release.ps1`) updates `client/src/links.ts` and the download links in `site/index.html`.

The web app is `client/dist` after `npm run build`; it's deployed to app.iskra.foo.

## Releasing

One command, from the repo root on the Windows PC with SimplySign Desktop logged in:

```powershell
.\scripts\release.ps1 -CheckOnly   # every check, nothing changes
.\scripts\release.ps1              # checks again, then the whole release (the next alpha; or give the version)
```

It writes the notes from `docs/releases/NEXT.md`, bumps, commits "Version X", tags and pushes vX (release.yml builds
Linux + macOS into a draft release), builds, signs and uploads the Windows apps and the Android app, then
`release-finalize.yml` checks all 23 files, adds `SHA256SUMS.txt` and build-provenance attestations, publishes
the release as Latest with the notes, deploys iskra.foo and app.iskra.foo, updates chat.iskra.foo and checks all three.
`scripts/release.ps1 -Redeploy site|webapp|server` redeploys any of those on its own. `npm test` at the root runs the release-script tests.

It relies on: secrets `CLOUDFLARE_API_TOKEN`, `DROPLET_SSH_KEY`, `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`,
`APPSTORE_API_KEY_BASE64`, `APPSTORE_KEY_ID`, `APPSTORE_ISSUER_ID`; variables `CLOUDFLARE_ACCOUNT_ID`, `DROPLET_HOST`,
`DROPLET_KNOWN_HOSTS`, `MAC_IDENTITY`; the `release` environment; and locally the Certum certificate (SimplySign),
the Android keystore and a logged-in `gh`.

The whole pipeline, every credential (where it lives, expiry, renewal) and troubleshooting: [ci-cd.md](ci-cd.md).
Step by step for agents: [ci-cd-playbook.md](ci-cd-playbook.md).

## Principles

- The server trusts nothing a client says about itself. Identity comes from the signed handshake; permissions are checked for every request and every broadcast.
- New protocol messages go into `protocol/PROTOCOL.md` first, with limits, and get a server test. Every bug gets a regression test.
- No hand-made crypto: libsodium primitives, domain-separated signatures, no plaintext fallbacks.
- User content is rendered by React only; never put it into HTML strings.

## Translations

The web client uses i18next. English (`client/src/i18n/en/`) is the source of truth; every other language must have exactly the same keys, which `tsc` and the catalog test check.

- New UI text: add a key to `client/src/i18n/en/<area>.ts` and the same key to every other language. In components use `useTranslation()`, outside React `t` from `i18n`. Dates and numbers go through `i18n/format.ts`, errors shown to people through `errorMessage(e)`.
- Adding a language:
  1. Copy `client/src/i18n/sv/` to `client/src/i18n/<code>/` and translate the values.
  2. Register it in `i18n/types.ts` (`LANGUAGES`, `LANGUAGE_NAMES`) and `i18n/index.ts` (`resources`, the `intlLocale` default region). Translate `<code>/errors.ts` for server errors.
  3. Languages with more plural forms than one/other need those keys (`_few`, `_many`, ...); the catalog test checks every form `Intl.PluralRules` needs.
  4. Desktop: add a dictionary to `DESKTOP_TEXT` in `desktop/src/i18n.ts`, and the code to `DesktopLanguage`, `parseLanguage` and `languageFromLocales`.
  5. Run `npm test` in `client` and `desktop`.

## Phone apps

`mobile/` is one Capacitor shell around the built client for iOS and Android ([mobile/README.md](../mobile/README.md)). `mobile/scripts/build-android.ps1` builds the signed APK into `mobile/release/Iskra-<version>.apk`; the release key lives outside the repo, every update must be signed with the same key, and its fingerprint is in `client/public/.well-known/assetlinks.json`. The iPhone app is built, signed and uploaded to TestFlight by `.github/workflows/mobile-ios.yml`. The phone apps have no push: they notify while open. (`android/` only holds a README; the old Trusted Web Activity is in git history.)

## Code layout

The detailed per-folder map (moved from CLAUDE.md).

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
- `scripts/`: `get-livekit.*`, `get-pebble.ps1` (pinned tools into `.tools`, checksums checked), `get-models.mjs` (the captions model into `client/.models/`; big models never go into git), `build-deepfilter.sh`, `release.ps1` (the one command that ships anything: release, `-GitHub` (presses the Release button), `-CheckOnly`, `-Resume`, `-Redeploy site|webapp|server|checksums`, `-Phones`, `-BotSdk`) and its steps, never run by hand (`release-checks.psm1`, `release-pc-checks.ps1`, `simplysign.psm1` + `simplysign-login.ps1` (SimplySign logs itself in with a DPAPI-stored TOTP seed), `release-preflight.mjs`, `release-notes.mjs`, `release-version.mjs`, `release-windows.ps1`, `ci-gate.mjs`, `release-lib.mjs`, `release-assets.*`, `play-upload.mjs`, `appstore.mjs`; table in docs/ci-cd.md), the owner's one-time `runner-setup.ps1` (the home PC as the release runner, with `runner-job-guard.ps1`) and `simplysign-setup.ps1`, `uptime-check.sh`, `dev-firewall.ps1` (adds inbound *block* rules for dev/test binaries so Windows never asks; elevated shell).
- `dev.ps1`: starts the server on `.dev/<world>` plus the Vite dev server (new dev worlds are `LocalOnly`). On a new world the server prints a one-time owner invite link (also in `owner-invite.txt`): open it to become the owner.

### CI workflows

CI (`.github/workflows/ci.yml`): server and client tests on Windows and Linux, desktop unit tests on Windows and Linux (macOS on PRs and nightly), interop and e2e (four shards balanced by `scripts/e2e-shards.mjs`, summed up by the `end-to-end` job) on Linux, a backup restore drill with the release-script tests, and an Android build; a newer push cancels a branch's older run (never a "Version X" commit's). `mobile-ios.yml` builds the iPhone app; `secrets.yml`, `scorecard.yml` and `uptime.yml` run too. `release-all.yml` ("Release") is the Release button: checks, version tag, CI (called), builds (release.yml called; Windows signed on the owner's home PC, a self-hosted runner with the label `iskra-windows-signing` that only its guarded jobs use), finalize (called), phones; `release.yml` builds the Linux and macOS apps (Mac x64 and arm64 in parallel) on a `v*` tag without waiting for CI; `release-finalize.yml` publishes and deploys, and refuses unless CI passed on the tagged commit; `deploy.yml` redeploys; `marketplace.yml` lints the Marketplace image (its build job is manual, behind an approval); CodeQL and Scorecard run on PRs and weekly, Dependabot weekly.

## Quiet test output (for agents and scripts)

Long test logs cost time and, for AI agents, tokens. These give the same result with a short summary:

- Server: `dotnet test --no-progress --no-ansi` (add `--filter "FullyQualifiedName~SomeTests"` for one class). The
  test runner is Microsoft.Testing.Platform (server/global.json): VSTest flags like `--logger "console;verbosity=minimal"`
  don't apply, and `-v q`/`-clp:ErrorsOnly` on `dotnet test` stop it from running tests. Build quietly with
  `dotnet build -v q -nologo -clp:ErrorsOnly`, then `dotnet test --no-build --no-progress --no-ansi`.
- Client unit tests: `npx vitest run` is already short outside a terminal.
- E2E: Playwright uses the `dot` reporter locally (CI keeps `list`); failures are listed in full at the end.
- Write long runs to a log file and read only the summary and failures.
