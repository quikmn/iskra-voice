# Iskra Multi-Server Overhaul Plan

## Goal
Replace the current single-server-at-a-time architecture with simultaneous connections to all saved servers — silent, automatic, invisible to the user. Feels like Discord UX but built the Iskra way: simple, no abstraction theater, privacy-first, power user.

## Philosophy
- App opens → all saved servers connect automatically in the background
- No connect/disconnect buttons in normal UI flow
- No connection status dots, spinners, or "Reconnecting..." text anywhere
- Silent auto-reconnect with exponential backoff (1→2→4→8→16→30s cap)
- If a server is offline when you click it: chat pane shows a quiet offline message
- Unread notification badges accumulate from ALL connected servers on their icons
- Voice runs independently — you stay voiced on server A while browsing server B
- Server icons are pure navigation (active pill = what you're viewing, not what you're connected to)

## Key Architectural Shift

### Before
~68 globals describing "the one connected server":
`connectedServerId`, `myRole`, `serverChannels`, `channelMessages`, `peers`, `ws`, etc.

### After
```javascript
const serverStates = {};              // serverId → state object (see factory below)
const connectedServerIds = new Set(); // all currently live server connections
let viewedServerId = null;            // what's rendered on screen right now
let voiceServerId  = null;            // which server's voice channel is active
let voiceChannelId = null;            // active voice channel ID
```

All render functions read from `serverStates[viewedServerId]`.
`handleBridgeMessage` gets a `serverId` param and reads/writes `serverStates[serverId]`.

---

## Context: What's in index.html

Single file ~10,100+ lines. All client logic is vanilla JS in one `<script>` block.
Key functions to touch:
- `connectToServer(id)` — line ~4030
- `disconnectFromServer()` — line ~4041
- `connectWebSocket(...)` — line ~4680
- `postToBridge(obj)` — line ~4694
- `handleBridgeMessage(data)` — line ~6491 (huge, ~400+ lines)
- `DISCONNECTED` handler — line ~6775 (authoritative list of per-server state)
- `renderServerBar()` — line ~4064
- `onServerIconClick(id)` — line ~4097
- `renderChannelList()` — line ~2594
- Variable declarations — lines ~2050–2592

## Context: Native vs Web client
- `IS_WEB = typeof window.chrome === 'undefined' || !window.chrome?.webview`
- Web: WebSockets managed directly in JS via `connectWebSocket()`
- Native: C# WebView2 wrapper; currently C# manages the WebSocket, messages come via bridge
- **Plan change**: For multi-server, ALL WebSockets are JS-managed regardless of native/web.
  C# bridge still handles audio/OS messages (SET_VOICE_MODE, SET_PTT_KEY, NOTIFY, LOG, SET_TITLE_COLOR).
  CONNECT action no longer goes to C# — JS calls `_connectWs()` directly in both paths.
  This is cleaner: JS owns network, C# owns audio/OS integration.

---

## Phase 1 — `createServerState()` factory

Delete all 68 per-server globals. Replace with:

```javascript
function createServerState() {
  return {
    // Connection
    ws: null, wsReady: false, _wsQueue: [],
    _userDisconnected: false,
    _reconnectDelay: 1000,
    _reconnectTimer: null,
    // Identity on this server
    myAlias: '', myRole: 'guest', serverUploadBase: null, _localProxyPort: 0,
    // Channels
    serverChannels: [], activeTextChannelId: null,
    channelMessages: {}, channelSlowMode: {}, lastSendTime: {},
    voiceChannelUsers: {}, currentChannelId: null, inMutedChannel: false,
    // Unread / notifications
    unreadCounts: {}, mentionCounts: {}, lastSeenTs: {},
    // Users
    userAvatars: {}, userStatuses: {}, userRoles: {},
    userStatusTexts: {}, myStatus: 'online', myStatusText: '',
    timedOutUsers: {}, pollVotes: {},
    // Server metadata
    serverIconUrl: null, serverEmojis: {}, roleColors: {},
    serverWebhooks: [], serverBotTokens: [], serverInboundHooks: [],
    serverEvents: [], _dismissedEvIds: new Set(),
    // Messages / threads
    pinnedMessages: {}, threadMsgMap: {}, threadCounts: {}, activeThreadId: null,
    // UI state (per-server)
    starboardConfig: { enabled: false, channelId: '', emoji: '⭐', threshold: 3 },
    voiceStatuses: {}, _slowTimer: null, _collapsedCats: new Set(),
    _typingTimers: {}, _lastTypingSent: 0,
    _forwardMsgId: null, _chCtxMenuId: null,
    // WebRTC / voice
    peers: {}, remoteGainNodes: {}, peerAnalysers: {},
    remoteSpeaking: new Set(), userVolumes: {},
    // Screen share
    displayStream: null, screenShareSenders: {}, screenShareAudioSenders: {},
    remoteScreens: {}, sharingChannelId: null,
    // Video
    videoSenders: {}, localVideoStream: null,
    // E2E (per-server channel encryption)
    myEcdhPrivKey: null, myEcdhPubKey: null,
    e2eChannelKeys: {}, serverPublicKeys: {}, e2eChannelAccess: {},
  };
}
```

---

## Phase 2 — Connection layer

### `connectToServer(id)`
```javascript
function connectToServer(id) {
  if (connectedServerIds.has(id)) { setViewedServer(id); return; }
  const server = clientConfig.servers.find(s => s.id === id);
  if (!server) return;
  serverStates[id] = createServerState();
  const alias = clientConfig.serverNicknames[id] || (relayAlias ?? clientConfig.activeAlias);
  _connectWs(id, server.host, server.port, alias, server.password, server.userPassword, server.adminPassword);
}
```

### `_connectWs(serverId, host, port, alias, password, userPassword, adminPassword)`
Always JS-managed (both native and web paths):
```javascript
function _connectWs(serverId, host, port, alias, password, userPassword, adminPassword) {
  const ss = serverStates[serverId];
  const proto = (location.protocol === 'https:' || port === 443 || port === 8443) ? 'wss:' : 'ws:';
  ss.ws = new WebSocket(`${proto}//${host}:${port}`);
  ss.ws.onopen = () => {
    ss.wsReady = true;
    ss._reconnectDelay = 1000; // reset backoff on successful open
    ss.ws.send(JSON.stringify({ action: 'AUTH', alias, password, userPassword, adminPassword }));
    ss._wsQueue.forEach(m => ss.ws.send(m));
    ss._wsQueue = [];
  };
  ss.ws.onmessage = async (e) => handleBridgeMessage(JSON.parse(e.data), serverId);
  ss.ws.onclose = () => {
    ss.wsReady = false; ss.ws = null;
    handleBridgeMessage({ action: 'DISCONNECTED' }, serverId);
    if (!ss._userDisconnected) _scheduleReconnect(serverId);
  };
  ss.ws.onerror = () => ss.ws?.close();
}
```

### `_scheduleReconnect(serverId)` — silent, no UI
```javascript
function _scheduleReconnect(serverId) {
  const ss = serverStates[serverId];
  if (!ss || ss._userDisconnected) return;
  ss._reconnectTimer = setTimeout(() => {
    const server = clientConfig.servers.find(s => s.id === serverId);
    if (!server) return;
    const alias = clientConfig.serverNicknames[serverId] || (relayAlias ?? clientConfig.activeAlias);
    _connectWs(serverId, server.host, server.port, alias, server.password, server.userPassword, server.adminPassword);
  }, ss._reconnectDelay);
  ss._reconnectDelay = Math.min(ss._reconnectDelay * 2, 30000);
}
```

### `disconnectFromServer(serverId)`
```javascript
function disconnectFromServer(serverId) {
  const ss = serverStates[serverId];
  if (!ss) return;
  ss._userDisconnected = true;
  clearTimeout(ss._reconnectTimer);
  ss.ws?.close();
}
```

### `postToBridge(obj)` changes
- Remove the `CONNECT` → `connectWebSocket()` redirect (replaced by `connectToServer`)
- Remove the `DISCONNECT` → `ws?.close()` redirect (replaced by `disconnectFromServer`)
- For sending messages to a specific server: `postToServer(serverId, obj)`:
```javascript
function postToServer(serverId, obj) {
  const ss = serverStates[serverId];
  if (!ss) return;
  const msg = JSON.stringify(obj);
  if (ss.wsReady) ss.ws.send(msg);
  else ss._wsQueue.push(msg);
}
```
- Non-server-specific bridge messages (audio, OS) still go via `window.chrome.webview.postMessage`

### Auto-connect on launch
At end of boot sequence (after `loadClientConfig()`):
```javascript
clientConfig.servers.forEach(s => connectToServer(s.id));
const firstServer = clientConfig.servers[0];
if (firstServer) setViewedServer(firstServer.id);
```

---

## Phase 3 — `handleBridgeMessage(data, serverId)`

Signature change: `handleBridgeMessage(data, serverId)`

At top of function:
```javascript
const ss = serverStates[serverId];
if (!ss && data.action !== 'NOTIFY' /* truly global actions */) return;
```

**Every** read/write of a per-server global becomes `ss.X`:
- `myRole` → `ss.myRole`
- `serverChannels` → `ss.serverChannels`
- `channelMessages` → `ss.channelMessages`
- `peers` → `ss.peers`
- `unreadCounts` → `ss.unreadCounts`
- ... (all 68 from the factory)

UI render calls only fire when `serverId === viewedServerId`:
```javascript
if (serverId === viewedServerId) renderChannelList();
```

Notification badges (unread counts) update `serverStates[serverId].unreadCounts` regardless, then call `renderServerBar()` to show badge on the icon.

**DISCONNECTED handler** becomes:
- Reset `ss` fields to defaults (or just `serverStates[serverId] = createServerState()` for the dead state)
- `connectedServerIds.delete(serverId)`
- Close WebRTC peers in `ss.peers`
- If `viewedServerId === serverId`: show offline state in chat pane (quiet message, no modal)
- No full UI wipe — other servers' state is untouched

**INIT_CLIENT handler** becomes:
- `connectedServerIds.add(serverId)`
- Populate `ss` fields from data
- If `viewedServerId === serverId`: full render

---

## Phase 4 — Render functions

Pattern for every render function:
```javascript
function renderChannelList() {
  const ss = serverStates[viewedServerId];
  if (!ss || !connectedServerIds.has(viewedServerId)) {
    showServerOfflineState(); // quiet "server offline" in chat pane
    return;
  }
  // use ss.serverChannels, ss.myRole, etc.
}
```

Functions to update:
- `renderChannelList()` / `renderChannelBar()`
- `renderMemberList()`
- `renderChatPane()` / `renderChatHistory()`
- `updateFooterBar()`
- `renderChannelHeader()`
- `renderServerBar()`
- `selectTextChannel(id)` — reads/writes `ss.activeTextChannelId`
- All `postToBridge()` calls that send to the server → become `postToServer(viewedServerId, obj)` or `postToServer(connectedServerId, obj)` where appropriate

New helper:
```javascript
function setViewedServer(id) {
  viewedServerId = id;
  renderChannelList();
  renderChatPane();
  renderMemberList();
  updateFooterBar();
  renderServerBar();
}
```

---

## Phase 5 — Server bar & icon click

### `onServerIconClick(id)`
```javascript
function onServerIconClick(id) {
  if (inDmMode) closeDmMode();
  closeRelayPanel();
  setViewedServer(id);
  const ss = serverStates[id];
  if (ss && connectedServerIds.has(id) && ss.activeTextChannelId) {
    selectTextChannel(ss.activeTextChannelId);
  }
}
```

### `renderServerBar()`
- Unread badge per server: `Object.values(ss?.unreadCounts ?? {}).reduce((a,b)=>a+b,0)`
- Mention badge per server: `Object.values(ss?.mentionCounts ?? {}).reduce((a,b)=>a+b,0)`
- Active pill = `viewedServerId` (not connected state)
- NO connection status dots, NO sorting by connected state
- Server icons are stable in position (order = `clientConfig.servers` order)
- Server icon image: use `ss?.serverIconUrl` if connected and has one, else `s.cachedIconDataUrl`, else initials

---

## Phase 6 — Voice across servers

Global voice state (not per-server):
```javascript
let voiceServerId  = null;
let voiceChannelId = null;
```

When joining voice:
- If already voiced on a different server → leave that server's voice first
- Set `voiceServerId = serverId`, `voiceChannelId = channelId`
- WebRTC peers in `serverStates[voiceServerId].peers`

Footer voice indicator: persistent bar showing `"▶ server-name · channel-name"` when `voiceServerId !== null`, visible even when viewing a different server.

When leaving voice: clear `voiceServerId`, `voiceChannelId`, close peers in that server's state.

---

## Phase 7 — Server-side channel GUID (Program.cs)

When the admin panel creates a new channel at runtime, generate:
```csharp
Id = Guid.NewGuid().ToString("N")  // 32-char hex, no dashes, globally unique
```

Default template channels (`"t_general"`, `"v_lobby"`, etc.) keep their IDs — no migration.
Existing servers are fully unaffected.

Find the handler in Program.cs that processes channel creation from the admin UI and add Guid generation there.

---

## Phase 8 — Settings panel cleanup

`renderServerList()` (settings panel):
- Remove Connect/Disconnect button pair entirely
- Show simple status next to each server: `connectedServerIds.has(s.id) ? '● Online' : '○ Offline'`
- Adding a new server → immediately calls `connectToServer(s.id)`
- Removing a server → calls `disconnectFromServer(s.id)` then removes from config
- No explicit "Connect" button anywhere in normal UI

---

## Implementation Order

1. **`createServerState()` + new globals** — wire `serverStates`, `connectedServerIds`, `voiceServerId`
2. **Delete the 68 old globals** from the declaration block
3. **`_connectWs`, `connectToServer`, `disconnectFromServer`, `_scheduleReconnect`** — new connection layer
4. **`postToBridge` / `postToServer` split** — native audio bridge vs JS WebSocket sends
5. **`handleBridgeMessage(data, serverId)`** — full `ss.X` pass (largest chunk, ~400 lines)
6. **All render functions** — add `const ss = serverStates[viewedServerId]` + null guards
7. **`setViewedServer()` + `onServerIconClick()`** update
8. **`renderServerBar()`** — unread badges per server, stable order, no status dots
9. **Voice globals** + footer indicator
10. **Auto-connect on launch** (2 lines at boot)
11. **Settings panel cleanup**
12. **Server-side GUID** for new channels in Program.cs

---

## Known Risk Areas

- **`handleBridgeMessage` size**: ~400+ lines, touches dozens of globals. Do it in one focused pass. Use the factory's field list as a checklist — every field must be confirmed replaced.
- **`postToBridge` call sites**: There are many scattered `postToBridge({action:'CHAT',...})` etc. calls throughout the file. All server-directed messages need to become `postToServer(viewedServerId, obj)`. Audio/OS messages stay as `postToBridge`.
- **Voice leave on disconnect**: When a server disconnects while you're voiced on it, must clean up voice state gracefully.
- **E2E channel keys**: `myEcdhPrivKey`/`myEcdhPubKey` are per-server in state but derived from the relay password (user-level). They'll be re-derived into each server's state slot on connect — same key, just duplicated per server. Fine.
- **`saveUnread(serverId)`**: Currently called in DISCONNECTED. Make sure it reads from `serverStates[serverId].unreadCounts` etc., not globals.
- **`lastSeenTs` persistence**: Saved per-channel to localStorage keyed by channelId. With multi-server, channel IDs are namespaced by being inside `ss`, but the localStorage key should also include serverId to avoid collisions. Check this when touching the unread/lastSeen logic.

---

## Files Changed
- `iskra_client/index.html` — all client changes
- `iskra_server/Program.cs` — channel GUID generation only
- `iskra_client/version.txt` — bump version
- `FEATURES.md` — update multi-server entry

## Version
This overhaul targets v1.1.0.0 (minor version bump — breaking architectural change).
