// Pop-out windows (the voice panel, a stream, a text channel, the bug report): which window.open requests become one, where they
// open, what they remember, and snapping to the screen's edges. No Electron here, so it's unit-tested.
// Each pop-out is the app's own page (popout.html, no scripts) that the main page renders into: one app, one
// connection, one media pipeline.

export type PopoutKind = 'voice' | 'stream' | 'chat' | 'report'
export const POPOUT_KINDS: readonly PopoutKind[] = ['voice', 'stream', 'chat', 'report']

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What's remembered per kind: where it was and whether it stays on top. */
export interface PopoutPrefs {
  bounds: Rect | null
  alwaysOnTop: boolean
}
export type PopoutState = Record<PopoutKind, PopoutPrefs>

export const DEFAULT_SIZE: Record<PopoutKind, { width: number; height: number }> = {
  voice: { width: 280, height: 340 },
  stream: { width: 480, height: 300 },
  chat: { width: 380, height: 560 },
  report: { width: 440, height: 680 },
}
/**
 * Voice and streams float over games by default; a text channel is an ordinary window. The bug report stays on top
 * while you use the app to show the bug.
 */
const DEFAULT_ON_TOP: Record<PopoutKind, boolean> = { voice: true, stream: true, chat: false, report: true }
export const MIN_SIZE = { width: 200, height: 120 }
/** The bug report's form needs room; the others can be small. */
export const minSizeFor = (kind: PopoutKind): { width: number; height: number } => (kind === 'report' ? { width: 420, height: 560 } : MIN_SIZE)
const MAX_SIZE = 8192
/** At most this many pop-outs at once. */
export const MAX_POPOUTS = 6
/** Let go this close to a screen edge and the window snaps to it (corners are two edges). */
export const SNAP_DISTANCE = 24
/** A remembered spot is used only if this much of the window is still on a screen. */
const MIN_VISIBLE = { width: 80, height: 48 }
/** New windows keep this gap from the screen's corner. */
const MARGIN = 16

export const POPOUT_PATH = '/popout.html'

/** window.open's frame name: iskra-popout-<kind>-<id>. Anything else is not a pop-out. */
export function parsePopoutName(name: unknown): { kind: PopoutKind; name: string } | null {
  if (typeof name !== 'string') return null
  const m = /^iskra-popout-(voice|stream|chat|report)-([a-z0-9]{1,24})$/.exec(name)
  return m ? { kind: m[1] as PopoutKind, name } : null
}

/** Only the app's own popout.html (no query, no credentials) may open as a pop-out. */
export function isPopoutPage(url: string, isAppUrl: (url: string) => boolean): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return isAppUrl(url) && parsed.pathname === POPOUT_PATH && !parsed.search && !parsed.username && !parsed.password
}

const isRect = (r: unknown): r is Rect => {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k] as number) && Math.abs(o[k] as number) < 100_000)
}

const clampSize = (n: number, min: number) => Math.round(Math.max(min, Math.min(MAX_SIZE, n)))

/** popouts.json, checked (it's a file on disk; anything odd falls back to the defaults). */
export function parsePopoutState(raw: unknown): PopoutState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const state = {} as PopoutState
  for (const kind of POPOUT_KINDS) {
    const p = (o[kind] && typeof o[kind] === 'object' ? o[kind] : {}) as Record<string, unknown>
    const min = minSizeFor(kind)
    const bounds = isRect(p.bounds)
      ? { x: Math.round(p.bounds.x), y: Math.round(p.bounds.y), width: clampSize(p.bounds.width, min.width), height: clampSize(p.bounds.height, min.height) }
      : null
    state[kind] = { bounds, alwaysOnTop: typeof p.alwaysOnTop === 'boolean' ? p.alwaysOnTop : DEFAULT_ON_TOP[kind] }
  }
  return state
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  }
}

/** The screen (work area) the window is mostly on; the first one if it's on none. */
export function areaFor(bounds: Rect, areas: Rect[]): Rect {
  let best = areas[0]
  let most = -1
  for (const area of areas) {
    const o = overlap(bounds, area)
    if (o.width * o.height > most) {
      most = o.width * o.height
      best = area
    }
  }
  return best
}

/**
 * Where a pop-out opens: where it was last time if that's still on a screen (monitors come and go), else its usual
 * size in the bottom-right corner of the main screen. `areas[0]` is the main screen's work area.
 */
export function openBounds(kind: PopoutKind, saved: Rect | null, areas: Rect[]): Rect {
  if (saved && areas.some((a) => {
    const o = overlap(saved, a)
    return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height
  })) {
    const area = areaFor(saved, areas)
    // Never bigger than the screen it's on.
    return { ...saved, width: Math.min(saved.width, area.width), height: Math.min(saved.height, area.height) }
  }
  const size = saved ? { width: saved.width, height: saved.height } : DEFAULT_SIZE[kind]
  const area = areas[0] ?? { x: 0, y: 0, width: 1280, height: 720 }
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return { x: Math.max(area.x, area.x + area.width - width - MARGIN), y: Math.max(area.y, area.y + area.height - height - MARGIN), width, height }
}

/** Let go near an edge of the screen: flush against it. Near two edges: in the corner. */
export function snapBounds(bounds: Rect, area: Rect, distance = SNAP_DISTANCE): Rect {
  let { x, y } = bounds
  const right = area.x + area.width - bounds.width
  const bottom = area.y + area.height - bounds.height
  if (Math.abs(x - area.x) <= distance) x = area.x
  else if (Math.abs(x - right) <= distance) x = right
  if (Math.abs(y - area.y) <= distance) y = area.y
  else if (Math.abs(y - bottom) <= distance) y = bottom
  return { ...bounds, x, y }
}

/** A change the page asks for: always on top, click-through, the pointer over the click-through handle, or focus. */
/**
 * The always-on-top level. Electron's default, "floating", goes just below the taskbar on Windows, and a window put
 * below a taskbar that isn't topmost at that moment (a full-screen game or video in front of it) isn't on top at all:
 * the e2e check saw isAlwaysOnTop() false on this PC now and then. "pop-up-menu" is above the taskbar and stays on top.
 * Elsewhere "floating" (macOS: below the Dock; Linux has no levels).
 */
export function onTopLevel(platform: NodeJS.Platform): 'pop-up-menu' | 'floating' {
  return platform === 'win32' ? 'pop-up-menu' : 'floating'
}

export interface PopoutPatch {
  alwaysOnTop?: boolean
  clickThrough?: boolean
  /** While click-through is on: the pointer is over the handle, so the window takes clicks for a moment. */
  handle?: boolean
  /** Bring it to the front ("Report a bug" again while the report is open). */
  focus?: boolean
}
export function parsePopoutPatch(raw: unknown): PopoutPatch | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const patch: PopoutPatch = {}
  for (const key of ['alwaysOnTop', 'clickThrough', 'handle', 'focus'] as const) {
    if (o[key] === undefined) continue
    if (typeof o[key] !== 'boolean') return null
    patch[key] = o[key] as boolean
  }
  return patch
}

/**
 * The window: frameless (the page draws its own title bar to drag by), never a parent of anything, and the same
 * locked-down page settings as the main window. Shown only once painted, and without taking focus.
 */
export function popoutWindowOptions(kind: PopoutKind, prefs: PopoutPrefs, bounds: Rect, base: { icon: string; backgroundColor: string; preload: string; spellcheck: boolean }) {
  return {
    ...bounds,
    minWidth: minSizeFor(kind).width,
    minHeight: minSizeFor(kind).height,
    frame: false,
    show: false,
    alwaysOnTop: prefs.alwaysOnTop,
    minimizable: kind === 'chat' || kind === 'report',
    maximizable: false,
    fullscreenable: kind === 'stream',
    autoHideMenuBar: true,
    icon: base.icon,
    backgroundColor: base.backgroundColor,
    webPreferences: {
      preload: base.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: base.spellcheck,
      webviewTag: false,
    },
  }
}

// ── window.open from the main window (security review R3-3) ─────────────────

/** How long after a click or key press a page may open a link in the browser. */
export const GESTURE_MS = 5_000
/** Links into the browser: at most this many at once, then one per REFILL_MS. */
export const EXTERNAL_BURST = 3
export const REFILL_MS = 2_000

/** Input that counts as the person doing something (Electron's input-event types). */
export const isGesture = (type: string | undefined): boolean =>
  !!type && /^(mouseDown|mouseUp|keyDown|rawKeyDown|char|touchStart|touchEnd|gestureTap|pointerDown|pointerUp)$/.test(type)

/**
 * What a window.open in the main window may do. Every frame in it lands in the same handler, third-party embeds
 * included, and Electron has no pop-up blocker. So the system browser opens only shortly after the person clicked or
 * typed in the window, a few at a time; a pop-out never for another origin (an embed's referrer), and without a
 * referrer (the app sends none) only shortly after a click or key press too (pop-outs only ever open from one).
 */
export class WindowOpenGate {
  private lastGesture = -Infinity
  private tokens = EXTERNAL_BURST
  private refilled = -Infinity

  gesture(now: number): void {
    this.lastGesture = now
  }

  decide(details: { url: string; referrer: string }, isPopout: boolean, isAppUrl: (url: string) => boolean, now: number): 'popout' | 'external' | 'deny' {
    const recent = now - this.lastGesture <= GESTURE_MS
    if (isPopout) return isAppUrl(details.referrer) || (!details.referrer && recent) ? 'popout' : 'deny'
    if (!/^https?:\/\//i.test(details.url) || !recent) return 'deny'
    const earned = Math.floor((now - this.refilled) / REFILL_MS)
    if (earned > 0) {
      this.tokens = Math.min(EXTERNAL_BURST, this.tokens + earned)
      this.refilled = this.tokens === EXTERNAL_BURST ? now : this.refilled + earned * REFILL_MS
    }
    if (this.tokens <= 0) return 'deny'
    this.tokens--
    return 'external'
  }
}
