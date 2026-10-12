// AudioWorklet: your mic's side of DeepFilterNet3 noise suppression (48 kHz). It only moves samples: 10 ms frames go
// to the DeepFilterNet worker (deepfilter.worker.ts) and come back cleaned, played at a fixed delay (dfQueue.ts).
// The page sends the link to the worker ({ port } or { slots }); it says "ready" once linked and "overrun" whenever
// a frame wasn't back in time. Nothing leaves before it's linked. { strength } tells it the network's delay.
import { queueDelay, WorkletQueue } from './dfQueue'

declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions?: { delay?: number } }) => AudioWorkletProcessor): void

class DeepFilterProcessor extends AudioWorkletProcessor {
  private readonly queue: WorkletQueue

  constructor(options: { processorOptions?: { delay?: number } }) {
    super()
    this.queue = new WorkletQueue(this.port, options?.processorOptions?.delay ?? queueDelay(512), 'silence')
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

registerProcessor('iskra-deepfilter', DeepFilterProcessor)
