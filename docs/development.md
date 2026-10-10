# Developing Iskra

## Layout

| Folder | What |
|---|---|
| `protocol/` | `PROTOCOL.md`, the wire protocol (source of truth for client and server), and `vectors.json`, shared crypto test vectors both sides check |
| `server/` | C# / .NET 10 server: sessions, permissions, storage (SQLite), voice (LiveKit), uploads, HTTPS |
| `client/` | TypeScript + React + Vite web app (also what the desktop app runs) |
| `desktop/` | Electron shell for Windows: push-to-talk, screen picker, tray, one-click hosting |
| `scripts/` | Downloads pinned tools (LiveKit, Pebble) into `.tools/` with checksum checks |
| `site/` | The iskra.foo website |

## Prerequisites

.NET 10 SDK, Node 24, and (for voice) LiveKit: `scripts/get-livekit.ps1` on Windows or `scripts/get-livekit.sh` on Linux.

## Run it

```powershell
.\dev.ps1          # server on .dev\world (port 47070) + web app on http://localhost:5173
```

On first start the server prints an owner link; open it to become the owner of your dev server.

## Tests

```powershell
cd server; dotnet test              # server: real server + WebSocket clients (and real HTTPS issuance if .tools/pebble.exe exists)
cd client; npm test                 # client unit tests
cd client; npm run test:interop     # the TypeScript client against the real .NET server
cd client; npm run test:e2e         # Playwright: browsers and the Electron app against real servers, voice via LiveKit
```

CI runs all of it on Windows and Linux.

## Building releases

```powershell
cd desktop; npm install; npm run dist   # Windows installer + portable exe in desktop/release (bundles the server)
```

The web app is `client/dist` after `npm run build`; it's deployed to app.iskra.foo.

## Principles

- The server trusts nothing a client says about itself. Identity comes from the signed handshake; permissions are checked for every request and every broadcast.
- New protocol messages go into `protocol/PROTOCOL.md` first, with limits, and get a server test. Every bug gets a regression test.
- No hand-made crypto: libsodium primitives, domain-separated signatures, no plaintext fallbacks.
- User content is rendered by React only; never put it into HTML strings.
