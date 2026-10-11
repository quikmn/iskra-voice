# Asset inventory

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10, and whenever an account, key or host is added or removed |

Credentials (what each one is, where it's stored, who uses it, expiry, how to rotate) are inventoried in
[docs/ci-cd.md §4](../../ci-cd.md#4-secrets-and-credentials) and their renewal dates in
[§5 Refresh calendar](../../ci-cd.md#5-refresh-calendar). This file lists everything else and points there. Never
write a secret value here.

## Information assets

| Asset | Classification | Location | Owner |
|---|---|---|---|
| Source code, workflows, docs | Public | GitHub `quikmn/iskra-voice`; clones on the owner's PC | Owner |
| Design notes (`design/`) | Internal | Owner's PC only (git-ignored) | Owner |
| chat.iskra.foo world: `iskra.db`, `uploads/`, `server.key`, `livekit.key`, `vapid.json`, `certs/`, `backups/` | Confidential (members' data, server secrets) | Droplet `/opt/iskra/world`, `0600`/`0700` | Owner |
| Downloaded encrypted backups of chat.iskra.foo | Confidential (encrypted) | Owner's chosen off-site location | Owner |
| Signing and release keys (Apple Developer ID p12, Android keystore, CI SSH key) | Secret | `D:\Development_Projects\devkeys` + offline copy; GitHub secrets | Owner |
| Push relay credentials (APNs auth key .p8, Firebase service account JSON, relay handle key) | Secret | GitHub environment `release` and the Worker's secrets; the .p8 also in `devkeys` + offline copy | Owner |
| Firebase app config (`iskra-google-services.json`) | Internal (ships inside the APK) | `devkeys` | Owner |
| Admin SSH key `~/.ssh/iskrapersonalvoip` | Secret | Owner's PC + offline copy | Owner |
| Windows code-signing key | Secret | Certum cloud HSM (SimplySign) — not exportable | Owner |
| Security reports, incident log, data-request emails | Confidential | spark@iskra.foo mailbox, private advisories | Owner |

Classification levels: **Public** (anyone), **Internal** (owner and future team), **Confidential** (need-to-know;
encrypted at rest where possible), **Secret** (credentials; never leave their store except to an offline backup).

## Services and accounts

| Service | Account / resource | Notes |
|---|---|---|
| GitHub | User `quikmn`, repo `quikmn/iskra-voice`, environment `release`, Actions secrets/variables | docs/ci-cd.md §4 "GitHub" |
| Cloudflare | Zone `iskra.foo`; Pages `iskra-hero-page` (iskra.foo), `iskra-webclient` (app.iskra.foo); Worker `iskra-push` (push.iskra.foo, the push relay); Email Routing; API tokens `iskra-github-ci`, `iskra-deploy-cf` | docs/ci-cd.md §4 "Cloudflare", "Push relay" |
| DigitalOcean | Droplet "Iskra-Voip-personal-ams3" (AMS3, Ubuntu 24.04, 146.190.236.187) | docs/ci-cd.md §4 "The server" |
| Apple | Developer Program team BWX2M8XSNZ, App IDs `foo.iskra.app` and `foo.iskra.app.NotificationService`, App Store Connect app "Iskra", API key, APNs auth key | docs/ci-cd.md §4 "Apple", "iOS app", "Push relay" |
| Google | Play Console "From a Spark" (not published yet); Firebase project "Iskra" (Cloud Messaging only, no Analytics) and its service account | docs/ci-cd.md §4 "Android", "Push relay" |
| Certum | Open Source Code Signing certificate (2026-05-12 → 2027-05-12) | docs/ci-cd.md §4 |
| Domain registrar | `iskra.foo` | Auto-renew checked yearly |
| Email | spark@iskra.foo (Cloudflare Email Routing → owner's mailbox) | |
| Resend | `send.iskra.foo` DNS records | Confirm use ([vendor-register.md](vendor-register.md)) |
| KLIPY, Ko-fi, PayPal | Partner Panel key (if any), donation pages | Low impact |

## Domains and endpoints

`iskra.foo`, `app.iskra.foo`, `chat.iskra.foo` (A 146.190.236.187, DNS only), `push.iskra.foo` (Worker custom domain), `send.iskra.foo` (Resend records).
Droplet ports: 22, 80, 443, 7881/tcp, 7882/udp (ufw).

## Hardware

| Device | Use | Required protection |
|---|---|---|
| Owner's Windows PC | Development, Windows/Android release builds, admin SSH, `devkeys` | Full-disk encryption (BitLocker), screen lock, automatic updates, MFA-protected accounts |
| Owner's phone | SimplySign codes, authenticator, passkeys | Screen lock, OS updates |
| Offline backup media (encrypted USB) | Copies of `devkeys`, admin SSH key, recovery codes | Encrypted, stored apart from the PC |

## Software components

Each release's components are listed in its CycloneDX SBOMs (attached to the GitHub release). Pinned external
binaries: LiveKit server v1.13.7 (`scripts/get-livekit.*`, checksum-verified), Pebble for tests
(`scripts/get-pebble.ps1`), wrangler (version in `deploy.yml`).

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
| 2026-10-11 | Push relay (Worker, APNs key, Firebase) and the Capacitor Android app |
