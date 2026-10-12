// Which noise suppression actually runs, given the setting and what this device can do:
//   'ai'      DeepFilterNet3 (WebAssembly with SIMD in an AudioWorklet, 48 kHz)
//   'rnnoise' RNNoise (WebAssembly in an AudioWorklet, 48 kHz)
//   'browser' the browser's own noise suppression
//   'off'     nothing
// AI falls back to RNNoise when it can't load or the device turned out too slow for it (remembered on this
// device), and RNNoise to the browser's. No DOM here beyond feature checks, so it's easy to test.
import type { NoiseMode } from '../audio'

export type NoiseEngine = 'ai' | 'rnnoise' | 'browser' | 'off'

export interface EngineCaps {
  /** AudioWorklet, WebAssembly and a way to turn the result back into a track. */
  worklet: boolean
  /** WebAssembly SIMD (DeepFilterNet is built with it). */
  simd: boolean
}

export interface EngineHealth {
  /** DeepFilterNet couldn't start here (this session). */
  aiBroken: boolean
  /** DeepFilterNet ran slower than real time here (remembered on this device). */
  aiSlow: boolean
  /** RNNoise couldn't start here (this session). */
  rnnoiseBroken: boolean
}

export function pickEngine(mode: NoiseMode, caps: EngineCaps, health: EngineHealth): NoiseEngine {
  if (mode === 'off') return 'off'
  if (mode === 'standard') return 'browser'
  if (mode === 'ai' && caps.worklet && caps.simd && !health.aiBroken && !health.aiSlow) return 'ai'
  if (caps.worklet && !health.rnnoiseBroken) return 'rnnoise'
  return 'browser'
}

/** Why the engine isn't the one you chose (for the settings), or null. */
export function fallbackReason(mode: NoiseMode, caps: EngineCaps, health: EngineHealth): 'unsupported' | 'slow' | 'failed' | null {
  const engine = pickEngine(mode, caps, health)
  if (mode === 'ai' && engine !== 'ai') return !caps.worklet || !caps.simd ? 'unsupported' : health.aiSlow ? 'slow' : 'failed'
  if (mode === 'strong' && engine !== 'rnnoise') return caps.worklet ? 'failed' : 'unsupported'
  return null
}

// ── This device ──────────────────────────────────────────────────────────

// The smallest module using a SIMD instruction (as in wasm-feature-detect).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])

let caps: EngineCaps | null = null
export function engineCaps(): EngineCaps {
  if (caps) return caps
  const worklet = typeof AudioWorkletNode === 'function' && typeof WebAssembly === 'object' && typeof AudioContext === 'function' &&
    'createMediaStreamDestination' in AudioContext.prototype
  let simd = false
  try {
    simd = typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE)
  } catch {
    simd = false
  }
  caps = { worklet, simd }
  return caps
}

const SLOW_KEY = 'iskra.audio.aiSlow'
const health: EngineHealth = { aiBroken: false, aiSlow: readSlow(), rnnoiseBroken: false }

function readSlow(): boolean {
  try {
    return localStorage.getItem(SLOW_KEY) === '1'
  } catch {
    return false
  }
}

export const engineHealth = (): EngineHealth => ({ ...health })

export function markBroken(engine: 'ai' | 'rnnoise'): void {
  if (engine === 'ai') health.aiBroken = true
  else health.rnnoiseBroken = true
}

export function markSlow(slow: boolean): void {
  health.aiSlow = slow
  try {
    if (slow) localStorage.setItem(SLOW_KEY, '1')
    else localStorage.removeItem(SLOW_KEY)
  } catch {
    /* private mode */
  }
}

/** Choosing AI again gives it another try. */
export function retryAi(): void {
  health.aiBroken = false
  markSlow(false)
}

export const plannedEngine = (mode: NoiseMode): NoiseEngine => pickEngine(mode, engineCaps(), health)

// ── Too slow? ────────────────────────────────────────────────────────────

/**
 * Realtime factor = time spent processing / length of the audio processed. Above this for a few seconds in a row
 * and the audio thread can't keep up (glitches), so we fall back.
 */
export const SLOW_RTF = 0.6
export const SLOW_WINDOWS = 3

/** Counts windows (about a second of audio each) over the limit; true once there were enough in a row. */
export class SlowWatch {
  private over = 0
  /** Returns true when it's time to give up. */
  report(rtf: number): boolean {
    this.over = rtf > SLOW_RTF ? this.over + 1 : 0
    return this.over >= SLOW_WINDOWS
  }
}
