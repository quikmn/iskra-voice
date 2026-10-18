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
  /** Newer servers (template format 2) say more for the preview. */
  version?: number
  roleDetails?: { name: string; color: string | null; icon: string | null; permissions: string[] }[]
  builtinRoles?: Record<string, { color: string | null; abilities: string[] | null; permissions: string[] | null }>
  afk?: { channel: string; minutes: number; canTalk: string[] } | null
  settings?: { notifyDefault: string | null; limits: boolean; builtinBots: string[]; bugInbox: string | null } | null
}

export interface TemplateChannelInfo {
  name: string
  kind: 'text' | 'voice' | 'forum' | 'stage' | 'docs' | 'whiteboard' | 'media'
  userLimit: number
  readRole?: string
  writeRole?: string
  hifi?: boolean
  slowmode?: number
  overrides?: { role: string; allow: string[]; deny: string[] }[]
  tags?: string[]
}

/** A template file someone picked: what it sets up (its id names it for create()), or why it can't be used. */
export type PickedTemplate = { fileName: string; template: ServerTemplateInfo } | { error: string }

/** A bot that ships with the desktop app (desktop/assets/gallery.json). */
export interface GalleryBotInfo {
  id: string
  name: string
  /** The bot invite the app makes for it can read all messages / join voice. */
  readAll: boolean
  voice: boolean
  settings: { env: string; kind: 'text' | 'number' | 'secret'; default: string }[]
}

/** A bot the desktop app runs (desktop/src/bots.ts BotStatus). */
export interface PcBot {
  id: string
  kind: 'gallery' | 'folder'
  gallery?: string
  folder?: string
  name: string
  autostart: boolean
  settings: Record<string, string>
  state: 'stopped' | 'starting' | 'running' | 'failed'
  online: boolean
  needsInvite: boolean
  /** Why the last run ended by itself: an exit code, or no-entry / no-python / spawn / not-trusted. */
  problem: string | null
  /** Secret settings that have a value (the values never come to the page). */
  secretsSet?: string[]
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
  /** Streamer mode turns itself on while one of `customGames` runs (only those are looked for). Missing in older desktop builds. */
  streamerAuto?: boolean
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
  setHotkeys?(binds: Partial<Record<'mute' | 'deafen' | 'clip' | 'whisper1' | 'whisper2' | 'whisper3' | 'priority', { code: number; mods: number }>>): Promise<void>
  /** The next key or side button pressed, with modifiers held; null if cancelled (Escape) or keys can't be seen. */
  captureHotkey?(): Promise<{ code: number; mods: number; name: string } | null>
  cancelHotkeyCapture?(): Promise<void>
  /** Only the action ever arrives, never which keys were pressed. */
  onHotkey?(callback: (action: 'mute' | 'deafen' | 'clip') => void): () => void
  /** Whisper and priority keys: held, so both the press and the release arrive (missing in older desktop builds). */
  onHoldHotkey?(callback: (action: 'whisper1' | 'whisper2' | 'whisper3' | 'priority', down: boolean) => void): () => void
  /**
   * Bug reports: a PNG data URL of one of Iskra's own windows, 'main' or an open pop-out's name (never the report
   * window), and never the screen. null if there's no such window or nothing to capture (missing in older desktop builds).
   */
  captureWindow?(target: string): Promise<string | null>
  /**
   * The desktop app's log file (missing in older desktop builds): `write` keeps one of this page's entries there (the
   * app checks it again), `tail` gives the last 30 minutes of its lines (main process, updater, this page) for a bug report.
   */
  logs?: { write(entry: unknown): void; tail(): Promise<unknown> }
  /** macOS: opens a Privacy & Security page in System Settings. */
  openSystemSettings(pane: 'accessibility' | 'screen' | 'microphone' | 'camera'): Promise<void>
  /** Tells the shell the app's language, for the tray and native dialogs (older shells don't have it). */
  setLanguage?(language: string): Promise<void>
  /**
   * The shell's own messages (the tray's "Check for updates" result, About, the macOS screen permission) as structured
   * notices the app words and shows itself (state/desktopNotices.ts); `act` answers one of its buttons. Missing in older shells.
   */
  notices?: {
    onNotice(callback: (notice: unknown) => void): () => void
    act(kind: string, action: string): Promise<void>
  }
  /** What the shell is built on, for About & legal (missing in older shells). */
  versions?: { electron: string; chrome: string; node: string; arch: string }
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
  /**
   * Pop-out windows (missing in older desktop builds): the page opens them with window.open(popout.html, name) and
   * renders into them; this sets always on top, click-through, wakes a click-through window while the pointer is
   * on its handle, and brings one to the front (focus: older shells ignore it). Returns the window's flags, or null when there's no such pop-out.
   */
  popout?: { set(name: string, patch: { alwaysOnTop?: boolean; clickThrough?: boolean; handle?: boolean; focus?: boolean }): Promise<{ alwaysOnTop: boolean; clickThrough: boolean } | null> }
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
  /** Seconds since the last keyboard or mouse input on the computer (older desktop apps don't have it). */
  systemIdleSeconds?(): Promise<number | null>
  onActivity(callback: (game: string | null) => void): () => void
  /** Streamer mode: whether one of your own listed programs runs right now, and when that changes (missing in older desktop builds). */
  streamerProgram?(): Promise<boolean | null>
  onStreamerProgram?(callback: (running: boolean) => void): () => void
  onDeepLink(callback: (token: string) => void): () => void
  host: {
    available(): Promise<boolean>
    list(): Promise<HostedServer[]>
    /** template: a starter template id from templates() or pickTemplate(), applied once on the server's first start. */
    create(name: string, appUrl: string, template?: string | null): Promise<HostedServer | null>
    /** The bundled server's starter templates (missing in older desktop builds). */
    templates?(): Promise<ServerTemplateInfo[]>
    /** Asks for a template file and checks it with the bundled server; null if cancelled (missing in older desktop builds). */
    pickTemplate?(): Promise<PickedTemplate | null>
    /** "Keep my server running": Iskra starts with the computer, hidden, and starts this server. */
    keepRunning?(id: string, on: boolean): Promise<HostedServer | null>
    start(id: string): Promise<HostedServer | null>
    stop(id: string): Promise<HostedServer | null>
    /** Asks for a backup file (.iskrabackup, or a daily .zip); null if cancelled. `encrypted` backups need the passphrase. */
    pickBackup?(): Promise<PickedBackup | null>
    /** Restores a picked backup into a new server folder here and starts it. Rejects with a readable message. */
    restore?(path: string, passphrase: string): Promise<RestoredServer>
    /** Restores from a backup buddy (a friend's server) with the recovery code, here, and starts it (missing in older desktop builds). */
    restoreBuddy?(address: string, recoveryCode: string): Promise<RestoredServer>
    /** "Let friends connect without port forwarding" changed on a server hosted here: the tunnel follows the world's files. */
    p2pSync?(id: string): Promise<HostedServer | null>
    /** The tunnel's status for a hosted server changed (it started, found its NAT type, failed). */
    onP2p?(callback: (update: { id: string; p2p: P2pHostStatus }) => void): () => void
  }
  /** Bots on this PC (desktop/src/bots.ts; missing in older desktop builds). */
  bots?: {
    gallery(): Promise<GalleryBotInfo[]>
    list(): Promise<PcBot[]>
    /** A gallery bot by id, or null: a folder the person picks in the app's own dialog (null if they cancel). */
    add(galleryId: string | null, name?: string): Promise<PcBot | null>
    update(id: string, patch: { name?: string; autostart?: boolean; settings?: Record<string, string | null> }): Promise<PcBot | null>
    /** `invite`: a bot invite link, used until the bot has joined (kept in memory only). */
    start(id: string, invite?: string | null): Promise<PcBot | null>
    stop(id: string): Promise<PcBot | null>
    remove(id: string): Promise<boolean>
    /** The last lines the bot printed. */
    log(id: string): Promise<string[]>
    openFolder(id: string): Promise<void>
    onChange(callback: () => void): () => void
  }
  /** A server behind a shared connection (missing in older desktop builds): open returns the local address, or `{ error }`. */
  p2p?: {
    open(serverKey: string, secret: string): Promise<TunnelEndpoint | { error: string } | null>
    close(serverKey: string): Promise<void>
    /** Say so before a room connects through a tunnel (WebRTC then uses one any-address socket) and again on leaving. */
    voice?(on: boolean): Promise<void>
  }
  /**
   * The personal assistant (missing in older desktop builds): requests to the user's AI provider go out from the main
   * process (no browser CORS; only https or this computer, only the provider endpoints), and the local MCP bridge.
   */
  assistant?: {
    fetch(request: { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }>
    /** The provider address the user saved (null: none); the main process sends requests only to its endpoints. */
    setBase?(baseUrl: string | null): Promise<{ ok: true } | { ok: false; error: 'refused' | 'invalid' }>
    /** Turns the local MCP bridge on or off; `command` is what an MCP client runs before --mcp (this app). */
    setMcp(on: boolean): Promise<{ on: boolean; command: string[] | null }>
    /** A request from a local MCP client: list the tools, or call one. Answer with mcpReply. */
    onMcp(callback: (request: { id: string; method: 'list' | 'call'; name?: string; args?: unknown }) => void): () => void
    mcpReply(id: string, result: unknown): Promise<void>
  }
  /**
   * Rent a server on DigitalOcean (missing in older desktop builds). The token goes to the main process once and stays
   * there; replies carry an error code (DigitalOceanError) and DigitalOcean's own words, never the token.
   */
  digitalOcean?: {
    connect(token: string): Promise<{ ok: true; regions: DoRegionChoice[] } | DoFailure | null>
    /** "Connect to DigitalOcean" in the browser (OAuth); false until Iskra's OAuth app is registered. */
    oauthAvailable?(): Promise<boolean>
    oauth?(): Promise<{ ok: true; regions: DoRegionChoice[] } | DoFailure | null>
    create(options: { name: string; region: string; size: string; userData: string; ssh: boolean }): Promise<{ ok: true; server: DoRented } | (DoFailure & { created: DoCreated }) | null>
    cancel(): Promise<void>
    cleanUp(): Promise<{ ok: true; droplet: boolean; firewall: boolean } | (DoFailure & { created: DoCreated }) | null>
    forget(): Promise<void>
    onProgress(callback: (progress: DoProgress) => void): () => void
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
  /** Recording a call (desktop/src/recordings.ts): ids only; the shell makes the folder. */
  recordings?: RecordingsBridge
}

export interface RecordingsBridge {
  /** The recordings folder (Documents/Iskra recordings until one is picked). */
  folder(): Promise<string | null>
  pickFolder(): Promise<string | null>
  begin(server: string, channel: string): Promise<{ id: string; folder: string } | { error: 'folder' | 'disk' } | null>
  open(id: string, name: string): Promise<string | null>
  write(file: string, data: Uint8Array): Promise<'ok' | 'disk' | 'failed'>
  close(file: string): Promise<boolean>
  info(id: string, text: string): Promise<boolean>
  end(id: string): Promise<void>
  show(id: string): Promise<void>
}

// ── Rent a server on DigitalOcean (desktop/src/digitalocean.ts) ──
export type DigitalOceanError = 'token' | 'scope' | 'limit' | 'rate' | 'network' | 'server' | 'invalid' | 'timeout' | 'cancelled' | 'busy' | 'denied' | 'unavailable'
export interface DoFailure {
  ok: false
  error: DigitalOceanError
  /** DigitalOcean's own words (English), if any. */
  detail: string
}
export interface DoRegionChoice {
  slug: string
  name: string
  size: { slug: string; memoryMb: number; vcpus: number; diskGb: number; priceMonthly: number }
}
export interface DoCreated {
  dropletId?: number
  dropletName?: string
  firewallId?: string
}
export type DoStep = 'droplet' | 'firewall' | 'booting' | 'installing' | 'ready'
export interface DoProgress {
  step: DoStep
  ip?: string
  url?: string
}
export interface DoRented {
  ip: string
  url: string
  dropletId: number
  dropletName: string
  region: string
  size: string
}

export const desktop: DesktopBridge | undefined = (globalThis as { iskraDesktop?: DesktopBridge }).iskraDesktop

/** The OS's name for About & legal, from the shell's process.platform. */
export const osName = (platform: string): string => (platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform)

// The tray and native dialogs follow the app's language.
if (desktop?.setLanguage) onLanguage((language) => void desktop!.setLanguage!(language).catch(() => undefined))
