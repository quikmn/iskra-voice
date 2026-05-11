# Iskra — Feature Inventory

> Living document. Update whenever a feature is added, fixed, or changed.  
> Last updated: 2026-05-11 · v1.1.15.6

---

## Architecture

| Component | Description |
|-----------|-------------|
| **Server** | C# WebSocket server (`iskra_server/Program.cs`), port 8080 by default |
| **Client wrapper** | C# WPF/WebView2 app (`iskra_client/Program.cs`) — bridges OS and JS frontend |
| **Frontend** | Single-file vanilla JS/HTML/CSS (`iskra_client/index.html`, ~10k lines) |
| **World model** | `servers/<name>/` per instance — `server.json`, `chat-{chId}.jsonl`, `dms/`, `fingerprints.json`, `bans.json`, `audit.jsonl`, `uploads/` |
| **Iskra Relay** | ASP.NET Core minimal API (`iskra_relay/`) at `id.iskra.foo` — SQLite, Resend email, bcrypt, hex session tokens |

---

# PART 1 — WHAT WE HAVE

## Messaging

| Feature | Notes |
|---------|-------|
| Text channels with history | Last 50 lines on connect; scrollback in session; JSONL storage |
| Markdown rendering | Bold, italic, strikethrough, spoiler, inline code, code blocks, blockquotes, @mentions, custom emoji |
| Syntax highlighting | Language-agnostic tokenizer in code blocks and inline code |
| Multi-line chat input | Auto-resize to 150px; Shift+Enter for newline |
| Formatting toolbar | ✏ button or Ctrl+Shift+F; inserts template with placeholder |
| Message edit | Inline textarea; Enter save, Esc cancel; edit history tracked; formatting toolbar (same as compose) available in edit mode |
| Message delete | Shift+click to skip confirm; admins delete any message |
| Message pin/unpin | Admin+; pin count badge in header; dedicated pin panel |
| Emoji reactions | Standard + custom server emoji; hover shows who reacted |
| Reply with quote | Inline quote block; click scrolls to original |
| Full threads | Side-panel threads off any message; persistent; count shown on parent |
| Message forward | Modal picks destination channel/DM with optional comment |
| Bookmarks / starred messages | ☆ per message; panel shows all bookmarks aggregated by server |
| Jump-to-message links | 🔗 on each message; copies serverId/channelId/msgId; scroll + flash |
| Link previews (Open Graph) | Title + description + image; cached server-side; YouTube via oEmbed |
| Typing indicators | "X is typing…" 3s debounce |
| System messages | Amber italic; multi-line pre-wrap for /help output |
| @mention autocomplete | Popup with online users + role names; ↑↓ navigate; Enter/Tab insert |
| Role @mentions | `@member`, `@admin` etc.; highlights all role members; shown amber |
| Poll command | `/poll "Q" "A" "B"` — click to vote; live bar chart; toggle vote |
| Message search | Ctrl+F; default searches current channel; checkboxes expand to all-server or DMs; click result scrolls and flashes |
| Search filters | `from:alias`, `"exact phrase"`, `has:image/link/file/code/reaction`, `mentions:alias`, `after:`/`before:YYYY-MM-DD`, `OR` operator; sort newest/oldest |
| Search regex mode | `.*` toggle switches to client-side regex filter on live results |
| Slow mode | `/slowmode <secs>` per channel; admin bypass; countdown bar |
| Ephemeral messages | `/shh [secs] <msg>` — visible to all, auto-deleted after N seconds |
| Starboard | Reaction threshold auto-posts to designated channel; admin configures |
| Message scheduling | Client-side timer sends message at chosen datetime; requires client open at send time |
| Message reminders | 🔔 on any message; pick 30 min / 1 h / 3 h / tomorrow / custom; fires desktop notification + popup with jump link; localStorage persistence |
| Mark all as read | Right-click server → Mark all as read; clears all channel unread counts |
| Media gallery | 🖼 in chat header; 72×72 thumbnails for all images/videos in channel |
| Unread jump pill | "↓ N unread" pill appears when scrolled up; click scrolls to latest and clears count; auto-hides when at bottom |
| Message drafts | Compose box content saved per-channel in memory; restored automatically on channel switch |
| Message export | Download all visible channel messages as a .txt file; button in chat header |

## Direct Messages

| Feature | Notes |
|---------|-------|
| DM conversations | Right-click user or click members list |
| DM history | Last 100 messages loaded on open |
| DM edit / delete | Inline edit; delete removes from both parties |
| DM read receipts | Avatar + "Seen" on last read message |
| DM unread badges | Per-conversation + total badge on toggle button |
| DM notifications | Desktop notification when not focused |
| 1:1 DM voice calls | 📞 in DM header; WebRTC relay; accept/decline overlay; mute + timer |
| Pinned DMs | Right-click → Pin DM; pinned section shown above All Messages |
| Contact nicknames | Right-click → Set Nickname; displayed in DM list and chat |
| DM folders | Right-click → Add to Folder; colour-coded collapsible groups; rename/delete |

## Voice & Audio

| Feature | Notes |
|---------|-------|
| Voice channels | Join/leave; user list in sidebar with speaking pulse |
| Voice Activity Detection | Toggle; sensitivity slider; 400ms hold time; live bar in Audio settings |
| Mute / Deafen | Footer buttons; status dot reflects state |
| Push-to-Talk | Configurable key (default Z); global hook at 10ms via C# bridge |
| Per-user volume | Right-click voice user; 0–200% slider |
| Input / output gain | Sliders in Audio settings |
| Mic meter | Live level bar in footer |
| Noise suppression | RNNoise WASM module; bundled and working on both native and web; toggle in Audio settings |
| Soundboard | Add/play .mp3/.wav/.ogg clips into voice channel |
| Session recording | Footer button; records local mic + all remote peers; includes active video/screenshare track; downloads .webm on stop |
| Live transcription | 🗣 footer button; Web Speech API; continuous real-time captions shown in dismissible strip at bottom of voice panel; Chrome/Edge/WebView2 only |

## Video & Screen Share

| Feature | Notes |
|---------|-------|
| Screen sharing | P2P WebRTC; fullscreen overlay view; includes system audio |
| Webcam video in voice | Toggle button; 30 FPS target; shown in share panel |
| Screen annotation | ✏ button in share panel controls; draw strokes overlaid on screen; strokes broadcast to voice channel peers via ANNOTATE_STROKE; Clear button |
| Watch party | YouTube IFrame API; host controls playback; viewers sync via WATCH_TICK every 5s with drift correction; `/watch <url>` or "▶ Watch Together" on preview cards |

## Files & Media

| Feature | Notes |
|---------|-------|
| File uploads | Click attach, drag/drop, or paste; blocked extension list; configurable size limit; streaming to disk |
| Upload validation | Magic byte validation (JPEG/PNG/GIF/WEBP); extension whitelist; server-side size + disk quota check |
| File deduplication | SHA-256 hash-based; duplicate uploads reuse existing file on disk |
| Inline image display | Lazy-loaded; click to zoom |
| Inline video | In-channel video playback with controls |
| Inline audio player | .mp3/.ogg/.webm rendered as custom audio player in chat; blob-fetched on play for reliable WebView2 + browser playback |
| Voice messages | 🎙 in chat toolbar; record via MediaRecorder; waveform visualizer; sent as .webm audio file; playback via inline audio player |
| Channel files panel | 📎 button in chat toolbar; shows all attachments in channel as a grid |
| Avatar upload + crop | Circular crop modal; zoom/pan; animated GIFs supported |
| Server icon upload | Same crop flow |
| GIF picker | 🎬 in chat input; Tenor search; trending on open |

## Roles & Permissions

| Feature | Notes |
|---------|-------|
| Role hierarchy | guest < member < trusted < admin < owner |
| Role colors | Configured per role; shown on names in chat |
| Role badges | Shown in members panel and footer |
| Per-channel MinRole (read) | Server-enforced |
| Per-channel WriteRole (post) | Server-enforced |
| Role grant/revoke | `/role <alias> <role>` — admin grants up to trusted, owner up to admin |

## Admin & Moderation

| Command / Feature | Notes |
|-------------------|-------|
| `/help` / `/commands` | Role-appropriate command list |
| `/kick <alias> [reason]` | Immediate disconnect; system message broadcast |
| `/ban <alias> [reason]` | GUID-based permanent ban; persisted to `bans.json` |
| `/unban <guid>` | Removes ban entry |
| `/timeout <alias> <mins>` | Timed-out users cannot send; badge shown in member list |
| `/untimeout <alias>` | Removes timeout |
| `/slowmode <secs>` | Per channel; 0 = off; countdown bar shown |
| `/shh [secs] <msg>` | Ephemeral message |
| `/adduser <alias> <pass>` | Owner only; registers account |
| `/removeuser <alias>` | Owner only |
| `/passwd <alias> <pass>` | Owner only; updates password hash |
| `/authmode <mode>` | Owner only; open / registered+guests / verified-only |
| `/listusers` | Owner only; lists registered users and auth mode |
| Members panel | View, manage roles, kick, ban |
| Roles panel | Create, edit, delete; configure colors |
| Channels panel | Create, edit, delete; drag to reorder; set MinRole/WriteRole |
| Starboard config | Emoji, threshold, channel selection |
| Bot tokens | Generate, revoke |
| Webhooks | Inbound (GitHub/CI → channel) + outbound (new message → URL) |
| Custom emoji management | Upload, name, delete |
| Audit log | JSONL; viewable in admin panel; last 150 entries |
| Server analytics | 30-day message bar chart + top channels + top members; admin-only; on-demand via GET_ANALYTICS |
| Announcement read tracking | Admins enter message ID → see who confirmed reading (via MARK_PINNED_READ); auto-sent when pin panel opened |
| Auto-moderation | Word filter (block or replace), link domain allowlist; ALL rules OFF by default; admin-configurable; AUTOMOD_BLOCKED error shown to user |
| Regex search toggle | `.*` button in search bar; toggles regex mode on existing results; client-side filter |
| Voice channel search | All-channels search now includes voice channel text history (was incorrectly excluded) |
| Server backup | Downloads ZIP of all world data |

## Channels & Server Structure

| Feature | Notes |
|---------|-------|
| Text channels | History, topics, slow mode, notify prefs |
| Voice channels | Inline user list; live activity status |
| Forum channels | Classic table layout (Topic / Replies / Last Post columns); each post has title + body + optional tags; clicking a row opens an inline thread view with back button; replies in-line below the OP; "New Post" modal; 📋 icon in sidebar; admin creates via + button; phpBB-style rounded post cards with accent OP border; tags shown below OP content (not in nav bar) |
| Date/time format | User-configurable in Appearance settings: 12h (3:07 PM), 24h (15:07), Date+12h (yyyy-MM-dd h:mm AM/PM), Date+24h (yyyy-MM-dd HH:mm); applies globally to all messages, forum posts, thread replies |
| Channel categories | Collapsible section labels |
| Channel topics | Editable by admin+; shown in chat header |
| Per-channel notification override | All / Mentions only / Muted |
| History retention | Configurable `HistoryRetentionDays` in server.json (default 30 days); old messages purged at startup |
| Shared channel notes | 📝 button in server sidebar; server-persisted per-channel textarea; synced live to all connected members; debounced auto-save; Edit/Preview toggle with full markdown rendering; formatting toolbar (bold, italic, strike, code, blockquote, lists, code block, hr); Ctrl+B/I/` shortcuts; Tab indent |

## Multi-Server

| Feature | Notes |
|---------|-------|
| Simultaneous connections | All saved servers connect on launch; silent auto-reconnect with exponential backoff |
| Per-server state isolation | `serverStates{}` map — independent channels, messages, roles, voice, E2E keys |
| Instant server switching | Click icon → instant UI switch; no reconnect; unread badges accumulate |
| Voice across servers | Stay voiced on server A while browsing server B |
| Unread badges per server | Unread + mention counts independent of viewed server |
| Drag-to-reorder servers | Drag server icons in the sidebar to reorder; persisted to clientConfig |
| Online count in header | Chat header shows "N online" for the current channel; updates on voice join/leave |

## Server Discovery & Invites

| Feature | Notes |
|---------|-------|
| `iskra://` protocol invite links | One-click join; base64-encoded, time-limited; fills connection form automatically |
| Server list | Add/edit/remove in Settings → Servers; ● Online / ○ Offline status |
| Per-server nickname | Optional display name override per server |
| Favourite servers | ⭐ button or right-click menu; sorted to top of server list |
| Per-server sound overrides | Right-click server → Server Sounds; upload per-sound override for join/leave/message/mention etc. |
| Per-server avatar override | Right-click server → Server Avatar; sets a local avatar only visible on that server |
| Server discovery page | `GET /findservers`; servers opt in via `PublicListing` in server.json; auto-ping every 4 min |
| Server list sync | IskraID stores your server list; synced across devices on login; merge-only |

## IskraID & Global Identity

| Feature | Notes |
|---------|-------|
| Global identity registration | Alias + email + password; globally unique alias |
| Email verification | Via `noreply@iskra.foo` (Resend API); resend button in ID tab |
| Login / logout | Bearer token in localStorage; session restored on boot |
| Password recovery | Email reset link; 1-hour expiry; all sessions invalidated |
| Alias change | Once per 30 days; days-remaining shown on rejection |
| Friends system | Send/accept/reject/remove by alias; pending requests in relay panel and ID tab |
| Global relay DMs | Store-and-forward via relay; 30-day TTL; polled every 3s |
| Relay DM history | localStorage per conversation; last 200 messages |
| Relay DM encryption | ECDH P-256 + AES-GCM 256; zero-knowledge relay; private key PBKDF2-wrapped (600k iter) |
| Relay DM read receipts | "✓ Seen [time]" under last delivered message |
| Relay DM notifications | Desktop notification when not focused |
| Relay panel | 💬 in server bar; sorted by last message; unread badge + per-conv count |
| Relay avatar sync | Global avatar shown across all servers to IskraID users |
| Encryption banner | Green "🔐 End-to-end encrypted" or amber "⚠ Not encrypted" in DM header |
| E2E key setup / unlock | Auto-generate on login; PBKDF2 derivation; rate-limited (5 attempts, 60s lockout) |
| HMAC record integrity | SHA-256 MAC on relay DM records; verified on unlock; tampered records dropped |
| TOFU pubkey pins | Trusted contacts pinned in localStorage |
| Profile pages | Link Neocities / GitHub Pages / Cloudflare Pages / Netlify; proxied + sandboxed iframe |
| account.iskra.foo | Full account portal; register, login, alias, password, avatar, profile URL, token handoff |
| Token handoff | "Open Iskra" on account page pre-logs in app via URL params |

## Channel E2E Encryption

| Feature | Notes |
|---------|-------|
| Per-channel E2E toggle | Admin-only; via channel context menu |
| AES-GCM 256 symmetric encryption | Key exchanged via ECDH P-256 pubkey wrapping |
| Per-member access | Grant / rotate / revoke key access |
| `/enable-channel-e2e` / `/disable-channel-e2e` | Admin commands |
| `/grant-e2e-access <member>` / `/rotate-e2e-key` | Admin commands |

## Settings & Personalisation

| Feature | Notes |
|---------|-------|
| Audio settings | Mic/speaker device select; input/output gain; VAD; noise suppression; soundboard |
| Zero telemetry badge | Shown in channel sidebar on connect; confirms no data leaves the device |
| Identity settings | Aliases, avatar, per-server nickname, IskraID login, friends, profile URL, E2E unlock |
| Server settings | Connection management; add/edit/remove servers |
| Appearance (skins) | 7 built-in themes; custom JSON import/export; live preview |
| Chat density | Compact / Comfortable / Cozy — CSS density modes; toggle in Appearance settings |
| Custom notification sounds | Upload per-sound override (join/leave/message/mention/etc.) globally or per server |
| Keyword notifications | Comma-separated keywords in Audio settings; match → mention-level ping; not triggered on own messages |
| DND schedule | Enable in Audio settings; suppress desktop notifications between configured hours (e.g. 23:00–08:00); sounds and unread still work |
| Auto-away timeout | Configurable in Audio settings (2/5/10/15/30 min or Never); replaces hardcoded 5-min constant |
| Custom status text | Set via status dot; shown in profile card and member list |
| Status presets | Chip strip; click apply, right-click remove, + Save to add |
| Private notes on users | Per-user note textarea in profile card; localStorage only |
| Settings description panel | Fixed-width right column beside every settings tab; explains each tab's fields and the identity priority system; minimal scrollbar; hidden on mobile |
| AI catch-up summary | ✦ button in channel header; summarises last 150 messages using Groq/Anthropic/OpenAI; user supplies their own API key (stored in clientConfig, never leaves device); Groq free tier works; dismissible card result |
| Raider.io integration | Settings → Identity → link WoW character (name/realm/region); M+ score badge with raider.io colour on profile cards; `/rio` posts your score to chat; `/rio <name> <realm> <region>` looks up any character; scores shared server-wide via WebSocket; "Raider.io" tag badge on profile card integration block |
| Steam integration | Settings → Identity → paste Steam profile URL, vanity name, or 64-bit Steam ID (trailing slash and all URL formats handled); server fetches Steam public XML, parses display name, avatar, online state, current game, top played game + hours, member since, location; result stored in `steam.json`, broadcast to all clients, shown on profile card with "Steam" tag badge; re-sent on every server reconnect; profile must be public |
| Profile quote / bio | Settings → Identity → "Profile Quote" field (120 chars max); stored server-side in `bios.json`, broadcast live; shown in italics on profile card below role badge; persists across reconnects |
| Admin panel | Members, roles, channels, bot tokens, webhooks, emoji, starboard, audit, backup, analytics, auto-mod, read tracking, leveling/XP toggle |

## Profile Cards

| Feature | Notes |
|---------|-------|
| Hover card | Click or hover any name/avatar in chat to open; click own name in footer to open self-card; shows avatar, banner, role badge, bio/quote, XP level, Raider.io M+ block, Steam block, online status, voice channel, action buttons |
| Self profile card | Clicking your own name in the footer or chat opens your own profile card; no "Message" button shown; private note hidden (notes are for other people) |
| Hover-to-open in chat | `mouseover` delegation on chat history — hovering any author name opens their profile card without a click |
| Integration blocks on card | Raider.io and Steam each render as a badge block with avatar/icon, stats, and a small tag pill ("Raider.io" / "Steam") in the bottom-right corner |
| Full profile page | Custom-hosted static page rendered in sandboxed iframe; YouTube support; scroll sections |
| Private note field | Visible only when viewing someone else's card; hidden on self-view; stored locally |
| Per-user volume | Set from profile card |

## Leveling / XP

| Feature | Notes |
|---------|-------|
| XP on messages | +15–25 XP per qualifying message; 60 s cooldown per user so spam-farming doesn't work |
| XP in voice | +2 XP per minute spent in any voice channel — Iskra-exclusive differentiator |
| Level formula | `level = floor(sqrt(xp / 50))` — Level 1 at 50 XP, Level 10 at 5000 XP |
| Level badge in member list | Small accent-coloured "Lv N" chip next to every username in the member panel |
| Level in profile card | "⭐ Level N · X / Y XP" progress line under the role badge |
| Level-up toast | "🎉 Level up! You reached level N" overlay for the local user; system message for others |
| /rank command | `/rank [alias]` — shows level, total XP, and XP threshold for next level |
| /leaderboard command | `/leaderboard` — top 10 users by XP |
| Admin toggle | Enable/disable in Admin → Leveling / XP; default is enabled |
| Role rewards | `server.json` XP.RoleRewards: `[{ level: N, role: "member" }]` auto-grants role on level-up |
| Persistence | `xp.json` in world directory; survives restarts |

## Security

| Feature | Notes |
|---------|-------|
| E2E encryption — DMs | ECDH P-256 + AES-GCM 256; PBKDF2 600k iter; relay is zero-knowledge |
| E2E encryption — channels | Same algorithm; admin-controlled per channel |
| HMAC-SHA256 record integrity | Relay DM records have MAC; verified on unlock |
| Rate-limited E2E unlock | 5 attempts, 60s lockout (client-side) |
| TOFU pubkey pinning | Peer public keys pinned on first contact |
| GUID-based ban system | Persisted; cannot be bypassed by reconnecting |
| Auth modes | open / registered+guests / verified-only (per server) |
| TURN server support | Configured in `server.json`; sent to clients in ICE config |
| DevTools disabled in release | `AreDevToolsEnabled` gated on `#if DEBUG` in client wrapper |

### Known Security Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| E2E unlock lockout is client-only | Medium | 5-attempt / 60s lockout enforced in JS only; bypass possible via devtools |
| No 2FA on IskraID | Medium | Password-only auth; planned in backlog |
| Static ECDH per peer (no forward secrecy) | Medium | All past DMs exposed if device compromised; planned Double Ratchet upgrade |

**Fixed (pending relay deploy):** login lockout (5 attempts → 15-min ban, in-memory), session token expiry (30-day `expires_at` column, checked on every auth).

## Developer & Integrations

| Feature | Notes |
|---------|-------|
| Inbound webhooks | `POST /inbound/{token}`; token scoped to channel; GitHub/CI → channel |
| Outbound webhooks | HTTP POST on new message; admin-configurable; documented in Settings |
| Bot API | Named bot tokens; bots connect via WebSocket; protocol docs in Settings |
| Auto-update | Checks GitHub releases on startup; download progress bar; self-replaces |
| DevLog panel | F9; colour-coded by category (BRIDGE, VOICE, RTC, VAD, etc.) |
| Link preview caching | OG tags fetched server-side and cached |

## Native Client (Windows)

| Feature | Notes |
|---------|-------|
| Windows app | C# WPF/WebView2 wrapper |
| System tray | Minimize/restore; right-click menu |
| Desktop notifications | Via C# bridge |
| Global PTT key hook | 10ms poll rate; configurable |
| Title bar color | Reflects online/offline/voice status |
| Auto-update | Self-replaces via PowerShell on download |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+K | Quick server/channel switcher |
| Ctrl+F | Message search |
| Ctrl+/ | Keyboard shortcuts overlay |
| Ctrl+Shift+F | Formatting toolbar |
| F9 | Toggle DevLog panel |
| Shift+F9 | Clear DevLog |
| Enter | Send message |
| Shift+Enter | New line |
| ↑ (empty input) | Edit last own message |
| Esc | Close modals / popups |
| PTT key (default Z) | Push-to-talk |

---

# PART 2 — WHAT WE PLAN

## Active Backlog

| Feature | Why |
|---------|-----|
| Donation supporter rewards | Ko-fi webhook → relay marks IskraID as supporter. Badge on hover card. Gift TBD (avatar glow, name color, animated status dot). Don't build until gift is decided. |
| Pinned message categories | Pins are a flat chronological list. Named groups ("resources", "rules", "links") would be a concrete improvement over Discord. |
| Footer bar polish | #user-footer gets crowded when role badge + alias + buttons all show. Plan: replace text badge with coloured dot + tooltip; add min-width:0 to info div; tighten gap 8px→4px. Currently acceptable — low priority. |

## Platform Expansion

| Feature | Why |
|---------|-----|
| Mobile PWA (installable) | App manifest + service worker + icons; iOS "Add to Home Screen" hint; Android auto-install banner; Lighthouse PWA audit |
| Capacitor native wrapper (Android/iOS) | Single web codebase wrapped in Capacitor; APK/AAB for Play Store; Xcode archive for App Store |
| Push notifications (mobile) | `@capacitor/push-notifications`; server-side FCM/APNs relay endpoint; deferred until after Capacitor wrapper ships |

## Channel Types

| Feature | Notes |
|---------|-------|
| Announcement channel | Read-only for non-admins |
| Stage channel | One speaker, many listeners |

## Other Planned

| Feature | Notes |
|---------|-------|
| Server templates | Clone channel/role layout when creating a new server |
| Spotify now-playing status | Show current track as custom status |
| Forward secrecy (Double Ratchet) | **High priority before 2k users.** Current relay E2E uses static ECDH shared key per peer — a compromised device exposes all past messages. Requires Double Ratchet (Signal-style), server-side prekey infrastructure, full DM protocol redesign. |

---

# PART 3 — SUGGESTIONS

Things not yet discussed but worth considering for making Iskra genuinely competitive.

## High Impact

| Idea | Why |
|------|-----|
| **2FA for IskraID accounts** | TOTP (e.g. Google Authenticator) is table stakes for any identity system. Especially relevant given relay DMs are E2E — losing your account = losing your contacts. |
| **DM group conversations** | 3+ person DMs. WhatsApp/iMessage staple. Relay already handles pairwise; group routing is the extension. |
| **Custom keybinding system** | All shortcuts are hardcoded. A keybinding config panel (stored in clientConfig) would let power users remap PTT, search, jump-to-unread, etc. Discord has very limited rebinding; Iskra can go further. |

## Medium Impact

| Idea | Why |
|------|-----|
| **Invite link expiry + single-use mode** | Currently links are time-limited but not use-limited. One-use links are good for adding someone without opening the server to everyone who finds the link. |
| **Offline mode (cached channel viewing)** | Read cached messages when disconnected. Service worker already handles app shell; extending it to message cache is the next step. |
| **Per-channel pinned message count in sidebar** | Small badge showing pinned count. Power-user signal that a channel has important anchored info. |
| **Audit log rotation** | Audit log is JSONL with no cleanup; grows unbounded. Add `AuditRetentionDays` to server config. |
| **Read receipts on channel messages (opt-in)** | DM read receipts already exist. Opt-in mutual read receipts on server channels — both parties enable the flag in settings. Discord refused this; Iskra can do it correctly. |

## Low Effort, High Polish

| Idea | Why |
|------|-----|
| **Channel last-active timestamp** | Show "last message 2h ago" in the channel list for channels you haven't visited. Reduces FOMO anxiety. |
| **Keyboard shortcut: jump to unread** | Alt+↓ to jump to oldest unread message across any channel. |
| **Voice channel user cap** | Optional max-user limit per voice channel set by admin. Good for managed events. |
| **Server transfer (change owner)** | Currently only owner can promote to admin. Need a way to fully hand off a server. |
| **Subtle glow on active elements** | OLED dark mode suggestion from design audit: `text-shadow: 0 0 10px` on active channel / server indicators with purple accent. Costs nothing, adds depth. |
