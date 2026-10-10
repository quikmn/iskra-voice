// What the desktop app (Electron preload) adds. Undefined in a normal browser.
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
export type PushToTalkStatus = 'ready' | 'needs-permission' | 'limited' | 'unavailable'

export interface DesktopBridge {
  platform: string
  setPushToTalkKey(keycode: number | null): Promise<void>
  /** null when keys can't be seen (see pushToTalkStatus). */
  capturePushToTalkKey(): Promise<{ code: number; name: string } | null>
  onPushToTalk(callback: (down: boolean) => void): () => void
  pushToTalkStatus(): Promise<PushToTalkStatus>
  /** macOS: opens a Privacy & Security page in System Settings. */
  openSystemSettings(pane: 'accessibility' | 'screen' | 'microphone' | 'camera'): Promise<void>
  updates: {
    status(): Promise<unknown>
    onStatus(callback: (status: unknown) => void): () => void
    restart(): Promise<boolean>
  }
  onPickScreen(callback: (sources: ScreenSource[]) => void): () => void
  pickScreen(id: string | null): void
  /** An incoming call: flash the taskbar and bring the window up (without stealing focus). */
  callAlert?(on: boolean): Promise<void>
  host: {
    available(): Promise<boolean>
    list(): Promise<HostedServer[]>
    create(name: string, appUrl: string): Promise<HostedServer | null>
    start(id: string): Promise<HostedServer | null>
    stop(id: string): Promise<HostedServer | null>
    /** Asks for a backup file (.iskrabackup, or a daily .zip); null if cancelled. `encrypted` backups need the passphrase. */
    pickBackup?(): Promise<PickedBackup | null>
    /** Restores a picked backup into a new server folder here and starts it. Rejects with a readable message. */
    restore?(path: string, passphrase: string): Promise<RestoredServer>
  }
  /** Saves a file from a server URL (asks where). */
  download?(url: string): Promise<boolean>
}

export const desktop: DesktopBridge | undefined = (globalThis as { iskraDesktop?: DesktopBridge }).iskraDesktop
