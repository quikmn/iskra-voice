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
8. [Uptime monitoring](#8-uptime-monitoring)
9. [CI results in Iskra](#9-ci-results-in-iskra)

## 1. Overview

```
 every branch push ──► ci.yml ..... server, client, desktop tests (Windows, Linux), interop, e2e in 4 shards
                                    (+ the `end-to-end` check over them), release-script tests + backup-restore drill
                                    (one job; report kept as an artifact). A newer push to the branch cancels the older
                                    run, except a "Version X" commit's (the release gate needs it)
 PR / nightly on main ──► ci.yml ... the same plus desktop tests on macOS and the macOS LiveKit cache for releases
 every push / PR / weekly ──► secrets.yml .. gitleaks over the whole git history
 PR / weekly / by hand ──► codeql.yml ... code scanning: JS/TS, C#, workflows
 PR / weekly / by hand ──► scorecard.yml ..... OpenSSF Scorecard → code scanning + scorecard.dev (the weekly run publishes)
 weekly ──► Dependabot ............ grouped PRs for npm (client, desktop, bots), NuGet (server), GitHub Actions
 every 15 min ──► uptime.yml ....... iskra.foo, app.iskra.foo, chat.iskra.foo (+ /health), voice port, TLS expiry
                                     ──► GitHub issue labelled "outage" on a change of state (section 8)

 RELEASE = scripts/release-all.ps1 X (this Windows PC, SimplySign logged in) runs ①–④ and the final checks
 ① release-notes.mjs + release.mjs  notes from docs/releases/NEXT.md into docs/releases/X.md; bump version in
                                    desktop/package.json(+lock), client/src/links.ts, site/index.html; commit "Version X"; tag vX
 ② git push --atomic origin main vX   (no waiting for CI: CI on main and the release builds run side by side)
        ├─► ci.yml (on main) ............. the tests; finalize refuses to publish until this run is green
        └─► release.yml (on the tag) ...... Linux AppImage/deb/rpm, macOS dmg/zip (x64 and arm64 in parallel jobs,
                                            each signed + notarized; latest-mac.yml merged), server tarballs;
                                            attestations; creates the DRAFT release vX
 ③ scripts/release-windows.ps1 X -NoFinalize
        ├─ npm run dist ................... signed Setup + Portable exe, latest.yml, signed iskra-server.exe
        ├─ server zip, build-android.ps1 .. iskra-server-X-win-x64.zip, Iskra-X.apk (mobile/, signed locally)
        └─ gh release upload ............... onto the draft
 ④ waits for release.yml and all 22 files, then starts
        └─► release-finalize.yml (workflow_dispatch, environment "release")
              ├─ publish: CI gate (ci.yml green on the tagged commit, waits up to 45 min), check files +
              │           latest*.yml hashes, CycloneDX SBOMs, SHA256SUMS.txt, attestations,
              │           publish as Latest (not prerelease) with docs/releases/X.md
              └─► deploy.yml (reusable, environment "release")
                    ├─ site ....... wrangler → Pages iskra-hero-page → https://iskra.foo  (checks the new links and every page)
                    ├─ webapp ..... client build → Pages iskra-webclient → https://app.iskra.foo (checks the new index asset)
                    └─ server ..... ssh root@DROPLET_HOST X → iskra-update X → https://chat.iskra.foo (checks it answers)
 ⑤ phones (where mobile/store.json says; docs/store/README.md)
        ├─► mobile-ios.yml (ref vX, upload) ... build, cloud-sign, upload, then scripts/appstore.mjs: processing,
        │                                       What to test, TestFlight groups, Beta App Review (phase B: + App Store
        │                                       version, listing, screenshots, App Review, automatic release)
        └─ scripts/play-upload.mjs X ......... the AAB from ③ → Google Play track (phase A: closed testing "alpha";
                                                phase B: production + listing), release notes en-US/sv-SE
 ⑥ final checks; a phone problem ends with STOP [phones] (-Resume retries only that)

 DEPLOY ONLY: deploy.yml by hand (workflow_dispatch: ref, site, webapp, server_version)
 BOT SDK: tag bots-sdk-vX ──► bots-sdk.yml ──► npm "iskra-bots" X with provenance (environment "npm"; section 4 → npm)
 iOS APP ALONE: mobile-ios.yml by hand (workflow_dispatch: ref, upload, store)
 RESULTS: ci.yml (main) and release-finalize.yml post pass/fail to an Iskra channel when ISKRA_CI_WEBHOOK is set (section 9)
```

| File | What it does |
|---|---|
| `package.json` (repo root) | `npm run release`, `npm test` (release-script tests) |
| `scripts/release-all.ps1` | The whole release (①–④ plus final checks). `-DryRun` checks everything and changes nothing; `-Resume` continues after a stop once the tag is pushed |
| `scripts/release-notes.mjs` | Writes docs/releases/X.md from docs/releases/NEXT.md (headline, sections, "Get started" from the previous notes) and empties NEXT.md; refuses lines that already shipped |
| `scripts/release.mjs` | Step ①. `--dry-run` shows the changes, `--push` pushes too |
| `scripts/ci-gate.mjs` | Exits 0 only when a push run of ci.yml concluded success on the given commit (waits up to `--wait-minutes`). Used by finalize |
| `scripts/release-lib.mjs`, `release-lib.test.mjs` | Version checks, version replacement, asset list, latest.yml parsing and merging, notes from NEXT.md, the CI verdict (unit-tested, run in CI) |
| `scripts/release-assets.json` | The files every release must have. One list for the PowerShell script and the workflows |
| `scripts/release-assets.mjs` | `list`, `names`, `check` (files + latest*.yml sha512), `sums` (SHA256SUMS.txt), `merge-yml` (release.yml: one latest-mac.yml from the two Mac jobs) |
| `scripts/release-windows.ps1` | Step ③ (on its own it also waits for the other files and starts finalize) |
| `.github/workflows/release.yml` | Linux and macOS builds on a `v*` tag |
| `.github/workflows/release-finalize.yml` | Publish + deploy |
| `.github/workflows/deploy.yml` | Site, web app and server deploys with checks; called by finalize or run by hand |
| `.github/workflows/marketplace.yml` | Lints the DigitalOcean Marketplace image (`marketplace/digitalocean/`) on changes; its build job runs only by hand in the `marketplace` environment (owner approval, secret `DO_MARKETPLACE_TOKEN`). Steps: `marketplace/digitalocean/README.md` |
| `.github/workflows/ci.yml`, `codeql.yml`, `.github/dependabot.yml` | Tests (including the backup-restore drill), code scanning, dependency updates |
| `.github/workflows/secrets.yml`, `.gitleaks.toml`, `.gitleaksignore` | Secret scan of the whole history ([below](#secret-scanning-and-security-settings)) |
| `.github/workflows/scorecard.yml` | OpenSSF Scorecard (supply-chain checks), results in the Security tab |
| `SECURITY.md`, `site/.well-known/security.txt`, `client/public/.well-known/security.txt` | Vulnerability disclosure policy and the RFC 9116 contact files on iskra.foo and app.iskra.foo |
| `docs/releases/<version>.md` | Release notes (become the GitHub release text) |
| `desktop/scripts/sign.ps1` | Signs the standalone Windows server exe with the Certum certificate |
| `mobile/scripts/build-android.ps1` | Signed Android APK (+ AAB) from the Capacitor shell ([Android](#android)) |
| `.github/workflows/mobile-ios.yml` | iPhone/iPad app: build, cloud-sign, upload to TestFlight ([iOS app](#ios-app)) |
| `.github/workflows/bots-sdk.yml`, `bots/sdk/package.json`, `bots/sdk/build-package.mjs` | The bot SDK on npm as `iskra-bots`, on a `bots-sdk-v*` tag ([npm](#npm-bot-sdk)) |
| `scripts/mobile-version.mjs` | The phone app's version and build numbers (tested by the root `npm test`) |
| `mobile/store.json` | Where the phone apps go each release: iOS mode (testflight, appstore, upload), TestFlight groups, Play track, rollout, listing ([docs/store/README.md](store/README.md)) |
| `scripts/appstore.mjs` | App Store Connect after each iOS upload (run by mobile-ios.yml): processing, export compliance, What to test, TestFlight groups, Beta App Review; phase B the App Store version, listing, screenshots, App Review. Tests against a fake API: `scripts/appstore.test.mjs` |
| `scripts/play-upload.mjs` | The Android app bundle to Google Play (Android Publisher API; run by release-all.ps1): track, release notes, listing, data safety. `--list-tracks`, `--dry-run`, `--check`. Tests against a fake API: `scripts/play-upload.test.mjs` |
| `scripts/ci-notify.mjs` | CI and release results to an Iskra channel ([section 9](#9-ci-results-in-iskra)) |
| `docs/store/` | Store texts, forms and graphics: `play/` (Google Play), `appstore/` (App Store), `README.md` (phases and the owner's one-time steps) |
| `.github/workflows/uptime.yml`, `scripts/uptime-check.sh` | Uptime checks and outage issues ([section 8](#8-uptime-monitoring)) |
| `server/deploy/iskra-update-guard` | Shipped in the Linux server tarball (release.yml): undoes a server self-update that doesn't start (docs/hosting.md) |
| `desktop/scripts/build-sidecar.mjs` | `iskra-p2p`, the standalone server's peer-to-peer tunnel as one Node single executable (+ `iskra-p2p-licenses.txt`), into every server package: release.yml (Linux, both Macs; Mac x64 takes Node from nodejs.org, checked against SHASUMS256.txt; ad-hoc signed) and release-windows.ps1 (signed, checked with the other signatures). Not in the desktop app, which runs the tunnel itself |

Supply chain: every action is pinned to a full commit SHA with the version as a comment (Dependabot keeps them
current); every workflow starts with minimal `permissions:` and widens them per job; wrangler is pinned
(`WRANGLER` in deploy.yml). Releases carry build-provenance attestations: `gh attestation verify <file> -R quikmn/iskra-voice`.
Each release also carries CycloneDX 1.6 SBOMs, made by finalize from the tag's lock files and project:
`iskra-sbom-web-X.cdx.json` (web app, runtime npm packages), `iskra-sbom-desktop-X.cdx.json` (desktop shell's runtime npm
packages; the web app inside it is the web SBOM) and `iskra-sbom-server-X.cdx.json` (server NuGet packages). They're in
SHA256SUMS.txt and attested like every other file. Tools are pinned in the step (`@cyclonedx/cyclonedx-npm`, the `CycloneDX`
dotnet tool). Check one with `gh attestation verify iskra-sbom-server-X.cdx.json -R quikmn/iskra-voice`, or feed it to a
scanner (`grype sbom:iskra-sbom-server-X.cdx.json`). They aren't in `release-assets.json`, so release-windows.ps1 doesn't wait for them;
`release-assets.mjs check` lists them as "unexpected file", which is fine.
For Linux/macOS files they come from the build workflow; for Windows and Android files (built locally) they only
prove the file is the one the finalize run published, not how it was built.
Standalone servers **require** these attestations before updating themselves (Updates/Attestations.cs): signed by
`release.yml` at the tag `vX` or by `release-finalize.yml` on `main` (dispatch finalize from `main`, or servers refuse the
update), for repository id 1227290412, naming the package file with its SHA-256. They check it offline against the
Sigstore trusted root compiled into the server, `server/src/Iskra.Server/Updates/sigstore-trusted-root.json`. CI warns when
it differs from Sigstore's current one; refresh it before tagging with
`gh attestation trusted-root | head -n 1 > server/src/Iskra.Server/Updates/sigstore-trusted-root.json` and run the server tests
(AttestationTests verify a real release against it). A server built with an older root refuses an update signed with a
newer Sigstore key until its owner updates it by hand once.

## 2. Releasing

Versions are `x.y.z` or `x.y.z-alpha.n`; tags are `v` + version. Alphas are published as normal releases marked
Latest (a prerelease never becomes GitHub's Latest, and people are told to "get the latest release"). The desktop
apps update themselves from the release (`latest*.yml`), with `allowPrerelease` on during the alpha.

**One command:** `.\scripts\release-all.ps1 <version>` on the Windows PC, from an up-to-date, clean `main`, with
SimplySign Desktop logged in. `-DryRun` first: it runs every check (git state, version, notes, links.ts/site, CI on main,
signing certificate, workflows) and prints every step without changing anything. On a problem it prints one
`STOP [case] what to do` line (the cases of the playbook's decision table) and ends; once the tag is pushed,
`-Resume` picks up where it stopped. What it does, step by step:

1. **Notes.** `scripts/release-notes.mjs` turns `docs/releases/NEXT.md` (bullets under `### What's new`, `### Fixes`,
   `### Good to know`; each change one line) into `docs/releases/<version>.md`: the headline, the non-empty sections and
   `### Get started` from the previous notes with the new version; NEXT.md goes back to empty sections. It refuses
   lines that already shipped in the previous notes and breaks of the public wording rules ("Iskra 2", "rebuilt", v1).
   A hand-written `docs/releases/<version>.md` ([format](releases/README.md)) wins: NEXT.md is then left alone.
2. **Bump and tag.** `npm run release -- <version>`. It refuses if the branch isn't
   main, the tree has other changes, main is behind origin, the tag exists, the version isn't newer, the notes are
   missing, or links.ts/site don't mention the current version. Result: one commit "Version X" (with the notes and
   NEXT.md) and an annotated tag vX.
3. **Push.** `git push --atomic origin main vX`. Nothing waits for CI here: CI runs on main while `release.yml` builds
   from the tag (Linux, Mac x64 and Mac arm64 in parallel jobs) and creates the draft release. CI doesn't run on tags
   (`branches: ['**']`): the tag's commit is main's, tested once.
4. **Windows + Android.** `.\scripts\release-windows.ps1 X -NoFinalize` (PowerShell 7). It test-signs a scratch file
   first, builds, checks every signature (valid, right publisher, timestamped), builds the server zip and APK, prints
   SHA256s, uploads and checks sizes on GitHub. Run on its own (without `-NoFinalize`) it also waits for the Linux/macOS
   files (up to `-WaitMinutes`, default 60) and starts finalize; `-SkipBuild` re-uploads existing files.
5. **Finalize.** release-all.ps1 waits for `release.yml` (and checks both Macs were notarized), checks all 22 files are
   there and starts `release-finalize.yml` (approve it if the environment has reviewers). Its first step is the **CI
   gate**: `scripts/ci-gate.mjs` waits (up to 45 min) for a push run of `ci.yml` on exactly the tagged commit and fails,
   before anything is uploaded or published, unless one concluded success. Then the checks, SBOMs, sums, attestations,
   publishing and the deploys. Done when all its jobs are green; its checks are the verification: iskra.foo links to vX,
   app.iskra.foo serves the new bundle, chat.iskra.foo answers, GitHub's Latest is vX, the downloads resolve.
   release-all.ps1 then checks them once more itself (Latest, every file and SHA256SUMS.txt, iskra.foo links,
   app.iskra.foo's bundle has the version, chat.iskra.foo/health reports it).
6. **Phones.** Once finalize published the release: release-all.ps1 starts `mobile-ios.yml` on the tag with upload on
   (its run is titled "Mobile iOS vX (TestFlight)", so a resumed release finds it instead of building twice), uploads
   `mobile\release\Iskra-X.aab` (built by release-windows.ps1 together with the APK) with `scripts/play-upload.mjs`,
   then waits for the iOS run, which ends with `scripts/appstore.mjs` doing everything App Store Connect needs.
   Where they go is `mobile/store.json` (phase A: TestFlight internal and external groups + Beta App Review, Play's
   closed testing track; phase B: the App Store and Play production; [docs/store/README.md](store/README.md)).
   No Play key (`D:\Development_Projects\devkeys\google-play-service-account.json`): the Play upload is skipped with a
   note. A phone problem doesn't stop the final checks; the run then ends with `STOP [phones]` and `-Resume` retries only
   what isn't done (a version already on the Play track or a TestFlight run that succeeded is left alone).
   `-SkipPhones` leaves the stores alone, `-PlayTrack <track>` overrides the track once.
7. Afterwards: `git checkout main`.

The user's own server updates through finalize. Other standalone servers look for new releases themselves (owner
setting, Settings → Updates: off / tell me / install automatically on Linux with systemd; docs/hosting.md "Updating").
They read the same release: the `iskra-server-<v>-<rid>` package, `SHA256SUMS.txt`, GitHub's asset digests and the
attestations, so every release needs SHA256SUMS.txt (finalize makes it) and the Linux tarball needs
`iskra-update-guard` (release.yml adds it). Servers report their version at `/health`; release builds get it from
`prepare-server.mjs` (`-p:Version=` from desktop/package.json), anything else says `0.0.0-dev` and never updates.

## 3. Deploying without a release

`deploy.yml` → Run workflow (or `gh workflow run deploy.yml -f ref=main -f site=true`):

| Input | Effect |
|---|---|
| `ref` | Tag or branch the site and web app are built from (`main` for a site text fix, the release tag to redeploy a release) |
| `site` | iskra.foo from `site/`: every `*.html` page (index, terms, privacy, support, delete-account), `*.css` (site.css, fonts.css), the `fonts/` folder (self-hosted Inter and JetBrains Mono), `.well-known/` (security.txt), worker.js and .assetsignore; never wrangler.toml or .wrangler/. Pages serves `terms.html` at `/terms` (and redirects `/terms.html` there). Fails if index.html doesn't link to the version in desktop/package.json at that ref, or if a page isn't served at `https://iskra.foo/<page>` afterwards (checked by its `<link rel="canonical">`, so every new page needs one), or `/.well-known/security.txt` isn't |
| `webapp` | Builds `client/` and deploys `client/dist` to app.iskra.foo (branch main = production), then checks the new bundle and `/.well-known/security.txt` |
| `server_version` | Runs `iskra-update <version>` on the droplet. The version must be a published release (it downloads from GitHub and checks SHA256SUMS.txt) |

Local fallback (no CI): `site/` with the `iskra-deploy-cf` token through `D:\Development_Projects\IskraHeroPage\deploy-hero.ps1`
(it decrypts the token itself; never print it). It deploys its own folder `IskraHeroPage\iskra-site`, not `site/`: copy
`site/*.html`, `site/*.css`, `site/fonts/`, `site/.well-known/`, `site/worker.js` and `site/.assetsignore` into it first, because a Pages deploy replaces the whole
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

**Mac updates depend on it.** Installed Mac apps update themselves (electron-updater + Squirrel.Mac) only when they
are Developer ID signed, and only to an update signed by the same team (`BWX2M8XSNZ`). The updater reads
`latest-mac.yml` and downloads the `.zip` for the Mac's CPU (`Iskra-X-mac-arm64.zip` or `-mac-x64.zip`, with its
`.blockmap` for smaller downloads); the dmgs are only for first installs. The "Check the update files" step in
release.yml (one job per architecture) unpacks its zip and fails the build if it isn't Developer ID signed by that team, isn't accepted by
Gatekeeper, or isn't listed in `latest-mac.yml`; the publish job merges the two jobs' `latest-mac.yml` into one that lists both zips (`release-assets.mjs merge-yml`, checked against every file's sha512 and size); `release-assets.mjs check` (finalize) also fails if a `latest*.yml`
doesn't list the files the updaters install from. An ad-hoc release (secrets missing, a warning in the log) isn't
installed by signed apps: they show a download link instead. So is a **new Developer ID with a different team**: the
release after a team change has to be installed by hand once. A renewed certificate with the same team is fine.

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
| App ID `foo.iskra.app` | developer.apple.com → Identifiers (team BWX2M8XSNZ) | Capability: Associated Domains. The phone apps have no push (notifications arrive while the app is open) |
| App record "Iskra" | App Store Connect → Apps | Created by the owner once (the API can't); TestFlight internal group with automatic distribution |
| Signing | Xcode cloud signing with the `APPSTORE_*` key | No certificates, profiles or keychains in CI. Apple keeps a cloud-managed "Apple Distribution" certificate; it shows under Certificates and renews itself |
| Universal Links | `client/public/.well-known/apple-app-site-association` on app.iskra.foo, entitlement `applinks:app.iskra.foo` | Deploy the web app before testers install |
| Export compliance | `ITSAppUsesNonExemptEncryption = false` in Info.plist | Standard algorithms, mass-market exemption; reasoning and open questions (France) in mobile/README.md |

**Build numbers.** `CFBundleShortVersionString` is the numeric part of `desktop/package.json`'s version (2.0.0-alpha.10 →
2.0.0); `CFBundleVersion` is `<version code>.<run number>.<run attempt>` with Android's version code (20000110), so it rises
with every release and every rebuild. App Store Connect rejects a build number it has already seen for that version; just
rerun. Once a `2.0.0` build is approved for the App Store, that version is closed: the next builds must be a higher
version (the next release bump does that).

**Running it.** Every release runs it (release-all.ps1, step 6 of [Releasing](#2-releasing)). By hand:
`gh workflow run mobile-ios.yml [-f ref=vX] [-f upload=false] [-f store=auto|testflight|appstore|upload]` (default:
main, upload, the mode in `mobile/store.json`). After the upload, the step "TestFlight groups and reviews" runs
`scripts/appstore.mjs`: it waits for Apple's processing (up to an hour; the job's timeout is 120 minutes), answers
export compliance, sets What to test from the release notes, keeps TestFlight's test information and the review
contact current, adds the build to the internal groups and the external groups in `mobile/store.json` (the public link
`r4tMgn3D`) and submits it for Beta App Review; in phase B it also fills and submits the App Store version. Every step
looks first, so reruns don't submit twice. The run summary names the build and what App Store Connect did.

| Also used by the store step | Where | Notes |
|---|---|---|
| `APPSTORE_REVIEW_PHONE` (secret, optional) | The review contact's phone | Apple requires a phone for App Review; set once with `gh secret set APPSTORE_REVIEW_PHONE` |
| `REVIEW_INVITE_URL` (variable) | A never-expiring member invite to the review server (Iskra Review, chat.iskra.foo:8443) for the review notes | One-time setup (docs/store/README.md): **Invite friends → Expires after: Never**. Nothing to renew; only if it's revoked, make a new one and set the variable again. Phase B refuses to submit without it |

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
It also runs **Iskra Review** (for app store reviewers, nothing else): world `/opt/iskra/review-world`, service
`iskra-review` on the same binary as Hangout, `https://chat.iskra.foo:8443` with Hangout's certificate (`Https.Mode` "files";
a nightly `iskra-review-restart.timer` picks up renewals and new versions), voice on 7891/tcp and 7892/udp (ufw), updates off.

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

**So friends see "restarting", not "went offline", during a deploy** (on the droplet since 2026-10-13):
`/usr/local/bin/iskra-update` runs this line right before its first `systemctl stop iskra` (while the old bundle is
still in `/opt/iskra/app`):

```sh
/opt/iskra/app/iskra-server expect-restart /opt/iskra/world --reason update --eta 30 || true
```

It writes the restart marker (`/opt/iskra/world/restart-expected`, see docs/hosting.md and PROTOCOL.md "Restarts and
reconnecting"); the stopping server reads it and closes sessions with 1012 `update`. `|| true` keeps a deploy going
if the binary at that point predates the command (it ships in the release after 2.0.0-alpha.12), and the first deploy after it
lands still says "went offline" because the *old* server is the one stopping. The marker is root-written but
world-readable (0644) inside the owner-only world folder, so the `iskra` user can read and delete it.
`iskra-update-guard` needs nothing: it runs at start (ExecStartPre), after the stop, and the server's own
automatic updates already say 1012.

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
goes to CI; CI (`ci.yml` job `android`) only runs an unsigned build.

| Item | Where | Notes |
|---|---|---|
| Release keystore | `D:\Development_Projects\devkeys\iskra-android.keystore` (PKCS12, alias `iskra`), password in `iskra-android-keystore.txt` | Valid ~27 years. Its SHA-256 fingerprint is in `client/public/.well-known/assetlinks.json`; the build script refuses an APK whose signer isn't listed there |
| Toolchain | `devtools\android-sdk` (platform 36, build-tools 36.1.0, licenses accepted), JDK 21 (`devtools\jdk-21` or `C:\Program Files\Java\jdk-21`) | Gradle 8.14.3 comes from the wrapper. The old Bubblewrap and JDK 17 in devtools are no longer needed |
| Play Console | Developer account "From a Spark", contact spark@iskra.foo | Every release uploads the AAB ([Google Play uploads](#google-play-uploads)) |
| Play service account key | `D:\Development_Projects\devkeys\google-play-service-account.json` (JSON key of `iskra-play-publisher@…`), read only by `scripts/play-upload.mjs` at release time | No expiry. Missing: Play uploads are skipped with a note. Setup: [docs/store/README.md](store/README.md#google-play-service-account-for-the-uploads) |

**Losing the keystore means installed APKs can never be updated** (Android requires the same key); everyone would
have to uninstall and reinstall. Keep an offline copy (encrypted USB stick and a password manager entry with the
password). Plan: enrol in Play App Signing when publishing on Play; Google then holds the app key and the upload
key can be replaced, and could live in CI. New personal Play accounts need a closed test with 12 testers for 14
days before production. If Play signs the app, add Play's app-signing fingerprint to assetlinks.json. Play also asks
for a declaration of the foreground service types (microphone, media playback: "voice chat in the background").

#### Google Play uploads

`scripts/play-upload.mjs <version>` (release-all.ps1 runs it after publishing) does one Android Publisher API edit:
`edits.insert`, `bundles.list` (Play never takes a version code twice: a code already there from the same file isn't
uploaded again; from a different file it stops and says to rebuild with `-Rebuild n`), `bundles.upload`, `tracks.get`
/ `tracks.update` to the track in `mobile/store.json` (`alpha` is the API name of Play's closed testing track; a custom
closed track goes by its own name, and an unknown name stops with the list of the app's tracks), release notes
en-US + sv-SE from `docs/releases` (Play's 500 characters: the headlines and a link to the full notes), status
`completed` (or `inProgress` with `userFraction` when `rollout` < 1), and in phase B the listing (`edits.listings`,
`edits.images`, only changed graphics) in the same edit, then `edits.commit`; `"dataSafety": true` also sends
`docs/store/play/data-safety.csv` (`applications.dataSafety`, Play Console's CSV format). A version already on the track
changes nothing. Two answers Play gives are handled: an app that was never published takes only **draft** releases
(the release is added as a draft; publish it once in Play Console), and managed publishing commits with
`changesNotSentForReview` (send them for review in Play Console). Auth: google-auth-library (mobile/devDependencies)
with the service account key; the script never prints it. Read only: `node scripts/play-upload.mjs --list-tracks`.
Dry run: `node scripts/play-upload.mjs <version> --dry-run`.

Version codes continue the old Trusted Web Activity's scheme (last: 2.0.0-alpha.7 = 20000107), so its installs update
to the Capacitor app in place. The TWA project is gone from the tree (`android/README.md`, git history).

### GitHub

- The `gh` CLI on the Windows PC is logged in as the owner (`gh auth status`); release-windows.ps1 uses it.
- Workflows use the automatic `GITHUB_TOKEN` with per-job permissions; no personal tokens are stored.
- Secrets (repo level): `CLOUDFLARE_API_TOKEN`, `DROPLET_SSH_KEY`, `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`,
  `APPSTORE_API_KEY_BASE64`, `APPSTORE_KEY_ID`, `APPSTORE_ISSUER_ID`; optional `APPSTORE_REVIEW_PHONE` (App Review
  contact) and `ISKRA_CI_WEBHOOK` ([section 9](#9-ci-results-in-iskra)). Variables: `CLOUDFLARE_ACCOUNT_ID`,
  `DROPLET_HOST`, `DROPLET_KNOWN_HOSTS`, `MAC_IDENTITY`, `REVIEW_INVITE_URL` (the review server invite for App Review notes).
- Environment `release` (Settings → Environments → New environment). Used by release-finalize.yml and deploy.yml.
  Options worth setting:
  - **Required reviewers**: the owner approves each publish and each deploy (finalize asks twice: once to publish,
    once for the deploy jobs, which start together and can be approved in one go).
  - **Deployment branches and tags**: "Selected" → branch `main`. Manually started workflows run on `main` (they
    check out the tag themselves), so don't restrict it to tags.
  - **Environment secrets**: move `CLOUDFLARE_API_TOKEN` and `DROPLET_SSH_KEY` here (add them to the environment,
    then delete the repo-level ones). Recommended: then only the release/deploy jobs on main can read them, not
    every workflow on every branch. The Apple secrets stay at repo level (release.yml's tag build uses them).

### npm (bot SDK)

The bot SDK is published to npm as [`iskra-bots`](https://www.npmjs.com/package/iskra-bots) by `bots-sdk.yml`, separately
from app releases. Not published yet: the owner sets it up once.

- **Account:** an npm account with two-factor authentication (the package is unscoped, so no npm organization is needed;
  the `@iskra` scope belongs to someone else). The first publish creates the package under that account.
- **Token:** a granular access token (npmjs.com → Access Tokens → Generate New Token → Granular) with read and write on
  packages (narrow it to `iskra-bots` after the first publish), saved as the secret `NPM_TOKEN` in the `npm` environment
  (Settings → Environments → npm; the workflow creates it on its first run, add the owner as a required reviewer).
  Write tokens expire (npm allows at most 90 days): renew it before a publish. Instead of a token, npm's trusted
  publishing (npmjs.com → the package → Settings → Trusted publisher: this repository, workflow `bots-sdk.yml`,
  environment `npm`) needs no secret at all once the package exists.
- **Publishing:** bump `version` in `bots/sdk/package.json`, commit, then `git tag bots-sdk-v<version>` and push the tag.
  The workflow checks the tag matches, type-checks, builds (`npm run build:sdk` in `bots/`) and runs `npm publish
  --provenance`. Try it locally first: `npm run pack:sdk` in `bots/` lists exactly what would be published.

### Secret scanning and security settings

`secrets.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks) (pinned release, checksum checked in the workflow) over
every branch and tag on each push, PR and weekly. GitHub's own protections are owner settings, not files: repo → Settings →
**Advanced Security** (Code security): turn on **Secret scanning** and **Push protection** (blocks a push that contains a known
token format), **Private vulnerability reporting** (SECURITY.md points reporters there), Dependabot alerts and security updates,
and CodeQL (already a workflow). Scorecard publishes its score at scorecard.dev and puts its findings under Security → Code scanning;
many of them (branch protection, review) are owner settings too. Click-by-click steps: docs/compliance/owner-actions.md.

## 5. Refresh calendar

| When | What | Do |
|---|---|---|
| Every Windows release | SimplySign session | Log in with the phone code before `release-windows.ps1` |
| Weekly (Mondays) | Dependabot PRs, CodeQL, Scorecard and secret scans | Merge green Dependabot PRs; look at new code-scanning alerts (Security tab: CodeQL and Scorecard) and secret-scanning alerts |
| Continuous | Droplet OS updates | Automatic (unattended-upgrades); reboot now and then (`ssh … reboot` with the admin key) when `/var/run/reboot-required` exists |
| Every ~60 days, automatic | chat.iskra.foo HTTPS certificate | The server renews it itself; port 80 must stay open |
| Yearly (membership date) | Apple Developer Program | Renew, or Mac builds stop being notarized |
| Yearly | Cloudflare tokens, CI SSH key | Optional rotation (they don't expire): see section 4 |
| **2027-04 (before 2027-05-12)** | Certum code-signing certificate | Renew (section 4); same CN keeps auto-update working |
| **2027-09 (before 2027-10-01), then yearly** | `Expires` in both security.txt files | Move it a year ahead (RFC 9116: at most a year), check Contact and Policy still work, deploy site and web app |
| Yearly | iskra.foo domain | Check auto-renew at the registrar |
| Before each bot SDK publish | `NPM_TOKEN` (npm write tokens last at most 90 days) | New granular token into the `npm` environment, or switch to trusted publishing (section 4 → npm) |
| Yearly | Offline backups | Check the keystore, devkeys folder and admin SSH key copies still open |
| After 60 days without commits | Uptime schedule | GitHub pauses scheduled workflows in inactive repos (it emails first): Actions → Uptime → Enable workflow |
| **2031-08 (before 2031-09-17)** | Apple Developer ID certificate | New CSR, certificate, p12, secrets (section 4) |
| ~2053 | Android keystore | Far future; Play App Signing removes the problem |

## 6. Troubleshooting

**Read a failing run:** `gh run list -L 5`, then `gh run view <id> --log-failed`. CI failures email the owner: fix
or revert quickly.

**End-to-end in CI** runs in four jobs, `end-to-end shard 1/4` … `4/4`, plus `interop` (the TS client and bot SDK
against the server, not sharded). The shards split the spec files by measured duration so they finish together:
`scripts/e2e-shards.mjs` (greedy, longest first) over `client/e2e/durations.json`; a spec not in that file counts as the
median, so a new spec always runs somewhere. Shard 1 checks that the split holds every spec Playwright lists, once
(`npm test` at the root checks the same offline). When the shards drift apart (new or slower specs), refresh the
durations from a green run: `gh run view <id> --log > ci.log`, `node scripts/e2e-shards.mjs measure ci.log` (several logs
are averaged), commit `durations.json`; `node scripts/e2e-shards.mjs show` prints the split. The job `end-to-end` waits
for all of them and is green only when every one passed: it's the check to require in branch protection. When a shard
fails it merges the shards' blob reports into one HTML report, the artifact `playwright-report` (open `index.html`;
traces included); each failing shard also keeps its `playwright-results-<n>` folder. Run one shard locally the same
way: `node ../scripts/e2e-shards.mjs list 2 4 shard.txt`, then `npx playwright test --test-list shard.txt` (in
`client/`). LiveKit (`.tools/livekit-server`) and the captions model are cached on their pins.

**Fewer jobs per push.** GitHub runs 20 jobs at once on this plan (40 on Pro); one push to main starts 17 (15 CI, counting the small `report to Iskra` job, + the
secrets scan; pushes skip macOS, CodeQL and Scorecard, which run on PRs, nightly or weekly). A newer push to the same
branch cancels the older CI run (`concurrency` in ci.yml), so a burst of pushes doesn't queue. Never cancelled: the
"Version X" commit's run (its own group: release finalize waits for CI to pass on exactly that commit; if one was
cancelled anyway, `gh run rerun <id>` it), tag runs, release, finalize, deploy and iOS workflows. Dependabot's branches
run CI as pull requests only.

| Symptom | Cause and fix |
|---|---|
| `release-windows.ps1` stops at "SimplySign isn't logged in", or the build log shows "No provider was specified", "SignTool Error" | SimplySign Desktop is logged out (it times out). Log in with the phone code, rerun. If it happened mid-build, rerun without `-SkipBuild` |
| sign.ps1 found no certificate in PowerShell 7 although it's installed | Fixed: `-CodeSigningCert` is missing when PSModulePath points at PowerShell 7's modules, so sign.ps1 filters on the code-signing EKU (1.3.6.1.5.5.7.3.3) itself. Keep that filter if you touch it |
| macOS: `security: SecKeychainItemImport` / codesign "errSecInternalComponent" / keychain won't unlock | Fixed in release.yml: we import the p12 into our own keychain and run `set-key-partition-list` (electron-builder's temporary keychain fails on current runners). Keep that step |
| Notarization failed or hangs | The electron-builder log shows the submission id. On a Mac with the .p8: `xcrun notarytool log <id> --key AuthKey.p8 --key-id <id> --issuer <issuer>` (or `notarytool history`) lists the rejected files. Common: an unsigned nested binary, missing hardened runtime, expired membership or agreement waiting in App Store Connect |
| Finalize: "no green CI run on …" / "CI concluded failure on this commit" | The CI gate: nothing was published. A flake: rerun CI's failed jobs (`gh run rerun <id> --failed`), then start finalize again (or `release-all.ps1 X -Resume`). "CI concluded cancelled": a newer push cancelled it (shouldn't happen to a "Version X" commit): `gh run rerun <id>`, then finalize again. A real failure: fix main and release the next version; never move the tag |
| release.yml publish: "latest-mac.yml: … doesn't match its build's update file" / "the parts …" | The two Mac jobs' update files don't fit their zips or each other. Rerun release.yml's failed jobs; if it repeats, report |
| Finalize: "missing (…)" | A build didn't upload. Check `release.yml`'s run for the tag, rerun it (`gh workflow run release.yml -f tag=vX`) or rerun release-windows.ps1 with `-SkipBuild` |
| Finalize: "latest.yml: … doesn't match" | A file was re-uploaded without the latest*.yml from the same build (or the other way round). Upload both from the same build |
| Checksums wrong after re-uploading assets | Rerun finalize with `deploy` off: it regenerates SHA256SUMS.txt and the attestations |
| Pages deploy fails | "Authentication error": token revoked/expired or wrong account id (section 4). "Project not found": project names in deploy.yml. The check step failing after a good deploy: Cloudflare cache; rerun |
| Server update fails | `iskra-update` rolled back to the previous version (the server keeps running). Log in with the admin key: `journalctl -u iskra -n 200`. Host key mismatch in CI: the droplet was rebuilt, refresh `DROPLET_KNOWN_HOSTS` |
| `release.yml`: "Check the tag matches the app version" fails | The tag was pushed without `npm run release`. Don't move the tag: delete the draft release, bump to the next version |
| Linux CI: audio/video device errors | Runners have no sound card or display. Electron tests run under `xvfb-run`; browser tests use Chromium's fake media devices. Don't add tests that need real devices |
| Windows Firewall prompts during tests | Something listened on all interfaces. Tests must be localhost-only (`LocalOnly: true`, `ISKRA_LOCAL_ONLY=1`); `scripts/dev-firewall.ps1` adds block rules for new exe paths |
| Secrets scan fails | gitleaks found something that looks like a secret (the log shows file, commit and rule, value redacted). A real one: revoke/rotate it at the service **first** (it's public the moment it's pushed), then remove it from the tree. A false positive: add its fingerprint (`commit:file:rule:line`, printed in the log) to `.gitleaksignore` with a comment why, or a path to `.gitleaks.toml` for test data |
| SBOM step fails in finalize | Usually npm or NuGet being unreachable, or a lock file out of step with package.json at the tag: rerun. Nothing is published before it passes |
| `scripts-and-drill` fails at the restore drill | A backup didn't restore to the same data: treat it as a real bug in Backups/ (the report artifact `restore-drill-report` says what differed) |
| CodeQL C# job fails to build | Needs .NET 10 (setup-dotnet in codeql.yml); same build as CI |
| iOS: "Cloud signing permission error" / "doesn't have permission to … cloud-managed distribution certificates" | The API key isn't Admin. New Admin key, replace the three `APPSTORE_*` secrets ([iOS app](#ios-app), mobile/README.md step 3) |
| iOS: "No profiles for 'foo.iskra.app'" / "No Account for Team" | The App ID isn't registered, or a developer agreement is pending (developer.apple.com and App Store Connect → Business). Owner fixes it, rerun |
| iOS archive fails on signing with `archive_signing=adhoc` | Rerun with `-f archive_signing=automatic`. If later runs then fail with "certificate … private key not installed", revoke the old "Created via API" development certificates |
| iOS upload: "bundle version must be higher" / "redundant binary upload" | That build number exists: rerun (the attempt number goes up). "No suitable application records" → the App Store Connect app record is missing |
| iOS upload: "SDK version issue" / "built with … SDK" | Apple wants a newer Xcode than the runner has; the workflow picks the newest installed. Wait for GitHub's image or switch `runs-on` to a newer macOS image |
| `outage` issue opened | See [section 8](#8-uptime-monitoring) and playbook J. The issue closes itself when the checks pass |
| Deploy `server`: "doesn't answer as X" | `/health` reports another version: `iskra-update` rolled back, or the build wasn't stamped with its version (prepare-server.mjs). `curl https://chat.iskra.foo/health` |
| build-android.ps1: "fingerprint isn't in assetlinks.json" | It found a different keystore. Never ship that APK: installed apps couldn't update. Point `ISKRA_ANDROID_KEYSTORE` at the real one |
| `STOP [phones]` from release-all.ps1 | The release is out; a phone part isn't. The line names it. TestFlight failed: the iOS rows here and the run's log. Play: the rows below. Then `release-all.ps1 X -Resume` |
| Play upload: "401" / "403 The caller does not have permission" | The service account isn't invited in Play Console, lacks the release permissions for Iskra, or was added less than ~24 h ago ([docs/store/README.md](store/README.md#google-play-service-account-for-the-uploads)) |
| Play upload: "Play has no track 'x'" | `android.track` in mobile/store.json doesn't match; the message lists the app's tracks (also `node scripts/play-upload.mjs --list-tracks`) |
| Play upload: "already has version code … from a different file" | That code was uploaded from another build. Rebuild with the next rebuild number (`build-android.ps1 -Rebuild 1`) and `-Resume` |
| Play upload: "Package not found" / "APK/AAB must be uploaded in Play Console first" | The app's first bundle goes through Play Console once (playbook L.4); after that the API works |
| Play release added as a **draft** | The app has never been published on any track; publish the first release in Play Console once |
| App Store Connect stopped: "couldn't process build … (INVALID)" | Apple rejected the binary (email to the account holder, TestFlight shows why). Fix and release again |
| App Store Connect: "no external TestFlight group with the public link …" | The group or its public link was removed or renamed: fix `ios.externalGroups` in mobile/store.json |
| App Store Connect: "already approved or on sale" | The App Store version (numeric part of the app version) is taken: the next release needs a higher version |
| App Store Connect warns "age rating not set through the API" | Apple renamed a questionnaire field: answer once from docs/store/appstore/age-rating.md, update age-rating.json |
| Beta App Review / App Review rejected for access | `REVIEW_INVITE_URL` doesn't work: was it revoked, or made with an expiry (an old 30-day invite)? Open Invite friends on Iskra Review, check **Active invites**, make a **Never** invite, `gh variable set REVIEW_INVITE_URL`, rerun |
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
- Agents never call the App Store Connect or Google Play APIs themselves and never open the Play key; the release
  scripts do it at release time. Tests use fake APIs only.
- Needs the human: the SimplySign phone code, the Apple developer portal and App Store Connect (app record, TestFlight testers, API keys), the Play Console,
  the Cloudflare dashboard (new tokens), DigitalOcean, approving `release` environment runs, anything that costs money.

## 8. Uptime monitoring

`.github/workflows/uptime.yml` runs `scripts/uptime-check.sh` every 15 minutes (at :04, :19, :34, :49; GitHub may
delay scheduled runs by a few minutes) and on demand (`gh workflow run uptime.yml`). It uses only the automatic
`GITHUB_TOKEN` (`contents: read`, `issues: write`); no secrets, and the checkout action is pinned by SHA.

| Check | Fails when |
|---|---|
| `https://iskra.foo`, `https://app.iskra.foo` | Not HTTP 2xx within 20 s |
| `https://chat.iskra.foo/` | The answer isn't Iskra's `{"iskra":1,...}` |
| `https://chat.iskra.foo/health` | Not 200, or `"voice":"down"` (LiveKit isn't running). A 404 (a version without `/health`) passes |
| `chat.iskra.foo:7881/tcp` | Can't open a TCP connection (voice over TCP; UDP 7882 can't be checked this way) |
| TLS certificates of all three | Expire in under 14 days, or can't be read |

Each check gets 3 tries, 20 s apart, so a blip isn't an outage. The run's summary shows a table of every check.

**Alerts.** A failing check opens one issue labelled `outage` (the label is created if missing), titled after the first
failure and **assigned to the repo owner**, so GitHub emails them (Settings → Notifications → "Assigned" / email must
stay on). While it stays open the workflow only edits it and comments when the *set* of failing checks changes (not when
details like "9 days left" do), and it closes the issue with a comment when everything passes again. The run itself
stays green when it found an outage (the issue is the alert; a red run would send a second email). A red run means the
check itself broke (e.g. GitHub's API), which CI failure emails cover.

**Changing it:** hosts and thresholds are environment variables at the top of the script (`SITE`, `APP`, `CHAT`,
`VOICE_PORT`, `CERT_WARN_DAYS`, `TRIES`, `PAUSE`). Try it locally without touching issues:
`DRY_RUN=1 TRIES=1 bash scripts/uptime-check.sh`. There's no public status page; the open `outage` issue is the
status (the repo is public, so keep issue text to what the checks say).

## 9. CI results in Iskra

Optional: CI and release results as messages in an Iskra channel, through an incoming webhook
(`scripts/ci-notify.mjs`, tested by the root `npm test`).

- **ci.yml**, job `report to Iskra`: after the test jobs, for runs on **main** only (pushes, nightly, by hand; never
  pull requests or other branches, and not for a run a newer push cancelled). Message: "CI passed on main" or "CI failed
  on main", the short commit, the failed jobs' names, and the run's link.
- **release-finalize.yml**, job `report to Iskra`: "Release vX published and deployed" or "Release vX: failed" with the
  tag's commit, the failed jobs and the run's link.
- Only when the secret `ISKRA_CI_WEBHOOK` is set; otherwise the job ends in a second without checking anything out.
  Nothing else is sent (no logs, no commit messages). A failed post is a warning, never a red run, and the URL is never
  printed. The URL must be `https://…/hooks/<id>/<secret>` (HTTPS, an Iskra webhook).

**Set it up (once):** in Iskra, on the server and channel that should get the results (e.g. chat.iskra.foo, a private
`#ci` channel): Server settings → **Bots and webhooks → Webhooks → New webhook**, name `CI`, "Posts in" that channel → **Create webhook** → copy the URL (it is shown once).
Then `gh secret set ISKRA_CI_WEBHOOK` and paste it at the prompt. To stop: `gh secret delete ISKRA_CI_WEBHOOK` (or delete
the webhook in Iskra; posts then fail quietly). Regenerate the webhook's secret in Iskra if the URL ever leaks, then set
the secret again.
