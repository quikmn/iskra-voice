// Camera background effects, the pure parts (shared with tests): the setting, and deciding when the device can't
// keep up. No DOM here.

export type BackgroundMode = 'off' | 'blur' | 'replace'
/** A built-in picture (drawn by the worker, so there's nothing to download) or a solid colour. */
export type Backdrop = 'color' | 'aurora' | 'sunset'

export interface BackgroundSettings {
  mode: BackgroundMode
  backdrop: Backdrop
  /** #rrggbb, for the solid colour. */
  color: string
  /** The camera to use ('' = the system's default). */
  camera: string
}

export const BACKGROUND_DEFAULTS: BackgroundSettings = { mode: 'off', backdrop: 'aurora', color: '#2f3640', camera: '' }

export function parseBackgroundSettings(raw: string | null): BackgroundSettings {
  try {
    const p = JSON.parse(raw ?? '{}') as Partial<BackgroundSettings>
    return {
      mode: p.mode === 'blur' || p.mode === 'replace' ? p.mode : 'off',
      backdrop: p.backdrop === 'color' || p.backdrop === 'sunset' ? p.backdrop : 'aurora',
      color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toLowerCase() : BACKGROUND_DEFAULTS.color,
      camera: typeof p.camera === 'string' && p.camera.length <= 512 ? p.camera : '',
    }
  } catch {
    return { ...BACKGROUND_DEFAULTS }
  }
}

/** #rrggbb as 0–1 floats. */
export function colorFloats(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Two seconds of processing, as the processor measures it. */
export interface EffectWindow {
  /** Frames the camera gave us per second. */
  inputFps: number
  /** Processed frames per second. */
  outputFps: number
  /** Mean time per processed frame (segmentation + drawing), ms. */
  frameMs: number
}

/** Below this many frames per second the picture stutters. */
export const MIN_FPS = 10
/** A frame taking longer than this caps the picture at about 15 fps and keeps a core busy. */
export const MAX_FRAME_MS = 60
/** Windows in a row that must be too slow before giving up (the first one is skipped: loading, warming up). */
export const SLOW_WINDOWS = 3

/** True when a window was too slow: well below the camera's own rate, or frames take too long. */
export function windowTooSlow(w: EffectWindow): boolean {
  if (w.inputFps < 5) return false // the camera itself stalled (covered, tab hidden): nothing to judge
  const wanted = Math.min(MIN_FPS, w.inputFps * 0.6)
  return w.outputFps < wanted || w.frameMs > MAX_FRAME_MS
}

export class EffectWatch {
  private seen = 0
  private over = 0
  /** True once it's time to turn the effect off. */
  report(w: EffectWindow): boolean {
    if (this.seen++ === 0) return false
    this.over = windowTooSlow(w) ? this.over + 1 : 0
    return this.over >= SLOW_WINDOWS
  }
}

/**
 * Temporal smoothing of the person mask (0–1 per pixel), in place: quick to follow real movement, slow to flicker.
 * The bigger the change at a pixel, the more of the new value is taken.
 */
export function smoothMask(previous: Float32Array, next: Float32Array): void {
  for (let i = 0; i < next.length; i++) {
    const d = next[i] - previous[i]
    const a = 0.45 + 0.55 * Math.min(1, Math.abs(d) * 1.5)
    previous[i] += a * d
  }
}
