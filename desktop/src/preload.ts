// The only bridge between the web app and the desktop shell. Small on purpose:
// the page can ask for push-to-talk and answer the screen picker, nothing else.
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
  capturePushToTalkKey: (): Promise<{ code: number; name: string }> => ipcRenderer.invoke('iskra:capture-ptt-key'),
  onPushToTalk: (callback: (down: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, down: boolean) => callback(down)
    ipcRenderer.on('iskra:ptt', listener)
    return () => ipcRenderer.off('iskra:ptt', listener)
  },

  onPickScreen: (callback: (sources: ScreenSource[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sources: ScreenSource[]) => callback(sources)
    ipcRenderer.on('iskra:pick-screen', listener)
    return () => ipcRenderer.off('iskra:pick-screen', listener)
  },
  pickScreen: (id: string | null): void => ipcRenderer.send('iskra:screen-picked', typeof id === 'string' ? id : null),
  callAlert: (on: boolean): Promise<void> => ipcRenderer.invoke('iskra:call-alert', on === true),

  host: {
    available: (): Promise<boolean> => ipcRenderer.invoke('iskra:host-available'),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('iskra:host-list'),
    create: (name: string, appUrl: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-create', name, appUrl),
    start: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-start', id),
    stop: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-stop', id),
  },
})
