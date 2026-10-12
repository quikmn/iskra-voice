# Who Iskra talks to

Iskra's rule: **your devices talk to your own servers, not to us or to third parties.** This page lists every
connection the apps (desktop, web, phone) and the server make to anyone other than the group's own Iskra server:
when it happens, what the other side learns, and how to turn it off. The apps show a short version in
**My settings → Privacy & data → Who Iskra talks to**; the privacy policy has the same list
([iskra.foo/privacy#third](https://iskra.foo/privacy#third)).

If you find a connection that isn't on this page, it's a bug: please report it (see [SECURITY.md](../SECURITY.md)).

## The apps

| Connection | Who contacts whom | When | What they learn | Default | How to turn it off |
|---|---|---|---|---|---|
| **Your servers** | Your device → each server you joined (HTTPS/WebSocket, voice through its LiveKit) | While you use it | Your IP address, everything you do on that server | On (it's the app) | Leave the server |
| **Link previews** | The **server** → the linked website | When a message with a link is shown | The server's IP; text only, no images are fetched | On | (server-side; your device never contacts the site) |
| **YouTube, Twitch, X, Reddit embeds** | Your device → `www.youtube-nocookie.com`, `player.twitch.tv`/`clips.twitch.tv`, `platform.twitter.com`, `embed.reddit.com` | Only after you press Play/Load on the placeholder ("Loads from YouTube…"), or for a site you ticked "Always load from <site>" on this device (then without autoplay) | Your IP address and what you play | Off: click-to-load | Don't click; forget the site in Privacy & data |
| **Watch parties from YouTube or a web link** | Your device → YouTube (privacy-enhanced player) or the video link's site | After you press "Watch from <site>" (the host's own start counts; the start dialog says "Plays from <site>") | Your IP address | Off: asks first | Don't press Watch; you stay in the call |
| **Watch parties from an uploaded file** | Your device → your server | When you're in the party | — | — | — |
| **GIFs (KLIPY)** | The **server** → `api.klipy.com` and KLIPY's media hosts (proxied) | When someone searches or a GIF is shown, only if an admin added a KLIPY key | KLIPY sees the server's IP and searches under one pseudonymous id per server | Through the server | Admin removes the key |
| **GIFs, "Straight from KLIPY"** | Your device → `api.klipy.com`, `static*.klipy.com` | Only if the owner explicitly picked it (labelled "KLIPY sees members' addresses"); GIFs in chat still wait for a click unless you turn on auto-load | Your IP, your searches, a per-member pseudonymous id | Off | Owner switches back to "Through this server" |
| **Desktop update checks** | Desktop app → `github.com` / `api.github.com` (electron-updater, or the releases API for builds that can't update themselves) | 15 s after start, then every 4 hours; downloads from GitHub's release storage | Your IP and the app version | On (updates fix security problems) | My settings → Privacy & data → "Check for updates automatically" (the tray's "Check for updates" still works) |
| **Web Push** | Your server → your browser's push service (Google FCM, Mozilla, Microsoft WNS, Apple) → your device | Only if you turned notifications on for that device | That a notification was sent, and when (content is encrypted to your device) | Off until you turn it on | My settings → Notifications |
| **The web app's files** | Browser → `app.iskra.foo` (Cloudflare Pages) | When you open the web app | Your IP (Cloudflare's short-lived logs); never your chats | Web app only | Use the desktop or phone app (they carry their own copy) |
| **Captions model** | Your device → your server (`/models/...`) | Once, when you turn captions on | — | Off until you turn captions on | — |
| **Voice ICE/STUN** | none: the apps pass an empty ICE server list, so no STUN or TURN server is asked | — | — | No third party | — |
| **Spellcheck** | Windows/macOS: the system's own spellchecker (no network). Linux: off, because Chromium would download Hunspell dictionaries from Google | — | — | No third party | — |
| **Chromium background services** | Electron has no Safe Browsing, component updater, field trials or Google sign-in. The app also turns off Cast discovery (`MediaRouter`, `DialMediaRouteProvider`), the autofill server and `<a ping>` | — | — | Off | — |
| **Passkeys for the app lock** | Desktop: a local window on `https://app.iskra.foo` served from memory (no request leaves the computer); the OS handles the passkey. Choosing "use a phone" uses the OS's own hybrid transport | When you set up or use the app lock | — (OS-level for phone passkeys) | Off until you set it up | — |
| **Profile pages with scripts** | Your device → whatever the page's author made it load (blocked by the page's CSP: no network) | Only if you choose to run a page's scripts | The page can't load anything from elsewhere (`connect-src 'none'`, images only from the server) | Off: asks first | Don't run scripts |
| **Links you click** | Your browser | When you click | What any website learns | — | — |
| **QR scanner** | none: the decoder (ZXing WebAssembly) ships with the app, never a CDN | — | — | — | — |
| **Fonts, icons, scripts, analytics, crash reports** | none: everything ships with the app; no analytics, ads or crash reporting | — | — | — | — |

The phone apps (Capacitor) run the same web app from the app bundle; Capacitor adds no telemetry, and the Android app
includes no Google Play services or Firebase. The phone's operating system has its own connections (app store,
OS updates), which Iskra doesn't control.

## A server

| Connection | Who contacts whom | When | What they learn | Default | How to turn it off |
|---|---|---|---|---|---|
| **Your router (UPnP / NAT-PMP)** | Server → the router on your own network | "Open to the internet" | — (local network) | Off until the owner turns it on | Server settings → Internet |
| **Let's Encrypt** | Server → `acme-v02.api.letsencrypt.org`; Let's Encrypt → server (HTTP check) | Getting and renewing the HTTPS certificate | The server's domain name (public in Certificate Transparency logs) and IP | With "Open to the internet" or `Https.Mode: acme` | Use your own certificate or none |
| **sslip.io** | Members' DNS resolvers → sslip.io's name servers | Resolving `1-2-3-4.sslip.io`, when there's no own domain | The lookups for that name (usually from members' ISPs' resolvers) | Only without a domain | Set your own domain |
| **Google STUN (via LiveKit)** | Server's LiveKit → a public STUN server (Google's by default) | Starting voice when open to the internet and the router didn't report the public IP | The server's IP only | Only in that case | Give the server a known address (router with UPnP/NAT-PMP) |
| **Hugging Face** | Server → `huggingface.co` (pinned commit, SHA-256-checked) | Once, the first time a member turns captions on | The server's IP | On demand | `server.json`: `"Captions": { "ModelDownload": false }`, or `ModelSource` for a local copy |
| **GitHub (server updates)** | Server → `api.github.com`, GitHub release storage | 2 min after start, then every 6 h; standalone servers only (desktop-hosted servers update with the app) | The server's IP and version | Notify | Server settings → Updates → Off |
| **Link previews** | Server → linked sites | See above | The server's IP | On | — |
| **KLIPY** | Server → KLIPY | See above | The server's IP | Only with a key | Remove the key |
| **Push services** | Server → each subscribed device's push service | Notifications | Encrypted payload, timing | Only for subscribed devices | — |

## The websites

- **iskra.foo**: static, on Cloudflare Pages; self-hosted fonts; no analytics. Its two showcase background videos
  load from YouTube (privacy-enhanced) only when a visitor presses their play button.
- **app.iskra.foo**: the web app's files, on Cloudflare Pages. After it loads, it talks only to the servers you join.

## How this is checked

- `client/src/state/siteConsent.test.ts`, `client/src/ui/chat/embeds.test.ts`: click-to-load and the per-site,
  per-device "Always load" list.
- `client/e2e/privacy.spec.ts`: a YouTube link makes no request to YouTube until clicked (the test watches every
  request), "Always load" survives a reload and can be forgotten, a YouTube watch party asks first, voice uses no
  STUN servers, and the "Who Iskra talks to" list renders. `client/e2e/gifs.spec.ts`: GIF search goes through the
  server by default and members' apps never contact KLIPY.
- `desktop`: `npm run test:network` starts Electron the way the app does, types into a spellchecked text box, and
  reads Chromium's own network log: nothing may ask for any host on the internet (runs in CI on Windows, macOS and
  Linux).
