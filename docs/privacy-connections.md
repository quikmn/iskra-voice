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
| **Desktop update checks** | Desktop app → `github.com` / `api.github.com` (electron-updater, or the releases API for builds that can't update themselves) | 15 s after start, then every hour, and when the window gets focus again if the last check is 15+ minutes old; downloads from GitHub's release storage | Your IP and the app version | On (updates fix security problems) | My settings → Privacy & data → "Check for updates automatically" (the tray's "Check for updates" still works) |
| **Web Push** | Your server → your browser's push service (Google FCM, Mozilla, Microsoft WNS, Apple) → your device | Only if you turned notifications on for that device | That a notification was sent, and when (content is encrypted to your device) | Off until you turn it on | My settings → Notifications |
| **Alert words, follows and quiet hours** | none: your device → your own servers only | Your alert words, follows (people and roles you follow in a channel) and quiet hours stay on your devices and sync between them sealed (servers can't read them); the app matches words and follows itself, in encrypted channels and DMs too. Only if you tick "Also when Iskra is closed" do your servers get a readable copy of the words and follows (words matched only in channels that aren't encrypted; a follow needs no text), and only servers your browser gets push from get your quiet hours schedule (days, times, time zone) | Your servers, as above; no third party | Words and follows: on your devices only. Schedule: only where push is on | My settings → Notifications (untick, or turn quiet hours off: the copies are deleted) |
| **Emoji and stickers from your other servers** | none: your device → the emoji's home server (a normal file download), then → the server you're posting on (a normal upload) | When you pick an emoji or sticker from another server in the picker | The server you post on gets the picture, its name and that you brought it (it keeps the same picture once, up to 300 emoji and 100 stickers); the home server sees only you downloading a file. Servers never contact each other | On for members (admins can turn it off per built-in role) | Pick emoji of the server you're on; admins: Server settings → Roles |
| **Search everywhere** | none: your device → each server you're on | When you switch the search panel to "Everywhere" (or Ctrl+K → "Search everywhere") | Each of your servers sees the search words and filters, as it does when you search it alone; nothing is stored. Your direct messages and groups are searched on the device | — | Search "This server" instead |
| **Streamer mode, "Turn on by itself"** | none: the desktop app looks at the programs running on your own computer for the ones you listed | While the switch is on | Nothing leaves the computer: the page only hears yes or no, and the mode's on/off syncs between your devices sealed like other settings | Off | My settings → Streamer mode |
| **The web app's files** | Browser → `app.iskra.foo` (Cloudflare Pages) | When you open the web app | Your IP (Cloudflare's short-lived logs); never your chats | Web app only | Use the desktop or phone app (they carry their own copy) |
| **DigitalOcean (Rent a server on DigitalOcean)** | Desktop app → `api.digitalocean.com` (HTTPS) with your OAuth key or token; your browser → `cloud.digitalocean.com` to sign in, then back to a one-time listener on `127.0.0.1` | Only while you rent a server there from the desktop app: listing sizes and regions, creating the droplet and its firewall, checking it, deleting them if setup fails | Your IP address and what the app creates in your account (DigitalOcean is your provider then). The app then asks `https://<ip>.sslip.io/health` on your new server, and the new server downloads Iskra from GitHub. The button that opens DigitalOcean uses Iskra's referral link (`m.do.co/c/...`): Iskra gets a small DigitalOcean credit; we never see your server or card | Off: only when you start it | Don't start it (the referral link only opens when you press the button); the key is forgotten after setup |
| **Bug reports** | Your device → `https://chat.iskra.foo/bug-reports` (Iskra's own server) | Only when you press Send in "Report a bug" (Help, the status menu, Ctrl+Shift+B) | What you wrote, your screenshots (stored without their metadata, like server icons), the email you gave (optional) and, unless you untick "Include logs", logs: app version and commit, OS and browser names, device kind, allowlisted settings (switches and choices, no ids or names), connection states per server (numbered, never named), failed request types and codes, voice state and stats, error names and bundle lines, update states. Never message text, file names, member or server names, keys, invite links, links or IP addresses (an allowlist, then a net for addresses, emails, links and key-shaped strings). The server sees your IP address for its rate limit and never stores it. Reports land in a private channel only the Iskra team reads and are deleted after a year at the latest | Off: only when you send one ("See what's included" shows exactly what goes) | Don't send one; "Save as a file" keeps it on your device |
| **HyperDHT (Connect without port forwarding)** | Desktop app (a server's owner, or a member joining such a server) → nodes of the public HyperDHT network: first the three bootstrap nodes Holepunch runs, then any node; then straight to the other computer (an encrypted tunnel) | Only if the owner turned on "Connect without port forwarding" (desktop-hosted servers), and for members only when the server's normal address can't be reached | Your IP address and the key you announce or look up, never what it is or what you say | Off until the owner turns it on | Owner: Server settings → Internet access; member: leave the server |
| **Captions model** | Your device → your server (`/models/...`) | Once, when you turn captions on | — | Off until you turn captions on | — |
| **Translation models** | Your device → your server (`/models/translate/...`) | Once per language and direction, when you translate from a language this device doesn't have and say yes to the download. The messages themselves are translated on the device and never sent | — | Off until an owner offers it and you agree to the download | — |
| **Voice ICE/STUN** | none from your device: the apps pass an empty ICE server list, so no STUN or TURN server is asked (a server's own LiveKit may ask Google STUN, see "A server") | — | — | No third party | — |
| **Spellcheck** | Windows/macOS: the system's own spellchecker (no network). Linux: off, because Chromium would download Hunspell dictionaries from Google | — | — | No third party | — |
| **Chromium background services** | Electron has no Safe Browsing, component updater, field trials or Google sign-in. The app also turns off Cast discovery (`MediaRouter`, `DialMediaRouteProvider`), the autofill server and `<a ping>` | — | — | Off | — |
| **Passkeys for the app lock** | Desktop: a local window on `https://app.iskra.foo` served from memory (no request leaves the computer); the OS handles the passkey. Choosing "use a phone" uses the OS's own hybrid transport | When you set up or use the app lock | — (OS-level for phone passkeys) | Off until you set it up | — |
| **Profile pages** | none: in the desktop app a page's scripts run in a walled-off session that can't reach the network (it shows only pictures uploaded to its own server); browsers and the phone apps show other people's pages without scripts | — | Nothing: a page can't load anything from elsewhere (images only from its own server) | — | — |
| **Links you click** | Your browser | When you click | What any website learns | — | — |
| **QR scanner** | none: the decoder (ZXing WebAssembly) ships with the app, never a CDN | — | — | — | — |
| **Fonts, icons, scripts, analytics, crash reports** | none: everything ships with the app; no analytics, ads or crash reporting | — | — | — | — |

The phone apps (Capacitor) run the same web app from the app bundle; Capacitor adds no telemetry, and the Android app
includes no Google Play services or Firebase. The phone's operating system has its own connections (app store,
OS updates), which Iskra doesn't control.

## A server

| Connection | Who contacts whom | When | What they learn | Default | How to turn it off |
|---|---|---|---|---|---|
| **Your router (UPnP / NAT-PMP)** | Server → the router on your own network | "Let friends anywhere join" | — (local network) | Off until the owner turns it on | Server settings → Internet access |
| **Let's Encrypt** | Server → `acme-v02.api.letsencrypt.org`; Let's Encrypt → server (HTTP check) | Getting and renewing the HTTPS certificate | The server's domain name (public in Certificate Transparency logs) and IP | With "Let friends anywhere join" or `Https.Mode: acme` | Use your own certificate or none |
| **sslip.io** | Members' DNS resolvers → sslip.io's name servers | Resolving `1-2-3-4.sslip.io`, when there's no own domain | The lookups for that name (usually from members' ISPs' resolvers) | Only without a domain | Set your own domain |
| **Google STUN (via LiveKit)** | Server's LiveKit → a public STUN server (Google's by default) | Starting voice when open to the internet and the router didn't report the public IP | The server's IP only | Only in that case | Give the server a known address (router with UPnP/NAT-PMP) |
| **Hugging Face** | Server → `huggingface.co` (pinned commit, SHA-256-checked) | Once, the first time a member turns captions on | The server's IP | On demand | `server.json`: `"Captions": { "ModelDownload": false }`, or `ModelSource` for a local copy |
| **Mozilla (translation models)** | Server → `storage.googleapis.com` (Mozilla's Firefox Translations models, pinned paths, SHA-256-checked); members' devices then download them from the server | Once per model, the first time a member needs it | The server's IP | Off | Server settings → Translation |
| **HyperDHT** | Server's p2p sidecar → public HyperDHT nodes (see above) | While "Connect without port forwarding" is on | The server's IP and its public key | Off | Server settings → Internet access |
| **GitHub (rented servers)** | A server you rent from the desktop app → GitHub release storage | During setup (and later server updates) | The new server's IP | Only when you rent one | Don't rent |
| **GitHub (server updates)** | Server → `api.github.com`, GitHub release storage | 2 min after start, then every 6 h; standalone servers only (desktop-hosted servers update with the app) | The server's IP and version | Notify | Server settings → Server updates → Off |
| **Link previews** | Server → linked sites | See above | The server's IP | On | No switch yet (text only, no images) |
| **KLIPY** | Server → KLIPY | See above | The server's IP | Only with a key | Remove the key |
| **Push services** | Server → each subscribed device's push service | Notifications | Encrypted payload, timing | Only for subscribed devices | — |
| **Outgoing webhooks** | Server → the address an admin picked (HTTPS; plain HTTP only on the owner's own network) | When a chosen event happens: a new message or reaction in chosen channels, a member joining or leaving, an event starting | What the event contains (message text and author's name, member names); never encrypted channels, DMs or group chats | None until an admin adds one; every member sees the hosts in My settings → Privacy & data → Who Iskra talks to | Server settings → Bots & webhooks → Outgoing (turn off or delete) |
| **Backup buddies** | Server → a friend's Iskra server the owner paired with (and back, only to answer it) | After each daily backup or *Back up now*, while backup buddies are on | That this server exists, its IP and server key, when backups happen and their size; never their contents (encrypted on this server first) | Off | Server settings → Backup & move → Backup buddies |

## The websites

- **iskra.foo**: static, on Cloudflare Pages; self-hosted fonts; no analytics; nothing loads from other sites.
- **app.iskra.foo**: the web app's files, on Cloudflare Pages. After it loads, it talks only to the servers you join.

## How this is checked

- `client/src/state/bugReport/diagnostics.test.ts`: bug report logs and payloads never contain seeded message text,
  names, keys, invite links, tokens, IP addresses or emails; `client/e2e/bug-report.spec.ts`: the preview of a real
  report shows nothing from the chat, the people or the server, and the report reaches the bug inbox channel.
- `client/src/state/siteConsent.test.ts`, `client/src/ui/chat/embeds.test.ts`: click-to-load and the per-site,
  per-device "Always load" list.
- `client/e2e/privacy.spec.ts`: a YouTube link makes no request to YouTube until clicked (the test watches every
  request), "Always load" survives a reload and can be forgotten, a YouTube watch party asks first, voice uses no
  STUN servers, and the "Who Iskra talks to" list renders. `client/e2e/gifs.spec.ts`: GIF search goes through the
  server by default and members' apps never contact KLIPY.
- `desktop`: `npm run test:network` starts Electron the way the app does, types into a spellchecked text box, and
  reads Chromium's own network log: nothing may ask for any host on the internet (runs in CI on Windows, macOS and
  Linux).
