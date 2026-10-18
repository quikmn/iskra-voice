// The only bridge between the web app and the desktop shell. Small on purpose:
// push-to-talk and hotkeys, the screen picker, hosting (and restoring backups), bots on this PC, renting a server on DigitalOcean, update notices,
// saving backups and big files, a picture of this window for bug reports, the OS keychain, pop-out windows, and the
// shell's own notices (worded by the page), nothing else.
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
  // Whisper and priority keys: held, so the page hears both the press and the release.
  onHoldHotkey: (callback: (action: 'whisper1' | 'whisper2' | 'whisper3' | 'priority', down: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: unknown) => {
      const { action, down } = (event ?? {}) as { action?: unknown; down?: unknown }
      if ((action === 'whisper1' || action === 'whisper2' || action === 'whisper3' || action === 'priority') && typeof down === 'boolean') callback(action, down)
    }
    ipcRenderer.on('iskra:hold', listener)
    return () => ipcRenderer.off('iskra:hold', listener)
  },
  // Bug reports: a picture of one of the app's own windows ('main' or a pop-out's name; PNG data URL), never the screen.
  captureWindow: (target: string): Promise<string | null> => ipcRenderer.invoke('iskra:capture-window', target),
  // The app log (userData/logs): the page's own entries go in (checked again there), and a bug report takes the last 30 minutes.
  logs: {
    write: (entry: unknown): void => ipcRenderer.send('iskra:log', entry),
    tail: (): Promise<unknown> => ipcRenderer.invoke('iskra:log-tail'),
  },
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

  // The shell's own messages (the tray's update check result, About, the macOS screen permission) as structured
  // notices the page puts into words and shows as its toasts and dialogs (desktop/src/notices.ts); `act` is a button in one.
  notices: {
    onNotice: (callback: (notice: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, notice: unknown) => callback(notice)
      ipcRenderer.on('iskra:notice', listener)
      return () => ipcRenderer.off('iskra:notice', listener)
    },
    act: (kind: string, action: string): Promise<void> => ipcRenderer.invoke('iskra:notice-action', kind, action),
  },
  // What this shell is built on, for About & legal.
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, arch: process.arch },

  onPickScreen: (callback: (sources: ScreenSource[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sources: ScreenSource[]) => callback(sources)
    ipcRenderer.on('iskra:pick-screen', listener)
    return () => ipcRenderer.off('iskra:pick-screen', listener)
  },
  pickScreen: (id: string | null): void => ipcRenderer.send('iskra:screen-picked', typeof id === 'string' ? id : null),
  callAlert: (on: boolean): Promise<void> => ipcRenderer.invoke('iskra:call-alert', on === true),
  // Pop-out windows (opened with window.open by name): always on top, click-through, its handle, and focus.
  popout: {
    set: (name: string, patch: { alwaysOnTop?: boolean; clickThrough?: boolean; handle?: boolean; focus?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('iskra:popout-set', name, patch),
  },

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
  // Streamer mode: whether one of the user's own listed programs runs (a yes or no, never which).
  streamerProgram: (): Promise<boolean | null> => ipcRenderer.invoke('iskra:streamer-program'),
  onStreamerProgram: (callback: (running: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, running: unknown) => callback(running === true)
    ipcRenderer.on('iskra:streamer-program', listener)
    return () => ipcRenderer.off('iskra:streamer-program', listener)
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
    pickTemplate: (): Promise<unknown> => ipcRenderer.invoke('iskra:host-pick-template'),
    keepRunning: (id: string, on: boolean): Promise<unknown> => ipcRenderer.invoke('iskra:host-keep-running', id, on),
    start: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-start', id),
    stop: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-stop', id),
    pickBackup: (): Promise<unknown> => ipcRenderer.invoke('iskra:host-pick-backup'),
    restore: (path: string, passphrase: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-restore', path, passphrase),
    restoreBuddy: (address: string, recoveryCode: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-restore-buddy', address, recoveryCode),
    // "Let friends connect without port forwarding" changed on a server hosted here: the tunnel follows.
    p2pSync: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:host-p2p-sync', id),
    onP2p: (callback: (update: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, update: unknown) => callback(update)
      ipcRenderer.on('iskra:host-p2p', listener)
      return () => ipcRenderer.off('iskra:host-p2p', listener)
    },
  },
  // Bots on this PC: gallery bots (by id) and folders the person picks in the main process's own dialog.
  bots: {
    gallery: (): Promise<unknown[]> => ipcRenderer.invoke('iskra:bots-gallery'),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('iskra:bots-list'),
    add: (galleryId: string | null, name?: string): Promise<unknown> => ipcRenderer.invoke('iskra:bots-add', galleryId, name ?? null),
    update: (id: string, patch: unknown): Promise<unknown> => ipcRenderer.invoke('iskra:bots-update', id, patch),
    start: (id: string, invite?: string | null): Promise<unknown> => ipcRenderer.invoke('iskra:bots-start', id, invite ?? null),
    stop: (id: string): Promise<unknown> => ipcRenderer.invoke('iskra:bots-stop', id),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('iskra:bots-remove', id),
    log: (id: string): Promise<string[]> => ipcRenderer.invoke('iskra:bots-log', id),
    openFolder: (id: string): Promise<void> => ipcRenderer.invoke('iskra:bots-open-folder', id),
    onChange: (callback: () => void): (() => void) => {
      const listener = () => callback()
      ipcRenderer.on('iskra:bots', listener)
      return () => ipcRenderer.off('iskra:bots', listener)
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
  // The personal assistant: requests to the user's AI provider (checked in the main process), and the local MCP bridge.
  assistant: {
    fetch: (request: unknown): Promise<unknown> => ipcRenderer.invoke('iskra:assistant-fetch', request),
    setBase: (baseUrl: string | null): Promise<unknown> => ipcRenderer.invoke('iskra:assistant-base', typeof baseUrl === 'string' ? baseUrl : null),
    setMcp: (on: boolean): Promise<unknown> => ipcRenderer.invoke('iskra:mcp-set', on === true),
    onMcp: (callback: (request: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, request: unknown) => callback(request)
      ipcRenderer.on('iskra:mcp', listener)
      return () => ipcRenderer.off('iskra:mcp', listener)
    },
    mcpReply: (id: string, answer: unknown): Promise<void> => ipcRenderer.invoke('iskra:mcp-reply', id, answer),
  },
  download: (url: string): Promise<boolean> => ipcRenderer.invoke('iskra:download', url),
  // Recording a call (desktop/src/recordings.ts): ids only, never paths from the page.
  recordings: {
    folder: (): Promise<string | null> => ipcRenderer.invoke('iskra:rec-folder'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('iskra:rec-pick'),
    begin: (server: string, channel: string): Promise<unknown> => ipcRenderer.invoke('iskra:rec-begin', server, channel),
    open: (id: string, name: string): Promise<string | null> => ipcRenderer.invoke('iskra:rec-open', id, name),
    write: (file: string, data: Uint8Array): Promise<string> => ipcRenderer.invoke('iskra:rec-write', file, data),
    close: (file: string): Promise<boolean> => ipcRenderer.invoke('iskra:rec-close', file),
    info: (id: string, text: string): Promise<boolean> => ipcRenderer.invoke('iskra:rec-info', id, text),
    end: (id: string): Promise<void> => ipcRenderer.invoke('iskra:rec-end', id),
    show: (id: string): Promise<void> => ipcRenderer.invoke('iskra:rec-show', id),
  },
  // Big decrypted DM files: a Save dialog, then the bytes a piece at a time; finish only once they're checked.
  saveFile: {
    begin: (name: string): Promise<string | null> => ipcRenderer.invoke('iskra:save-begin', name),
    write: (id: string, data: Uint8Array): Promise<boolean> => ipcRenderer.invoke('iskra:save-write', id, data),
    finish: (id: string): Promise<boolean> => ipcRenderer.invoke('iskra:save-finish', id),
    abort: (id: string): Promise<void> => ipcRenderer.invoke('iskra:save-abort', id),
  },
})
