# CI/CD reference

How Iskra is built, released and deployed, every credential the pipeline depends on, when each one expires and
how to renew it, and what to do when something breaks. This is the reference: it explains the why.
For step-by-step instructions (what an agent runs for a routine release or redeploy) use
[ci-cd-playbook.md](ci-cd-playbook.md). Keep both in sync with the scripts and workflows they describe.

Never put a secret value in this file, a commit, an issue or a log. Names and locations only.

## Contents

1. [Overview](#1-overview)
2. [Releasing](#2-releasing)
3. [Deploying without a release](#3-deploying-without-a-release)
4. [Secrets and credentials](#4-secrets-and-credentials)
5. [Refresh calendar](#5-refresh-calendar)
6. [Troubleshooting](#6-troubleshooting)
7. [Rules for agents](#7-rules-for-agents)

## 1. Overview

```
 every push / PR ──► ci.yml ............ server, client, desktop tests (Win/Linux/macOS), interop + e2e, release-script tests
 push to main / PR / weekly ──► codeql.yml ... code scanning: JS/TS, C#, workflows
 weekly ──► Dependabot ............ grouped PRs for npm (client, desktop, bots), NuGet (server), GitHub Actions

 RELEASE
 ① npm run release -- X        (any OS)   bump version in desktop/package.json(+lock), client/src/links.ts,
                                          site/index.html; commit "Version X" with docs/releases/X.md; tag vX
 ② git push --atomic origin main vX
        └─► release.yml (on the tag) ...... Linux AppImage/deb/rpm, macOS dmg/zip (signed + notarized),
                                            server tarballs; attestations; creates the DRAFT release vX
 ③ scripts/release-windows.ps1 X  (this Windows PC, SimplySign logged in)
        ├─ npm run dist ................... signed Setup + Portable exe, latest.yml, signed iskra-server.exe
        ├─ server zip, build-android.ps1 .. iskra-server-X-win-x64.zip, Iskra-X.apk (mobile/, signed locally)
        ├─ gh release upload ............... onto the draft
        ├─ waits until all 22 files are on the release
        └─► release-finalize.yml (workflow_dispatch, environment "release")
              ├─ publish: check files + latest*.yml hashes, SHA256SUMS.txt, attestations,
              │           publish as Latest (not prerelease) with docs/releases/X.md
              └─► deploy.yml (reusable, environment "release")
                    ├─ site ....... wrangler → Pages iskra-hero-page → https://iskra.foo  (checks the new links and every page)
                    ├─ webapp ..... client build → Pages iskra-webclient → https://app.iskra.foo (checks the new index asset)
                    └─ server ..... ssh root@DROPLET_HOST X → iskra-update X → https://chat.iskra.foo (checks it answers)

 DEPLOY ONLY: deploy.yml by hand (workflow_dispatch: ref, site, webapp, server_version, relay)
 iOS APP: mobile-ios.yml by hand (workflow_dispatch: ref, upload) ──► TestFlight (not part of a release yet)
 PUSH RELAY: deploy.yml relay=true ──► Worker iskra-push → https://push.iskra.foo (APNs/FCM for the phone apps)
```

| File | What it does |
|---|---|
| `package.json` (repo root) | `npm run release`, `npm test` (release-script tests) |
| `scripts/release.mjs` | Step ①. `--dry-run` shows the changes, `--push` pushes too |
| `scripts/release-lib.mjs`, `release-lib.test.mjs` | Version checks, version replacement, asset list, latest.yml parsing (unit-tested, run in CI) |
| `scripts/release-assets.json` | The files every release must have. One list for the PowerShell script and the workflows |
| `scripts/release-assets.mjs` | `list`, `names`, `check` (files + latest*.yml sha512), `sums` (SHA256SUMS.txt) |
| `scripts/release-windows.ps1` | Step ③ |
| `.github/workflows/release.yml` | Linux and macOS builds on a `v*` tag |
| `.github/workflows/release-finalize.yml` | Publish + deploy |
| `.github/workflows/deploy.yml` | Site, web app and server deploys with checks; called by finalize or run by hand |
| `.github/workflows/ci.yml`, `codeql.yml`, `.github/dependabot.yml` | Tests, code scanning, dependency updates |
| `docs/releases/<version>.md` | Release notes (become the GitHub release text) |
| `desktop/scripts/sign.ps1` | Signs the standalone Windows server exe with the Certum certificate |
| `mobile/scripts/build-android.ps1` | Signed Android APK (+ AAB) from the Capacitor shell ([Android](#android)) |
| `relay/` | The push relay (Cloudflare Worker); deployed by deploy.yml `relay` ([Push relay](#push-relay)) |
| `.github/workflows/mobile-ios.yml` | iPhone/iPad app: build, cloud-sign, upload to TestFlight ([iOS app](#ios-app)) |
| `scripts/mobile-version.mjs` | The phone app's version and build numbers (tested by the root `npm test`) |

Supply chain: every action is pinned to a full commit SHA with the version as a comment (Dependabot keeps them
current); every workflow starts with minimal `permissions:` and widens them per job; wrangler is pinned
(`WRANGLER` in deploy.yml). Releases carry build-provenance attestations: `gh attestation verify <file> -R quikmn/iskra-voice`.
For Linux/macOS files they come from the build workflow; for Windows and Android files (built locally) they only
prove the file is the one the finalize run published, not how it was built.

## 2. Releasing

Versions are `x.y.z` or `x.y.z-alpha.n`; tags are `v` + version. Alphas are published as normal releases marked
Latest (a prerelease never becomes GitHub's Latest, and people are told to "get the latest release"). The desktop
apps update themselves from the release (`latest*.yml`), with `allowPrerelease` on during the alpha.

1. **Notes.** Write `docs/releases/<version>.md` ([format](releases/README.md)). It may stay uncommitted.
2. **Bump and tag.** On an up-to-date, clean `main`: `npm run release -- <version>`. It refuses if the branch isn't
   main, the tree has other changes, main is behind origin, the tag exists, the version isn't newer, the notes are
   missing, or links.ts/site don't mention the current version. Result: one commit "Version X" and an annotated tag vX.
3. **Push.** `git push --atomic origin main vX` (printed by the script). CI runs on main; `release.yml` starts on the tag
   (~20–30 min, macOS notarization is the slow part) and creates the draft release.
4. **Windows + Android.** On the Windows PC, log in to SimplySign Desktop, `git checkout vX`, then
   `.\scripts\release-windows.ps1 X` (PowerShell 7). It test-signs a scratch file first, builds, checks every
   signature (valid, right publisher, timestamped), builds the server zip and APK, prints SHA256s, uploads, checks
   sizes on GitHub, waits for the Linux/macOS files (up to `-WaitMinutes`, default 60) and starts finalize.
   `-SkipBuild` re-uploads existing files; `-NoFinalize` stops after uploading.
5. **Finalize.** `release-finalize.yml` (approve it if the environment has reviewers). Done when all its jobs are
   green; its checks are the verification: iskra.foo links to vX, app.iskra.foo serves the new bundle,
   chat.iskra.foo answers, GitHub's Latest is vX, the downloads resolve.
6. Afterwards: `git checkout main`.

The user's own server updates through finalize. Other people's servers don't update themselves: they download the
new `iskra-server` package (docs/hosting.md).

## 3. Deploying without a release

`deploy.yml` → Run workflow (or `gh workflow run deploy.yml -f ref=main -f site=true`):

| Input | Effect |
|---|---|
| `ref` | Tag or branch the site and web app are built from (`main` for a site text fix, the release tag to redeploy a release) |
| `site` | iskra.foo from `site/`: every `*.html` page (index, terms, privacy, support, delete-account), `*.css` (site.css, fonts.css), the `fonts/` folder (self-hosted Inter and JetBrains Mono), worker.js and .assetsignore; never wrangler.toml or .wrangler/. Pages serves `terms.html` at `/terms` (and redirects `/terms.html` there). Fails if index.html doesn't link to the version in desktop/package.json at that ref, or if a page isn't served at `https://iskra.foo/<page>` afterwards (checked by its `<link rel="canonical">`, so every new page needs one) |
| `webapp` | Builds `client/` and deploys `client/dist` to app.iskra.foo (branch main = production) |
| `server_version` | Runs `iskra-update <version>` on the droplet. The version must be a published release (it downloads from GitHub and checks SHA256SUMS.txt) |
| `relay` | Tests and deploys `relay/` (Worker `iskra-push`, custom domain push.iskra.foo), sets its secrets from the `release` environment, checks `/v1/health` |

Local fallback (no CI): `site/` with the `iskra-deploy-cf` token through `D:\Development_Projects\IskraHeroPage\deploy-hero.ps1`
(it decrypts the token itself; never print it). It deploys its own folder `IskraHeroPage\iskra-site`, not `site/`: copy
`site/*.html`, `site/*.css`, `site/fonts/`, `site/worker.js` and `site/.assetsignore` into it first, because a Pages deploy replaces the whole
site and would drop any page that's missing. The web app deploys with `npx wrangler@4.136.3 pages deploy dist --project-name=iskra-webclient --branch=main`
from `client/` after `npm run build`, and the server with `ssh -i ~/.ssh/iskrapersonalvoip root@146.190.236.187 iskra-update <version>`.

## 4. Secrets and credentials

Where GitHub settings live: repo → Settings → Secrets and variables → Actions (secrets, variables) and
Settings → Environments → `release`. `gh secret list`, `gh variable list` show names (never values).
Set a secret from a file without echoing it: `gh secret set NAME < file`.

### Windows code signing (Certum, SimplySign)

| | |
|---|---|
| What | Code-signing certificate "Open Source Developer Viktor Lundgren" (Certum Open Source Code Signing), key in Certum's cloud HSM, used through **SimplySign Desktop** on the Windows PC |
| Valid | 2026-05-12 → **2027-05-12** |
| Used by | `npm run dist` (electron-builder `win.signtoolOptions`, certificate looked up by subject in CurrentUser\My), `desktop/scripts/sign.ps1` (server exe), `scripts/release-windows.ps1` (checks) |
| Login | SimplySign Desktop → log in with the 6-digit code from the SimplySign phone app before every Windows build; the session times out after a while |
| Lost/expired | No signed Windows builds. Already-signed releases stay valid (they're timestamped) |

**Renewal** (start a month early): order the renewal in the Certum shop with the same identity, verify as Certum
asks, activate it in SimplySign. Check the new certificate's subject. The apps refuse an update whose signer
doesn't match `publisherName` in `desktop/package.json` (electron-updater checks it), so:
- same CN "Open Source Developer Viktor Lundgren": nothing else to change;
- different CN: first ship a release whose `win.signtoolOptions.publisherName` lists **both** names (it accepts a
  list), signed with the old certificate, then switch. Otherwise installed apps stop auto-updating and people must
  reinstall by hand. Update `certificateSubjectName`, `sign.ps1` and the `$subject` in release-windows.ps1 too.

Windows SmartScreen reputation builds per certificate, so expect warnings again for a while after a change.

### Apple (macOS signing and notarization)

| Item | Where | Expiry / renewal |
|---|---|---|
| Developer ID Application "Viktor Lundgren (BWX2M8XSNZ)" | Key and certificate: `D:\Development_Projects\devkeys\apple-developer-id.{key,csr,pem,p12}`, password in `apple-developer-id-p12-password.txt`, intermediate `apple-DeveloperIDG2CA.*`. In GitHub: secrets `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, variable `MAC_IDENTITY` | Valid until **2031-09-17** |
| App Store Connect API key (.p8) for notarization and the iOS app | Secrets `APPSTORE_API_KEY_BASE64`, `APPSTORE_KEY_ID`, `APPSTORE_ISSUER_ID` | No expiry; revoke in App Store Connect → Users and Access → Integrations. The iOS app's cloud signing needs the key's role to be **Admin** |
| Apple Developer Program membership | developer.apple.com (owner's Apple ID) | Yearly (99 USD). If it lapses, notarization stops and new certificates can't be made |

`release.yml` falls back to ad-hoc signing (no notarization) when the Apple secrets are missing, so a broken Apple
setup gives unsigned Mac builds instead of failing; check the "Desktop app (signed and notarized)" step ran.

**Renew the Developer ID** (before 2031-09-17, or when the key is compromised):
1. New key and CSR: `openssl genrsa -out apple-developer-id.key 2048` and
   `openssl req -new -key apple-developer-id.key -out apple-developer-id.csr -subj "/emailAddress=<apple id>/CN=Viktor Lundgren/C=SE"`.
2. developer.apple.com → Certificates → + → Developer ID Application (G2 Sub-CA) → upload the CSR → download `.cer`.
3. `openssl x509 -inform DER -in developerID_application.cer -out apple-developer-id.pem`, then
   `openssl pkcs12 -export -inkey apple-developer-id.key -in apple-developer-id.pem -certfile apple-DeveloperIDG2CA.pem -out apple-developer-id.p12` with a new random password (save it to the password file).
4. `base64 -w0 apple-developer-id.p12 | gh secret set MAC_CERT_P12_BASE64`, `gh secret set MAC_CERT_PASSWORD < apple-developer-id-p12-password.txt`;
   update `MAC_IDENTITY` if the name changed. Keep the old files until a release has been signed with the new ones.

**Rotate the API key:** App Store Connect → Integrations → new key (**Admin** role: the iOS app's cloud signing needs it;
notarization works with any role), download the .p8 once, set the three secrets, run `mobile-ios.yml` with `upload=false`
and a release (or `release.yml` with workflow_dispatch) to test, then revoke the old key.

### iOS app

The iPhone/iPad app (`mobile/`, Capacitor around the built client; details in [mobile/README.md](../mobile/README.md))
is built on GitHub's macOS runners by `.github/workflows/mobile-ios.yml` and uploaded to TestFlight. No Mac is involved.

| Item | Where | Notes |
|---|---|---|
| App ID `foo.iskra.app` | developer.apple.com → Identifiers (team BWX2M8XSNZ) | Capabilities: Associated Domains, Push Notifications |
| App ID `foo.iskra.app.NotificationService` | Same place | The Notification Service Extension (decrypts pushes). Xcode registers it during cloud signing; mobile/README.md step 7 if not |
| App record "Iskra" | App Store Connect → Apps | Created by the owner once (the API can't); TestFlight internal group with automatic distribution |
| Signing | Xcode cloud signing with the `APPSTORE_*` key | No certificates, profiles or keychains in CI. Apple keeps a cloud-managed "Apple Distribution" certificate; it shows under Certificates and renews itself |
| Universal Links | `client/public/.well-known/apple-app-site-association` on app.iskra.foo, entitlement `applinks:app.iskra.foo` | Deploy the web app before testers install |
| Export compliance | `ITSAppUsesNonExemptEncryption = false` in Info.plist | Standard algorithms, mass-market exemption; reasoning and open questions (France) in mobile/README.md |

**Build numbers.** `CFBundleShortVersionString` is the numeric part of `desktop/package.json`'s version (2.0.0-alpha.10 →
2.0.0); `CFBundleVersion` is `<version code>.<run number>.<run attempt>` with Android's version code (20000110), so it rises
with every release and every rebuild. App Store Connect rejects a build number it has already seen for that version; just
rerun. Once a `2.0.0` build is approved for the App Store, that version is closed: the next builds must be a higher
version (the next release bump does that).

**Running it.** `gh workflow run mobile-ios.yml [-f ref=vX] [-f upload=false]` (default: main, upload). The run summary
names the version and build; Apple then processes the build (5–30 min) and TestFlight shows it to the internal group.
Wiring it into releases later: add a job to `release-finalize.yml` after `publish`:
`ios: { needs: publish, uses: ./.github/workflows/mobile-ios.yml, with: { ref: <tag> }, secrets: inherit }`
(the caller's `permissions` must include `contents: read`).

### Cloudflare

| Item | Where | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` (GitHub secret) | Token "iskra-github-ci" in Cloudflare → My Profile → API Tokens | Account permissions Cloudflare Pages: Edit + Workers Scripts: Edit, one account, no TTL |
| `CLOUDFLARE_ACCOUNT_ID` (GitHub variable) | Cloudflare dashboard sidebar | Not secret |
| Local token "iskra-deploy-cf" | Encrypted on the Windows PC, used by `D:\Development_Projects\IskraHeroPage\deploy-hero.ps1` | Fallback deploys. Never print it |
| Pages projects | `iskra-hero-page` → iskra.foo, `iskra-webclient` → app.iskra.foo (production branch main) | |
| DNS (zone iskra.foo) | `chat` A 146.190.236.187, DNS only (grey cloud: the server does its own HTTPS); Email Routing `spark@iskra.foo` → the owner's mailbox; `send.iskra.foo` records belong to Resend (email sending) | Don't proxy `chat` |

**Rotate the CI token:** create a new token with the same permissions → `gh secret set CLOUDFLARE_API_TOKEN`
(paste at the prompt) → run deploy.yml with `site` → delete the old token. If the token leaks, roll it first
(Cloudflare → token → Roll), then update the secret. Lost: deploys fail; nothing that's live breaks.

### The server (chat.iskra.foo)

DigitalOcean droplet "Iskra-Voip-personal-ams3" (AMS3, Ubuntu 24.04, 146.190.236.187), the owner's friend server "Hangout".

| Item | Where | Notes |
|---|---|---|
| Admin SSH key | `~/.ssh/iskrapersonalvoip` on the Windows PC (root) | Full access. Back it up; DigitalOcean's web console is the fallback |
| CI SSH key | `D:\Development_Projects\devkeys\iskra-droplet-ci` (+ `.pub`), GitHub secret `DROPLET_SSH_KEY` | ed25519. In root's authorized_keys with a forced command `/usr/local/bin/iskra-update-ci`, which accepts only a version and runs `/usr/local/bin/iskra-update <version>` |
| `DROPLET_HOST`, `DROPLET_KNOWN_HOSTS` (variables) | The IP and its host keys | Refresh after rebuilding the droplet: `ssh-keyscan -t ed25519,ecdsa,rsa 146.190.236.187` → `gh variable set DROPLET_KNOWN_HOSTS < file` (check the fingerprints against the DigitalOcean console first) |

Layout: binaries in `/opt/iskra/app`, the world (database, keys, uploads, backups) in `/opt/iskra/world`, systemd
unit `iskra` (+ drop-in `quiet.conf`), HTTPS by the server's built-in Let's Encrypt, ufw allows 22, 80, 443,
7881/tcp and 7882/udp (voice), 1 GB swap, unattended-upgrades for the OS, raised UDP buffer sysctls for LiveKit.
`iskra-update X` downloads the X server bundle, verifies it against SHA256SUMS.txt, swaps it in, restarts, and
rolls back to the previous bundle if the server doesn't come up.

The world folder holds the server's own secrets: `server.key` (server identity), `livekit.key` (server ↔ LiveKit),
`vapid.json` (push), `certs/`. They're generated by the server and live only there and in its backups; back up
`/opt/iskra/world` (the server makes encrypted daily backups, see docs/hosting.md). The KLIPY GIF key, if set,
is in the server's settings (admins add it in the app), also per server.

**Rotate the CI key:** `ssh-keygen -t ed25519 -f iskra-droplet-ci -C iskra-github-ci -N ""` → on the server, replace
the old line in `/root/.ssh/authorized_keys` keeping the `command="/usr/local/bin/iskra-update-ci",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty`
options → `gh secret set DROPLET_SSH_KEY < iskra-droplet-ci` → run deploy.yml with the current `server_version`.

### Android

The Android app is the Capacitor shell in `mobile/android` ([mobile/README.md](../mobile/README.md#android)), built and
signed on the Windows PC by `mobile/scripts/build-android.ps1` (release-windows.ps1 runs it). The signing key never
goes to CI; CI (`ci.yml` job `android`) only runs the unit tests and an unsigned build.

| Item | Where | Notes |
|---|---|---|
| Release keystore | `D:\Development_Projects\devkeys\iskra-android.keystore` (PKCS12, alias `iskra`), password in `iskra-android-keystore.txt` | Valid ~27 years. Its SHA-256 fingerprint is in `client/public/.well-known/assetlinks.json`; the build script refuses an APK whose signer isn't listed there |
| Firebase app config | `D:\Development_Projects\devkeys\iskra-google-services.json` | Not secret (it ships inside the APK) but per project; the build copies it in and removes it. Missing → the app builds without push (warning) |
| Toolchain | `devtools\android-sdk` (platform 36, build-tools 36.1.0, licenses accepted), JDK 21 (`devtools\jdk-21` or `C:\Program Files\Java\jdk-21`) | Gradle 8.14.3 comes from the wrapper. The old Bubblewrap and JDK 17 in devtools are no longer needed |
| Play Console | Developer account "From a Spark", contact spark@iskra.foo | Not published yet. The AAB is built for it |

**Losing the keystore means installed APKs can never be updated** (Android requires the same key); everyone would
have to uninstall and reinstall. Keep an offline copy (encrypted USB stick and a password manager entry with the
password). Plan: enrol in Play App Signing when publishing on Play; Google then holds the app key and the upload
key can be replaced, and could live in CI. New personal Play accounts need a closed test with 12 testers for 14
days before production. If Play signs the app, add Play's app-signing fingerprint to assetlinks.json. Play also asks
for declarations: foreground service types (microphone, media playback: "voice chat in the background"), and
full-screen intents (incoming calls).

Version codes continue the old Trusted Web Activity's scheme (last: 2.0.0-alpha.7 = 20000107), so its installs update
to the Capacitor app in place. The TWA project is gone from the tree (`android/README.md`, git history).

### Push relay

Iskra servers are self-hosted and can't hold Apple's or Google's push credentials, so the phone apps get pushes
through **push.iskra.foo**, a Cloudflare Worker in `relay/` ([relay/README.md](../relay/README.md)). It stores nothing;
payloads stay encrypted to the phone. Deploy: `gh workflow run deploy.yml -f ref=main -f relay=true`.

| Secret (GitHub environment `release`) | Worker secret | What | Expiry / renewal |
|---|---|---|---|
| `RELAY_HANDLE_KEYS` | `HANDLE_KEYS` | `1:<base64 of 32 random bytes>`: seals push handles | Doesn't expire. Rotate: set `2:<new>,1:<old>` (new first), deploy; drop `1:` only after every app has re-registered (months), since old handles stop working without it. If it leaks: new key alone, deploy; phones re-register on their next launch |
| `APNS_KEY_P8` | `APNS_KEY` | APNs auth key (.p8 contents) | **Never expires**, but can be revoked; Apple allows 2 APNs keys per team |
| `APNS_KEY_ID` | `APNS_KEY_ID` | Its 10-character Key ID | With the key |
| `FCM_SERVICE_ACCOUNT_JSON` | `FCM_SERVICE_ACCOUNT` | Firebase service account key (JSON) | Doesn't expire by default; rotate yearly (below). Org policies may force expiry |
| (variables in `relay/wrangler.toml`) | `APNS_TEAM_ID`, `APNS_TOPIC` | `BWX2M8XSNZ`, `foo.iskra.app` | |

The Cloudflare token (`CLOUDFLARE_API_TOKEN`) also needs **Workers Scripts: Edit** (it has it) and, for the custom
domain, zone `iskra.foo` **Workers Routes: Edit** and **DNS: Edit**. If deploy fails on the custom domain, add those
permissions, or attach the domain once by hand: Cloudflare → Workers & Pages → iskra-push → Settings → Domains &
Routes → Add → Custom domain `push.iskra.foo`.

**One-time setup (owner, ~20 minutes):**
1. **Handle key.** In a terminal: `node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))" | gh secret set RELAY_HANDLE_KEYS --env release`
   (it goes straight into GitHub; don't save it elsewhere: losing it only means phones register again).
2. **APNs key.** developer.apple.com → Certificates, Identifiers & Profiles → **Keys** → **+** → Key Name `Iskra push relay`
   → tick **Apple Push Notifications service (APNs)** → Configure: Environment **Sandbox & Production**, Key Restriction
   **Team Scoped (All Topics)** → Save → Continue → Register → **Download** (only once) `AuthKey_<KEYID>.p8`; note the
   Key ID (Team ID is `BWX2M8XSNZ`). Then, from the folder with it:
   `gh secret set APNS_KEY_P8 --env release < AuthKey_<KEYID>.p8` and `gh secret set APNS_KEY_ID --env release` (paste the Key ID).
   Keep the .p8 in `devkeys\` (offline backup), never in the repo.
3. **App ID push capability.** Identifiers → `foo.iskra.app` → **Push Notifications** ticked (mobile/README.md step 1).
   Nothing to configure for the key-based setup (no certificates).
4. **Firebase project.** console.firebase.google.com → **Create a project** → name `Iskra` → Google Analytics **off** →
   Create. Then **Add app** → Android → package name `foo.iskra.app`, nickname `Iskra` → Register → **Download
   google-services.json** → save it as `D:\Development_Projects\devkeys\iskra-google-services.json` → skip the SDK steps.
5. **FCM service account.** Firebase console → ⚙ Project settings → **Service accounts** → Firebase Admin SDK →
   **Generate new private key** → Generate key (downloads a JSON). Then `gh secret set FCM_SERVICE_ACCOUNT_JSON --env release < iskra-xxxx-firebase-adminsdk-....json`
   and delete the downloaded file (or keep it in `devkeys\`). Check Project settings → **Cloud Messaging**: "Firebase
   Cloud Messaging API (V1)" is **Enabled** (enable it in Google Cloud if not).
6. **Deploy** the relay: `gh workflow run deploy.yml -f ref=main -f relay=true`. Its last step prints
   `{"ok":true,"apns":true,"fcm":true}`.
7. Build a new Android APK (it now includes the Firebase config) and a new iOS build; turn on push in each app.

**Rotate the APNs key:** create a second key (step 2), set both secrets, deploy the relay, check a push arrives, then
revoke the old key (Keys → old key → Revoke). If a key leaks: revoke it at once (pushes stop until the new one is
deployed). **Rotate the FCM service account key:** Google Cloud console → IAM & Admin → Service accounts →
`firebase-adminsdk-…` → Keys → **Add key** → JSON; set the secret, deploy the relay, check, then delete the old key there.
**Lost/broken relay:** phones stop getting pushes (nothing else breaks); servers keep the subscriptions until the
relay answers 404/410.

### GitHub

- The `gh` CLI on the Windows PC is logged in as the owner (`gh auth status`); release-windows.ps1 uses it.
- Workflows use the automatic `GITHUB_TOKEN` with per-job permissions; no personal tokens are stored.
- Secrets (repo level): `CLOUDFLARE_API_TOKEN`, `DROPLET_SSH_KEY`, `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`,
  `APPSTORE_API_KEY_BASE64`, `APPSTORE_KEY_ID`, `APPSTORE_ISSUER_ID`. Environment `release` only: `RELAY_HANDLE_KEYS`,
  `APNS_KEY_P8`, `APNS_KEY_ID`, `FCM_SERVICE_ACCOUNT_JSON` ([Push relay](#push-relay)). Variables: `CLOUDFLARE_ACCOUNT_ID`,
  `DROPLET_HOST`, `DROPLET_KNOWN_HOSTS`, `MAC_IDENTITY`.
- Environment `release` (Settings → Environments → New environment). Used by release-finalize.yml and deploy.yml.
  Options worth setting:
  - **Required reviewers**: the owner approves each publish and each deploy (finalize asks twice: once to publish,
    once for the deploy jobs, which start together and can be approved in one go).
  - **Deployment branches and tags**: "Selected" → branch `main`. Manually started workflows run on `main` (they
    check out the tag themselves), so don't restrict it to tags.
  - **Environment secrets**: move `CLOUDFLARE_API_TOKEN` and `DROPLET_SSH_KEY` here (add them to the environment,
    then delete the repo-level ones). Recommended: then only the release/deploy jobs on main can read them, not
    every workflow on every branch. The Apple secrets stay at repo level (release.yml's tag build uses them).

## 5. Refresh calendar

| When | What | Do |
|---|---|---|
| Every Windows release | SimplySign session | Log in with the phone code before `release-windows.ps1` |
| Weekly (Mondays) | Dependabot PRs, CodeQL scan | Merge green Dependabot PRs; look at new code-scanning alerts (Security tab) |
| Continuous | Droplet OS updates | Automatic (unattended-upgrades); reboot now and then (`ssh … reboot` with the admin key) when `/var/run/reboot-required` exists |
| Every ~60 days, automatic | chat.iskra.foo HTTPS certificate | The server renews it itself; port 80 must stay open |
| Yearly (membership date) | Apple Developer Program | Renew, or Mac builds stop being notarized |
| Yearly | Cloudflare tokens, CI SSH key | Optional rotation (they don't expire): see section 4 |
| Yearly | FCM service account key | Rotate ([Push relay](#push-relay)). The APNs key never expires; only revoke/replace it if it leaks |
| **2027-04 (before 2027-05-12)** | Certum code-signing certificate | Renew (section 4); same CN keeps auto-update working |
| Yearly | iskra.foo domain | Check auto-renew at the registrar |
| Yearly | Offline backups | Check the keystore, devkeys folder and admin SSH key copies still open |
| **2031-08 (before 2031-09-17)** | Apple Developer ID certificate | New CSR, certificate, p12, secrets (section 4) |
| ~2053 | Android keystore | Far future; Play App Signing removes the problem |

## 6. Troubleshooting

**Read a failing run:** `gh run list -L 5`, then `gh run view <id> --log-failed`. CI failures email the owner: fix
or revert quickly.

| Symptom | Cause and fix |
|---|---|
| `release-windows.ps1` stops at "SimplySign isn't logged in", or the build log shows "No provider was specified", "SignTool Error" | SimplySign Desktop is logged out (it times out). Log in with the phone code, rerun. If it happened mid-build, rerun without `-SkipBuild` |
| sign.ps1 found no certificate in PowerShell 7 although it's installed | Fixed: `-CodeSigningCert` is missing when PSModulePath points at PowerShell 7's modules, so sign.ps1 filters on the code-signing EKU (1.3.6.1.5.5.7.3.3) itself. Keep that filter if you touch it |
| macOS: `security: SecKeychainItemImport` / codesign "errSecInternalComponent" / keychain won't unlock | Fixed in release.yml: we import the p12 into our own keychain and run `set-key-partition-list` (electron-builder's temporary keychain fails on current runners). Keep that step |
| Notarization failed or hangs | The electron-builder log shows the submission id. On a Mac with the .p8: `xcrun notarytool log <id> --key AuthKey.p8 --key-id <id> --issuer <issuer>` (or `notarytool history`) lists the rejected files. Common: an unsigned nested binary, missing hardened runtime, expired membership or agreement waiting in App Store Connect |
| Finalize: "missing (…)" | A build didn't upload. Check `release.yml`'s run for the tag, rerun it (`gh workflow run release.yml -f tag=vX`) or rerun release-windows.ps1 with `-SkipBuild` |
| Finalize: "latest.yml: … doesn't match" | A file was re-uploaded without the latest*.yml from the same build (or the other way round). Upload both from the same build |
| Checksums wrong after re-uploading assets | Rerun finalize with `deploy` off: it regenerates SHA256SUMS.txt and the attestations |
| Pages deploy fails | "Authentication error": token revoked/expired or wrong account id (section 4). "Project not found": project names in deploy.yml. The check step failing after a good deploy: Cloudflare cache; rerun |
| Server update fails | `iskra-update` rolled back to the previous version (the server keeps running). Log in with the admin key: `journalctl -u iskra -n 200`. Host key mismatch in CI: the droplet was rebuilt, refresh `DROPLET_KNOWN_HOSTS` |
| `release.yml`: "Check the tag matches the app version" fails | The tag was pushed without `npm run release`. Don't move the tag: delete the draft release, bump to the next version |
| Linux CI: audio/video device errors | Runners have no sound card or display. Electron tests run under `xvfb-run`; browser tests use Chromium's fake media devices. Don't add tests that need real devices |
| Windows Firewall prompts during tests | Something listened on all interfaces. Tests must be localhost-only (`LocalOnly: true`, `ISKRA_LOCAL_ONLY=1`); `scripts/dev-firewall.ps1` adds block rules for new exe paths |
| CodeQL C# job fails to build | Needs .NET 10 (setup-dotnet in codeql.yml); same build as CI |
| iOS: "Cloud signing permission error" / "doesn't have permission to … cloud-managed distribution certificates" | The API key isn't Admin. New Admin key, replace the three `APPSTORE_*` secrets ([iOS app](#ios-app), mobile/README.md step 3) |
| iOS: "No profiles for 'foo.iskra.app'" / "No Account for Team" | The App ID isn't registered, or a developer agreement is pending (developer.apple.com and App Store Connect → Business). Owner fixes it, rerun |
| iOS archive fails on signing with `archive_signing=adhoc` | Rerun with `-f archive_signing=automatic`. If later runs then fail with "certificate … private key not installed", revoke the old "Created via API" development certificates |
| iOS upload: "bundle version must be higher" / "redundant binary upload" | That build number exists: rerun (the attempt number goes up). "No suitable application records" → the App Store Connect app record is missing |
| iOS upload: "SDK version issue" / "built with … SDK" | Apple wants a newer Xcode than the runner has; the workflow picks the newest installed. Wait for GitHub's image or switch `runs-on` to a newer macOS image |
| Push relay health says `"apns":false` / `"fcm":false` | That secret isn't set in the `release` environment, or deploy.yml ran before it was: set it, rerun with `relay=true` |
| Phones get no pushes, relay healthy | Settings → Notifications in the app shows the error per server. "push relay couldn't register": relay down or rate limited. Android without Firebase config: rebuild with `devkeys\iskra-google-services.json`. iOS: `aps-environment` must be production in the build (mobile-ios.yml checks it) |
| iOS: "No profiles for 'foo.iskra.app.NotificationService'" | Register that App ID (mobile/README.md step 7), rerun |
| build-android.ps1: "fingerprint isn't in assetlinks.json" | It found a different keystore. Never ship that APK: installed apps couldn't update. Point `ISKRA_ANDROID_KEYSTORE` at the real one |
| Universal Links open Safari instead of the app | `curl -sI https://app.iskra.foo/.well-known/apple-app-site-association` must be 200 `application/json` with no redirect; Apple's CDN caches it (up to a day): reinstall the app later |

**Undoing a release:** don't delete or move the tag. Fix forward with the next version. To pull a broken release
from the auto-updater quickly, mark it a prerelease (`gh release edit vX --prerelease --latest=false`) and mark the
previous one Latest. The server can be put back with deploy.yml `server_version=<previous>` only if no database
migration ran in between (migrations are forward-only); otherwise restore from a backup.

## 7. Rules for agents

- Never print, echo, log or commit a secret, token, key, password or certificate. Set secrets with `gh secret set NAME < file`.
- Never force-push and never move or delete a published tag; bump the version instead.
- Keep CI green: failures email the owner. Watch runs you started (`gh run watch`).
- Public text (release notes, site, docs): the product is just "Iskra". Never "Iskra 2", never "rebuilt", never v1.
- Releases are published as Latest, not prerelease.
- Tests and local servers listen on localhost only (no firewall prompts).
- Needs the human: the SimplySign phone code, the Apple developer portal and App Store Connect (app record, TestFlight testers, API keys, the APNs key), the Firebase console, the Play Console,
  the Cloudflare dashboard (new tokens), DigitalOcean, approving `release` environment runs, anything that costs money.
