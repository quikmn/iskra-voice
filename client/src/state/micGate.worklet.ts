// AudioWorklet: input volume, the voice activity gate, and level reports for the meter (about 20 a second).
import { Gate, type GateParams } from './micGate'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const REPORT_EVERY = 16 // blocks: 16 × 128 samples ≈ 43 ms at 48 kHz

class MicGateProcessor extends AudioWorkletProcessor {
  private readonly gate = new Gate(sampleRate)
  private blocks = 0
  private wasOpen = false

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<Partial<GateParams>>) => {
      const p = e.data
      if (p && typeof p === 'object') this.gate.params = { ...this.gate.params, ...p }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (!output) return true
    if (!input) {
      output.fill(0)
    } else {
      this.gate.process(input, output)
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output)
    if (++this.blocks >= REPORT_EVERY || this.gate.open !== this.wasOpen) {
      this.blocks = 0
      this.wasOpen = this.gate.open
      this.port.postMessage({ level: this.gate.takePeak(), open: this.gate.open })
    }
    return true
  }
}

registerProcessor('iskra-mic-gate', MicGateProcessor)
