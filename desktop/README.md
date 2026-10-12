# Iskra desktop

Electron shell around the web app: global push-to-talk, screen picker, tray, hosting servers from the app, and updates.

## Building

| Platform | Command | Where |
|---|---|---|
| Windows (signed) | `npm run dist` | locally, with the Certum token connected |
| Windows (unsigned) | `npm run dist:unsigned` | anywhere; never touches the signing token |
| Linux x64 | `npm run dist:linux` (AppImage, deb, rpm) | CI (`.github/workflows/release.yml`) or a Linux box |
| macOS arm64 + x64 | `npm run dist:mac` (dmg, zip) | CI or a Mac |

Each build first runs `scripts/prepare-server.mjs <rid>`, which publishes a self-contained iskra-server into
`build/server-<os>-<arch>` together with LiveKit from `.tools/` (`scripts/get-livekit.ps1` on Windows,
`scripts/get-livekit.sh <rid>` elsewhere; LiveKit has no macOS release, so on a Mac it's built from the pinned source).

`npm test` runs the unit tests for the per-platform helpers (`src/platform.ts`).

## Releases and updates

The app checks GitHub releases of `quikmn/iskra-voice` shortly after launch and every 4 hours (prereleases included).

- **Windows installer, Linux AppImage and macOS** (release builds) download the update in the background, then show
  "Update ready, Restart" and restart through the same "Updating Iskra" overlay and "Updated to X" splash.
  On Windows the downloaded installer must be signed by `Open Source Developer Viktor Lundgren` (`publisherName`),
  otherwise it isn't installed. On macOS the app reads its own signature at startup (`codesign`): only a Developer ID
  signed app updates itself, from the release's `.zip` for its CPU (Squirrel.Mac checks the update is signed by the same
  team). It also has to be somewhere it can be replaced: not running from the disk image, and not translocated (opened from
  Downloads without being moved to Applications).
- **Portable exe, deb/rpm, ad-hoc signed Mac builds** (local `dist:mac`, CI without the Apple secrets) and Mac apps in
  those places can't replace themselves; they show "New version available" with a link to the release. A failed
  download or signature check falls back to the same link.

Upload these to each GitHub release (file names must stay exactly as built; the `.yml` files point at them):

| From | Files |
|---|---|
| Windows (local `npm run dist`) | `Iskra-Setup-<v>.exe`, `Iskra-Setup-<v>.exe.blockmap`, `latest.yml`, `Iskra-Portable-<v>.exe`, plus `iskra-server-<v>-win-x64.zip` |
| Linux (CI) | `Iskra-<v>-x86_64.AppImage`, `Iskra-<v>-amd64.deb`, `Iskra-<v>-x86_64.rpm`, `latest-linux.yml`, `iskra-server-<v>-linux-x64.tar.gz` |
| macOS (CI) | `Iskra-<v>-mac-arm64.dmg`, `Iskra-<v>-mac-x64.dmg`, the matching `.zip` files and `.blockmap`s, `latest-mac.yml`, `iskra-server-<v>-osx-arm64.tar.gz`, `iskra-server-<v>-osx-x64.tar.gz` |

Pushing a `v*` tag runs the release workflow, which attaches the Linux and macOS files (creating a draft prerelease if the
release doesn't exist yet). Without `latest.yml` on a release, Windows installs won't see it.

## First run on macOS

The macOS app is signed with a Developer ID and notarized by Apple (from 2.0.0-alpha.9): open the dmg, drag Iskra to Applications and open it.
Iskra asks for the microphone and camera when you first use them. Push to talk needs **Accessibility** and screen sharing needs
**Screen & System Audio Recording** (Privacy & Security); the app points you there when needed.

## Linux notes

- The AppImage updates itself; deb/rpm users install new versions from the release page.
- On Ubuntu 24.04 and later, prefer the `.deb`: AppArmor blocks the AppImage's Chromium sandbox there.
- Wayland: screen sharing uses the system's (PipeWire) picker. Global push to talk only sees keys pressed while Iskra or an
  X11 app is focused; an X11 session or voice activity works everywhere.
- The tray icon needs AppIndicator support (on GNOME, the AppIndicator extension). Without it, opening Iskra again brings the window back.
