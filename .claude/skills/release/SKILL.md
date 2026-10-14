---
name: release
description: Release a new Iskra version end to end with scripts/release.ps1 (checks first, then notes, version bump and tag, push, builds, signing, publish, deploys, phones) by following docs/ci-cd-playbook.md. Also "/release deploy site|webapp|server [version]", "/release resume", "/release phones", "/release bot-sdk".
argument-hint: [<version>] | resume | deploy site|webapp|server [version] | checksums [version] | phones | bot-sdk [version] | ci
disable-model-invocation: true
context: fork
agent: release-runner
---

Task: $ARGUMENTS

Follow `docs/ci-cd-playbook.md` exactly (read it first, in full):

- A version like `2.0.0-alpha.10`, or no arguments (the next alpha) → section **A. Release**: `scripts/release.ps1 -CheckOnly`, then `scripts/release.ps1`; you only act on the check phase's red lines and `STOP [case]` lines, by the decision table. If neither `docs/releases/NEXT.md` has V's notes nor `docs/releases/V.md` exists, ask the human for the notes (offer a draft from `git log --oneline` since the previous tag) before anything else.
- `resume` / `finalize V` → **B**; `deploy site` → **D**; `deploy webapp` → **E**; `deploy server [V]` → **F**; `checksums [V]` → **G**; `ci` → **H**; `phones` → **I**; `bot-sdk [X]` → **M**.

When the script says `Log in to SimplySign Desktop (6-digit code from the app)`, tell the human that line and wait; nothing else needs them during a release (no approvals in GitHub). Stop and report on any failure the playbook's decision table doesn't cover. End with the playbook's report format.
