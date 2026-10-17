// Public links shown in the app. Update the version when a new release ships.
export const RELEASE_VERSION = '2.0.0-alpha.26'
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
  // Raspberry Pi 4/5 (64-bit OS) and other 64-bit ARM Linux boards.
  serverLinuxArm: download(`iskra-server-${RELEASE_VERSION}-linux-arm64.tar.gz`),
  serverMacAppleSilicon: download(`iskra-server-${RELEASE_VERSION}-osx-arm64.tar.gz`),
  serverMacIntel: download(`iskra-server-${RELEASE_VERSION}-osx-x64.tar.gz`),
  releases: 'https://github.com/quikmn/iskra-voice/releases',
  website: 'https://iskra.foo',
  license: 'https://github.com/quikmn/iskra-voice/blob/main/LICENSE',
  // The Android app (mobile/scripts/build-android.ps1) is attached to every release.
  androidApp: 'https://github.com/quikmn/iskra-voice/releases/latest',
  kofi: 'https://ko-fi.com/vlundgren',
  paypal: 'https://paypal.me/iskrafoo',
  hostingGuide: 'https://github.com/quikmn/iskra-voice/blob/main/docs/hosting.md',
  gifsGuide: 'https://github.com/quikmn/iskra-voice/blob/main/docs/hosting.md#gifs',
  // KLIPY's Partner Panel, where an admin makes the free API key for their server's GIF picker.
  klipy: 'https://partner.klipy.com',
  // Rent a server on DigitalOcean. The sign-up link is Iskra's referral link (the app says so): Iskra gets some
  // DigitalOcean credit when someone pays there, nothing else.
  digitalOceanReferral: 'https://m.do.co/c/5ed476bab2ca',
  digitalOceanTokens: 'https://cloud.digitalocean.com/account/api/tokens',
  digitalOceanDroplets: 'https://cloud.digitalocean.com/droplets',
  digitalOceanFirewalls: 'https://cloud.digitalocean.com/networking/firewalls',
  digitalOceanBilling: 'https://cloud.digitalocean.com/account/billing',
}

export type DesktopOs = 'windows' | 'mac' | 'linux' | 'other'

/** Phones and tablets: a server needs a computer, so the start guide says so first. */
export function isPhoneOrTablet(userAgent: string, platform = '', touchPoints = 0): boolean {
  const ua = userAgent.toLowerCase()
  if (/android|iphone|ipad|ipod|mobile/.test(ua)) return true
  return (platform.toLowerCase().startsWith('mac') || ua.includes('macintosh')) && touchPoints > 1
}

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

/**
 * Where "Report a bug" sends reports: the bug inbox on Iskra's own server (POST /bug-reports, see PROTOCOL.md
 * "Bug inbox"). Reports land in a private channel only the Iskra team reads.
 */
export const BUG_REPORT_URL = 'https://chat.iskra.foo/bug-reports'
