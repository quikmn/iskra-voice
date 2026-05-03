# Iskra

A self-hosted voice and text chat server for people who are done with Discord.

Run your own server. Own your data. No accounts, no telemetry, no subscriptions. Back it up whenever you want, run as many as you want, give it to your friends for free.

---

> **Like it? Buy me a coffee.**
> [☕ Ko-fi](https://ko-fi.com/YOUR_USERNAME) · [💳 PayPal](https://www.paypal.com/donate/?business=viktor.lundgren%40gmail.com)

---

## What it is

Iskra is two things:

- **iskra_server** — a Windows executable you run on any machine (your PC, a VPS, a home server). It hosts channels, stores chat history, handles voice routing, manages users.
- **iskra_client** — a Windows desktop app your friends download and run. No installer. Unzip, double-click, connect.

Voice uses WebRTC (peer-to-peer where possible, TURN relay for NAT traversal). Text is stored as plain `.jsonl` files on disk. Everything is local. Nothing phones home.

---

## Features

- Voice channels (push-to-talk or voice activation)
- Text channels with markdown, image embeds, file uploads, reactions, edits, pinning
- Direct messages with read receipts
- Per-user roles (guest / member / trusted / admin / owner)
- Server password, per-user registered accounts, three auth modes
- Custom server icon and user avatars
- 7 visual themes (Catppuccin, Nord, Tokyo Night, and more)
- Full chat export and server backup (ZIP)
- Soundboard, screen share, webcam
- Tray icon, minimize to tray, Discord-style UX
- Custom emoji
- Webhooks and bot support
- Audit log
- No account required. No cloud. No bullshit.

---

## Requirements

### Server machine
- Windows 10/11 (64-bit)
- [.NET 8 Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) — "Run console apps" is enough

### Client machines
- Windows 10/11 (64-bit)
- [.NET Desktop Runtime 8.0](https://dotnet.microsoft.com/download/dotnet/8.0) — the "Desktop" variant, not just "Runtime"
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

Paste this as a starting point and edit it:

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

Channel IDs must be unique across your server. Use short lowercase strings.

### 4. Start the server

```
iskra_server.exe C:\iskra\my-server
```

Or drag the world folder onto the exe. A console window opens showing connection logs.

### 5. Allow port 8080 through Windows Firewall

Run this once in an Administrator terminal:

```powershell
New-NetFirewallRule -DisplayName "Iskra Server 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

If your server is on the same machine you play on and you only need LAN access, that's it. For internet access, see Port Forwarding below.

---

## Quick start — connecting as a client

1. Unzip `Iskra-Client.zip` anywhere
2. Run `iskra_client.exe`
3. Open Settings (⚙ bottom-left) → **Servers** tab → fill in the address and port
4. Click Connect

The client auto-minimizes to the system tray when you close the window. Right-click the tray icon to quit.

---

## Port forwarding

For friends to connect over the internet you need to forward one TCP port on your router.

| What | Protocol | Port | Required for |
|---|---|---|---|
| Chat + signalling | TCP | 8080 (or your chosen port) | Everything — text, voice signalling, file uploads |
| Voice relay | UDP | 3478 | Voice when peers can't connect directly (handled by TURN) |

Forward TCP 8080 (or whatever port you set in `server.json`) to the internal IP of the machine running `iskra_server.exe`. Give your friends your public IP or hostname.

Voice itself is peer-to-peer WebRTC — no extra ports needed on the server machine for that. The TURN server handles relay for users who can't punch through NAT directly.

---

## TURN server (voice relay)

WebRTC voice needs a TURN server for users behind strict NATs. You have three options:

### Option A — Use the built-in public TURN (easiest, recommended for most)

The default `server.json` already points at a TURN server that runs alongside Iskra. Just leave those values in place:

```json
"TurnUrls": ["turn:turn01.ams.iskra.foo:3478", "turns:turn01.ams.iskra.foo:5349"],
"TurnUsername": "iskra",
"TurnCredential": "ee32a9bc-55f9-4393-adcc-f82c3381b15c"
```

This is provided as-is. It handles voice relay for Iskra users. No guarantees on uptime but it works well for friend groups.

### Option B — Use a public free TURN

Some public TURN servers exist but they're unreliable and bandwidth-limited. Not recommended for regular use.

### Option C — Run your own coturn server

If you're self-hosting seriously and want full control, run [coturn](https://github.com/coturn/coturn) on a VPS:

```bash
# Install on Ubuntu/Debian
apt install coturn

# Minimal /etc/turnserver.conf
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

Open UDP 3478 and TCP/UDP 5349 on the VPS firewall.

To disable TURN entirely (LAN-only setups where everyone is on the same network):

```json
"TurnUrls": [],
"TurnUsername": "",
"TurnCredential": ""
```

---

## Running multiple servers

Each server is just a world folder + one running exe. You can run as many as you want on the same machine, on different ports.

```
C:\iskra\
  gaming-server\     ← port 8080
    server.json
  work-server\       ← port 8181
    server.json
  family-server\     ← port 8282
    server.json
```

Start each one in its own terminal:

```
iskra_server.exe C:\iskra\gaming-server
iskra_server.exe C:\iskra\work-server
iskra_server.exe C:\iskra\family-server
```

Forward each port separately on your router. Clients add each server as a separate entry in their server list.

---

## server.json reference

```jsonc
{
  "Settings": {
    // Display name shown in the client
    "ServerName": "My Server",

    // Port the server listens on
    "Port": 8080,

    // If true, clients must supply ServerPassword to connect
    "RequirePassword": false,
    "ServerPassword": "",

    // The owner password. Whoever sends this at connect gets the "owner" role.
    // Leave blank to disable owner/admin commands.
    "AdminPassword": "secret",

    // Optional, not used by the server — just a note for yourself
    "AdminEmail": "",

    // TURN server for WebRTC voice relay. See TURN section above.
    "TurnUrls": ["turn:turn01.ams.iskra.foo:3478", "turns:turn01.ams.iskra.foo:5349"],
    "TurnUsername": "iskra",
    "TurnCredential": "ee32a9bc-55f9-4393-adcc-f82c3381b15c",

    // How many days of chat history to keep. 0 = keep forever.
    "HistoryRetentionDays": 60,

    // Maximum total disk usage for uploads in GB. 0 = unlimited.
    "MaxDiskGb": 10.0,

    // Auth mode. See Auth section below.
    // "open"               — anyone connects with any alias
    // "registered+guests"  — registered aliases must use their password; others connect freely
    // "verified-only"      — only registered aliases can connect
    "AuthMode": "open",

    // Registered user accounts. Managed via /adduser command, not by hand.
    // Values are bcrypt hashes — never store plaintext passwords here.
    "RegisteredUsers": {}
  },

  "Channels": [
    // Type: "Header", "Text", "Voice"
    // MinRole: "guest" (default), "member", "trusted", "admin"
    // ReadOnly: true = only admins can post
    // Muted: true = no audio in or out for this voice channel
    // SlowMode: seconds between messages per user (0 = off)
    { "Id": "hdr_main",  "Name": "Main",    "Type": "Header" },
    { "Id": "v_lobby",   "Name": "Lobby",   "Type": "Voice"  },
    { "Id": "t_general", "Name": "general", "Type": "Text",  "MinRole": "guest", "ReadOnly": false, "SlowMode": 0 }
  ]
}
```

The file is rewritten live when you use admin commands. You can also edit it by hand while the server is stopped.

---

## What's in the world folder

After the server has been running a while your world folder will look like this:

```
my-server/
  server.json          ← configuration (edit this)
  chat-t_general.jsonl ← one file per text channel, one JSON object per line
  chat-v_lobby.jsonl   ← voice channel history (joins/leaves)
  avatars.json         ← alias → avatar URL mapping
  roles.json           ← alias → role mapping
  fingerprints.json    ← HWID → {aliases, IPs, last seen} for identity tracking
  bans.json            ← banned HWIDs
  audit.jsonl          ← admin action log
  emojis.json          ← custom emoji shortcodes
  uploads/             ← uploaded files and images (auto-purged per MaxDiskGb)
```

Everything is plain text or JSON. You can read it, back it up with `robocopy` or `rsync`, or inspect it directly. No database engine required.

---

## Auth and user management

### Auth modes

Set via `/authmode` command or directly in `server.json`:

| Mode | Behaviour |
|---|---|
| `open` | Anyone connects with any alias. Default. |
| `registered+guests` | Registered aliases must supply the correct password. Unknown aliases connect freely as guests. |
| `verified-only` | Only registered aliases can connect. Anyone else is rejected with a message to contact the owner. |

### Admin commands

These are typed in any text channel. You must be connected with the admin password to use them.

**User management**
```
/adduser <alias> <password>     Register an alias with a password
/removeuser <alias>             Remove a registration
/passwd <alias> <newpassword>   Change a registered user's password
/listusers                      Show current auth mode and all registered aliases
/authmode <mode>                Change auth mode (open / registered+guests / verified-only)
```

**Roles**
```
/role <alias> <role>    Set role: guest, member, trusted, admin
```

**Moderation**
```
/kick <alias> [reason]
/ban <alias> [reason]
/unban <guid>
```

**Channels**
```
/slowmode <seconds> [channelId]    Set slow mode (0 to disable)
```

Clients set their user password in the server connection settings (edit the server entry, "Your password" field). It's saved locally per-server and sent on every connect.

---

## Backup

Use the Admin panel in the client (Settings → Admin → Download Backup) to download a full ZIP containing all chat history, roles, bans, avatars, uploads, and the audit log.

Or just copy the world folder while the server is stopped. That's it.

---

## Running as a Windows Service (optional)

If you want the server to start automatically on boot without logging in, use NSSM:

```powershell
# Download nssm.exe, then:
nssm install IskraServer "C:\iskra\iskra_server.exe" "C:\iskra\my-server"
nssm set IskraServer AppStdout "C:\iskra\logs\server.log"
nssm set IskraServer AppStderr "C:\iskra\logs\server.log"
nssm start IskraServer
```

The server needs to bind to all interfaces. Run this once in an admin terminal if you haven't already:

```
netsh http add urlacl url=http://+:8080/ user=Everyone
```

---

## Building from source

Requirements: .NET 8 SDK

```powershell
# Build server
dotnet build iskra_server\iskra_server.csproj -c Release

# Build and package client
.\ship-client.ps1
```

The client build script produces `Iskra-Client.zip` — that's what you distribute to friends.

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)

Free to use, self-host, and modify for any noncommercial purpose. You may not sell it or offer it as a paid service. The full license is in the `LICENSE` file.

---

## Support the project

If Iskra saves you money on Discord Nitro or just makes your server life better, a coffee goes a long way.

[☕ Ko-fi — ko-fi.com/YOUR_USERNAME](https://ko-fi.com/YOUR_USERNAME)

[💳 PayPal — paypal.me/YOUR_USERNAME](https://paypal.me/YOUR_USERNAME)

No pressure. The software is free either way.
