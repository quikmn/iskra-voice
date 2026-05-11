# Iskra

*[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) · Copyright (c) 2024 Viktor Lundgren*

A self-hosted voice, text, and identity platform for people who are done with Discord.

Run your own server. Own your data. No accounts required, no telemetry, no subscriptions. And if you want a global identity that works across every server — and even without one — that's built in too.

---

> **Like it? Buy me a coffee.**
> [☕ Ko-fi](https://ko-fi.com/vlundgren) · [💳 PayPal](https://www.paypal.com/donate/?business=viktor.lundgren%40gmail.com)

---

## What it is

Iskra is three things:

- **iskra_server** — a Windows executable you run on any machine (your PC, a VPS, a home server). Hosts channels, stores chat history, handles voice routing, manages users.
- **iskra_client** — a Windows desktop app your friends download and run. No installer. Unzip, double-click, connect.
- **Iskra ID** — an optional global identity layer hosted at `id.iskra.foo`. Register once, keep your alias across every server, add friends, and send end-to-end encrypted direct messages to anyone on Iskra — even if you're not on the same server.

Voice uses WebRTC (peer-to-peer where possible, TURN relay for NAT traversal). Text is stored as plain `.jsonl` files on disk. The relay stores only encrypted blobs — it is mathematically zero-knowledge. Nothing phones home unless you opt into Iskra ID.

---

## Features

### Servers & channels
- Voice channels (push-to-talk or voice activation)
- Text channels with markdown, image embeds, file uploads, reactions, edits, pins, threads
- Screen sharing and webcam support
- Per-user roles: guest / member / trusted / admin / owner
- Per-channel read and write role requirements
- Server password, registered accounts, three auth modes
- Slow mode, timeouts, kick, ban
- Custom emoji, soundboard, webhooks, bot tokens
- Audit log, server backup (ZIP download)
- 7 built-in themes + custom JSON skin import

### Direct messages
- In-server DMs with read receipts and unread badges
- Desktop notifications

### Iskra ID (global, optional)
- One alias, globally unique, works across all servers
- Friends list — add by alias, message anywhere
- **End-to-end encrypted relay DMs** — ECDH P-256 + AES-GCM 256. Your private key is derived from your password via PBKDF2 and never leaves your device. The relay stores only encrypted ciphertext and mathematically cannot comply with a decryption order.
- Alias changes: once every 30 days
- Email verification, password recovery
- **Profile pages** — link your Neocities, GitHub Pages, Cloudflare Pages, or Netlify page. Full HTML and CSS, your way. See below.

---

## Profile pages

Iskra ID users can link a personal profile page. Anyone can view it by clicking your name and hitting **🌐 Profile**.

**Requires an Iskra ID** — register free at the ID tab in Settings.

Host your page anywhere from this list:
- [Neocities](https://neocities.org) — free, built for personal pages, has a web editor
- [GitHub Pages](https://pages.github.com) — free, version-controlled, great if you know git
- [Cloudflare Pages](https://pages.cloudflare.com) — free, fast globally
- [Netlify](https://netlify.com) — free tier, drag-and-drop deploy

Paste the URL in **Settings → ID → Profile Page** and hit Save.

### Build your profile with AI

You don't need to know how to code. Paste something like this into Claude, ChatGPT, or Gemini and you'll have a working page in minutes:

> *"Create a single `index.html` file for my personal profile page. Dark background, neon or pastel accent colours, custom Google Fonts. Give it a MySpace/Geocities vibe but polished — animated CSS effects, custom scrollbar, gradient text, that kind of thing. Sections for: a short bio, my interests, and links. Everything must be self-contained in one file — all CSS in a `<style>` block, no external JavaScript. I'm going to upload this to Neocities."*

Tweak it, tell the AI your colours, your vibe, your links, add a photo. Neocities has a built-in file editor so you can keep iterating without touching a terminal.

The Iskra relay fetches and sanitises your page server-side before rendering it in a sandboxed frame — no scripts execute, no matter what's in the HTML. It's safe to view anyone's profile.

---

## Requirements

### Server machine
- Windows 10/11 (64-bit)
- [.NET 8 Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) — "Run console apps" is enough

### Client machines
- Windows 10/11 (64-bit)
- [.NET Desktop Runtime 8.0](https://dotnet.microsoft.com/download/dotnet/8.0) — the "Desktop" variant
- WebView2 (already installed on Windows 11; Windows 10 users may need to install it)

---

## Quick start — running a server

### 1. Download and extract

Grab the server release zip and extract it anywhere. The exe is standalone.

### 2. Create a world folder

A "world" is the folder that holds all your server data. Create one:

```
C:\iskra\my-server\
```

### 3. Create `server.json` in that folder

```json
{
  "Settings": {
    "ServerName": "My Server",
    "Port": 8080,
    "RequirePassword": false,
    "ServerPassword": "",
    "AdminPassword": "change-this-to-something-secret",
    "AdminEmail": "",
    "TurnUrls": ["turn:turn01.ams.iskra.foo:3478", "turns:turn01.ams.iskra.foo:5349"],
    "TurnUsername": "iskra",
    "TurnCredential": "ee32a9bc-55f9-4393-adcc-f82c3381b15c",
    "HistoryRetentionDays": 60,
    "MaxDiskGb": 10.0,
    "AuthMode": "open"
  },
  "Channels": [
    { "Id": "hdr_main",   "Name": "Main",    "Type": "Header" },
    { "Id": "v_lobby",    "Name": "Lobby",   "Type": "Voice"  },
    { "Id": "t_general",  "Name": "general", "Type": "Text"   }
  ]
}
```

Channel IDs must be unique. Use short lowercase strings.

### 4. Start the server

```
iskra_server.exe C:\iskra\my-server
```

Or drag the world folder onto the exe. A console window opens showing connection logs.

### 5. Allow port 8080 through Windows Firewall

```powershell
New-NetFirewallRule -DisplayName "Iskra Server 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

---

## Quick start — connecting as a client

### Native client (Windows)

1. Unzip `Iskra-Client.zip` anywhere
2. Run `iskra_client.exe`
3. Open Settings (⚙ bottom-left) → **Servers** tab → fill in the address and port
4. Click Connect

The client minimizes to the system tray when you close the window. Right-click the tray icon to quit.

### Web client (any browser, any device)

Go to **[app.iskra.foo](https://app.iskra.foo)** — no download, no install. Works on Android, iOS, desktop.

> **Connecting to a self-hosted server from the web client requires TLS.**
>
> Browsers block unencrypted WebSocket connections (`ws://`) from HTTPS pages — it's a browser security rule, not something Iskra can work around. The native client has no such restriction and works fine with just an IP and port.
>
> To use the web client with your own server you need a domain name pointed at your server and a TLS certificate in front of it. The setup is a one-time thing and takes about 5 minutes.

#### Setting up TLS for your server (Ubuntu/Debian VPS)

**1. Point a domain at your server IP** — add an A record in your DNS provider (grey cloud / DNS-only, not proxied).

**2. Install nginx and certbot on the server:**

```bash
apt install nginx certbot python3-certbot-nginx
certbot --nginx -d yoursubdomain.yourdomain.com --non-interactive --agree-tos -m you@email.com
```

**3. Write the nginx config:**

```bash
cat > /etc/nginx/sites-available/iskra << 'EOF'
server {
    listen 443 ssl;
    server_name yoursubdomain.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yoursubdomain.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yoursubdomain.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name yoursubdomain.yourdomain.com;
    return 301 https://$host$request_uri;
}
EOF

ln -sf /etc/nginx/sites-available/iskra /etc/nginx/sites-enabled/iskra
ufw allow 80/tcp && ufw allow 443/tcp
nginx -t && systemctl reload nginx
```

**4. Open ports 80 and 443** in your firewall/VPS control panel if not already open.

**5. Connect** — in the web client (or native client), add the server using your domain name and port **443**. No `ws://` prefix needed, the client handles it.

The Let's Encrypt certificate auto-renews via a scheduled task certbot installs. Nothing else to maintain.

---

## Port forwarding

| What | Protocol | Port | Required for |
|---|---|---|---|
| Chat + signalling | TCP | 8080 (or your port) | Everything |
| Voice relay | UDP | 3478 | Voice through strict NATs (handled by TURN) |

Forward TCP 8080 to the machine running `iskra_server.exe`. Give friends your public IP or hostname.

---

## TURN server (voice relay)

WebRTC voice needs a TURN server for users behind strict NATs.

### Option A — Use the built-in public TURN (recommended)

The default `server.json` already points at a TURN server that runs alongside Iskra:

```json
"TurnUrls": ["turn:turn01.ams.iskra.foo:3478", "turns:turn01.ams.iskra.foo:5349"],
"TurnUsername": "iskra",
"TurnCredential": "ee32a9bc-55f9-4393-adcc-f82c3381b15c"
```

### Option B — Run your own coturn

```bash
apt install coturn
```

Minimal `/etc/turnserver.conf`:

```
realm=yourdomain.com
server-name=yourdomain.com
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=myuser:mypassword
cert=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/yourdomain.com/privkey.pem
```

Then in `server.json`:

```json
"TurnUrls": ["turn:yourdomain.com:3478", "turns:yourdomain.com:5349"],
"TurnUsername": "myuser",
"TurnCredential": "mypassword"
```

To disable TURN entirely (LAN-only):

```json
"TurnUrls": [],
"TurnUsername": "",
"TurnCredential": ""
```

---

## Running multiple servers

Each server is a world folder + one running exe. Run as many as you want on different ports.

```
C:\iskra\
  gaming-server\     ← port 8080
  work-server\       ← port 8181
  family-server\     ← port 8282
```

---

## server.json reference

```jsonc
{
  "Settings": {
    "ServerName": "My Server",
    "Port": 8080,
    "RequirePassword": false,
    "ServerPassword": "",
    "AdminPassword": "secret",
    "AdminEmail": "",
    "TurnUrls": ["turn:turn01.ams.iskra.foo:3478", "turns:turn01.ams.iskra.foo:5349"],
    "TurnUsername": "iskra",
    "TurnCredential": "ee32a9bc-55f9-4393-adcc-f82c3381b15c",
    "HistoryRetentionDays": 60,  // 0 = keep forever
    "MaxDiskGb": 10.0,           // 0 = unlimited
    // "open" | "registered+guests" | "verified-only"
    "AuthMode": "open"
  },
  "Channels": [
    { "Id": "hdr_main",  "Name": "Main",    "Type": "Header" },
    { "Id": "v_lobby",   "Name": "Lobby",   "Type": "Voice"  },
    { "Id": "t_general", "Name": "general", "Type": "Text",  "MinRole": "guest", "SlowMode": 0 }
  ]
}
```

---

## Auth and user management

| Mode | Behaviour |
|---|---|
| `open` | Anyone connects with any alias. Default. |
| `registered+guests` | Registered aliases must use their password. Unknown aliases connect freely as guests. |
| `verified-only` | Only registered aliases can connect. |

**User management commands** (owner only):
```
/adduser <alias> <password>
/removeuser <alias>
/passwd <alias> <newpassword>
/listusers
/authmode <mode>
```

**Moderation** (admin+):
```
/kick <alias> [reason]
/ban <alias> [reason]
/unban <guid>
/timeout <alias> <mins> [reason]
/untimeout <alias>
/slowmode <seconds> [channelId]
```

---

## What's in the world folder

```
my-server/
  server.json          ← configuration
  chat-t_general.jsonl ← one file per text channel
  avatars.json
  roles.json
  fingerprints.json    ← HWID tracking for identity
  bans.json
  audit.jsonl
  emojis.json
  uploads/
```

Plain text and JSON throughout. Back it up with `robocopy`, `rsync`, or a ZIP.

---

## Backup

Settings → Admin → Download Backup gives you a full ZIP.

Or just copy the world folder while the server is stopped.

---

## Running as a Windows Service (optional)

```powershell
nssm install IskraServer "C:\iskra\iskra_server.exe" "C:\iskra\my-server"
nssm start IskraServer
```

---

## Building from source

Requirements: .NET 8 SDK

```powershell
# Build server
dotnet build iskra_server\iskra_server.csproj -c Release

# Build and package client
.\ship-client.ps1

# Build and deploy relay (Linux target)
cd iskra_relay
dotnet publish -c Release -r linux-x64 --self-contained false -o ./publish
```

The `iskra_relay/` folder is the identity relay that runs at `id.iskra.foo`. You can run your own instance — see `deploy-relay.sh` for the full setup script (nginx, systemd, certbot). Config goes in `relay.json` next to the binary (never committed to the repo).

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)

Free to use, self-host, and modify for any noncommercial purpose. You may not sell it or offer it as a paid service.

---

## Support the project

[☕ Ko-fi — ko-fi.com/vlundgren](https://ko-fi.com/vlundgren)

[💳 PayPal](https://www.paypal.com/donate/?business=viktor.lundgren%40gmail.com)

No pressure. The software is free either way.
