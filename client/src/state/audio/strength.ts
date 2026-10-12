// DeepFilterNet3's settings, shared by the mic's worklet, the worker for incoming voices and the quality tests.
// Measured with scripts/audio-quality.mjs (docs/voice-processing.md has the numbers).
import { df_create, df_set_atten_lim, df_set_thresholds } from '../../../vendor/deepfilternet/deepfilter.js'
import type { AiStrength } from '../audio'

/**
 * The most AI noise removal may turn anything down, in dB (100 = no limit). With a limit, what it takes out is mixed
 * back in at that level: noise stays far down, and the voice keeps what the network would otherwise shave off it.
 */
export const DF_STRENGTH_DB: Record<AiStrength, number> = { gentle: 18, normal: 30, max: 100 }

/**
 * Local SNR thresholds (dB): below the first a frame counts as noise only, above the others the network leaves the
 * frame (or its deep-filter stage) alone. libDF's WebAssembly defaults (-10, 30, 20) skip the deep filter on clean
 * speech and turn it down by about 8 dB, frame by frame; DeepFilterNet's own command line tool uses these.
 */
export const DF_THRESHOLDS = { min: -15, maxErb: 35, maxDf: 35 } as const

/** A DeepFilterNet3 state with Iskra's settings. */
export function createDeepFilter(model: Uint8Array, attenDb: number): number {
  const state = df_create(model, attenDb)
  df_set_thresholds(state, DF_THRESHOLDS.min, DF_THRESHOLDS.maxErb, DF_THRESHOLDS.maxDf)
  return state
}

/**
 * Runs a few frames of faint noise through a new state, so the first real frames don't pay for warming up (the first
 * ones take 10 times longer: too long for an audio thread). Faint, not silent: libDF skips digital silence.
 */
export function warmUp(state: number, process: (state: number, frame: Float32Array) => Float32Array, frames = 20): void {
  const frame = new Float32Array(480)
  let seed = 1
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < frame.length; i++) frame[i] = ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 0.002
    process(state, frame)
  }
}

export function setStrength(state: number, attenDb: number): void {
  df_set_atten_lim(state, attenDb)
}
