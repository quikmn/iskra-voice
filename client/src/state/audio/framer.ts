// Audio worklets get 128 samples at a time; DeepFilterNet wants 480 (10 ms at 48 kHz). The framer collects input
// into frames, runs them, and plays the results back at a fixed delay that never runs dry. Allocation-free apart
// from what the engine itself returns. Also measures how long the engine takes (the realtime factor).

export class Framer {
  private readonly frame: Float32Array
  private filled = 0
  private readonly fifo: Float32Array
  private read = 0
  private write = 0
  private count = 0
  /** Output starts once this much has come in: one frame plus one block keeps the FIFO from ever running dry. */
  private readonly startAfter: number
  private received = 0
  private started = false
  private busyMs = 0
  private frames = 0
  private readonly frameMs: number
  private readonly block: number
  private readonly process: (frame: Float32Array) => Float32Array
  private readonly clock: () => number

  constructor(frameSize: number, sampleRate: number, process: (frame: Float32Array) => Float32Array, block = 128,
    clock: () => number = () => (globalThis.performance?.now?.() ?? Date.now())) {
    this.frame = new Float32Array(frameSize)
    this.fifo = new Float32Array(frameSize * 4 + block * 4)
    this.startAfter = frameSize + block
    this.block = block
    this.frameMs = (frameSize / sampleRate) * 1000
    this.process = process
    this.clock = clock
  }

  /** Samples of delay the framing adds (output starts with the block in which `startAfter` is reached). */
  get latency(): number {
    return Math.ceil(this.startAfter / this.block) * this.block - this.block
  }

  /** Time spent / audio processed since the last call, then starts over (null before any frame). */
  takeRtf(): number | null {
    if (!this.frames) return null
    const rtf = this.busyMs / (this.frames * this.frameMs)
    this.busyMs = 0
    this.frames = 0
    return rtf
  }

  /** Frames since the last takeRtf(). */
  get pending(): number {
    return this.frames
  }

  push(input: Float32Array, output: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      this.frame[this.filled++] = input[i]
      if (this.filled === this.frame.length) {
        this.filled = 0
        const t = this.clock()
        const out = this.process(this.frame)
        this.busyMs += this.clock() - t
        this.frames++
        for (let j = 0; j < out.length && this.count < this.fifo.length; j++) {
          this.fifo[this.write] = out[j]
          this.write = (this.write + 1) % this.fifo.length
          this.count++
        }
      }
    }
    this.received += input.length
    if (!this.started && this.received >= this.startAfter) this.started = true
    for (let i = 0; i < output.length; i++) {
      if (this.started && this.count > 0) {
        output[i] = this.fifo[this.read]
        this.read = (this.read + 1) % this.fifo.length
        this.count--
      } else {
        output[i] = 0
      }
    }
  }
}
