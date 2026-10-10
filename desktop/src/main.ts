// Iskra desktop: a thin, locked-down shell around the same web app.
// It adds what browsers can't do: push-to-talk while a game has focus, a screen/window picker,
// the tray, and a stable app:// origin for local storage.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, protocol, session, shell, systemPreferences, Tray } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Host } from './host'
import { isWayland, MAC_SETTINGS, skipScreenPicker, type SettingsPane } from './platform'
import { PushToTalk } from './ptt'
import { Updates, type UpdateStatus } from './updates'

const DEV_URL = process.env.ISKRA_DEV_URL // e.g. http://localhost:5173 while developing
const APP_ORIGIN = 'app://iskra'
const ASSETS = path.join(__dirname, '..', 'assets')
const MAC = process.platform === 'darwin'
const WAYLAND = isWayland(process.platform, process.env)
// .ico only works on Windows; macOS wants a monochrome "template" tray icon.
const ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
const TRAY_ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : MAC ? 'trayTemplate.png' : 'tray.png')
const CLIENT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'client') : path.join(__dirname, '..', '..', 'client', 'dist')

// Screen sharing on Wayland goes through PipeWire and the system's own picker.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const ptt = new PushToTalk((down) => window?.webContents.send('iskra:ptt', down))
const host = new Host()
const updates = new Updates((status: UpdateStatus) => window?.webContents.send('iskra:update', status))

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
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!isAppUrl(contents.getURL()) || !allowed.has(permission)) return callback(false)
    if (!MAC || permission !== 'media') return callback(true)
    // macOS asks the user once per app for the microphone and camera.
    const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    const asks = [
      ...(types.includes('audio') ? [systemPreferences.askForMediaAccess('microphone')] : []),
      ...(types.includes('video') ? [systemPreferences.askForMediaAccess('camera')] : []),
    ]
    void Promise.all(asks).then((granted) => callback(granted.every(Boolean)), () => callback(false))
  })
  appSession.setPermissionCheckHandler((contents, permission) => !!contents && isAppUrl(contents.getURL()) && allowed.has(permission))

  // Screen sharing: let the user pick a screen or window in our own picker.
  appSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
    if (MAC && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      void explainScreenPermission()
      return callback({})
    }
    if (skipScreenPicker(WAYLAND, sources.length)) return callback({ video: sources[0] })
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

/** macOS: screen sharing needs the Screen Recording permission, granted in System Settings. */
async function explainScreenPermission(): Promise<void> {
  if (!window) return
  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    message: 'Allow Iskra to share your screen',
    detail: 'Turn on Iskra under Privacy & Security → Screen & System Audio Recording in System Settings, then quit and reopen Iskra.',
    buttons: ['Open System Settings', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) void shell.openExternal(MAC_SETTINGS.screen)
}

/** macOS: the standard app menu, so Cmd+C/V/Q and friends work. */
function createMacMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
    ]),
  )
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
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

/**
 * The global key hook. macOS only allows it with the Accessibility permission, so there it starts
 * once a key is set, and the user is only asked when they pick one.
 */
let waitingForTrust: NodeJS.Timeout | null = null
function startPtt(prompt: boolean): boolean {
  if (MAC && !systemPreferences.isTrustedAccessibilityClient(prompt)) {
    // Start by itself once the user flips the switch in System Settings.
    waitingForTrust ??= setInterval(() => {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return
      clearInterval(waitingForTrust!)
      waitingForTrust = null
      ptt.start()
    }, 2000)
    return false
  }
  return ptt.start()
}

/** Wayland only lets us see keys pressed in X11 (XWayland) windows, hence "limited". */
function pttStatus(): 'ready' | 'needs-permission' | 'limited' | 'unavailable' {
  if (MAC && !systemPreferences.isTrustedAccessibilityClient(false)) return 'needs-permission'
  if (!ptt.running && !startPtt(false)) return 'unavailable'
  return WAYLAND ? 'limited' : 'ready'
}

ipcMain.handle('iskra:set-ptt', (event, keycode: unknown) => {
  if (!fromApp(event)) return
  const key = typeof keycode === 'number' ? keycode : null
  if (key !== null && !ptt.running) startPtt(false)
  ptt.setKey(key)
})
ipcMain.handle('iskra:capture-ptt-key', (event) => {
  if (!fromApp(event)) return null
  if (!ptt.running) startPtt(true)
  return ptt.captureNextKey()
})
ipcMain.handle('iskra:ptt-status', (event) => (fromApp(event) ? pttStatus() : 'unavailable'))
ipcMain.handle('iskra:open-settings', (event, pane: unknown) => {
  if (!fromApp(event) || !MAC || typeof pane !== 'string' || !Object.hasOwn(MAC_SETTINGS, pane)) return
  if (pane === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true) // puts Iskra in the list
  void shell.openExternal(MAC_SETTINGS[pane as SettingsPane])
})

// Updates.
ipcMain.handle('iskra:update-status', (event) => (fromApp(event) ? updates.current() : { state: 'none' }))
ipcMain.handle('iskra:update-restart', (event) => fromApp(event) && updates.restart(() => (quitting = true)))

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
  if (MAC) createMacMenu()
  createWindow()
  createTray()
  if (!MAC) ptt.start()
  void host.startAll()
  updates.start()
})

// macOS: clicking the Dock icon brings the window back.
app.on('activate', () => showWindow())

let serversStopped: Promise<void> | null = null
app.on('before-quit', () => {
  quitting = true
  ptt.stop()
  if (host.running()) serversStopped ??= host.stopAll()
})

// Give hosted servers a moment to shut down cleanly (they also stop by themselves once the app is gone).
let readyToQuit = false
app.on('will-quit', (event) => {
  if (readyToQuit || !serversStopped) return
  event.preventDefault()
  void serversStopped.finally(() => {
    readyToQuit = true
    setImmediate(() => app.quit())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
