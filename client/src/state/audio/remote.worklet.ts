// AudioWorklet for what you hear, one node of each per incoming voice:
//   iskra-leveler    loudness leveling (leveler.ts)
//   iskra-df-bridge  DeepFilterNet3 noise removal, run in a worker (deepfilter.worker.ts) so it never stalls the
//                    audio thread. The same queue as the mic's (dfQueue.ts): 10 ms frames out, played at a fixed
//                    delay, crossfading to the voice as it is whenever the worker falls behind. Until it's linked to
//                    the worker the voice passes through.
import { Leveler } from './leveler'
import { queueDelay, WorkletQueue } from './dfQueue'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions?: { delay?: number } }) => AudioWorkletProcessor): void

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

class DeepFilterBridge extends AudioWorkletProcessor {
  private readonly queue: WorkletQueue

  constructor(options: { processorOptions?: { delay?: number } }) {
    super()
    this.queue = new WorkletQueue(this.port, options?.processorOptions?.delay ?? queueDelay(512), 'input')
    this.port.onmessage = (e) => this.queue.message(e.data)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.queue.stopped) return false
    const output = outputs[0]?.[0]
    if (!output) return true
    this.queue.process(inputs[0]?.[0], output)
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output)
    return true
  }
}

registerProcessor('iskra-leveler', LevelerProcessor)
registerProcessor('iskra-df-bridge', DeepFilterBridge)
