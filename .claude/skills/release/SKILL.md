---
name: release
description: Release a new Iskra version end to end (notes, version bump and tag, push, Linux/macOS build, signed Windows build and APK, publish, deploy, server update) by following docs/ci-cd-playbook.md. Also "/release deploy site|webapp|server [version]" for deploys without a release.
argument-hint: <version> | deploy site|webapp|server [version] | finalize <version> | ci
disable-model-invocation: true
context: fork
agent: release-runner
---

Task: $ARGUMENTS

Follow `docs/ci-cd-playbook.md` exactly (read it first, in full):

- A version like `2.0.0-alpha.10` → section **A. Full release** with V = that version: it runs `scripts/release-all.ps1` (dry run first) and you only act on a `STOP [case]` line, by the decision table. If neither `docs/releases/NEXT.md` has V's notes nor `docs/releases/V.md` exists, ask the human for the notes (offer a draft from `git log --oneline` since the previous tag) before anything else.
- `deploy site` → **D**; `deploy webapp` → **E**; `deploy server [V]` → **F**; `finalize V` → **C**; `checksums V` → **G**; `ci` → **H**.
- No arguments → ask which version to release.

Ask the human to log in to SimplySign Desktop before the Windows step, and to approve `release` environment runs if GitHub asks. Stop and report on any failure the playbook's decision table doesn't cover. End with the playbook's report format.
