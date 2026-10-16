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
 nightly / by hand ──► e2e-stress.yml .. the e2e suite 3 times over on the 4 shards; flaky tests reported, not red
 every push / PR / weekly ──► secrets.yml .. gitleaks over the whole git history
 PR / weekly / by hand ──► codeql.yml ... code scanning: JS/TS, C#, workflows
 PR / weekly / by hand ──► scorecard.yml ..... OpenSSF Scorecard → code scanning + scorecard.dev (the weekly run publishes)
 weekly ──► Dependabot ............ grouped PRs for npm (client, desktop, bots), NuGet (server), GitHub Actions
 every 15 min ──► uptime.yml ....... iskra.foo, app.iskra.foo, chat.iskra.foo (+ /health), voice port, TLS expiry
                                     ──► GitHub issue labelled "outage" on a change of state (section 8)
 daily ──► renewals.yml ............ everything that expires (docs/renewals.json) ──► #renewals channel (section 5)

 THE RELEASE BUTTON: GitHub → Actions → Release → Run workflow (github.com or GitHub Mobile), or
 scripts/release.ps1 -GitHub. Needs only the home PC switched on (section 2a). release-all.yml:
 ⓪ checks (ubuntu: release-preflight.mjs release) + home PC checks (SimplySign test signature, logging itself in once;
    build tools; Android keystore; Play key) ── any red: the run stops, nothing changed. PC off for 10 min: run cancelled
 ① version commit + tag (GITHUB_TOKEN push), draft release
 ② ci.yml called on that commit │ release.yml called (Linux, macOS) │ Windows on the home PC (release-windows.ps1)
 ③ release-finalize.yml called (gate: this run's CI jobs) → publish → deploy.yml (site, webapp, server)
 ④ phones: mobile-ios.yml dispatched and followed; Google Play (workload identity, or the home PC's key) ⑤ report

 THE LOCAL WAY: scripts/release.ps1 on this Windows PC (SimplySign Desktop logged in, or a stored seed). Check phase
 first (every check, all reds at once, nothing changed), then "ALL CHECKS GREEN - SENDING" and the steps below without
 prompts or approvals.
 RELEASE = scripts/release.ps1 [X] (default X: the next alpha after the latest release)
 ⓪ check phase ....................... SimplySign test signature first, then git/main/CI, version, notes, links.ts/site,
                                        file list, build tools, Android prerequisites, Play key, mobile/store.json,
                                        GitHub secrets/variables (names only), environments without reviewers
 ① release-notes.mjs + release-version.mjs  notes from docs/releases/NEXT.md into docs/releases/X.md; bump version in
                                    desktop/package.json(+lock), client/src/links.ts, site/index.html; commit "Version X"; tag vX
 ② git push --atomic origin main vX, then the DRAFT release vX (no waiting for CI: CI on main and the builds run side by side)
        ├─► ci.yml (on main) ............. the tests; finalize refuses to publish until this run is green
        ├─► release.yml (on the tag) ...... Linux AppImage/deb/rpm, macOS dmg/zip (x64 and arm64 in parallel jobs,
        │                                   each signed + notarized), server tarballs, CycloneDX SBOMs (its own job):
        │                                   each job attaches its own files to the draft, with attestations
        │                                   (.github/actions/release-attach); latest-mac.yml merged and attached last;
        │                                   the built web app kept as the artifact `webapp` for the deploy
        └─► mobile-ios.yml (on the tag) ... the iPhone app built and cloud-signed (job `build`); the .ipa and its
                                            numbers kept as the artifact iskra-ios-vX (nothing uploaded from a push run)
 ③ scripts/release-windows.ps1 X
        ├─ npm run dist ................... signed Setup + Portable exe, latest.yml, signed iskra-server.exe
        ├─ server zip, build-android.ps1 .. iskra-server-X-win-x64.zip, Iskra-X.apk + .aab (mobile/, signed locally)
        └─ gh release upload ............... onto the draft
 ④ waits for release.yml and all 26 files, then starts
        └─► release-finalize.yml (workflow_dispatch, environment "release", no reviewers)
              ├─ publish: CI gate (ci.yml green on the tagged commit, waits up to 45 min), check files +
              │           latest*.yml hashes, SHA256SUMS.txt, attestations, publish as Latest (not prerelease)
              │           with docs/releases/X.md
              ├─► deploy.yml (reusable, environment "release"), side by side with the TestFlight upload below
              │     ├─ site ....... wrangler → Pages iskra-hero-page → https://iskra.foo  (checks the new links and every page)
              │     ├─ webapp ..... the `webapp` artifact of the tag's release.yml run (else a client build) → Pages
              │     │              iskra-webclient → https://app.iskra.foo (checks the new index asset)
              │     └─ server ..... ssh root@DROPLET_HOST X → iskra-update X → https://chat.iskra.foo (checks it answers)
              ├─ TestFlight upload: the iskra-ios-vX artifact of the tag's mobile-ios.yml run → App Store Connect
              │           (.github/actions/testflight-upload). release.ps1 waits for publish, the deploys and this
              └─ TestFlight groups and reviews (.github/actions/appstore-connect, scripts/appstore.mjs): Apple's
                          processing (5-60 min), What to test, TestFlight groups, Beta App Review (phase B: + App Store
                          version, listing, screenshots, App Review, automatic release). release.ps1 doesn't wait for it
 ⑤ phones (where mobile/store.json says; docs/store/README.md)
        └─ scripts/play-upload.mjs X ......... the AAB from ③ → Google Play track (phase A: closed testing "alpha";
                                                phase B: production + listing), release notes en-US/sv-SE
 ⑥ final checks (+ "TestFlight upload ok" from finalize's run); a phone problem ends with STOP [phones] (-Resume
    retries Play; -Phones builds and uploads the iPhone app again: mobile-ios.yml with upload on, as before)

 REDEPLOY: scripts/release.ps1 -Redeploy site|webapp|server|checksums ──► deploy.yml / release-finalize.yml (deploy off)
 PHONES ONLY: scripts/release.ps1 -Phones ──► ⑤ for the latest release
 BOT SDK: scripts/release.ps1 -BotSdk [X] ──► tag bots-sdk-vX ──► bots-sdk.yml ──► npm "iskra-bots" X with provenance
 RESULTS: ci.yml (main) and release-finalize.yml post pass/fail to an Iskra channel when ISKRA_CI_WEBHOOK is set (section 9)
```

**Steps.** Only the Release button (`release-all.yml`) and `scripts/release.ps1` are started by a person or an agent.
Everything below ships something only as a step of them (each file's header says so); none of them is run by hand to ship.

| Step | Called by | What it does |
|---|---|---|
| `.github/workflows/release-all.yml` ("Release") | The owner (Run workflow), `release.ps1 -GitHub` | The whole release on GitHub ([2a](#2a-the-release-button)) |
| `scripts/release-checks.psm1` | release.ps1, release-windows.ps1, release-pc-checks.ps1 | SimplySign's test signature (certificate in the store, a signed scratch file), `Confirm-Signing` (the test signature with a time limit, filling SimplySign's login dialog if it shows, then the automatic login once), the Android build prerequisites (presence only). Tests: `release-checks.test.mjs` (fake certificates, signer, login and dialog; a signer that never finishes) |
| `scripts/release-pc-checks.ps1` | release-all.yml (home PC checks) | The checks only the home PC can answer, before anything changes |
| `scripts/simplysign.psm1`, `simplysign-login.ps1` | Confirm-Signing, release-windows.ps1 (build watcher) | SimplySign logging itself in, also when its login dialog pops up mid-signature ([SimplySign auto-login](#simplysign-auto-login)). Tests: `simplysign.test.mjs` (RFC 6238 vectors, DPAPI round trip, the attempt ledger, the dialog fill and the watcher with fake dialogs) |
| `scripts/release-preflight.mjs` | release.ps1 (check phase), release-all.yml (`release` subcommand) | The next version, `mobile/store.json` validity, the GitHub secret and variable names the release needs, environments with reviewers; on GitHub also the version, notes, links/site, file list and CI on main. Tests: `release-preflight.test.mjs` |
| `scripts/ci-gate.mjs` | release.ps1 (check phase), release-preflight.mjs, release-finalize.yml | Exits 0 only when a push run of ci.yml concluded success on the given commit (waits up to `--wait-minutes`); `--run <id>`: the Release run's own `ci / …` jobs passed. Tests: `ci-gate.test.mjs` |
| `scripts/release-notes.mjs` | release.ps1 ① | Writes docs/releases/X.md from docs/releases/NEXT.md (headline, sections, "Get started" from the previous notes) and empties NEXT.md; refuses lines that already shipped. `--dry-run` in the check phase |
| `scripts/release-version.mjs` | release.ps1 ① | Version bump in desktop/package.json(+lock), links.ts, site/index.html; commit "Version X"; tag vX. `--dry-run` in the check phase |
| `scripts/release-lib.mjs` | the .mjs steps, release-finalize.yml | Version checks, version replacement, asset list, latest.yml parsing and merging, notes from NEXT.md, the CI verdict (`release-lib.test.mjs`) |
| `scripts/release-assets.json`, `release-assets.mjs` | release.ps1, release-windows.ps1, release.yml, release-finalize.yml | The files every release must have; `list`, `names`, `check` (files + latest*.yml sha512), `sums` (SHA256SUMS.txt), `merge-yml` |
| `scripts/release-windows.ps1` | release.ps1 ③ | Test signature, `npm run dist`, signature checks, server zip, Android APK + AAB, upload, size check |
| `desktop/scripts/prepare-server.mjs`, `build-sidecar.mjs`, `sign.ps1` | `npm run dist*` (③), release.yml | Self-contained server + LiveKit into the package; `iskra-p2p` (the standalone server's tunnel as one Node executable, + licenses; not in the desktop app, which runs the tunnel itself); Certum signing of the server exes (fails instead of skipping when `ISKRA_REQUIRE_SIGNING=1`, which release-windows.ps1 sets) |
| `mobile/scripts/build-android.ps1`, `scripts/mobile-version.mjs` | release-windows.ps1 (③), mobile-ios.yml | Signed Android APK + AAB from the Capacitor shell ([Android](#android)); the phone app's version and build numbers |
| `scripts/play-upload.mjs` | release.ps1 ⑤ | The AAB to Google Play (track, notes, listing, data safety); `--check` (key presence) in the check phase. Tests against a fake API |
| `scripts/appstore.mjs` | release-finalize.yml (job "TestFlight groups and reviews") and mobile-ios.yml (`-Phones`), through `.github/actions/appstore-connect` | App Store Connect after each iOS upload: processing, What to test, TestFlight groups, Beta App Review; phase B the App Store version, listing, screenshots, App Review. Tests against a fake API |
| `.github/workflows/release.yml` ("Release builds") | the `v*` tag pushed by release.ps1 ②; called by release-all.yml | Linux and macOS builds, server tarballs (each with `iskra-p2p`; the linux-arm64 one is cross-built, checked with `readelf`, then run on an `ubuntu-24.04-arm` runner before it is attached), the CycloneDX SBOMs (job `sbom`); each job attaches its own files to the draft release as soon as it has checked them (`.github/actions/release-attach`); `publish` merges and attaches latest-mac.yml; the linux job keeps the built web app as the artifact `webapp` |
| `.github/actions/release-attach`, `testflight-upload`, `appstore-connect` | release.yml; release-finalize.yml and mobile-ios.yml | The steps several workflows share, one copy each: attach files to the tag's release (the draft if nothing made it yet, build-provenance attestations, `gh release upload --clobber`, each file's size checked); upload a built `.ipa` (with its `ios-build.env`) to App Store Connect (`xcrun altool --upload-app` with the API key, on a macOS runner); run `scripts/appstore.mjs` after an upload |
| `.github/workflows/release-finalize.yml` | release.ps1 ④, `-Redeploy checksums`; called by release-all.yml | CI gate, publish, then side by side the deploys (deploy.yml) and the TestFlight upload of the tag's iPhone build; after the upload, TestFlight groups and reviews. Inputs `deploy` and `testflight` (both off for a checksums rerun) |
| `scripts/runner-setup.ps1`, `runner-job-guard.ps1` | The owner, once | The home PC as the release runner, and the guard it runs before every job ([The home PC runner](#the-home-pc-runner)). Tests: `runner.test.mjs`, `workflows.test.mjs` (also actionlint) |
| `.github/workflows/deploy.yml` | release-finalize.yml, `release.ps1 -Redeploy site/webapp/server` | Site, web app and server deploys with checks; for a tag, the web app is release.yml's `webapp` artifact (built from source when there is none) |
| `.github/workflows/mobile-ios.yml` | the `v*` tag pushed by release.ps1 ② (build only); release.ps1 `-Phones` (build, upload, store steps) | iPhone/iPad app: `build` (build, cloud-sign, check; the `.ipa` as the artifact `iskra-ios-<ref>`, 14 days) on every tag push and dispatch; `upload` and `groups` only with workflow_dispatch and upload on ([iOS app](#ios-app)); by hand only for a test build without upload |
| `.github/workflows/bots-sdk.yml` | the `bots-sdk-v*` tag pushed by `release.ps1 -BotSdk` | The bot SDK on npm as `iskra-bots` ([npm](#npm-bot-sdk)) |

Other files of the pipeline:

| File | What it does |
|---|---|
| `package.json` (repo root) | `npm test`: the release-script tests (`scripts/*.test.mjs`, run in CI) |
| `mobile/store.json` | Where the phone apps go each release: iOS mode (testflight, appstore, upload), TestFlight groups, Play track, rollout, listing ([docs/store/README.md](store/README.md)) |
| `docs/releases/<version>.md`, `NEXT.md` | Release notes (become the GitHub release text); NEXT.md collects them between releases |
| `.github/workflows/marketplace.yml` | Lints the DigitalOcean Marketplace image (`marketplace/digitalocean/`) on changes. By hand (Run workflow, no approval) it builds the image and tests it end to end on a temporary $6 droplet (`test.sh`: HTTPS, claim screen, ufw, a claim with the app's code, voice), always deletes that droplet, and keeps the snapshot; jobs in the `marketplace` environment (secret `DO_MARKETPLACE_TOKEN`). It ships no Iskra release. Steps: `marketplace/digitalocean/README.md` |
| `.github/workflows/ci.yml`, `codeql.yml`, `.github/dependabot.yml` | Tests (including the backup-restore drill), code scanning, dependency updates |
| `.github/workflows/secrets.yml`, `.gitleaks.toml`, `.gitleaksignore` | Secret scan of the whole history ([below](#secret-scanning-and-security-settings)) |
| `.github/workflows/scorecard.yml` | OpenSSF Scorecard (supply-chain checks), results in the Security tab |
| `SECURITY.md`, `site/.well-known/security.txt`, `client/public/.well-known/security.txt` | Vulnerability disclosure policy and the RFC 9116 contact files on iskra.foo and app.iskra.foo |
| `scripts/ci-notify.mjs` | CI and release results to an Iskra channel ([section 9](#9-ci-results-in-iskra)) |
| `docs/store/` | Store texts, forms and graphics: `play/` (Google Play), `appstore/` (App Store), `README.md` (phases and the owner's one-time steps) |
| `.github/workflows/uptime.yml`, `scripts/uptime-check.sh` | Uptime checks and outage issues ([section 8](#8-uptime-monitoring)) |
| `docs/renewals.json`, `.github/workflows/renewals.yml`, `scripts/renewals.mjs` | Everything that expires, and daily warnings to the #renewals channel ([Renewal warnings](#renewal-warnings)) |
| `server/deploy/iskra-update-guard` | Shipped in the Linux server tarball (release.yml): undoes a server self-update that doesn't start (docs/hosting.md) |

Supply chain: every action is pinned to a full commit SHA with the version as a comment (Dependabot keeps them
current); every workflow starts with minimal `permissions:` and widens them per job; wrangler is pinned
(`WRANGLER` in deploy.yml). Releases carry build-provenance attestations: `gh attestation verify <file> -R quikmn/iskra-voice`.
Each release also carries CycloneDX 1.6 SBOMs, made by release.yml's `sbom` job (beside the builds) from the tag's lock
files and project: `iskra-sbom-web-X.cdx.json` (web app, runtime npm packages), `iskra-sbom-desktop-X.cdx.json` (desktop
shell's runtime npm packages; the web app inside it is the web SBOM) and `iskra-sbom-server-X.cdx.json` (server NuGet
packages). They're in SHA256SUMS.txt and attested like every other file (by the sbom job and again by finalize). Tools are
pinned in the job (`@cyclonedx/cyclonedx-npm`, the `CycloneDX` dotnet tool). Check one with
`gh attestation verify iskra-sbom-server-X.cdx.json -R quikmn/iskra-voice`, or feed it to a scanner
(`grype sbom:iskra-sbom-server-X.cdx.json`). They're the `sbom` group of `release-assets.json`: finalize's file check
refuses to publish without them (rerun release.yml's `sbom` job when they're missing); release-windows.ps1 waits only for
its own groups.
For Linux/macOS files and the SBOMs they come from the build workflow; for Windows and Android files (built locally) they only
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

Two ways, the same checks and the same result: the **Release button** on GitHub ([2a](#2a-the-release-button), the
usual one: from anywhere, the home PC only has to be on), or `scripts/release.ps1` on the Windows PC (below; the
local alternative, and what `-Resume` picks up).

### 2a. The Release button

GitHub → quikmn/iskra-voice → **Actions → Release → Run workflow** (in GitHub Mobile: the repo → Actions → Release →
Run workflow), on `main`. Inputs: `version` (empty: the next alpha after the latest release), `phones` (TestFlight and
Google Play, on by default), `check_only` (only the checks). From a PC: `.\scripts\release.ps1 -GitHub [<version>]
[-CheckOnly] [-SkipPhones]` presses it and follows the run (it first checks the home PC runner is online and the fork
approval setting). Only the repo owner can start it, only from main; one release at a time (a second press waits).

What it needs: the release notes in `docs/releases/NEXT.md` on main (editable in GitHub's web editor), and the **home
PC switched on and logged in to Windows** (the runner starts at logon; a locked screen is fine, sleep isn't). SimplySign
needs nothing when a seed is stored ([SimplySign auto-login](#simplysign-auto-login)); without one, log in to
SimplySign Desktop on the PC before pressing the button, as before.

Jobs (`release-all.yml`), in order; everything that changes something comes after every check:

| Job | Runs on | What it does |
|---|---|---|
| `checks` | GitHub (ubuntu), environment `release` | `release-preflight.mjs release`: workflows active, version (tag and release unused, newer), notes ready, links.ts/site, file list, mobile/store.json, the secret names (set or not; never values) and variables, CI green on main's head (waits up to 30 min). Reds go to the run summary, one per line with its case |
| `pc-checks` | home PC | `release-pc-checks.ps1`: SimplySign test signature (logs itself in once if needed), git/node/npm/gh/dotnet, 10 GB free, Android JDK/SDK/keystore (presence), the Play key file when there's no workload identity |
| `pc-online` | GitHub | If the home PC hasn't picked up `pc-checks` within 10 minutes, it cancels the run: "switch it on and log in". Nothing changed |
| `version` | GitHub | Main is still where the checks were; `release-notes.mjs`, `release-version.mjs` (commit "Version X" as the owner, tag vX); `git push --atomic` with the job's token; creates the draft release |
| `ci` | GitHub | `ci.yml` called on the version commit (a GITHUB_TOKEN push starts no workflows, so this workflow runs CI itself) |
| `builds` | GitHub | `release.yml` called: Linux, Mac x64/arm64 (an ad-hoc signed Mac build fails here), the SBOMs; each job attaches its files to the draft |
| `windows` | home PC | `release-windows.ps1`: signed Windows apps, server zip, Android APK + AAB with the release key; uploads; keeps the AAB as an artifact (7 days) |
| `finalize` | GitHub, environment `release` | `release-finalize.yml` called with `testflight: false`: the CI gate reads this run's `ci / …` jobs (`ci-gate.mjs --run`), then checks, sums, attestations (signed by `release-finalize.yml@refs/heads/main`, which servers accept), publish, deploys |
| `ios` | GitHub | Dispatches `mobile-ios.yml` (ref vX, upload) as its own run (build, upload, store steps), so its build numbers keep counting as before, and follows it; a run for the tag that succeeded or still runs is reused. (This run's tag push is made with `GITHUB_TOKEN`, which starts no mobile-ios.yml build for finalize's TestFlight job to upload, so the button path keeps the dispatch) |
| `play` / `play-pc` | GitHub with workload identity / else the home PC with its key file | `play-upload.mjs` with the AAB artifact |
| `report` | GitHub | A table of every job in the run summary; the result to Iskra when `ISKRA_CI_WEBHOOK` is set |

A failed job after the tag: fix the cause, then **Re-run failed jobs** on the same run (each step looks before it
acts: a published release isn't published again, a TestFlight run for the tag is reused, a version already on the Play
track is left alone). `scripts/release.ps1 -Resume` on the PC works too (it reads the tag, not the run).

**Not on GitHub's runners (yet):** Windows signing (Certum allows no CI seed; RELEASE_ANYWHERE design note), so the home
PC does it. The Android build moves to GitHub once the Play upload key is reset ([Android built on
GitHub](#android-built-on-github-prepared)).

### 2b. The local way: scripts/release.ps1

**One command:** `.\scripts\release.ps1` (or `.\scripts\release.ps1 <version>`; without one it takes the next alpha
after the latest release) on the Windows PC, from `main` at origin/main, with SimplySign Desktop logged in (or a seed
stored: it logs itself in once). Nothing asks for anything after it starts: no prompts, no approvals in GitHub, no phone.

**Phase 1, checks (nothing changes).** In this order:

1. **SimplySign first**: the certificate is in the store and not expired, and a test signature on a scratch file works
   (with Certum's timestamp). Not logged in and a seed stored: it logs itself in once and signs again. Still not
   logged in: it stops at once with one line, *Log in to SimplySign Desktop (6-digit code from the app), then run
   scripts/release.ps1 again.* (An expiry within 30 days is a warning.)
2. git, gh, node, npm on PATH; gh logged in; GitHub reachable (these stop at once too).
3. Then everything else, every red collected: the workflows `ci`, `release`, `release-finalize`, `deploy`
   (`mobile-ios` too unless `-SkipPhones`) are active; on `main`, clean (only the notes files may be uncommitted), exactly
   at origin/main, and `git push --dry-run` works without asking; the tag and a release of that name don't exist; the
   version is newer than desktop/package.json's; the release notes are ready (`release-notes.mjs --dry-run`);
   desktop/package.json, links.ts and site/index.html (at least 20 links) carry the same current version
   (`release-version.mjs --dry-run`); the file list (release-assets.json) is complete; dotnet, `.tools\livekit-server.exe`
   and 10 GB of free disk for the Windows build; the Android JDK 21, SDK + build-tools and the release keystore and its
   password file (presence only, never read); the Play service-account key (presence only); mobile/store.json valid; the
   GitHub secrets and variables the workflows need (names only: `gh secret list`, `gh variable list`, also the `release`
   environment's), `REVIEW_INVITE_URL` when `ios.mode` is `appstore`; a warning for an environment that still has required
   reviewers, with the setting to change.
4. Last, CI: a push run of ci.yml must have passed on HEAD (or on the newest commit before it that isn't docs/site-only,
   since CI skips those); while it runs the check waits up to `-CiWaitMinutes` (30).

Any red: it lists all of them (`N thing(s) to fix ... (nothing was changed or sent)`) and ends. Fix, run it again.
`-CheckOnly` (alias `-DryRun`) stops here either way.

**Phase 2, sending.** All green prints `ALL CHECKS GREEN - SENDING` and runs, without a prompt:

1. **Notes.** `scripts/release-notes.mjs` turns `docs/releases/NEXT.md` (bullets under `### What's new`, `### Fixes`,
   `### Good to know`; each change one line) into `docs/releases/<version>.md`: the headline, the non-empty sections and
   `### Get started` from the previous notes with the new version; NEXT.md goes back to empty sections. It refuses
   lines that already shipped in the previous notes and breaks of the public wording rules ("Iskra 2", "rebuilt", v1).
   A hand-written `docs/releases/<version>.md` ([format](releases/README.md)) wins: NEXT.md is then left alone.
2. **Bump and tag.** `scripts/release-version.mjs`: one commit "Version X" (with the notes and NEXT.md) and an annotated
   tag vX.
3. **Push.** `git push --atomic origin main vX`, then the draft release vX (`gh release create --draft --prerelease`),
   so every build that follows uploads straight to it. Nothing waits for CI here: CI runs on main while `release.yml`
   builds from the tag (Linux, Mac x64 and Mac arm64 and the SBOMs in parallel jobs, each attaching its files the
   moment it has checked them) and `mobile-ios.yml` builds the iPhone app from the tag (the `.ipa` kept as the artifact
   `iskra-ios-vX`). CI doesn't run on tags (`branches: ['**']`): the tag's commit is main's, tested once.
4. **Windows + Android.** `scripts/release-windows.ps1 X`. It test-signs a scratch file again, builds (`sign.ps1` fails
   instead of leaving a file unsigned), checks every signature (valid, right publisher, timestamped), builds the server
   zip, APK and AAB, prints SHA256s, uploads and checks sizes on GitHub. SimplySign asking to log in mid-build (its
   2-hour session ended): a watcher fills the dialog with the stored seed and the build goes on. SimplySign logged out
   outright: with a stored seed (and the ledger allowing it) it logs in and builds once more; otherwise it ends with
   `STOP [SimplySign] Log in ..., then run scripts/release.ps1 -Resume`.
5. **Finalize.** release.ps1 waits for `release.yml` (and checks both Macs were notarized), checks all 26 files are there
   and starts `release-finalize.yml`. The `release` environment has no required reviewers, so nothing waits for a click:
   the automatic gate is its first step, the **CI gate**: `scripts/ci-gate.mjs` waits (up to 45 min) for a push run of
   `ci.yml` on exactly the tagged commit and fails, before anything is uploaded or published, unless one concluded
   success. Then the checks, sums, attestations and publishing, and side by side the deploys and the **TestFlight
   upload** (job "TestFlight upload": the `iskra-ios-vX` artifact of the tag's mobile-ios.yml run, found with `gh run
   list --branch vX --event push`, to App Store Connect through `.github/actions/testflight-upload`). release.ps1 asks
   every 15 s and goes on as soon as publish, the deploys and the upload are done; the job "TestFlight groups and
   reviews" (`scripts/appstore.mjs`: Apple's processing, up to an hour) finishes on its own and reports to the Iskra
   channel like any finalize job. Its checks are the verification: iskra.foo links to vX, app.iskra.foo serves the new
   bundle (the deploy reuses the `webapp` artifact release.yml built), chat.iskra.foo answers, GitHub's Latest is vX.
6. **Phones.** release.ps1 uploads `mobile\release\Iskra-X.aab` with `scripts/play-upload.mjs`; the iPhone app was
   uploaded by finalize (above). Where they go is `mobile/store.json` (phase A: TestFlight internal and external groups +
   Beta App Review, Play's closed testing track; phase B: the App Store and Play production;
   [docs/store/README.md](store/README.md)). A phone problem doesn't stop the final checks; the run then ends with
   `STOP [phones]`: a Play problem is retried by `-Resume`; a TestFlight upload that failed or didn't happen (no build run
   for the tag, an older finalize) is redone by `-Phones`, which builds and uploads the iPhone app in one `mobile-ios.yml`
   run with upload on (its run is titled "Mobile iOS vX (TestFlight)", so a second `-Phones` finds it instead of building
   twice). `-SkipPhones` leaves the stores alone (finalize runs with `testflight` off), `-PlayTrack <track>` overrides the
   track once.
7. **Final checks**: Latest, every file and SHA256SUMS.txt, iskra.foo links, app.iskra.foo's bundle has the version,
   chat.iskra.foo/health reports it, "TestFlight upload ok" from finalize's run. Then the report lines (Task, Result,
   Release, Runs, Checks, Phones).

A problem after the banner prints one `STOP [case] what to do` line (the playbook's decision table). Once the tag is
pushed, `.\scripts\release.ps1 -Resume` (on the tag commit) checks again and picks up where it stopped.

**What can still fail after the tag is pushed** (it can't be checked before without building or publishing): the
Linux/macOS builds and notarization (Apple's side: agreements, membership), the SBOM job (npm or NuGet unreachable), the
iPhone build on the tag and its upload in finalize (fallback `-Phones`), the Windows build itself and SimplySign
timing out during it, the Android build, uploads to GitHub, CI on the "Version X" commit (only versions, notes and links
change; the gate in finalize catches it), Cloudflare tokens and the droplet's SSH during the deploys, the App Store
Connect and Play APIs (permissions, Apple's processing, review). Each ends with a STOP line and `-Resume` (or `-Phones`);
nothing is published before finalize's CI gate passes.

The user's own server updates through finalize. Other standalone servers look for new releases themselves (owner
setting, Settings → Updates: off / tell me / install automatically on Linux with systemd; docs/hosting.md "Updating").
They read the same release: the `iskra-server-<v>-<rid>` package, `SHA256SUMS.txt`, GitHub's asset digests and the
attestations, so every release needs SHA256SUMS.txt (finalize makes it) and the Linux tarball needs
`iskra-update-guard` (release.yml adds it). Servers report their version at `/health`; release builds get it from
`prepare-server.mjs` (`-p:Version=` from desktop/package.json), anything else says `0.0.0-dev` and never updates.

Installed desktop apps (Windows installer, AppImage, signed Mac) check about 15 s after start, every hour, and when the
window comes back after 15 minutes (tray → "Check for updates" any time). They pick the newest **published** release
from the GitHub releases API and let electron-updater read that release's `latest*.yml`. They don't use the
`releases.atom` feed: it also lists tags whose release is still a draft (a release finalize refused), and a draft has no
`latest.yml`, so every check would fail until a newer release is out. Each app keeps a few KB of its latest checks in
`logs/updates.log` in its data folder (Windows: `%APPDATA%\iskra-desktop\logs\updates.log`; macOS:
`~/Library/Application Support/iskra-desktop/logs`; Linux: `~/.config/iskra-desktop/logs`): start, each check and what
it found, downloads and errors (no links with tokens). The downloaded installer waits in
`%LOCALAPPDATA%\iskra-desktop-updater\pending` on Windows; a leftover one there is harmless.

## 3. Deploying without a release

`.\scripts\release.ps1 -Redeploy site` (iskra.foo from main; `-Ref <tag or branch>`), `-Redeploy webapp` (app.iskra.foo
from the latest release tag; `-Ref main`), `-Redeploy server [<version>]` (chat.iskra.foo to the latest or that published
release) and `-Redeploy checksums [<version>]` (finalize again without deploying, after files were replaced). Each checks
first (the workflow is active, the ref exists on GitHub, site commits are pushed, the release is published with
SHA256SUMS.txt), then starts `deploy.yml` (or `release-finalize.yml`) with these inputs and waits for it:

| Input | Effect |
|---|---|
| `ref` | Tag or branch the site and web app are built from (`main` for a site text fix, the release tag to redeploy a release) |
| `site` | iskra.foo from `site/`: every `*.html` page (index, terms, privacy, support, delete-account), `*.css` (site.css, fonts.css), the `fonts/` folder (self-hosted Inter and JetBrains Mono), `.well-known/` (security.txt), worker.js and .assetsignore; never wrangler.toml or .wrangler/. Pages serves `terms.html` at `/terms` (and redirects `/terms.html` there). Fails if index.html doesn't link to the version in desktop/package.json at that ref, or if a page isn't served at `https://iskra.foo/<page>` afterwards (checked by its `<link rel="canonical">`, so every new page needs one), or `/.well-known/security.txt` isn't |
| `webapp` | Builds `client/` and deploys `client/dist` to app.iskra.foo (branch main = production), then checks the new bundle and `/.well-known/security.txt` |
| `server_version` | Runs `iskra-update <version>` on the droplet. The version must be a published release (it downloads from GitHub and checks SHA256SUMS.txt) |

Local fallback, only with the human and only when GitHub Actions can't run: `site/` with the `iskra-deploy-cf` token through `D:\Development_Projects\IskraHeroPage\deploy-hero.ps1`
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
| Used by | `npm run dist` (electron-builder `win.signtoolOptions`, certificate looked up by subject in CurrentUser\My), `desktop/scripts/sign.ps1` (server exe), `scripts/release-checks.psm1` (test signature before a release) |
| Login | Automatic when the TOTP seed is stored on the home PC ([SimplySign auto-login](#simplysign-auto-login)); otherwise SimplySign Desktop → log in with the 6-digit code from the SimplySign phone app before a release. The session times out after a while |
| Lost/expired | No signed Windows builds. Already-signed releases stay valid (they're timestamped) |

**Renewal** (start a month early): order the renewal in the Certum shop with the same identity, verify as Certum
asks, activate it in SimplySign. Check the new certificate's subject. The apps refuse an update whose signer
doesn't match `publisherName` in `desktop/package.json` (electron-updater checks it). It already lists two names:
today's CN `Open Source Developer Viktor Lundgren` and the distinguished name `CN=Viktor Lundgren, C=SE` (a future
certificate in the owner's own name, e.g. Certum Standard or SSL.com IV; as a DN both CN and country must match), so
every install that updated since it was added accepts either. Then:
- same CN, or `CN=Viktor Lundgren` in Sweden: nothing else to change in the updater;
- any other subject: first ship a release whose `publisherName` also lists the new one, signed with the old
  certificate, then switch. Otherwise installed apps stop auto-updating and people must reinstall by hand.
Either way update `certificateSubjectName`, `sign.ps1` and `$script:Subject` in scripts/release-checks.psm1 when the CN
changes (the test in release-checks.test.mjs keeps `publisherName[0]` equal to the signing subject).

#### SimplySign auto-login

On the home PC, releases log SimplySign Desktop in by themselves, so nobody types the phone code.

- **The seed**: the TOTP seed of the SimplySign account (the otpauth:// link or Base32 seed behind the QR code Certum
  shows when the phone app is added). `scripts/simplysign-setup.ps1` (the owner, once, in their own window) asks for the
  account e-mail and the link or seed with a hidden prompt (or reads the QR code from a Win+Shift+S snip with
  `-FromClipboard`, or a picture with `-Image`, decoded offline by `scripts/read-qr.mjs`), shows the current code to compare with the phone app, and
  stores it with **DPAPI for the owner's Windows account** (with a context string) in `%LOCALAPPDATA%\Iskra\simplysign.dat`.
  It is never printed, logged, committed or sent to GitHub. `-Remove` deletes it. Risk accepted by the owner
  (2026-10-13): anyone who can run code as this Windows account can sign as Iskra, like the devkeys on this PC.
- **When SimplySign's session ends** (one login lasts 2 hours) while its certificate is still in the store, a signature
  doesn't fail: SimplySign opens its own login dialog and the signature waits. So nothing waits on that dialog:
  - **The test signature** (`Invoke-SigningProbe` in `release-checks.psm1`) runs in a hidden child process with a
    time limit. While it runs, the release looks for SimplySign's login dialog about once a second. When the dialog
    shows, the stored code goes in at once (`simplysign-login.ps1 -NoCheck`: fills the open dialog, no restart, no
    test signature of its own) and the signature gets 2 more minutes to finish. No result in 60 seconds and no
    dialog: the child is stopped and the check fails with "didn't finish within 60 s" (`sign-timeout`).
  - **During the Windows build** (`release-windows.ps1`): a hidden watcher (`simplysign-login.ps1 -Watch`) runs while
    `npm run dist` and `build-sidecar.mjs` sign, and fills the dialog the same way. It stops when each step ends.
  - When the dialog can't be filled (no seed, the ledger says no, the login failed), the release closes it, so the
    signature fails at once and the release stops with the usual "Log in to SimplySign Desktop ..." line. No window
    is left waiting.
- **The login** (`scripts/simplysign-login.ps1`, called by `Confirm-Signing` when a test signature fails because
  SimplySign isn't logged in at all, e.g. no certificate in the store):
  - TOTP per RFC 6238 with .NET's HMAC (tested against the RFC's vectors), a code with at least 8 seconds left.
  - The login dialog: opens SimplySign Desktop's login dialog (restarting SimplySign, which isn't logged in at
    that point, so the dialog shows on start; option "show the login dialog on start" must stay on; the dialog that
    pops up when a program asks to sign works too) and fills it with window messages (7.6.90.0 has no UI Automation
    names): the window with an "ID:" and a "Token:" label and an "&Ok" button, each box matched to its label's row.
    Proven with Certum's link on 2026-10-15. Decline SimplySign's update offers until a new version is checked. It is
    the only method: SimplySign's own `/otpauth "<link>"` and `/autologin` switches (once method `switches`) are
    retired because they put the seed on a command line, visible to every process of the account. A seed stored for
    that method logs in through the dialog, with a note.
  - **At most one attempt per release run** (GitHub run + attempt, or release.ps1's run), and **none for 30 minutes
    after a failed one**, so a wrong seed can't lock the Certum account. One exception: a run that outlasts a session
    may log in again when its last login **worked** and was at least 90 minutes ago (sessions last 2 hours). After a
    failure, never. The ledger is `%LOCALAPPDATA%\Iskra\simplysign-attempts.json` (times and results only); every
    way in (test signature, login script, build watcher) goes through it.
  - Then the certificate must appear in CurrentUser\My and a test signature on a scratch file must pass.
- Without a stored seed nothing changes: the release stops with "Log in to SimplySign Desktop ...".
- Unverified until the owner's first run: UI Automation with the screen locked (the runner starts at logon; a locked
  session should still answer UI Automation, but if the login only works unlocked, keep the PC unlocked).

#### The home PC runner

The Release workflow's Windows jobs (`pc-checks`, `windows`, `play-pc`) run on the owner's PC as a GitHub Actions
self-hosted runner with the label `iskra-windows-signing` (only that label: no `self-hosted`/`Windows` labels).

- **Set up once**: `scripts/runner-setup.ps1` in the owner's normal (not elevated) PowerShell, logged in to gh as the
  owner. It downloads the official runner (pinned version, SHA-256 checked before unpacking) into
  `D:\Development_Projects\iskra-runner`, registers it with a one-hour token from `gh api`, installs the job guard and a
  logon task "Iskra release runner" that starts it hidden as the owner (not a service: it needs the owner's DPAPI key,
  the CurrentUser certificate store and SimplySign Desktop in the owner's session). `-Remove` stops it, unregisters it
  on GitHub and deletes the folder and the task.
- **Firewall**: the runner only connects out to GitHub over HTTPS and listens on no port; Windows Firewall only prompts
  for programs that accept incoming connections, so no rule is needed. Nothing in the release jobs starts a server.
- **Public repo safety**:
  - Only `release-all.yml` names the label, and each of those jobs runs only when `github.event_name ==
    'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == github.repository_owner &&
    github.triggering_actor == github.repository_owner` (never for pull requests; `workflows.test.mjs` checks this).
  - The runner's own job guard (`runner-job-guard.ps1`, copied into the runner folder at setup and run before every
    job via `ACTIONS_RUNNER_HOOK_JOB_STARTED`) refuses any job that isn't exactly this repository (by id), this
    workflow on main, workflow_dispatch, started and re-run by the owner, one of those three jobs. A workflow file
    changed on a branch or in a fork can't get past it. Changing the guard needs `runner-setup.ps1` again.
  - Repo setting (owner): Settings → Actions → General → "Approval for running fork pull request workflows from
    contributors" → **Require approval for all external contributors**. `release.ps1 -GitHub` checks it.
  - Fork pull requests can't reach the runner anyway (their jobs fail at the guard), and nothing on the PC is shared
    with other workflows: the checkout is cleaned (`git clean -ffdx`) at the start of each job.
- **When the PC is off**: `pc-online` cancels the run after 10 minutes with "switch it on and log in"; nothing changed.

#### Android built on GitHub (prepared)

Off until the owner's steps are done; the default is the home PC building and signing with the release key.
- Set the repo variable `ANDROID_BUILD` to `ci` to switch: `android-ci` builds the AAB on GitHub and signs it with a
  separate **upload key** (environment `signing`: `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`;
  alias `upload`). `android-apk` uploads it to Play **before** finalize (Play takes only the upload key after the reset),
  then downloads the universal APK Play generated and signed with the app signing key (`play-upload.mjs --universal-apk`,
  `generatedApks`), checks its signer is in `assetlinks.json` and its version code, and attaches it to the draft. The
  release key then leaves the routine path (cold storage). Needs workload identity federation (below).
- Unverified until the first run: that Play has the generated APK right after the commit (it should for the closed
  track); in phase B a failure after the Play commit leaves Play ahead of GitHub (RELEASE_ANYWHERE §2.3).

#### Google Play without a key file

The Release workflow's `play` (and `android-apk`) jobs get a short-lived access token for `iskra-play-publisher` through
Google **workload identity federation** (`google-github-actions/auth`, `token_format: access_token`, scope
androidpublisher) and pass it to `play-upload.mjs` as `ISKRA_PLAY_ACCESS_TOKEN`. No key file anywhere. Repo variables
`GCP_WIF_PROVIDER` (`projects/<number>/locations/global/workloadIdentityPools/github/providers/iskra-voice`) and
`GCP_PLAY_SERVICE_ACCOUNT` (`iskra-play-publisher@iskra-play.iam.gserviceaccount.com`) switch it on; until both are set,
`play-pc` uploads from the home PC with the JSON key, as release.ps1 does. The provider's attribute condition pins this
repository and the `release` environment, so only jobs in that environment on main can get a token. The owner's
Google Cloud steps are in docs/ci-cd-playbook.md, "Owner: one-time setup". After one green upload this way, delete the
JSON key in Cloud Console and the devkeys file.

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
2.0.0); `CFBundleVersion` is `<version code>.<run number>.<run attempt>` with Android's version code (20000110) and
mobile-ios.yml's run number (push and dispatch runs count together), so it rises with every release and every rebuild.
App Store Connect rejects a build number it has already seen for that version; a new build (`-Phones`, or a rerun of a
`-Phones` run) gets a new one. Once a `2.0.0` build is approved for the App Store, that version is closed: the next builds
must be a higher version (the next release bump does that).

**Running it.** Every release builds it: the `v*` tag push starts `mobile-ios.yml` (job `build`: build, cloud-sign,
check; the `.ipa` and its numbers, `ios-build.env`, as the artifact `iskra-ios-vX`, kept 14 days; nothing is uploaded
from a push run), and `release-finalize.yml` uploads that artifact after publishing (job "TestFlight upload":
`.github/actions/testflight-upload`, `xcrun altool --upload-app` with the API key on a macOS runner; `actions: read` to
find the tag's build run) and then runs "TestFlight groups and reviews" (`.github/actions/appstore-connect`). The
release ends when the upload is done (release.ps1, step 6 of [Releasing](#2-releasing)); the groups job finishes on its
own. `release.ps1 -Phones` does it for the latest release in one `mobile-ios.yml` run with upload on (jobs `build`,
`upload`, `groups`, the same two actions): the fallback when finalize's upload failed or didn't happen. By hand, only a
test build without upload: `gh workflow run mobile-ios.yml -f upload=false [-f ref=<branch or tag>]` (build, sign and
check only). With upload on, the run uses the mode in `mobile/store.json` (input `store` overrides it). After an upload,
`scripts/appstore.mjs` waits for Apple's processing (up to an hour; the job's timeout is 120 minutes), answers export
compliance, sets What to test from the release notes, keeps TestFlight's test information and the review contact
current, adds the build to the internal groups and the external groups in `mobile/store.json` (the public link
`r4tMgn3D`) and submits it for Beta App Review; in phase B it also fills and submits the App Store version. Every step
looks first, so reruns don't submit twice. The run summary names the build and what App Store Connect did.

| Also used by the store step | Where | Notes |
|---|---|---|
| `APPSTORE_REVIEW_PHONE` (secret, optional) | The review contact's phone | Apple requires a phone for App Review; set once with `gh secret set APPSTORE_REVIEW_PHONE` |
| `REVIEW_INVITE_URL` (variable) | A never-expiring member invite to the community server (Iskra, community.iskra.foo) for the review notes | One-time setup (docs/store/README.md): **Invite friends → Expires after: Never**. Nothing to renew; only if it's revoked, make a new one and set the variable again. Phase B refuses to submit without it |

### Cloudflare

| Item | Where | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` (secret of the `release` environment) | Token "iskra-github-ci" in Cloudflare → My Profile → API Tokens | Account permissions Cloudflare Pages: Edit + Workers Scripts: Edit, one account, no TTL |
| `CLOUDFLARE_ACCOUNT_ID` (GitHub variable) | Cloudflare dashboard sidebar | Not secret |
| Local token "iskra-deploy-cf" | Encrypted on the Windows PC, used by `D:\Development_Projects\IskraHeroPage\deploy-hero.ps1` | Fallback deploys. Never print it |
| Pages projects | `iskra-hero-page` → iskra.foo, `iskra-webclient` → app.iskra.foo (production branch main) | |
| DNS (zone iskra.foo) | `chat` A 146.190.236.187, DNS only (grey cloud: the server does its own HTTPS); Email Routing `spark@iskra.foo` → the owner's mailbox; `send.iskra.foo` records belong to Resend (email sending) | Don't proxy `chat` |

**Rotate the CI token:** create a new token with the same permissions → `gh secret set CLOUDFLARE_API_TOKEN --env release`
(paste at the prompt) → run deploy.yml with `site` → delete the old token. If the token leaks, roll it first
(Cloudflare → token → Roll), then update the secret. Lost: deploys fail; nothing that's live breaks.

### The server (chat.iskra.foo)

DigitalOcean droplet "Iskra-Voip-personal-ams3" (AMS3, Ubuntu 24.04, 146.190.236.187), the owner's friend server "Hangout".
It also runs the public **Iskra** community server (formerly Iskra Review; also where app store reviewers and testers
join): world `/opt/iskra/review-world`, service `iskra-review` on the same binary as Hangout, `https://community.iskra.foo`
with its own Let's Encrypt certificate (a nightly `iskra-review-restart.timer` picks up new versions), voice on 7891/tcp
and 7892/udp (ufw), updates off.

Both servers sit behind nginx (since 2026-10-15, hosting.md "Two servers on one machine"): `stream` on 443 routes by SNI
(TLS passthrough, PROXY protocol, so each server sees members' real addresses) to Hangout on 127.0.0.1:9443 and Iskra on
127.0.0.1:8443; `http` on 80 routes by Host to 127.0.0.1:9080 / 8080 (ACME challenges and redirects). Config:
`/etc/nginx/modules-enabled/99-iskra-stream.conf` and `/etc/nginx/sites-available/iskra`. Each server.json has
`Https.BindAddress` "127.0.0.1" and `Https.ProxyProtocol` true; backups `server.json.bak-proxy-20261015-1618`.

| Item | Where | Notes |
|---|---|---|
| Admin SSH key | `~/.ssh/iskrapersonalvoip` on the Windows PC (root) | Full access. Back it up; DigitalOcean's web console is the fallback |
| CI SSH key | `D:\Development_Projects\devkeys\iskra-droplet-ci` (+ `.pub`), secret `DROPLET_SSH_KEY` of the `release` environment | ed25519. In root's authorized_keys with a forced command `/usr/local/bin/iskra-update-ci`, which accepts only a version and runs `/usr/local/bin/iskra-update <version>` |
| `DROPLET_HOST`, `DROPLET_KNOWN_HOSTS` (variables) | The IP and its host keys | Refresh after rebuilding the droplet: `ssh-keyscan -t ed25519,ecdsa,rsa 146.190.236.187` → `gh variable set DROPLET_KNOWN_HOSTS < file` (check the fingerprints against the DigitalOcean console first) |

Layout: binaries in `/opt/iskra/app`, the world (database, keys, uploads, backups) in `/opt/iskra/world`, systemd
unit `iskra` (+ drop-in `quiet.conf`), HTTPS by the server's built-in Let's Encrypt, ufw allows 22, 80, 443,
7881/tcp and 7882/udp (voice), 1 GB swap, unattended-upgrades for the OS, raised UDP buffer sysctls for LiveKit.
`iskra-update X` downloads the X server bundle, verifies it against SHA256SUMS.txt, swaps it in, restarts, and
rolls back to the previous bundle if the server doesn't come up. Then it restarts the community server
(community.iskra.foo, unit `iskra-review`, same `/opt/iskra/app`) onto the new version too (since 2026-10-16); if that
one doesn't come back, it prints a warning and chat.iskra.foo stays as it is.

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
options → `gh secret set DROPLET_SSH_KEY --env release < iskra-droplet-ci` → run deploy.yml with the current `server_version`.

**Not done: chat.iskra.foo updating itself instead of the SSH deploy.** It would remove `DROPLET_SSH_KEY`, but a
server checks for new releases only every 6 hours (Updates/UpdateService.cs), so the deploy job couldn't confirm the
new version within the release; a "check now" trigger would need a new authenticated server endpoint. The SSH key is
low risk already (forced command, published and checksummed versions only), so the deploy stays as it is.

### DigitalOcean Marketplace image

| Item | Where | Expiry / renewal |
|---|---|---|
| `DO_MARKETPLACE_TOKEN` (secret of the `marketplace` environment) | DigitalOcean → API → Tokens, custom scopes; used only by `marketplace.yml` (builds and tests the 1-Click image) | 90 days: created 2026-10-15, expires **2027-01-13** |

**Renew the token:** DigitalOcean → API → Tokens → Generate New Token, 90 days, the custom scopes listed in
[marketplace/digitalocean/README.md](../marketplace/digitalocean/README.md#2-a-digitalocean-project-and-token-for-image-builds-once)
→ `gh secret set DO_MARKETPLACE_TOKEN --env marketplace` (paste at the prompt) → delete the old token → update its
`expires` in `docs/renewals.json` and the date here. Expired: only Marketplace image builds fail; nothing live breaks.

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
password). Play App Signing is on (checked 2026-10-16: the APK Play installs is signed with this same key, the
fingerprint in assetlinks.json), so Google holds a copy of the app key: if the keystore is lost, Play installs can
still be updated after an upload key reset; only GitHub APK installs would be stuck. The upload key can be replaced
and could live in CI. New personal Play accounts need a closed test with 12 testers for 14
days before production. If Play signs the app, add Play's app-signing fingerprint to assetlinks.json. Play also asks
for a declaration of the foreground service types (microphone, media playback: "voice chat in the background").

#### Google Play uploads

`scripts/play-upload.mjs <version>` (release.ps1 runs it after publishing) does one Android Publisher API edit:
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

- The `gh` CLI on the Windows PC is logged in as the owner (`gh auth status`); release.ps1 and its steps use it, and
  `runner-setup.ps1` gets the runner's registration token with it. The Release workflow doesn't need it.
- Workflows use the automatic `GITHUB_TOKEN` with per-job permissions; no personal tokens are stored. The Release
  workflow pushes the version commit and tag with it (main has no branch protection; if it gets one, allow the
  workflow to push, or the `version` job fails before anything else changes).
- Repo secrets: `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPSTORE_API_KEY_BASE64`, `APPSTORE_KEY_ID`,
  `APPSTORE_ISSUER_ID`; optional `APPSTORE_REVIEW_PHONE` (App Review contact), `ISKRA_CI_WEBHOOK`
  ([section 9](#9-ci-results-in-iskra)) and `ISKRA_RENEWALS_WEBHOOK` ([Renewal warnings](#renewal-warnings)).
- Environment `marketplace` secret: `DO_MARKETPLACE_TOKEN` ([DigitalOcean Marketplace image](#digitalocean-marketplace-image)).
- Environment `release` secrets: **`CLOUDFLARE_API_TOKEN` and `DROPLET_SSH_KEY`** (moved there from repo level; only
  jobs in that environment, on main, can read them).
- Variables: `CLOUDFLARE_ACCOUNT_ID`, `DROPLET_HOST`, `DROPLET_KNOWN_HOSTS`, `MAC_IDENTITY`, `REVIEW_INVITE_URL` (the
  review server invite for App Review notes); for the Release workflow, when set up: `GCP_WIF_PROVIDER`,
  `GCP_PLAY_SERVICE_ACCOUNT` ([Google Play without a key file](#google-play-without-a-key-file)), `ANDROID_BUILD`
  (`ci` only after the upload-key reset).
- Environment `signing` (only for `ANDROID_BUILD=ci`): deployment branch `main`, secrets
  `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`.
- Environment `release` (Settings → Environments). Used by release-finalize.yml, deploy.yml and the Release
  workflow's `checks`, `play` and `android-apk` jobs. Options:
  - **No required reviewers** (owner decision 2026-10-15): a release is one button or command and nothing waits for a
    click in GitHub. The automatic gates are the checks and finalize's CI gate; release.ps1's check phase warns if an
    environment gets reviewers again (Settings → Environments → release → untick "Required reviewers").
  - **Deployment branches and tags**: "Selected" → branch `main`. Manually started workflows run on `main` (they
    check out the tag themselves), so don't restrict it to tags.
- Actions settings for the self-hosted runner: [The home PC runner](#the-home-pc-runner).

### npm (bot SDK)

The bot SDK is published to npm as [`iskra-bots`](https://www.npmjs.com/package/iskra-bots) by `bots-sdk.yml`, separately
from app releases (first published 2026-10-14, 0.1.0).

- **Account:** the owner's npm account `iskravoice`, two-factor login with a passkey (Windows Hello on the release PC;
  recovery codes in devkeys). The package is unscoped (the `@iskra` scope belongs to someone else).
- **No token: trusted publishing.** npmjs.com → iskra-bots → Settings → Trusted Publisher: GitHub Actions,
  `quikmn/iskra-voice`, workflow `bots-sdk.yml`, environment `npm`, allowed: `npm publish`. npm checks the workflow
  run's identity (OIDC); nothing to renew. Publishing access: 2FA required, tokens disallowed. The `npm` environment
  has no required reviewers, so a publish doesn't wait for a click.
- **Publishing:** `.\scripts\release.ps1 -BotSdk [<version>]` (default: the next patch version). Its check phase: main
  clean at origin/main with green CI, the tag and the npm version unused, `npm run typecheck`, `npm run build:sdk` and
  `npm pack ./sdk --dry-run` in `bots/`. Then it sets `version` in `bots/sdk/package.json`, commits "Bot SDK X", tags
  `bots-sdk-vX`, pushes main and the tag, waits for bots-sdk.yml (tag matches, type-check, build, `npm publish
  --provenance`) and checks npm lists the version.

### Secret scanning and security settings

`secrets.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks) (pinned release, checksum checked in the workflow) over
every branch and tag on each push, PR and weekly. GitHub's own protections are owner settings, not files: repo → Settings →
**Advanced Security** (Code security): turn on **Secret scanning** and **Push protection** (blocks a push that contains a known
token format), **Private vulnerability reporting** (SECURITY.md points reporters there), Dependabot alerts and security updates,
and CodeQL (already a workflow). Scorecard publishes its score at scorecard.dev and puts its findings under Security → Code scanning;
many of them (branch protection, review) are owner settings too. Click-by-click steps: docs/compliance/owner-actions.md.

## 5. Refresh calendar

**`docs/renewals.json` is the single list of everything that expires** (date, how to renew, the section that
explains it); [renewals.yml](#renewal-warnings) warns about each one in the #renewals channel. When a date changes (a
renewed certificate, a new token), update `expires` there. The table below adds the routine chores; its dated rows
must match renewals.json.

| When | What | Do |
|---|---|---|
| Every release | SimplySign session | Nothing with a stored seed (it logs itself in); otherwise log in to SimplySign Desktop with the phone code first (the first check says so) |
| Every release | The home PC | Switched on and logged in to Windows for the Release button (the runner starts at logon) |
| Weekly (Mondays) | Dependabot PRs, CodeQL, Scorecard and secret scans | Merge green Dependabot PRs; look at new code-scanning alerts (Security tab: CodeQL and Scorecard) and secret-scanning alerts |
| Continuous | Droplet OS updates | Automatic (unattended-upgrades); reboot now and then (`ssh … reboot` with the admin key) when `/var/run/reboot-required` exists |
| Every ~60 days, automatic | chat.iskra.foo HTTPS certificate | The server renews it itself; port 80 must stay open |
| Yearly, next **2027-10-12** (auto-renew on) | Apple Developer Program | Check the card before the date, or Mac builds stop being notarized |
| Yearly | Cloudflare tokens, CI SSH key | Optional rotation (they don't expire): see section 4 |
| **2027-01 (before 2027-01-13), then every 90 days** | DigitalOcean token `DO_MARKETPLACE_TOKEN` | New token, `gh secret set DO_MARKETPLACE_TOKEN --env marketplace` ([section 4](#digitalocean-marketplace-image)) |
| **2027-04 (before 2027-05-12)** | Certum code-signing certificate | Renew (section 4); same CN keeps auto-update working |
| **2027-09 (before 2027-10-01), then yearly** | `Expires` in both security.txt files | Move it a year ahead (RFC 9116: at most a year), check Contact and Policy still work, deploy site and web app |
| Yearly (read live by renewals.yml) | iskra.foo domain | Check auto-renew at the registrar (Porkbun) |
| Yearly | Offline backups | Check the keystore, devkeys folder and admin SSH key copies still open |
| After 60 days without commits | Uptime schedule | GitHub pauses scheduled workflows in inactive repos (it emails first): Actions → Uptime → Enable workflow |
| **2031-08 (before 2031-09-17)** | Apple Developer ID certificate | New CSR, certificate, p12, secrets (section 4) |
| ~2053 | Android keystore | Far future; Play App Signing is on (Google holds the app key) |

### Renewal warnings

`.github/workflows/renewals.yml` runs `scripts/renewals.mjs --post` daily (and by hand: Actions → Renewals → Run
workflow; tick **digest** to post the full list now). It reads `docs/renewals.json` and works out the days left for
each item: a fixed `expires` date, or a live check with no date to maintain: the TLS certificates of iskra.foo,
app.iskra.foo and chat.iskra.foo, the iskra.foo domain (RDAP: the registry's `expiration` event) and the `Expires`
field of the deployed security.txt on iskra.foo and app.iskra.foo.

| When | What it posts |
|---|---|
| Exactly at one of the item's `warnDays` (default 30, 14, 7 and 1 days left) | That item |
| 7 days or fewer left, overdue, or a live check can't be read | That item, every day |
| The 1st of the month (UTC), or **digest** ticked | Every item with its days left, and those whose date is unknown ("date unknown: owner to fill") |
| Any other day | Nothing |

Each line: the name, the date, the days left, how to renew and a link to the section here. The run is **red** when
something is overdue or a live check can't be read, so it shows in Actions even without the webhook. Try it locally
(read-only network checks, posts nothing): `node scripts/renewals.mjs` (`--today YYYY-MM-DD` pretends another day).
Tests: `scripts/renewals.test.mjs` (root `npm test`).

**Adding an item:** one entry in `docs/renewals.json`: `id`, `name`, `expires` (YYYY-MM-DD; `null` with a `note` while
the date is unknown) or `check`, optional `warnDays`, `renew` (one line) and `doc` (a section of this file). Only real
dates: the test checks that every `expires` also appears in this file.

**The channel (once):** the warnings get their own channel, not #ci. On Hangout (chat.iskra.foo): create a text channel
`#renewals` that only admins can read (channel permissions), then Server settings → **Bots and webhooks → Webhooks →
New webhook**, name `Renewals`, "Posts in" #renewals → **Create webhook** → copy the URL (it is shown once). Then
`gh secret set ISKRA_RENEWALS_WEBHOOK` and paste it at the prompt. Until it's set, the run says "ISKRA_RENEWALS_WEBHOOK
not set, not posting." and still passes (unless something is overdue). The URL is never printed; regenerate the
webhook's secret in Iskra if it leaks, then set the secret again.

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
`client/`). LiveKit (`.tools/livekit-server`) and the captions and English/Swedish translation models (`get-models.mjs --translate sv`) are cached on their pins.

**Flaky end-to-end tests.** On CI (`CI` set) a failed test runs once more (`retries: 1` in `client/playwright.config.ts`;
locally never). Passing on the retry makes it *flaky*: the run stays green, and `scripts/e2e-flaky.mjs` lists it from
each shard's JSON report in the job summary (each shard's and the `end-to-end` job's), and the #ci message says
"CI passed on main, 2 flaky" with the tests' names (section 9). A test that fails twice stays red. A flaky test is a bug
to fix at its cause, not a pass: its trace is in the shard's `playwright-results-<n>` only when the shard failed, so
reproduce it locally with `--repeat-each 20 --workers 4` (see the nightly stress run's `stress-results-<n>` artifact,
which keeps the traces of every test that failed once).

**Nightly end-to-end stress** (`e2e-stress.yml`, 04:17 UTC and by hand with a repeat count): the whole suite three times
over on the same four shards (`--repeat-each 3`, one retry as in CI). Flaky and failed tests go to the summary and to the
#ci channel ("Nightly end-to-end stress passed on main, 1 flaky"). Flaky-only stays green, so it never emails; a test
that fails twice turns it red.

**Fewer jobs per push.** GitHub runs 20 jobs at once on this plan (40 on Pro); one push to main starts 17 (15 CI, counting the small `report to Iskra` job, + the
secrets scan; pushes skip macOS, CodeQL and Scorecard, which run on PRs, nightly or weekly). A newer push to the same
branch cancels the older CI run (`concurrency` in ci.yml), so a burst of pushes doesn't queue. Never cancelled: the
"Version X" commit's run (its own group: release finalize waits for CI to pass on exactly that commit; if one was
cancelled anyway, `gh run rerun <id>` it), tag runs, release, finalize, deploy and iOS workflows. Dependabot's branches
run CI as pull requests only.

| Symptom | Cause and fix |
|---|---|
| `STOP [SimplySign] Log in to SimplySign Desktop ...` (at the start, or mid-build: "No provider was specified", "SignTool Error", "Signing failed") | SimplySign Desktop is logged out (it times out) and there's no stored seed, or its one automatic login this run is used. Log in with the phone code, then run release.ps1 again (`-Resume` once the tag is pushed); on GitHub re-run the failed jobs |
| "SimplySign's test signature didn't finish within 60 s and SimplySign showed no login dialog" | SimplySign Desktop is stuck (no answer, no login dialog). Quit and start SimplySign Desktop (log in if it asks), then run release.ps1 again; on GitHub re-run the failed jobs |
| "SimplySign's session ended (it asked to log in) and ..." | SimplySign's 2-hour session ended and its login dialog couldn't be filled; the reason follows ("no seed is stored", or the automatic login's reason as in the next row). The release closed the dialog. Log in by hand, then run again |
| "the automatic login didn't help (...)" | The reason is in the brackets. "the last SimplySign login failed at HH:mm": a wrong seed or a changed dialog; log in by hand, then check the seed with `simplysign-setup.ps1` (it shows the code to compare). "login dialog's fields weren't found": SimplySign Desktop changed; report it |
| Release run: "The home PC didn't pick up its job in 10 minutes" | The PC is off, asleep or not logged in (the runner starts at logon), or the runner is gone (Settings → Actions → Runners). Switch it on, log in, press Release again. Nothing was changed |
| Release run: a job on the home PC fails at "Set up runner" with "Refused: ..." | The runner's job guard refused it: the run wasn't started by the owner on main with Run workflow. Start it that way |
| Release run: `version` "main moved since the checks" | Something was pushed to main during the checks: press Release again |
| Release run: `checks` red | The run summary lists every red with its case (the same as release.ps1's); fix, press Release again |
| sign.ps1 found no certificate in PowerShell 7 although it's installed | Fixed: `-CodeSigningCert` is missing when PSModulePath points at PowerShell 7's modules, so sign.ps1 filters on the code-signing EKU (1.3.6.1.5.5.7.3.3) itself. Keep that filter if you touch it |
| macOS: `security: SecKeychainItemImport` / codesign "errSecInternalComponent" / keychain won't unlock | Fixed in release.yml: we import the p12 into our own keychain and run `set-key-partition-list` (electron-builder's temporary keychain fails on current runners). Keep that step |
| Notarization failed or hangs | The electron-builder log shows the submission id. On a Mac with the .p8: `xcrun notarytool log <id> --key AuthKey.p8 --key-id <id> --issuer <issuer>` (or `notarytool history`) lists the rejected files. Common: an unsigned nested binary, missing hardened runtime, expired membership or agreement waiting in App Store Connect |
| Finalize: "no green CI run on …" / "CI concluded failure on this commit" | The CI gate: nothing was published. A flake: rerun CI's failed jobs (`gh run rerun <id> --failed`), then `release.ps1 -Resume`. "CI concluded cancelled": a newer push cancelled it (shouldn't happen to a "Version X" commit): `gh run rerun <id>`, then `release.ps1 -Resume`. A real failure: fix main and release the next version; never move the tag |
| release.yml publish: "latest-mac.yml: … doesn't match its build's update file" / "the parts …" | The two Mac jobs' update files don't fit the zips and dmgs they attached, or each other. Rerun release.yml's failed jobs; if it repeats, report |
| release.yml, step "Attach to the release": "isn't on the release with N bytes" / "nothing matches …" | A short upload, or a build that left no file. Rerun that job (`gh run rerun <id> --failed`; `--clobber` replaces the file). Two draft releases vX in GitHub → Releases: two jobs made the draft in the same second (release.ps1 makes it right after the push, so this takes a tag pushed by hand); delete the emptier one and rerun the jobs whose files were on it |
| Finalize: "missing (…)" | A build didn't upload. Check `release.yml`'s run for the tag, rerun its failed jobs (`gh run rerun <id> --failed`), then `release.ps1 -Resume` (it builds and uploads missing Windows files). `missing (sbom)`: release.yml's `sbom` job (npm or NuGet unreachable, a lock file out of step with package.json at the tag): rerun it the same way |
| Finalize, job "TestFlight upload": "no Mobile iOS build run for vX" / "concluded failure" / "has no artifact iskra-ios-vX" | The release is published and deployed; only the iPhone app is missing. The tag push didn't start mobile-ios.yml (workflow off? pushed with a token that starts no workflows?), its `build` job failed (its log; the iOS rows below) or the artifact expired (14 days). `release.ps1 -Phones` builds and uploads it in one run (playbook I) |
| TestFlight upload (altool): "Unable to authenticate" / "No suitable application records" / "bundle version must be higher" / "redundant binary" | The API key (the three `APPSTORE_*` secrets; rotate it, [Apple](#apple-macos-signing-and-notarization)), the App Store Connect app record, or a build number Apple has seen. The last two from finalize: `release.ps1 -Phones` (a new build, a new number); in a `-Phones` run: `gh run rerun <id>` once |
| Finalize, job "TestFlight groups and reviews" failed after the release ended | `gh run view <id> --log-failed`: the "App Store Connect stopped" rows below. A flake of Apple's API: `gh run rerun <id> --failed` once (every step looks first, nothing is submitted twice) |
| deploy.yml webapp: "the webapp artifact of run N is incomplete" | release.yml's `webapp` artifact lacks index.html or `.well-known/` (hidden files must be included, `include-hidden-files: true`). Report it; until release.yml is fixed, delete that artifact (the run page → Artifacts) so a redeploy builds from source |
| Finalize: "latest.yml: … doesn't match" | A file was re-uploaded without the latest*.yml from the same build (or the other way round). Upload both from the same build |
| An installed desktop app doesn't update by itself | Read its `logs/updates.log` (section 2, after "What can still fail"). `releases list: HTTP 403` is GitHub's rate limit for that address (60 an hour, shared by everything on it). `newer release X found` then an error: that release lacks the right `latest*.yml` or installer. Nothing logged for hours: the app wasn't running or checks are off (My settings → Privacy & data). Apps up to alpha.21 read the atom feed and find nothing while the newest tag's release is a draft; they update once the newest tag is a published release (or from tray → Check for updates at such a time) |
| Checksums wrong after re-uploading assets | `release.ps1 -Redeploy checksums <version>`: finalize with deploy off regenerates SHA256SUMS.txt and the attestations |
| Pages deploy fails | "Authentication error": token revoked/expired or wrong account id (section 4). "Project not found": project names in deploy.yml. The check step failing after a good deploy: Cloudflare cache; rerun |
| Server update fails | `iskra-update` rolled back to the previous version (the server keeps running). Log in with the admin key: `journalctl -u iskra -n 200`. Host key mismatch in CI: the droplet was rebuilt, refresh `DROPLET_KNOWN_HOSTS` |
| `release.yml`: "Check the tag matches the app version" fails | The tag was pushed by hand, not by release.ps1. Don't move the tag: delete the draft release, bump to the next version |
| Linux CI: audio/video device errors | Runners have no sound card or display. Electron tests run under `xvfb-run`; browser tests use Chromium's fake media devices. Don't add tests that need real devices |
| Windows Firewall prompts during tests | Something listened on all interfaces. Tests must be localhost-only (`LocalOnly: true`, `ISKRA_LOCAL_ONLY=1`); `scripts/dev-firewall.ps1` adds block rules for new exe paths |
| Secrets scan fails | gitleaks found something that looks like a secret (the log shows file, commit and rule, value redacted). A real one: revoke/rotate it at the service **first** (it's public the moment it's pushed), then remove it from the tree. A false positive: add its fingerprint (`commit:file:rule:line`, printed in the log) to `.gitleaksignore` with a comment why, or a path to `.gitleaks.toml` for test data |
| SBOM job (`release.yml`, `sbom`) fails | Usually npm or NuGet being unreachable, or a lock file out of step with package.json at the tag: `gh run rerun <id> --failed`. Finalize refuses to publish while the three `iskra-sbom-*.cdx.json` files are missing |
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
| `STOP [phones]` from release.ps1 | The release is out; a phone part isn't. The line names it. TestFlight failed: the iOS rows here and the run's log. Play: the rows below. Then `release.ps1 -Resume` |
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
- Ship only with `scripts/release.ps1` (release, `-GitHub` for the Release button, `-Resume`, `-Redeploy`, `-Phones`,
  `-BotSdk`); never run its steps or `gh workflow run` for release-all, release, finalize, deploy or iOS uploads by hand.
- Never run `simplysign-login.ps1`, `simplysign-setup.ps1` or `runner-setup.ps1` yourself: the first runs inside a
  release, the other two are the owner's (in a window opened for them).
- Needs the human: the SimplySign login (phone code) before a release when no seed is stored, the Apple developer portal and App Store Connect (app record, TestFlight testers, API keys), the Play Console,
  the Cloudflare dashboard (new tokens), DigitalOcean, anything that costs money.

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

**Alerts.** Everything automatic reports to **one Iskra channel** (the `ISKRA_CI_WEBHOOK` webhook, the same one CI and
releases use), and nothing e-mails the owner. A failing check posts "🔴 Outage" there and opens one issue labelled
`outage` (not assigned, as a record); when the *set* of failing checks changes it posts "🟠" and comments, and when
everything passes again it posts "🟢 Back up" and closes the issue. The run itself stays green when it found an outage;
a red run means the check itself broke (e.g. GitHub's API).

**Changing it:** hosts and thresholds are environment variables at the top of the script (`SITE`, `APP`, `CHAT`,
`VOICE_PORT`, `CERT_WARN_DAYS`, `TRIES`, `PAUSE`). Try it locally without touching issues:
`DRY_RUN=1 TRIES=1 bash scripts/uptime-check.sh`. There's no public status page; the open `outage` issue is the
status (the repo is public, so keep issue text to what the checks say).

## 9. CI results in Iskra

Optional: what GitHub's own messages don't say, in an Iskra channel, through an incoming webhook
(`scripts/ci-notify.mjs`, tested by the root `npm test`). The channel already gets GitHub's `workflow_run` and release
events (Iskra turns them into a pass/fail line), so these post only the details:

- **ci.yml**, job `report to Iskra`: for runs on **main** only (pushes, nightly, by hand; never pull requests or other
  branches, the Release workflow's call, or a run a newer push cancelled). On a failure: "CI failed on main", the short
  commit, the failed jobs' names and the end-to-end tests that failed twice. On a pass with flaky end-to-end tests:
  "CI passed on main, 2 flaky" and their names (the first five). A plain pass posts nothing.
- **e2e-stress.yml**, job `report`: only when it found failed or flaky tests ("Nightly end-to-end stress passed on main,
  1 flaky", or "... failed on main"), with the same lists.
- Releases post nothing of their own: GitHub's release and `workflow_run` events cover them.
- Only when the secret `ISKRA_CI_WEBHOOK` is set; otherwise the job ends in a second without checking anything out.
  Nothing else is sent (no logs, no commit messages; test names only). A failed post is a warning, never a red run, and
  the URL is never printed. The URL must be `https://…/hooks/<id>/<secret>` (HTTPS, an Iskra webhook).

**Set it up (once):** in Iskra, on the server and channel that should get the results (e.g. chat.iskra.foo, a private
`#ci` channel): Server settings → **Bots and webhooks → Webhooks → New webhook**, name `CI`, "Posts in" that channel → **Create webhook** → copy the URL (it is shown once).
Then `gh secret set ISKRA_CI_WEBHOOK` and paste it at the prompt. To stop: `gh secret delete ISKRA_CI_WEBHOOK` (or delete
the webhook in Iskra; posts then fail quietly). Regenerate the webhook's secret in Iskra if the URL ever leaks, then set
the secret again.
