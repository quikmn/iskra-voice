// Per-OS decisions, kept free of Electron imports so they can be unit-tested anywhere.
import path from 'node:path'
import { DESKTOP_TEXT, parseLanguage, type DesktopLanguage, type DesktopText } from './i18n'

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

/**
 * Whether Chromium's spellchecker would download its dictionaries (Hunspell, from Google's servers). Windows and macOS
 * use the system's own spellchecker; Linux would download, so the app keeps spellcheck off there.
 */
export const spellcheckDownloadsDictionaries = (platform: NodeJS.Platform) => platform !== 'win32' && platform !== 'darwin'

/** On Wayland the system (PipeWire portal) already asked which screen; a single answer needs no second picker. */
export const skipScreenPicker = (wayland: boolean, sourceCount: number) => wayland && sourceCount === 1

/**
 * How this copy of the app updates itself.
 * auto: download in the background and restart into it (Windows installer, Linux AppImage, Developer ID signed macOS).
 * manual: tell the user and link to the download (portable exe, deb/rpm, ad-hoc signed macOS builds, a Mac app run
 * from the disk image or from Downloads before it was moved).
 * off: development builds.
 */
export type UpdateMode = 'auto' | 'manual' | 'off'

/** The running macOS app: how it's signed and where it is (the .app bundle). */
export type MacApp = { signing: MacSigning; bundlePath: string }

export function updateMode(platform: NodeJS.Platform, packaged: boolean, env: Env, mac?: MacApp): UpdateMode {
  if (!packaged || env.ISKRA_NO_UPDATES) return 'off'
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'manual' : 'auto'
  if (platform === 'linux') return env.APPIMAGE ? 'auto' : 'manual'
  // Squirrel.Mac only installs an update whose signature satisfies the running app's (same Developer ID team), so an
  // ad-hoc signed build can never update itself. It also needs to be able to replace the app where it is.
  return mac?.signing === 'developer-id' && macCanReplaceItself(mac.bundlePath) ? 'auto' : 'manual'
}

/**
 * How a macOS app is signed, read from `codesign -dv --verbose=2 <app>` (which prints to stderr).
 * developer-id: a Developer ID Application certificate with a team (release builds from CI with the Apple secrets).
 * adhoc: signed without a certificate (local builds, CI without the secrets). none: not signed, or codesign failed.
 */
export type MacSigning = 'developer-id' | 'adhoc' | 'none'

export function macSigning(codesignOutput: string): MacSigning {
  const lines = codesignOutput.split('\n').map((l) => l.trim())
  if (lines.some((l) => /^Signature=adhoc$/i.test(l))) return 'adhoc'
  const developerId = lines.some((l) => l.startsWith('Authority=Developer ID Application:'))
  const team = lines.find((l) => l.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length)
  if (developerId && team && /^[A-Z0-9]{10}$/.test(team)) return 'developer-id'
  return lines.some((l) => l.startsWith('Identifier=')) ? 'adhoc' : 'none'
}

/**
 * Whether Squirrel.Mac can swap the app in place: not while it runs from the mounted disk image (read-only) or
 * translocated (opened from Downloads without being moved, so macOS runs it from a read-only random path).
 */
export const macCanReplaceItself = (bundlePath: string) =>
  bundlePath.endsWith('.app') && !bundlePath.startsWith('/Volumes/') && !bundlePath.includes('/AppTranslocation/')

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** A plain version like 2.0.0-alpha.12 (no "v"). */
export const isVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && !v.startsWith('v') && VERSION.test(v)

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
export function trayMenu(update: UpdateState, checking: boolean, updatesOn: boolean, text: DesktopText = DESKTOP_TEXT.en): TrayItem[] {
  const t = text.tray
  const item = (action: TrayAction, label: string, enabled = true): TrayItem => ({ action, label, enabled })
  const sep: TrayItem = { action: null, label: '', enabled: true }
  const updateItem =
    update.state === 'ready' ? item('restart', t.restart(update.version))
    : update.state === 'available' ? item('download', t.download(update.version))
    : update.state === 'downloading' ? item('check', t.downloading(update.version), false)
    : checking ? item('check', t.checking, false)
    : item('check', t.check, updatesOn)
  return [item('open', t.open), sep, item('about', t.about), updateItem, sep, item('quit', t.quit)]
}

/** The About box's text. */
export function aboutDetail(
  versions: { app: string; electron: string; chrome: string; node: string }, platform: NodeJS.Platform, arch: string, text: DesktopText = DESKTOP_TEXT.en,
): string {
  const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform
  return [
    text.about.version(versions.app, os, arch),
    `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`,
    '',
    text.about.tagline,
    text.about.license,
    text.about.builtOn,
  ].join('\n')
}

/** What YouTube sees as the embedding page for the desktop app (whose app:// origin it won't accept as a referrer). */
export const YOUTUBE_REFERRER = 'https://app.iskra.foo/'

/**
 * The Referer to send with a request, for YouTube's privacy-enhanced embeds only: requests to youtube-nocookie.com
 * made from the app's own window. Anything else keeps its headers (null).
 */
export function youTubeReferrer(requestUrl: string, fromApp: boolean): string | null {
  if (!fromApp) return null
  try {
    const url = new URL(requestUrl)
    return url.protocol === 'https:' && url.hostname === 'www.youtube-nocookie.com' ? YOUTUBE_REFERRER : null
  } catch {
    return null
  }
}

/** Twitch's embeddable players (chat link embeds). */
export const TWITCH_EMBED_URLS = ['https://player.twitch.tv/*', 'https://clips.twitch.tv/*']

/** scheme://host of a page URL (Node's URL gives "null" as the origin of app:// pages). */
export function pageOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    return u.host ? `${u.protocol}//${u.host}` : null
  } catch {
    return null
  }
}

/**
 * Response headers for an embed framed by `embedder`: every CSP frame-ancestors directive (Twitch sends
 * `frame-ancestors https://<parent>`) allows just the embedder instead. Other headers and directives are kept.
 */
export function embedderHeaders(headers: Record<string, string[]>, embedder: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, values] of Object.entries(headers)) {
    out[name] = name.toLowerCase() === 'content-security-policy'
      ? values.map((v) => v.replace(/(^|;)\s*frame-ancestors[^;]*/gi, (_m, start: string) => `${start}${start ? ' ' : ''}frame-ancestors ${embedder}`))
      : values
  }
  return out
}

/**
 * Whether the OS keychain can protect Iskra's keys (Electron safeStorage).
 * keyring: DPAPI, Keychain, libsecret or kwallet. basic: Linux without a keyring, where safeStorage falls back to a
 * fixed password, which is no protection; the app then uses its browser wrap and says so. unavailable: nothing.
 */
export function keychainKind(platform: NodeJS.Platform, available: boolean, linuxBackend: string | null, env: Env): 'keyring' | 'basic' | 'unavailable' {
  if (env.ISKRA_NO_KEYCHAIN) return 'unavailable'
  if (!available) return 'unavailable'
  if (platform === 'linux' && (linuxBackend === 'basic_text' || linuxBackend === 'unknown' || !linuxBackend)) return 'basic'
  return 'keyring'
}

// ── iskra:// links ───────────────────────────────────────────────────────

export const DEEP_LINK_SCHEME = 'iskra'
/** <b64u(server url)>.<server key>.<code>[.<p2p secret>], as in web invite links (#/join/...). */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{4,600}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{8,64}(\.[A-Za-z0-9_-]{43})?$/

/** A 32-byte key as the page sends it (b64u): a server key, or a server's p2p secret. */
export const isKey43 = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)

/**
 * The invite token in an iskra://join/<token> (or iskra://invite/<token>) link, or null. Nothing else is
 * accepted: no other paths, no query, fragment, user info or port, and nothing that needs decoding.
 */
export function parseDeepLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 800) return null
  const match = /^iskra:\/\/(join|invite)\/([^/?#]+)\/?$/i.exec(raw)
  if (!match) return null
  return INVITE_TOKEN.test(match[2]) ? match[2] : null
}

/** Windows and Linux pass the link as a command-line argument (first launch or a second instance). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const token = parseDeepLink(arg)
    if (token) return token
  }
  return null
}

// ── Desktop settings (kept by the main process: some apply before the window exists) ──

export interface DesktopSettings {
  /** Start when you log in, hidden in the tray. */
  openAtLogin: boolean
  /** The window's close button hides to the tray instead of quitting. */
  closeToTray: boolean
  /** GPU acceleration (takes effect after a restart). */
  hardwareAcceleration: boolean
  /** Show "Playing X" from running games (opt-in). */
  activity: boolean
  /** Your own programs to show as games: display name and process name (e.g. "mygame.exe"). */
  customGames: { name: string; process: string }[]
  /** The app's language as the page last reported it (null: not yet, follow the OS). */
  language: DesktopLanguage | null
  /** Hosted servers (folder ids) to keep running: they start with the app, also when it starts with the computer. */
  keepRunning: string[]
  /** Look for new versions on GitHub by itself (on by default: updates fix security problems). */
  updateChecks: boolean
  /** The version that ran last time, so the splash can say "Updated to X" once. */
  lastRunVersion: string | null
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  openAtLogin: false, closeToTray: true, hardwareAcceleration: true, activity: false, customGames: [], language: null, keepRunning: [], updateChecks: true, lastRunVersion: null,
}

export const MAX_CUSTOM_GAMES = 30
export const MAX_KEEP_RUNNING = 50

/** Hosted server ids are folder names made by the app (host.ts slug), nothing else. */
export const isServerId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v)

/** Display names: 1–64 visible characters (the server checks again). */
const cleanName = (v: unknown) =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 64 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v) ? v.trim() : null
/** Process names: a file name only, no paths. */
const cleanProcess = (v: unknown) =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 100 && !/[\\/:*?"<>|\p{Cc}]/u.test(v) ? v.trim() : null

export function parseDesktopSettings(raw: unknown): DesktopSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const flag = (key: 'openAtLogin' | 'closeToTray' | 'hardwareAcceleration' | 'activity' | 'updateChecks') =>
    typeof s[key] === 'boolean' ? (s[key] as boolean) : DEFAULT_DESKTOP_SETTINGS[key]
  const customGames: DesktopSettings['customGames'] = []
  if (Array.isArray(s.customGames)) {
    for (const g of s.customGames.slice(0, MAX_CUSTOM_GAMES)) {
      const name = cleanName((g as Record<string, unknown> | null)?.name)
      const proc = cleanProcess((g as Record<string, unknown> | null)?.process)
      if (name && proc) customGames.push({ name, process: proc })
    }
  }
  return {
    openAtLogin: flag('openAtLogin'), closeToTray: flag('closeToTray'), hardwareAcceleration: flag('hardwareAcceleration'),
    activity: flag('activity'), customGames, language: parseLanguage(s.language), updateChecks: flag('updateChecks'),
    keepRunning: Array.isArray(s.keepRunning) ? [...new Set(s.keepRunning.filter(isServerId))].slice(0, MAX_KEEP_RUNNING) : [],
    lastRunVersion: isVersion(s.lastRunVersion) ? s.lastRunVersion : null,
  }
}

/**
 * "Keep my server running" for one hosted server. On: Iskra starts with the computer (hidden in the tray), the close
 * button keeps it in the tray, and this server starts with it. Off for the last such server: Iskra stops starting
 * with the computer too (the tickbox put it there).
 */
export function setKeepRunning(settings: DesktopSettings, id: string, on: boolean): DesktopSettings {
  if (!isServerId(id)) return settings
  const others = settings.keepRunning.filter((k) => k !== id)
  if (on) return { ...settings, keepRunning: [...others, id].slice(0, MAX_KEEP_RUNNING), openAtLogin: true, closeToTray: true }
  return { ...settings, keepRunning: others, openAtLogin: others.length > 0 ? settings.openAtLogin : false }
}

/** Which hosted servers start with the app: all of them when you open it, only the kept-running ones at login. */
export function serversToStart(all: string[], settings: DesktopSettings, startedAtLogin: boolean): string[] {
  return startedAtLogin ? all.filter((id) => settings.keepRunning.includes(id)) : all
}

/** The flag a login-started app gets, so it stays in the tray. */
export const HIDDEN_FLAG = '--hidden'

/** Linux: ~/.config/autostart/iskra.desktop (setLoginItemSettings doesn't exist there). */
export function autostartEntry(exec: string): string {
  // Desktop entry quoting: " ` $ \ get a backslash inside quotes, and that backslash is itself escaped in the file.
  const quoted = /[\s"'$`\\]/.test(exec) ? `"${exec.replace(/(["`$\\])/g, '\\\\$1')}"` : exec
  return ['[Desktop Entry]', 'Type=Application', 'Name=Iskra', `Exec=${quoted} ${HIDDEN_FLAG}`, 'X-GNOME-Autostart-enabled=true', ''].join('\n')
}

/** The macOS dock badge for an unread count. */
export const badgeText = (count: number) => (count <= 0 || !Number.isFinite(count) ? '' : count > 99 ? '99+' : String(Math.floor(count)))
