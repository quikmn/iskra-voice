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
}

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
    create(name: string, appUrl: string): Promise<HostedServer | null>
    start(id: string): Promise<HostedServer | null>
    stop(id: string): Promise<HostedServer | null>
  }
}

export const desktop: DesktopBridge | undefined = (globalThis as { iskraDesktop?: DesktopBridge }).iskraDesktop
