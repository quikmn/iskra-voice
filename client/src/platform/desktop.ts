// What the desktop app (Electron preload) adds. Undefined in a normal browser.
import { onLanguage } from '../i18n'

export interface ScreenSource {
  id: string
  name: string
  thumbnail: string
  isScreen: boolean
}

export interface HostedServer {
  id: string
  name: string
  folder: string
  port: number
  running: boolean
  lanUrl: string
  localUrl: string
  ownerInvite: string | null
  /** "Keep my server running" is on (missing in older desktop builds). */
  keepRunning?: boolean
  /** How friends on Tailscale reach it, when Tailscale is on (missing in older desktop builds). */
  tailscaleUrl?: string | null
  /** The peer-to-peer tunnel for friends without port forwarding, when the world has it on (missing in older desktop builds). */
  p2p?: P2pHostStatus | null
}

/** The desktop app's side of "Let friends connect without port forwarding" for a server it hosts. */
export interface P2pHostStatus {
  /** unavailable: this build or mode has no peer-to-peer network (development builds and local-only runs without a testnet). */
  state: 'off' | 'unavailable' | 'starting' | 'ready' | 'failed'
  /** The host's DHT public key (hex), what friends look up. */
  hostKey: string | null
  nat: {
    /** Behind a NAT or firewall (nearly every home). */
    firewalled: boolean
    /** The NAT gives each destination a new port: hard to punch, so friends on such NATs too may fail to connect. */
    randomized: boolean
    publicAddress: string | null
  } | null
  /** Tunnel connections open right now. */
  connections: number
  error?: string
}

/** A local address that leads to a server through the tunnel (desktop.p2p.open). */
export interface TunnelEndpoint {
  url: string
  /** LiveKit's TURN through the tunnel: turn:127.0.0.1:<turnPort>. */
  turnPort: number
}

/** A starter template for a new server, as the bundled iskra-server describes it. */
export interface ServerTemplateInfo {
  id: string
  name: string
  description: string
  categories: { name: string; channels: TemplateChannelInfo[] }[]
  channels: TemplateChannelInfo[]
  roles: string[]
  rules: boolean
}

export interface TemplateChannelInfo {
  name: string
  kind: 'text' | 'voice'
  userLimit: number
}

export interface PickedBackup {
  path: string
  fileName: string
  /** The server's name from the backup's header (encrypted backups), if readable. */
  name: string | null
  encrypted: boolean
}

export interface RestoredServer {
  server: HostedServer
  serverKey: string
  name: string
}

/**
 * ready: works everywhere. needs-permission: macOS Accessibility is off.
 * limited: Wayland, where only keys pressed in X11 apps reach us. unavailable: the key hook couldn't start.
 */
/** Kept by the desktop app itself (desktop/src/settings.ts). */
export interface DesktopSettings {
  openAtLogin: boolean
  closeToTray: boolean
  hardwareAcceleration: boolean
  activity: boolean
  customGames: { name: string; process: string }[]
  /** Hosted servers kept running ("Keep my server running"). Missing in older desktop builds. */
  keepRunning?: string[]
  /** Looks for new versions on GitHub by itself (default on). Missing in older desktop builds. */
  updateChecks?: boolean
}

export type PushToTalkStatus = 'ready' | 'needs-permission' | 'limited' | 'unavailable'

export interface DesktopBridge {
  platform: string
  setPushToTalkKey(keycode: number | null): Promise<void>
  /** null when keys can't be seen (see pushToTalkStatus). */
  capturePushToTalkKey(): Promise<{ code: number; name: string } | null>
  onPushToTalk(callback: (down: boolean) => void): () => void
  pushToTalkStatus(): Promise<PushToTalkStatus>
  /** Global mute/deafen hotkeys: codes and modifiers (Ctrl 1, Shift 2, Alt 4, Meta 8). Missing in older desktop builds. */
  setHotkeys?(binds: Partial<Record<'mute' | 'deafen', { code: number; mods: number }>>): Promise<void>
  /** The next key or side button pressed, with modifiers held; null if cancelled (Escape) or keys can't be seen. */
  captureHotkey?(): Promise<{ code: number; mods: number; name: string } | null>
  cancelHotkeyCapture?(): Promise<void>
  /** Only the action ever arrives, never which keys were pressed. */
  onHotkey?(callback: (action: 'mute' | 'deafen' | 'clip') => void): () => void
  /** macOS: opens a Privacy & Security page in System Settings. */
  openSystemSettings(pane: 'accessibility' | 'screen' | 'microphone' | 'camera'): Promise<void>
  /** Tells the shell the app's language, for the tray and native dialogs (older shells don't have it). */
  setLanguage?(language: string): Promise<void>
  updates: {
    status(): Promise<unknown>
    onStatus(callback: (status: unknown) => void): () => void
    restart(): Promise<boolean>
    /** "Updating Iskra to X…" right before the shell quits into an update; null if it didn't (older shells don't have it). */
    onUpdating?(callback: (version: string | null) => void): () => void
  }
  onPickScreen(callback: (sources: ScreenSource[]) => void): () => void
  pickScreen(id: string | null): void
  /** An incoming call: flash the taskbar and bring the window up (without stealing focus). */
  callAlert?(on: boolean): Promise<void>
  /** WebAuthn ceremonies for app lock passkeys, run by the main process on https://app.iskra.foo (desktop/src/passkeys.ts). */
  passkey?: { run(op: 'create' | 'get', request: unknown): Promise<{ ok: boolean; name?: string; message?: string } & Record<string, unknown>> }
  /** The OS keychain (Electron safeStorage). basic: Linux without a keyring, which protects nothing. */
  keychain?: {
    status(): Promise<'keyring' | 'basic' | 'unavailable'>
    encrypt(data: string): Promise<string | null>
    decrypt(data: string): Promise<string | null>
  }
  settings: {
    get(): Promise<DesktopSettings | null>
    set(patch: Partial<DesktopSettings>): Promise<DesktopSettings>
    /** Restarts the app (hardware acceleration changes). */
    relaunch(): Promise<void>
  }
  /** Unread count on the taskbar / dock; Windows shows `overlay` (a small PNG data URL) as the overlay icon. */
  setBadge(count: number, overlay: string | null): Promise<void>
  /** Flash the taskbar (bounce the dock) while the app isn't focused. */
  attention(): Promise<void>
  /** An iskra://join/... invite token that started the app, once. */
  takeDeepLink(): Promise<string | null>
  /** The game running now, if activity status is on (only its name; never the program list). */
  activity(): Promise<string | null>
  onActivity(callback: (game: string | null) => void): () => void
  onDeepLink(callback: (token: string) => void): () => void
  host: {
    available(): Promise<boolean>
    list(): Promise<HostedServer[]>
    /** template: a starter template id from templates(), applied once on the server's first start. */
    create(name: string, appUrl: string, template?: string | null): Promise<HostedServer | null>
    /** The bundled server's starter templates (missing in older desktop builds). */
    templates?(): Promise<ServerTemplateInfo[]>
    /** "Keep my server running": Iskra starts with the computer, hidden, and starts this server. */
    keepRunning?(id: string, on: boolean): Promise<HostedServer | null>
    start(id: string): Promise<HostedServer | null>
    stop(id: string): Promise<HostedServer | null>
    /** Asks for a backup file (.iskrabackup, or a daily .zip); null if cancelled. `encrypted` backups need the passphrase. */
    pickBackup?(): Promise<PickedBackup | null>
    /** Restores a picked backup into a new server folder here and starts it. Rejects with a readable message. */
    restore?(path: string, passphrase: string): Promise<RestoredServer>
    /** "Let friends connect without port forwarding" changed on a server hosted here: the tunnel follows the world's files. */
    p2pSync?(id: string): Promise<HostedServer | null>
    /** The tunnel's status for a hosted server changed (it started, found its NAT type, failed). */
    onP2p?(callback: (update: { id: string; p2p: P2pHostStatus }) => void): () => void
  }
  /** A server behind a shared connection (missing in older desktop builds): open returns the local address, or `{ error }`. */
  p2p?: {
    open(serverKey: string, secret: string): Promise<TunnelEndpoint | { error: string } | null>
    close(serverKey: string): Promise<void>
    /** Say so before a room connects through a tunnel (WebRTC then uses one any-address socket) and again on leaving. */
    voice?(on: boolean): Promise<void>
  }
  /** Saves a file from a server URL (asks where). */
  download?(url: string): Promise<boolean>
  /** Big decrypted files straight to disk: a Save dialog (null if cancelled), then the bytes; `finish` only once they're checked. */
  saveFile?: {
    begin(name: string): Promise<string | null>
    write(id: string, data: Uint8Array): Promise<boolean>
    finish(id: string): Promise<boolean>
    abort(id: string): Promise<void>
  }
}

export const desktop: DesktopBridge | undefined = (globalThis as { iskraDesktop?: DesktopBridge }).iskraDesktop

// The tray and native dialogs follow the app's language.
if (desktop?.setLanguage) onLanguage((language) => void desktop!.setLanguage!(language).catch(() => undefined))
