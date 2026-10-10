// Iskra desktop: a thin, locked-down shell around the same web app.
// It adds what browsers can't do: push-to-talk while a game has focus, a screen/window picker,
// the tray, and a stable app:// origin for local storage.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, protocol, session, shell, systemPreferences, Tray } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Host } from './host'
import {
  aboutDetail, badgeText, DEEP_LINK_SCHEME, deepLinkFromArgv, isAppPage, isWayland, MAC_SETTINGS, parseDeepLink, parseDesktopSettings,
  skipScreenPicker, trayMenu, type DesktopSettings, type SettingsPane, type TrayAction,
} from './platform'
import { PushToTalk } from './ptt'
import { applyOpenAtLogin, loadDesktopSettings, saveDesktopSettings, startedHidden } from './settings'
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

// Desktop settings: hardware acceleration has to be turned off before the app is ready.
let settings: DesktopSettings = loadDesktopSettings()
if (!settings.hardwareAcceleration) app.disableHardwareAcceleration()

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const ptt = new PushToTalk((down) => window?.webContents.send('iskra:ptt', down))
const host = new Host()
const updates = new Updates((status: UpdateStatus) => {
  window?.webContents.send('iskra:update', status)
  updateTray()
})

if (!app.requestSingleInstanceLock()) app.quit()

// ── iskra:// invite links ────────────────────────────────────────────────
// Only an invite token ever gets through (parseDeepLink); the page then shows its usual "You're invited" prompt.
let pendingDeepLink: string | null = deepLinkFromArgv(process.argv)

function openDeepLink(token: string | null): void {
  if (!token) return
  showWindow()
  if (window && !window.webContents.isLoading()) window.webContents.send('iskra:deep-link', token)
  else pendingDeepLink = token
}

// Installed builds register the scheme (the installers do too); development builds never touch the system.
if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)

// Windows and Linux: a second launch (e.g. clicking a link) hands its command line to us, then quits.
app.on('second-instance', (_event, argv) => {
  showWindow()
  openDeepLink(deepLinkFromArgv(argv))
})
// macOS delivers links as events, possibly before the window exists.
app.on('open-url', (event, url) => {
  event.preventDefault()
  const token = parseDeepLink(url)
  if (window) openDeepLink(token)
  else if (token) pendingDeepLink = token
})

function showWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

const isAppUrl = (url: string) => isAppPage(url, APP_ORIGIN, DEV_URL)

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

  // Started with the computer: stay in the tray until opened.
  if (!startedHidden()) window.once('ready-to-show', () => window?.show())
  window.on('focus', () => window?.flashFrame(false))
  void window.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`)

  // Links open in the real browser; the app window never navigates away from the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  // Closing hides to the tray, like Discord (unless turned off); quit from the tray menu.
  window.on('close', (event) => {
    if (!quitting && settings.closeToTray) {
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

  // Only the permissions a chat app needs, and only for the app itself (never for frames inside it, like profile pages).
  const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!isAppUrl(contents.getURL()) || !isAppUrl(details.requestingUrl) || !allowed.has(permission)) return callback(false)
    if (!MAC || permission !== 'media') return callback(true)
    // macOS asks the user once per app for the microphone and camera.
    const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    const asks = [
      ...(types.includes('audio') ? [systemPreferences.askForMediaAccess('microphone')] : []),
      ...(types.includes('video') ? [systemPreferences.askForMediaAccess('camera')] : []),
    ]
    void Promise.all(asks).then((granted) => callback(granted.every(Boolean)), () => callback(false))
  })
  appSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    !!contents && isAppUrl(contents.getURL()) && isAppUrl(requestingOrigin + '/') && allowed.has(permission))

  // Screen sharing: let the user pick a screen or window in our own picker.
  appSession.setDisplayMediaRequestHandler(async (request, callback) => {
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
    // "Share audio": everything the computer plays ("loopback"), on Windows only; elsewhere it's ignored.
    callback(process.platform === 'win32' && request.audioRequested ? { video: picked, audio: 'loopback' } : { video: picked })
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

const WEBSITE = 'https://iskra.foo'
const LICENSE_URL = 'https://github.com/quikmn/iskra-voice/blob/main/LICENSE'
let checking = false

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
  tray.setToolTip('Iskra')
  updateTray()
  tray.on('click', showWindow)
}

/** The tray menu, rebuilt whenever the updater's state changes. */
function updateTray(): void {
  if (!tray) return
  const items = trayMenu(updates.current(), checking, updates.enabled)
  if (process.env.ISKRA_E2E) (globalThis as { iskraTrayMenu?: unknown }).iskraTrayMenu = items // for the desktop e2e test
  tray.setContextMenu(
    Menu.buildFromTemplate(items.map((item) =>
      item.action ? { label: item.label, enabled: item.enabled, click: () => void trayAction(item.action!) } : { type: 'separator' as const })),
  )
}

async function trayAction(action: TrayAction): Promise<void> {
  if (action === 'open') return showWindow()
  if (action === 'about') return showAbout()
  if (action === 'check') return checkForUpdates()
  if (action === 'restart') return void updates.restart(() => (quitting = true))
  if (action === 'download') {
    const status = updates.current()
    if (status.state === 'available' && status.url.startsWith('https://github.com/')) void shell.openExternal(status.url)
    return
  }
  quitting = true
  app.quit()
}

/** A small native About box: version, what Iskra is built on, and links. */
async function showAbout(): Promise<void> {
  const detail = aboutDetail(
    { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    process.platform,
    process.arch,
  )
  const options: Electron.MessageBoxOptions = {
    type: 'info', title: 'About Iskra', message: 'Iskra', detail, icon: nativeImage.createFromPath(path.join(ASSETS, 'icon.png')),
    buttons: ['OK', 'Website', 'License', 'Open source licenses'], defaultId: 0, cancelId: 0, noLink: true,
  }
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  if (response === 1) void shell.openExternal(WEBSITE)
  if (response === 2) void shell.openExternal(LICENSE_URL)
  if (response === 3) void openThirdPartyLicenses()
}

/** electron-builder ships Chromium's and Electron's notices next to the app. */
async function openThirdPartyLicenses(): Promise<void> {
  const dir = MAC ? path.join(process.resourcesPath, '..') : path.dirname(process.execPath)
  for (const file of ['LICENSES.chromium.html', 'LICENSE.electron.txt']) {
    const full = path.join(dir, file)
    if (existsSync(full)) {
      void shell.openPath(full)
      return
    }
  }
  void shell.openExternal('https://github.com/electron/electron/blob/main/LICENSE')
}

/** "Check for updates" from the tray: always says what it found. */
async function checkForUpdates(): Promise<void> {
  if (checking) return
  checking = true
  updateTray()
  const result = await updates.check().finally(() => {
    checking = false
    updateTray()
  })
  const status = updates.current()
  if (result === 'found' && status.state === 'ready') return void trayAction('restart')
  if (result === 'found' && status.state === 'available') return void trayAction('download')
  const message =
    result === 'found' ? `Iskra ${'version' in status ? status.version : ''} is downloading`
    : result === 'up-to-date' ? "You're up to date"
    : result === 'off' ? 'Updates are off in this build'
    : "Couldn't check for updates"
  const detail =
    result === 'found' ? "It installs in the background. When it's ready, choose Restart to update from this menu or the app."
    : result === 'up-to-date' ? `Iskra ${app.getVersion()} is the newest version.`
    : result === 'off' ? "Development builds don't update themselves."
    : 'Check your internet connection and try again.'
  const options: Electron.MessageBoxOptions = { type: 'info', title: 'Iskra updates', message, detail, buttons: ['OK'] }
  if (window) await dialog.showMessageBox(window, options)
  else await dialog.showMessageBox(options)
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

// Desktop settings.
ipcMain.handle('iskra:desktop-settings', (event) => (fromApp(event) ? settings : null))
ipcMain.handle('iskra:set-desktop-settings', (event, patch: unknown) => {
  if (!fromApp(event) || !patch || typeof patch !== 'object') return settings
  const next = parseDesktopSettings({ ...settings, ...patch })
  if (next.openAtLogin !== settings.openAtLogin) applyOpenAtLogin(next.openAtLogin)
  settings = next
  try {
    saveDesktopSettings(settings)
  } catch (error) {
    console.error('Saving settings:', error)
  }
  return settings
})
ipcMain.handle('iskra:relaunch', (event) => {
  if (!fromApp(event)) return
  quitting = true
  app.relaunch()
  app.quit()
})

// iskra:// links that arrived before the page was ready.
ipcMain.handle('iskra:take-deep-link', (event) => {
  if (!fromApp(event)) return null
  const token = pendingDeepLink
  pendingDeepLink = null
  return token
})

// Unread mentions and DMs on the taskbar / dock. Windows draws the count as an overlay icon the page renders.
ipcMain.handle('iskra:badge', (event, count: unknown, overlay: unknown) => {
  if (!fromApp(event) || !window || typeof count !== 'number' || !Number.isFinite(count)) return
  const n = Math.max(0, Math.min(9999, Math.floor(count)))
  if (MAC) app.dock?.setBadge(badgeText(n))
  else if (process.platform === 'linux') app.setBadgeCount(n) // Unity launchers and docks that support it
  else if (process.platform === 'win32') {
    const png = typeof overlay === 'string' && overlay.length < 20_000 && overlay.startsWith('data:image/png;base64,') ? nativeImage.createFromDataURL(overlay) : null
    window.setOverlayIcon(n > 0 && png && !png.isEmpty() ? png : null, n > 0 ? `${n} unread` : '')
  }
})
// A mention or DM while Iskra isn't focused: flash the taskbar (bounce the dock on macOS) until it is.
ipcMain.handle('iskra:attention', (event) => {
  if (!fromApp(event) || !window || window.isFocused()) return
  window.flashFrame(true)
})

// Updates.
ipcMain.handle('iskra:update-status', (event) => (fromApp(event) ? updates.current() : { state: 'none' }))
ipcMain.handle('iskra:update-restart', (event) => fromApp(event) && updates.restart(() => (quitting = true)))

// An incoming call: flash the taskbar and show the window if it's hidden in the tray, without stealing focus.
ipcMain.handle('iskra:call-alert', (event, on: unknown) => {
  if (!fromApp(event) || !window) return
  if (on === true) {
    if (!window.isVisible() || window.isMinimized()) window.showInactive()
    if (!window.isFocused()) window.flashFrame(true)
  } else {
    window.flashFrame(false)
  }
})

// Hosting servers from the app.
ipcMain.handle('iskra:host-available', (event) => fromApp(event) && host.available())
ipcMain.handle('iskra:host-list', (event) => (fromApp(event) ? host.list() : []))
ipcMain.handle('iskra:host-create', (event, name: unknown, appUrl: unknown) => {
  if (!fromApp(event) || typeof name !== 'string' || typeof appUrl !== 'string' || !/^https?:\/\//.test(appUrl)) return null
  return host.create(name, appUrl)
})
ipcMain.handle('iskra:host-start', (event, id: unknown) => (fromApp(event) && typeof id === 'string' ? host.start(id) : null))
ipcMain.handle('iskra:host-stop', (event, id: unknown) => (fromApp(event) && typeof id === 'string' ? host.stop(id) : null))

// Windows shows notifications (incoming calls, messages) under this id.
if (process.platform === 'win32') app.setAppUserModelId('foo.iskra.desktop')

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
