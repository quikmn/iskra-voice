// Loudness leveling for one incoming voice: a slow gain that brings quiet and loud people towards the same level
// (only while they're talking, so background hiss isn't pulled up in pauses), then a gentle compressor that only
// touches syllables well above the target, and a look-ahead limiter that keeps peaks from clipping. Every gain moves
// smoothly, sample by sample: no steps, nothing that distorts the waveform. Per-person volume is applied after this,
// on top. Runs per 128-sample block in an audio worklet, allocation-free. Shared with its tests.

export const LEVEL_TARGET_DB = -23
/** The slow gain never goes beyond ± this. */
export const LEVEL_MAX_DB = 12
/** How fast the slow gain may move. */
export const LEVEL_RATE_DB_PER_S = 3
/** Below this the block is a pause: measured, but it doesn't move the gain. */
export const LEVEL_GATE_DB = -50

/** Levels are RMS (about 10 ms), not peaks: the compressor follows loudness, not every waveform peak. */
export const COMPRESSOR = { threshold: -16, ratio: 2, knee: 8, attackMs: 10, releaseMs: 200 }
export const LIMIT = 0.89 // -1 dBFS
/** The mic's limiter, before it's sent (only input volume above 100% reaches it). */
export const SEND_CEILING = 0.97
/** The limiter sees peaks this far ahead and ramps down over the same time, so it never clips or steps. */
export const LIMITER_LOOKAHEAD_MS = 1.5
const LIMITER_RELEASE_MS = 80

const toDb = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -180)
const fromDb = (db: number) => Math.pow(10, db / 20)
/** Below this the compressor does nothing (skips the math). */
const KNEE_START = fromDb(COMPRESSOR.threshold - COMPRESSOR.knee / 2) ** 2

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

/**
 * A look-ahead peak limiter, per sample: the signal is delayed by the look-ahead, the gain each sample needs is
 * known in advance (sliding minimum), and the applied gain is that minimum averaged over the look-ahead, so it ramps
 * down smoothly and is already low enough when the peak arrives. Then it recovers slowly. Allocation-free.
 */
export class Limiter {
  /** Look-ahead in samples (the delay it adds). */
  readonly lookahead: number
  /** The gain applied to the last sample (1 = untouched). */
  gain = 1
  private readonly ceiling: number
  private readonly release: number
  private readonly delay: Float32Array
  private delayPos = 0
  // Sliding minimum of the needed gain (a monotonic queue of values and their sample numbers).
  private readonly qv: Float64Array
  private readonly qi: Float64Array
  private qHead = 0
  private qLen = 0
  // Moving average of that minimum.
  private readonly box: Float64Array
  private boxPos = 0
  private boxSum: number
  private t = 0

  constructor(sampleRate: number, ceiling = LIMIT, lookaheadMs = LIMITER_LOOKAHEAD_MS, releaseMs = LIMITER_RELEASE_MS) {
    const n = Math.max(2, Math.round((lookaheadMs / 1000) * sampleRate))
    this.lookahead = n - 1
    this.ceiling = ceiling
    this.release = 1 - Math.exp(-1 / ((releaseMs / 1000) * sampleRate))
    this.delay = new Float32Array(n - 1)
    this.qv = new Float64Array(n + 1)
    this.qi = new Float64Array(n + 1)
    this.box = new Float64Array(n).fill(1)
    this.boxSum = n
  }

  step(x: number): number {
    const n = this.box.length
    const size = this.qv.length
    const a = Math.abs(x)
    const need = a > this.ceiling ? this.ceiling / a : 1
    while (this.qLen > 0 && this.qv[(this.qHead + this.qLen - 1) % size] >= need) this.qLen--
    this.qv[(this.qHead + this.qLen) % size] = need
    this.qi[(this.qHead + this.qLen) % size] = this.t
    this.qLen++
    while (this.qi[this.qHead] <= this.t - n) {
      this.qHead = (this.qHead + 1) % size
      this.qLen--
    }
    const min = this.qv[this.qHead]
    this.boxSum += min - this.box[this.boxPos]
    this.box[this.boxPos] = min
    this.boxPos = (this.boxPos + 1) % n
    const avg = Math.min(1, this.boxSum / n)
    // Down: as the average says (it reaches the needed gain by the time the peak is out). Up: slowly.
    this.gain = avg < this.gain ? avg : this.gain + (avg - this.gain) * this.release
    this.t++
    const delayed = this.delay[this.delayPos]
    this.delay[this.delayPos] = x
    this.delayPos = (this.delayPos + 1) % this.delay.length
    const y = delayed * this.gain
    // Rounding in the running sum can't push a sample over the ceiling.
    return y > this.ceiling ? this.ceiling : y < -this.ceiling ? -this.ceiling : y
  }
}

export class Leveler {
  /** The slow gain, in dB. */
  gainDb = 0
  /** Speech loudness estimate (dBFS RMS), slow. */
  loudnessDb = LEVEL_TARGET_DB
  /** The compressor's gain on the last sample (linear). */
  compressorGain = 1
  private env = 0
  private slow = 1
  private readonly limiter: Limiter
  private readonly blockS: number
  private readonly attack: number
  private readonly release: number
  private readonly loudnessAlpha: number

  constructor(sampleRate: number, block = 128) {
    this.blockS = block / sampleRate
    this.attack = 1 - Math.exp(-1 / ((COMPRESSOR.attackMs / 1000) * sampleRate))
    this.release = 1 - Math.exp(-1 / ((COMPRESSOR.releaseMs / 1000) * sampleRate))
    this.limiter = new Limiter(sampleRate)
    // About 3 s of talking to settle on someone's level.
    this.loudnessAlpha = 1 - Math.exp(-this.blockS / 3)
  }

  /** Samples of delay (the limiter's look-ahead). */
  get latency(): number {
    return this.limiter.lookahead
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
    // Glides to the new slow gain across the block.
    const from = this.slow
    const to = fromDb(this.gainDb)
    this.slow = to
    const n = input.length

    for (let i = 0; i < n; i++) {
      let x = input[i] * (from + ((to - from) * (i + 1)) / n)
      // Compressor: RMS envelope (mean square), smooth gain.
      const sq = x * x
      this.env += (sq - this.env) * (sq > this.env ? this.attack : this.release)
      this.compressorGain = this.env > KNEE_START ? fromDb(compressorGainDb(10 * Math.log10(this.env))) : 1
      x *= this.compressorGain
      output[i] = this.limiter.step(x)
    }
  }
}
