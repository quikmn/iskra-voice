// "Report a bug" in a window of its own, the parts without a DOM: how it opens here, the screenshot countdown, and the
// pictures the desktop app hands back.
import type { PopoutMode } from '../popoutLogic'

/** "Screenshot in 5 seconds": time to open a menu or point at something in another window first. */
export const CAPTURE_DELAY_SECONDS = 5

/**
 * What "Report a bug" does now: bring the open report window to the front, open one (desktop app; Document
 * Picture-in-Picture in Chromium, but not on a touch screen), or show the report in the page (phones, tablets,
 * Firefox, Safari). Nothing if it's showing.
 */
export function reportOpenAction(now: { windowOpen: boolean; dialogOpen: boolean; mode: PopoutMode | null; touch: boolean }): 'focus' | 'window' | 'dialog' | 'none' {
  if (now.windowOpen) return 'focus'
  if (now.dialogOpen) return 'none'
  return now.mode === 'window' || (now.mode === 'document' && !now.touch) ? 'window' : 'dialog'
}

/**
 * Counts down from `seconds`, calling `tick` with the seconds left (first right away), then `done`. Returns a cancel.
 * Nothing here touches focus: the window you're showing the bug in stays as it is.
 */
export function startCountdown(seconds: number, tick: (left: number) => void, done: () => void): () => void {
  let left = seconds
  let timer: ReturnType<typeof setTimeout> | null = null
  const step = () => {
    if (left <= 0) {
      timer = null
      done()
      return
    }
    tick(left)
    left--
    timer = setTimeout(step, 1000)
  }
  step()
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
}

const PNG_PREFIX = 'data:image/png;base64,'

/** The desktop app's capture (a PNG data URL) as a blob; null for anything else. */
export function pngFromDataUrl(url: unknown): Blob | null {
  if (typeof url !== 'string' || !url.startsWith(PNG_PREFIX)) return null
  try {
    return new Blob([Uint8Array.from(atob(url.slice(PNG_PREFIX.length)), (c) => c.charCodeAt(0))], { type: 'image/png' })
  } catch {
    return null
  }
}
