// AudioWorklet: DeepFilterNet3 noise suppression on your mic (48 kHz). The engine and model arrive over the port;
// it says "ready" once it runs, "error" if it can't, and reports its realtime factor about once a second.
import { df_create, df_process_frame, initSync } from '../../../vendor/deepfilternet/deepfilter.js'
import { Framer } from './framer'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const REPORT_FRAMES = 100 // 1 s

class DeepFilterProcessor extends AudioWorkletProcessor {
  private framer: Framer | null = null

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<{ wasm: ArrayBuffer; model: ArrayBuffer }>) => {
      try {
        if (sampleRate !== 48000) throw new Error(`DeepFilterNet needs 48 kHz, not ${sampleRate}`)
        initSync({ module: e.data.wasm })
        // No attenuation limit: take out all the noise it finds.
        const state = df_create(new Uint8Array(e.data.model), 100)
        this.framer = new Framer(480, sampleRate, (frame) => df_process_frame(state, frame))
        this.port.postMessage({ type: 'ready', latency: this.framer.latency })
      } catch (err) {
        this.port.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) })
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0]
    if (!output) return true
    const input = inputs[0]?.[0]
    if (!this.framer) {
      output.fill(0) // nothing leaves before noise suppression is on
    } else {
      this.framer.push(input ?? output.fill(0), output)
      if (this.framer.pending >= REPORT_FRAMES) this.port.postMessage({ type: 'rtf', rtf: this.framer.takeRtf() })
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output)
    return true
  }
}

registerProcessor('iskra-deepfilter', DeepFilterProcessor)
