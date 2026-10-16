# CI/CD playbook (for agents)

Follow these steps exactly. Run only the commands written here. If a check fails, use the decision table; if the
table doesn't cover it, **stop and report**. Don't improvise fixes. Background and explanations: [ci-cd.md](ci-cd.md).

- Repo: `D:\Development_Projects\Iskra` (GitHub `quikmn/iskra-voice`). Run every command from there.
- `V` = the version without `v`, e.g. `2.0.0-alpha.10`. `vV` = the tag, e.g. `v2.0.0-alpha.10`.
- Commands are PowerShell 7 unless marked **bash**. Long waits: run in the background and check back.

## Never

1. Never print, echo, cat or log a secret, token, password, key or certificate file. Never open files in `D:\Development_Projects\devkeys`.
2. Never `git push --force`, never delete or move a tag, never `git stash`, never `git reset --hard` on main.
3. Never edit workflows, scripts, `desktop/package.json`, `client/src/links.ts` or `site/index.html` by hand during a release.
4. Never change GitHub secrets, variables or settings, Cloudflare, Apple, Google Play or the droplet.
5. Never mark a release as prerelease and never publish it by hand (finalize does it).
6. Never write "Iskra 2", "rebuilt" or anything about v1 in release notes or anything public.
7. Never skip a failing check or rerun something more than once without the human.
8. Never ship any other way than `scripts/release.ps1` (no hand-run steps, no `gh workflow run` of release, finalize,
   deploy or an iOS upload, no tags pushed by hand). Never try to log in to SimplySign yourself.

## Tasks

Everything that ships goes through one script, `scripts/release.ps1`. Never run its steps (release-windows.ps1,
release-version.mjs, release-notes.mjs, play-upload.mjs, ...) or `gh workflow run` for release, finalize, deploy or iOS
uploads by hand.

| The human says | Section |
|---|---|
| "release V" / "send it" / "release the next one" | [A. Release](#a-release) (with the home PC runner set up: [A0](#a0-release-with-the-release-button)) |
| "set up the Release button" / "the runner" / "the SimplySign seed" / "Play without a key" | [O. Owner: one-time setup](#o-owner-one-time-setup) |
| "finalize V" / "publish V" / "do the Windows part of V" / a release stopped after the tag | [B. Resume a release](#b-resume-a-release) |
| "redeploy the site" | [D. Redeploy site](#d-redeploy-the-site-iskrafoo) |
| "redeploy the web app" | [E. Redeploy web app](#e-redeploy-the-web-app-appiskrafoo) |
| "update the server (to V)" | [F. Update the server](#f-update-the-server-chatiskrafoo) |
| "fix the checksums of V" | [G. Re-run checksums](#g-re-run-checksums-and-attestations) |
| "is CI green?" | [H. Check CI](#h-check-ci-status) |
| "put the phone apps of the latest release in the stores" / "build iOS and upload to TestFlight" | [I. Phone apps](#i-phone-apps) |
| an `outage` issue was opened / "is everything up?" | [J. Outage alert](#j-outage-alert) |
| "build the Android app" (a local test build) | [K. Android app](#k-android-app) |
| "put the Android app on Google Play" (first time) | [L. Google Play](#l-google-play-the-owner-in-the-browser): agents only do step L.3 (K); the rest is the human's |
| "publish the bot SDK" | [M. Bot SDK](#m-bot-sdk-to-npm) |

Every mode of release.ps1 has two phases. The **check phase** runs every check and changes nothing; if anything is red it
prints `N thing(s) to fix before ... (nothing was changed or sent):` with one `- [case] what to do` line each, and ends.
If all is green it prints `ALL CHECKS GREEN - SENDING` and ships without a prompt or an approval. After that, a problem
prints one `STOP [case] what to do` line. `-CheckOnly` (alias `-DryRun`) runs only the check phase.

## A0. Release with the Release button

The owner can press it themselves (GitHub → Actions → Release → Run workflow, also in GitHub Mobile). For an agent, once
the home PC runner is set up ([O.2](#o-owner-one-time-setup)):
1. **Notes**: as A.1 (they must be on main on GitHub: the workflow releases origin/main).
2. **Check**: `pwsh -NoProfile -File scripts/release.ps1 -GitHub -CheckOnly` (or with `V`). It checks the runner is
   online and the Actions setting, starts the workflow with `check_only`, and follows it.
   ✔ `ok: the Release workflow succeeded (checks only: nothing was changed)`. Red: the run's summary lists each red
   with its case: the decision table.
3. **Release**: `pwsh -NoProfile -File scripts/release.ps1 -GitHub` (or with `V`), in the background (60-90 min).
   ✔ `ok: the Release workflow succeeded: <url>`.
4. `STOP [Release failure] Jobs: ...`: read the failed job (`gh run view <id> --log-failed`), find the case in the
   decision table. Once fixed, re-run the failed jobs (`gh run rerun <id> --failed`) once; never press Release again
   for a version whose tag exists.

## A. Release

1. **Notes.** The notes for V are the lines in `docs/releases/NEXT.md` (the script turns them into `docs/releases/V.md`),
   or a hand-written `docs/releases/V.md`. Check one of them has V's changes; if neither does, **stop and ask** for the
   notes (suggest a draft from `git log --oneline v<previous>..main`).
2. **Check.** `pwsh -NoProfile -File scripts/release.ps1 -CheckOnly` (no version: the next alpha after the latest
   release; or give `V`).
   - `STOP [SimplySign] Log in to SimplySign Desktop (6-digit code from the app), then run scripts/release.ps1 again.`
     → tell the human exactly that line, wait for their answer, then run step 2 again.
   - `N thing(s) to fix` → each line is a decision-table row: do what it says (most are the human's), then step 2 again.
   ✔ Ends with `ALL CHECKS GREEN: release vV would go ahead. Nothing was changed (check only).`
3. **Release.** Run in the background (60–90 min; it waits for the builds, finalize and the iPhone build):
   `pwsh -NoProfile -File scripts/release.ps1` (or with `V`). It runs the checks again, prints
   `ALL CHECKS GREEN - SENDING`, then writes the notes, bumps and tags, pushes, builds, signs and uploads the Windows
   files and the Android app, waits for release.yml, runs finalize (no approval: it refuses by itself unless CI passed
   on the tag), the phones where `mobile/store.json` says, and the final checks. `-SkipPhones` only if the human asks.
   ✔ Ends with `Result: done` and the report lines (Release, Runs, Checks, Phones).
4. **A `STOP [case] ...` line:** find the case in the decision table and do exactly that. Once the tag is pushed, go on
   with [B](#b-resume-a-release). Never rerun more than once without the human.
5. `git checkout main`, then report (format at the end).

## B. Resume a release

After a STOP once the tag is pushed (or to finish the Windows part, finalize or the phones of V):
1. `git fetch --tags`, then `git checkout vV` unless main is at the `Version V` commit.
2. `pwsh -NoProfile -File scripts/release.ps1 -Resume` (V comes from desktop/package.json; or add `V`). Run it in the
   background. It checks again (SimplySign only if Windows files are missing), then skips what's done: Windows files
   already on the release, a finalize that already published, a TestFlight run that succeeded, a version already on
   the Play track.
   ✔ Ends with `Result: done`.

## C. Finalize only

Use [B](#b-resume-a-release): `-Resume` starts finalize when all files are there and it hasn't published yet.

## D. Redeploy the site (iskra.foo)

1. Changes to `site/` must be on main on GitHub (the check says so if they aren't).
2. `pwsh -NoProfile -File scripts/release.ps1 -Redeploy site` (from main; another ref: `-Ref <tag or branch>`).
   ✔ `ALL CHECKS GREEN - SENDING (redeploy site)`, then `ok: redeployed site (<url>)` (deploy.yml's site job checks that
   iskra.foo links to the version and that every page in `site/`, such as /terms, /privacy, /support and
   /delete-account, is served).

## E. Redeploy the web app (app.iskra.foo)

1. `pwsh -NoProfile -File scripts/release.ps1 -Redeploy webapp` (the latest release tag; `-Ref main` only if the human
   said main).
   ✔ `ok: redeployed webapp (<url>)` (it checks the new index asset is served).

## F. Update the server (chat.iskra.foo)

1. `pwsh -NoProfile -File scripts/release.ps1 -Redeploy server` (the latest release; or add `V`). The check refuses a
   version that isn't a published release with SHA256SUMS.txt.
   ✔ `ok: redeployed server (<url>)`. The run's log ends with `chat.iskra.foo runs V`.

## G. Re-run checksums and attestations

Use after files on a published release were replaced.
1. `pwsh -NoProfile -File scripts/release.ps1 -Redeploy checksums` (the latest release; or add `V`).
   ✔ `ok: SHA256SUMS.txt and attestations of vV redone (<url>)`.

## H. Check CI status

1. `gh run list -L 10`
2. For each `failure` on main: `gh run view <id> --log-failed` and report the failing job and the first error lines. Don't fix it unless asked.

## I. Phone apps

Every release does this by itself (A, step 3): mobile-ios.yml on the tag ends with the step "TestFlight groups and
reviews" (scripts/appstore.mjs: Apple's processing, What to test, TestFlight groups, Beta App Review), and the Android
bundle goes to the Play track in `mobile/store.json`. To do only that for the latest release (for example after the human
fixed something on Apple's or Google's side):
1. The AAB must be in `mobile\release` (built by the release on this PC); otherwise `git checkout vV` first so it can be built.
2. `pwsh -NoProfile -File scripts/release.ps1 -Phones` (or add `V`). Run it in the background (30–90 min).
   ✔ Ends with `Phones: TestFlight uploaded, Google Play on the '<track>' track`.
3. Tell the human: "Build <build> of <version> is in TestFlight for the internal and external groups; external testers get
   it when Beta App Review approves it."

A test build without upload (nothing ships): `gh workflow run mobile-ios.yml -f upload=false` (`-f ref=<branch>` for
another branch), then `gh run watch <id>`. Never change the API key, the App Store Connect app, TestFlight groups or
`mobile/store.json` yourself; those are the human's. Never run scripts/appstore.mjs yourself (it runs on GitHub with the key).

## J. Outage alert

The uptime workflow (`uptime.yml`, every 15 minutes) opened or updated an issue labelled `outage`.
1. `gh issue list --label outage --state open` → read the issue: it lists each failing check.
2. Confirm it's still failing: `gh workflow run uptime.yml`, then `gh run list --workflow uptime.yml -L 1` and `gh run watch <id>`; its summary is a table of every check.
   It closes the issue by itself when all pass.
3. By check:
   - `iskra.foo` / `app.iskra.foo` doesn't answer: `curl -sI https://iskra.foo`. Cloudflare's status page
     (cloudflarestatus.com) first. A bad deploy: redeploy ([D](#d-redeploy-the-site-iskrafoo) / [E](#e-redeploy-the-web-app-appiskrafoo)).
   - `chat.iskra.foo` doesn't answer, `/health` unhealthy or `voice … down`, voice port not reachable: the droplet. Report to
     the human; they log in with the admin key (`journalctl -u iskra -n 200`, `systemctl status iskra`). Right after a
     server update: [F](#f-update-the-server-chatiskrafoo) with the previous version only if the human agrees.
   - `certificate … expires in N days`: Pages hosts renew themselves (report if it stays under 14 days for 2 days);
     chat.iskra.foo renews in the server (port 80 must be open): report to the human.
4. Never close an `outage` issue by hand while a check still fails, and never change the schedule to silence it.

## K. Android app

Releases build the APK and the app bundle and upload the bundle to Google Play by themselves (A). A local test build
(it ships nothing), on the Windows PC (the release key lives only there):
1. `git checkout <tag or main>`, then `pwsh -NoProfile -File mobile/scripts/build-android.ps1` (add `-ApkOnly` to skip the AAB).
2. ✔ Ends with `Built ...\mobile\release\Iskra-V.apk (signed by the release key, 7c5941ba…)`.
3. Never print or open the keystore or its password file.
4. The AAB for Google Play is `mobile\release\Iskra-V.aab` (the script prints `Built ...\Iskra-V.aab` before the APK line),
   signed with the same release key. Only release.ps1 uploads it (A, or I for the latest release); never upload it any
   other way and never run scripts/play-upload.mjs yourself.

## L. Google Play (the owner, in the browser)

For the human: agents never touch Play Console (Never, rule 4). Everything to paste is in
[docs/store/play](store/play): listing text (`en-US/`, `sv-SE/`), [app-content.md](store/play/app-content.md) (every
other form), [data-safety.md](store/play/data-safety.md), [content-rating.md](store/play/content-rating.md).

**Signing, decided once.** Every Android build so far (the old app and the GitHub APKs) is signed with the release key
in `devkeys\iskra-android.keystore`, and `client/public/.well-known/assetlinks.json` lists its fingerprint for App
Links. Play App Signing re-signs what you upload with an *app signing key*; what you upload is signed with the *upload
key*. Choose **"Use a key from Java keystore"** (upload the existing key, encrypted by Google's PEPK tool) so Play
signs with the same key as before: copies installed from GitHub then update from Play and back, and App Links keep
working without a new fingerprint. Keep using the same key as the upload key too, so `build-android.ps1` works as it
is. (If you let Google generate a new key instead, Play and GitHub installs can't update each other, and you must add
Play's SHA-256 from Setup → App signing to `assetlinks.json` and redeploy the web app, E.)

1. **Create the app.** play.google.com/console → Create app: fields in app-content.md "Create app". Free.
2. **Set up the app** (Dashboard → "Set up your app"; each item links to its form): privacy policy, app access
   (create the review server's invite link first, see app-content.md), ads, content rating, target audience, news,
   data safety, government apps, financial features, health, advertising ID. Then Store settings (category, email,
   website) and Main store listing (text, icon, feature graphic, screenshots; Swedish under Translations).
   Graphics: `cd server; dotnet build src/Iskra.Server`, then `cd client; $env:PLAY_SHOTS=1; $env:ISKRA_E2E_PORT=5299;
   npx playwright test e2e/play-store.spec.ts` → `docs/store/play/screenshots/` and `graphics/`.
3. **Build the AAB**: [K](#k-android-app) on the release tag (`mobile\release\Iskra-V.aab`).
4. **Internal testing.** Test and release → Testing → Internal testing → Testers: create a list (`Friends & family`, the
   testers' Google account emails) → Releases → Create new release. The first time it asks about app signing: Choose
   signing key → **Use a key from Java keystore**, follow its PEPK steps on this PC (the tool reads the keystore
   locally; upload only the encrypted zip it makes; alias `iskra`). Upload `Iskra-V.aab`, release name `V`, release
   notes from `docs/releases/` (short; English and Swedish) → Next → Save and publish.
5. **Foreground services.** Policy and programs → App content → Foreground service permissions: microphone and media
   playback, texts in app-content.md, plus a short video of voice with the screen locked (record it on a phone from
   the internal test).
6. **Check on a phone** (from the testers' opt-in link): install over a GitHub APK (it must update, not fail with a
   signature conflict), join a server, voice with the screen locked for 2 minutes, an invite link opens the app
   (`adb shell pm get-app-links foo.iskra.app` → `verified`). Then answer the data safety question about encryption
   in transit (data-safety.md, "to decide").
7. **Closed testing, then production.** A personal developer account made after November 2023 needs a closed test
   with at least 12 testers who stay opted in for 14 days before it can apply for production (Dashboard shows the
   requirement if it applies). Create a closed testing track, promote the internal release to it, invite the testers,
   wait the 14 days, then Apply for production → Production → Create release (promote the tested release), countries
   per app-content.md, staged rollout 20% → 100%.
8. **Every later release:** automatic. With the service account set up once
   ([docs/store/README.md](store/README.md#google-play-service-account-for-the-uploads)), release.ps1 uploads the
   bundle to the track in `mobile/store.json` (closed testing `alpha` now; production after step 7 and the flip in
   docs/store/README.md) with the release notes. The version code rises with every version (scripts/mobile-version.mjs);
   Play refuses a code it has seen.

## M. Bot SDK to npm

1. `pwsh -NoProfile -File scripts/release.ps1 -BotSdk -CheckOnly` (the next patch version; or add `X`).
   ✔ `ALL CHECKS GREEN: bot SDK X would go ahead.`
2. `pwsh -NoProfile -File scripts/release.ps1 -BotSdk` (same version). It bumps `bots/sdk/package.json`, commits
   "Bot SDK X", tags `bots-sdk-vX`, pushes, waits for bots-sdk.yml and checks npm.
   ✔ `ok: iskra-bots X is on npm, with provenance`.

## O. Owner: one-time setup

For the orchestrator, walking the owner through it. Each step that needs the owner's input runs in a PowerShell window
opened for them in `D:\Development_Projects\Iskra` (CLAUDE.local.md): they never copy commands. Background:
[ci-cd.md 2a and section 4](ci-cd.md#2a-the-release-button). Do them in this order; 1-3 make the Release button work,
4-5 remove the Play key file and the release keystore from the routine path.

1. **GitHub Actions setting** (owner, browser): github.com/quikmn/iskra-voice → Settings → Actions → General →
   "Approval for running fork pull request workflows from contributors" → **Require approval for all external
   contributors** → Save. (Today it is "first-time contributors".) Also check Settings → Environments → `release` still
   has deployment branch `main` and no required reviewers.
2. **The runner** (after this branch is merged and pushed): open a normal, not elevated window running
   `scripts\runner-setup.ps1` (`Start-Process pwsh -WorkingDirectory D:\Development_Projects\Iskra -ArgumentList '-NoExit','-File','scripts\runner-setup.ps1'`).
   The owner only watches; it needs gh logged in as the owner. ✔ "Runner 'iskra-home-…' is online on GitHub with the
   label iskra-windows-signing." Then the owner sets Windows → Settings → System → Power → "When plugged in, put my
   device to sleep after" → Never. Check: `gh api repos/quikmn/iskra-voice/actions/runners` lists it online.
3. **The SimplySign seed** (when the owner has a new QR code from Certum: ask infolinia@certum.pl to generate one;
   support@certum.pl is for partners only):
   - In SimplySign Desktop: options → "show the login dialog on start" ticked.
   - Open a window running `scripts\simplysign-setup.ps1 -FromClipboard`. The owner types the account e-mail, snips the
     QR code with Win+Shift+S (decoded offline by `scripts/read-qr.mjs`; the snip is deleted and the clipboard emptied),
     compares the code it shows with the phone app and answers y. Without `-FromClipboard` it asks for the otpauth://
     link or Base32 seed at a hidden prompt; `-Image <file>` reads a saved picture.
     The phone app should scan the same QR, so the phone keeps working too.
   - First test, with the owner watching: the owner logs SimplySign Desktop out (tray → disconnect), then
     `pwsh -NoProfile -File scripts/release.ps1 -CheckOnly` (local) or A0.2. Its first line should end
     "SimplySign logged itself in". If it fails, report it; a second try waits 30 minutes (the pause after a failed
     login). There is no other method: SimplySign's /otpauth + /autologin switches put the seed on a command line and
     were retired.
   - Also try once with the screen locked (the runner may log in while nobody is at the PC).
4. **Google Play without a key file** (owner, Google Cloud console, project `iskra-play`; or the orchestrator writes the
   gcloud lines into a .ps1 and opens it in Notepad for them):
   1. APIs & Services → enable **IAM Service Account Credentials API** (and Security Token Service API if asked).
   2. IAM & Admin → Workload Identity Federation → Create pool: name `github`. Add provider: OpenID Connect, name
      `iskra-voice`, issuer `https://token.actions.githubusercontent.com`, audience: default. Attribute mapping:
      `google.subject` = `assertion.sub`, `attribute.repository_id` = `assertion.repository_id`,
      `attribute.environment` = `assertion.environment`. Attribute condition:
      `assertion.repository_id == '1227290412' && assertion.sub == 'repo:quikmn/iskra-voice:environment:release'`.
   3. IAM & Admin → Service accounts → `iskra-play-publisher` → Principals with access → Grant access: principal
      `principalSet://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/github/attribute.repository_id/1227290412`,
      role **Workload Identity User**. Nothing changes in Play Console (the service account keeps its permissions).
   4. The orchestrator (with the owner's OK) sets two repo variables (not secrets):
      `GCP_WIF_PROVIDER` = `projects/<project number>/locations/global/workloadIdentityPools/github/providers/iskra-voice`,
      `GCP_PLAY_SERVICE_ACCOUNT` = the service account's e-mail. From then on the `play` job uploads, not `play-pc`.
   5. After one release whose `play` job is green: Cloud Console → the service account → Keys → delete the JSON key;
      the owner deletes `devkeys\google-play-service-account.json` (agents never touch devkeys). Optional: org
      policy "Disable service account key creation".
5. **Android built on GitHub** (optional, after 4; Google's reset takes about two days):
   1. Open a window that makes the upload key in the owner's devkeys folder: `keytool -genkeypair -alias upload -keyalg RSA
      -keysize 4096 -validity 10000 -keystore upload.keystore` then `keytool -export -rfc -alias upload -keystore
      upload.keystore -file upload_certificate.pem` (JDK 21's keytool; the owner types a new password and keeps it in
      the password manager).
   2. Play Console → Iskra → Test and release → App integrity → App signing → **Request upload key reset** → reason
      "moving builds to CI" → upload `upload_certificate.pem`. Wait for Google's e-mail.
   3. GitHub → Settings → Environments → New environment `signing`: deployment branches "Selected" → `main`, no
      reviewers. Open a window for `gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD --env signing` (paste the password)
      and one that sets `ANDROID_UPLOAD_KEYSTORE_BASE64` from the file without showing it
      (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('<devkeys>\upload.keystore')) | gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64 --env signing`).
   4. Set the repo variable `ANDROID_BUILD` = `ci`. The next release builds the bundle on GitHub, puts it on Play first
      and attaches Play's APK (signed with the same app key as before). Watch its `android-apk` job.
   5. Once that worked: the release keystore goes to cold storage only (encrypted USB + password manager); it is no
      longer needed for releases.

## Decision table

| You see | Do |
|---|---|
| `STOP [SimplySign] Log in to SimplySign Desktop ...` | Tell the human that exact line; wait for their answer; run the same command again (`-Resume` if the tag is pushed). Never try to log in yourself |
| `no home PC runner` / `home PC offline` (release.ps1 -GitHub) or the run's "The home PC didn't pick up its job in 10 minutes" | Tell the human: switch the home PC on and log in to Windows (or do O.2 if there's no runner). Nothing was changed |
| `Actions setting` (release.ps1 -GitHub) | Tell the human: O.1 |
| "SimplySign isn't logged in and the automatic login didn't help (...)" | Tell the human the line; they log in by hand. "last SimplySign login failed": also tell them to check the seed (O.3). Never run the login or setup scripts yourself |
| A home PC job fails at "Set up runner" with "Refused: ..." | The run wasn't started by the owner on main with Run workflow. Start it with A0 (or the owner presses the button) |
| `N thing(s) to fix before ...` (check phase) | Nothing was changed. Each `- [case]` line is a row below; fix what you may, report the rest to the human, then run the same command again |
| `STOP [<case>]` from release.ps1 | The row below whose text matches the case; then `-Resume` once the cause is fixed (if the tag is pushed) |
| `CI not done` | Wait for CI on main to finish, then run the check again |
| `main is ahead of origin/main` | Local commits aren't on GitHub: report to the human (they push main; CI must pass first) |
| `git cannot push` | Report: the human logs git in (`gh auth setup-git`) |
| `workflow off` | Report the workflow name to the human |
| `Google Play key` / `Android build` / `LiveKit missing` / `missing tool` / `disk space` | Report the line to the human: it's this PC's setup. Never touch devkeys |
| `store setup` / `GitHub setup` | Report the line: mobile/store.json or a GitHub secret/variable (docs/store/README.md, ci-cd.md section 4) is the human's |
| `warning: environment "<name>" has required reviewers` | Not a stop. Tell the human once: Settings → Environments → <name> → untick "Required reviewers" |
| `CI failed on main` | Stop. Report the failing run (`gh run view <id> --log-failed`). A flake: `gh run rerun <id> --failed` once, then check again. Release after main is green |
| `CI didn't pass on vV` / finalize `no green CI run` | Nothing was published. Report the CI run. The human decides: a flake → `gh run rerun <id> --failed`, then `-Resume`; a real failure → fix main, release the next version (never move the tag) |
| `Mac builds not notarized` | Stop and report. Don't finalize |
| `release.yml still running` / `finalize still running` | Wait, then `-Resume` |
| `final checks failed` | A site/web app check: `release.ps1 -Redeploy site` (or `webapp`) once (D/E). Anything else: report |
| `nothing to resume` | Run without `-Resume` (the tag isn't pushed yet) |
| `you're on <branch>` / `working tree has changes` | Stop. Report the branch or the changed files. Don't discard anything |
| `main is behind origin/main` | `git pull --ff-only`, then run the check again once |
| `tag vV already exists` | Stop. Ask the human for the next version. Never move tags |
| `must be newer than the current version` | Stop. Ask for the right version |
| `write the release notes first` | Go to A.1 |
| `doesn't mention the current version` | Stop and report (links.ts or site/index.html is out of sync) |
| `git push` rejected | Stop and report. Never force |
| release.yml failed | Report the failing job: `gh run view <id> --log-failed` (first 40 lines). Stop |
| `isn't validly signed` / `has no timestamp` / `signed by '...'` | Stop and report. Don't upload |
| `certificate expired` / `expires on` warning | Report it; point to ci-cd.md "Windows code signing". Stop if expired |
| `HEAD isn't the vV commit` | Do B.1, then rerun |
| `build-android.ps1 didn't produce` / `Missing ...android-sdk` / `No JDK 21` / `fingerprint isn't in assetlinks.json` | Stop and report (never try another keystore) |
| `files missing on the release` | Check release.yml's run for the tag. If it succeeded since, do B. If it failed, report |
| Finalize `missing (...)` | Stop and report the missing names |
| Finalize `doesn't match (re-upload ...)` | Stop and report. The human decides which build to upload |
| Deploy `site`/`webapp` check failed after 5 minutes | Run that redeploy once (D/E). Still failing: report |
| Deploy `server` failed | Report the log (`--log-failed`). The server rolled back by itself. Don't retry without the human |
| `Host key verification failed` | Stop. The droplet's host key changed; the human must check it |
| `STOP [phones]` | The release is out. Read which part: `TestFlight build failed` → the mobile-ios.yml rows below; `Google Play upload failed` → ci-cd.md troubleshooting (Play rows). Fixed by the human (or a flake): `-Resume` once |
| `App Store Connect stopped: …` in mobile-ios.yml | Report the line. `couldn't process build` / `no external TestFlight group` / `already approved` / `REVIEW_INVITE_URL` (unset or revoked: a one-time never-expiring invite, docs/store/README.md): the human (ci-cd.md troubleshooting) |
| mobile-ios.yml: `Cloud signing permission error`, `No profiles for 'foo.iskra.app'`, `No Account for Team`, `agreement` | Stop. The human must fix the Apple side (ci-cd.md, "iOS app" and troubleshooting) |
| mobile-ios.yml archive fails on signing | Rerun once with `-f archive_signing=automatic`. Fails again: stop and report |
| mobile-ios.yml upload: `bundle version` / `redundant binary` | `gh run rerun <id>` once (the build number rises with the attempt) |
| `outage` issue open | Do [J](#j-outage-alert). Report what fails; the droplet and DNS are the human's |
| Anything else | Stop and report the exact message |

## Report format

```
Task: <release V | redeploy site | ...>
Result: done | stopped at <section.step>
Release: https://github.com/quikmn/iskra-voice/releases/tag/vV
Runs: release.yml <url> (<conclusion>), release-finalize.yml <url> (<conclusion>), deploy.yml <url> (<conclusion>)
Checks: iskra.foo <ok/fail>, app.iskra.foo <ok/fail>, chat.iskra.foo <ok/fail>, Latest = vV <yes/no>
Phones: TestFlight <uploaded/failed>, Google Play <on the 'alpha' track/skipped/failed>
Problem (if stopped): <exact message>, what you tried, what the human needs to do
```
Leave out lines that don't apply. No other prose.
