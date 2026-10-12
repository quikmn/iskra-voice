// The voice activity gate driven by Silero VAD: opens when you start speaking, stays open through short pauses
// (hangover) and closes after you stop. Speech is only detected after it starts, so the gate keeps a short history and
// sends it when it opens (pre-roll): the first syllable isn't cut off. That makes the voice late by the pre-roll for a
// moment; the gate catches up by skipping the quiet gaps between words, so a sentence or two later it's live again.
// Runs once per 128-sample block in the audio worklet, allocation-free. Shared with its tests.

export interface VadGateParams {
  /** Speech probability that opens the gate. */
  enter: number
  /** Below this the gate starts its hangover; also what counts as a gap to skip while catching up. */
  exit: number
  preRollMs: number
  hangoverMs: number
  /** Off: pass everything through (push-to-talk), but still tell whether you're speaking. */
  gating: boolean
}

export const VAD_DEFAULTS: VadGateParams = { enter: 0.5, exit: 0.35, preRollMs: 250, hangoverMs: 500, gating: true }

/** Fade in and out over this long, so opening and closing never click. */
const FADE_MS = 10
/** A gap is only skipped when this much after it is quiet too (the detector lags behind the start of a word). */
const LOOKAHEAD_MS = 80

export class VadGate {
  params: VadGateParams = { ...VAD_DEFAULTS }
  /** Speaking (after hangover). */
  open = false
  private probability = 0
  private quietMs = 0
  private readonly blockMs: number
  private readonly block: number
  private readonly blocks: number
  private readonly ring: Float32Array
  /** Speech probability of each stored block when it came in. */
  private readonly probs: Float32Array
  private write = 0
  /** How many blocks behind live the output is. */
  private delay = 0
  /** Output gain, ramped towards open (1) or closed (0). */
  private level = 0
  private readonly fadeStep: number
  private readonly lookahead: number
  /** Blocks still to send before catching up may start: the pre-roll itself is never skipped. */
  private protect = 0

  constructor(sampleRate: number, block = 128, maxPreRollMs = 400) {
    this.block = block
    this.blockMs = (block / sampleRate) * 1000
    this.blocks = Math.ceil(maxPreRollMs / this.blockMs) + 2
    this.ring = new Float32Array(this.blocks * block)
    this.probs = new Float32Array(this.blocks)
    this.fadeStep = 1 / Math.max(1, (FADE_MS / 1000) * sampleRate)
    this.lookahead = Math.ceil(LOOKAHEAD_MS / this.blockMs)
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
    this.delay = 0
    this.protect = 0
    this.level = 0
    this.ring.fill(0)
    this.probs.fill(0)
  }

  process(input: Float32Array, output: Float32Array): void {
    const { enter, exit, preRollMs, hangoverMs, gating } = this.params
    const p = this.probability
    this.ring.set(input.subarray(0, this.block), this.write * this.block)
    this.probs[this.write] = p

    // Speaking or not, with hangover.
    if (p >= enter) {
      this.quietMs = 0
      if (!this.open) {
        this.open = true
        // Start from the pre-roll: what was said just before the detector noticed.
        this.delay = gating ? Math.min(this.blocks - 2, Math.round(preRollMs / this.blockMs)) : 0
        this.protect = this.delay + 1
      }
    } else if (this.open && p < exit) {
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

    // Catch up: drop one stored block that was a gap between words (it's replaced by the next one, crossfaded).
    let skip = this.open && this.delay > 0 && this.protect <= 0
    for (let back = this.delay; skip && back >= Math.max(0, this.delay - this.lookahead); back--) {
      if (this.probs[this.slot(back)] >= exit) skip = false
    }
    this.protect -= skip ? 2 : 1
    const from = this.slot(this.delay)
    if (skip) {
      this.delay--
      const to = this.slot(this.delay)
      const n = this.block
      for (let i = 0; i < n; i++) {
        const t = i / n
        output[i] = this.ring[from * n + i] * (1 - t) + this.ring[to * n + i] * t
      }
    } else {
      output.set(this.ring.subarray(from * this.block, from * this.block + this.block))
    }

    // Fades.
    const target = this.open ? 1 : 0
    if (this.level !== target || target === 0) {
      for (let i = 0; i < output.length; i++) {
        this.level = target > this.level ? Math.min(1, this.level + this.fadeStep) : Math.max(0, this.level - this.fadeStep)
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
