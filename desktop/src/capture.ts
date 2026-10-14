// "Take a screenshot of Iskra" for bug reports: only the app's own page (webContents.capturePage), never the screen
// or other windows. Big windows are scaled down so the longer side is at most MAX_CAPTURE_SIDE.

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
