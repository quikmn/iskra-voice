// Iskra desktop: a thin, locked-down shell around the same web app.
// It adds what browsers can't do: push-to-talk while a game has focus, a screen/window picker,
// the tray, and a stable app:// origin for local storage.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, safeStorage, session, shell, systemPreferences, Tray } from 'electron'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { APP_ORIGIN, configureAppSession, registerAppScheme } from './appSession'
import { Host, isTemplateId, type HostedServer } from './host'
import { parseHotkeys } from './hotkeys'
import { isBackupDownload, readBackupInfo } from './restore'
import { SaveStreams, suggestedName } from './saveStreams'
import {
  aboutDetail, badgeText, DEEP_LINK_SCHEME, deepLinkFromArgv, isAppPage, isWayland, MAC_SETTINGS, parseDeepLink, parseDesktopSettings,
  keychainKind, serversToStart, setKeepRunning, skipScreenPicker, spellcheckDownloadsDictionaries, trayMenu, type DesktopSettings, type SettingsPane, type TrayAction,
} from './platform'
import { allowPageViews } from './pages'
import { PushToTalk } from './ptt'
import { ActivityDetector } from './activity'
import { applyOpenAtLogin, loadDesktopSettings, saveDesktopSettings, startedHidden } from './settings'
import { Updates, type UpdateStatus } from './updates'
import { applyChromiumPrivacy, applySessionPrivacy } from './privacy'
import { desktopLanguage, languageFromLocales, parseLanguage, setDesktopLanguage, text } from './i18n'
import { initialLaunch, readyToShow, SERVER_WAIT_MS, splashView, updatedTo, updatingView, type LaunchState } from './launch'
import { Splash } from './splash'
import { ceremonyScript, parseCreate, parseGet, PASSKEY_ORIGIN, PASSKEY_PAGE, passkeyPage, type CreateRequest, type GetRequest } from './passkeys'

/** Chromium's media::AudioDeviceDescription::kLoopbackWithoutChromeId: system audio minus this app's own. */
const LOOPBACK_WITHOUT_ISKRA = 'loopbackWithoutChrome'
const DEV_URL = process.env.ISKRA_DEV_URL // e.g. http://localhost:5173 while developing
const ASSETS = path.join(__dirname, '..', 'assets')
const MAC = process.platform === 'darwin'
const WAYLAND = isWayland(process.platform, process.env)
// .ico only works on Windows; macOS wants a monochrome "template" tray icon.
const ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
const TRAY_ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : MAC ? 'trayTemplate.png' : 'tray.png')
const CLIENT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'client') : path.join(__dirname, '..', '..', 'client', 'dist')

// Screen sharing on Wayland goes through PipeWire and the system's own picker.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')

// No Chromium background connections (privacy.ts).
applyChromiumPrivacy(app)

// Desktop settings: hardware acceleration has to be turned off before the app is ready.
let settings: DesktopSettings = loadDesktopSettings()
if (!settings.hardwareAcceleration) app.disableHardwareAcceleration()

registerAppScheme()

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
/** Quitting to start again (an update, a relaunch): hosted servers say "restarting" rather than "stopped". */
let restarting = false
// Mute/deafen hotkeys: only the action's name reaches the page, never which keys were pressed.
const ptt = new PushToTalk((down) => window?.webContents.send('iskra:ptt', down), (action) => window?.webContents.send('iskra:hotkey', action))
const host = new Host()
// "Playing X": only the matched game's name ever reaches the page.
const activity = new ActivityDetector((game) => window?.webContents.send('iskra:activity', game))
const updates = new Updates((status: UpdateStatus) => {
  window?.webContents.send('iskra:update', status)
  updateTray()
})

// A second launch (e.g. an iskra:// link) hands over to this one and quits before showing anything.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

// ── Starting up: the splash window ───────────────────────────────────────
// Shown at once on every start (not when started hidden in the tray), then fades into the main window once its page
// is painted and the hosted servers starting with it are up (or we stopped waiting for them).
/** For the desktop e2e test: what the splash and the main window did, in order. */
const launchLog = (event: string) => {
  if (process.env.ISKRA_E2E) ((globalThis as { iskraLaunchLog?: string[] }).iskraLaunchLog ??= []).push(event)
}
const splash = new Splash(path.join(ASSETS, 'splash.html'), ICON, (event) => launchLog(`splash ${event}`))
/** Non-null while the splash is up and the main window waits. */
let launch: LaunchState | null = null
/** "Updated to X" on the splash, once after an update. */
let updatedVersion: string | null = null
const LAUNCH_GIVE_UP_MS = 30_000

function launchChanged(next: Partial<LaunchState>): void {
  if (!launch) return
  launch = { ...launch, ...next }
  if (readyToShow(launch)) return void finishLaunch()
  if (!updatingTo) splash.update(splashView(launch, updatedVersion, text().splash), desktopLanguage())
}

/** The bar fills, the main window appears, and the splash fades out on top of it. */
function finishLaunch(): void {
  if (!launch) return
  splash.update(splashView({ ...launch, page: 'ready', serversGaveUp: true }, updatedVersion, text().splash), desktopLanguage())
  launch = null
  setTimeout(() => {
    void splash.fadeOut()
    if (!window) return
    window.show()
    window.focus()
    launchLog('main shown')
  }, 150)
}

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
  // Still starting: the window shows by itself in a moment.
  if (launch) return splash.focus()
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
      // The system's spellchecker (Windows, macOS); Linux would download dictionaries from Google, so none there.
      spellcheck: !spellcheckDownloadsDictionaries(process.platform),
      // Only for profile pages, each locked in its own session (pages.ts).
      webviewTag: true,
    },
  })
  allowPageViews(window, isAppUrl)

  // Started with the computer: stay in the tray until opened. Otherwise the splash shows it when everything's ready.
  window.webContents.once('dom-ready', () => launch?.page === 'loading' && launchChanged({ page: 'loaded' }))
  window.once('ready-to-show', () => launchChanged({ page: 'ready' }))
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

  // app://iskra/, and what YouTube and Twitch embeds need to play there.
  configureAppSession(appSession, CLIENT_DIR, isAppUrl)

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
    // "Share audio" (Windows): everything the computer plays except Iskra itself, so friends never hear their own
    // voices back. Electron passes this Chromium loopback device id straight through (its docs only list
    // 'loopback'); the page also asks for restrictOwnAudio. Both measured in e2e/desktop-audio.spec.ts.
    callback(process.platform === 'win32' && request.audioRequested ? { video: picked, audio: LOOPBACK_WITHOUT_ISKRA as string as 'loopback' } : { video: picked })
  })
}

/** macOS: screen sharing needs the Screen Recording permission, granted in System Settings. */
async function explainScreenPermission(): Promise<void> {
  if (!window) return
  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    message: text().screen.message,
    detail: text().screen.detail,
    buttons: [text().screen.open, text().screen.notNow],
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
        label: text().menu.view,
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
  const items = trayMenu(updates.current(), checking, updates.enabled, text())
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
  if (action === 'restart') return void restartToUpdate()
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
    text(),
  )
  const options: Electron.MessageBoxOptions = {
    type: 'info', title: text().about.title, message: 'Iskra', detail, icon: nativeImage.createFromPath(path.join(ASSETS, 'icon.png')),
    buttons: [...text().about.buttons], defaultId: 0, cancelId: 0, noLink: true,
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
  const t = text().updates
  const message =
    result === 'found' ? t.downloading('version' in status ? status.version : '')
    : result === 'up-to-date' ? t.upToDate
    : result === 'off' ? t.off
    : t.failed
  const detail =
    result === 'found' ? t.downloadingDetail
    : result === 'up-to-date' ? t.upToDateDetail(app.getVersion())
    : result === 'off' ? t.offDetail
    : t.failedDetail
  const options: Electron.MessageBoxOptions = { type: 'info', title: t.title, message, detail, buttons: [t.ok] }
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
ipcMain.handle('iskra:set-hotkeys', (event, binds: unknown) => {
  if (!fromApp(event)) return
  ptt.setHotkeys(parseHotkeys(binds))
  if (ptt.hasHotkeys && !ptt.running) startPtt(false)
})
ipcMain.handle('iskra:capture-hotkey', (event) => {
  if (!fromApp(event)) return null
  if (!ptt.running) startPtt(true)
  return ptt.captureNextHotkey(process.platform)
})
ipcMain.handle('iskra:cancel-hotkey-capture', (event) => {
  if (fromApp(event)) ptt.cancelCapture()
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
  const next = parseDesktopSettings({ ...settings, ...patch, lastRunVersion: settings.lastRunVersion })
  if (next.openAtLogin !== settings.openAtLogin) applyOpenAtLogin(next.openAtLogin)
  const activityChanged = next.activity !== settings.activity || JSON.stringify(next.customGames) !== JSON.stringify(settings.customGames)
  const checksChanged = next.updateChecks !== settings.updateChecks
  settings = next
  if (activityChanged) activity.configure(settings.activity, settings.customGames)
  if (checksChanged) updates.setAutomatic(settings.updateChecks)
  try {
    saveDesktopSettings(settings)
  } catch (error) {
    console.error('Saving settings:', error)
  }
  return settings
})
// The page's language (its picker, or the system's), so the tray and dialogs match it, also on the next start.
ipcMain.handle('iskra:set-language', (event, value: unknown) => {
  const language = parseLanguage(value)
  if (!fromApp(event) || !language) return
  setDesktopLanguage(language)
  updateTray()
  if (language === settings.language) return
  settings = { ...settings, language }
  try {
    saveDesktopSettings(settings)
  } catch (error) {
    console.error('Saving settings:', error)
  }
})
ipcMain.handle('iskra:relaunch', (event) => {
  if (!fromApp(event)) return
  quitting = restarting = true
  app.relaunch()
  app.quit()
})

ipcMain.handle('iskra:activity', (event) => (fromApp(event) ? activity.game : null))

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
ipcMain.handle('iskra:update-restart', (event) => fromApp(event) && restartToUpdate())

/**
 * Every "Restart to update" (tray, the app's notice) comes here. First a moment of "Updating Iskra to X…": over the app
 * if it's on screen, else in the splash window. Then the installer takes over and starts the new version, whose splash
 * says "Updated to X".
 */
const UPDATE_NOTICE_MS = 1200
let updatingTo: string | null = null
async function restartToUpdate(): Promise<boolean> {
  const status = updates.current()
  if (status.state !== 'ready') return false
  if (updatingTo) return true
  updatingTo = status.version
  const view = updatingView(status.version, text().splash)
  if (!launch && window?.isVisible() && !window.isMinimized()) {
    showWindow()
    window.webContents.send('iskra:updating', status.version)
  } else {
    splash.show(view, desktopLanguage())
  }
  await new Promise((resolve) => setTimeout(resolve, UPDATE_NOTICE_MS))
  if (updates.restart(() => (quitting = restarting = true))) return true
  updatingTo = null
  window?.webContents.send('iskra:updating', null)
  if (!launch) splash.close()
  return false
}

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

// The OS keychain protects the key that encrypts Iskra's stored keys (see client/src/core/vault.ts).
// Only the app page may use it, and only for small blobs.
const keychain = () =>
  keychainKind(process.platform, safeStorage.isEncryptionAvailable(), process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null, process.env)
const smallB64 = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9_-]*$/.test(value)
ipcMain.handle('iskra:keychain-status', (event) => (fromApp(event) ? keychain() : 'unavailable'))
ipcMain.handle('iskra:keychain-encrypt', (event, data: unknown) => {
  if (!fromApp(event) || !smallB64(data) || keychain() !== 'keyring') return null
  return safeStorage.encryptString(data).toString('base64url')
})
ipcMain.handle('iskra:keychain-decrypt', (event, data: unknown) => {
  if (!fromApp(event) || !smallB64(data) || keychain() !== 'keyring') return null
  try {
    return safeStorage.decryptString(Buffer.from(data, 'base64url'))
  } catch {
    return null
  }
})

// Passkeys for the app lock: the ceremony runs in a small window on https://app.iskra.foo (see passkeys.ts).
let passkeyBusy = false
function runPasskey(op: 'create' | 'get', request: CreateRequest | GetRequest): Promise<unknown> {
  // In memory only, and it never reaches the network: every https request gets the one local page (or a 404).
  const ses = session.fromPartition('iskra-passkeys')
  if (!ses.protocol.isProtocolHandled('https')) {
    ses.protocol.handle('https', (req) => req.url === PASSKEY_PAGE
      ? new Response(passkeyPage(text().passkey.title, text().passkey.waiting), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      : new Response('', { status: 404 }))
    ses.setPermissionRequestHandler((_c, _p, callback) => callback(false))
    applySessionPrivacy(ses)
  }
  const ceremony = new BrowserWindow({
    parent: window ?? undefined, modal: !!window, width: 380, height: 180, resizable: false, minimizable: false, maximizable: false,
    title: text().passkey.title, icon: ICON, backgroundColor: '#0B0B14', autoHideMenuBar: true, show: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged },
  })
  ceremony.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  ceremony.webContents.on('will-navigate', (e) => e.preventDefault())
  return new Promise((resolve) => {
    let done = false
    const finish = (result: unknown) => {
      if (done) return
      done = true
      resolve(result)
      if (!ceremony.isDestroyed()) ceremony.destroy()
    }
    ceremony.on('closed', () => finish({ ok: false, name: 'NotAllowedError', message: 'Closed' }))
    ceremony.once('ready-to-show', () => {
      ceremony.show()
      ceremony.focus()
      ceremony.webContents.executeJavaScript(ceremonyScript(op, request), true).then(finish, () => finish({ ok: false, name: 'Error', message: 'Failed' }))
    })
    void ceremony.loadURL(PASSKEY_PAGE).catch(() => finish({ ok: false, name: 'NotSupportedError', message: `Couldn't open ${PASSKEY_ORIGIN}` }))
  })
}
ipcMain.handle('iskra:passkey', async (event, op: unknown, raw: unknown) => {
  if (!fromApp(event) || passkeyBusy) return { ok: false, name: 'NotAllowedError', message: 'Busy' }
  const request = op === 'create' ? parseCreate(raw) : op === 'get' ? parseGet(raw) : null
  if (!request) return { ok: false, name: 'NotSupportedError', message: 'Bad request' }
  passkeyBusy = true
  try {
    return await runPasskey(op as 'create' | 'get', request)
  } finally {
    passkeyBusy = false
  }
})

// Hosting servers from the app.
ipcMain.handle('iskra:host-available', (event) => fromApp(event) && host.available())
const withKeep = (server: HostedServer): HostedServer => ({ ...server, keepRunning: settings.openAtLogin && settings.keepRunning.includes(server.id) })
ipcMain.handle('iskra:host-list', (event) => (fromApp(event) ? host.list().map(withKeep) : []))
ipcMain.handle('iskra:host-templates', (event) => (fromApp(event) ? host.templates() : []))
ipcMain.handle('iskra:host-create', async (event, name: unknown, appUrl: unknown, template: unknown) => {
  if (!fromApp(event) || typeof name !== 'string' || typeof appUrl !== 'string' || !/^https?:\/\//.test(appUrl)) return null
  return withKeep(await host.create(name, appUrl, isTemplateId(template) ? template : null))
})
ipcMain.handle('iskra:host-start', async (event, id: unknown) => (fromApp(event) && typeof id === 'string' ? withKeep(await host.start(id)) : null))
ipcMain.handle('iskra:host-stop', async (event, id: unknown) => (fromApp(event) && typeof id === 'string' ? withKeep(await host.stop(id)) : null))
// "Keep my server running": Iskra starts with the computer, hidden in the tray, and starts this server.
ipcMain.handle('iskra:host-keep-running', (event, id: unknown, on: unknown) => {
  if (!fromApp(event) || typeof id !== 'string' || typeof on !== 'boolean') return null
  const server = host.list().find((s) => s.id === id)
  if (!server) return null
  const next = setKeepRunning(settings, id, on)
  if (next.openAtLogin !== settings.openAtLogin) applyOpenAtLogin(next.openAtLogin)
  settings = next
  try {
    saveDesktopSettings(settings)
  } catch (error) {
    console.error('Saving settings:', error)
  }
  return withKeep(server)
})

// Restoring a server from a backup: the file comes from our own open dialog, never a path the page makes up.
const pickedBackups = new Map<string, string | null>()
ipcMain.handle('iskra:host-pick-backup', async (event) => {
  if (!fromApp(event) || !window) return null
  const picked = await dialog.showOpenDialog(window, {
    title: text().backup.pickTitle,
    properties: ['openFile'],
    filters: [{ name: text().backup.filter, extensions: ['iskrabackup', 'zip'] }],
  })
  const file = picked.filePaths[0]
  if (picked.canceled || !file) return null
  const head = Buffer.alloc(4108)
  const fd = openSync(file, 'r')
  let read = 0
  try {
    read = readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  const info = readBackupInfo(head.subarray(0, read))
  if (!info) throw new Error(text().backup.notBackup)
  pickedBackups.set(file, info.name)
  return { path: file, fileName: path.basename(file), name: info.name, encrypted: info.encrypted }
})
ipcMain.handle('iskra:host-restore', (event, file: unknown, passphrase: unknown) => {
  if (!fromApp(event) || typeof file !== 'string' || !pickedBackups.has(file) || typeof passphrase !== 'string' || passphrase.length > 1024) return null
  return host.restore(file, passphrase, pickedBackups.get(file) ?? null)
})
// Saving a backup someone just made: only /backup/<token> links, with the usual "Save as" dialog.
ipcMain.handle('iskra:download', (event, url: unknown) => {
  if (!fromApp(event) || !isBackupDownload(url)) return false
  event.sender.downloadURL(url)
  return true
})

// Saving a big decrypted DM file: our own Save dialog picks the path; the page streams the bytes and says when they're checked.
const saves = new SaveStreams()
const watchedPages = new Set<number>()
ipcMain.handle('iskra:save-begin', async (event, name: unknown) => {
  if (!fromApp(event) || !window) return null
  const picked = await dialog.showSaveDialog(window, { defaultPath: path.join(app.getPath('downloads'), suggestedName(name)) })
  if (picked.canceled || !picked.filePath) return null
  const owner = event.sender.id
  if (!watchedPages.has(owner)) {
    watchedPages.add(owner)
    const drop = () => void saves.abortAll(owner)
    event.sender.on('did-start-navigation', (details) => details.isMainFrame && !details.isSameDocument && drop())
    event.sender.once('destroyed', () => {
      watchedPages.delete(owner)
      drop()
    })
  }
  return saves.begin(picked.filePath, owner)
})
ipcMain.handle('iskra:save-write', (event, id: unknown, data: unknown) => fromApp(event) && saves.write(id, data, event.sender.id))
ipcMain.handle('iskra:save-finish', (event, id: unknown) => fromApp(event) && saves.finish(id, event.sender.id))
ipcMain.handle('iskra:save-abort', (event, id: unknown) => (fromApp(event) ? saves.abort(id, event.sender.id) : undefined))

// Windows shows notifications (incoming calls, messages) under this id.
if (process.platform === 'win32') app.setAppUserModelId('foo.iskra.desktop')

app.whenReady().then(() => {
  if (!primaryInstance) return
  // Until the page says otherwise: the OS's language.
  setDesktopLanguage(settings.language ?? languageFromLocales(app.getPreferredSystemLanguages()))
  const hidden = startedHidden()
  // The splash first, before anything slow. Remember this version for next time ("Updated to X" once).
  updatedVersion = updatedTo(settings.lastRunVersion, app.getVersion())
  if (!hidden) {
    launch = initialLaunch(0)
    splash.show(splashView(launch, updatedVersion, text().splash), desktopLanguage())
  }
  if (settings.lastRunVersion !== app.getVersion()) {
    settings = { ...settings, lastRunVersion: app.getVersion() }
    try {
      saveDesktopSettings(settings)
    } catch (error) {
      console.error('Saving settings:', error)
    }
  }
  setUpSession()
  applySessionPrivacy(session.defaultSession)
  if (MAC) createMacMenu()
  createWindow()
  createTray()
  if (!MAC) ptt.start()
  // Started with the computer: only the servers kept running. Opened by hand: all of them, as before.
  const servers = serversToStart(host.list().map((s) => s.id), settings, hidden)
  launchChanged({ servers: { total: servers.length, done: 0 } })
  for (const id of servers) {
    void host.start(id).catch(() => undefined).finally(() => launch && launchChanged({ servers: { ...launch.servers, done: launch.servers.done + 1 } }))
  }
  if (servers.length > 0) setTimeout(() => launchChanged({ serversGaveUp: true }), SERVER_WAIT_MS)
  // A page that never paints still shows (with whatever it has) rather than leaving only the splash.
  setTimeout(() => launchChanged({ page: 'ready', serversGaveUp: true }), LAUNCH_GIVE_UP_MS)
  updates.start(settings.updateChecks)
  activity.configure(settings.activity, settings.customGames)
})

// macOS: clicking the Dock icon brings the window back.
app.on('activate', () => showWindow())

let serversStopped: Promise<void> | null = null
app.on('before-quit', () => {
  quitting = true
  ptt.stop()
  // Restarting (an update, a relaunch): hosted servers tell members "restarting", since they're back in a moment.
  if (host.running()) serversStopped ??= host.stopAll(restarting)
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
