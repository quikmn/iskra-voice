# Origin Server — Configuration & Multi-Instance Guide

## Table of Contents

1. [Config File Overview](#1-config-file-overview)
2. [Server Settings Block](#2-server-settings-block)
3. [Channel Types](#3-channel-types)
4. [Channel ID Rules](#4-channel-id-rules)
5. [Building a Channel Structure](#5-building-a-channel-structure)
6. [Full Config Examples](#6-full-config-examples)
7. [Running a Single Server](#7-running-a-single-server)
8. [Running Multiple Servers on One Machine](#8-running-multiple-servers-on-one-machine)
9. [Launcher Scripts](#9-launcher-scripts)
10. [Data Directory Layout](#10-data-directory-layout)
11. [Quick Reference](#11-quick-reference)

---

## 1. Config File Overview

Each server instance reads one JSON config file. The file has two top-level keys:

```json
{
  "Settings": { ... },
  "Channels": [ ... ]
}
```

**Where the file lives:** The server looks for the config in its *working directory* unless you pass an absolute or relative path as the first command-line argument (covered in sections 7 and 8).

**Auto-generation:** If the specified config file does not exist, the server creates it with defaults (port 8080, one voice channel, one text channel) and exits cleanly on next run. This lets you bootstrap a new server by simply pointing it at a path that doesn't exist yet, then editing the generated file.

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

| Field | Type | Description |
|---|---|---|
| `ServerName` | string | Display name shown to clients in the channel bar header and in the server's console window title |
| `Port` | integer | TCP port the WebSocket server binds to. **Must be unique per instance on the same machine.** |
| `RequirePassword` | bool | Reserved — password is sent by the client but validation is not yet enforced server-side |
| `ServerPassword` | string | The password clients must supply when connecting |
| `AdminEmail` | string | Informational only, not used by the server currently |

**Port range:** Use anything from `1024` to `65535`. Ports below 1024 require admin/elevated privileges on Windows. Common choices: `8080`, `8081`, `8082`, `9000`, `9001`, etc.

---

## 3. Channel Types

Every entry in the `Channels` array has three fields:

```json
{ "Id": "...", "Name": "...", "Type": "..." }
```

There are three valid `Type` values:

### `"Voice"`
A joinable audio channel. Users click it to enter voice, see other occupants listed beneath it in real time, and click the ✖ button to leave. Multiple users in the same voice channel are connected peer-to-peer via WebRTC.

```json
{ "Id": "c_ops_v", "Name": "Command", "Type": "Voice" }
```

### `"Text"`
A selectable text chat channel. Users click it to open its message history in the chat pane. Sending a message routes it to whichever text channel is currently selected. Text channels are independent of voice — switching between text channels does not affect your voice connection.

```json
{ "Id": "c_ops_t", "Name": "ops-log", "Type": "Text" }
```

### `"Header"`
A non-interactive section label rendered as a small uppercase divider in the channel sidebar — exactly like Discord's category headers. Headers are never joined or selected; they are purely visual. The `Id` field is still required and must be unique, but it is never used for any functional purpose.

```json
{ "Id": "hdr_ops", "Name": "Operations", "Type": "Header" }
```

**Client rendering order:** Channels are rendered in the sidebar in the exact order they appear in the `Channels` array. Place your `Header` entries wherever you want the section break to appear.

---

## 4. Channel ID Rules

The `Id` field is critical. It is used as:
- The primary key for routing voice state (who is in which channel)
- The filename for the text chat history log: `chat-{Id}.jsonl`
- The DOM element identifier on the client

**Rules:**
1. **Must be unique within a config file.** Duplicate IDs cause undefined behaviour (the second channel silently overwrites the first in the server's state).
2. **Must be unique across all server instances running on the same machine if they share a working directory.** If two servers use the same working directory and have a channel with `Id = "c_gen_t"`, their chat logs will collide. The easiest fix is to give each server its own `DataDir` (covered in section 10), or to prefix IDs with a server abbreviation.
3. **Allowed characters:** letters, numbers, underscores, hyphens. No spaces. No special characters.
4. **Convention:** `{server_prefix}_{purpose}_{type_initial}` — e.g. `alpha_ops_v` for Bunker Alpha's Operations voice channel. This makes logs immediately identifiable.

**Good IDs:**
```
alpha_cmd_v      beta_lobby_v      srv3_officers_t
hdr_alpha_ops    c_general_voice   announcements_t
```

**Bad IDs:**
```
General Voice    (spaces — will break file paths)
c gen t          (spaces)
channel#1        (special character)
```

---

## 5. Building a Channel Structure

### Flat structure (no headers)

The simplest layout — channels listed in order, no section breaks. The client just stacks them top to bottom.

```json
"Channels": [
  { "Id": "c_voice_1", "Name": "General",  "Type": "Voice" },
  { "Id": "c_voice_2", "Name": "AFK",      "Type": "Voice" },
  { "Id": "c_text_1",  "Name": "general",  "Type": "Text"  },
  { "Id": "c_text_2",  "Name": "off-topic","Type": "Text"  }
]
```

Renders as:
```
🔊 General
🔊 AFK
#  general
#  off-topic
```

### Sectioned structure (with headers)

Use `Header` entries to group related channels. You can interleave voice and text however you like — the order in the array is the order on screen.

```json
"Channels": [
  { "Id": "hdr_ops",    "Name": "Operations",  "Type": "Header" },
  { "Id": "ops_cmd_v",  "Name": "Command",     "Type": "Voice"  },
  { "Id": "ops_sit_v",  "Name": "Situational", "Type": "Voice"  },
  { "Id": "ops_log_t",  "Name": "ops-log",     "Type": "Text"   },

  { "Id": "hdr_social", "Name": "Social",      "Type": "Header" },
  { "Id": "soc_hang_v", "Name": "Hangout",     "Type": "Voice"  },
  { "Id": "soc_afk_v",  "Name": "AFK",         "Type": "Voice"  },
  { "Id": "soc_gen_t",  "Name": "general",     "Type": "Text"   },
  { "Id": "soc_memes_t","Name": "memes",       "Type": "Text"   }
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
  #  memes
```

### Mixing voice and text within a section

There is no restriction on order. If you want a text channel sandwiched between two voice channels, that is valid:

```json
"Channels": [
  { "Id": "hdr_pub",   "Name": "Public",    "Type": "Header" },
  { "Id": "pub_v",     "Name": "Lobby",     "Type": "Voice"  },
  { "Id": "pub_t",     "Name": "lobby-chat","Type": "Text"   },
  { "Id": "pub_lfg_v", "Name": "LFG",       "Type": "Voice"  },

  { "Id": "hdr_priv",  "Name": "Officers",  "Type": "Header" },
  { "Id": "priv_v",    "Name": "Briefing",  "Type": "Voice"  },
  { "Id": "priv_t",    "Name": "intel",     "Type": "Text"   }
]
```

### Divider-only header (horizontal rule effect)

If you set `Name` to a sequence of dashes or a unicode line character, the header acts as a visual divider with no label text — though the section label CSS uppercases and letter-spaces it, so it may still be visible. A single dash or a long dash string works:

```json
{ "Id": "hdr_div1", "Name": "──────────", "Type": "Header" }
```

---

## 6. Full Config Examples

### Minimal (no password, two channels)

```json
{
  "Settings": {
    "ServerName":     "My Server",
    "Port":            8080,
    "RequirePassword": false,
    "ServerPassword":  "",
    "AdminEmail":      ""
  },
  "Channels": [
    { "Id": "c_voice", "Name": "General", "Type": "Voice" },
    { "Id": "c_text",  "Name": "chat",    "Type": "Text"  }
  ]
}
```

### Gaming clan server

```json
{
  "Settings": {
    "ServerName":     "Anvil Gaming",
    "Port":            8080,
    "RequirePassword": true,
    "ServerPassword":  "anvil2026",
    "AdminEmail":      ""
  },
  "Channels": [
    { "Id": "hdr_main",   "Name": "Main",        "Type": "Header" },
    { "Id": "ag_lobby_v", "Name": "Lobby",        "Type": "Voice"  },
    { "Id": "ag_gen_t",   "Name": "general",      "Type": "Text"   },
    { "Id": "ag_news_t",  "Name": "announcements","Type": "Text"   },

    { "Id": "hdr_play",   "Name": "Playing",      "Type": "Header" },
    { "Id": "ag_squad1_v","Name": "Squad 1",      "Type": "Voice"  },
    { "Id": "ag_squad2_v","Name": "Squad 2",      "Type": "Voice"  },
    { "Id": "ag_squad3_v","Name": "Squad 3",      "Type": "Voice"  },
    { "Id": "ag_strat_t", "Name": "strats",       "Type": "Text"   },

    { "Id": "hdr_staff",  "Name": "Staff",        "Type": "Header" },
    { "Id": "ag_staff_v", "Name": "Staff Room",   "Type": "Voice"  },
    { "Id": "ag_staff_t", "Name": "staff-chat",   "Type": "Text"   }
  ]
}
```

### Two servers on the same machine (different ports, prefixed IDs)

`configs/alpha.json`:
```json
{
  "Settings": { "ServerName": "Bunker Alpha", "Port": 8080, "RequirePassword": true, "ServerPassword": "alpha", "AdminEmail": "" },
  "Channels": [
    { "Id": "hdr_a_ops",  "Name": "Operations", "Type": "Header" },
    { "Id": "a_ops_v",    "Name": "Command",    "Type": "Voice"  },
    { "Id": "a_ops_t",    "Name": "ops-log",    "Type": "Text"   },
    { "Id": "hdr_a_soc",  "Name": "Social",     "Type": "Header" },
    { "Id": "a_hang_v",   "Name": "Hangout",    "Type": "Voice"  },
    { "Id": "a_gen_t",    "Name": "general",    "Type": "Text"   }
  ]
}
```

`configs/beta.json`:
```json
{
  "Settings": { "ServerName": "Bunker Beta", "Port": 8081, "RequirePassword": true, "ServerPassword": "beta", "AdminEmail": "" },
  "Channels": [
    { "Id": "hdr_b_main", "Name": "Main",      "Type": "Header" },
    { "Id": "b_lobby_v",  "Name": "Lobby",     "Type": "Voice"  },
    { "Id": "b_main_t",   "Name": "general",   "Type": "Text"   },
    { "Id": "hdr_b_priv", "Name": "Private",   "Type": "Header" },
    { "Id": "b_priv_v",   "Name": "Officers",  "Type": "Voice"  },
    { "Id": "b_priv_t",   "Name": "intel",     "Type": "Text"   }
  ]
}
```

---

## 7. Running a Single Server

The server executable is at:
```
iskra_server\bin\Release\net8.0\iskra_server.exe
```

### No argument — uses `ServerConfig.json` in current directory

```powershell
cd iskra_server\bin\Release\net8.0
.\iskra_server.exe
```

If `ServerConfig.json` does not exist in that directory, a default one is generated and the server starts on port 8080.

### With a config path argument

The first (and only) argument is the path to the config file. It can be absolute or relative to where you run the command from.

```powershell
# Relative path from solution root
.\iskra_server\bin\Release\net8.0\iskra_server.exe .\configs\bunker-alpha.json

# Absolute path
.\iskra_server\bin\Release\net8.0\iskra_server.exe "C:\Servers\alpha\alpha.json"

# From the EXE's own directory
cd iskra_server\bin\Release\net8.0
.\iskra_server.exe "D:\Iskra\configs\bunker-alpha.json"
```

```batch
:: CMD equivalent
iskra_server\bin\Release\net8.0\iskra_server.exe configs\bunker-alpha.json
```

### Controlling where chat logs are written

Chat history files (`chat-{channelId}.jsonl`) are written to the **working directory** — wherever the terminal is `cd`'d to when you launch the process, not where the EXE lives and not where the config file lives. Use this to keep each server's data isolated:

```powershell
# Create the data directory, cd into it, then launch pointing at the config
New-Item -ItemType Directory -Force "server-data\alpha"
cd server-data\alpha
..\..\iskra_server\bin\Release\net8.0\iskra_server.exe "..\..\configs\bunker-alpha.json"
```

The console window title will read `Origin Server — Bunker Alpha :8080` so you can identify it at a glance when running multiple instances.

---

## 8. Running Multiple Servers on One Machine

### Requirements

- Each server must have a **unique port** in its `"Settings"` block.
- Each server should have its own **working directory** so chat log files (`chat-{id}.jsonl`) do not collide.
- Channel IDs should be **prefixed per server** as a best practice, in case you ever move data directories around.

### By hand in separate terminals

Open a PowerShell window for each server:

**Terminal 1:**
```powershell
New-Item -ItemType Directory -Force "server-data\alpha"
cd server-data\alpha
..\..\iskra_server\bin\Release\net8.0\iskra_server.exe "..\..\configs\bunker-alpha.json"
```

**Terminal 2:**
```powershell
New-Item -ItemType Directory -Force "server-data\beta"
cd server-data\beta
..\..\iskra_server\bin\Release\net8.0\iskra_server.exe "..\..\configs\bunker-beta.json"
```

Each opens in its own window and logs independently.

### Via PowerShell launcher script

The `launch-servers.ps1` script at the repo root handles directory creation and process spawning automatically. Edit the `$Servers` array to add or remove instances:

```powershell
$Servers = @(
    @{ Config = "configs\bunker-alpha.json"; DataDir = "server-data\alpha" },
    @{ Config = "configs\bunker-beta.json";  DataDir = "server-data\beta"  },
    @{ Config = "configs\bunker-gamma.json"; DataDir = "server-data\gamma" },
    @{ Config = "configs\bunker-delta.json"; DataDir = "server-data\delta" },
    @{ Config = "configs\bunker-epsilon.json"; DataDir = "server-data\epsilon" }
)
```

Run it:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\launch-servers.ps1
```

Each server spawns in its own console window. Five configs = five windows = five independent servers.

### Via batch file launcher

The `launch-servers.bat` file at the repo root works identically but from CMD. Edit it to add more `start` blocks following the same pattern:

```batch
set CFG_C=%~dp0configs\bunker-gamma.json
set DIR_C=%~dp0server-data\gamma
if not exist "%DIR_C%" mkdir "%DIR_C%"
start "Bunker Gamma" /D "%DIR_C%" "%EXE%" "%CFG_C%"
```

Run it:
```batch
launch-servers.bat
```

### Firewall / port forwarding

If you are hosting for LAN or WAN access:
- The server attempts to bind `http://+:{PORT}/` (all interfaces) first. This requires either running as administrator or registering the URL with `netsh`.
- If that fails, it falls back to `http://localhost:{PORT}/` (loopback only — local machine can connect, LAN cannot).

To register a port without running as admin (do this once per port):
```batch
netsh http add urlacl url=http://+:8080/ user=Everyone
netsh http add urlacl url=http://+:8081/ user=Everyone
```

For WAN access, forward each port in your router to the host machine's LAN IP.

---

## 9. Launcher Scripts

### `launch-servers.ps1` (PowerShell)

Located at the repo root. Edit `$Servers` to configure instances. Each entry needs:

| Key | Description |
|---|---|
| `Config` | Path to the config JSON, relative to the repo root |
| `DataDir` | Path to the data directory for this instance, relative to repo root |

The script reads `ServerName` directly from the JSON to name the spawned process window. It creates `DataDir` automatically if it does not exist.

```powershell
.\launch-servers.ps1
```

### `launch-servers.bat` (CMD/Batch)

Located at the repo root. Each server is a block of four lines — duplicate the block and adjust paths and window title for additional instances.

```batch
launch-servers.bat
```

### Running a specific server directly without a launcher

```powershell
# PowerShell one-liner: create data dir, start server in it
$d = "server-data\alpha"; New-Item -Force -ItemType Directory $d | Out-Null
Start-Process .\iskra_server\bin\Release\net8.0\iskra_server.exe `
    -ArgumentList ('"' + (Resolve-Path .\configs\bunker-alpha.json) + '"') `
    -WorkingDirectory (Resolve-Path $d)
```

---

## 10. Data Directory Layout

After running one or more servers, your working directories will contain:

```
server-data\
  alpha\
    ServerConfig.json          ← only if you launched without --config and it auto-generated
    chat-a_ops_t.jsonl         ← text history for channel Id "a_ops_t"
    chat-a_gen_t.jsonl         ← text history for channel Id "a_gen_t"
  beta\
    chat-b_main_t.jsonl
    chat-b_priv_t.jsonl
```

**JSONL format:** Each line is one `CHAT_RECEIVE` message:
```json
{"action":"CHAT_RECEIVE","channelId":"a_gen_t","author":"Viktor","time":"3:42 PM","message":"hello"}
```

On each client connect, the server replays the last 50 lines from each text channel's file. There is no size cap currently — trim or archive old files manually if they grow large.

**Backing up:** Copy the entire `server-data\{name}\` directory. The config JSON and chat JSONL files are the complete persistent state of a server. No database, no registry entries.

---

## 11. Quick Reference

### Valid channel types

| Type | Joinable | Selectable | Logged | Rendered as |
|---|---|---|---|---|
| `Voice` | Yes | No | No | 🔊 channel row with user list |
| `Text` | No | Yes | Yes (`chat-{id}.jsonl`) | # channel row |
| `Header` | No | No | No | Section label / divider |

### Config file checklist

- [ ] `Port` is unique across all running instances
- [ ] All `Id` values are unique within the file
- [ ] All `Id` values are unique across instances that share a working directory (or each instance has its own data dir)
- [ ] No spaces or special characters in any `Id`
- [ ] `Header` entries have a unique `Id` even though it is never used functionally
- [ ] File is valid JSON (trailing commas are not allowed in JSON — use a linter if unsure)

### Port quick-pick for five servers

| Instance | Port |
|---|---|
| Alpha | 8080 |
| Beta | 8081 |
| Gamma | 8082 |
| Delta | 8083 |
| Epsilon | 8084 |

### Minimal one-liner to start a named server

```powershell
# Replace paths and port as needed
$cfg = "C:\Iskra\configs\alpha.json"
$data = "C:\Iskra\server-data\alpha"
New-Item -Force -ItemType Directory $data | Out-Null
Start-Process "C:\Iskra\iskra_server\bin\Release\net8.0\iskra_server.exe" -ArgumentList "`"$cfg`"" -WorkingDirectory $data
```
