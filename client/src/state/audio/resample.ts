// Turns the mic (44.1 or 48 kHz) into the 16 kHz Silero VAD wants: a 4th-order low-pass (two biquads, Butterworth)
// below the new Nyquist, then linear interpolation. Good enough for a speech detector, not for listening.
// Allocation-free after construction: it runs in the audio thread.

class Biquad {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0

  constructor(rate: number, cutoff: number, q: number) {
    const w = (2 * Math.PI * cutoff) / rate
    const alpha = Math.sin(w) / (2 * q)
    const cos = Math.cos(w)
    const a0 = 1 + alpha
    this.b0 = (1 - cos) / 2 / a0
    this.b1 = (1 - cos) / a0
    this.b2 = this.b0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x
    this.y2 = this.y1; this.y1 = y
    return y
  }
}

export class Downsampler {
  private readonly step: number
  private readonly lp1: Biquad
  private readonly lp2: Biquad
  /** Position of the next output sample, in input samples, relative to `prev`. */
  private pos = 0
  private prev = 0
  private readonly frame: Float32Array
  private filled = 0
  private readonly onFrame: (frame: Float32Array) => void

  /** Calls `onFrame` with every `frameSize` samples at `outRate` (the same array each time: copy it to keep it). */
  constructor(inRate: number, outRate: number, frameSize: number, onFrame: (frame: Float32Array) => void) {
    this.onFrame = onFrame
    this.step = inRate / outRate
    const cutoff = Math.min(outRate * 0.45, inRate * 0.45)
    this.lp1 = new Biquad(inRate, cutoff, 0.5412)
    this.lp2 = new Biquad(inRate, cutoff, 1.3066)
    this.frame = new Float32Array(frameSize)
  }

  push(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      const x = this.lp2.step(this.lp1.step(input[i]))
      // Output samples that fall between the previous input sample and this one.
      while (this.pos <= 1) {
        this.frame[this.filled++] = this.prev + (x - this.prev) * this.pos
        if (this.filled === this.frame.length) {
          this.filled = 0
          this.onFrame(this.frame)
        }
        this.pos += this.step
      }
      this.pos -= 1
      this.prev = x
    }
  }
}
