# Secure development lifecycle

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10 |
| Applies to | All code in this repository, by the maintainer, contributors and AI coding agents |

## Requirements and design

- **Protocol first.** Every new protocol message is specified in [protocol/PROTOCOL.md](../../../protocol/PROTOCOL.md)
  with size limits before it's implemented, and gets a server test ([CLAUDE.md](../../../CLAUDE.md) rules).
- **Security rules that are never broken** (CLAUDE.md): the server trusts nothing the client says about itself;
  permissions are checked on the server for every request and broadcast; no hand-rolled cryptography (libsodium,
  NSec, well-known maintained libraries), a context string on every signed payload, never a plaintext fallback;
  user content is rendered by React only, never through `dangerouslySetInnerHTML`; never commit secrets, world
  folders or deploy scripts with keys.
- Features that touch identity, encryption, files from users, or network fetches get a short threat note in the
  pull request or the design notes, and an entry in [docs/security.md](../../security.md) when users should know.
- Privacy by default: collect nothing that isn't needed; update [site/privacy.html](../../../site/privacy.html) and
  [records-of-processing.md](records-of-processing.md) when processing changes.

## Implementation

- Validate every input on the server (types, lengths, ranges, allowed values); normalise text and reject invisible
  control characters (`Text.Normalize`, `server/src/Iskra.Server/Sessions/Session.cs`).
- Rate-limit new request types (`server/src/Iskra.Server/Sessions/RateLimiter.cs`).
- Database changes are append-only named migrations (`FeatureMigrations` in `Storage/Store.cs`); shipped migrations
  are never edited.
- Dependencies: prefer the platform and few, maintained packages. Pin versions (lock files, `global.json`), and
  pin GitHub Actions to full commit SHAs with the version as a comment.

## Verification

| Check | Where | When |
|---|---|---|
| Server tests (xUnit, real server + WebSocket clients) | `.github/workflows/ci.yml` job `server`, Windows + Linux | Every push and PR |
| Client tests (vitest) and type-checked build | `ci.yml` job `client` | Every push and PR |
| Desktop unit tests | `ci.yml` job `desktop`, Windows + Linux (+ macOS on PRs, nightly and in release builds) | Every push and PR |
| Interop (TS client ↔ .NET server) and Playwright end-to-end | `ci.yml` jobs `interop` and `end-to-end shard 1/4`…`4/4`, summed up by the job `end-to-end` | Every branch push and PR |
| Release-script tests | `ci.yml` job `scripts-and-drill` | Every push and PR |
| Backup → restore drill with integrity checks | `ci.yml` job `scripts-and-drill` (artifact `restore-drill-report`) | Every push and PR |
| Static analysis (CodeQL: C#, JS/TS, workflows) | `.github/workflows/codeql.yml` | PRs, weekly on main |
| Secret scanning (gitleaks) | `.github/workflows/secrets.yml`, `.gitleaks.toml` | Every push and PR |
| Supply-chain posture (OpenSSF Scorecard) | `.github/workflows/scorecard.yml` → code scanning | PRs, weekly on main |
| Dependency updates (npm, NuGet, Actions) with a 7-day cooldown | `.github/dependabot.yml` | Weekly |

Every bug gets a regression test. A change is done when all of CI is green.

## Review

- Changes are reviewed in a pull request diff (or the commit diff for the solo maintainer) before merging to main;
  CI must be green. Security-relevant changes (auth, permissions, crypto, file handling, workflows) get a second look
  with the [ASVS self-assessment](../asvs-l2-self-assessment.md) in mind.
- AI coding agents work on their own branch and worktree, cannot push, deploy or change GitHub settings, and their
  work is reviewed before it's merged.

## Release integrity

Releases are built by GitHub workflows (Linux, macOS) or on the owner's PC (Windows, Android) and published by
`release-finalize.yml`, which checks every file and the auto-update hashes, writes `SHA256SUMS.txt`, creates
build-provenance attestations and attaches CycloneDX SBOMs. Windows binaries are code-signed and timestamped; macOS
builds are signed with the Developer ID and notarized ([docs/ci-cd.md](../../ci-cd.md)).

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
