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

export interface DesktopBridge {
  platform: string
  setPushToTalkKey(keycode: number | null): Promise<void>
  capturePushToTalkKey(): Promise<{ code: number; name: string }>
  onPushToTalk(callback: (down: boolean) => void): () => void
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
  }
}

export const desktop: DesktopBridge | undefined = (globalThis as { iskraDesktop?: DesktopBridge }).iskraDesktop
