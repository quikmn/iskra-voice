// While the e2e suite drives the app (never a packaged app): where windows open, and no pictures of the real screen.
// The suite (client/e2e/global-setup.ts) passes ISKRA_E2E_WINDOW_AREA: "x,y,w,h" (a monitor's work area in physical
// pixels), "offscreen", or "primary" (the normal placement).
import type { BrowserWindow } from 'electron'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type TestWindowArea = Rect | 'offscreen'

/** Far outside every monitor, but within what Windows accepts (±32767); the window still renders there. */
export const OFFSCREEN = { x: -20000, y: -20000 }

/** A development run started by the e2e suite. */
export function isTestRun(env: Record<string, string | undefined>, packaged: boolean): boolean {
  return !packaged && (!!env.ISKRA_E2E || !!env.ISKRA_E2E_WINDOW_AREA)
}

/** The screen picker's thumbnails are real pictures of the screen and windows: none in test runs, unless a spec
 * opts in to real capture (ISKRA_E2E_SPEAKERS=1, desktop-audio.spec). */
export function realScreenThumbnails(env: Record<string, string | undefined>, packaged: boolean): boolean {
  return !isTestRun(env, packaged) || env.ISKRA_E2E_SPEAKERS === '1'
}

/** What desktopCapturer.getSources is asked for: 0×0 captures no thumbnail at all. */
export function thumbnailSize(real: boolean): { width: number; height: number } {
  return real ? { width: 320, height: 180 } : { width: 0, height: 0 }
}

/** The picker's choices for the page; without real thumbnails each one is blank whatever the capturer returned. */
export function pickerChoices(sources: { id: string; name: string; thumbnail: { toDataURL(): string } }[], real: boolean) {
  return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: real ? s.thumbnail.toDataURL() : BLANK_THUMBNAIL, isScreen: s.id.startsWith('screen:') }))
}

/** A 1×1 transparent PNG. */
export const BLANK_THUMBNAIL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** The area to place test windows in, or null for the normal behaviour (packaged apps always get null). */
export function testWindowArea(env: Record<string, string | undefined>, packaged: boolean): TestWindowArea | null {
  const raw = env.ISKRA_E2E_WINDOW_AREA?.trim()
  if (packaged || !raw) return null
  if (raw === 'offscreen') return 'offscreen'
  const parts = raw.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || !parts.every(Number.isInteger)) return null
  const [x, y, width, height] = parts
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/** A window of this size, centred in the area and shrunk to fit it; off-screen keeps the size. */
export function placeInArea(size: { width: number; height: number }, area: TestWindowArea): Rect {
  if (area === 'offscreen') return { ...OFFSCREEN, width: size.width, height: size.height }
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  }
}

/**
 * Applies the placement to every new window of a test run: placed in the area (or off-screen), shown without ever
 * taking focus (show, focus and restore become inactive), off the taskbar when off-screen, and never throttled.
 * workArea maps the suite's physical-pixel rect to the work area of the display it is on (Electron's DIPs).
 */
export function placeTestWindow(win: BrowserWindow, area: TestWindowArea, workArea: (rect: Rect) => Rect): void {
  const target = area === 'offscreen' ? area : workArea(area)
  const place = () => {
    if (win.isDestroyed()) return
    const [width, height] = win.getSize()
    win.setBounds(placeInArea({ width, height }, target))
  }
  place()
  win.webContents.setBackgroundThrottling(false)
  if (area === 'offscreen') win.setSkipTaskbar(true)
  win.show = () => win.showInactive()
  win.restore = () => win.showInactive()
  win.focus = () => undefined
  // Windows can move a window back onto a monitor when it's first shown: put it back.
  win.once('show', place)
}
