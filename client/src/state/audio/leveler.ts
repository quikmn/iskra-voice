// Loudness leveling for one incoming voice: a slow gain that brings quiet and loud people towards the same level
// (only while they're talking, so background hiss isn't pulled up in pauses), then a compressor that evens out
// syllables and a limiter that keeps peaks from clipping. Per-person volume is applied after this, on top.
// Runs per 128-sample block in an audio worklet, allocation-free. Shared with its tests.

export const LEVEL_TARGET_DB = -23
/** The slow gain never goes beyond ± this. */
export const LEVEL_MAX_DB = 12
/** How fast the slow gain may move. */
export const LEVEL_RATE_DB_PER_S = 3
/** Below this the block is a pause: measured, but it doesn't move the gain. */
export const LEVEL_GATE_DB = -50

export const COMPRESSOR = { threshold: -20, ratio: 3, knee: 6, attackMs: 5, releaseMs: 150 }
const LIMIT = 0.89 // -1 dBFS

const toDb = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -180)
const fromDb = (db: number) => Math.pow(10, db / 20)
/** Below this the compressor does nothing (skips the math). */
const KNEE_START = fromDb(COMPRESSOR.threshold - COMPRESSOR.knee / 2)

/** A compressor's gain reduction (≤ 0 dB) at `levelDb`, with a soft knee. */
export function compressorGainDb(levelDb: number, threshold = COMPRESSOR.threshold, ratio = COMPRESSOR.ratio, knee = COMPRESSOR.knee): number {
  const over = levelDb - threshold
  if (2 * over < -knee) return 0
  if (2 * Math.abs(over) <= knee) {
    const x = over + knee / 2
    return ((1 / ratio - 1) * x * x) / (2 * knee)
  }
  return over * (1 / ratio - 1)
}

export class Leveler {
  /** The slow gain, in dB. */
  gainDb = 0
  /** Speech loudness estimate (dBFS RMS), slow. */
  loudnessDb = LEVEL_TARGET_DB
  private env = 0
  private limiterGain = 1
  private readonly blockS: number
  private readonly attack: number
  private readonly release: number
  private readonly limiterRelease: number
  private readonly loudnessAlpha: number

  constructor(sampleRate: number, block = 128) {
    this.blockS = block / sampleRate
    this.attack = 1 - Math.exp(-1 / ((COMPRESSOR.attackMs / 1000) * sampleRate))
    this.release = 1 - Math.exp(-1 / ((COMPRESSOR.releaseMs / 1000) * sampleRate))
    this.limiterRelease = 1 - Math.exp(-1 / (0.05 * sampleRate))
    // About 3 s of talking to settle on someone's level.
    this.loudnessAlpha = 1 - Math.exp(-this.blockS / 3)
  }

  process(input: Float32Array, output: Float32Array): void {
    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
    const blockDb = toDb(Math.sqrt(sum / Math.max(1, input.length)))

    // Slow gain: only follows while someone is talking.
    if (blockDb > LEVEL_GATE_DB) {
      this.loudnessDb += (blockDb - this.loudnessDb) * this.loudnessAlpha
      const want = Math.max(-LEVEL_MAX_DB, Math.min(LEVEL_MAX_DB, LEVEL_TARGET_DB - this.loudnessDb))
      const maxStep = LEVEL_RATE_DB_PER_S * this.blockS
      this.gainDb += Math.max(-maxStep, Math.min(maxStep, want - this.gainDb))
    }
    const slow = fromDb(this.gainDb)

    for (let i = 0; i < input.length; i++) {
      let x = input[i] * slow
      // Compressor: peak envelope, fast attack, slower release.
      const a = Math.abs(x)
      this.env += (a - this.env) * (a > this.env ? this.attack : this.release)
      if (this.env > KNEE_START) x *= fromDb(compressorGainDb(toDb(this.env)))
      // Limiter: instant down, gentle back up.
      const peak = Math.abs(x)
      if (peak * this.limiterGain > LIMIT) this.limiterGain = LIMIT / peak
      else this.limiterGain += (1 - this.limiterGain) * this.limiterRelease
      output[i] = x * this.limiterGain
    }
  }
}
