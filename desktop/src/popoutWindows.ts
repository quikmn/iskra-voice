// The pop-out windows themselves (see popouts.ts; the bug report is one too): made from the main page's window.open, remembered in
// userData/popouts.json, snapped to screen edges, kept on top or click-through when asked, and closed with the page.
import { app, screen, shell, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  areaFor, isPopoutPage, MAX_POPOUTS, onTopLevel, openBounds, parsePopoutName, parsePopoutState, popoutWindowOptions, snapBounds,
  type PopoutKind, type PopoutPatch, type PopoutState,
} from './popouts'

interface Open {
  win: BrowserWindow
  kind: PopoutKind
  clickThrough: boolean
}

export interface PopoutFlags {
  alwaysOnTop: boolean
  clickThrough: boolean
}

export class PopoutWindows {
  private readonly open = new Map<string, Open>()
  private state: PopoutState | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private opener: WebContents | null = null

  /** `testRun`: e2e runs place windows themselves (off-screen), so positions are neither restored, snapped nor saved. */
  constructor(
    private readonly isAppUrl: (url: string) => boolean,
    private readonly base: { icon: string; backgroundColor: string; preload: string; spellcheck: boolean },
    private readonly testRun: boolean,
  ) {}

  private file = () => path.join(app.getPath('userData'), 'popouts.json')

  private prefs(): PopoutState {
    if (!this.state) {
      try {
        this.state = parsePopoutState(JSON.parse(readFileSync(this.file(), 'utf8')))
      } catch {
        this.state = parsePopoutState(null)
      }
    }
    return this.state
  }

  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        const target = this.file()
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target + '.tmp', JSON.stringify(this.prefs(), null, 2))
        renameSync(target + '.tmp', target)
      } catch (error) {
        console.error('Saving pop-outs:', error)
      }
    }, 400)
  }

  /** The window options for a window.open from the main page, or null when it isn't a pop-out we make. */
  options(url: string, frameName: string): BrowserWindowConstructorOptions | null {
    const parsed = parsePopoutName(frameName)
    if (!parsed || !isPopoutPage(url, this.isAppUrl) || this.open.has(parsed.name) || this.open.size >= MAX_POPOUTS) return null
    const prefs = this.prefs()[parsed.kind]
    const areas = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea)
    return popoutWindowOptions(parsed.kind, prefs, openBounds(parsed.kind, prefs.bounds, areas), this.base)
  }

  /** The window Electron made for it (did-create-window). */
  adopt(win: BrowserWindow, frameName: string): void {
    const parsed = parsePopoutName(frameName)
    if (!parsed || this.open.has(parsed.name)) {
      win.destroy()
      return
    }
    const entry: Open = { win, kind: parsed.kind, clickThrough: false }
    this.open.set(parsed.name, entry)
    this.throttleOpener()
    const contents = win.webContents
    // The page inside has no scripts and never goes anywhere else; links in it open in the browser.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // (Its first load, popout.html, is a navigation too.)
    contents.on('will-navigate', (event, url) => !isPopoutPage(url, this.isAppUrl) && event.preventDefault())
    if (this.prefs()[parsed.kind].alwaysOnTop) win.setAlwaysOnTop(true, onTopLevel(process.platform))
    win.once('ready-to-show', () => !win.isDestroyed() && win.showInactive())
    const remember = () => {
      if (win.isDestroyed()) return
      const prefs = this.prefs()[parsed.kind]
      const bounds = win.getBounds()
      // Test windows sit off-screen: only their size is worth remembering.
      prefs.bounds = this.testRun ? { x: 0, y: 0, width: bounds.width, height: bounds.height } : bounds
      this.saveSoon()
    }
    // Let go of it near an edge: snap. (Linux has no "moved", only "move": wait for it to stop.)
    let settle: NodeJS.Timeout | null = null
    const snap = () => {
      if (win.isDestroyed() || this.testRun) return remember()
      const bounds = win.getBounds()
      const snapped = snapBounds(bounds, areaFor(bounds, screen.getAllDisplays().map((d) => d.workArea)))
      if (snapped.x !== bounds.x || snapped.y !== bounds.y) win.setBounds(snapped)
      remember()
    }
    if (process.platform === 'linux') {
      win.on('move', () => {
        if (settle) clearTimeout(settle)
        settle = setTimeout(snap, 300)
      })
    } else {
      win.on('moved', snap)
    }
    win.on('resize', remember)
    win.on('closed', () => {
      if (settle) clearTimeout(settle)
      if (this.open.get(parsed.name)?.win === win) this.open.delete(parsed.name)
      this.throttleOpener()
    })
  }

  /** Always on top (remembered per kind) and click-through (never remembered: it's off each time a pop-out opens). */
  set(name: unknown, patch: PopoutPatch): PopoutFlags | null {
    const entry = typeof name === 'string' ? this.open.get(name) : undefined
    if (!entry || entry.win.isDestroyed()) return null
    const { win } = entry
    if (patch.alwaysOnTop !== undefined) {
      win.setAlwaysOnTop(patch.alwaysOnTop, onTopLevel(process.platform))
      this.prefs()[entry.kind].alwaysOnTop = patch.alwaysOnTop
      this.saveSoon()
    }
    if (patch.clickThrough !== undefined && entry.kind === 'voice') {
      entry.clickThrough = patch.clickThrough
      // Clicks fall through to the game below; the pointer still moves over the page, so its handle can wake it.
      win.setIgnoreMouseEvents(patch.clickThrough, { forward: true })
    }
    if (patch.handle !== undefined && entry.clickThrough) {
      win.setIgnoreMouseEvents(!patch.handle, { forward: true })
    }
    if (patch.focus) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    return { alwaysOnTop: win.isAlwaysOnTop(), clickThrough: entry.clickThrough }
  }

  /** A pop-out's page, for a bug report screenshot (capture.ts): never the report window itself. */
  contents(name: string): WebContents | null {
    const entry = this.open.get(name)
    return entry && entry.kind !== 'report' && !entry.win.isDestroyed() ? entry.win.webContents : null
  }

  /** The main page went away (reloaded, navigated, closed): its pop-outs go with it. */
  closeAll(): void {
    for (const { win } of this.open.values()) if (!win.isDestroyed()) win.close()
    this.open.clear()
  }

  /**
   * The main page renders every pop-out, so it keeps its timers at full speed while one is open, even when the main
   * window is hidden or minimised (e2e runs never throttle anything: testMode.ts).
   */
  private throttleOpener(): void {
    if (this.opener && !this.opener.isDestroyed() && !this.testRun) this.opener.setBackgroundThrottling(this.open.size === 0)
  }

  /** Watches the page that opens pop-outs. */
  watch(page: WebContents): void {
    this.opener = page
    page.on('did-start-navigation', (details) => details.isMainFrame && !details.isSameDocument && this.closeAll())
    page.on('render-process-gone', () => this.closeAll())
    page.once('destroyed', () => this.closeAll())
  }

  /** For the desktop e2e test. */
  debug(): { name: string; kind: PopoutKind; alwaysOnTop: boolean; clickThrough: boolean; bounds: { width: number; height: number } }[] {
    return [...this.open.entries()].filter(([, e]) => !e.win.isDestroyed()).map(([name, e]) => {
      const { width, height } = e.win.getBounds()
      return { name, kind: e.kind, alwaysOnTop: e.win.isAlwaysOnTop(), clickThrough: e.clickThrough, bounds: { width, height } }
    })
  }
}
