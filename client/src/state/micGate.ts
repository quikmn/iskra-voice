// The voice activity gate and level meter, shared by the audio worklet (micGate.worklet.ts) and its tests.
// Runs once per 128-sample block, so it stays allocation-free.

export interface GateParams {
  /** Linear gain applied first (input volume). */
  gain: number
  /** dBFS: the gate opens above this. With `gating` off it only decides "speaking". */
  threshold: number
  /** Close the mic below the threshold (manual sensitivity), or just report. */
  gating: boolean
}

export const HOLD_MS = 300
/** Fade in/out time, so the gate never clicks. */
const ATTACK_MS = 5
const RELEASE_MS = 60

const toDb = (rms: number) => (rms > 1e-8 ? 20 * Math.log10(rms) : -160)

export class Gate {
  params: GateParams = { gain: 1, threshold: -50, gating: false }
  /** Loudest block since the last report, in dBFS. */
  peakDb = -160
  open = false
  private heldMs = 0
  private level = 0
  private readonly blockMs: number
  private readonly attack: number
  private readonly release: number

  constructor(sampleRate: number, blockSize = 128) {
    this.blockMs = (blockSize / sampleRate) * 1000
    this.attack = Math.min(1, this.blockMs / ATTACK_MS)
    this.release = Math.min(1, this.blockMs / RELEASE_MS)
  }

  /** Processes one mono block in place. */
  process(input: Float32Array, output: Float32Array): void {
    const { gain, threshold, gating } = this.params
    let sum = 0
    for (let i = 0; i < input.length; i++) {
      const v = input[i] * gain
      output[i] = v
      sum += v * v
    }
    const db = toDb(Math.sqrt(sum / Math.max(1, input.length)))
    if (db > this.peakDb) this.peakDb = db

    if (db >= threshold) {
      this.open = true
      this.heldMs = 0
    } else if (this.open) {
      this.heldMs += this.blockMs
      if (this.heldMs >= HOLD_MS) this.open = false
    }

    if (!gating) return
    // Ramp the gate's own level towards open/closed, sample by sample within the block.
    const target = this.open ? 1 : 0
    const step = target > this.level ? this.attack : this.release
    const from = this.level
    const to = from + (target - from) * step
    if (from === 1 && to === 1) return
    for (let i = 0; i < output.length; i++) output[i] *= from + ((to - from) * i) / output.length
    this.level = to < 1e-3 ? 0 : to > 0.999 ? 1 : to
  }

  /** The loudest level since the last call, then starts over. */
  takePeak(): number {
    const peak = this.peakDb
    this.peakDb = -160
    return peak
  }
}
