# Risk register

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10, after incidents, and when a risk's treatment is done |

Scale: likelihood and impact 1 (low) – 3 (high); score = L × I. Treatment: **reduce**, **accept**, **transfer**,
**avoid**.

| # | Risk | L | I | Score | Treatment | Controls / plan | Status |
|---|---|---|---|---|---|---|---|
| R1 | **Single maintainer**: illness or loss of access stops fixes, releases and incident response; no segregation of duties | 2 | 3 | 6 | Reduce | Public code, documented pipeline (docs/ci-cd.md, playbook), self-hosted servers keep working without the owner; name a backup contact; long-term: a second maintainer | Open |
| R2 | **Compromise of the owner's GitHub account** → malicious release to every desktop app via auto-update | 1 | 3 | 3 | Reduce | MFA (passkey), `release` environment reviewers, Windows signing key in an HSM needing a phone code, notarization, attestations; secret scanning | Partly done (owner actions) |
| R3 | **Leak of a signing key or CI secret** (Apple p12, Android keystore, Cloudflare token, droplet CI key) | 1 | 3 | 3 | Reduce | Secrets only in GitHub secrets/devkeys; gitleaks in CI; push protection; least-privilege tokens; forced-command SSH; rotation procedures in docs/ci-cd.md §4 | Open (move secrets to environment) |
| R4 | **Loss of chat.iskra.foo data** (disk failure, droplet deleted, bad migration) | 2 | 2 | 4 | Reduce | Daily backups (same disk), encrypted downloadable backups, `iskra-update` rollback, restore drill in CI; needs off-site copies | Open (off-site backups) |
| R5 | **Vulnerability in the server** (auth, permissions, file handling) exposes members' data | 2 | 3 | 6 | Reduce | Server-side checks on every request, tests, CodeQL, ASVS self-assessment, rate/size limits, security log, fix SLAs | Ongoing |
| R6 | **Vulnerable or malicious dependency** (npm, NuGet, Electron, LiveKit) | 2 | 3 | 6 | Reduce | Lock files, Dependabot with a 7-day cooldown, pinned actions, SBOMs, Scorecard, few dependencies | Ongoing |
| R7 | **Flaw in the end-to-end encryption design or use** | 1 | 3 | 3 | Reduce | libsodium primitives only, context strings, shared test vectors (`protocol/vectors.json`), documented limitations; external crypto review not yet done | Open (external review) |
| R8 | **Abuse / illegal content** on chat.iskra.foo or reports about other servers | 2 | 2 | 4 | Reduce | Terms, reporting, moderation tools, audit log, AutoMod, spark@iskra.foo safety contact, police contact in the incident plan | Ongoing |
| R9 | **Availability of chat.iskra.foo** (single droplet, no redundancy) | 2 | 1 | 2 | Accept | Friend server; RTO 4 h accepted; automatic restart (systemd), OS updates | Accepted |
| R10 | **Metadata exposure** (who talks to whom) on servers | 3 | 1 | 3 | Accept | Inherent to the design; documented in docs/security.md "Limitations" and the privacy policy | Accepted |
| R11 | **Owner's PC compromised** (devkeys, admin SSH key, gh login) | 1 | 3 | 3 | Reduce | Disk encryption, OS updates, MFA, Windows signing key not on disk, offline backup; consider passphrase-protecting the SSH key and moving devkeys into a password manager vault | Open |
| R12 | **Regulatory: personal data breach handled late** or a data-subject request missed | 1 | 2 | 2 | Reduce | Incident plan with 72 h steps and templates, data export and deletion in the app, records of processing | Done |
| R13 | **Commercial use / sale blocked by licensing or missing contracts** | 2 | 2 | 4 | Avoid until decided | PolyForm Noncommercial licence; DPA/SLA templates and a legal entity needed before selling | Open (owner decision) |
| R14 | **Self-hosters run outdated, vulnerable servers** | 3 | 2 | 6 | Reduce | Desktop apps auto-update their bundled server; release notes and advisories; consider an in-app "update available" notice for standalone servers | Open |
| R15 | **Old secrets in public git history** (v1: Google API key, TURN credential, a password) could still be valid | 2 | 2 | 4 | Reduce | Revoke/rotate or confirm dead ([owner-actions.md](../owner-actions.md) §18); suppressed by fingerprint in `.gitleaksignore`; no history rewrite (public tags) | Open (owner action) |

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
