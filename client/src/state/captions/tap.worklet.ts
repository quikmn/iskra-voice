// AudioWorklet "iskra-caption-tap": one per voice being captioned. Turns the voice into 16 kHz mono and sends it,
// about 128 ms at a time, straight to the captions worker over the port it's given. Outputs nothing.
import { Downsampler } from '../audio/resample'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const CHUNK = 2048

class CaptionTap extends AudioWorkletProcessor {
  private worker: MessagePort | null = null
  private stopped = false
  private readonly down = new Downsampler(sampleRate, 16000, CHUNK, (chunk) => this.worker?.postMessage(chunk.slice()))

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<{ port: MessagePort } | 'stop'>) => {
      if (e.data === 'stop') {
        this.stopped = true
        this.worker?.close()
        this.worker = null
      } else if (e.data?.port) {
        this.worker = e.data.port
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const input = inputs[0]?.[0]
    if (input && this.worker) this.down.push(input)
    return true
  }
}

registerProcessor('iskra-caption-tap', CaptionTap)
