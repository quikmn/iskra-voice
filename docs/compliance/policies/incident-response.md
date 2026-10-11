# Incident response plan

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10, and after every incident |
| Applies to | Security incidents and personal data breaches affecting the Iskra software, its release pipeline, iskra.foo, app.iskra.foo or chat.iskra.foo |

## Contacts

| Who | How | When |
|---|---|---|
| Incident lead: Viktor Lundgren | spark@iskra.foo (and phone, kept offline) | Always |
| Backup contact | *To be named by the owner* (name, phone, what they may do: e.g. take chat.iskra.foo offline from the DigitalOcean console) | If the lead can't be reached for 24 h during an incident |
| Swedish data protection authority, Integritetsskyddsmyndigheten (IMY) | imy.se → "Anmäl personuppgiftsincident" (e-service) | Personal data breach on a service the owner runs, within 72 h |
| Vendors | GitHub, Cloudflare, DigitalOcean, Apple, Google, Certum support / abuse contacts (see [vendor-register.md](vendor-register.md)) | Compromised account or credential at that vendor |
| Police (Polisen) | 114 14 / polisen.se; 112 if someone is in danger | Crime, threats, child sexual abuse material |
| Reporters | Reply to the reporter's email / GitHub advisory | Throughout, per [SECURITY.md](../../../SECURITY.md) |

## Severity

| Level | Examples | Start within |
|---|---|---|
| **Critical** | Leaked signing key or CI secret; remote code execution on chat.iskra.foo; bypass of E2EE or authentication; malicious release published | Immediately (same day) |
| **High** | Data exposure on chat.iskra.foo; permission bypass; compromised vendor account without known misuse | 24 h |
| **Medium** | Vulnerability with limited impact; availability incident of a hosted service over 4 h | 3 days |
| **Low** | Hardening issue, failed attack with no effect | Next working week |

## Phases

1. **Detect and record.** Sources: SECURITY.md reports, GitHub code-scanning / Dependabot / secret-scanning alerts,
   CI failures, the server's security log (Settings → Security log, `security.log.list`) and audit log,
   `journalctl -u iskra`, vendor notifications, users. Open a private incident note (date, reporter, what's known)
   — a private GitHub security advisory works for software issues.
2. **Assess.** Severity, what data and which systems, whether personal data is affected (→ breach procedure below),
   whether self-hosters are affected (→ advisory).
3. **Contain.** As fits: revoke/rotate the credential (procedures in [docs/ci-cd.md](../../ci-cd.md) §4); disable the
   `release` environment or require reviewers; mark a bad release prerelease so auto-update stops offering it
   (docs/ci-cd.md §6); stop the `iskra` service or power off the droplet from the DigitalOcean console; block
   accounts on chat.iskra.foo (ban); take the site down by deploying a maintenance page.
4. **Preserve evidence.** Before wiping anything: copy `journalctl -u iskra`, the security and audit logs (JSON
   export), workflow run logs, the affected release files and their hashes, and a DigitalOcean snapshot of the
   droplet. Keep them read-only with the incident note.
5. **Eradicate and recover.** Fix the cause, ship a patch release through the normal pipeline, rebuild hosts from
   known-good images if compromise is suspected, restore data from a backup known to be clean
   ([backup-and-recovery.md](backup-and-recovery.md)).
6. **Notify** (below).
7. **Learn.** Within two weeks: a short post-incident review (timeline, cause, what worked, what to change), new
   regression tests, updates to the [risk register](risk-register.md) and policies. Publish a GitHub security advisory
   for software vulnerabilities once a fix is out.

## Personal data breaches (GDPR Art. 33 and 34)

Applies to services the owner controls (iskra.foo, app.iskra.foo, chat.iskra.foo). On other people's servers the
server owner is the controller; the owner's role there is to fix the software and tell them quickly.

- **Within 72 hours** of becoming aware: notify IMY unless the breach is unlikely to result in a risk to people's
  rights and freedoms. If not everything is known, notify with what is known and add the rest later (Art. 33(4)).
- **Without undue delay:** tell affected people directly when the risk is high (Art. 34), e.g. by a notice on
  chat.iskra.foo and in the app's server announcement channel. Not needed if the data was unintelligible to the
  attacker (e.g. only end-to-end encrypted ciphertext leaked) — record the reasoning.
- **Always** record every breach, even unreported ones, in the incident log (Art. 33(5)): facts, effects, actions.

### Template: notification to IMY (fields of IMY's e-service)

> Controller: Viktor Lundgren ("From a Spark"), Sweden, spark@iskra.foo. Service: chat.iskra.foo (Iskra server).
> When it happened / when discovered: … What happened: … Categories and approximate number of people: … Categories
> and approximate number of records: … (e.g. display names, server channel messages; end-to-end encrypted DMs are
> ciphertext the server can't read). Likely consequences: … Measures taken and proposed: … Have the people been
> informed: yes/no, how, when. Contact: spark@iskra.foo.

### Template: notice to users

> **Security notice for chat.iskra.foo, <date>.** On <date> we found that <what happened in one sentence>. This
> affected <what data> of <who>. Your direct messages and group chats are end-to-end encrypted and were <not> affected.
> We have <what we did>. What you can do: <e.g. replace your account key in Settings → Recovery key, update the app>.
> Questions: spark@iskra.foo.

### Template: advisory to self-hosters

> **Iskra security update <version>.** A <severity> issue in <component> could let <who> <do what> on servers running
> <affected versions>. Update to <version> (desktop apps update themselves; standalone servers: download the new
> iskra-server, docs/hosting.md). If you run a server, check <what to look for, e.g. entries in Settings → Security
> log>. Details: GitHub security advisory <id>. Thanks to <reporter>.

## Incident log

Kept privately by the owner (not in this public repo). Each entry: id, dates (start, detected, contained, closed),
severity, summary, personal data involved (yes/no), IMY notified (date/reason not), users notified, root cause,
follow-ups.

## Exercise

Once a year, walk through one scenario (e.g. "the Cloudflare CI token leaked in a log", "chat.iskra.foo disk lost")
using this plan and docs/ci-cd.md; record it in the change log.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
