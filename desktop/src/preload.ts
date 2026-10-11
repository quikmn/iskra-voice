// The only bridge between the web app and the desktop shell. Small on purpose:
// push-to-talk, the screen picker, hosting, and update notices, nothing else.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export interface ScreenSource {
  id: string
  name: string
  thumbnail: string
  isScreen: boolean
}

contextBridge.exposeInMainWorld('iskraDesktop', {
  platform: process.platform,

  setPushToTalkKey: (keycode: number | null): Promise<void> => ipcRenderer.invoke('iskra:set-ptt', keycode),
  capturePushToTalkKey: (): Promise<{ code: number; name: string } | null> => ipcRenderer.invoke('iskra:capture-ptt-key'),
  onPushToTalk: (callback: (down: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, down: boolean) => callback(down)
    ipcRenderer.on('iskra:ptt', listener)
    return () => ipcRenderer.off('iskra:ptt', listener)
  },
  pushToTalkStatus: (): Promise<string> => ipcRenderer.invoke('iskra:ptt-status'),
  openSystemSettings: (pane: string): Promise<void> => ipcRenderer.invoke('iskra:open-settings', pane),

  updates: {
    status: (): Promise<unknown> => ipcRenderer.invoke('iskra:update-status'),
    onStatus: (callback: (status: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, status: unknown) => callback(status)
      ipcRenderer.on('iskra:update', listener)
      return () => ipcRenderer.off('iskra:update', listener)
    },
    restart: (): Promise<boolean> => ipcRenderer.invoke('iskra:update-restart'),
  },

  onPickScreen: (callback: (sources: ScreenSource[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sources: ScreenSource[]) => callback(sources)
    ipcRenderer.on('iskra:pick-screen', listener)
    return () => ipcRenderer.off('iskra:pick-screen', listener)
  },
  pickScreen: (id: string | null): void => ipcRenderer.send('iskra:screen-picked', typeof id === 'string' ? id : null),
  callAlert: (on: boolean): Promise<void> => ipcRenderer.invoke('iskra:call-alert', on === true),

  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('iskra:desktop-settings'),
    set: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('iskra:set-desktop-settings', patch),
    relaunch: (): Promise<void> => ipcRenderer.invoke('iskra:relaunch'),
  },
  setBadge: (count: number, overlay: string | null): Promise<void> => ipcRenderer.invoke('iskra:badge', count, overlay),
  attention: (): Promise<void> => ipcRenderer.invoke('iskra:attention'),
  takeDeepLink: (): Promise<string | null> => ipcRenderer.invoke('iskra:take-deep-link'),
  activity: (): Promise<string | null> => ipcRenderer.invoke('iskra:activity'),
  onActivity: (callback: (game: string | null) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, game: string | null) => callback(typeof game === 'string' ? game : null)
    ipcRenderer.on('iskra:activity', listener)
    return () => ipcRenderer.off('iskra:activity', listener)
  },
  onDeepLink: (callback: (token: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, token: string) => callback(token)
    ipcRenderer.on('iskra:deep-link', listener)
    return () => ipcRenderer.off('iskra:deep-link', listener)
  },

  host: {
    available: (): Promise<boolean> => ipcRenderer.invoke('iskra:host-available'),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('iskra:host-list'),
    create: (name: string, appUrl: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-create', name, appUrl),
    start: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-start', id),
    stop: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-stop', id),
  },
})
