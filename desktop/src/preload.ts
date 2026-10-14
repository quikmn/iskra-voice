// The only bridge between the web app and the desktop shell. Small on purpose:
// push-to-talk and hotkeys, the screen picker, hosting (and restoring backups), renting a server on DigitalOcean, update notices,
// saving backups and big files, a picture of this window for bug reports, and the OS keychain, nothing else.
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
  // Mute/deafen/clip hotkeys: the page sets them and hears which action fired, never other keys.
  setHotkeys: (binds: unknown): Promise<void> => ipcRenderer.invoke('iskra:set-hotkeys', binds),
  captureHotkey: (): Promise<{ code: number; mods: number; name: string } | null> => ipcRenderer.invoke('iskra:capture-hotkey'),
  cancelHotkeyCapture: (): Promise<void> => ipcRenderer.invoke('iskra:cancel-hotkey-capture'),
  onHotkey: (callback: (action: 'mute' | 'deafen' | 'clip') => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: unknown) => {
      if (action === 'mute' || action === 'deafen' || action === 'clip') callback(action)
    }
    ipcRenderer.on('iskra:hotkey', listener)
    return () => ipcRenderer.off('iskra:hotkey', listener)
  },
  // Bug reports: a picture of this app window only (PNG data URL), never the screen.
  captureApp: (): Promise<string | null> => ipcRenderer.invoke('iskra:capture-app'),
  openSystemSettings: (pane: string): Promise<void> => ipcRenderer.invoke('iskra:open-settings', pane),
  setLanguage: (language: string): Promise<void> => ipcRenderer.invoke('iskra:set-language', language),

  updates: {
    status: (): Promise<unknown> => ipcRenderer.invoke('iskra:update-status'),
    onStatus: (callback: (status: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, status: unknown) => callback(status)
      ipcRenderer.on('iskra:update', listener)
      return () => ipcRenderer.off('iskra:update', listener)
    },
    restart: (): Promise<boolean> => ipcRenderer.invoke('iskra:update-restart'),
    // "Updating Iskra to X…" just before the app quits into an update (null: it didn't happen after all).
    onUpdating: (callback: (version: string | null) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, version: unknown) => callback(typeof version === 'string' ? version : null)
      ipcRenderer.on('iskra:updating', listener)
      return () => ipcRenderer.off('iskra:updating', listener)
    },
  },

  onPickScreen: (callback: (sources: ScreenSource[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sources: ScreenSource[]) => callback(sources)
    ipcRenderer.on('iskra:pick-screen', listener)
    return () => ipcRenderer.off('iskra:pick-screen', listener)
  },
  pickScreen: (id: string | null): void => ipcRenderer.send('iskra:screen-picked', typeof id === 'string' ? id : null),
  callAlert: (on: boolean): Promise<void> => ipcRenderer.invoke('iskra:call-alert', on === true),

  keychain: {
    status: (): Promise<string> => ipcRenderer.invoke('iskra:keychain-status'),
    encrypt: (data: string): Promise<string | null> => ipcRenderer.invoke('iskra:keychain-encrypt', data),
    decrypt: (data: string): Promise<string | null> => ipcRenderer.invoke('iskra:keychain-decrypt', data),
  },
  // App lock passkeys: the main process runs the WebAuthn ceremony (desktop/src/passkeys.ts).
  // Resolves with { ok: true, ... } or { ok: false, name } (WebAuthn's error names), never rejects.
  passkey: {
    run: (op: 'create' | 'get', request: unknown): Promise<unknown> => ipcRenderer.invoke('iskra:passkey', op === 'create' ? 'create' : 'get', request),
  },
  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('iskra:desktop-settings'),
    set: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('iskra:set-desktop-settings', patch),
    relaunch: (): Promise<void> => ipcRenderer.invoke('iskra:relaunch'),
  },
  setBadge: (count: number, overlay: string | null): Promise<void> => ipcRenderer.invoke('iskra:badge', count, overlay),
  attention: (): Promise<void> => ipcRenderer.invoke('iskra:attention'),
  takeDeepLink: (): Promise<string | null> => ipcRenderer.invoke('iskra:take-deep-link'),
  activity: (): Promise<string | null> => ipcRenderer.invoke('iskra:activity'),
  systemIdleSeconds: (): Promise<number | null> => ipcRenderer.invoke('iskra:system-idle'),
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
    create: (name: string, appUrl: string, template?: string | null): Promise<unknown> => ipcRenderer.invoke('iskra:host-create', name, appUrl, template ?? null),
    templates: (): Promise<unknown[]> => ipcRenderer.invoke('iskra:host-templates'),
    keepRunning: (id: string, on: boolean): Promise<unknown> => ipcRenderer.invoke('iskra:host-keep-running', id, on),
    start: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-start', id),
    stop: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-stop', id),
    pickBackup: (): Promise<unknown> => ipcRenderer.invoke('iskra:host-pick-backup'),
    restore: (path: string, passphrase: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-restore', path, passphrase),
    // "Let friends connect without port forwarding" changed on a server hosted here: the tunnel follows.
    p2pSync: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-p2p-sync', id),
    onP2p: (callback: (update: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, update: unknown) => callback(update)
      ipcRenderer.on('iskra:host-p2p', listener)
      return () => ipcRenderer.off('iskra:host-p2p', listener)
    },
  },
  // A server behind a shared connection: a local address that leads to it through the peer-to-peer tunnel.
  p2p: {
    open: (serverKey: string, secret: string): Promise<unknown> => ipcRenderer.invoke('iskra:p2p-open', serverKey, secret),
    close: (serverKey: string): Promise<void> => ipcRenderer.invoke('iskra:p2p-close', serverKey),
    // Voice is about to go through a tunnel (before the room connects), or just left it.
    voice: (on: boolean): Promise<void> => ipcRenderer.invoke('iskra:p2p-voice', on === true),
  },
  // Rent a server on DigitalOcean: the token goes to the main process once and never comes back.
  digitalOcean: {
    connect: (token: string): Promise<unknown> => ipcRenderer.invoke('iskra:do-connect', token),
    // "Connect to DigitalOcean" in the browser (OAuth); false until Iskra's OAuth app is registered.
    oauthAvailable: (): Promise<boolean> => ipcRenderer.invoke('iskra:do-oauth-available'),
    oauth: (): Promise<unknown> => ipcRenderer.invoke('iskra:do-oauth'),
    create: (options: unknown): Promise<unknown> => ipcRenderer.invoke('iskra:do-create', options),
    cancel: (): Promise<void> => ipcRenderer.invoke('iskra:do-cancel'),
    cleanUp: (): Promise<unknown> => ipcRenderer.invoke('iskra:do-clean-up'),
    forget: (): Promise<void> => ipcRenderer.invoke('iskra:do-forget'),
    onProgress: (callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on('iskra:do-progress', listener)
      return () => ipcRenderer.off('iskra:do-progress', listener)
    },
  },
  download: (url: string): Promise<boolean> => ipcRenderer.invoke('iskra:download', url),
  // Big decrypted DM files: a Save dialog, then the bytes a piece at a time; finish only once they're checked.
  saveFile: {
    begin: (name: string): Promise<string | null> => ipcRenderer.invoke('iskra:save-begin', name),
    write: (id: string, data: Uint8Array): Promise<boolean> => ipcRenderer.invoke('iskra:save-write', id, data),
    finish: (id: string): Promise<boolean> => ipcRenderer.invoke('iskra:save-finish', id),
    abort: (id: string): Promise<void> => ipcRenderer.invoke('iskra:save-abort', id),
  },
})
