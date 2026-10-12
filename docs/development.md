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

Run one e2e spec on its own port (useful with several checkouts): `$env:ISKRA_E2E_PORT=5299; npx playwright test e2e/calls.spec.ts`. Screenshots go to `client/e2e/screenshots`. Specs that talk to the internet (YouTube watch parties) only run with `ISKRA_E2E_NETWORK=1`; the desktop specs need `npm run build` in `desktop/` and `client/` first. The Whisper unit test and the captions e2e test need the captions model: run `node scripts/get-models.mjs` from the repo root once (it goes into `client/.models/`, ignored by git); without it they're skipped. `node scripts/bench-audio.mjs` and `bench-captions.mjs` in `client/` measure CPU use.

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

More in [desktop/README.md](../desktop/README.md), including first-run steps on macOS. `npm run release` updates `client/src/links.ts` and the download links in `site/index.html`.

The web app is `client/dist` after `npm run build`; it's deployed to app.iskra.foo.

## Releasing

Three commands, from the repo root:

```powershell
npm run release -- 2.0.0-alpha.10           # needs docs/releases/2.0.0-alpha.10.md; bumps, commits "Version X", tags vX
git push --atomic origin main v2.0.0-alpha.10  # release.yml builds Linux + macOS into a draft release
.\scripts\release-windows.ps1 2.0.0-alpha.10  # on Windows, SimplySign logged in: signed Windows build + APK, upload, then finalize
```

`release-finalize.yml` then checks all 22 files, adds `SHA256SUMS.txt` and build-provenance attestations, publishes
the release as Latest with the notes, deploys iskra.foo and app.iskra.foo, updates chat.iskra.foo and checks all three.
`deploy.yml` redeploys any of those on its own. `npm test` at the root runs the release-script tests.

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
