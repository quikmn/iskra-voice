// The page's side of "Bots on this PC" (My settings): IPC for the bot runner (bots.ts). Only the app's own page may
// call these; it never names a file or a program, only a gallery bot's id or a folder the person picked here.
import { app, dialog, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BotRunner, isInvite, parseGallery, type Confirm, type GalleryBot, type SecretBox } from './bots'
import { text } from './i18n'
import { deskLog } from './log'

type IpcEvent = Electron.IpcMainInvokeEvent

/** dist/gallery, outside the asar archive when packaged (the bots run in their own Node process). */
function galleryDir(): string {
  const dir = path.join(__dirname, 'gallery')
  return dir.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

function loadGallery(): GalleryBot[] {
  try {
    return parseGallery(JSON.parse(readFileSync(path.join(__dirname, '..', 'assets', 'gallery.json'), 'utf8')))
  } catch {
    return []
  }
}

/** Secret settings (like a Twitch app secret) encrypted with the OS keychain; where there's none, the runner stores them as-is. */
const keychain: SecretBox = {
  encrypt: (text) => {
    try {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null
      return safeStorage.encryptString(text).toString('base64')
    } catch {
      return null
    }
  },
  decrypt: (text) => {
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(text, 'base64')) : null
    } catch {
      return null
    }
  },
}

/** Native dialogs (never the page) before a folder bot runs for the first time, or starts by itself with the app. */
function confirmer(window: () => BrowserWindow | null): Confirm {
  return async (kind, bot) => {
    const words = text().bots
    const options = {
      type: 'warning' as const,
      buttons: [kind === 'trust-folder' ? words.run : words.autostart, words.cancel],
      defaultId: 1,
      cancelId: 1,
      title: words.warnTitle,
      message: kind === 'trust-folder' ? words.runQuestion(bot.name) : words.autostartQuestion(bot.name),
      detail: words.warnDetail(bot.folder),
    }
    const win = window()
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return result.response === 0
  }
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,60}$/.test(v)

/** Sets up the runner and its IPC; call once the app is ready (it needs userData). */
export function registerBots(window: () => BrowserWindow | null, fromApp: (event: IpcEvent) => boolean): BotRunner {
  const gallery = loadGallery()
  const runner = new BotRunner({
    root: path.join(app.getPath('userData'), 'bots'),
    execPath: process.execPath,
    galleryDir: galleryDir(),
    gallery,
    spawn,
    secrets: keychain,
    confirm: confirmer(window),
    onChange: () => window()?.webContents.send('iskra:bots'),
    // The app's own log says that a bot started or stopped (never its name, folder or output: that's in its bot.log).
    onEvent: (event, _id, detail) => {
      if (event === 'started') deskLog.info('life', 'bot-start', [['what', typeof detail === 'string' ? detail : null]])
      else if (event === 'stopped') deskLog.info('life', 'bot-stop')
      else if (event === 'exited') deskLog.warn('DSK-160', 'life', 'bot-exit', [['exit', typeof detail === 'number' ? detail : null]])
      else deskLog.warn('DSK-170', 'life', 'bot-fail', [['why', typeof detail === 'string' ? detail : null]])
    },
  })

  ipcMain.handle('iskra:bots-gallery', (event) => (fromApp(event) ? gallery : []))
  ipcMain.handle('iskra:bots-list', (event) => (fromApp(event) ? runner.list() : []))
  // galleryId: a bundled bot; null: a folder the person picks now (the page warns about running other people's code first).
  ipcMain.handle('iskra:bots-add', async (event, galleryId: unknown, name: unknown) => {
    if (!fromApp(event)) return null
    if (isId(galleryId)) return runner.add({ gallery: galleryId }, name)
    if (galleryId !== null) return null
    const win = window()
    // The warning again, in the app's own dialog (the page can't word it away).
    const options = {
      title: text().bots.pickTitle,
      message: text().bots.pickMessage,
      buttonLabel: text().bots.pickButton,
      properties: ['openDirectory' as const],
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null
    return runner.add({ folder: picked.filePaths[0] }, name)
  })
  ipcMain.handle('iskra:bots-update', async (event, id: unknown, patch: unknown) => {
    if (!fromApp(event) || !isId(id) || !patch || typeof patch !== 'object') return null
    const { name, autostart, settings } = patch as Record<string, unknown>
    return runner.update(id, { name, autostart, settings })
  })
  ipcMain.handle('iskra:bots-start', (event, id: unknown, invite: unknown) =>
    fromApp(event) && isId(id) ? runner.start(id, isInvite(invite) ? invite : undefined) : null)
  ipcMain.handle('iskra:bots-stop', (event, id: unknown) => (fromApp(event) && isId(id) ? runner.stop(id) : null))
  ipcMain.handle('iskra:bots-remove', (event, id: unknown) => (fromApp(event) && isId(id) ? runner.remove(id) : false))
  ipcMain.handle('iskra:bots-log', (event, id: unknown) => (fromApp(event) && isId(id) ? runner.tail(id, 200) : []))
  // Shows the bot's files: its own folder (keys, data, bot.log), or the folder it runs from.
  ipcMain.handle('iskra:bots-open-folder', (event, id: unknown) => {
    if (!fromApp(event) || !isId(id)) return
    const bot = runner.list().find((b) => b.id === id)
    if (bot) void shell.openPath(bot.kind === 'folder' && bot.folder ? bot.folder : runner.dataDir(id))
  })
  return runner
}
