// Iskra desktop: a thin, locked-down shell around the same web app.
// It adds what browsers can't do: push-to-talk while a game has focus, a screen/window picker,
// the tray, and a stable app:// origin for local storage.
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, net, protocol, session, shell, Tray } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Host } from './host'
import { PushToTalk } from './ptt'

const DEV_URL = process.env.ISKRA_DEV_URL // e.g. http://localhost:5173 while developing
const APP_ORIGIN = 'app://iskra'
const ICON = path.join(__dirname, '..', 'assets', 'icon.ico')
const CLIENT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'client') : path.join(__dirname, '..', '..', 'client', 'dist')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const ptt = new PushToTalk((down) => window?.webContents.send('iskra:ptt', down))
const host = new Host()

if (!app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', () => showWindow())

function showWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function isAppUrl(url: string): boolean {
  return url.startsWith(APP_ORIGIN + '/') || (!!DEV_URL && url.startsWith(DEV_URL))
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 420,
    minHeight: 500,
    backgroundColor: '#0b0b14',
    title: 'Iskra',
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  })

  window.once('ready-to-show', () => window?.show())
  void window.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`)

  // Links open in the real browser; the app window never navigates away from the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  // Closing hides to the tray, like Discord; quit from the tray menu.
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })
}

function setUpSession(): void {
  const appSession = session.defaultSession

  // Serve the built web app from app://iskra/ (a secure, stable origin for IndexedDB and getUserMedia).
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url)
    const relative = decodeURIComponent(pathname) === '/' ? '/index.html' : decodeURIComponent(pathname)
    const file = path.normalize(path.join(CLIENT_DIR, relative))
    if (!file.startsWith(CLIENT_DIR + path.sep)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  // Only the permissions a chat app needs, and only for the app itself.
  const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])
  appSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isAppUrl(contents.getURL()) && allowed.has(permission))
  })
  appSession.setPermissionCheckHandler((contents, permission) => !!contents && isAppUrl(contents.getURL()) && allowed.has(permission))

  // Screen sharing: let the user pick a screen or window in our own picker.
  appSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
    const choices = sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }))
    const pickedId = await new Promise<string | null>((resolve) => {
      ipcMain.once('iskra:screen-picked', (e, id: unknown) => resolve(fromApp(e) && typeof id === 'string' ? id : null))
      window?.webContents.send('iskra:pick-screen', choices)
    })
    const picked = sources.find((s) => s.id === pickedId)
    if (!picked) return callback({})
    // "loopback" shares system audio on Windows; elsewhere it's ignored.
    callback(process.platform === 'win32' ? { video: picked, audio: 'loopback' } : { video: picked })
  })
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(ICON))
  tray.setToolTip('Iskra')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Iskra', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit Iskra',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', showWindow)
}

/** IPC is only accepted from the app's own page. */
const fromApp = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => !!event.senderFrame && isAppUrl(event.senderFrame.url)

ipcMain.handle('iskra:set-ptt', (event, keycode: unknown) => {
  if (fromApp(event)) ptt.setKey(typeof keycode === 'number' ? keycode : null)
})
ipcMain.handle('iskra:capture-ptt-key', (event) => (fromApp(event) ? ptt.captureNextKey() : null))

// Hosting servers from the app.
ipcMain.handle('iskra:host-available', (event) => fromApp(event) && host.available())
ipcMain.handle('iskra:host-list', (event) => (fromApp(event) ? host.list() : []))
ipcMain.handle('iskra:host-create', (event, name: unknown, appUrl: unknown) => {
  if (!fromApp(event) || typeof name !== 'string' || typeof appUrl !== 'string' || !/^https?:\/\//.test(appUrl)) return null
  return host.create(name, appUrl)
})
ipcMain.handle('iskra:host-start', (event, id: unknown) => (fromApp(event) && typeof id === 'string' ? host.start(id) : null))
ipcMain.handle('iskra:host-stop', (event, id: unknown) => (fromApp(event) && typeof id === 'string' ? host.stop(id) : null))

app.whenReady().then(() => {
  setUpSession()
  createWindow()
  createTray()
  ptt.start()
  void host.startAll()
})

app.on('before-quit', () => {
  quitting = true
  ptt.stop()
  host.stopAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
