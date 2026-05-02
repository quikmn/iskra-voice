# Origin Server — Configuration & Multi-Instance Guide

## Table of Contents

1. [The World Folder Model](#1-the-world-folder-model)
2. [Server Settings Block](#2-server-settings-block)
3. [Channel Types](#3-channel-types)
4. [Channel ID Rules](#4-channel-id-rules)
5. [Building a Channel Structure](#5-building-a-channel-structure)
6. [Full Config Examples](#6-full-config-examples)
7. [Running a Single Server](#7-running-a-single-server)
8. [Running Multiple Servers](#8-running-multiple-servers)
9. [Launcher Scripts](#9-launcher-scripts)
10. [Backup, Migration & VPS Hosting](#10-backup-migration--vps-hosting)
11. [Quick Reference](#11-quick-reference)

---

## 1. The World Folder Model

Every server instance is a single self-contained folder called a **world**. The folder contains everything that server needs and produces:

```
servers/
  quikmn-gaming/
    server.json          ← config (always this name, always here)
    chat-c_gen_t.jsonl   ← text chat history, written automatically
    chat-c_ops_t.jsonl
  friends-hangout/
    server.json
    chat-b_lobby_t.jsonl
  someones-clan/
    server.json
    chat-...jsonl
```

**One folder = one server. The folder name is the server's identity.**

To add a server: create a folder under `servers/`, put a `server.json` inside it, done — the launcher picks it up automatically.

To remove a server: delete the folder (or rename `server.json` to disable it without losing data).

To back up a server: zip its folder. To move it to a VPS: copy its folder. Everything is in one place.

---

## 2. Server Settings Block

```json
"Settings": {
  "ServerName":    "Bunker Alpha",
  "Port":           8080,
  "RequirePassword": true,
  "ServerPassword": "your_password_here",
  "AdminEmail":    ""
}
```

| Field | Type | Notes |
|---|---|---|
| `ServerName` | string | Shown to clients in the channel bar header and in the server's console window title |
| `Port` | integer | TCP port. **Must be unique per running instance on the same machine.** |
| `RequirePassword` | bool | Reserved — password is sent by the client but enforcement is not yet active server-side |
| `ServerPassword` | string | Password clients must supply when connecting |
| `AdminEmail` | string | Informational only |

**Port uniqueness:** Each server on the same machine needs a different port. If you omit a port or duplicate one, the second server fails to bind and exits. Simple convention: `8080`, `8081`, `8082`, etc.

**Auto-generation:** If you point the server at a folder that has no `server.json`, it creates one with defaults (port 8080, one voice channel, one text channel) and logs `New world created`. Edit the file and restart.

---

## 3. Channel Types

Every entry in the `Channels` array has three fields:

```json
{ "Id": "...", "Name": "...", "Type": "..." }
```

### `"Voice"`
A joinable audio channel. Users click to enter, see other occupants listed beneath it in real time, and use the ✖ button to leave. Connected peers use WebRTC for audio.

```json
{ "Id": "a_cmd_v", "Name": "Command", "Type": "Voice" }
```

### `"Text"`
A selectable text chat channel. Clicking it opens its message history in the chat pane. Selecting a different text channel does not affect voice — they are completely independent.

```json
{ "Id": "a_ops_t", "Name": "ops-log", "Type": "Text" }
```

Chat history is persisted to `chat-{Id}.jsonl` inside the world folder. The last 50 messages per channel are replayed to each client on connect.

### `"Header"`
A non-interactive section label — a visual divider rendered as a small uppercase string in the sidebar, exactly like Discord's category headers. It is never joined or selected. The `Id` is required and must be unique but is otherwise unused.

```json
{ "Id": "hdr_ops", "Name": "Operations", "Type": "Header" }
```

**Render order:** Channels appear in the sidebar in the exact order they appear in the `Channels` array. Place `Header` entries wherever you want section breaks.

---

## 4. Channel ID Rules

The `Id` field is used as the chat log filename (`chat-{Id}.jsonl`) and as the routing key for voice state. Get these right and you never have to think about them again.

**Rules:**
1. **Unique within a config.** Duplicate IDs cause undefined behaviour.
2. **Unique across all worlds that share a disk location.** This is automatically handled by the world folder model — each world has its own folder, so `chat-{id}.jsonl` files never collide even if two worlds use the same ID.
3. **Allowed characters:** letters, numbers, underscores, hyphens. No spaces. No special characters.
4. **Convention:** prefix with a short server abbreviation so logs are identifiable if you ever look at them directly.

```
a_cmd_v        ← "alpha", command, voice
b_lobby_t      ← "beta", lobby, text
hdr_a_ops      ← header for alpha's operations section
```

---

## 5. Building a Channel Structure

### Flat (no headers)
```json
"Channels": [
  { "Id": "c_voice", "Name": "General",   "Type": "Voice" },
  { "Id": "c_afk",   "Name": "AFK",       "Type": "Voice" },
  { "Id": "c_chat",  "Name": "general",   "Type": "Text"  },
  { "Id": "c_offtop","Name": "off-topic", "Type": "Text"  }
]
```
Renders as:
```
🔊 General
🔊 AFK
#  general
#  off-topic
```

### Sectioned (with headers)
```json
"Channels": [
  { "Id": "hdr_ops",  "Name": "Operations",  "Type": "Header" },
  { "Id": "ops_cmd",  "Name": "Command",      "Type": "Voice"  },
  { "Id": "ops_sit",  "Name": "Situational",  "Type": "Voice"  },
  { "Id": "ops_log",  "Name": "ops-log",      "Type": "Text"   },

  { "Id": "hdr_soc",  "Name": "Social",       "Type": "Header" },
  { "Id": "soc_hang", "Name": "Hangout",       "Type": "Voice"  },
  { "Id": "soc_afk",  "Name": "AFK",           "Type": "Voice"  },
  { "Id": "soc_gen",  "Name": "general",       "Type": "Text"   }
]
```
Renders as:
```
OPERATIONS
  🔊 Command
  🔊 Situational
  #  ops-log

SOCIAL
  🔊 Hangout
  🔊 AFK
  #  general
```

Voice and text can be interleaved however you like — the sidebar renders them strictly in config order.

---

## 6. Full Config Examples

### Minimal — no password, two channels
```json
{
  "Settings": {
    "ServerName": "My Server",
    "Port": 8080,
    "RequirePassword": false,
    "ServerPassword": "",
    "AdminEmail": ""
  },
  "Channels": [
    { "Id": "c_voice", "Name": "General", "Type": "Voice" },
    { "Id": "c_text",  "Name": "chat",    "Type": "Text"  }
  ]
}
```

### Gaming clan
```json
{
  "Settings": {
    "ServerName": "Anvil Gaming",
    "Port": 8080,
    "RequirePassword": true,
    "ServerPassword": "anvil2026",
    "AdminEmail": ""
  },
  "Channels": [
    { "Id": "hdr_main",    "Name": "Main",         "Type": "Header" },
    { "Id": "ag_lobby_v",  "Name": "Lobby",         "Type": "Voice"  },
    { "Id": "ag_gen_t",    "Name": "general",       "Type": "Text"   },
    { "Id": "ag_news_t",   "Name": "announcements", "Type": "Text"   },

    { "Id": "hdr_play",    "Name": "Playing",       "Type": "Header" },
    { "Id": "ag_squad1_v", "Name": "Squad 1",       "Type": "Voice"  },
    { "Id": "ag_squad2_v", "Name": "Squad 2",       "Type": "Voice"  },
    { "Id": "ag_strat_t",  "Name": "strats",        "Type": "Text"   },

    { "Id": "hdr_staff",   "Name": "Staff",         "Type": "Header" },
    { "Id": "ag_staff_v",  "Name": "Staff Room",    "Type": "Voice"  },
    { "Id": "ag_staff_t",  "Name": "staff-chat",    "Type": "Text"   }
  ]
}
```

---

## 7. Running a Single Server

The server executable is at:
```
iskra_server\bin\Release\net8.0\iskra_server.exe
```

Pass the world folder path as the only argument:

```powershell
# PowerShell
.\iskra_server\bin\Release\net8.0\iskra_server.exe .\servers\quikmn-gaming

# Absolute path also fine
.\iskra_server\bin\Release\net8.0\iskra_server.exe "C:\Iskra\servers\quikmn-gaming"
```

```batch
:: CMD
iskra_server\bin\Release\net8.0\iskra_server.exe servers\quikmn-gaming
```

**No argument:** defaults to the current working directory. Useful for running a server directly from inside its world folder:
```powershell
cd servers\quikmn-gaming
..\..\iskra_server\bin\Release\net8.0\iskra_server.exe
```

**First run on a new folder:** if `server.json` doesn't exist yet, the server creates one with defaults and logs `New world created`. Edit the file and restart.

The console window title will show `Origin Server — <ServerName> :<Port>` so you can identify it at a glance.

---

## 8. Running Multiple Servers

Each server needs:
- Its own world folder under `servers/`
- A unique `Port` in its `server.json`

That's it. The launcher handles everything else.

### Add a server
```
servers/
  quikmn-gaming/     ← existing
    server.json
  new-server/        ← create this folder
    server.json      ← put a config here
```
Next time you run the launcher, `new-server` starts automatically.

### Remove a server
Delete the folder. Or rename `server.json` to `server.json.disabled` to stop it from launching without losing data.

### Port quick-pick for five servers
| World folder | Port |
|---|---|
| `alpha/` | 8080 |
| `beta/` | 8081 |
| `gamma/` | 8082 |
| `delta/` | 8083 |
| `epsilon/` | 8084 |

### Firewall / LAN access
The server tries to bind `http://+:{PORT}/` (all interfaces) first. This requires admin or a registered URL reservation. If that fails it falls back to `http://localhost:{PORT}/` (loopback only).

To register a port without running as admin (one-time per port):
```batch
netsh http add urlacl url=http://+:8080/ user=Everyone
netsh http add urlacl url=http://+:8081/ user=Everyone
```

For WAN access, forward each port in your router to the host machine's LAN IP.

---

## 9. Launcher Scripts

### `launch-servers.ps1` (PowerShell — recommended)

Scans `servers\` automatically. No configuration needed.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\launch-servers.ps1
```

Output:
```
Starting: quikmn-gaming
Starting: friends-hangout
Starting: someones-clan
3 server(s) launched.
```

Each world opens in its own console window. Add or remove world folders and rerun — the script adapts with no edits required.

### `launch-servers.bat` (CMD/Batch)

Same behaviour, no PowerShell required:
```batch
launch-servers.bat
```

### Start a single world directly

```powershell
# One-liner: start a specific world
Start-Process .\iskra_server\bin\Release\net8.0\iskra_server.exe -ArgumentList "`"$PWD\servers\quikmn-gaming`""
```

---

## 10. Backup, Migration & VPS Hosting

### Backup a server
Copy the world folder. Everything is inside it.
```powershell
Copy-Item -Recurse servers\quikmn-gaming backups\quikmn-gaming-2026-05-02
```

### Move to a VPS
1. Copy the world folder to the VPS
2. Copy the server EXE and its dependencies
3. Run: `./iskra_server servers/quikmn-gaming`

No installer, no database, no registry entries.

### Hosting for multiple people on a VPS

Each person gets their own world folder named after them. Automated provisioning is trivial:

```powershell
# Provision a new server for a user
function New-OriginServer($username, $port, $password) {
    $world = "servers\$username"
    New-Item -ItemType Directory -Force $world | Out-Null
    @{
        Settings = @{ ServerName = "$username's Server"; Port = $port; RequirePassword = $true; ServerPassword = $password; AdminEmail = "" }
        Channels = @(
            @{ Id = "${username}_v"; Name = "General"; Type = "Voice" }
            @{ Id = "${username}_t"; Name = "chat";    Type = "Text"  }
        )
    } | ConvertTo-Json -Depth 5 | Set-Content "$world\server.json"
    Start-Process .\iskra_server\bin\Release\net8.0\iskra_server.exe -ArgumentList "`"$(Resolve-Path $world)`""
    Write-Host "Server for $username started on port $port"
}

New-OriginServer "alice" 8080 "alicepass"
New-OriginServer "bob"   8081 "bobpass"
```

The resulting layout:
```
servers/
  alice/
    server.json
    chat-alice_t.jsonl
  bob/
    server.json
    chat-bob_t.jsonl
```

Ownership is obvious at a glance. Deleting a user's server is `Remove-Item -Recurse servers\alice`.

---

## 11. Quick Reference

### Channel types at a glance
| Type | Joinable | Selectable | Persisted | Renders as |
|---|---|---|---|---|
| `Voice` | Yes | No | No | 🔊 row with live user list |
| `Text` | No | Yes | Yes (`chat-{Id}.jsonl`) | # row |
| `Header` | No | No | No | Section label |

### World folder checklist
- [ ] Folder is inside `servers\`
- [ ] `server.json` exists inside the folder
- [ ] `Port` is unique across all running instances
- [ ] All `Id` values are unique within the file
- [ ] No spaces or special characters in any `Id`
- [ ] File is valid JSON (no trailing commas)

### Minimal `server.json` to copy-paste
```json
{
  "Settings": {
    "ServerName": "My Server",
    "Port": 8080,
    "RequirePassword": false,
    "ServerPassword": "",
    "AdminEmail": ""
  },
  "Channels": [
    { "Id": "c_voice", "Name": "General", "Type": "Voice" },
    { "Id": "c_text",  "Name": "chat",    "Type": "Text"  }
  ]
}
```
