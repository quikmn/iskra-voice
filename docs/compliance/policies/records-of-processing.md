# Records of processing activities (GDPR Art. 30)

| | |
|---|---|
| Controller | Viktor Lundgren ("From a Spark"), Sweden — spark@iskra.foo |
| Representative / DPO | None. Controller established in the EU (no Art. 27 representative); no DPO required (Art. 37: no large-scale systematic monitoring or special-category processing as a core activity) |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10, and whenever processing changes |
| Source of truth for users | [site/privacy.html](../../../site/privacy.html) |

The Art. 30(5) exemption for organisations under 250 people may apply, but these records are kept anyway because
processing on chat.iskra.foo is not occasional. Servers run by other people are their owners' processing, not
recorded here.

## 1. iskra.foo (website)

| | |
|---|---|
| Purpose | Information about Iskra, downloads, legal pages |
| Legal basis | Legitimate interest (Art. 6(1)(f)): delivering and protecting the site |
| Data subjects | Visitors |
| Personal data | IP address, user agent, request details, processed by the host |
| Recipients | Cloudflare (hosting, DDoS protection); GitHub when a visitor follows a download link |
| Transfers outside the EEA | Cloudflare (US): DPF / SCCs |
| Retention | Cloudflare's short-lived logs; the owner stores nothing (no analytics, cookies or trackers) |
| Security | HTTPS only (Cloudflare), static files, no forms, deploys through `deploy.yml` in the protected `release` environment |

## 2. app.iskra.foo (web app delivery)

| | |
|---|---|
| Purpose | Delivering the web app's files to browsers and phones |
| Legal basis | Legitimate interest (Art. 6(1)(f)) |
| Data subjects | App users |
| Personal data | IP address, user agent, request details, processed by the host. Once loaded, the app talks directly to the servers the user joins; nothing about the user's chats reaches app.iskra.foo |
| Recipients | Cloudflare |
| Transfers | Cloudflare (US): DPF / SCCs |
| Retention | Cloudflare's short-lived logs |
| Security | HTTPS; `_headers`: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP (`client/public/_headers`) |

## 3. chat.iskra.foo (the owner's Iskra server "Hangout")

| | |
|---|---|
| Purpose | Running a voice and text chat server for the owner's friends: accounts, channels, messages, files, voice, DMs and group chats (E2EE), notifications, moderation, security |
| Legal basis | Contract / service requested (Art. 6(1)(b)): providing the server the member joined. Legitimate interest (Art. 6(1)(f)): security logging, abuse prevention, moderation, backups. Legal obligation (Art. 6(1)(c)) where authorities require it |
| Data subjects | Members (friends of the owner; 13+), people mentioned in content, reporters |
| Personal data | Account and device public keys, display name, profile (avatar, bio, pronouns, colour, status, profile page), nickname, roles, join time, rules accepted; server channel messages, edits, files, reactions, polls, pins, threads, forum posts, events, emoji/stickers/sounds; per-server settings and block list; push subscriptions; DM and group chat ciphertext with sender/recipient/time/size metadata and group membership; call metadata; reports; audit log; security log (account key, event, time; IP address only if the owner turns on `Retention.SecurityLogIps`, off on chat.iskra.foo); presence and connection IPs in memory |
| Special categories | Not sought. Members may write about anything in server channels; not processed for any purpose beyond storing and showing it |
| Recipients | Other members per channel permissions; DigitalOcean (hosting); browsers' Web Push services (encrypted notifications); Let's Encrypt (certificate for the domain); websites fetched for link previews (see the server IP only); KLIPY only if GIFs are turned on |
| Transfers | DigitalOcean (US company, data in Amsterdam): DPF / SCCs. Push services (US): DPF / SCCs; payload end-to-end encrypted to the device |
| Retention | [data-retention.md](data-retention.md) |
| Security | [docs/security.md](../../security.md), [controls-matrix.md](../controls-matrix.md); E2EE for DMs/groups/calls; HTTPS with TLS 1.2+; firewall (ufw); automatic OS security updates; encrypted backup downloads |
| Rights | Access/portability: Settings → Privacy & data → Download my data (`data.export`), or email; rectification: edit profile, messages; erasure: delete messages, leave, Delete account, or email; objection/restriction: email |

## 4. Email to spark@iskra.foo

| | |
|---|---|
| Purpose | Support, safety reports, security reports, data-subject requests |
| Legal basis | Legitimate interest (answering); legal obligation (data-subject requests, reporting illegal content) |
| Data subjects | People who write |
| Personal data | Email address, name, message content and attachments |
| Recipients | Cloudflare Email Routing (forwarding), the owner's mailbox provider; authorities where required |
| Retention | [data-retention.md](data-retention.md) ("Apps and websites") |

## 5. Software distribution (GitHub releases, desktop updates)

| | |
|---|---|
| Purpose | Distributing and updating the apps |
| Legal basis | Legitimate interest |
| Personal data | IP address and app version seen by GitHub when the desktop app checks for and downloads updates |
| Recipients | GitHub (US): DPF / SCCs |
| Note | The owner doesn't receive these logs |

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
| 2026-10-12 | No push relay, APNs or FCM: the phone apps notify while open |
