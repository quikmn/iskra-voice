// What the desktop app (Electron preload) adds. Undefined in a normal browser.
export interface ScreenSource {
  id: string
  name: string
  thumbnail: string
  isScreen: boolean
}

export interface DesktopBridge {
  platform: string
  setPushToTalkKey(keycode: number | null): Promise<void>
  capturePushToTalkKey(): Promise<{ code: number; name: string }>
  onPushToTalk(callback: (down: boolean) => void): () => void
  onPickScreen(callback: (sources: ScreenSource[]) => void): () => void
  pickScreen(id: string | null): void
}

export const desktop: DesktopBridge | undefined = (globalThis as { iskraDesktop?: DesktopBridge }).iskraDesktop
