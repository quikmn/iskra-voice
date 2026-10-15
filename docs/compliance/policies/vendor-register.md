# Vendor and subprocessor register

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10 (and before adding a vendor) |
| Applies to | Services used to build, release and run Iskra and the owner's hosted services |

**Subprocessor** = processes personal data on the owner's behalf for iskra.foo, app.iskra.foo or chat.iskra.foo.
**Third party** = a service users' apps contact directly, under that service's own terms (listed in the privacy
policy §8); the owner doesn't instruct it. **Supplier** = no personal data of users.

Before adding a vendor: check what data it gets, where, its security posture (SOC 2/ISO report or equivalent), and
accept its DPA if it's a subprocessor; add a row here and to [site/privacy.html](../../../site/privacy.html) if users'
data is involved. DPA status "to accept" is an owner action ([owner-actions.md](../owner-actions.md)).

| Vendor | Role | Purpose | Personal data | Location / transfer basis | DPA |
|---|---|---|---|---|---|
| **Cloudflare** | Subprocessor | DNS for iskra.foo; Pages hosting for iskra.foo and app.iskra.foo; Email Routing for spark@iskra.foo | Visitors' IP addresses and request details (short-lived logs); emails to spark@iskra.foo pass through | Global network, US company; EU–US Data Privacy Framework / SCCs | Cloudflare's DPA is part of its self-serve terms; owner to confirm accepted |
| **DigitalOcean** | Subprocessor | Droplet for chat.iskra.foo (AMS3, Amsterdam) | Everything chat.iskra.foo stores (profiles, server channel messages, files, E2EE ciphertext, IPs in memory and in the security log) | Data at rest in the Netherlands; US company, DPF / SCCs | DigitalOcean DPA (online); owner to confirm accepted |
| **GitHub** (Microsoft) | Subprocessor (releases, issues) / supplier (code, CI) | Source, CI, releases, update downloads, security advisories | Downloaders' IP addresses (desktop update checks (on by default, users can turn them off in Privacy & data), standalone servers' update checks and rented servers' first download hit GitHub); reporters' details in issues and advisories | US; DPF / SCCs | GitHub DPA (online); owner to confirm accepted |
| **Apple** | Supplier / third party | Developer ID signing and notarization, App Store Connect and TestFlight; Web Push for Safari and iOS home-screen apps (`push.apple.com`) | Notarization: binaries only. Push: device push endpoint and timing (content encrypted) | US / Ireland | Apple Developer Program License Agreement |
| **Google** | Third party / supplier | Web Push for Chrome and Android (`fcm.googleapis.com`); Play Console (Android, not published yet); default public STUN server LiveKit asks for the server's own address when the server is open to the internet and the router didn't say (the apps use no STUN servers: they pass an empty ICE server list). No longer: Electron spell-check dictionaries (the desktop app uses the OS spellchecker on Windows/macOS and turns spellcheck off on Linux) | Push: endpoint and timing (content encrypted); STUN: the server's IP only | US; DPF | Google's terms; Play Console DDA when publishing |
| **Mozilla**, **Microsoft** (WNS) | Third party | Web Push for Firefox and Edge on Windows | Endpoint and timing (content encrypted) | US / EU | Browser vendors' terms |
| **KLIPY** | Supplier to each server (proxied mode, the default since 2026-10-12) / third party (direct mode, an owner's explicit choice) | GIF search, only if a server's admin turns it on | Proxied: only the server's IP and searches under one per-server pseudonymous id. Direct: users' IPs, search words, per-member pseudonymous id. KLIPY's standard terms describe direct calls; owners may ask KLIPY (developers@klipy.com) to confirm proxying | Location not confirmed | KLIPY API terms; not enabled on chat.iskra.foo unless the owner turned it on |
| **Hugging Face** | Supplier | Source of the live-captions model (Whisper base, pinned commit, hash-checked): each Iskra server fetches it once and serves it to its members' apps; CI and tests get it via `scripts/get-models.mjs` | The fetching server's IP address only; members' devices never contact it | US | None (public model download) |
| **Mozilla** | Supplier | Source of the translation models (Firefox Translations, MPL-2.0, pinned paths and SHA-256s in `client/src/state/translate/models.json`): each Iskra server whose owner offers translation fetches each model once from Mozilla's Google Cloud Storage bucket and serves it to its members' apps | The fetching server's IP address only; members' devices never contact it | US | None (public model download) |
| **Let's Encrypt** (ISRG) | Supplier | HTTPS certificates for chat.iskra.foo and self-hosted servers | Certificate domain names (public by design in CT logs); account email if set | US non-profit | Subscriber agreement |
| **sslip.io** | Supplier | Free wildcard DNS for servers opened to the internet without a domain (not used by chat.iskra.foo) | DNS queries for the server's name | Not confirmed | None (free public service) |
| **Resend** | *Unconfirmed* | DNS records for `send.iskra.foo` exist (docs/ci-cd.md §4); no code in this repo sends email | Recipients' addresses, if used for mail from spark@iskra.foo | US | To confirm whether it's in use; accept its DPA if so |
| **Certum** (Asseco Data Systems) | Supplier | Windows code-signing certificate, key held in Certum's cloud HSM (SimplySign) | Owner's identity only | Poland (EU) | Certum terms |
| **Ko-fi**, **PayPal** | Third party | Donations; the site and Settings → About link to them | Donors give their data to Ko-fi/PayPal directly | UK / Luxembourg (EU entity for EU users) | Their own terms; the owner receives donor name/email from them as controller |
| **npm registry**, **NuGet** (Microsoft) | Supplier | Package downloads for builds | None | US | — |
| **YouTube, Twitch, X, Reddit, linked websites** | Third party | Embeds (click-to-load placeholders; a per-site, per-device "Always load" tick) and watch parties (a "plays from …" notice before anything loads); link previews fetched by the server (text only); iskra.foo's two showcase videos only after a click | Users' IP (embeds, watch parties); the server's IP (previews) | Various | Their own terms (privacy policy §8) |

**Not vendors:** VPS providers named in the app's "Rent a small server" guide (Hetzner, DigitalOcean as examples) are
chosen, paid and run by each group itself; Iskra has no deal with them and they process nothing for the owner (the
owner's own DigitalOcean droplet is listed above). Gaming VPNs such as Tailscale are only a suggestion to users, in
the same way. AI assistants named in the port-forwarding help (ChatGPT, Gemini, Claude) get only what a user chooses
to paste.

## Review

Yearly: confirm each vendor is still used, re-read DPAs/trust pages for changes in subprocessors or locations,
check accounts have MFA ([access-control.md](access-control.md)), and update this register and the privacy policy.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
| 2026-10-12 | Removed Cloudflare Workers (push relay), Apple APNs and Google FCM: the phone apps notify while open |
| 2026-10-12 | Added Hugging Face (captions model, fetched by servers); GitHub covers server update checks; VPS providers, gaming VPNs and AI assistants in the hosting help noted as not vendors |
| 2026-10-12 | Privacy pass ([docs/privacy-connections.md](../../privacy-connections.md)): KLIPY proxied by default; embeds and watch parties click-to-load; desktop update checks can be turned off; no Google spellcheck downloads; apps use no STUN servers |
| 2026-10-15 | Added Mozilla (translation models, fetched by servers when the owner offers translation) |
