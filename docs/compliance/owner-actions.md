# Owner actions

Things only the owner can do: account settings, vendor consoles, decisions and records. Each one closes an
`owner-action` row in the [controls matrix](controls-matrix.md). Tick them off by editing this file (date in the
last column) and updating the matrix in the same commit. Menu names change over time; the intent stays the same.

| # | Action | Matrix rows | Done |
|---|---|---|---|
| 1 | MFA everywhere | ISO 5.17, 8.5; CC6.1 | |
| 2 | GitHub secret scanning and push protection | ISO 8.12; CC6.1, CC7.1 | |
| 3 | GitHub private vulnerability reporting | ISO 5.24, 8.8; CC2.3 | |
| 4 | Dependabot alerts and security updates | ISO 8.8; CC7.1 | |
| 5 | Code scanning alerts (CodeQL, Scorecard) reviewed | ISO 8.8, 8.29; CC7.1 | |
| 6 | Ruleset on `main` | ISO 8.4, 8.32; CC8.1 | |
| 7 | `release` environment: reviewers, branches, environment secrets | ISO 8.2, 8.32; CC6.3, CC8.1 | |
| 8 | Offline backup of keys and recovery codes | ISO 8.13; A1.2 | |
| 9 | Off-site backups for chat.iskra.foo | ISO 8.13, 8.14; A1.2 | |
| 10 | Uptime monitoring for the hosted services | ISO 8.16; A1.1, CC7.2 | |
| 11 | Yearly real restore test | ISO 5.30; A1.3 | |
| 12 | Accept vendors' DPAs and confirm Resend use | ISO 5.19, 5.20; GDPR Art. 28; P6 | |
| 13 | Name a backup contact | ISO 5.24; CC2.3 | |
| 14 | Yearly review (policies, access, risks, security.txt) | ISO 5.1, 5.35, 5.36; CC4.1 | |
| 15 | Owner devices hardened | ISO 8.1, 7.x; CC6.8 | |
| 16 | Decide licensing before selling | ISO 5.31, 5.32 | |
| 17 | Update the privacy policy for the security log | GDPR Art. 13 | |
| 18 | Revoke or confirm dead the secrets in old public history | ISO 5.17, 8.12; CC6.1 | |

## 1. Turn on MFA everywhere

Use a passkey or hardware key where offered, otherwise an authenticator app. Save recovery codes to the offline
backup (action 8).

- **GitHub:** avatar → Settings → Password and authentication → Two-factor authentication → Enable; then
  Passkeys → Add a passkey. Check "Sessions" and remove unknown ones.
- **Apple ID** (Developer Program, App Store Connect): account.apple.com → Sign-In and Security → Two-Factor
  Authentication (on for developer accounts); add a security key under Security Keys. In App Store Connect → Users
  and Access, check only expected users and API keys exist.
- **Google** (Play Console account): myaccount.google.com → Security → 2-Step Verification → Turn on; add a passkey.
- **Cloudflare:** My Profile → Authentication → Two-Factor Authentication → Add (security key or app). Also
  Manage Account → Members: only the owner.
- **DigitalOcean:** Settings → Security → Two-factor authentication → Enable (or sign in with an MFA-protected
  GitHub/Google account). Check Team members.
- **Certum / SimplySign:** already a phone code per session; protect the Certum shop account with a strong unique
  password and MFA if offered.
- **Domain registrar** for iskra.foo: turn on 2FA and registrar lock; check auto-renew.
- **Mailbox** that receives spark@iskra.foo (it can reset everything above): 2FA with a passkey.
- **KLIPY, Resend (if used), Ko-fi, PayPal:** 2FA in each account's security settings.

## 2. GitHub secret scanning and push protection

Repo → Settings → Code security (or "Advanced Security") → **Secret Protection: Enable**, then **Push protection:
Enable**. Free for public repositories. Alerts appear under Security → Secret scanning. The CI's gitleaks job
(`.github/workflows/secrets.yml`) is the second line.

## 3. Private vulnerability reporting

Repo → Settings → Code security → **Private vulnerability reporting: Enable**. Reports then arrive as draft
security advisories (Security → Advisories), as [SECURITY.md](../../SECURITY.md) promises.

## 4. Dependabot alerts and security updates

Repo → Settings → Code security → **Dependency graph: Enable**, **Dependabot alerts: Enable**, **Dependabot
security updates: Enable**. Version updates are already configured in `.github/dependabot.yml`. Notifications:
avatar → Settings → Notifications → Dependabot alerts → email.

## 5. Review code scanning

CodeQL already runs from `.github/workflows/codeql.yml` (advanced setup) and Scorecard from `scorecard.yml`; don't
also turn on CodeQL "default setup" (they conflict). Weekly with the Dependabot PRs: Security → Code scanning →
triage new alerts (fix, or dismiss with a reason). Look at the Scorecard checks once after the first run and note
any accepted findings (e.g. "Code-Review" for a solo maintainer) in the risk register.

## 6. Ruleset on `main`

Repo → Settings → Rules → Rulesets → New ruleset → New branch ruleset: name "main", Enforcement **Active**, target
the default branch. Turn on:

- **Restrict deletions** and **Block force pushes**.
- **Require status checks to pass**: add the CI jobs (`server`, `client`, `desktop`, `end-to-end`,
  `release-scripts`, `backup-restore-drill`, the CodeQL `analyze` jobs, `gitleaks`) once they've run on a PR.
- **Require a pull request before merging**: recommended once there's a second person. For a solo maintainer it
  slows releases (`npm run release` commits to main and pushes atomically with the tag); if you turn it on, add
  yourself to the bypass list and use it only for the release commit. Record the choice in the risk register (R1).
- Optional: **Require signed commits** (set up SSH commit signing first: `git config gpg.format ssh`).

## 7. The `release` environment

Repo → Settings → Environments → `release` ([docs/ci-cd.md](../ci-cd.md) §4 "GitHub"):

- **Required reviewers:** add yourself; tick "Prevent self-review" only once there's a second reviewer.
- **Deployment branches and tags:** Selected → `main`.
- **Environment secrets:** add `CLOUDFLARE_API_TOKEN` and `DROPLET_SSH_KEY` here, run `deploy.yml` once to check,
  then delete the repo-level copies (Settings → Secrets and variables → Actions).

## 8. Offline backup of keys and recovery codes

Copy `D:\Development_Projects\devkeys` (Apple p12 and password file, Android keystore and password, droplet CI key),
`~/.ssh/iskrapersonalvoip`, and the MFA recovery codes onto an encrypted USB stick (BitLocker To Go or VeraCrypt),
plus a password-manager entry with the passwords. Keep the stick away from the PC. Yearly: check the copies open
(docs/ci-cd.md §5 already lists this).

## 9. Off-site backups for chat.iskra.foo

Daily backups stay on the droplet's disk. Pick one or both:

- **DigitalOcean backups:** droplet → Backups → Enable (weekly or daily snapshots of the whole droplet; paid).
- **Encrypted download:** in the app, Settings → Backup & move → Make backup (strong passphrase from the password
  manager); store the file off the droplet (e.g. the encrypted USB stick or a cloud drive). At least weekly, or
  script it with `iskra-server backup` and `--passphrase-stdin` from a cron job that copies the file elsewhere.

## 10. Uptime monitoring

Add a free external monitor (e.g. UptimeRobot, Better Stack or Cloudflare Health Checks) for
`https://chat.iskra.foo/` (expects JSON `{"iskra":1,...}`), `https://iskra.foo/` and `https://app.iskra.foo/`, alerting
to the owner's email/phone. Also turn on DigitalOcean Monitoring alerts (droplet → Monitoring → Create alert policy:
CPU > 90 %, disk > 85 %, memory > 90 % for 10 min). Add the monitor vendor to the vendor register.

## 11. Yearly real restore test

Take the newest off-site chat.iskra.foo backup, restore it on the PC into a new folder (`iskra-server restore …`),
start it with `"LocalOnly": true` in its server.json, check members, recent messages and the server key, time it,
then delete the folder. Record date and duration in [policies/backup-and-recovery.md](policies/backup-and-recovery.md).

## 12. Vendor DPAs, and Resend

Cloudflare (Dashboard → Manage Account → Configurations → Data Processing Addendum, or its self-serve DPA page),
DigitalOcean (legal DPA page, accepted with the terms), GitHub (GitHub DPA, part of the customer agreement): confirm
each applies to your account and save a PDF copy with the date. Decide whether Resend is used (`send.iskra.foo`
DNS records exist, no code uses it); if not, delete the DNS records and the account; if yes, accept its DPA and add it
to the privacy policy. Update [policies/vendor-register.md](policies/vendor-register.md).

## 13. Backup contact

Ask a trusted person to be the incident backup contact, agree what they may do (e.g. power off the droplet from the
DigitalOcean console via team access you grant only during an incident, or post a notice), and put their name in
[policies/incident-response.md](policies/incident-response.md) (phone number offline only).

## 14. Yearly review (every October)

- Re-read every policy in [policies/](policies/), update facts, bump the version and add a change-log line.
- Access review (policy [access-control.md](policies/access-control.md) "Access review").
- Update the risk register and the matrix statuses.
- Renew `security.txt` before its `Expires:` date (site/.well-known/security.txt and
  client/public/.well-known/security.txt), then deploy the site and web app.
- Check the GDPR position: no IMY registration is needed in Sweden for a controller; a DPO is not required (Art. 37)
  unless processing grows to large-scale monitoring.

## 15. Owner devices

On the Windows PC: BitLocker on (Settings → Privacy & security → Device encryption / BitLocker), Windows Update
automatic, screen lock after a few minutes, Microsoft Defender on. Phone: passcode, OS updates. Consider a passphrase
on `~/.ssh/iskrapersonalvoip` (`ssh-keygen -p -f ~/.ssh/iskrapersonalvoip`) with the agent for convenience.

## 16. Licensing before selling

The code is under PolyForm Noncommercial 1.0.0. Before selling the software or a hosted service, decide the
commercial licence (and contributor terms, if there are outside contributors), a legal entity, and customer
documents (terms, DPA, SLA). Get legal advice.

## 17. Privacy policy: keep it in step with the security log

[site/privacy.html](../../site/privacy.html) §3, §10 and §13 describe the security log (account key, event and time,
365 days, no IP addresses), retention and Download my data; deploy the site with the release that ships them. The
security log records IP addresses only if a server's owner turns on **Record IP addresses in the security log**
(Settings → Security log → Data retention, `Retention.SecurityLogIps`). Leave it off on chat.iskra.foo, or, if you turn
it on (for example during an attack), update privacy.html §3 first and say for how long.

## 18. Old secrets in public git history

gitleaks found possible secrets in the retired v1 code that is still in the public history (tags `v1-final`,
`v1.0`). They are suppressed by fingerprint in `.gitleaksignore` so the scan stays green; history isn't rewritten.
Treat them as public and make sure none still works:

- a **Google API key** in `iskra_client/index.html` (commit `b408220b`): Google Cloud console → APIs & Services →
  Credentials → delete (or restrict and rotate) the key;
- a **TURN credential** in `servers/*/server.json` (commit `820d3897`) and the old README (`5fde3fe2`): rotate it at the
  TURN provider or confirm the server is gone;
- a **password** in `iskra_client/iskra_client/Program.cs` (`499e1e67`): change it wherever it was used.

Record "revoked"/"confirmed dead" with the date in this file.
