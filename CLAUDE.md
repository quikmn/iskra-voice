# Iskra

A self-hosted voice and text app for friend groups: like Discord, but free, easy, and yours.

## Repo

| Path | What it is |
|---|---|
| `protocol/`, `server/`, `client/`, `desktop/`, `mobile/`, `bots/`, `scripts/` | The app (see below) |
| `marketplace/digitalocean/` | The DigitalOcean Marketplace 1-Click image (Packer, first boot, claim code); `marketplace.yml` lints it, builds only by hand |
| `docs/` | Public docs: `hosting.md` (the app links to it), `security.md`, `voice-processing.md` (on-device audio, video and captions, third-party notices), `bots.md`, `development.md`, `ci-cd.md` + `ci-cd-playbook.md` (releases and deploys), `releases/` (release notes), `compliance/` (controls matrix, ASVS self-assessment, policies, owner actions) |
| `site/` | The iskra.foo website (Cloudflare Pages project `iskra-hero-page`). Keep it in sync with what the app actually does. |

An older, retired codebase lives on the `v1` branch (tag `v1-final`); don't add features to it. **In anything public the product is just "Iskra"**: never "Iskra 2", no "rebuilt", no mention of v1.

Private design notes live in `design/` (local only, ignored). If it exists, read `design/ISKRA_2_DESIGN.md` before making architectural changes; `protocol/PROTOCOL.md` is the public reference.

## Layout

Details for every folder: [docs/development.md#code-layout](docs/development.md#code-layout).

- `protocol/`: `PROTOCOL.md` (wire protocol, source of truth), `vectors.json` (crypto test vectors; regenerate with `node scripts/gen-vectors.mjs` from `client/`, only when the protocol changes).
- `server/`: C# / .NET 10 / ASP.NET Core. `Sessions/` (one reader and one writer per connection; never send on a socket from anywhere else; limits in `RateLimiter.cs`), `Features/<Feature>Feature.cs` (one per area, one line each in `Router.cs`), `Storage/` (SQLite, all writes behind one lock; store methods in `Store.<Feature>.cs`; a world is a folder), `Crypto/`, `Hosting/`, `Voice/` (LiveKit), `Push/`, `Files/`, `Captions/`, `Templates/`, `Updates/`, `Backups/`, `Import/`, `Gifs/`, `Cli.cs`.
- `client/`: TypeScript, React, Vite, zustand. `src/core/` (protocol, crypto, connection; shared with the bot SDK, so no DOM or React), `src/state/` (`store.ts` plus one file per feature using `onServerEvent`, `onWelcomeHook`, `connectionFor`; components never touch the socket), `src/ui/` (React renders all user text), `src/i18n/` (`en/` is the source, `sv/` same keys), `src/platform/`, `src/theme/`, `vendor/`, `public/`.
- `desktop/`: Electron shell (Windows, Linux, macOS); "Create a server" runs the bundled server + LiveKit; `npm run dist` builds and signs.
- `mobile/`: Capacitor 8 phone apps (iOS, Android) around the built client; no native push. `android/`: only a README.
- `bots/`: Node bot SDK and the Dice example (`docs/bots.md`).
- `scripts/`: pinned tools into `.tools`, `release.ps1` (the one release command) and its steps (never run by hand), `dev-firewall.ps1`.
- `dev.ps1`: server on `.dev/<world>` plus Vite (new dev worlds are `LocalOnly`); the server prints a one-time owner invite link (also `owner-invite.txt`).

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

CI (`.github/workflows/ci.yml`): server, client and desktop tests on Windows and Linux (desktop on macOS on PRs and nightly), interop and e2e (four shards, `end-to-end` job) on Linux, a backup restore drill, an Android build. A newer push cancels a branch's older run (never a "Version X" commit's). `release.yml` builds Linux and macOS apps on a `v*` tag without waiting for CI; `release-finalize.yml` refuses unless CI passed on the tagged commit. Other workflows and details: docs/development.md#ci-workflows.

**Releasing, deploying, credentials:** read [docs/ci-cd.md](docs/ci-cd.md) (reference: pipeline, secrets, expiry and renewal, troubleshooting) and follow [docs/ci-cd-playbook.md](docs/ci-cd-playbook.md) (step by step). **Shipping is one button or one command:** the Release button (Actions → Release → Run workflow, or `pwsh scripts/release.ps1 -GitHub [<version>]`; needs the home PC on), or `pwsh scripts/release.ps1 [<version>]` locally (default: the next alpha). It runs every check first (SimplySign's test signature first; all reds listed at once, nothing changed), then prints `ALL CHECKS GREEN - SENDING` and ships with no prompts or approvals; `-CheckOnly` only checks, `-Resume` continues after a stop, `-Redeploy`/`-Phones`/`-BotSdk` for the rest. Notes from `docs/releases/NEXT.md`. SimplySign logs itself in when the owner has stored the seed; otherwise the owner logs in to SimplySign Desktop first. The `release-runner` agent (`/release`) runs it and handles STOP lines. Pin new actions to a full commit SHA with a version comment.

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
