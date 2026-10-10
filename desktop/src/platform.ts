// Per-OS decisions, kept free of Electron imports so they can be unit-tested anywhere.
import path from 'node:path'

type Env = Record<string, string | undefined>

export const exeName = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name)

/** The .NET runtime identifier for a self-contained iskra-server build. */
export function serverRid(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : 'linux'
  return `${os}-${arch === 'arm64' ? 'arm64' : 'x64'}`
}

/**
 * Where "Create a server" keeps world folders. Documents/Iskra/Servers on Windows and Linux.
 * On macOS, Documents is privacy-protected (an extra prompt, re-asked after unsigned updates),
 * so servers live in Application Support instead.
 */
export function defaultHostRoot(platform: NodeJS.Platform, dirs: { documents: string; userData: string }): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'darwin') return p.join(dirs.userData, 'Servers')
  return p.join(dirs.documents, 'Iskra', 'Servers')
}

/** Native Wayland session: global key hooks and screen capture work differently there. */
export const isWayland = (platform: NodeJS.Platform, env: Env) =>
  platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY)

/** On Wayland the system (PipeWire portal) already asked which screen; a single answer needs no second picker. */
export const skipScreenPicker = (wayland: boolean, sourceCount: number) => wayland && sourceCount === 1

/**
 * How this copy of the app updates itself.
 * auto: download in the background and restart into it (Windows installer, Linux AppImage).
 * manual: tell the user and link to the download (portable exe, deb/rpm, unsigned macOS builds).
 * off: development builds.
 */
export type UpdateMode = 'auto' | 'manual' | 'off'

export function updateMode(platform: NodeJS.Platform, packaged: boolean, env: Env): UpdateMode {
  if (!packaged || env.ISKRA_NO_UPDATES) return 'off'
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'manual' : 'auto'
  if (platform === 'linux') return env.APPIMAGE ? 'auto' : 'manual'
  return 'manual' // macOS: Squirrel.Mac only installs updates signed with a Developer ID
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** Semver precedence (a < b → negative). Versions that don't parse sort below everything. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i])
  if (!x[4] || !y[4]) return (x[4] ? -1 : 0) - (y[4] ? -1 : 0) // a release beats its prereleases
  const p = x[4].split('.')
  const q = y[4].split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1
    const pn = /^\d+$/.test(p[i])
    const qn = /^\d+$/.test(q[i])
    if (pn && qn && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i])
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1
  }
  return 0
}

export interface GitHubRelease {
  tag_name: string
  html_url: string
  draft: boolean
}

/** The newest published release that's newer than ours, if any. */
export function newerRelease(releases: GitHubRelease[], current: string): { version: string; url: string } | null {
  let best: GitHubRelease | null = null
  for (const r of releases) {
    if (r.draft || !VERSION.test(r.tag_name) || !r.html_url.startsWith('https://github.com/')) continue
    if (compareVersions(r.tag_name, current) > 0 && (!best || compareVersions(r.tag_name, best.tag_name) > 0)) best = r
  }
  return best ? { version: best.tag_name.replace(/^v/, ''), url: best.html_url } : null
}

/** System settings pages for the permissions Iskra uses (macOS). */
export const MAC_SETTINGS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
} as const
export type SettingsPane = keyof typeof MAC_SETTINGS

/**
 * Is this URL the app's own page? Exactly the app's scheme and host (app://iskra), or exactly the dev
 * server's origin: never a look-alike such as app://iskra.evil, http://localhost:51730 or http://localhost:5173.evil.
 */
export function isAppPage(url: string, appOrigin: string, devUrl?: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  const app = new URL(appOrigin)
  // Node gives custom schemes an opaque ("null") origin, so compare scheme and host for app://.
  if (parsed.protocol === app.protocol && parsed.host === app.host) return true
  if (!devUrl) return false
  try {
    const dev = new URL(devUrl).origin
    return dev !== 'null' && parsed.origin === dev
  } catch {
    return false
  }
}

/** What the updater is doing, as the tray and the app see it. */
export type UpdateState =
  | { state: 'none' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'available'; version: string; url: string }

export type TrayAction = 'open' | 'about' | 'check' | 'restart' | 'download' | 'quit'
export interface TrayItem {
  action: TrayAction | null
  label: string
  enabled: boolean
}

/** The tray's right-click menu (null action = separator). The update item follows what the updater is doing. */
export function trayMenu(update: UpdateState, checking: boolean, updatesOn: boolean): TrayItem[] {
  const item = (action: TrayAction, label: string, enabled = true): TrayItem => ({ action, label, enabled })
  const sep: TrayItem = { action: null, label: '', enabled: true }
  const updateItem =
    update.state === 'ready' ? item('restart', `Restart to update to ${update.version}`)
    : update.state === 'available' ? item('download', `Download Iskra ${update.version}`)
    : update.state === 'downloading' ? item('check', `Downloading ${update.version}…`, false)
    : checking ? item('check', 'Checking for updates…', false)
    : item('check', 'Check for updates', updatesOn)
  return [item('open', 'Open Iskra'), sep, item('about', 'About Iskra'), updateItem, sep, item('quit', 'Quit Iskra')]
}

/** The About box's text. */
export function aboutDetail(versions: { app: string; electron: string; chrome: string; node: string }, platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform
  return [
    `Version ${versions.app} (${os}, ${arch})`,
    `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`,
    '',
    'Voice and text chat for friends, on servers you own.',
    'Iskra is source-available under the PolyForm Noncommercial License 1.0.0.',
    'It builds on open source software, including Electron, Chromium, LiveKit, libsodium, React and RNNoise.',
  ].join('\n')
}
