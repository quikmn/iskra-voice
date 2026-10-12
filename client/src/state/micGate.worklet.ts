// AudioWorklet: input volume, the voice activity gate, a limiter (so input volume above 100% can't clip), and level
// reports for the meter (about 20 a second).
// Voice activity is Silero VAD (its model arrives over the port) unless you set a manual sensitivity; until the model
// is in, or if it can't load, the mic opens by level like before.
import { Gate, type GateParams } from './micGate'
import { Downsampler } from './audio/resample'
import { parseOnnxWeights, SILERO_FRAME, SILERO_RATE, SileroVad } from './audio/silero'
import { VadGate } from './audio/vadGate'
import { Limiter, SEND_CEILING } from './audio/leveler'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const REPORT_EVERY = 16 // blocks: 16 × 128 samples ≈ 43 ms at 48 kHz

/** What the page sends: the level gate's settings plus how voice activity works right now. */
export interface MicParams extends GateParams {
  /** Silero decides (automatic sensitivity). */
  vad: boolean
  /** Push-to-talk: never gate, only tell whether you're speaking. */
  ptt: boolean
}

type Message = Partial<MicParams> | { type: 'vad-model'; model: ArrayBuffer }

class MicGateProcessor extends AudioWorkletProcessor {
  private readonly gate = new Gate(sampleRate)
  private readonly vadGate = new VadGate(sampleRate)
  private readonly limiter = new Limiter(sampleRate, SEND_CEILING)
  private down: Downsampler | null = null
  private vad = false
  /** Level gating as asked for (manual sensitivity); off while Silero decides. */
  private levelGating = false
  private readonly scratch = new Float32Array(128)
  private blocks = 0
  private wasOpen = false

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data
      if (!m || typeof m !== 'object') return
      if ('type' in m) {
        try {
          const silero = new SileroVad(parseOnnxWeights(m.model))
          this.down = new Downsampler(sampleRate, SILERO_RATE, SILERO_FRAME, (frame) => this.vadGate.setProbability(silero.process(frame)))
          this.port.postMessage({ type: 'vad-ready' })
        } catch (err) {
          this.port.postMessage({ type: 'vad-error', message: String((err as Error)?.message ?? err) })
        }
        return
      }
      const { vad, ptt, ...gate } = m
      if (typeof vad === 'boolean') {
        if (vad && !this.vad) this.vadGate.reset()
        this.vad = vad
      }
      if (typeof ptt === 'boolean') this.vadGate.params = { ...this.vadGate.params, gating: !ptt }
      if (typeof gate.gating === 'boolean') this.levelGating = gate.gating
      this.gate.params = { ...this.gate.params, ...gate }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (!output) return true
    const silero = this.vad && this.down !== null && output.length === this.scratch.length
    this.gate.params.gating = silero ? false : this.levelGating
    if (!input) {
      output.fill(0)
    } else if (silero) {
      // Volume and level first, then Silero opens and closes the mic.
      this.gate.process(input, this.scratch)
      this.down!.push(this.scratch)
      this.vadGate.process(this.scratch, output)
    } else {
      this.gate.process(input, output)
    }
    for (let i = 0; i < output.length; i++) output[i] = this.limiter.step(output[i])
    const open = silero ? this.vadGate.open : this.gate.open
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output)
    if (++this.blocks >= REPORT_EVERY || open !== this.wasOpen) {
      this.blocks = 0
      this.wasOpen = open
      this.port.postMessage({ level: this.gate.takePeak(), open })
    }
    return true
  }
}

registerProcessor('iskra-mic-gate', MicGateProcessor)
