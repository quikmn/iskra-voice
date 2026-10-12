// AudioWorklet: DeepFilterNet3 noise suppression on your mic (48 kHz). The engine and model arrive over the port;
// it says "ready" once it runs, "error" if it can't, and reports its realtime factor about once a second. The
// strength (attenuation limit, dB) comes with them and can change while it runs ({ strength }).
import { df_process_frame, initSync } from '../../../vendor/deepfilternet/deepfilter.js'
import { createDeepFilter, setStrength, warmUp } from './strength'
import { Framer } from './framer'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const REPORT_FRAMES = 100 // 1 s

class DeepFilterProcessor extends AudioWorkletProcessor {
  private framer: Framer | null = null
  private state = 0
  private stopped = false

  constructor() {
    super()
    // The page sends the compiled engine ({ module, model }); if it didn't arrive as one (a browser that can't send
    // modules to worklets), ask for the bytes ({ wasm, model }) and compile here.
    this.port.onmessageerror = () => this.port.postMessage({ type: 'need-bytes' })
    type Message = { module?: unknown; wasm?: ArrayBuffer; model: ArrayBuffer; strength: number } | { strength: number; model?: undefined } | 'stop'
    this.port.onmessage = (e: MessageEvent<Message>) => {
      if (e.data === 'stop') {
        this.stopped = true
        return
      }
      if (!e.data.model) {
        if (this.framer && typeof e.data.strength === 'number') setStrength(this.state, e.data.strength)
        return
      }
      const { module, wasm, model, strength } = e.data
      try {
        if (sampleRate !== 48000) throw new Error(`DeepFilterNet needs 48 kHz, not ${sampleRate}`)
        if (module instanceof WebAssembly.Module) initSync({ module })
        else if (wasm) initSync({ module: wasm })
        else return this.port.postMessage({ type: 'need-bytes' })
        const state = createDeepFilter(new Uint8Array(model), typeof strength === 'number' ? strength : 100)
        this.state = state
        warmUp(state, df_process_frame)
        this.framer = new Framer(480, sampleRate, (frame) => df_process_frame(state, frame))
        this.port.postMessage({ type: 'ready', latency: this.framer.latency })
      } catch (err) {
        this.port.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) })
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const output = outputs[0]?.[0]
    if (!output) return true
    const input = inputs[0]?.[0]
    if (!this.framer) {
      output.fill(0) // nothing leaves before noise suppression is on
    } else {
      this.framer.push(input ?? output.fill(0), output)
      if (this.framer.pending >= REPORT_FRAMES) {
        const slowest = this.framer.slowestMs
        this.port.postMessage({ type: 'rtf', rtf: this.framer.takeRtf(), slowest })
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output)
    return true
  }
}

registerProcessor('iskra-deepfilter', DeepFilterProcessor)
