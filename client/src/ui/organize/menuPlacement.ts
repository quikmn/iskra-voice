// Where a popover menu goes: at its anchor, flipped to the other side when it wouldn't fit, then slid to stay inside
// its bounds (the window, or a pane such as the chat, so the menu never lies over the column next to it).

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface MenuAnchor {
  x: number
  y: number
  /** 'end': the menu's right edge sits at x (a button at the right end of a row). Default: its left edge. */
  align?: 'start' | 'end'
  /** Where the menu's bottom edge goes when it opens upward (the top of the button); default y. */
  above?: number
  /** Keep the menu inside this box where it fits (window coordinates); it always stays inside the window. */
  within?: Box
}

const MARGIN = 8

/** One axis: the wanted start, else the flipped start, else slid inside [low, high]. */
function fit(wanted: number, flipped: number, size: number, low: number, high: number): number {
  const fits = (start: number) => start >= low && start + size <= high
  if (fits(wanted)) return wanted
  if (fits(flipped)) return flipped
  return Math.max(low, Math.min(wanted, high - size))
}

/** The pane's edges count on an axis only when the menu fits between them; otherwise the window's do. */
function range(pane: [number, number] | null, win: [number, number], size: number): [number, number] {
  if (pane) {
    const low = Math.max(pane[0], win[0])
    const high = Math.min(pane[1], win[1])
    if (high - low >= size) return [low, high]
  }
  return win
}

export function placeMenu(anchor: MenuAnchor, size: { w: number; h: number }, viewport: { w: number; h: number }, margin = MARGIN): { left: number; top: number } {
  const pane = anchor.within
  const [lowX, highX] = range(pane ? [pane.left, pane.right] : null, [margin, viewport.w - margin], size.w)
  const [lowY, highY] = range(pane ? [pane.top, pane.bottom] : null, [margin, viewport.h - margin], size.h)
  const end = anchor.align === 'end'
  const left = fit(end ? anchor.x - size.w : anchor.x, end ? anchor.x : anchor.x - size.w, size.w, lowX, highX)
  const top = fit(anchor.y, (anchor.above ?? anchor.y) - size.h, size.h, lowY, highY)
  return { left, top }
}

/**
 * The pane a control sits in: its nearest scrolling ancestor's left and right edges (the message list, a thread panel),
 * and the whole height of the window. Null when there is none.
 */
export function paneOf(el: Element): Box | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') {
      const r = node.getBoundingClientRect()
      return { left: r.left, right: r.right, top: 0, bottom: window.innerHeight }
    }
  }
  return null
}
