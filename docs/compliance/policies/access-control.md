# Access control policy

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10 |
| Applies to | Administrative accounts and credentials for the code, pipeline and hosted services; access control inside the Iskra product |

## 1. Administrative access

### Accounts and MFA

Every account below must have multi-factor authentication. Prefer a passkey or hardware security key; an
authenticator app is acceptable; SMS only where nothing else is offered. Recovery codes are kept offline with the
devkeys backup. Step-by-step: [owner-actions.md](../owner-actions.md#1-turn-on-mfa-everywhere).

| Account | Why it matters | MFA required |
|---|---|---|
| GitHub (`quikmn`) | Source, workflows, secrets, releases | Yes (passkey/hardware key) |
| Apple ID (Developer Program, App Store Connect) | macOS signing, notarization, iOS app | Yes (Apple's two-factor is mandatory) |
| Google (Play Console "From a Spark") | Android app listing | Yes |
| Cloudflare | DNS for iskra.foo, Pages for iskra.foo and app.iskra.foo, email routing | Yes |
| DigitalOcean | The chat.iskra.foo droplet and its console | Yes |
| Certum / SimplySign | Windows code-signing certificate | Yes (SimplySign phone code per session) |
| Domain registrar for iskra.foo | Domain ownership | Yes |
| Email mailbox receiving spark@iskra.foo | Password resets for everything above, security reports | Yes |
| KLIPY Partner Panel, Resend (if used), Ko-fi, PayPal | Lower impact | Yes where offered |

### Least privilege

- CI uses the automatic `GITHUB_TOKEN` with `permissions: {}` or read-only at the top of each workflow, widened per
  job ([.github/workflows/](../../../.github/workflows/)). No personal access tokens are stored.
- The Cloudflare CI token is scoped to Pages and Workers Scripts on one account.
- The droplet's CI SSH key has a forced command (`iskra-update-ci`) that only accepts a version number
  ([docs/ci-cd.md](../../ci-cd.md) §4 "The server").
- Release and deploy secrets are used only in jobs running in the `release` environment; moving
  `CLOUDFLARE_API_TOKEN` and `DROPLET_SSH_KEY` into that environment is an owner action.
- The admin SSH key for the droplet stays on the owner's Windows PC (with an offline backup).

### Joiners, movers, leavers

Today there is one person. When someone gets access: record it in the [asset inventory](asset-inventory.md), give
the least access that works, require MFA, and remove it the day it's no longer needed (rotate any shared secret
they could read, per docs/ci-cd.md §4).

### Access review

Yearly (with the policy review) and after any incident: list GitHub collaborators, deploy keys, Actions secrets and
variables, environment reviewers, Cloudflare API tokens, droplet `authorized_keys`, Apple API keys; remove what's
unused. Record the date in the change log below.

## 2. Access control in the product

- **Authentication** is a signature over a fresh server challenge by a device key certified by the account key; no
  passwords ([PROTOCOL.md](../../../protocol/PROTOCOL.md), `server/src/Iskra.Server/Sessions/Session.cs`).
  Revoked devices are refused; deleted or rotated accounts are refused with a reason.
- **Authorisation** is checked on the server for every request and every broadcast, against the member's role and
  custom roles at that moment (`server/src/Iskra.Server/Sessions/Permissions.cs`). Channel overrides are checked
  for every message, upload, voice join and broadcast.
- **Roles:** `guest < member < trusted < admin < owner`, plus custom roles that only add permissions; managers can't
  grant permissions they don't hold. Owner-only: limits, backups, move, import, retention, the security log.
- **Joining** needs a valid invite (expiring, optionally single-use) or a single-use bot invite.
- **Moderation and admin actions** are recorded in the audit log; security events in the security log.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
