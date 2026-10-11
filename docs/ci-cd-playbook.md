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

## Tasks

| The human says | Section |
|---|---|
| "release V" | [A. Full release](#a-full-release) |
| "do the Windows part of V" | [B. Windows step](#b-windows-step) |
| "finalize V" / "publish V" | [C. Finalize only](#c-finalize-only) |
| "redeploy the site" | [D. Redeploy site](#d-redeploy-the-site-iskrafoo) |
| "redeploy the web app" | [E. Redeploy web app](#e-redeploy-the-web-app-appiskrafoo) |
| "update the server (to V)" | [F. Update the server](#f-update-the-server-chatiskrafoo) |
| "fix the checksums of V" | [G. Re-run checksums](#g-re-run-checksums-and-attestations) |
| "is CI green?" | [H. Check CI](#h-check-ci-status) |

## A. Full release

1. **Preflight.**
   ```
   git checkout main
   git pull --ff-only
   git status --porcelain
   gh auth status
   ```
   ✔ `git status --porcelain` prints nothing (or only `docs/releases/V.md`). ✔ gh says "Logged in".
2. **Release notes.** Check `docs/releases/V.md` exists: `Test-Path docs/releases/V.md`.
   - True → read it, check it mentions V and not the old version. Go on.
   - False → if the human gave you notes, write them to `docs/releases/V.md` following `docs/releases/README.md`
     and the previous file in that folder. If not, **stop and ask** for the notes (suggest a draft from
     `git log --oneline v<previous>..main`).
3. **Dry run.** `npm run release -- V --dry-run`
   ✔ Prints `Iskra <old> -> V`, links.ts 1 occurrence, site/index.html ≥ 20 occurrences, and no "(dry run, ignored)" lines.
4. **Bump and tag.** `npm run release -- V`
   ✔ Ends with `Committed "Version V" and tagged vV.` and prints a `git push` command.
5. **Push.** `git push --atomic origin main vV`
   ✔ Output lists `main -> main` and `[new tag] vV -> vV`.
6. **Watch the Linux/macOS build** (20–40 min).
   ```
   gh run list --workflow release.yml -L 1
   ```
   ✔ The newest run's branch is `vV`. Note its id, then check every few minutes:
   `gh run view <id> --json status,conclusion` until status is `completed`.
   ✔ conclusion `success`. You may continue with step 7 while it runs.
7. **Ask the human:** "Please log in to SimplySign Desktop (6-digit code from the SimplySign app) and tell me when done."
   Wait for the answer.
8. **Windows step:** do [B](#b-windows-step) steps 1–4. It finishes by starting finalize.
9. **Finalize:** do [C](#c-finalize-only) from step 3 (watching).
10. `git checkout main`, then report (format at the end).

## B. Windows step

1. `git fetch --tags` then `git checkout vV`. ✔ `git describe --tags --exact-match` prints `vV`.
2. Make sure the human has logged in to SimplySign (ask, as in A.7).
3. Run in the background (it can take over an hour, mostly waiting for macOS):
   `pwsh -NoProfile -File scripts/release-windows.ps1 V`
4. Read its output when it ends.
   ✔ Sections `Checking signatures` show `Signed:` for 3 files, `Uploaded and checked.`, `All files are on the release.`,
   `Finalize started: <url>`. Note the url.
5. Re-uploading files that are already built: `pwsh -NoProfile -File scripts/release-windows.ps1 V -SkipBuild`.

## C. Finalize only

Use when B uploaded everything but finalize didn't start (or failed and the cause is fixed).
1. Check the files:
   ```
   gh release view vV --json assets --jq '.assets[].name' | Set-Content $env:TEMP\iskra-names.txt
   node scripts/release-assets.mjs names V $env:TEMP\iskra-names.txt
   ```
   ✔ `All 22 expected files are there.`
2. `gh workflow run release-finalize.yml -f tag=vV`
3. `gh run list --workflow release-finalize.yml -L 1` → note the id. Tell the human: "If the release environment asks
   for approval, approve it at <run url>." Check `gh run view <id> --json status,conclusion,jobs` every few minutes.
4. ✔ conclusion `success`, all jobs green (publish, deploy / site, deploy / webapp, deploy / server).
5. Verify:
   - `gh release view --json tagName,isDraft,isPrerelease` → tagName `vV`, both false.
   - **bash** `curl -fsSL https://iskra.foo | grep -c "v$V/"` → a number above 0.
   - **bash** `curl -fsS https://chat.iskra.foo/` → JSON starting `{"iskra":1`.

## D. Redeploy the site (iskra.foo)

1. Changes to `site/` must already be on main on GitHub: `git fetch` then `git status -sb` shows no `ahead`.
2. `gh workflow run deploy.yml -f ref=main -f site=true`
3. Watch as in C.3. ✔ job `site` green (its last steps check that iskra.foo links to the version and that every page in `site/`, such as /terms, /privacy, /support and /delete-account, is served).

## E. Redeploy the web app (app.iskra.foo)

1. Pick the ref: the latest release tag (`gh release view --json tagName --jq .tagName`) unless the human said main.
2. `gh workflow run deploy.yml -f ref=<ref> -f webapp=true`
3. Watch as in C.3. ✔ job `webapp` green (it checks the new index asset is served).

## F. Update the server (chat.iskra.foo)

1. The version must be a published release: `gh release view vV --json isDraft --jq .isDraft` → `false`.
   Default V: the latest release (`gh release view --json tagName --jq .tagName`, without the `v`).
2. `gh workflow run deploy.yml -f server_version=V`
3. Watch as in C.3. ✔ job `server` green. Its log ends with `chat.iskra.foo answers`.

## G. Re-run checksums and attestations

Use after files on a published release were replaced.
1. Check the files as in C.1.
2. `gh workflow run release-finalize.yml -f tag=vV -f deploy=false`
3. Watch as in C.3. ✔ job `publish` green. Then **bash** `gh release download vV -p SHA256SUMS.txt -O - | head -3` shows `<hash>  <name>` lines.

## H. Check CI status

1. `gh run list -L 10`
2. For each `failure` on main: `gh run view <id> --log-failed` and report the failing job and the first error lines. Don't fix it unless asked.

## Decision table

| You see | Do |
|---|---|
| `Release stopped: you're on <branch>` / `working tree has changes` | Stop. Report the branch or the changed files. Don't discard anything |
| `main is N commit(s) behind origin/main` | `git pull --ff-only`, then retry once |
| `tag vV already exists` | Stop. Ask the human for the next version. Never move tags |
| `must be newer than the current version` | Stop. Ask for the right version |
| `write the release notes first` | Go to A.2 |
| `doesn't mention the current version` | Stop and report (links.ts or site/index.html is out of sync) |
| `git push` rejected | Stop and report. Never force |
| release.yml failed | Report the failing job: `gh run view <id> --log-failed` (first 40 lines). Stop |
| `SimplySign isn't logged in` / `signing failed during the build` | Ask the human to log in to SimplySign, then rerun B.3 once |
| `isn't validly signed` / `has no timestamp` / `signed by '...'` | Stop and report. Don't upload |
| `certificate expired` / `expires on` warning | Report it; point to ci-cd.md "Windows code signing". Stop if expired |
| `tag vV isn't on GitHub yet` | Do A.5, then rerun |
| `HEAD isn't the vV commit` | Do B.1, then rerun |
| `android\build.ps1 didn't produce` / `Missing ...android-sdk` | Stop and report |
| `still missing files after 60 minutes` | Check release.yml (A.6). If it succeeded since, do C. If it failed, report |
| Finalize waiting for approval | Tell the human to approve at the run url. Wait |
| Finalize `missing (...)` | Stop and report the missing names |
| Finalize `doesn't match (re-upload ...)` | Stop and report. The human decides which build to upload |
| Deploy `site`/`webapp` check failed after 5 minutes | Rerun that deploy once (D/E). Still failing: report |
| Deploy `server` failed | Report the log (`--log-failed`). The server rolled back by itself. Don't retry without the human |
| `Host key verification failed` | Stop. The droplet's host key changed; the human must check it |
| Anything else | Stop and report the exact message |

## Report format

```
Task: <release V | redeploy site | ...>
Result: done | stopped at <section.step>
Release: https://github.com/quikmn/iskra-voice/releases/tag/vV
Runs: release.yml <url> (<conclusion>), release-finalize.yml <url> (<conclusion>), deploy.yml <url> (<conclusion>)
Checks: iskra.foo <ok/fail>, app.iskra.foo <ok/fail>, chat.iskra.foo <ok/fail>, Latest = vV <yes/no>
Problem (if stopped): <exact message>, what you tried, what the human needs to do
```
Leave out lines that don't apply. No other prose.
