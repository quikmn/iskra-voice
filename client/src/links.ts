// Public links shown in the app. Update the version when a new release ships.
export const RELEASE_VERSION = '2.0.0-alpha.9'
const download = (file: string) => `https://github.com/quikmn/iskra-voice/releases/download/v${RELEASE_VERSION}/${file}`

// File names as electron-builder writes them (desktop/package.json, .github/workflows/release.yml).
export const LINKS = {
  windowsInstaller: download(`Iskra-Setup-${RELEASE_VERSION}.exe`),
  macAppleSilicon: download(`Iskra-${RELEASE_VERSION}-mac-arm64.dmg`),
  macIntel: download(`Iskra-${RELEASE_VERSION}-mac-x64.dmg`),
  linuxAppImage: download(`Iskra-${RELEASE_VERSION}-x86_64.AppImage`),
  linuxDeb: download(`Iskra-${RELEASE_VERSION}-amd64.deb`),
  linuxRpm: download(`Iskra-${RELEASE_VERSION}-x86_64.rpm`),
  serverWindows: download(`iskra-server-${RELEASE_VERSION}-win-x64.zip`),
  serverLinux: download(`iskra-server-${RELEASE_VERSION}-linux-x64.tar.gz`),
  serverMacAppleSilicon: download(`iskra-server-${RELEASE_VERSION}-osx-arm64.tar.gz`),
  serverMacIntel: download(`iskra-server-${RELEASE_VERSION}-osx-x64.tar.gz`),
  releases: 'https://github.com/quikmn/iskra-voice/releases',
  // The Android app (android/build.ps1) is attached to every release.
  androidApp: 'https://github.com/quikmn/iskra-voice/releases/latest',
  hostingGuide: 'https://github.com/quikmn/iskra-voice/blob/main/docs/hosting.md',
  gifsGuide: 'https://github.com/quikmn/iskra-voice/blob/main/docs/hosting.md#gifs',
}

export type DesktopOs = 'windows' | 'mac' | 'linux' | 'other'

/** Which desktop app to offer first. Phones and tablets get 'other' (there's no app for them; the web app works). */
export function desktopOs(userAgent: string, platform = '', touchPoints = 0): DesktopOs {
  const ua = userAgent.toLowerCase()
  const p = platform.toLowerCase()
  if (/android|iphone|ipad|ipod|cros/.test(ua)) return 'other'
  // iPadOS asks for desktop sites and says "Macintosh"; only real Macs have no touch screen.
  if (p.startsWith('mac') || ua.includes('macintosh') || ua.includes('mac os x')) return touchPoints > 1 ? 'other' : 'mac'
  if (p.startsWith('win') || ua.includes('windows')) return 'windows'
  if (p.includes('linux') || ua.includes('linux') || ua.includes('x11')) return 'linux'
  return 'other'
}
