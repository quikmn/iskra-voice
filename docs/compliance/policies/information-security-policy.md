# Information security policy

| | |
|---|---|
| Owner | Viktor Lundgren ("From a Spark"), maintainer — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10 (yearly, or after a major change or incident) |
| Applies to | The Iskra source code and release pipeline, iskra.foo, app.iskra.foo, chat.iskra.foo, and every account and credential used to build or run them |

## Purpose

Protect the confidentiality, integrity and availability of Iskra's users' data, the software they run, and the
services the owner operates, and be able to show how.

## Principles

1. **Trust as little as possible.** Accounts are keys held on users' devices; the server trusts nothing a client says
   about itself; direct messages, group chats and their calls are end-to-end encrypted so even the operator can't
   read them ([docs/security.md](../../security.md)).
2. **Collect as little as possible.** No email, phone number, password, analytics or tracking
   ([site/privacy.html](../../../site/privacy.html)). Logs never contain message content, invite codes,
   passphrases or keys.
3. **Secure by default.** Defaults are the safe choice (localhost-only test servers, encrypted backup downloads,
   GIFs off until an admin turns them on, profile page scripts only behind the desktop app's network wall).
4. **Everything through the pipeline.** Production changes are made by the release and deploy workflows, not by hand
   ([change-management.md](change-management.md)).
5. **Evidence over promises.** A control counts when there is a test, a workflow run or a file that shows it
   ([controls-matrix.md](../controls-matrix.md)).

## Roles

| Role | Who | Responsibilities |
|---|---|---|
| Maintainer / security owner | Viktor Lundgren | Everything in this policy: development, review, releases, operations, incident response, vendor management, yearly review |
| Backup contact | *To be named* (see [incident-response.md](incident-response.md)) | Can be reached if the maintainer is unavailable during an incident; has no standing access |
| Server owners (self-hosters) | Each owner | Their own server, its members' data and its moderation (terms §8) |
| Contributors | Anyone via pull request | Follow [secure-development.md](secure-development.md); no access to secrets or production |

With one person, segregation of duties isn't possible; compensating controls are automated checks (CI, CodeQL,
attestations) and approval gates on the `release` environment. Adding a second maintainer is a goal.

## Policy statements

- **Access:** least privilege, MFA on every account that can change code, releases, DNS or servers
  ([access-control.md](access-control.md)).
- **Development:** follow the secure development lifecycle ([secure-development.md](secure-development.md)).
- **Change:** production changes go through [change-management.md](change-management.md).
- **Vulnerabilities:** handled per [vulnerability-management.md](vulnerability-management.md) and
  [SECURITY.md](../../../SECURITY.md).
- **Incidents:** handled per [incident-response.md](incident-response.md), including GDPR breach notification
  within 72 hours.
- **Backups and continuity:** [backup-and-recovery.md](backup-and-recovery.md).
- **Suppliers:** recorded and reviewed in [vendor-register.md](vendor-register.md).
- **Data:** kept only as long as listed in [data-retention.md](data-retention.md); processing recorded in
  [records-of-processing.md](records-of-processing.md).
- **Assets and risks:** [asset-inventory.md](asset-inventory.md), [risk-register.md](risk-register.md).
- **Secrets** are never committed, printed or logged ([docs/ci-cd.md](../../ci-cd.md) §7); they live in GitHub
  secrets, the owner's `devkeys` folder (with an offline copy) or the server's world folder.
- **Acceptable use:** owner devices used for Iskra keep full-disk encryption, a screen lock, automatic OS updates
  and no shared user accounts.

## Exceptions

Exceptions are written down (in the relevant policy's change log or the risk register) with a reason and an end date.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
