// The small window Iskra shows straight away while it starts, and while it restarts into an update (launch.ts decides
// what it says). A local page in its own in-memory session: no network, no preload, sandboxed.
import { app, BrowserWindow, session } from 'electron'
import type { SplashView } from './launch'

const WIDTH = 360
const HEIGHT = 250
const FADE_MS = 220
const FADE_STEPS = 10

export class Splash {
  private win: BrowserWindow | null = null
  private loaded = false
  private pending: (SplashView & { lang: string }) | null = null

  /** log: what happened, for the desktop e2e test (ISKRA_E2E only). */
  constructor(private readonly file: string, private readonly icon: string, private readonly log: (event: string) => void = () => undefined) {}

  get showing(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  /** Opens the window (or redraws it if it's open). It shows as soon as its first frame is painted. */
  show(view: SplashView, lang: string): void {
    if (this.showing) return this.update(view, lang)
    this.log(`view ${view.heading} | ${view.status}`)
    const ses = session.fromPartition('iskra-splash')
    ses.setPermissionRequestHandler((_c, _p, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
    const win = new BrowserWindow({
      width: WIDTH, height: HEIGHT, center: true, frame: false, resizable: false, maximizable: false, fullscreenable: false,
      show: false, title: view.heading, icon: this.icon, backgroundColor: '#0b0b14', hasShadow: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged },
    })
    this.win = win
    this.loaded = false
    this.pending = null
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.show()
      this.log('shown')
    })
    win.webContents.once('did-finish-load', () => {
      this.loaded = true
      if (this.pending) this.draw(this.pending)
      this.pending = null
    })
    win.on('closed', () => {
      this.log('closed')
      if (this.win === win) this.win = null
    })
    void win.loadFile(this.file, { hash: encodeURIComponent(JSON.stringify({ ...view, lang })) }).catch(() => undefined)
  }

  update(view: SplashView, lang: string): void {
    if (!this.showing) return
    this.log(`view ${view.heading} | ${view.status}`)
    if (this.loaded) this.draw({ ...view, lang })
    else this.pending = { ...view, lang }
  }

  focus(): void {
    if (!this.showing) return
    if (this.win!.isMinimized()) this.win!.restore()
    this.win!.focus()
  }

  /** Fades out over whatever just appeared behind it (Windows and macOS; Linux can't fade a window, so it just closes). */
  async fadeOut(): Promise<void> {
    const win = this.win
    if (!win || win.isDestroyed()) return
    this.win = null
    if (process.platform !== 'linux' && win.isVisible()) {
      win.setAlwaysOnTop(true)
      for (let i = 1; i <= FADE_STEPS && !win.isDestroyed(); i++) {
        await new Promise((resolve) => setTimeout(resolve, FADE_MS / FADE_STEPS))
        if (!win.isDestroyed()) win.setOpacity(1 - i / FADE_STEPS)
      }
    }
    if (!win.isDestroyed()) win.destroy()
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private draw(view: SplashView & { lang: string }): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.setTitle(view.heading)
    // The page's own function; the view is plain JSON and only ever becomes textContent there.
    void this.win.webContents.executeJavaScript(`window.splash(${JSON.stringify(view)})`, false).catch(() => undefined)
  }
}
