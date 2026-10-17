# Controls matrix

How Iskra meets each relevant control, where the evidence is, and the honest status. Self-assessed by the maintainer
on 2026-10-11; not audited. See [README.md](README.md) for scope and what the statuses mean.

**Status:** `met` — in place with evidence · `partial` — some of it, gap noted · `owner-action` — needs the owner
(account setting, decision, record; see [owner-actions.md](owner-actions.md)) · `n/a` — doesn't apply, reason given.

Short names used below: **SEC** = [docs/security.md][sec] · **CICD** = [docs/ci-cd.md][cicd] · **HOST** =
[docs/hosting.md][host] · **PRIV** = [site/privacy.html][priv] · **CI** = [ci.yml][ci] · **POL/x** =
[policies/x.md](policies/) · **OA n** = [owner-actions.md](owner-actions.md) item n · **SecLog** = the server's
security log (`security_log` table, `security.log.list`, Settings → Security log) · **Audit** = the admin audit log
(`audit.list`).

## 1. SOC 2 — Trust Services Criteria (2017, revised points of focus 2022)

### Common criteria (Security)

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| CC1.1 Integrity and ethical values | Terms with community guidelines; maintainer commitments in policies | [site/terms.html][terms], POL/information-security-policy | partial |
| CC1.2 Board oversight | One-person project; no board | — | n/a |
| CC1.3 Structures, reporting lines, authority | Roles table (maintainer, backup contact, server owners, contributors) | POL/information-security-policy | partial |
| CC1.4 Competence, hiring, training | No employees; no training records | — | owner-action |
| CC1.5 Accountability | Maintainer owns every policy; yearly review recorded in change logs | policies/*, OA 14 | partial |
| CC2.1 Quality information for internal control | CI results, code scanning, SecLog, Audit, release attestations | [CI][ci], [codeql.yml][codeql] | met |
| CC2.2 Internal communication of objectives and responsibilities | CLAUDE.md rules for every contributor and agent; policies in the repo | [CLAUDE.md][claude], [policies/](policies/) | met |
| CC2.3 External communication | Privacy policy, terms, security notes, SECURITY.md, security.txt, release notes | PRIV, SEC, [SECURITY.md][secmd], `/.well-known/security.txt` | met |
| CC3.1 Objectives specified | Purpose and principles | POL/information-security-policy | met |
| CC3.2 Risk identification and analysis | Risk register with scoring | POL/risk-register | met |
| CC3.3 Fraud risk | Release tampering and account takeover considered (R2, R3); signing keys in HSM / offline | POL/risk-register, CICD §4 | met |
| CC3.4 Changes affecting controls | Yearly review and review on major change | README "Review cadence" | partial |
| CC4.1 Ongoing / separate evaluations | Continuous CI, CodeQL, Scorecard; no independent evaluation | CI, [scorecard.yml][scorecard] | partial |
| CC4.2 Communicating deficiencies | Gaps tracked in this matrix and risk register; advisories for vulnerabilities | this file, POL/vulnerability-management | met |
| CC5.1 Control activities selected | Controls mapped in this matrix | this file | met |
| CC5.2 Technology general controls | Pinned actions, minimal permissions, protected `release` environment | [.github/workflows/][wf], CICD §1 | met |
| CC5.3 Policies and procedures deployed | Policies + runbooks (CI/CD playbook, hosting guide) | policies/, [ci-cd-playbook.md][playbook], HOST | met |
| CC6.1 Logical access security | Key-based auth with signed challenge; MFA on admin accounts required | [Session.cs][session], POL/access-control, OA 1 | owner-action |
| CC6.2 User registration and authorisation | Joining needs an invite (expiring, single-use option; optionally a moderator's approval); admins can pause every invite (AutoMod's join-flood rule does it by itself) and slow newcomers; bot invites single-use | [InviteFeature.cs][invite], `JoinFeature.cs`, [BotFeature.cs][bot] | met |
| CC6.3 Role-based access, least privilege | Roles and custom roles checked server-side per request; CI least privilege | [Permissions.cs][perms], [RoleTests.cs][roletests] | met |
| CC6.4 Physical access | Cloudflare and DigitalOcean data centres (vendors' reports) | POL/vendor-register | met |
| CC6.5 Disposal of assets | Uploads swept, retention sweeper, account deletion; droplet destroy wipes per DigitalOcean | [UploadSweeper.cs][upsweep], POL/data-retention | met |
| CC6.6 External threats at the boundary | Firewall (ufw) on the droplet; rate and size limits; LiveKit API on 127.0.0.1; HTTPS redirect | CICD §4 "The server", [RateLimiter.cs][rate] | met |
| CC6.7 Data in transit | TLS 1.2+ with HSTS; E2EE for DMs/groups/calls; encrypted Web Push | [Program.cs][program], SEC | met |
| CC6.8 Malicious software | Signed/notarized apps, attestations, CodeQL, gitleaks; owner device hardening | CICD §1, [secrets.yml][secretsyml], OA 15 | partial |
| CC7.1 Detection of vulnerabilities and config changes | Dependabot, CodeQL, Scorecard, gitleaks; GitHub secret scanning to enable | [dependabot.yml][dependabot], OA 2–5 | owner-action |
| CC7.2 Monitoring for anomalies | SecLog (auth failures, rate limits, new devices); no external uptime monitoring yet | SecLog, OA 10 | partial |
| CC7.3 Evaluating security events | Severity levels and triage | POL/incident-response | met |
| CC7.4 Incident response | Plan with containment steps, evidence, notification templates | POL/incident-response | met |
| CC7.5 Recovery from incidents | Rollback, restore procedure, post-incident review | POL/backup-and-recovery, POL/incident-response | met |
| CC8.1 Change management | Release pipeline with tests, approvals, attestations; ruleset on main pending | POL/change-management, CICD §2, OA 6–7 | owner-action |
| CC9.1 Business disruption risk mitigation | RPO/RTO, backups, restore drill | POL/backup-and-recovery, CI job `scripts-and-drill` | partial |
| CC9.2 Vendor and partner risk | Vendor register; DPAs to confirm | POL/vendor-register, OA 12 | owner-action |

### Availability

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| A1.1 Capacity | Upload quotas, size limits, rate limits; droplet with swap; no capacity monitoring | HOST `server.json` reference, OA 10 | partial |
| A1.2 Backups and recovery infrastructure | Daily backups (same disk, optionally copied to another disk or share with `Backups.CopyTo`, and off-site to backup buddies: friends' Iskra servers, encrypted with a recovery code only the owner has), encrypted downloads (the CI restore drill proves the buddy copy restores); off-site copies for chat.iskra.foo pending | [BackupService.cs][backupsvc], [BuddyBackupService.cs][buddysvc], [BuddyHolder.cs][buddyholder], OA 8–9 | owner-action |
| A1.3 Recovery testing | Automated backup → restore drill on every CI run, also restoring the off-site backup-buddy copy from its recovery code; yearly real restore pending | CI `scripts-and-drill` (artifact `restore-drill-report`), [RestoreDrillTests.cs][drill], OA 11 | partial |

### Confidentiality

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| C1.1 Identify and protect confidential information | Classification in the asset inventory; E2EE for private conversations; secrets `0600`; private channels never leak | POL/asset-inventory, SEC | met |
| C1.2 Disposal of confidential information | Configurable retention, disappearing messages (per conversation, kept out of backups), account deletion, prekey deletion for forward secrecy | POL/data-retention, [RetentionSweeper.cs][retention], [DisappearFeature.cs][disappear] | met |

### Privacy

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| P1 Notice | Privacy policy covering apps, servers, websites | PRIV | met |
| P2 Choice and consent | No consent-based processing; opt-ins for activity status, GIF auto-load, notifications (profile page scripts need no opt-in: they run only where they can't reach the network) | PRIV §2, §7–8 | met |
| P3 Collection | Minimal: no email/phone/password/analytics | PRIV "short version" | met |
| P4 Use, retention, disposal | Retention table and sweepers | POL/data-retention | met |
| P5 Access | Download my data (`data.export`), edit profile and messages | [DataExports.cs][export], PRIV §13 | met |
| P6 Disclosure to third parties | Vendor register; no sale or sharing; DPAs to confirm | POL/vendor-register, OA 12 | owner-action |
| P7 Quality | Users edit their own profile and messages | PRIV §11 | met |
| P8 Monitoring and enforcement | Complaints to spark@iskra.foo or IMY; incident plan | PRIV §13, POL/incident-response | met |

## 2. ISO/IEC 27001:2022 Annex A

### 5 Organizational controls

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| 5.1 Policies for information security | Policy set with owner and review date | POL/information-security-policy | met |
| 5.2 Roles and responsibilities | Roles table; one person | POL/information-security-policy | met |
| 5.3 Segregation of duties | Not possible with one person; compensating CI, approvals, attestations | POL/risk-register R1 | partial |
| 5.4 Management responsibilities | Maintainer is management; yearly review | OA 14 | owner-action |
| 5.5 Contact with authorities | IMY, police listed | POL/incident-response | met |
| 5.6 Contact with special interest groups | Follows upstream advisories (.NET, Electron, LiveKit, libsodium); no formal memberships | POL/vulnerability-management | partial |
| 5.7 Threat intelligence | Dependabot/GitHub advisories, CodeQL, Scorecard | POL/vulnerability-management | partial |
| 5.8 Information security in project management | Protocol-first rule, threat notes, security docs per feature | POL/secure-development, [CLAUDE.md][claude] | met |
| 5.9 Inventory of information and assets | Asset inventory + credentials inventory | POL/asset-inventory, CICD §4 | met |
| 5.10 Acceptable use | Owner device rules; terms for users | POL/information-security-policy, [site/terms.html][terms] | met |
| 5.11 Return of assets | No staff or lent equipment | — | n/a |
| 5.12 Classification of information | Four levels | POL/asset-inventory | met |
| 5.13 Labelling of information | Classification column in the inventory; no document labelling scheme | POL/asset-inventory | partial |
| 5.14 Information transfer | TLS, E2EE, encrypted backups (passphrase sealed to the server key) | SEC | met |
| 5.15 Access control | Policy and product access control | POL/access-control | met |
| 5.16 Identity management | Accounts are keys; device certificates; signed per-server key log (key transparency) with client-side checks and gossip; admin accounts listed | POL/access-control, POL/asset-inventory | met |
| 5.17 Authentication information | Recovery keys user-held; secrets in GitHub/devkeys; third-party keys a server holds (KLIPY key, the Feeds bot's Twitch app secret) stay in `iskra.db`, never sent to apps, removable by admins/the owner (docs/security.md, Feeds); MFA and old v1 secrets to handle | OA 1, OA 18 | owner-action |
| 5.18 Access rights | Yearly access review defined | POL/access-control "Access review" | owner-action |
| 5.19 Supplier relationships | Vendor register with checks before adding | POL/vendor-register | met |
| 5.20 Security in supplier agreements | DPAs to confirm and file | OA 12 | owner-action |
| 5.21 ICT supply chain | Pinned actions, lock files, Dependabot cooldown, SBOMs, attestations, Scorecard | CICD §1, [release-finalize.yml][finalize] | met |
| 5.22 Supplier service monitoring | Yearly vendor review | POL/vendor-register "Review" | partial |
| 5.23 Cloud services | Cloudflare and DigitalOcean usage, tokens scoped, DNS documented | CICD §4 | met |
| 5.24 Incident management planning | Plan, severities, contacts; backup contact to name | POL/incident-response, OA 13 | partial |
| 5.25 Assessment of security events | Triage and severity table | POL/incident-response | met |
| 5.26 Response to incidents | Containment and recovery steps | POL/incident-response | met |
| 5.27 Learning from incidents | Post-incident review within two weeks | POL/incident-response | met |
| 5.28 Collection of evidence | Evidence preservation step (logs, SecLog/Audit export, snapshots) | POL/incident-response | met |
| 5.29 Security during disruption | Same controls apply in restore procedure (hardening steps) | POL/backup-and-recovery | met |
| 5.30 ICT readiness for business continuity | RPO/RTO defined, CI restore drill; real restore yearly | POL/backup-and-recovery, OA 11 | partial |
| 5.31 Legal, statutory, regulatory requirements | GDPR records, terms, export compliance note for iOS | POL/records-of-processing, [mobile/README.md][mobile] | met |
| 5.32 Intellectual property rights | PolyForm Noncommercial licence; dependency licences in SBOMs; licensing decision before sale | [LICENSE][license], OA 16 | partial |
| 5.33 Protection of records | Git history, workflow logs, incident log kept privately | POL/incident-response, POL/data-retention | met |
| 5.34 Privacy and protection of PII | Privacy by design, retention, export, deletion, RoPA, DPIA screening | PRIV, POL/records-of-processing, POL/dpia-screening | met |
| 5.35 Independent review | None yet (no external audit or pen test) | README "What still needs…" | owner-action |
| 5.36 Compliance with policies | Yearly self-review | OA 14 | owner-action |
| 5.37 Documented operating procedures | CI/CD playbook, hosting guide, restore procedure | [ci-cd-playbook.md][playbook], HOST, POL/backup-and-recovery | met |

### 6 People controls

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| 6.1 Screening | No staff | — | n/a |
| 6.2 Terms and conditions of employment | No staff | — | n/a |
| 6.3 Awareness, education, training | Maintainer only; no training programme or records | — | owner-action |
| 6.4 Disciplinary process | No staff | — | n/a |
| 6.5 Responsibilities after termination | Leaver steps for future access (rotate shared secrets) | POL/access-control "Joiners, movers, leavers" | partial |
| 6.6 Confidentiality / NDAs | No staff; would be needed with a second maintainer | — | n/a |
| 6.7 Remote working | Owner device rules (encryption, lock, updates) | POL/information-security-policy, OA 15 | owner-action |
| 6.8 Information security event reporting | SECURITY.md, security.txt, in-app reports, spark@iskra.foo | [SECURITY.md][secmd], PRIV | met |

### 7 Physical controls

Hosted services run at Cloudflare and DigitalOcean, whose data-centre controls are covered by their own audits
(vendor register). The owner's workplace is a home office.

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| 7.1 Physical security perimeters | Vendor data centres | POL/vendor-register | met |
| 7.2 Physical entry | Vendor data centres | POL/vendor-register | met |
| 7.3 Securing offices, rooms, facilities | Home office; no dedicated facility | — | n/a |
| 7.4 Physical security monitoring | Vendor data centres | POL/vendor-register | met |
| 7.5 Physical and environmental threats | Vendor data centres; code in git elsewhere | POL/vendor-register | met |
| 7.6 Working in secure areas | No secure areas | — | n/a |
| 7.7 Clear desk and clear screen | Screen lock on owner devices | OA 15 | owner-action |
| 7.8 Equipment siting and protection | Servers at vendors | POL/vendor-register | met |
| 7.9 Assets off-premises | Encrypted laptop/PC and offline USB | OA 8, OA 15 | owner-action |
| 7.10 Storage media | Encrypted USB for key backups | OA 8 | owner-action |
| 7.11 Supporting utilities | Vendor data centres | POL/vendor-register | met |
| 7.12 Cabling security | Vendor data centres | — | n/a |
| 7.13 Equipment maintenance | Vendors; owner devices auto-update | OA 15 | met |
| 7.14 Secure disposal or re-use | Droplet destroy per DigitalOcean; wipe owner devices before disposal | POL/asset-inventory | partial |

### 8 Technological controls

| Control | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| 8.1 User endpoint devices | App: keys encrypted at rest, app lock (passphrase and/or passkeys with WebAuthn PRF). Owner devices: hardening to confirm | SEC "Your keys on your device", OA 15 | partial |
| 8.2 Privileged access rights | Owner-only server functions; forced-command CI key; scoped tokens; environment secrets to move | POL/access-control, OA 7 | partial |
| 8.3 Information access restriction | Per-request, per-channel permission checks; private channels invisible | [Permissions.cs][perms], [PermissionTests.cs][permtests] | met |
| 8.4 Access to source code | Public repo; write access only the owner; ruleset to add | OA 6 | owner-action |
| 8.5 Secure authentication | Ed25519 challenge-response, device certificates and revocation; passkey (biometric/PIN/security key) app unlock; key transparency against servers swapping keys; MFA on admin accounts | [Session.cs][session], [HandshakeTests.cs][handshake], OA 1 | partial |
| 8.6 Capacity management | Limits and quotas; no capacity alerts | HOST, OA 10 | partial |
| 8.7 Protection against malware | Uploads typed by content and served sandboxed; signed releases; CodeQL | [Uploads.cs][uploads], CICD | met |
| 8.8 Management of technical vulnerabilities | Policy with SLAs, Dependabot, CodeQL, Scorecard; GitHub alert settings pending | POL/vulnerability-management, OA 2–5 | partial |
| 8.9 Configuration management | `server.json` documented; workflows and infrastructure steps in git/docs; droplet config documented, not code | HOST, CICD §4 | partial |
| 8.10 Information deletion | Retention sweeper, upload sweeper, account deletion (moderators' notes about the account included), join requests pruned (7 days; refusals 1 day), empty voice rooms removed | POL/data-retention, [RetentionSweeper.cs][retention] | met |
| 8.11 Data masking | Audit/report entries and the "people who left" entry keep actions with names removed after deletion; join requests show moderators the invite's last characters, never the code or an address; push DM notifications have no content; KLIPY gets a pseudonym | SEC, PRIV | met |
| 8.12 Data leakage prevention | No analytics; link previews fetched by server; gitleaks in CI; push protection pending; old v1 secrets to revoke | [secrets.yml][secretsyml], OA 2, OA 18 | partial |
| 8.13 Information backup | Daily + encrypted backups; off-site to backup buddies (encrypted at the source, signed server-to-server requests, holder quota, versions, rate limits and grace period; [BuddyBackupTests.cs][buddytests]; the CI restore drill also restores the buddy copy); off-site copies for chat.iskra.foo pending | [BackupService.cs][backupsvc], [BuddyBackupService.cs][buddysvc], OA 9 | partial |
| 8.14 Redundancy | Single droplet; static sites on Cloudflare's network | POL/risk-register R9 (accepted) | partial |
| 8.15 Logging | SecLog + Audit (join approvals, refusals and invite pauses included), no content or secrets (moderators' notes never reach the audit log), configurable retention, owner export | [ComplianceFeature.cs][seclog], [ModerationFeature.cs][moderation], [ComplianceTests.cs][compliancetests] | met |
| 8.16 Monitoring activities | Owner reviews SecLog; no automated alerting/uptime monitor | OA 10 | partial |
| 8.17 Clock synchronization | Ubuntu 24.04's default NTP client (systemd-timesyncd) on the droplet; not yet checked on the host (`timedatectl`) | CICD §4 "The server" | partial |
| 8.18 Privileged utility programs | CLI commands (`backup`, `restore`, `move`, `import-discord`) need shell access to the world folder | [Cli.cs][cli] | met |
| 8.19 Installation of software on operational systems | Only via `iskra-update` with SHA256SUMS verification and rollback; OS via unattended-upgrades | CICD §4 "The server" | met |
| 8.20 Networks security | ufw allows 22, 80, 443, 7881/tcp, 7882/udp; LiveKit API bound to 127.0.0.1; internal webhook loopback-only (never via the p2p tunnel or a proxy); behind a reverse proxy, PROXY protocol headers only from `Https.ProxyTrustedFrom` | CICD §4, [Program.cs][program] | met |
| 8.21 Security of network services | TLS 1.2/1.3, HSTS and security headers, Let's Encrypt automation; Cloudflare-managed TLS for the sites | [Program.cs][program], [HttpsTests.cs][httpstests], [SecurityHeadersTests.cs][headertests] | met |
| 8.22 Segregation of networks | Voice API local-only; test servers localhost-only (`LocalOnly`) | CLAUDE.md rules, HOST | met |
| 8.23 Web filtering | Link-preview fetcher refuses private addresses; GIF proxy only KLIPY hosts; no corporate web filtering needed | [LinkPreviews.cs][previews] | met |
| 8.24 Use of cryptography | libsodium/NSec primitives, context strings, test vectors, documented design | SEC, [vectors.json][vectors] | met |
| 8.25 Secure development life cycle | SDLC policy, CI on three OSes | POL/secure-development, CI | met |
| 8.26 Application security requirements | Protocol-first with size limits; ASVS self-assessment | [PROTOCOL.md][protocol], [asvs-l2-self-assessment.md](asvs-l2-self-assessment.md) | met |
| 8.27 Secure architecture and engineering principles | Zero trust in clients, E2EE, least privilege, single writer | SEC, [CLAUDE.md][claude] | met |
| 8.28 Secure coding | Rules in CLAUDE.md, CodeQL, React-only rendering, parameterised SQL | [codeql.yml][codeql] | met |
| 8.29 Security testing in development and acceptance | Server permission/safety tests, interop, e2e, CodeQL; no external pen test | CI, [SafetyTests.cs][safetytests] | partial |
| 8.30 Outsourced development | AI agents work on branches without push/deploy rights; reviewed before merge | POL/secure-development "Review" | met |
| 8.31 Separation of dev, test and production | Local and CI test worlds (localhost only); production on the droplet; deploys only via `release` environment | POL/change-management | met |
| 8.32 Change management | Release pipeline, approvals, rollback; ruleset pending | POL/change-management, OA 6–7 | partial |
| 8.33 Test information | Tests generate synthetic data; production data never used | POL/change-management rule 6 | met |
| 8.34 Protection during audit testing | No audits yet; restore tests run localhost-only on copies | OA 11 | n/a |

## 3. GDPR (for services the owner controls)

| Article | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| Art. 5 Principles (lawfulness, minimisation, storage limitation, integrity) | Minimal data, retention limits, security controls | PRIV, POL/data-retention, this matrix | met |
| Art. 6 Lawful basis | Contract and legitimate interest per activity | POL/records-of-processing | met |
| Art. 7 Conditions for consent | Consent isn't relied on | POL/records-of-processing | n/a |
| Art. 8 Children | Minimum age 13 / national age of consent; deletion on request | [site/terms.html][terms] §6, PRIV §12 | met |
| Art. 12 Transparent communication | Plain-language policy; email contact; one month to answer | PRIV | met |
| Art. 13–14 Information to data subjects | Privacy policy covers the security log (IP addresses only if a server's owner opts in), retention and Download my data | PRIV §3, §10, §13 | met |
| Art. 15 Right of access | Download my data in the app (`data.export`); owner export for email requests; moderators' private notes about a person are excluded from that person's export (like reporters' identities) and included in the author's | [DataExports.cs][export], [PROTOCOL.md][protocol] | met |
| Art. 16 Rectification | Edit profile, messages | PRIV §11 | met |
| Art. 17 Erasure | Delete account on every server (`account.delete`: profile, per-server picture, settings, moderators' notes about the account; names blanked in audit, report and people-who-left entries), delete messages, leave; email for chat.iskra.foo | [AccountFeature.cs][account], [site/delete-account.html][delete] | met |
| Art. 18 Restriction | By email request; owner can time out/limit an account | PRIV §13 | partial |
| Art. 19 Notification of rectification/erasure | Account deletion propagates to every reachable server | [AccountFeature.cs][account] | met |
| Art. 20 Portability | JSON export (server) and device export (local data) | [DataExports.cs][export] | met |
| Art. 21 Objection | By email; no direct marketing or profiling | PRIV §13 | met |
| Art. 22 Automated decisions | None with legal or similar effect | POL/dpia-screening | n/a |
| Art. 24 Controller responsibility | Policies and this evidence pack | README | met |
| Art. 25 Data protection by design and default | Keys instead of accounts, E2EE, opt-ins, no analytics, minimal logs; no third-party connections by default (click-to-load embeds and watch parties, GIFs through the server, no STUN servers, no Chromium background connections, listed in-app and in [privacy-connections.md](../privacy-connections.md); `siteConsent.test.ts`, `e2e/privacy.spec.ts`, `desktop npm run test:network`) | SEC, PRIV | met |
| Art. 28 Processors | Vendor register; DPAs to accept and file | POL/vendor-register, OA 12 | owner-action |
| Art. 30 Records of processing | Kept | POL/records-of-processing | met |
| Art. 32 Security of processing | Technical controls in this matrix; ASVS L2 self-assessment | this file, [asvs-l2-self-assessment.md](asvs-l2-self-assessment.md) | met |
| Art. 33 Breach notification to IMY (72 h) | Procedure and template | POL/incident-response | met |
| Art. 34 Communication to data subjects | Procedure and template | POL/incident-response | met |
| Art. 35 DPIA | Screening done; full DPIA not required now | POL/dpia-screening | met |
| Art. 37 DPO | Not required: no large-scale monitoring or special categories as core activity | POL/records-of-processing | n/a |
| Art. 44–49 International transfers | US vendors under DPF/SCCs, stated in the privacy policy | PRIV §9, POL/vendor-register | partial |

## 4. OWASP ASVS 4.0.3 Level 2 (summary)

Details and evidence: [asvs-l2-self-assessment.md](asvs-l2-self-assessment.md).

| Chapter | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| V1 Architecture and threat modeling | Documented trust model; no formal threat model yet | SEC | partial |
| V2 Authentication | Key-based challenge-response; passkeys (WebAuthn PRF) for the local app lock; key transparency log; password items n/a | [Session.cs][session] | met |
| V3 Session management | Authenticated WebSocket per session; no cookies/tokens | [Session.cs][session] | met |
| V4 Access control | Server-side, per request and broadcast | [Permissions.cs][perms] | met |
| V5 Validation, sanitization, encoding | Typed validation, React rendering, SSRF protection, parameterised SQL | [LinkPreviews.cs][previews] | met |
| V6 Stored cryptography | libsodium primitives (plus WebCrypto HKDF for passkey PRF), secrets `0600`, signed hash-chained key log | SEC | met |
| V7 Error handling and logging | SecLog, Audit, generic errors | [ComplianceFeature.cs][seclog] | met |
| V8 Data protection | Encryption at rest on devices, export, deletion; secrets in webhook URLs by design | SEC | partial |
| V9 Communication | TLS 1.2+, HSTS; plain HTTP possible on LAN servers | [Program.cs][program] | partial |
| V10 Malicious code | CodeQL, signed updates, attestations | CICD | met |
| V11 Business logic | Rate limits, quotas, timeouts, join gating (approval invites, paused invites, newcomer slowmode, join-flood rule) | [RateLimiter.cs][rate] | met |
| V12 Files and resources | Content sniffing, sandboxed serving, quotas | [Uploads.cs][uploads] | met |
| V13 API and web service | Documented protocol with limits, tests per message | [PROTOCOL.md][protocol] | met |
| V14 Configuration | Pipeline hardening, server headers; no CSP on app.iskra.foo yet | [client/public/_headers][headers] | partial |

## 5. OWASP MASVS (desktop app, iOS shell, Android TWA)

| Group | How Iskra meets it | Evidence | Status |
|---|---|---|---|
| MASVS-STORAGE | Keys and decrypted DMs encrypted at rest (OS keychain via Electron `safeStorage`; non-extractable WebCrypto key in web views); optional Argon2id app lock | SEC "Your keys on your device" | met |
| MASVS-CRYPTO | libsodium-wrappers-sumo; no custom primitives; shared vectors | [vectors.json][vectors] | met |
| MASVS-AUTH | Device keys certified by the account key; device revocation; app lock (passphrase or passkey; iPhone app passkeys not yet device-verified) | SEC "Your devices" | met |
| MASVS-NETWORK | HTTPS required by web views for remote servers; desktop allows plain HTTP for LAN servers; no certificate pinning (server identity pinned by its Ed25519 key in invites instead) | SEC, HOST | partial |
| MASVS-PLATFORM | Electron: `contextIsolation`, `sandbox`, no `nodeIntegration`, navigation and window-open handlers, permission handler, IPC only from the app page; `iskra://` links only open invites; iOS Universal Links via AASA | [desktop/src/main.ts][main], SEC "The desktop app" | met |
| MASVS-CODE | Dependabot for desktop deps, Electron kept current, signed auto-updates checking publisher | [dependabot.yml][dependabot], CICD §4 | met |
| MASVS-RESILIENCE | Code signing/notarization (Windows, macOS, iOS), Android signed APK; no anti-tampering or obfuscation (open source, not a goal); Linux packages unsigned | CICD §4 | partial |
| MASVS-PRIVACY | No analytics, tracking or crash reporting; activity status opt-in; permissions requested only when used | PRIV §8 | met |

## Status counts

| Framework | Rows | met | partial | owner-action | n/a |
|---|---|---|---|---|---|
| SOC 2 (CC, A, C, P) | 46 | 28 | 10 | 7 | 1 |
| ISO/IEC 27001:2022 Annex A | 93 | 49 | 23 | 12 | 9 |
| GDPR | 24 | 18 | 2 | 1 | 3 |
| OWASP ASVS L2 (chapters) | 14 | 10 | 4 | 0 | 0 |
| OWASP MASVS (groups) | 8 | 6 | 2 | 0 | 0 |

[sec]: ../security.md
[cicd]: ../ci-cd.md
[host]: ../hosting.md
[playbook]: ../ci-cd-playbook.md
[priv]: ../../site/privacy.html
[terms]: ../../site/terms.html
[delete]: ../../site/delete-account.html
[claude]: ../../CLAUDE.md
[license]: ../../LICENSE
[secmd]: ../../SECURITY.md
[protocol]: ../../protocol/PROTOCOL.md
[vectors]: ../../protocol/vectors.json
[mobile]: ../../mobile/README.md
[headers]: ../../client/public/_headers
[main]: ../../desktop/src/main.ts
[wf]: ../../.github/workflows/
[ci]: ../../.github/workflows/ci.yml
[codeql]: ../../.github/workflows/codeql.yml
[scorecard]: ../../.github/workflows/scorecard.yml
[secretsyml]: ../../.github/workflows/secrets.yml
[finalize]: ../../.github/workflows/release-finalize.yml
[dependabot]: ../../.github/dependabot.yml
[program]: ../../server/src/Iskra.Server/Program.cs
[cli]: ../../server/src/Iskra.Server/Cli.cs
[session]: ../../server/src/Iskra.Server/Sessions/Session.cs
[perms]: ../../server/src/Iskra.Server/Sessions/Permissions.cs
[rate]: ../../server/src/Iskra.Server/Sessions/RateLimiter.cs
[invite]: ../../server/src/Iskra.Server/Features/InviteFeature.cs
[bot]: ../../server/src/Iskra.Server/Features/BotFeature.cs
[account]: ../../server/src/Iskra.Server/Features/AccountFeature.cs
[moderation]: ../../server/src/Iskra.Server/Features/ModerationFeature.cs
[previews]: ../../server/src/Iskra.Server/Features/LinkPreviews.cs
[uploads]: ../../server/src/Iskra.Server/Files/Uploads.cs
[upsweep]: ../../server/src/Iskra.Server/Files/UploadSweeper.cs
[backupsvc]: ../../server/src/Iskra.Server/Backups/BackupService.cs
[buddysvc]: ../../server/src/Iskra.Server/Backups/BuddyBackupService.cs
[buddyholder]: ../../server/src/Iskra.Server/Backups/BuddyHolder.cs
[buddytests]: ../../server/tests/Iskra.Server.Tests/BuddyBackupTests.cs
[seclog]: ../../server/src/Iskra.Server/Features/ComplianceFeature.cs
[retention]: ../../server/src/Iskra.Server/Features/RetentionSweeper.cs
[disappear]: ../../server/src/Iskra.Server/Features/DisappearFeature.cs
[export]: ../../server/src/Iskra.Server/Features/DataExports.cs
[permtests]: ../../server/tests/Iskra.Server.Tests/PermissionTests.cs
[roletests]: ../../server/tests/Iskra.Server.Tests/RoleTests.cs
[safetytests]: ../../server/tests/Iskra.Server.Tests/SafetyTests.cs
[handshake]: ../../server/tests/Iskra.Server.Tests/HandshakeTests.cs
[httpstests]: ../../server/tests/Iskra.Server.Tests/HttpsTests.cs
[drill]: ../../server/tests/Iskra.Server.Tests/RestoreDrillTests.cs
[compliancetests]: ../../server/tests/Iskra.Server.Tests/ComplianceTests.cs
[headertests]: ../../server/tests/Iskra.Server.Tests/SecurityHeadersTests.cs
