// Screenshots for bug reports: one of Iskra's own windows (the main window or a pop-out), captured from its page
// (webContents.capturePage), never the screen or other apps. Big windows are scaled down so the longer side is at most
// MAX_CAPTURE_SIDE.
import { parsePopoutName } from './popouts'

export const MAX_CAPTURE_SIDE = 2560

interface Picture {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): Picture
  toPNG(): Buffer
}

export interface CapturableContents {
  isDestroyed(): boolean
  capturePage(): Promise<Picture>
}

/** A PNG data URL of the page, or null if there's nothing to capture. */
export async function captureAppPage(contents: CapturableContents): Promise<string | null> {
  if (contents.isDestroyed()) return null
  let picture = await contents.capturePage()
  if (picture.isEmpty()) return null
  const { width, height } = picture.getSize()
  const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(width, height, 1))
  if (scale < 1) picture = picture.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
  return `data:image/png;base64,${picture.toPNG().toString('base64')}`
}

/**
 * Which window the page asked for: 'main', or the name of one of its pop-outs (never the bug report window itself).
 * Anything else is null.
 */
export function parseCaptureTarget(raw: unknown): 'main' | string | null {
  if (raw === 'main') return 'main'
  const popout = parsePopoutName(raw)
  return popout && popout.kind !== 'report' ? popout.name : null
}

/** The page to capture: the main window's, or a pop-out the app has open right now; null for anything else. */
export function captureTarget<T>(raw: unknown, main: T | null, popout: (name: string) => T | null): T | null {
  const target = parseCaptureTarget(raw)
  if (!target) return null
  return target === 'main' ? main : popout(target)
}
