// Phone navigation, the pure parts: what the back button does, and whether a touch is a drawer swipe.
// The wiring (history, Capacitor's back button, touch events) is in backNav.ts and PhoneNav.tsx.

/** What's on top when back is pressed. `nav`/`members`: that drawer and nothing above it. */
export type BackTop = 'none' | 'layer' | 'nav'

export interface BackState {
  top: BackTop
  /** The channels drawer exists (a phone-width shell is showing). */
  drawer: boolean
  /** Back was pressed on the drawer a moment ago ("Press back again to leave" is showing). */
  armed: boolean
}

export type BackAction =
  | 'close-layer' // the top menu, sheet, dialog, viewer, panel or settings page
  | 'open-nav' // in a channel: show the channels drawer
  | 'close-nav' // the drawer: back to the channel, and arm the exit
  | 'arm' // nothing to close and no drawer: arm the exit
  | 'exit' // a second back while armed: leave the app

/** One press of back. */
export function backAction({ top, drawer, armed }: BackState): BackAction {
  if (top === 'layer') return 'close-layer'
  if (armed) return 'exit'
  if (top === 'nav') return 'close-nav'
  return drawer ? 'open-nav' : 'arm'
}

/** How long "Press back again to leave" waits for the second press. */
export const EXIT_WINDOW_MS = 2000

// ── Swipes ──

/** Movement before a touch counts as a swipe or a scroll. */
export const SLOP_PX = 10
/** Horizontal only when it's clearly sideways. */
export const HORIZONTAL_RATIO = 1.5
/** Past this share of the drawer's width, letting go finishes the move. */
export const COMMIT_SHARE = 0.35
/** A flick this fast (px/ms) finishes the move whatever the distance. */
export const FLICK_SPEED = 0.5

export type Intent = 'pending' | 'horizontal' | 'vertical'

/** A touch that has moved dx, dy: still undecided, a sideways swipe, or something else (scrolling). */
export function swipeIntent(dx: number, dy: number): Intent {
  if (Math.hypot(dx, dy) < SLOP_PX) return 'pending'
  return Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO ? 'horizontal' : 'vertical'
}

export type Panel = 'none' | 'nav' | 'members'
export type Drag = { panel: 'nav' | 'members'; opening: boolean }

/** What a sideways swipe moves, from what's open: right opens channels / closes members, left the opposite. */
export function swipeTarget(panel: Panel, dx: number, members: boolean): Drag | null {
  const right = dx > 0
  if (panel === 'none') return right ? { panel: 'nav', opening: true } : members ? { panel: 'members', opening: true } : null
  if (panel === 'nav') return right ? null : { panel: 'nav', opening: false }
  return right ? { panel: 'members', opening: false } : null
}

/** How far open (0..1) a drawer of `width` is, `dx` into a drag. */
export function dragProgress(drag: Drag, dx: number, width: number): number {
  if (width <= 0) return drag.opening ? 0 : 1
  const towardsOpen = drag.panel === 'nav' ? dx : -dx
  const share = Math.min(1, Math.max(0, Math.abs(towardsOpen) / width))
  if (drag.opening) return towardsOpen > 0 ? share : 0
  return towardsOpen < 0 ? 1 - share : 1
}

/** On letting go: does the drawer end up open? `velocity` is px/ms along x. */
export function dragEndsOpen(drag: Drag, progress: number, velocity: number): boolean {
  const towardsOpen = drag.panel === 'nav' ? velocity : -velocity
  if (towardsOpen > FLICK_SPEED) return true
  if (towardsOpen < -FLICK_SPEED) return false
  return drag.opening ? progress >= COMMIT_SHARE : progress > 1 - COMMIT_SHARE
}

/** Where a swipe can't start: things that use sideways moves themselves, and fields. */
export const NO_SWIPE = [
  'input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])', 'pre', 'code', 'canvas', 'video',
  'iframe', '[role="slider"]', '[data-no-swipe]', '.emoji-picker', '.sticker-panel', '.gif-panel', '.soundboard',
  '.whiteboard-channel', '.activity-frame', '.stage-body', '.lightbox', '.katex-display',
].join(', ')

/** True when a touch starting on `el` must not move a drawer (inside `root`, which is never checked itself). */
export function swipeBlocked(el: Element | null, root: Element | null): boolean {
  for (let node = el; node && node !== root; node = node.parentElement) {
    if (node.matches(NO_SWIPE)) return true
    if (scrollsSideways(node)) return true
  }
  return false
}

function scrollsSideways(el: Element): boolean {
  if (el.scrollWidth <= el.clientWidth + 1) return false
  const overflow = getComputedStyle(el).overflowX
  return overflow === 'auto' || overflow === 'scroll'
}
