// The voice activity gate driven by Silero VAD: opens when you start speaking, stays open through short pauses
// (hangover) and closes after you stop. Speech is only detected after it starts, so the gate keeps a short history and
// sends it when it opens (pre-roll): the first syllable isn't cut off. That makes the voice late by the pre-roll for as
// long as the gate stays open; it never skips or squeezes audio to catch up (that's audible as choppy, hurried speech).
// Once it has closed again (after the hangover), the next opening starts over. Runs once per 128-sample block in the
// audio worklet, allocation-free. Shared with its tests.

export interface VadGateParams {
  /** Speech probability that opens the gate. */
  enter: number
  /** Below this the gate starts its hangover. */
  exit: number
  preRollMs: number
  hangoverMs: number
  /**
   * Opens early, on a probability this high, before Silero is sure (null: only at `enter`). If it doesn't reach
   * `enter` within `confirmMs`, it closes again.
   */
  early: number | null
  confirmMs: number
  /** Off: pass everything through (push-to-talk), but still tell whether you're speaking. */
  gating: boolean
}

/**
 * Pre-roll: short, because it's also the delay while you talk. Silero notices a word 25–40 ms after its voiced part
 * starts, and up to 145 ms after its faintest lead-in (a breath or soft consonant 20–30 dB down). 100 ms always
 * covers the first and now and then softens the second (quality.test.ts measures both).
 */
/**
 * Early opening: in noise (keyboard, café) Silero is sure of a soft first sound (an "s") later than the pre-roll
 * reaches back, so the gate opens at 0.2 already and closes again if Silero doesn't reach 0.5 within 200 ms.
 * Measured with the listening kit's voices and noises: word starts cut at most 60 ms instead of 135 (no noise
 * removal) and 25 instead of 50 (AI), no added delay; noise alone opens it no more often, except café chatter
 * (speech itself: 4 short openings in 30 s instead of 2).
 */
export const VAD_DEFAULTS: VadGateParams = { enter: 0.5, exit: 0.35, preRollMs: 100, hangoverMs: 500, early: 0.2, confirmMs: 200, gating: true }

/** Fade in and out over this long, so opening and closing never click. */
const FADE_MS = 10

export class VadGate {
  params: VadGateParams = { ...VAD_DEFAULTS }
  /** Speaking (after hangover). */
  open = false
  private probability = 0
  private quietMs = 0
  /** Opened early and not yet confirmed: for how long (ms), or -1. */
  private tentativeMs = -1
  /** After an early opening wasn't confirmed: not again until the probability has dropped below `early`. */
  private armed = true
  private readonly blockMs: number
  private readonly block: number
  private readonly blocks: number
  private readonly ring: Float32Array
  private write = 0
  /** How many blocks behind live the output is: the pre-roll while open (or fading out), 0 once closed. */
  private delay = 0
  /** Output gain, ramped towards open (1) or closed (0). */
  private level = 0
  private readonly fadeStep: number

  constructor(sampleRate: number, block = 128, maxPreRollMs = 400) {
    this.block = block
    this.blockMs = (block / sampleRate) * 1000
    this.blocks = Math.ceil(maxPreRollMs / this.blockMs) + 2
    this.ring = new Float32Array(this.blocks * block)
    this.fadeStep = 1 / Math.max(1, (FADE_MS / 1000) * sampleRate)
  }

  /** The newest speech probability (Silero runs every 32 ms; blocks in between reuse it). */
  setProbability(p: number): void {
    this.probability = p
  }

  /** Current extra latency from the pre-roll, in ms. */
  get latencyMs(): number {
    return this.delay * this.blockMs
  }

  reset(): void {
    this.open = false
    this.quietMs = 0
    this.tentativeMs = -1
    this.armed = true
    this.delay = 0
    this.level = 0
    this.ring.fill(0)
  }

  process(input: Float32Array, output: Float32Array): void {
    const { enter, exit, preRollMs, hangoverMs, gating, early, confirmMs } = this.params
    const p = this.probability
    this.ring.set(input.subarray(0, this.block), this.write * this.block)

    // Speaking or not, with hangover. An early opening that Silero doesn't confirm in time closes again.
    if (this.tentativeMs >= 0) {
      if (p >= enter) this.tentativeMs = -1
      else if ((this.tentativeMs += this.blockMs) >= confirmMs) {
        this.tentativeMs = -1
        this.open = false
        this.armed = false
      }
    }
    if (early === null || p < early) this.armed = true
    if (p >= enter || (early !== null && this.armed && !this.open && p >= early)) {
      this.quietMs = 0
      if (!this.open && p < enter) this.tentativeMs = 0
      if (!this.open) {
        this.open = true
        // Start from the pre-roll: what was said just before the detector noticed. Reopened while still fading out:
        // carry on from where the output is (jumping would repeat or skip audio).
        if (this.delay === 0 && gating) this.delay = Math.min(this.blocks - 2, Math.round(preRollMs / this.blockMs))
      }
    } else if (this.open && this.tentativeMs < 0 && p < exit) {
      this.quietMs += this.blockMs
      if (this.quietMs >= hangoverMs) this.open = false
    } else if (this.open) {
      this.quietMs = 0
    }

    if (!gating) {
      output.set(input)
      this.delay = 0
      this.level = 1
      this.advance()
      return
    }

    const from = this.slot(this.delay) * this.block
    output.set(this.ring.subarray(from, from + this.block))

    // Fades.
    const target = this.open ? 1 : 0
    if (this.level !== target || target === 0) {
      // Once it gets there it stays (it used to step back and forth by one step around 1: a buzz at half the
      // sample rate).
      for (let i = 0; i < output.length; i++) {
        if (this.level < target) this.level = Math.min(target, this.level + this.fadeStep)
        else if (this.level > target) this.level = Math.max(target, this.level - this.fadeStep)
        output[i] *= this.level
      }
    }
    if (!this.open && this.level === 0) this.delay = 0
    this.advance()
  }

  /** The ring slot `back` blocks before the newest one. */
  private slot(back: number): number {
    return (this.write - back + this.blocks) % this.blocks
  }

  private advance(): void {
    this.write = (this.write + 1) % this.blocks
  }
}
