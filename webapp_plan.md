# Iskra Web App — Implementation Plan

## Goal
Serve `index.html` in a regular browser with no C# dependency. All features work
except global PTT (VAD replaces it). Same single-file HTML, adapted in-place and
also copied to `iskra_webclient/` as the canonical web build.

---

## Folder Structure

```
iskra_webclient/
  index.html          ← adapted from iskra_client/index.html
  manifest.json       ← PWA manifest (used by mobilePWA too)
  service-worker.js   ← PWA shell cache (used by mobilePWA too)
  icons/              ← generated at PWA stage
```

`iskra_client/index.html` stays untouched as the native client.
`iskra_webclient/index.html` is the web build — diverges only at the bridge layer.

---

## Detection Constant

Add near the top of the script block (before any bridge call):

```js
const IS_WEB = typeof window.chrome === 'undefined' || !window.chrome?.webview;
```

Use `IS_WEB` everywhere to branch between WebSocket-direct and bridge-relay.

---

## Step 1 — WebSocket Layer

Replace the C# WebSocket relay with a native browser WebSocket.
Add these globals alongside existing state variables:

```js
let ws        = null;
let wsReady   = false;
let _wsQueue  = [];   // messages queued before ws is open
```

Add `connectWebSocket(host, port, alias, password, userPassword, adminPassword)`:

```js
function connectWebSocket(host, port, alias, password, userPassword, adminPassword) {
    ws = new WebSocket(`ws://${host}:${port}`);
    ws.onopen = () => {
        wsReady = true;
        ws.send(JSON.stringify({ action: 'AUTH', alias, password, userPassword, adminPassword }));
        _wsQueue.forEach(m => ws.send(m));
        _wsQueue = [];
    };
    ws.onmessage = (e) => handleBridgeMessage(JSON.parse(e.data));
    ws.onclose   = () => { wsReady = false; ws = null; handleBridgeMessage({ action: 'DISCONNECTED' }); };
    ws.onerror   = () => { ws?.close(); };
}
```

---

## Step 2 — postToBridge Routing

Replace the current `postToBridge` with a web-aware version:

```js
function postToBridge(obj) {
    if (!IS_WEB) {
        // native path — unchanged
        DevLog.log('BRIDGE', `→ C# | ${obj.action}`);
        window.chrome.webview.postMessage(JSON.stringify(obj));
        return;
    }

    // Web-only no-ops (C#-only actions with no server equivalent)
    if (['SET_VOICE_MODE','SET_PTT_KEY','SET_TITLE_COLOR','LOG'].includes(obj.action)) return;

    // NOTIFY → Web Notifications API
    if (obj.action === 'NOTIFY') {
        if (Notification.permission === 'granted')
            new Notification(obj.title, { body: obj.body, icon: '/icons/icon-192.png' });
        return;
    }

    // CONNECT → open WebSocket
    if (obj.action === 'CONNECT') {
        connectWebSocket(obj.host, obj.port, obj.alias, obj.password, obj.userPassword, obj.adminPassword);
        return;
    }

    // DISCONNECT
    if (obj.action === 'DISCONNECT') {
        ws?.close();
        return;
    }

    // Everything else → send directly to server WebSocket
    const msg = JSON.stringify(obj);
    if (wsReady) ws.send(msg);
    else _wsQueue.push(msg);
}
```

---

## Step 3 — Bridge Listener

The current listener is:
```js
window.chrome.webview.addEventListener('message', async (e) => { ... });
```

Extract the handler body into a named function `handleBridgeMessage(data)` and attach it
to both paths:

```js
async function handleBridgeMessage(data) {
    // ... existing handler body ...
}

// Native path
if (!IS_WEB) {
    window.chrome.webview.addEventListener('message', async (e) => {
        handleBridgeMessage(JSON.parse(e.data));
    });
}
// Web path uses ws.onmessage → handleBridgeMessage (wired in connectWebSocket above)
```

---

## Step 4 — Connection Initiation in Web Mode

In web mode there is no C# to auto-connect. The user must trigger connection manually.
`connectToServer(id)` already calls `postToBridge({ action: 'CONNECT', ... })` — this is
already handled by Step 2. No extra changes needed, as long as the Settings → Servers UI
works to add/connect servers.

**INIT_CLIENT handling**: the server sends `INIT_CLIENT` on successful auth. The existing
`handleBridgeMessage` branch for `INIT_CLIENT` already does `postToBridge({ action: 'SET_VOICE_MODE', ... })` and `postToBridge({ action: 'SET_PTT_KEY', ... })` — these are no-ops in web
mode via Step 2, which is correct.

---

## Step 5 — PTT in Web Mode

- `SET_VOICE_MODE` and `SET_PTT_KEY` are no-ops (handled in Step 2).
- Hide the PTT key picker in Settings when `IS_WEB`.
- Show a small notice: *"PTT unavailable in browser — use Voice Activity Detection."*
- VAD is already excellent; nothing else needed.

---

## Step 6 — Notification Permission

On first load in web mode, request permission:

```js
if (IS_WEB && Notification.permission === 'default') {
    Notification.requestPermission();
}
```

Add this in the boot sequence after `loadClientConfig()`.

---

## Step 7 — Audit Log

Current code shows a NOTIFY saying "not supported in embedded client." In web mode,
just do `window.open(url, '_blank')` directly. Guard with `IS_WEB` check.

---

## Step 8 — `iskra://` Protocol Links

Protocol links won't work in a browser. Replace with a web URL scheme:
`https://iskra.foo/join?s=<base64-encoded-invite>`

On page load, check `new URLSearchParams(location.search).get('s')` and trigger
join flow if present. Keep `iskra://` working in the native client unchanged.

---

## Step 9 — Server CORS

The Iskra server needs to accept WebSocket upgrades from browser origins.
Check `iskra_server/Program.cs` for any origin restrictions and ensure the WS
endpoint allows `*` or at minimum `https://iskra.foo`.

---

## Step 10 — Serving

Deploy `iskra_webclient/` to **Cloudflare Pages** (same account, new project).
Will live at `app.iskra.foo` or `iskra.foo/app` — TBD.

- Static file serving, zero config.
- SSL handled by Cloudflare automatically.
- Push `iskra_webclient/` to a `webclient` branch or subfolder and connect Pages to it.

---

## Action Routing Reference

| Bridge Action | Web Handling |
|---|---|
| `CONNECT` | `connectWebSocket(...)` |
| `DISCONNECT` | `ws.close()` |
| `SEND_CHAT` | `ws.send(...)` |
| `SEND_DM` | `ws.send(...)` |
| `SEND_THREAD_MESSAGE` | `ws.send(...)` |
| `JOIN_VOICE` | `ws.send(...)` |
| `LEAVE_VOICE` | `ws.send(...)` |
| `WEBRTC_SIGNAL` | `ws.send(...)` |
| `DM_CALL_SIGNAL` | `ws.send(...)` |
| `TYPING` | `ws.send(...)` |
| `EDIT_MESSAGE` / `EDIT_DM` | `ws.send(...)` |
| `DELETE_MESSAGE` / `DELETE_DM` | `ws.send(...)` |
| `MARK_DM_READ` | `ws.send(...)` |
| `GET_DM_HISTORY` | `ws.send(...)` |
| `GET_AUDIT_LOG` | `ws.send(...)` |
| `SEARCH_MESSAGES` | `ws.send(...)` |
| `GET_THREAD_HISTORY` | `ws.send(...)` |
| `CREATE_THREAD` | `ws.send(...)` |
| `POLL_VOTE` | `ws.send(...)` |
| `ADD_REACTION` / `PIN_MESSAGE` | `ws.send(...)` |
| `SET_STATUS` | `ws.send(...)` |
| `SET_VOICE_STATUS` | `ws.send(...)` |
| `SET_CHANNEL_TOPIC` | `ws.send(...)` |
| `SET_SERVER_ICON` / `SET_AVATAR` | `ws.send(...)` |
| `REGISTER_PUBLIC_KEY` | `ws.send(...)` |
| `ENABLE_CHANNEL_E2E` / `DISABLE_CHANNEL_E2E` | `ws.send(...)` |
| `GRANT_E2E_ACCESS` / `ROTATE_E2E_KEY` | `ws.send(...)` |
| `ADD_CHANNEL` / `DELETE_CHANNEL` | `ws.send(...)` |
| `RENAME_CHANNEL` / `REORDER_CHANNEL` | `ws.send(...)` |
| `SET_USER_ROLE` / `SET_ROLE_COLOR` | `ws.send(...)` |
| `GENERATE_BOT_TOKEN` / `REVOKE_BOT_TOKEN` | `ws.send(...)` |
| `ADD_WEBHOOK` / `DELETE_WEBHOOK` | `ws.send(...)` |
| `DELETE_EMOJI` | `ws.send(...)` |
| `ADD_EVENT` / `DELETE_EVENT` | `ws.send(...)` |
| `SCREEN_SHARE_STARTED` / `SCREEN_SHARE_STOPPED` | `ws.send(...)` |
| `VIDEO_STARTED` / `VIDEO_STOPPED` | `ws.send(...)` |
| `FORWARD_MESSAGE` | `ws.send(...)` |
| `NOTIFY` | `new Notification(title, {body})` |
| `SET_VOICE_MODE` | no-op |
| `SET_PTT_KEY` | no-op |
| `SET_TITLE_COLOR` | no-op |
| `LOG` | no-op (already guarded) |

---

## Implementation Order

1. Add `IS_WEB` constant
2. Extract `handleBridgeMessage(data)` from the bridge listener
3. Rewrite `postToBridge` with web routing
4. Wire `ws.onmessage` in `connectWebSocket`
5. Boot: request Notification permission
6. Hide PTT UI when `IS_WEB`
7. Fix audit log `window.open`
8. Verify CORS on server
9. Copy to `iskra_webclient/`, smoke-test in browser
10. Deploy to Cloudflare Pages as `app.iskra.foo`
