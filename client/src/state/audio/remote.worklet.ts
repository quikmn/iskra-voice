// AudioWorklet for what you hear, one node of each per incoming voice:
//   iskra-leveler    loudness leveling (leveler.ts)
//   iskra-df-bridge  DeepFilterNet3 noise removal, run in a worker (deepfilter.worker.ts) so starting it for someone
//                    who just joined never stalls everyone else's audio. Sends 10 ms frames over a port and plays the
//                    results 20 ms later; until the first ones are back (and whenever the worker falls behind) the
//                    voice passes through as it is.
import { Leveler } from './leveler'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

// Both stop when the page says so (the voice left or the chain was rebuilt), so they can be collected.
class LevelerProcessor extends AudioWorkletProcessor {
  private readonly leveler = new Leveler(sampleRate)
  private stopped = false

  constructor() {
    super()
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.stopped = true
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const output = outputs[0]?.[0]
    if (!output) return true
    const input = inputs[0]?.[0]
    if (input) this.leveler.process(input, output)
    else output.fill(0)
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output)
    return true
  }
}

const FRAME = 480
/** Processed audio to have queued before playing it: covers the worker's round trip. */
const PREFILL = 2 * FRAME
/** More than this queued (the worker caught up in a burst): drop the oldest, so the delay stays short. */
const MAX_QUEUED = 10 * FRAME

class DeepFilterBridge extends AudioWorkletProcessor {
  private worker: MessagePort | null = null
  private readonly frame = new Float32Array(FRAME)
  private filled = 0
  private readonly fifo = new Float32Array(16 * FRAME)
  private read = 0
  private count = 0
  private playing = false
  private stopped = false

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<{ port: MessagePort } | 'stop'>) => {
      if (e.data === 'stop') {
        this.stopped = true
        this.worker = null
        return
      }
      if (!(e.data?.port instanceof MessagePort)) return
      this.worker = e.data.port
      this.worker.onmessage = (m: MessageEvent<Float32Array>) => this.receive(m.data)
    }
  }

  private receive(frame: Float32Array): void {
    if (!(frame instanceof Float32Array)) return
    for (let i = 0; i < frame.length; i++) {
      this.fifo[(this.read + this.count) % this.fifo.length] = frame[i]
      if (this.count < this.fifo.length) this.count++
      else this.read = (this.read + 1) % this.fifo.length
    }
    while (this.count > MAX_QUEUED) {
      this.read = (this.read + 1) % this.fifo.length
      this.count--
    }
    if (!this.playing && this.count >= PREFILL) this.playing = true
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const output = outputs[0]?.[0]
    if (!output) return true
    const input = inputs[0]?.[0]
    if (this.worker) {
      for (let i = 0; i < output.length; i++) {
        this.frame[this.filled++] = input ? input[i] : 0
        if (this.filled === FRAME) {
          this.filled = 0
          const copy = this.frame.slice()
          this.worker.postMessage(copy, [copy.buffer])
        }
      }
    }
    if (this.playing && this.count >= output.length) {
      for (let i = 0; i < output.length; i++) {
        output[i] = this.fifo[this.read]
        this.read = (this.read + 1) % this.fifo.length
      }
      this.count -= output.length
    } else {
      if (this.playing) {
        // The worker fell behind: say so, pass the voice through and refill.
        this.playing = false
        this.port.postMessage({ type: 'underrun' })
      }
      if (input) output.set(input)
      else output.fill(0)
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output)
    return true
  }
}

registerProcessor('iskra-leveler', LevelerProcessor)
registerProcessor('iskra-df-bridge', DeepFilterBridge)
