# Iskra — Feature Inventory

> Living document. Update this file whenever a feature is added, fixed, or changed.
> Last updated: 2026-05-08

---

## Architecture

- **Server**: C# WebSocket server (`iskra_server/Program.cs`), port 8080 by default
- **Client wrapper**: C# WPF/WebView2 app (`iskra_client/Program.cs`) — bridge between OS and JS
- **Frontend**: Single-file vanilla JS/HTML/CSS (`iskra_client/index.html`)
- **World model**: `servers/<name>/` folder per instance — `server.json`, `chat-{chId}.jsonl`, `dms/`, `fingerprints.json`, `bans.json`, `audit.jsonl`, `uploads/`
- **Iskra Relay**: ASP.NET Core minimal API (`iskra_relay/`) — deployed at `https://id.iskra.foo` on DigitalOcean AMS3; SQLite, Resend email, bcrypt passwords, hex session tokens

---

## Feature Status

### Messaging

| Feature | Status | Notes |
|---------|--------|-------|
| Text channels with history | ✅ | Last 50 lines loaded on connect; scroll back in session |
| Markdown rendering | ✅ | Bold, italic, strike, spoiler, inline code, code block, blockquote, @mention, custom emoji |
| Syntax highlighting in code blocks | ✅ | Language-agnostic tokenizer (keywords, strings, comments, numbers, fn calls) |
| Syntax highlighting in inline code | ✅ | Same tokenizer |
| Code block horizontal scroll | ✅ | `max-width: 640px`, scrollable |
| Multi-line chat input (textarea) | ✅ | Auto-resize up to 150px; Shift+Enter for newline |
| Formatting toolbar | ✅ | ✏ button or Ctrl+Shift+F; inserts template with placeholder selected |
| Message edit | ✅ | Inline textarea, Enter to save, Esc to cancel; edit history tracked |
| Message delete | ✅ | Shift+click to skip confirm; admins can delete any message |
| Message pin/unpin | ✅ | Admin+; pin count badge in header; dedicated pin panel |
| Emoji reactions | ✅ | Standard + custom server emoji; hover shows who reacted |
| Reply with quote | ✅ | Inline quote block; click to scroll to original |
| Full thread branching | ✅ | Side-panel threads off any message; persistent; count shown on parent |
| Message forward | ✅ | Modal picks destination channel/DM, optional comment |
| Bookmarks / starred messages | ✅ | Per-message ☆ button; panel shows all bookmarks by server |
| Link previews (Open Graph) | ✅ | Title + description + image; cached server-side; YouTube via oEmbed |
| Typing indicators | ✅ | "X is typing…" with 3s debounce |
| System messages | ✅ | Amber italic; multi-line (pre-wrap) for /help output |
| @mention highlighting (received) | ✅ | Personal mentions highlighted; @everyone/@here distinct colour; role mentions amber |
| @mention autocomplete (while typing) | ✅ | Popup with online users + role names; ↑↓ navigate; Enter/Tab to insert |
| Role @mentions (`@member`, `@admin` etc.) | ✅ | Highlights all members with that role; shown amber in chat |
| Poll command | ✅ | `/poll "Question" "Option A" "Option B"` — click to vote; live bar chart; toggle vote |
| Message search | ✅ | Ctrl+F; searches current channel; debounced; click result to scroll |
| Slow mode | ✅ | `/slowmode <secs>` per channel; admin bypass; countdown bar shown |
| Reply threads (Discord-style) | ✅ | 💬 button on message; side panel with full history; count indicator on parent |

### Direct Messages

| Feature | Status | Notes |
|---------|--------|-------|
| DM conversations | ✅ | Right-click user or click in members list |
| DM history | ✅ | Loaded on open; last 100 messages |
| DM edit | ✅ | Same inline edit UI as channel messages |
| DM delete | ✅ | Removes from both parties |
| DM read receipts | ✅ | Avatar + "Seen" shown on last read message for recipient |
| DM unread badges | ✅ | Per-conversation + total badge on DM toggle button |
| DM notifications | ✅ | Desktop notification when not focused |
| 1:1 DM voice calls | ✅ | 📞 button in DM header; WebRTC via server relay; accept/decline overlay; mute + timer bar; hangup |

### Voice & Audio

| Feature | Status | Notes |
|---------|--------|-------|
| Voice channels | ✅ | Join/leave; user list shown in sidebar with speaking pulse |
| Push-to-Talk (PTT) | ✅ | Configurable key (default Z); global poll at 10ms via C# bridge |
| Voice Activity Detection (VAD) | ✅ | Toggle; sensitivity slider; 400ms hold time |
| Mute / Deafen | ✅ | Footer buttons; status dot reflects state |
| Per-user volume | ✅ | Right-click voice user; 0–200% slider |
| Input / output gain sliders | ✅ | In Audio settings |
| Mic meter | ✅ | Live level bar in footer |
| VAD sensitivity meter | ✅ | Live bar in Audio settings modal |
| Noise suppression (RNNoise) | ✅ | WASM module; toggle in Audio settings |
| Soundboard | ✅ | Add/play .mp3/.wav/.ogg clips; plays into voice channel |

### Video & Screen Share

| Feature | Status | Notes |
|---------|--------|-------|
| Screen sharing | ✅ | P2P WebRTC; fullscreen overlay view; includes system audio track |
| Video (webcam) in voice | ✅ | Toggle button; 30 FPS target; shows in share panel |
| Synchronized watch party | ✅ | YouTube IFrame API; host controls playback; viewers sync via WATCH_TICK every 5s with drift correction; `/watch <url>` or "▶ Watch Together" on preview cards |

### Files & Media

| Feature | Status | Notes |
|---------|--------|-------|
| File uploads | ✅ | Click attach, drag/drop, or paste; blocked extension list; configurable size limit |
| Inline image display | ✅ | Lazy-loaded; click to zoom |
| Avatar upload + crop | ✅ | Circular crop modal; zoom/pan |
| Server icon upload | ✅ | Same crop flow |
| GIF picker | ✅ | 🎬 button in chat input; Tenor search; trending on open |

### Roles & Permissions

| Feature | Status | Notes |
|---------|--------|-------|
| Role hierarchy | ✅ | guest < member < trusted < admin < owner |
| Role colors | ✅ | Configured per role in server settings; shown on names in chat |
| Role badges | ✅ | Shown in members panel and footer |
| Per-channel MinRole (read) | ✅ | Server-enforced |
| Per-channel WriteRole (post) | ✅ | Server-enforced |
| Role grant/revoke command | ✅ | `/role <alias> <role>` — admin can grant up to trusted, owner up to admin |

### Admin & Moderation

| Feature | Status | Notes |
|---------|--------|-------|
| `/help` / `/commands` | ✅ | Shows role-appropriate command list; available to all roles |
| `/shh [secs] <message>` | ✅ | Ephemeral message — visible to all but auto-deleted after N seconds (default 60) |
| `/kick <alias> [reason]` | ✅ | Immediate disconnect; system message broadcast |
| `/ban <alias> [reason]` | ✅ | GUID-based permanent ban; persisted to `bans.json` |
| `/unban <guid>` | ✅ | Removes ban entry |
| `/slowmode <secs> [channelId]` | ✅ | 0 = off; countdown bar shown to users |
| `/timeout <alias> <mins> [reason]` | ✅ | Timed-out users cannot send messages; badge shown in member list |
| `/untimeout <alias>` | ✅ | Removes active timeout |
| `/adduser <alias> <pass>` | ✅ | Owner only; registers a user account |
| `/removeuser <alias>` | ✅ | Owner only |
| `/passwd <alias> <pass>` | ✅ | Owner only; updates password hash |
| `/authmode <mode>` | ✅ | Owner only; open / registered+guests / verified-only |
| `/listusers` | ✅ | Owner only; lists registered users and current auth mode |
| Starboard | ✅ | Reaction threshold auto-posts to a designated channel; admin configures emoji/threshold/channel |
| Audit log | ✅ | JSONL file; viewable in admin panel; last 150 entries |
| Server backup | ✅ | Downloads ZIP of all world data from admin panel |

### Channels & Server Structure

| Feature | Status | Notes |
|---------|--------|-------|
| Text channels | ✅ | With history, topics, slow mode, notify prefs |
| Voice channels | ✅ | With inline user list; live activity status set by users in channel |
| Channel categories (headers) | ✅ | Collapsible section labels |
| Channel topics | ✅ | Editable by admin+; shown in chat header |
| Per-channel notification override | ✅ | All / Mentions only / Muted; icon in sidebar |
| Announcement channel type | ❌ | Not implemented |
| Forum/thread channel type | ❌ | Not implemented |

### Server Discovery & Invites

| Feature | Status | Notes |
|---------|--------|-------|
| `iskra://` protocol invite links | ✅ | One-click join; base64-encoded, time-limited |
| Server list (add/edit/remove) | ✅ | In Settings → Servers |
| Per-server nickname | ✅ | Optional display name override per server |

### Settings & Personalisation

| Feature | Status | Notes |
|---------|--------|-------|
| Audio settings (device, gain, VAD) | ✅ | Mic/speaker device select; input/output gain |
| Identity settings (aliases, avatar) | ✅ | Add/remove/select alias; upload avatar |
| Servers settings | ✅ | Connection management |
| Appearance settings (themes) | ✅ | 7 built-in themes + custom JSON import/export |
| Custom status text | ✅ | Set via status dot; shown in profile card and members list |
| Status text presets | ✅ | Chip strip in status picker; click to apply, right-click to remove, + Save to add |
| Private notes on users | ✅ | Per-user note textarea in profile card; stored in localStorage only |
| Admin settings panel | ✅ | Members, roles, channels, bot tokens, webhooks, emoji, starboard, audit, backup |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+K | Quick server/channel switcher |
| Ctrl+F | Message search |
| Ctrl+/ | Keyboard shortcuts overlay |
| Ctrl+Shift+F | Formatting toolbar |
| F9 | Toggle DevLog panel |
| Shift+F9 | Clear DevLog |
| Enter | Send message |
| Shift+Enter | New line in message |
| ↑ (in empty input) | Edit last own message |
| Esc | Close modals / popups |
| PTT key (default Z) | Push-to-talk (configurable) |

### Developer & Integration Features

| Feature | Status | Notes |
|---------|--------|-------|
| Outbound webhooks | ✅ | HTTP POST to URL on new message; admin manages |
| Inbound webhooks (GitHub/CI → channel) | ❌ | Not yet implemented |
| Inbound bot API | ✅ | Named bot tokens; bots connect via WebSocket |
| Auto-update | ✅ | Checks GitHub releases API on startup; download progress bar; self-replaces via PS script; opt-in toggle in settings |
| DevLog panel | ✅ | F9; colour-coded by category (BRIDGE, VOICE, RTC, etc.) |
| E2E encryption (channels + DMs) | ✅ | AES-GCM 256; EC pubkey wrapping; per-member access |
| TURN server support | ✅ | Configured in `server.json`; sent to clients in ICE config |
| Link preview caching | ✅ | OG tags fetched server-side; cached |
| Profile cards | ✅ | Click any username/avatar; shows role, status, actions |

### Iskra ID & Global Relay (`id.iskra.foo`)

| Feature | Status | Notes |
|---------|--------|-------|
| Global identity registration | ✅ | Alias + email + password; alias globally unique (first-come-first-served) |
| Email verification | ✅ | Resend API via `noreply@iskra.foo`; resend button in ID tab |
| Login / logout | ✅ | Bearer token stored in `localStorage`; session restored on boot |
| Password recovery | ✅ | Email reset link; 1-hour expiry; all sessions invalidated on reset |
| Alias change | ✅ | Once per 30 days; days-remaining shown on rejection |
| Friends — send / accept / reject / remove | ✅ | By alias; pending requests shown in friends panel |
| Global relay DMs | ✅ | Store-and-forward via relay; 30-day TTL; inbox polled every 30s |
| Relay DM history | ✅ | Stored in `localStorage` per conversation (last 200 messages) |
| Friends panel | ✅ | 👥 button in server bar; filter, add, message, remove |
| Iskra ID settings tab | ✅ | 🪪 ID tab in Settings; shows alias, email, verification status |
| CORS | ✅ | `AllowAnyOrigin` — required for WebView2 fetch |
| E2E encryption for relay DMs | ✅ | ECDH P-256 + AES-GCM 256; private key PBKDF2-wrapped, stored as key_backup; relay is zero-knowledge |
| Relay DM notifications | ✅ | Desktop notification when app not focused and new relay message arrives |
| Profile pages | ✅ | Link GitHub Pages / Neocities / Cloudflare Pages / Netlify; relay proxies + sanitizes; rendered in sandboxed iframe |

### Iskra ID & Relay — Recent Additions

| Feature | Status | Notes |
|---------|--------|-------|
| Relay DM read receipts | ✅ | Receipts table; sender sees "✓ Seen [time]" under last delivered message |
| Relay avatar sync | ✅ | PUT/GET `/api/me/avatar`; data URL base64 up to 128 KB; shown across servers |
| Profile page media | ✅ | YouTube muted by default; relay injects mute param + controller script; user can unmute via 🔇/🎤 button + volume slider |
| Server discovery | ✅ | `GET /findservers` HTML page; servers opt in via `PublicListing` in server.json; auto-ping every 4 min |
| Persistent unread state | ✅ | `lastSeenTs` per channel persisted in localStorage; accurate across reconnects |
| Media gallery view | ✅ | 🖼 in chat header; 72×72 image/video thumbnails for current channel |
| Jump-to-message links | ✅ | 🔗 on each message; copies `serverId/channelId/msgId`; smooth scroll + flash animation |
| Animated GIF avatars | ✅ | Avatars uploaded as GIF render animated |

### Planned / Not Yet Implemented

| Feature | Notes |
|---------|-------|
| Announcement channel type | Read-only for non-admins |
| Forum/board channel type | Post-style threads |
| Server templates | Clone channel/role layout |
| Stage channels | One speaker, many listeners |
| Inbound webhook (GitHub/CI → channel) | HTTP POST from GitHub, CI, etc. into a channel |
| Mobile PWA | Push notifications, offline shell |
| Spotify now-playing status | Show current track as custom status |
