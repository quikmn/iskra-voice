# OWASP ASVS Level 2 self-assessment

| | |
|---|---|
| Standard | OWASP Application Security Verification Standard **4.0.3**, Level 2 (chapter numbering V1–V14). A mapping to ASVS 5.0 chapters is at the end |
| Target | Iskra server (`server/`), web client (`client/`), desktop shell (`desktop/`), as of 2026-10-11 |
| Assessor | The maintainer (self-assessment; no independent verification) |
| Verdicts | **met**, **partial** (gaps listed), **n/a** (with reason) |

## How Iskra differs from a typical web app

- **No passwords, no cookies, no server-side login sessions.** An account is an Ed25519 key pair on the user's
  devices. Each device has its own key, certified by the account key. To connect, the client signs a fresh 32-byte
  server nonce bound to the server's public key over a WebSocket (`Session.Authenticate` in
  [Session.cs](../../server/src/Iskra.Server/Sessions/Session.cs), [PROTOCOL.md](../../protocol/PROTOCOL.md)). The
  authenticated "session" is that WebSocket connection; nothing reusable is issued.
- Most of ASVS V2 (passwords, credential recovery by email, OTP) and V3 (cookies, session tokens) therefore doesn't
  apply. The equivalent controls (key protection, device revocation, key rotation, connection lifetime) are assessed
  instead.
- HTTP endpoints exist for files, uploads, webhooks, backups, exports and voice signaling; each uses unguessable,
  short-lived or single-purpose capabilities rather than ambient credentials.

## Summary

| Chapter | Verdict |
|---|---|
| V1 Architecture, design and threat modeling | partial |
| V2 Authentication | met (password items n/a) |
| V3 Session management | met (cookie items n/a) |
| V4 Access control | met |
| V5 Validation, sanitization and encoding | met |
| V6 Stored cryptography | met |
| V7 Error handling and logging | met |
| V8 Data protection | partial |
| V9 Communication | partial |
| V10 Malicious code | met |
| V11 Business logic | met |
| V12 Files and resources | met |
| V13 API and web service | met |
| V14 Configuration | partial |

## V1 Architecture, design and threat modeling — partial

| Area | Evidence | Verdict |
|---|---|---|
| Secure SDLC, security requirements | [policies/secure-development.md](policies/secure-development.md), protocol-first rule in [CLAUDE.md](../../CLAUDE.md) | met |
| Threat model | Trust model and limitations in [docs/security.md](../security.md) (who can read what, metadata, key theft race); no formal per-component threat model document | partial |
| Architecture: trust boundaries, single entry points | One WebSocket per session with a single reader/writer; all requests through `Router` ([Router.cs](../../server/src/Iskra.Server/Features/Router.cs)); LiveKit only on localhost | met |
| Access control architecture | Central `Permissions` checks ([Permissions.cs](../../server/src/Iskra.Server/Sessions/Permissions.cs)) | met |
| Crypto architecture | libsodium / NSec only, context strings, shared test vectors ([protocol/vectors.json](../../protocol/vectors.json)) | met |
| Dependencies | Lock files, Dependabot, SBOMs on releases | met |

Gap: write a short STRIDE-style threat model per component (server, client, desktop, voice, release pipeline).

## V2 Authentication — met (password items n/a)

| Area | Evidence | Verdict |
|---|---|---|
| 2.1 Password security, 2.3 lifecycle of passwords, 2.4 credential storage, 2.5 recovery by email/questions, 2.7 out-of-band, 2.8 OTP | No passwords, emails or OTPs exist | n/a |
| 2.2 General authenticator security, anti-automation | Handshake must complete within 5 s, pre-auth frames ≤ 4 KB (`SessionLimits`); per-session and per-account rate limits after auth ([RateLimiter.cs](../../server/src/Iskra.Server/Sessions/RateLimiter.cs), [AccountLimits.cs](../../server/src/Iskra.Server/Sessions/AccountLimits.cs)); failed handshakes are recorded in the security log (the IP address only if the owner turns on `Retention.SecurityLogIps`; bursts per address are capped either way) | met |
| 2.9 Cryptographic verifier | Ed25519 signatures over a server nonce + server key (no replay across servers), device certificates verified, revoked devices refused ([Identity.cs](../../server/src/Iskra.Server/Crypto/Identity.cs)) | met |
| 2.5 Recovery | Recovery key (the account key) shown on request; device linking with a one-time secret, a six-digit confirmation code typed on the signed-in device, and a 5-minute expiry; account key replacement with dual signatures and a dispute window ([docs/security.md](../security.md)) | met |
| 2.10 Service authentication | LiveKit webhooks verified with the world's LiveKit secret and loopback-only; webhook ingress by hashed secret; CI → droplet by forced-command SSH key | met |
| Protection of keys on devices | XChaCha20-Poly1305 at rest with OS keychain (desktop) or non-extractable WebCrypto key (browser), optional Argon2id app lock and/or passkeys: WebAuthn with user verification, whose PRF output (HKDF-SHA256) wraps the data key, so the passkey protects the keys rather than gating a screen ([vault.ts](../../client/src/core/vault.ts), [passkeys.ts](../../client/src/platform/passkeys.ts)); changing the lock needs the current passphrase or passkey | met |
| Key directory integrity (impersonation by a server) | Key transparency: per-server append-only key log, SHA-256 hash chain, head signed with the server's Ed25519 key; clients verify continuity, that shown members/rotations are logged, compare servers, and gossip signed heads in E2EE DMs; problems reach the owner's security log (`keylog.alert`, `keylog.broken`) ([KeyLogFeature.cs](../../server/src/Iskra.Server/Features/KeyLogFeature.cs), [keylog.ts](../../client/src/core/keylog.ts), [security.md](../security.md#key-transparency)) | met (detection, documented limits) |

## V3 Session management — met (cookie items n/a)

| Area | Evidence | Verdict |
|---|---|---|
| 3.2 Session binding, 3.3 termination | The session is the authenticated WebSocket; closes on kick, ban, device revocation, account deletion or key rotation (`Session.End/Kick`); clients re-authenticate with a new nonce on every connect | met |
| 3.4 Cookie-based sessions | No cookies are used | n/a |
| 3.5 Token-based sessions | No bearer session tokens. Capability URLs (upload tickets, DM file links, export links) are random, short-lived and single-purpose | met |
| 3.7 Re-authentication for sensitive actions | Account deletion and key rotation require signatures by the account key with context strings (`iskra/account-delete/v1`); backup passphrases sealed to the server key | met |

## V4 Access control — met

| Area | Evidence | Verdict |
|---|---|---|
| 4.1 Enforced on a trusted service layer, deny by default | Every request type has a server handler that checks permissions; unknown types refused; role read at the moment of each request ([Session.cs](../../server/src/Iskra.Server/Sessions/Session.cs) `CurrentMember`) | met |
| 4.2 Operation-level, IDOR | Channel read/write levels and per-role overrides checked for messages, uploads, voice joins, broadcasts and search; DM files served only to conversation members via signed links ([DmFileFeature.cs](../../server/src/Iskra.Server/Features/DmFileFeature.cs)); private channels never leak | met |
| 4.3 Administrative interfaces | Owner-only: limits, backups, move, import, retention, security log; admin-only audit log (`ViewAuditLog`); role managers can't exceed their own rank | met |
| Tests | [PermissionTests.cs](../../server/tests/Iskra.Server.Tests/PermissionTests.cs), [RoleTests.cs](../../server/tests/Iskra.Server.Tests/RoleTests.cs), [SafetyTests.cs](../../server/tests/Iskra.Server.Tests/SafetyTests.cs) and per-feature tests | met |

## V5 Validation, sanitization and encoding — met

| Area | Evidence | Verdict |
|---|---|---|
| 5.1 Input validation | Typed accessors with maximum lengths and ranges for every field (`Body`), text normalisation that rejects control/format characters (`Text.Normalize`); frame size limits (64 KB) | met |
| 5.2 Sanitization, 5.3 output encoding | React renders all user content; no `dangerouslySetInnerHTML` on user content (CLAUDE.md rule, CodeQL); themes validated value by value; profile pages only in a sandboxed frame with CSP (scripts only in the desktop app's walled page session, `desktop/src/pages.ts`) | met |
| 5.2.6 SSRF | Link previews refuse private/internal addresses on every connection including redirects ([LinkPreviews.cs](../../server/src/Iskra.Server/Features/LinkPreviews.cs)); GIF proxy only fetches signed KLIPY URLs | met |
| 5.3.4 Injection | SQLite through parameterised commands only ([Store.cs](../../server/src/Iskra.Server/Storage/Store.cs)) | met |
| 5.5 Deserialization | JSON only, `System.Text.Json` with explicit types; zip imports validated (entries can't escape the export) | met |

## V6 Stored cryptography — met

| Area | Evidence | Verdict |
|---|---|---|
| 6.2 Algorithms | Ed25519 (NSec/libsodium), XChaCha20-Poly1305, `crypto_box_seal`, `crypto_secretstream`, Argon2id, SHA-256 (key log hash chain), HKDF-SHA256 (WebCrypto, passkey PRF → key-encryption key); no custom primitives | met |
| 6.4 Key management on devices | Data key wrapped per lock method (device wrap, passphrase box, one slot per passkey, ≤ 10); the data key itself never leaves the device; passkeys without PRF are refused | met |
| 6.3 Random values | `RandomNumberGenerator` on the server, libsodium `randombytes` in clients | met |
| 6.4 Secret management | Server secrets in the world folder, `0600` on Linux/macOS; CI secrets in GitHub secrets; no secrets in code (gitleaks in CI) | met |
| 6.1 Data classification / encryption at rest on the server | DMs, group chats and their files are end-to-end encrypted. Server channel data in `iskra.db` is not encrypted at rest (relies on host disk security); downloaded backups are encrypted | met (documented limitation) |

## V7 Error handling and logging — met

| Area | Evidence | Verdict |
|---|---|---|
| 7.1 Log content | Security log (`security_log`, owner-only `security.log.list`) records auth failures (reason; IP address only when the owner opts in), rate-limit hits (throttled), joins, new-device sign-ins, key rotations and disputes, account deletions, device revocations, backups, moves, retention changes, data exports; the audit log records moderation/admin actions. No message text, invite codes, passphrases or keys | met |
| 7.2 Log processing, 7.3 log protection | Stored in the server's database, readable only by the owner (security log) or `ViewAuditLog` holders (audit log); exportable as JSON; retention configurable (`Retention.SecurityLogDays`, `Retention.AuditDays`) | met |
| 7.4 Error handling | Clients get generic errors (`internal`: "Something went wrong on the server."); details only in the server log ([Router.cs](../../server/src/Iskra.Server/Features/Router.cs)) | met |
| 7.3.4 Time source | Host clock; Ubuntu's default NTP client on the droplet (to confirm with `timedatectl`) | partial |

## V8 Data protection — partial

| Area | Evidence | Verdict |
|---|---|---|
| 8.1 Server-side data protection | Files served with `Cache-Control: private`; backups encrypted; daily backups owner-only | met |
| 8.2 Client-side data protection | Keys and decrypted DMs encrypted at rest; push notifications for DMs carry no content | met |
| 8.3 Sensitive private data | Data minimisation (no email/phone/password, no analytics); "Download my data" export (`data.export`); account deletion on every server; retention settings ([policies/data-retention.md](policies/data-retention.md)) | met |
| 8.3.x Sensitive data in URLs | Webhook secrets are in the URL by design (shown once, only a hash stored, `https` enforced for remote senders); export and file links are short-lived capabilities | partial (by design, documented) |
| Metadata | Servers see who talks to whom and when (documented limitation) | partial (accepted) |

## V9 Communication — partial

| Area | Evidence | Verdict |
|---|---|---|
| 9.1 TLS for clients | HTTPS via built-in Let's Encrypt (ACME) or own certificates; TLS 1.2 and 1.3 only on both HTTPS listeners; HSTS on HTTPS requests to domain names; plain HTTP from the internet redirected when HTTPS is available | met |
| Plain HTTP on LAN / without a domain | A server without HTTPS (LAN, or before "Open to the internet") speaks plain HTTP/WS; browsers refuse it, the desktop app allows it. Handshakes are still signed and E2EE content stays encrypted, but server channel traffic is readable on the network | partial (documented) |
| 9.2 Server communications | LiveKit API bound to 127.0.0.1; outbound fetches over HTTPS where the target supports it; push to known push-service hosts only | met |

## V10 Malicious code — met

| Area | Evidence | Verdict |
|---|---|---|
| 10.2 Malicious code search | CodeQL on C#, JS/TS and workflows; no telemetry or analytics; the app loads no third-party scripts | met |
| 10.3 Application integrity | Desktop updates: Windows code signature with matching publisher checked by electron-updater; macOS Developer ID + notarization; release SHA256SUMS and build-provenance attestations; `iskra-update` checks SHA256SUMS | met |

## V11 Business logic — met

| Area | Evidence | Verdict |
|---|---|---|
| 11.1 Anti-automation, limits | Per-type token buckets, per-account upload quotas, call/thread limits, slowmode, timeouts, AutoMod, 10 device revocations/hour | met |
| Ordering and races | Single writer for SQLite; first-valid-replacement rule for key rotation with dispute handling | met |

## V12 Files and resources — met

| Area | Evidence | Verdict |
|---|---|---|
| 12.1 Upload size and quotas | `MaxUploadMb`, daily quotas, Discord import `Import.MaxMb` | met |
| 12.2 File integrity / type | Type decided by content sniffing, never by name ([FileSniffer.cs](../../server/src/Iskra.Server/Files/FileSniffer.cs)) | met |
| 12.3 File execution, path traversal | Files stored by SHA-256 outside any web root, names cleaned; zip entries can't point outside the archive | met |
| 12.5 File download | `nosniff`, `Content-Disposition` attachment unless a real image/video/audio, `CSP: default-src 'none'; sandbox` on every served file ([Uploads.cs](../../server/src/Iskra.Server/Files/Uploads.cs)) | met |
| 12.6 SSRF | See V5 | met |

## V13 API and web service — met

| Area | Evidence | Verdict |
|---|---|---|
| 13.1 Generic | Documented protocol with size limits ([PROTOCOL.md](../../protocol/PROTOCOL.md)); every request has a server test | met |
| 13.2 RESTful / HTTP endpoints | Methods limited per route; uploads need a ticket; CORS `*` without credentials on file routes (capabilities, not cookies) | met |
| 13.5 WebSocket | Origin-independent signed handshake; frame size limits; malformed-frame cut-off after 10 bad frames | met |

## V14 Configuration — partial

| Area | Evidence | Verdict |
|---|---|---|
| 14.1 Build and deploy | Reproducible CI builds, pinned actions, minimal permissions, `release` environment, attestations, SBOMs | met |
| 14.2 Dependencies | Lock files, Dependabot with cooldown, SBOMs, Scorecard | met |
| 14.3 Unintended disclosure | No stack traces to clients; server returns only `{"iskra":1,"name":…}` at `/` | met |
| 14.4 HTTP security headers (server) | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'` / `X-Frame-Options: DENY` except framed profile pages, HSTS on HTTPS | met |
| 14.4 HTTP security headers (app.iskra.foo) | `_headers`: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP ([client/public/_headers](../../client/public/_headers)). **No `Content-Security-Policy`** for the app itself yet | partial |
| 14.5 HTTP request header validation | Kestrel defaults; Host-based redirects use the configured public URL | met |

Gaps: add a Content-Security-Policy to app.iskra.foo (and the desktop app's `app://` origin) restricting
`script-src 'self'` and `connect-src` to server origins; write the V1 threat model.

## Mapping to ASVS 5.0

ASVS 5.0 reorganised the chapters: V1 Encoding and Sanitization (4.0 V5), V2 Validation and Business Logic (V5, V11),
V3 Web Frontend Security (V14.4, V5.3), V4 API and Web Service (V13), V5 File Handling (V12), V6 Authentication (V2),
V7 Session Management (V3), V8 Authorization (V4), V9 Self-contained Tokens (V3.5; n/a: no JWTs), V10 OAuth and OIDC
(n/a: not used), V11 Cryptography (V6), V12 Secure Communication (V9), V13 Configuration (V14), V14 Data Protection
(V8), V15 Secure Coding and Architecture (V1, V10), V16 Security Logging and Error Handling (V7), V17 WebRTC (LiveKit;
DM/group calls use LiveKit end-to-end encryption, voice channels don't — documented in docs/security.md). The
verdicts above carry over chapter by chapter.
