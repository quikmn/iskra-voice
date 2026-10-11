# Compliance

This folder is Iskra's security and privacy **evidence pack**: which controls exist, where they live in the code and
the pipeline, which ones still need the owner (or, later, a company) to act, and the policies that tie them together.

## What "compliance-ready" means here

- **Controls are built in and documented.** For SOC 2 (Trust Services Criteria: Security, Availability,
  Confidentiality, Privacy), ISO/IEC 27001:2022 Annex A, the GDPR, OWASP ASVS 4.0.3 Level 2 and OWASP MASVS, the
  [controls matrix](controls-matrix.md) says how Iskra meets each relevant control, where the evidence is, and
  how far along it is.
- **No certificate, no audit.** Iskra has not been audited or certified against any of these frameworks, and no
  penetration test by a third party has been done. Nothing in this folder claims otherwise. The statuses are a
  self-assessment by the maintainer.
- **Honest statuses.** `met` means the control exists and there is evidence for it in the repo or its CI runs.
  `partial` means some of it exists. `owner-action` means only the owner can do it (an account setting, a signature,
  a decision). `n/a` means the control doesn't apply, with the reason given.

The goal is that someone buying, funding or auditing Iskra can see in an afternoon what's in place and what's left,
and that a formal audit later starts from evidence instead of from zero.

## Scope

| In scope | Notes |
|---|---|
| The open-source software: server (`server/`), web client (`client/`), desktop app (`desktop/`), iOS shell (`mobile/`), Android TWA (`android/`), bot SDK (`bots/`) | Built, tested and released from this repository by the GitHub workflows in `.github/workflows/` |
| The owner's hosted services: **iskra.foo** (site), **app.iskra.foo** (web app files), **chat.iskra.foo** (the owner's own Iskra server on a DigitalOcean droplet) | Run by Viktor Lundgren ("From a Spark"), Sweden, the GDPR controller for these (see [site/privacy.html](../../site/privacy.html)) |
| The build and release pipeline, the credentials it uses, and the owner's accounts at vendors | [docs/ci-cd.md](../ci-cd.md) §4 is the credential inventory |

**Out of scope:** servers that other people run. Every Iskra server owner is the controller for the data on their
server (privacy policy §1, terms §8). This pack helps them too (retention settings, the security log, data exports,
backups), but their own operations are theirs to document.

## What's covered

- **Technical controls in the product:** key-based authentication with signed handshakes, server-side permission
  checks on every request and broadcast, end-to-end encryption for DMs, group chats and their calls, rate and size
  limits, upload content checks, SSRF-safe link previews, security headers and TLS 1.2+, encrypted backups, a
  security event log with configurable retention, owner-configurable data retention, a "Download my data" export,
  account deletion across servers. See [docs/security.md](../security.md) for the user-facing description.
- **Pipeline controls:** CI on three OSes, CodeQL, Dependabot with a cooldown, actions pinned to commit SHAs,
  minimal workflow permissions, a protected `release` environment, build-provenance attestations, SHA256SUMS,
  CycloneDX SBOMs on releases, OpenSSF Scorecard, secret scanning in CI (gitleaks), an automated backup/restore drill.
- **Documentation:** the policies in [policies/](policies/), the [controls matrix](controls-matrix.md), the
  [ASVS L2 self-assessment](asvs-l2-self-assessment.md) and the [owner actions](owner-actions.md).

## What still needs a company or more people

These can't be met by code or by one person, and are marked as such in the matrix:

- **Segregation of duties.** One person writes, reviews, releases and operates. Mitigations: required CI checks,
  CodeQL, environment approval steps, attestations. A second maintainer with review rights is the real fix.
- **HR controls:** background screening, employment terms, NDAs, disciplinary process, onboarding/offboarding.
- **Security awareness training** with records.
- **Formal management review** and an internal audit programme (a yearly self-review is recorded instead).
- **Independent assessment:** an external penetration test, a SOC 2 Type I/II audit or ISO 27001 certification audit.
- **Insurance** (cyber liability) and a legal entity to hold contracts.
- **Customer contracts:** a data processing agreement (DPA) template for organisations that would buy hosting, an
  SLA, and a subprocessor notification process. Today nobody buys anything: chat.iskra.foo is a free friend server.
- **Licensing for sale.** The code is under the PolyForm Noncommercial License 1.0.0 ([LICENSE](../../LICENSE)).
  Selling the software or a hosted service needs a licensing decision by the owner first.

## Documents

| Document | What it is |
|---|---|
| [controls-matrix.md](controls-matrix.md) | SOC 2, ISO 27001:2022 Annex A, GDPR, ASVS, MASVS → how, evidence, status |
| [asvs-l2-self-assessment.md](asvs-l2-self-assessment.md) | OWASP ASVS 4.0.3 Level 2, chapter by chapter |
| [owner-actions.md](owner-actions.md) | Things only the owner can do, with click steps |
| [policies/information-security-policy.md](policies/information-security-policy.md) | The top-level policy |
| [policies/access-control.md](policies/access-control.md) | Accounts, MFA, least privilege, access reviews |
| [policies/secure-development.md](policies/secure-development.md) | Secure development lifecycle |
| [policies/change-management.md](policies/change-management.md) | How changes reach production |
| [policies/incident-response.md](policies/incident-response.md) | Incident response plan, GDPR breach notification |
| [policies/vulnerability-management.md](policies/vulnerability-management.md) | Intake, triage, fix SLAs |
| [policies/backup-and-recovery.md](policies/backup-and-recovery.md) | Backups, RPO/RTO, restore, disaster recovery |
| [policies/vendor-register.md](policies/vendor-register.md) | Vendors and subprocessors |
| [policies/data-retention.md](policies/data-retention.md) | What is kept how long, and how it's deleted |
| [policies/records-of-processing.md](policies/records-of-processing.md) | GDPR Art. 30 records |
| [policies/dpia-screening.md](policies/dpia-screening.md) | DPIA screening for end-to-end encrypted chat |
| [policies/asset-inventory.md](policies/asset-inventory.md) | Accounts, domains, keys, hardware |
| [policies/risk-register.md](policies/risk-register.md) | Top risks and how they're treated |

Related: [docs/security.md](../security.md) (security model), [docs/ci-cd.md](../ci-cd.md) (pipeline and
credentials), [docs/hosting.md](../hosting.md) (operating a server), [SECURITY.md](../../SECURITY.md)
(vulnerability disclosure), [site/privacy.html](../../site/privacy.html) and [site/terms.html](../../site/terms.html).

## Review cadence

- **Yearly (October)** and after any major change: review every policy, the matrix statuses and the risk register;
  record the review in the change log at the bottom of each policy (date, what changed). Next review: **2027-10**.
- **Per release:** keep docs/security.md, the privacy policy and this pack in step with what the app does.
- **When a status changes** (an owner action done, a gap fixed): update the matrix in the same commit.
