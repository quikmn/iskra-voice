# Secure development lifecycle

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.1, 2026-11-03 |
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
| Static analysis (CodeQL: C#, JS/TS, workflows, Android Java, Python) | `.github/workflows/codeql.yml` | PRs, weekly on main |
| Secret scanning (gitleaks) | `.github/workflows/secrets.yml`, `.gitleaks.toml` | Every push and PR |
| Supply-chain posture (OpenSSF Scorecard) | `.github/workflows/scorecard.yml` → code scanning | PRs, weekly on main |
| Dependency updates (npm, NuGet, pip, Actions) with a 7-day cooldown; Dependabot alerts | `.github/dependabot.yml`, repo settings | Weekly; alerts as advisories appear |

Every bug gets a regression test. A change is done when all of CI is green (checked after it lands, see Review).

## Review

What actually happens (solo maintainer working with AI coding agents):

- Most changes land on main as local merges or direct commits, not through pull requests; the only regular PRs are
  Dependabot's. `main` has no branch protection or ruleset yet, so nothing in GitHub forces a review or a green CI
  before a change lands. The owner decides what is merged and looks at the change (the diff or the agent's report of
  it) first; there is no second reviewer.
- Before pushing to main, the full local set of checks is run (tests, type-check, gitleaks; the owner's standing rule),
  and CI runs on every push. CI isn't a merge gate, but it is a release gate: `release-finalize.yml` refuses to
  publish unless CI passed on the tagged commit.
- Security-relevant changes (auth, permissions, crypto, file handling, workflows) get a second look with the
  [ASVS self-assessment](../asvs-l2-self-assessment.md) in mind, often as a separate review pass by an agent.
- AI coding agents work in their own branch and git worktree, following [CLAUDE.md](../../../CLAUDE.md). They run
  with the owner's git and `gh` credentials, so they *can* push, release or change settings; they're told not to
  unless the owner asks, and a `release-runner` agent ships releases when asked. That is an instruction, not a
  technical control.
- Releases go only through `scripts/release.ps1` or the Release button (the same checks): every check runs first and
  any red stops it before anything changes ([docs/ci-cd.md](../../ci-cd.md)).
- Planned to close the gap: a ruleset on main (no force-push or deletion; tags `v*` and `bots-sdk-v*` limited to the
  owner) and, for agents, a token that can't push to main or change settings
  ([owner-actions.md](../owner-actions.md) #6).

## Release integrity

Releases are built by GitHub workflows (Linux, macOS) or on the owner's PC (Windows, Android) and published by
`release-finalize.yml`, which checks every file and the auto-update hashes, writes `SHA256SUMS.txt`, creates
build-provenance attestations and attaches CycloneDX SBOMs. Windows binaries are code-signed and timestamped; macOS
builds are signed with the Developer ID and notarized ([docs/ci-cd.md](../../ci-cd.md)).

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
| 2026-11-03 | Review section describes the real process (direct commits, agents with the owner's credentials, no branch protection yet); CodeQL and Dependabot coverage |
